/**
 * Process lifecycle: listen, then stop cleanly.
 *
 * Separated from `createGatewayApp` so tests can exercise the application
 * without binding a port, and so the shutdown logic — the part that decides
 * whether a deploy loses deliveries — is testable on its own.
 *
 * # Why graceful shutdown matters here specifically
 *
 * The gateway's promise is that a 2xx means the delivery is durably owned. A
 * process killed mid-request breaks that promise in the worst way: GitHub sees
 * a connection reset, records a failed delivery, and **does not automatically
 * redeliver**. The event is gone.
 *
 * So on SIGTERM the server stops accepting new connections and lets in-flight
 * requests finish. Every rolling deploy is a SIGTERM, so this runs far more
 * often than any failure path.
 */

import type { Server } from "node:http";

import type { Express } from "express";

import { applyServerTimeouts, type ServerTimeouts } from "./security.js";

export interface StartOptions {
  readonly app: Express;
  readonly port: number;
  readonly host?: string | undefined;
  readonly timeouts?: ServerTimeouts | undefined;
  /**
   * How long in-flight requests may take before the process exits anyway.
   *
   * Bounded on purpose. An unbounded drain turns one stuck request into a pod
   * that never terminates, and the orchestrator eventually SIGKILLs it — which
   * is the ungraceful shutdown this exists to avoid, arrived at slowly.
   */
  readonly drainMillis?: number | undefined;
  readonly onListening?: ((address: string) => void) | undefined;
  readonly onShutdown?: ((reason: string) => void) | undefined;
}

export interface RunningServer {
  readonly server: Server;
  /** Resolves once the server has stopped accepting and drained. */
  stop(reason?: string): Promise<void>;
}

export function startGateway(options: StartOptions): Promise<RunningServer> {
  const drainMillis = options.drainMillis ?? 15_000;

  return new Promise<RunningServer>((resolve) => {
    const server = options.app.listen(
      options.port,
      options.host ?? "0.0.0.0",
      () => {
        const address = server.address();
        options.onListening?.(
          typeof address === "string"
            ? address
            : `${address?.address ?? "?"}:${String(address?.port ?? options.port)}`,
        );
        resolve({ server, stop });
      },
    );

    // Applied to the server, not as middleware: a slowloris client is holding
    // a socket before any handler runs, so nothing in Express can intervene.
    applyServerTimeouts(server, options.timeouts);

    let stopping: Promise<void> | undefined;

    function stop(reason = "shutdown"): Promise<void> {
      // Idempotent. SIGTERM followed by SIGINT during a slow drain must not
      // start a second shutdown and race the first.
      stopping ??= new Promise<void>((resolveStop) => {
        options.onShutdown?.(reason);

        const forced = setTimeout(() => {
          server.closeAllConnections();
          resolveStop();
        }, drainMillis);
        // Does not hold the event loop open on its own.
        forced.unref();

        server.close(() => {
          clearTimeout(forced);
          resolveStop();
        });

        // Idle keep-alive sockets would otherwise keep `close` waiting for the
        // full drain window on every deploy, even with nothing in flight.
        server.closeIdleConnections();
      });
      return stopping;
    }

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void stop(signal);
      });
    }
  });
}
