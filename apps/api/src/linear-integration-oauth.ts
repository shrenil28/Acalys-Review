import { createHash, randomBytes } from "node:crypto";

import {
  DashboardIntegrationStore,
  type DashboardIntegrationRow,
} from "@acalys/database";
import { ProviderError, UnauthorizedError, ValidationError } from "@acalys/contracts/domain";
import { z } from "zod";

const tokenSchema = z.object({
  access_token: z.string().min(1).max(8_192),
  refresh_token: z.string().min(1).max(8_192),
  expires_in: z.number().int().positive().max(7 * 24 * 60 * 60),
  token_type: z.string().min(1).max(64),
});
const viewerSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string().min(1).max(200),
      name: z.string().min(1).max(500),
    }),
  }),
  errors: z.array(z.object({ message: z.string().max(2_000) })).optional(),
});

export interface LinearIntegrationOAuthOptions {
  readonly clientId: string;
  readonly callbackUrl: string;
  readonly store: DashboardIntegrationStore;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
  readonly attemptTtlMillis?: number | undefined;
}

export class LinearIntegrationOAuthService {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #attemptTtlMillis: number;

  public constructor(private readonly options: LinearIntegrationOAuthOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#attemptTtlMillis = options.attemptTtlMillis ?? 10 * 60_000;
    if (options.clientId.trim() === "") throw new ValidationError("Linear OAuth client id is required");
    const callback = new URL(options.callbackUrl);
    if (callback.protocol !== "https:" && callback.hostname !== "localhost") {
      throw new ValidationError("Linear OAuth callback must use HTTPS outside localhost");
    }
  }

  public async createAuthorization(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly browserNonce: string;
  }): Promise<{ readonly url: string; readonly state: string }> {
    if (input.browserNonce.length < 16 || input.browserNonce.length > 256) {
      throw new ValidationError("Linear OAuth browser nonce is invalid");
    }
    const state = randomBytes(32).toString("base64url");
    // 64 random bytes => 86 base64url characters, safely inside RFC 7636's
    // 43..128 character verifier range.
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const created = await this.options.store.createLinearOAuthAttempt({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      state,
      browserNonce: input.browserNonce,
      verifier,
      ttlMillis: this.#attemptTtlMillis,
    });
    if (created !== "created") throw new UnauthorizedError("Linear integration requires an owner or admin");

    const url = new URL("https://linear.app/oauth/authorize");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state };
  }

  public async exchangeAndConnect(input: {
    readonly organizationId: string;
    readonly state: string;
    readonly code: string;
    readonly browserNonce: string;
  }): Promise<DashboardIntegrationRow> {
    if (input.state.length < 20 || input.code.length < 1) throw new UnauthorizedError("Linear OAuth callback is malformed");
    const attempt = await this.options.store.consumeLinearOAuthAttempt({
      organizationId: input.organizationId,
      state: input.state,
      browserNonce: input.browserNonce,
    });
    if (attempt === undefined) throw new UnauthorizedError("Linear OAuth state is invalid, expired, or already consumed");

    const form = new URLSearchParams({
      code: input.code,
      redirect_uri: this.options.callbackUrl,
      client_id: this.options.clientId,
      code_verifier: attempt.verifier,
      grant_type: "authorization_code",
    });
    const response = await this.#fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      redirect: "error",
    });
    if (!response.ok) throw new ProviderError("Linear OAuth token exchange failed", { retryable: response.status >= 500 });
    const token = tokenSchema.safeParse(await response.json());
    if (!token.success) throw new ProviderError("Linear OAuth token response had an invalid shape", { retryable: false });

    const viewerResponse = await this.#fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.data.access_token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ query: "query AcalysViewer { viewer { id name } }" }),
      redirect: "error",
    });
    if (!viewerResponse.ok) throw new ProviderError("Linear identity verification failed", { retryable: viewerResponse.status >= 500 });
    const viewer = viewerSchema.safeParse(await viewerResponse.json());
    if (!viewer.success || viewer.data.errors?.length) {
      throw new ProviderError("Linear identity response had an invalid shape", { retryable: false });
    }

    const existing = await this.options.store.getIntegration(input.organizationId, "linear");
    const outcome = await this.options.store.connectAuthorized({
      organizationId: input.organizationId,
      actorUserId: attempt.actorUserId,
      key: "linear",
      expectedRevision: existing?.revision ?? 0,
      config: {
        ...(existing?.config ?? {}),
        authorizedViewerId: viewer.data.data.viewer.id,
        authorizedViewerName: viewer.data.data.viewer.name,
      },
      credential: {
        accessToken: token.data.access_token,
        refreshToken: token.data.refresh_token,
        expiresAt: new Date(this.#now().getTime() + token.data.expires_in * 1_000).toISOString(),
      },
    });
    if (outcome.kind === "forbidden") throw new UnauthorizedError("Linear integration authorization is no longer valid");
    if (outcome.kind !== "updated") throw new ProviderError("Linear integration changed while OAuth was completing", { retryable: false });
    return outcome.integration;
  }
}
