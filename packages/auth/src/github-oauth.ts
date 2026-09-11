import { createHmac, timingSafeEqual } from "node:crypto";
import { ValidationError, ProviderError, UnauthorizedError } from "@acalys/contracts/domain";
import { CredentialRing } from "./credential-ring.js";

interface OAuthStatePayload {
  readonly nonce: string;
  readonly organizationId: string;
  readonly returnTo: string;
  readonly issuedAt: number;
}

export interface GithubOAuthIdentity {
  readonly providerUserId: string;
  readonly login: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  /** Emails GitHub itself marks verified; this is the only email set suitable for invitation redemption. */
  readonly verifiedEmails: readonly string[];
}

export interface GithubOAuthOptions {
  readonly clientId: string;
  readonly clientSecrets: CredentialRing<string>;
  readonly stateSecrets: CredentialRing<string>;
  readonly callbackUrl: string;
  readonly appSlug?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
  readonly stateTtlMillis?: number | undefined;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
}

function isApplicationRelativePath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const origin = new URL("https://acalys.invalid/");
    return new URL(value, origin).origin === origin.origin;
  } catch {
    return false;
  }
}

export class GithubOAuthService {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #stateTtlMillis: number;
  readonly #appSlug: string;

  public constructor(private readonly options: GithubOAuthOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#stateTtlMillis = options.stateTtlMillis ?? 10 * 60 * 1_000;
    this.#appSlug = options.appSlug ?? "acalys";
    if (options.clientId.trim().length === 0 || options.clientSecrets.active.length === 0) {
      throw new ValidationError("GitHub OAuth client credentials are required");
    }
    if (options.stateSecrets.configuredValues().some((secret) => secret.length === 0)) {
      throw new ValidationError("OAuth state secrets must not be empty");
    }
    if (!/^[A-Za-z0-9-]{1,100}$/u.test(this.#appSlug)) {
      throw new ValidationError("GitHub App slug is invalid");
    }
    if (!Number.isSafeInteger(this.#stateTtlMillis) || this.#stateTtlMillis <= 0) {
      throw new ValidationError("OAuth state TTL must be a positive integer");
    }
  }

  public createAuthorization(input: {
    readonly organizationId: string;
    readonly nonce: string;
    readonly returnTo: string;
  }): { readonly url: string; readonly state: string } {
    if (input.nonce.length < 8 || input.nonce.length > 256) {
      throw new ValidationError("OAuth nonce must be between 8 and 256 characters");
    }
    if (!isApplicationRelativePath(input.returnTo)) {
      throw new ValidationError("OAuth returnTo must be an application-relative path");
    }
    const payload: OAuthStatePayload = {
      nonce: input.nonce,
      organizationId: input.organizationId,
      returnTo: input.returnTo,
      issuedAt: this.#now().getTime(),
    };
    const encoded = base64urlJson(payload);
    const signature = sign(encoded, this.options.stateSecrets.active);
    const state = `${encoded}.${signature}`;
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.callbackUrl);
    url.searchParams.set("scope", "user:email");
    url.searchParams.set("state", state);
    return { url: url.toString(), state };
  }

  public verifyState(state: string, expectedNonce: string): OAuthStatePayload {
    const [encoded, supplied, extra] = state.split(".");
    if (encoded === undefined || supplied === undefined || extra !== undefined) {
      throw new UnauthorizedError("OAuth state is malformed");
    }
    const suppliedBytes = Buffer.from(supplied, "utf8");
    let valid = false;
    for (const secret of this.options.stateSecrets.verificationCandidates()) {
      const expected = sign(encoded, secret);
      const expectedBytes = Buffer.from(expected, "utf8");
      const sameLength = expectedBytes.length === suppliedBytes.length;
      const matches = sameLength && timingSafeEqual(expectedBytes, suppliedBytes);
      valid = matches || valid;
    }
    if (!valid) throw new UnauthorizedError("OAuth state signature is invalid");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new UnauthorizedError("OAuth state payload is invalid");
    }
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>)["nonce"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["organizationId"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["returnTo"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["issuedAt"] !== "number" ||
      !Number.isSafeInteger((parsed as Record<string, unknown>)["issuedAt"])
    ) {
      throw new UnauthorizedError("OAuth state payload has the wrong shape");
    }
    const payload = parsed as OAuthStatePayload;
    if (!isApplicationRelativePath(payload.returnTo)) {
      throw new UnauthorizedError("OAuth state return path is invalid");
    }
    if (payload.nonce !== expectedNonce) {
      throw new UnauthorizedError("OAuth state nonce does not match the initiating browser");
    }
    const now = this.#now().getTime();
    if (now - payload.issuedAt > this.#stateTtlMillis || payload.issuedAt > now + 30_000) {
      throw new UnauthorizedError("OAuth state expired or was issued in the future");
    }
    return payload;
  }

  public async exchangeCode(code: string): Promise<{ readonly accessToken: string; readonly identity: GithubOAuthIdentity }> {
    if (code.length === 0) throw new ValidationError("OAuth code is required");
    const response = await this.#fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecrets.active,
        code,
        redirect_uri: this.options.callbackUrl,
      }),
    });
    if (!response.ok) {
      throw new ProviderError("GitHub OAuth code exchange failed", { retryable: response.status >= 500 });
    }
    const tokenBody = await response.json() as Record<string, unknown>;
    const accessToken = tokenBody["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new ProviderError("GitHub OAuth response did not contain an access token", { retryable: false });
    }
    const user = await this.#fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" },
    });
    if (!user.ok) throw new ProviderError("GitHub user lookup failed", { retryable: user.status >= 500 });
    const body = await user.json() as Record<string, unknown>;
    if ((typeof body["id"] !== "number" && typeof body["id"] !== "string") || typeof body["login"] !== "string") {
      throw new ProviderError("GitHub user response had an invalid identity", { retryable: false });
    }
    const emails = await this.#fetch("https://api.github.com/user/emails?per_page=100", {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" },
    });
    if (!emails.ok) throw new ProviderError("GitHub verified-email lookup failed", { retryable: emails.status >= 500 });
    const emailBody = await emails.json() as unknown;
    if (!Array.isArray(emailBody)) {
      throw new ProviderError("GitHub email response had an invalid shape", { retryable: false });
    }
    const verifiedEmails = [...new Set(emailBody.flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      return record["verified"] === true && typeof record["email"] === "string"
        ? [record["email"].trim().toLowerCase()]
        : [];
    }).filter((value) => value.length > 0))];
    return {
      accessToken,
      identity: {
        providerUserId: String(body["id"]),
        login: body["login"] as string,
        ...(typeof body["name"] === "string" ? { displayName: body["name"] as string } : {}),
        ...(typeof body["email"] === "string" ? { email: body["email"] as string } : {}),
        verifiedEmails,
      },
    };
  }

  public installationUrl(state: string): string {
    const url = new URL(`https://github.com/apps/${this.#appSlug}/installations/new`);
    url.searchParams.set("state", state);
    return url.toString();
  }
}
