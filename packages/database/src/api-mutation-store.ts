import { randomUUID } from "node:crypto";
import type { ConversationDto, FindingDto, ReviewRunDto } from "@acalys/contracts/api/v1";
import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export type IdempotentMutationOutcome =
  | { readonly kind: "result"; readonly status: number; readonly body: unknown }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "conflict" }
  | { readonly kind: "in_progress" };

export interface IdempotencyIdentity {
  readonly organizationId: string;
  readonly principalId: string;
  readonly routeName: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly now: Date;
}

function iso(value: Date): string { return value.toISOString(); }
function errorBody(code: string, message: string) { return { code, message, retryability: "non_retryable" as const }; }

export class ApiMutationStore {
  public constructor(private readonly pool: PgPool) {}

  private async inTransaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value=await work(client); await client.query("COMMIT"); return value; }
    catch(error){ await client.query("ROLLBACK").catch(()=>undefined); throw error; }
    finally{ client.release(); }
  }

  private async idempotent(
    identity: IdempotencyIdentity,
    work: (client: PgClient) => Promise<{ readonly status: number; readonly body: unknown }>,
  ): Promise<IdempotentMutationOutcome> {
    return this.inTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO api_idempotency
           (organization_id, principal_id, route_name, idempotency_key, request_digest, state, created_at)
         VALUES ($1,$2,$3,$4,$5,'in_progress',$6)
         ON CONFLICT (organization_id, principal_id, route_name, idempotency_key) DO NOTHING`,
        [identity.organizationId, identity.principalId, identity.routeName, identity.key, identity.requestDigest, identity.now],
      );
      if (inserted.rowCount !== 1) {
        const existing = await client.query<{ request_digest:string; state:string; response_status:number|null; response_body:unknown }>(
          `SELECT request_digest, state, response_status, response_body
             FROM api_idempotency
            WHERE organization_id=$1 AND principal_id=$2 AND route_name=$3 AND idempotency_key=$4
            FOR UPDATE`,
          [identity.organizationId, identity.principalId, identity.routeName, identity.key],
        );
        const row=existing.rows[0];
        if(row===undefined) throw new Error("Idempotency row disappeared during conflict resolution");
        if(row.request_digest!==identity.requestDigest) return {kind:"conflict"};
        if(row.state==="completed" && row.response_status!==null) return {kind:"replay",status:row.response_status,body:row.response_body};
        return {kind:"in_progress"};
      }
      const result=await work(client);
      await client.query(
        `UPDATE api_idempotency SET state='completed', response_status=$6, response_body=$7::jsonb, completed_at=$8
          WHERE organization_id=$1 AND principal_id=$2 AND route_name=$3 AND idempotency_key=$4 AND request_digest=$5`,
        [identity.organizationId,identity.principalId,identity.routeName,identity.key,identity.requestDigest,result.status,JSON.stringify(result.body),identity.now],
      );
      return {kind:"result",...result};
    });
  }

  public createReview(input: {
    readonly identity: IdempotencyIdentity;
    readonly repositoryId: string;
    readonly pullRequestId: string;
    readonly requestedBy: unknown;
    readonly correlationId: string;
  }): Promise<IdempotentMutationOutcome> {
    return this.idempotent(input.identity, async (client) => {
      const seed=await client.query<{provider:string;provider_external_id:string;number:number;title:string;description:string|null;author:unknown;draft:boolean;revision_id:string;head_sha:string;head_ref:string;base_sha:string;base_ref:string;merge_base_sha:string|null}>(
        `SELECT p.provider,p.provider_external_id,p.number,p.title,p.description,p.author,p.draft,
                v.id AS revision_id,v.head_sha,v.head_ref,v.base_sha,v.base_ref,v.merge_base_sha
           FROM pull_requests p
           JOIN LATERAL (SELECT id,head_sha,head_ref,base_sha,base_ref,merge_base_sha FROM pull_request_revisions
                         WHERE organization_id=p.organization_id AND pull_request_id=p.id ORDER BY sequence DESC LIMIT 1) v ON TRUE
          WHERE p.organization_id=$1 AND p.repository_id=$2 AND p.id=$3`,
        [input.identity.organizationId,input.repositoryId,input.pullRequestId],
      );
      const resolved=seed.rows[0];
      if(resolved===undefined)return{status:404,body:errorBody("NOT_FOUND","Pull request not found")};
      const revisionId=resolved.revision_id;
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`api-review:${input.identity.organizationId}:${revisionId}`]);
      const active=await client.query<{id:string}>(
        `SELECT id FROM review_runs WHERE organization_id=$1 AND revision_id=$2
          AND state NOT IN ('completed','failed','cancelled','superseded')
          ORDER BY created_at DESC LIMIT 1`,[input.identity.organizationId,revisionId]);
      if(active.rows[0]!==undefined) return {status:409,body:errorBody("REVIEW_ALREADY_RUNNING","A review of this revision is already running")};
      const objectId=(value:string)=>({algorithm:value.length===64?"sha256":"sha1",value:value.toLowerCase()});
      const target={kind:"pull_request",schemaVersion:1,repositoryId:input.repositoryId,provider:resolved.provider,changeRequest:{kind:"change_request",provider:resolved.provider,externalId:resolved.provider_external_id,number:resolved.number},base:{name:resolved.base_ref,objectId:objectId(resolved.base_sha)},head:{name:resolved.head_ref,objectId:objectId(resolved.head_sha)},...(resolved.merge_base_sha===null?{}:{mergeBase:{objectId:objectId(resolved.merge_base_sha)}}),title:resolved.title,...(resolved.description===null?{}:{description:resolved.description}),author:resolved.author,draft:resolved.draft};
      const requestId=randomUUID(); const runId=randomUUID();
      await client.query(
        `INSERT INTO review_requests
          (id, organization_id, repository_id, pull_request_id, revision_id, target, trigger, requested_by,
           execution_mode, execution_strategy, idempotency_scope, idempotency_key, requested_at, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'api',$7::jsonb,'full','standard',$8,$9,$10,$11)`,
        [requestId,input.identity.organizationId,input.repositoryId,input.pullRequestId,revisionId,JSON.stringify(target),JSON.stringify(input.requestedBy),input.identity.organizationId,`api:${input.identity.principalId}:${input.identity.key}`,input.identity.now,input.correlationId],
      );
      await client.query(
        `INSERT INTO review_runs
          (id, organization_id, repository_id, request_id, revision_id, attempt, state, execution_mode, execution_strategy, created_at)
         VALUES ($1,$2,$3,$4,$5,1,'queued','full','standard',$6)`,
        [runId,input.identity.organizationId,input.repositoryId,requestId,revisionId,input.identity.now],
      );
      await client.query(
        `INSERT INTO review_dispatch_jobs
          (review_run_id, organization_id, revision_id, pull_request_id, available_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5,$5)`,
        [runId,input.identity.organizationId,revisionId,input.pullRequestId,input.identity.now],
      );
      const body: ReviewRunDto={id:runId,repositoryId:input.repositoryId,pullRequestId:input.pullRequestId,state:"queued",settled:false,createdAt:iso(input.identity.now)};
      return {status:202,body};
    });
  }

  public cancelReview(input: { readonly identity: IdempotencyIdentity; readonly reviewRunId:string; readonly reason?:string }): Promise<IdempotentMutationOutcome> {
    return this.idempotent(input.identity, async(client)=>{
      const q=await client.query<{id:string;repository_id:string;pull_request_id:string|null;state:ReviewRunDto["state"];failure_code:string|null;created_at:Date;started_at:Date|null;completed_at:Date|null}>(
        `SELECT r.id,r.repository_id,q.pull_request_id,r.state,r.failure_code,r.created_at,r.started_at,r.completed_at
           FROM review_runs r JOIN review_requests q ON q.id=r.request_id AND q.organization_id=r.organization_id
          WHERE r.organization_id=$1 AND r.id=$2 FOR UPDATE OF r`,[input.identity.organizationId,input.reviewRunId]);
      const row=q.rows[0]; if(row===undefined)return{status:404,body:errorBody("NOT_FOUND","Review not found")};
      if(!["queued","preparing","analyzing","reviewing","verifying","reconciling"].includes(row.state))return{status:409,body:errorBody("STATE_CONFLICT","Review can no longer be cancelled")};
      const seq=await client.query<{next_seq:number}>(`SELECT COALESCE(MAX(seq),0)+1 AS next_seq FROM review_run_transitions WHERE run_id=$1`,[input.reviewRunId]);
      await client.query(`UPDATE review_runs SET state='cancelled', completed_at=$3, cancel_reason=$4 WHERE organization_id=$1 AND id=$2`,[input.identity.organizationId,input.reviewRunId,input.identity.now,input.reason??null]);
      await client.query(`INSERT INTO review_run_transitions(run_id,seq,from_state,to_state,at) VALUES($1,$2,$3,'cancelled',$4)`,[input.reviewRunId,seq.rows[0]?.next_seq??1,row.state,input.identity.now]);
      const body:ReviewRunDto={id:row.id,repositoryId:row.repository_id,...(row.pull_request_id===null?{}:{pullRequestId:row.pull_request_id}),state:"cancelled",settled:true,createdAt:iso(row.created_at),...(row.started_at===null?{}:{startedAt:iso(row.started_at)}),completedAt:iso(input.identity.now)};
      return{status:200,body};
    });
  }

  public dismissFinding(input:{readonly identity:IdempotencyIdentity;readonly findingId:string;readonly reason:string}):Promise<IdempotentMutationOutcome>{
    return this.idempotent(input.identity,async(client)=>{
      const q=await client.query<{id:string;repository_id:string;review_run_id:string;severity:FindingDto["severity"];category:FindingDto["category"];confidence_level:FindingDto["confidence"];state:FindingDto["lifecycle"];title:string;explanation:string;path:string;start_line:number;end_line:number;evidence_count:number;suggested_fix_id:string|null;created_at:Date}>(
        `SELECT id,repository_id,review_run_id,severity,category,confidence_level,state,title,explanation,path,start_line,end_line,evidence_count,suggested_fix_id,created_at
           FROM review_findings WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[input.identity.organizationId,input.findingId]);
      const row=q.rows[0]; if(row===undefined)return{status:404,body:errorBody("NOT_FOUND","Finding not found")};
      if(row.state!=="published")return{status:409,body:errorBody("STATE_CONFLICT","Finding cannot be dismissed")};
      await client.query(`UPDATE review_findings SET state='dismissed',dismissal_reason=$3,updated_at=$4 WHERE organization_id=$1 AND id=$2`,[input.identity.organizationId,input.findingId,input.reason,input.identity.now]);
      const body:FindingDto={id:row.id,repositoryId:row.repository_id,reviewRunId:row.review_run_id,severity:row.severity,category:row.category,confidence:row.confidence_level,lifecycle:"dismissed",title:row.title,explanation:row.explanation,path:row.path,startLine:row.start_line,endLine:row.end_line,evidenceCount:row.evidence_count,hasSuggestedFix:row.suggested_fix_id!==null,createdAt:iso(row.created_at)};
      return{status:200,body};
    });
  }

  public resolveConversation(input:{readonly identity:IdempotencyIdentity;readonly conversationId:string}):Promise<IdempotentMutationOutcome>{
    return this.idempotent(input.identity,async(client)=>{
      const q=await client.query<{id:string;repository_id:string;pull_request_id:string|null;finding_id:string|null;state:ConversationDto["state"];created_at:Date;updated_at:Date}>(
        `SELECT id,repository_id,pull_request_id,finding_id,state,created_at,updated_at
           FROM review_conversations WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[input.identity.organizationId,input.conversationId]);
      const row=q.rows[0]; if(row===undefined)return{status:404,body:errorBody("NOT_FOUND","Conversation not found")};
      const count=await client.query<{message_count:number}>(
        `SELECT COUNT(*)::int AS message_count FROM conversation_messages WHERE organization_id=$1 AND conversation_id=$2`,
        [input.identity.organizationId,input.conversationId]);
      if(row.state!=="open")return{status:409,body:errorBody("STATE_CONFLICT","Conversation cannot be resolved")};
      await client.query(`UPDATE review_conversations SET state='resolved',updated_at=$3 WHERE organization_id=$1 AND id=$2`,[input.identity.organizationId,input.conversationId,input.identity.now]);
      const body:ConversationDto={id:row.id,repositoryId:row.repository_id,...(row.pull_request_id===null?{}:{pullRequestId:row.pull_request_id}),...(row.finding_id===null?{}:{findingId:row.finding_id}),state:"resolved",messageCount:count.rows[0]?.message_count??0,createdAt:iso(row.created_at),updatedAt:iso(input.identity.now)};
      return{status:200,body};
    });
  }
}
