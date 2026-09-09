import { ReviewDispatchStore, StaleReviewDispatchClaim } from "@acalys/database";
import type { ReviewExecutionPort } from "./worker.js";

export interface ApiDispatchWorkerOptions {
  readonly store: ReviewDispatchStore;
  readonly reviewExecution: ReviewExecutionPort;
  readonly batchSize?: number;
  readonly leaseMillis?: number;
  readonly pollIntervalMillis?: number;
  readonly retryBackoffMillis?: number;
  readonly observer?: { readonly onError?: (error: unknown) => void };
}

export interface RunningApiDispatchWorker { start(): void; stop(): Promise<void>; runOnce(): Promise<number>; }

export function createApiDispatchWorker(options: ApiDispatchWorkerOptions): RunningApiDispatchWorker {
  const batchSize=options.batchSize??10; const leaseMillis=options.leaseMillis??60_000;
  const pollMillis=options.pollIntervalMillis??1_000; const retryBackoff=options.retryBackoffMillis??5_000;
  let timer:NodeJS.Timeout|undefined; let stopped=false; let inFlight:Promise<void>|undefined;

  const runOnce=async():Promise<number>=>{
    const claims=await options.store.claim(batchSize,leaseMillis,new Date());
    for(const claim of claims){
      try{
        const outcome=await options.reviewExecution.execute({runId:claim.reviewRunId,revisionId:claim.revisionId,pullRequestId:claim.pullRequestId,deliveryRowId:`api:${claim.reviewRunId}`});
        switch(outcome.kind){
          case "settled": await options.store.complete(claim.reviewRunId,claim.claimGeneration); break;
          case "deferred": await options.store.defer(claim.reviewRunId,claim.claimGeneration,new Date(Date.now()+pollMillis),new Date()); break;
          case "retryable_failure": await options.store.release(claim.reviewRunId,claim.claimGeneration,new Date(Date.now()+retryBackoff),outcome.errorCode,new Date()); break;
          case "permanent_failure": await options.store.deadLetter(claim.reviewRunId,claim.claimGeneration,outcome.errorCode,new Date()); break;
        }
      }catch(error){ if(error instanceof StaleReviewDispatchClaim)continue; options.observer?.onError?.(error); }
    }
    return claims.length;
  };
  const schedule=()=>{if(stopped)return; timer=setTimeout(()=>{inFlight=runOnce().then(()=>undefined).catch((e)=>options.observer?.onError?.(e)).finally(()=>{inFlight=undefined;schedule();});},pollMillis);};
  return {start(){if(!stopped&&timer===undefined&&inFlight===undefined)schedule();},async stop(){stopped=true;if(timer!==undefined){clearTimeout(timer);timer=undefined;}await inFlight;},runOnce};
}
