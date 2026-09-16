import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ProviderError,
  UnauthorizedError,
  ValidationError,
} from "@acalys/contracts/domain";
import { type CredentialRing } from "./credential-ring.js";

interface OAuthStatePayload {
  readonly nonce: string;
  readonly organizationId: string;
  readonly returnTo: string;
  readonly issuedAt: number;
}

export interface GitlabOAuthIdentity {
  readonly providerUserId: string;
  readonly username: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly verifiedEmails: readonly string[];
}

export interface GitlabOAuthOptions {
  readonly clientId: string;
  readonly clientSecrets: CredentialRing<string>;
  readonly stateSecrets: CredentialRing<string>;
  readonly callbackUrl: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
  readonly stateTtlMillis?: number | undefined;
}

const GITLAB_ORIGIN = "https://gitlab.com";
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}
function safePath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    containsControlCharacter(value)
  )
    return false;
  try {
    const origin = new URL("https://acalys.invalid/");
    return new URL(value, origin).origin === origin.origin;
  } catch {
    return false;
  }
}

export class GitlabOAuthService {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #stateTtlMillis: number;

  public constructor(private readonly options: GitlabOAuthOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#stateTtlMillis = options.stateTtlMillis ?? 10 * 60_000;
    if (
      options.clientId.trim().length === 0 ||
      options.clientSecrets.active.length === 0
    )
      throw new ValidationError("GitLab OAuth client credentials are required");
    if (
      options.stateSecrets
        .configuredValues()
        .some((secret) => secret.length === 0)
    )
      throw new ValidationError("GitLab OAuth state secrets must not be empty");
    if (
      !Number.isSafeInteger(this.#stateTtlMillis) ||
      this.#stateTtlMillis <= 0
    )
      throw new ValidationError(
        "GitLab OAuth state TTL must be a positive integer",
      );
  }

  public createAuthorization(input: {
    readonly organizationId: string;
    readonly nonce: string;
    readonly returnTo: string;
  }): { readonly url: string; readonly state: string } {
    if (input.nonce.length < 8 || input.nonce.length > 256)
      throw new ValidationError(
        "OAuth nonce must be between 8 and 256 characters",
      );
    if (!safePath(input.returnTo))
      throw new ValidationError(
        "OAuth returnTo must be an application-relative path",
      );
    const payload: OAuthStatePayload = {
      nonce: input.nonce,
      organizationId: input.organizationId,
      returnTo: input.returnTo,
      issuedAt: this.#now().getTime(),
    };
    const encoded = encode(payload);
    const state = `${encoded}.${sign(encoded, this.options.stateSecrets.active)}`;
    const url = new URL("/oauth/authorize", GITLAB_ORIGIN);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read_user");
    url.searchParams.set("gl_auth_type", "login");
    url.searchParams.set("state", state);
    return { url: url.toString(), state };
  }

  public verifyState(state: string, expectedNonce: string): OAuthStatePayload {
    const [encoded, supplied, extra] = state.split(".");
    if (encoded === undefined || supplied === undefined || extra !== undefined)
      throw new UnauthorizedError("OAuth state is malformed");
    const suppliedBytes = Buffer.from(supplied, "utf8");
    let valid = false;
    for (const secret of this.options.stateSecrets.verificationCandidates()) {
      const expectedBytes = Buffer.from(sign(encoded, secret), "utf8");
      valid =
        (expectedBytes.length === suppliedBytes.length &&
          timingSafeEqual(expectedBytes, suppliedBytes)) ||
        valid;
    }
    if (!valid) throw new UnauthorizedError("OAuth state signature is invalid");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new UnauthorizedError("OAuth state payload is invalid");
    }
    if (typeof parsed !== "object" || parsed === null)
      throw new UnauthorizedError("OAuth state payload has the wrong shape");
    const record = parsed as Record<string, unknown>;
    if (
      typeof record["nonce"] !== "string" ||
      typeof record["organizationId"] !== "string" ||
      typeof record["returnTo"] !== "string" ||
      typeof record["issuedAt"] !== "number" ||
      !Number.isSafeInteger(record["issuedAt"])
    ) {
      throw new UnauthorizedError("OAuth state payload has the wrong shape");
    }
    const payload = record as unknown as OAuthStatePayload;
    if (!safePath(payload.returnTo) || payload.nonce !== expectedNonce)
      throw new UnauthorizedError(
        "OAuth state does not match the initiating browser",
      );
    const now = this.#now().getTime();
    if (
      now - payload.issuedAt > this.#stateTtlMillis ||
      payload.issuedAt > now + 30_000
    )
      throw new UnauthorizedError(
        "OAuth state expired or was issued in the future",
      );
    return payload;
  }

  public async exchangeCode(code: string): Promise<{
    readonly accessToken: string;
    readonly identity: GitlabOAuthIdentity;
  }> {
    if (code.length === 0) throw new ValidationError("OAuth code is required");
    const token = await this.#fetch(`${GITLAB_ORIGIN}/oauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecrets.active,
        code,
        grant_type: "authorization_code",
        redirect_uri: this.options.callbackUrl,
      }).toString(),
    });
    if (!token.ok)
      throw new ProviderError("GitLab OAuth code exchange failed", {
        retryable: token.status >= 500,
      });
    const tokenBody = (await token.json()) as Record<string, unknown>;
    const accessToken = tokenBody["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0)
      throw new ProviderError(
        "GitLab OAuth response did not contain an access token",
        { retryable: false },
      );
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    };
    const user = await this.#fetch(`${GITLAB_ORIGIN}/api/v4/user`, { headers });
    if (!user.ok)
      throw new ProviderError("GitLab user lookup failed", {
        retryable: user.status >= 500,
      });
    const body = (await user.json()) as Record<string, unknown>;
    if (
      (typeof body["id"] !== "number" && typeof body["id"] !== "string") ||
      typeof body["username"] !== "string"
    )
      throw new ProviderError("GitLab user response had an invalid identity", {
        retryable: false,
      });
    const emails = await this.#fetch(`${GITLAB_ORIGIN}/api/v4/user/emails`, {
      headers,
    });
    if (!emails.ok)
      throw new ProviderError("GitLab confirmed-email lookup failed", {
        retryable: emails.status >= 500,
      });
    const emailBody = await emails.json();
    if (!Array.isArray(emailBody))
      throw new ProviderError("GitLab email response had an invalid shape", {
        retryable: false,
      });
    const verifiedEmails = [
      ...new Set(
        emailBody
          .flatMap((value) => {
            if (
              typeof value !== "object" ||
              value === null ||
              Array.isArray(value)
            )
              return [];
            const record = value as Record<string, unknown>;
            return typeof record["email"] === "string" &&
              typeof record["confirmed_at"] === "string" &&
              record["confirmed_at"].length > 0
              ? [record["email"].trim().toLowerCase()]
              : [];
          })
          .filter((value) => value.length > 0),
      ),
    ];
    return {
      accessToken,
      identity: {
        providerUserId: String(body["id"]),
        username: body["username"],
        ...(typeof body["name"] === "string"
          ? { displayName: body["name"] }
          : {}),
        ...(typeof body["email"] === "string" ? { email: body["email"] } : {}),
        verifiedEmails,
      },
    };
  }
}
