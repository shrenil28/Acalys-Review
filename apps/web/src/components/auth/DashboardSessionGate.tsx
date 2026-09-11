import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { browserAuthorization, clearBrowserSession, storeBrowserSession } from "@/lib/api/browserSession";
import { loadDashboardSession, redeemLoginExchange, type DashboardSessionView } from "@/lib/api/dashboardAdmin";
import { resolveDataConfig } from "@/lib/api/config";

const SessionContext = createContext<DashboardSessionView | null>(null);
export function useDashboardSession(): DashboardSessionView | null { return useContext(SessionContext); }

export function DashboardSessionGate({ children }: { children: ReactNode }) {
  const config = resolveDataConfig();
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<DashboardSessionView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unauthorized" | "failed">("loading");
  const exchange = useMemo(() => new URLSearchParams(location.search).get("acalys_exchange"), [location.search]);

  useEffect(() => {
    if (config.kind !== "api") { setState("ready"); return; }
    const controller = new AbortController();
    void (async () => {
      setState("loading");
      if (exchange !== null) {
        const redeemed = await redeemLoginExchange(exchange, controller.signal);
        if (controller.signal.aborted) return;
        if (redeemed.kind !== "ok" || !storeBrowserSession(redeemed.value.token)) {
          clearBrowserSession(); setState("unauthorized"); return;
        }
        const params = new URLSearchParams(location.search);
        params.delete("acalys_exchange");
        navigate({ pathname: location.pathname, search: params.size === 0 ? "" : `?${params.toString()}`, hash: location.hash }, { replace: true });
      }
      if (browserAuthorization() === undefined) { setState("unauthorized"); return; }
      const result = await loadDashboardSession(controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "ok") { setSession(result.value); setState("ready"); return; }
      if (result.kind === "rejected" && result.status === 401) { clearBrowserSession(); setState("unauthorized"); return; }
      setState("failed");
    })();
    return () => controller.abort();
  }, [config.kind, exchange, location.hash, location.pathname, location.search, navigate]);

  if (config.kind === "fixtures") return <SessionContext.Provider value={null}>{children}</SessionContext.Provider>;
  if (config.kind === "misconfigured") return <div className="mx-auto max-w-2xl px-6 py-16"><LiveMisconfiguredState detail={config.detail} /></div>;
  if (state === "unauthorized") {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  if (state === "loading") return <div className="flex h-full items-center justify-center bg-shell text-sm text-fg-subtle">Validating your Acalys session…</div>;
  if (state === "failed" || session === null) return <div className="flex h-full items-center justify-center bg-shell px-6 text-center text-sm text-fg-subtle">Acalys could not validate this browser session. Check the API connection and retry.</div>;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
