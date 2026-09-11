import { createHash } from "node:crypto";

import type {
  CredentialRotationOutcome,
  DashboardIntegrationKey,
  DashboardIntegrationRow,
  StoredIntegrationCredential,
} from "@acalys/database";
import type { DashboardEffectiveReviewPolicy } from "@acalys/contracts/dashboard/v1";
import type { ExternalReviewDataBlock } from "@acalys/review-engine";
import { z } from "zod";

export interface ReviewProviderSubject {
  readonly repositoryId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly headSha: string;
  readonly headRef: string;
  readonly number?: number | undefined;
  readonly title: string;
  readonly description?: string | undefined;
}

export interface ProviderIntegrationStore {
  readCredential<TCredential extends object>(
    organizationId: string,
    key: DashboardIntegrationKey,
  ): Promise<StoredIntegrationCredential<TCredential> | undefined>;
  rotateCredentialIfCurrent(input: {
    readonly organizationId: string;
    readonly key: DashboardIntegrationKey;
    readonly expectedCredentialVersion: number;
    readonly credential: object;
  }): Promise<CredentialRotationOutcome>;
}

export interface ReviewProviderContextResolverOptions {
  readonly integrations: ProviderIntegrationStore;
  readonly linearClientId?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

export interface ResolvedProviderContext {
  readonly blocks: readonly ExternalReviewDataBlock[];
  /** Stable identity included in model input identity, never analyzer cache identity. */
  readonly digest: string;
}

const linearCredentialSchema = z.object({
  accessToken: z.string().min(1).max(8_192),
  refreshToken: z.string().min(1).max(8_192),
  expiresAt: z.string().datetime({ offset: true }),
});
const linearConfigSchema = z.object({
  teamKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]{0,20}$/)).max(50).default([]),
}).passthrough();
const linearTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(8_192),
  refresh_token: z.string().min(1).max(8_192),
  expires_in: z.number().int().positive().max(7 * 24 * 60 * 60),
  token_type: z.string().min(1).max(64),
});
const linearIssueResponseSchema = z.object({
  data: z.object({
    issue: z.object({
      id: z.string().min(1).max(200),
      identifier: z.string().min(1).max(100),
      title: z.string().min(1).max(1_000),
      description: z.string().max(30_000).nullable().optional(),
      url: z.string().url().max(2_000).optional(),
      priorityLabel: z.string().max(200).nullable().optional(),
      state: z.object({ name: z.string().min(1).max(300) }).nullable().optional(),
    }).nullable(),
  }),
  errors: z.array(z.object({ message: z.string().max(2_000) })).optional(),
});

const circleCredentialSchema = z.object({ token: z.string().min(1).max(8_192) });
const circleConfigSchema = z.object({
  /** Repository UUID -> CircleCI project slug. */
  projectSlugs: z.record(z.string(), z.string().min(1).max(500)).default({}),
}).passthrough();
const circlePipelinesSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(200),
    number: z.number().int().nonnegative().optional(),
    state: z.string().max(100).optional(),
    created_at: z.string().max(100).optional(),
    vcs: z.object({
      revision: z.string().min(1).max(200),
      review_id: z.string().max(100).nullable().optional(),
      branch: z.string().max(500).nullable().optional(),
      commit: z.object({
        subject: z.string().max(2_000).nullable().optional(),
        body: z.string().max(20_000).nullable().optional(),
      }).optional(),
    }),
  })).max(250),
}).passthrough();
const circleWorkflowsSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
    status: z.string().min(1).max(100),
    created_at: z.string().max(100).optional(),
    stopped_at: z.string().max(100).nullable().optional(),
  })).max(250),
}).passthrough();

class ProviderUnavailable extends Error {
  public constructor(readonly provider: "linear" | "circleci", message: string) {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalBlockIdentity(block: ExternalReviewDataBlock): string {
  return `${block.source}\u0000${block.status}\u0000${block.identity}\u0000${sha256(block.content)}`;
}

async function boundedJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: { readonly timeoutMs: number; readonly maxBytes: number; readonly provider: "linear" | "circleci" },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
    } catch {
      throw new ProviderUnavailable(options.provider, "network request failed");
    }
    if (!response.ok) {
      throw new ProviderUnavailable(options.provider, `provider returned HTTP ${String(response.status)}`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > options.maxBytes) {
      throw new ProviderUnavailable(options.provider, "provider response exceeded size limit");
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > options.maxBytes) {
        throw new ProviderUnavailable(options.provider, "provider response exceeded size limit");
      }
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
      catch { throw new ProviderUnavailable(options.provider, "provider returned invalid JSON"); }
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderUnavailable(options.provider, "provider response exceeded size limit");
      }
      chunks.push(next.value);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(joined)) as unknown; }
    catch { throw new ProviderUnavailable(options.provider, "provider returned invalid JSON"); }
  } finally {
    clearTimeout(timer);
  }
}

function incompleteBlock(provider: "linear" | "circleci", reason: string): ExternalReviewDataBlock {
  return {
    source: provider,
    status: "incomplete",
    identity: `${provider}:unavailable`,
    content: `Provider context unavailable: ${reason}`,
  };
}

function extractLinearIdentifiers(subject: ReviewProviderSubject, teamKeys: readonly string[]): readonly string[] {
  if (teamKeys.length === 0) return [];
  const allowed = new Set(teamKeys.map((key) => key.toUpperCase()));
  const text = `${subject.title}\n${subject.description ?? ""}`;
  const out = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{0,20})-(\d{1,10})\b/g)) {
    const team = match[1];
    const identifier = match[0];
    if (team !== undefined && identifier !== undefined && allowed.has(team)) out.add(identifier);
    if (out.size >= 10) break;
  }
  return [...out].sort();
}

function integrationConfig(row: DashboardIntegrationRow): Readonly<Record<string, unknown>> {
  return row.config;
}

export class ReviewProviderContextResolver {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  public constructor(private readonly options: ReviewProviderContextResolverOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.requestTimeoutMs ?? 8_000;
    this.#maxBytes = options.maxResponseBytes ?? 1_000_000;
  }

  public async resolve(input: {
    readonly organizationId: string;
    readonly subject: ReviewProviderSubject;
    /** Immutable policy admitted with this ReviewRequest. */
    readonly policy?: DashboardEffectiveReviewPolicy | undefined;
  }): Promise<ResolvedProviderContext> {
    const [linear, circle] = await Promise.all([
      this.#linear(input).catch((error: unknown) => {
        if (error instanceof ProviderUnavailable) return [incompleteBlock("linear", error.message)] as const;
        throw error;
      }),
      this.#circleci(input).catch((error: unknown) => {
        if (error instanceof ProviderUnavailable) return [incompleteBlock("circleci", error.message)] as const;
        throw error;
      }),
    ]);
    const blocks = [...linear, ...circle];
    return {
      blocks,
      digest: sha256(blocks.map(canonicalBlockIdentity).sort().join("\n")),
    };
  }

  async #linear(input: {
    readonly organizationId: string;
    readonly subject: ReviewProviderSubject;
    readonly policy?: DashboardEffectiveReviewPolicy | undefined;
  }): Promise<readonly ExternalReviewDataBlock[]> {
    let stored = await this.options.integrations.readCredential<unknown & object>(input.organizationId, "linear");
    if (stored === undefined) return [];
    let credential = linearCredentialSchema.parse(stored.credential);
    const config = linearConfigSchema.parse(integrationConfig(stored.integration));
    // The admitted policy is authoritative for review-time behavior. The
    // mutable integration config is retained only as the legacy fallback for
    // ReviewRequests created before policy snapshots existed.
    const teamKeys = input.policy?.organizationConfig.knowledgeBase.linearTeamKeys ?? config.teamKeys;
    const identifiers = extractLinearIdentifiers(input.subject, teamKeys);
    if (identifiers.length === 0) return [];

    if (new Date(credential.expiresAt).getTime() <= this.#now().getTime() + 60_000) {
      const clientId = this.options.linearClientId;
      if (clientId === undefined || clientId.trim() === "") {
        throw new ProviderUnavailable("linear", "OAuth client is not configured for token refresh");
      }
      const refreshBody = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: clientId,
      });
      const refreshedRaw = await boundedJson(
        this.#fetch,
        "https://api.linear.app/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: refreshBody.toString(),
        },
        { timeoutMs: this.#timeoutMs, maxBytes: this.#maxBytes, provider: "linear" },
      );
      const refreshedResult = linearTokenResponseSchema.safeParse(refreshedRaw);
      if (!refreshedResult.success) {
        throw new ProviderUnavailable("linear", "token refresh response did not match contract");
      }
      const refreshed = refreshedResult.data;
      const nextCredential = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: new Date(this.#now().getTime() + refreshed.expires_in * 1_000).toISOString(),
      };
      const rotated = await this.options.integrations.rotateCredentialIfCurrent({
        organizationId: input.organizationId,
        key: "linear",
        expectedCredentialVersion: stored.integration.credentialVersion,
        credential: nextCredential,
      });
      if (rotated.kind === "updated") {
        credential = nextCredential;
      } else if (rotated.kind === "stale_generation") {
        // Disconnect/reconnect or another refresh won. Re-read once; never write
        // the stale refresh result again, which is the anti-resurrection rule.
        stored = await this.options.integrations.readCredential<unknown & object>(input.organizationId, "linear");
        if (stored === undefined) return [];
        credential = linearCredentialSchema.parse(stored.credential);
      } else {
        return [];
      }
    }

    const blocks: ExternalReviewDataBlock[] = [];
    for (const identifier of identifiers) {
      const raw = await boundedJson(
        this.#fetch,
        "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            query: "query AcalysIssue($id: String!) { issue(id: $id) { id identifier title description url priorityLabel state { name } } }",
            variables: { id: identifier },
          }),
        },
        { timeoutMs: this.#timeoutMs, maxBytes: this.#maxBytes, provider: "linear" },
      );
      const parsed = linearIssueResponseSchema.safeParse(raw);
      if (!parsed.success || parsed.data.errors?.length) {
        throw new ProviderUnavailable("linear", `issue ${identifier} response did not match contract`);
      }
      const issue = parsed.data.data.issue;
      if (issue === null || issue.identifier !== identifier) continue;
      blocks.push({
        source: "linear",
        status: "complete",
        identity: `linear:${issue.id}:${issue.identifier}`,
        content: [
          `Issue ${issue.identifier}: ${issue.title}`,
          `State: ${issue.state?.name ?? "unknown"}`,
          `Priority: ${issue.priorityLabel ?? "unknown"}`,
          ...(issue.description == null ? [] : [`Description:\n${issue.description}`]),
        ].join("\n"),
      });
    }
    return blocks;
  }

  async #circleci(input: {
    readonly organizationId: string;
    readonly subject: ReviewProviderSubject;
    readonly policy?: DashboardEffectiveReviewPolicy | undefined;
  }): Promise<readonly ExternalReviewDataBlock[]> {
    // A snapshotted false wins over mutable integration state. This prevents a
    // review admitted with CircleCI disabled from gaining new evidence merely
    // because an admin enables the integration while that run is in flight.
    if (input.policy !== undefined && input.policy.organizationConfig.tools.circleci !== true) return [];
    const stored = await this.options.integrations.readCredential<unknown & object>(input.organizationId, "circleci");
    if (stored === undefined) return [];
    const credential = circleCredentialSchema.parse(stored.credential);
    const config = circleConfigSchema.parse(integrationConfig(stored.integration));
    const projectSlug = config.projectSlugs[input.subject.repositoryId];
    if (projectSlug === undefined) return [];

    const encodedSlug = projectSlug.split("/").map(encodeURIComponent).join("/");
    const url = new URL(`https://circleci.com/api/v2/project/${encodedSlug}/pipeline`);
    url.searchParams.set("branch", input.subject.headRef);
    const raw = await boundedJson(
      this.#fetch,
      url.toString(),
      { headers: { "Circle-Token": credential.token, accept: "application/json" } },
      { timeoutMs: this.#timeoutMs, maxBytes: this.#maxBytes, provider: "circleci" },
    );
    const pipelines = circlePipelinesSchema.safeParse(raw);
    if (!pipelines.success) throw new ProviderUnavailable("circleci", "pipeline response did not match contract");

    const exact = pipelines.data.items.find((pipeline) => {
      if (pipeline.vcs.revision !== input.subject.headSha) return false;
      if (pipeline.vcs.review_id == null || input.subject.number === undefined) return true;
      return pipeline.vcs.review_id === String(input.subject.number);
    });
    if (exact === undefined) {
      return [incompleteBlock("circleci", "no pipeline matched the admitted head revision/review")];
    }

    const workflowRaw = await boundedJson(
      this.#fetch,
      `https://circleci.com/api/v2/pipeline/${encodeURIComponent(exact.id)}/workflow`,
      { headers: { "Circle-Token": credential.token, accept: "application/json" } },
      { timeoutMs: this.#timeoutMs, maxBytes: this.#maxBytes, provider: "circleci" },
    );
    const workflows = circleWorkflowsSchema.safeParse(workflowRaw);
    if (!workflows.success) throw new ProviderUnavailable("circleci", "workflow response did not match contract");

    return [{
      source: "circleci",
      status: "complete",
      identity: `circleci:${exact.id}:${input.subject.headSha}:${input.subject.number ?? "none"}`,
      content: [
        `Pipeline ${String(exact.number ?? exact.id)} is bound to reviewed head ${input.subject.headSha}.`,
        ...(exact.vcs.review_id == null ? [] : [`Review id: ${exact.vcs.review_id}`]),
        ...workflows.data.items.map((workflow) => `Workflow ${workflow.name}: ${workflow.status}`),
      ].join("\n"),
    }];
  }
}
