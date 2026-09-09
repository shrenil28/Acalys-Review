import { describe, expect, it } from "vitest";
import { createApiDispatchWorker } from "../src/api-dispatch-worker.js";
import type { ReviewDispatchStore } from "@acalys/database";
import type { ReviewExecutionPort } from "../src/worker.js";

describe("API review dispatch",()=>{
  it("defers peer-owned execution without treating it as a failure",async()=>{
    const calls:string[]=[];
    const store={
      async claim(){return[{reviewRunId:"run",organizationId:"org",revisionId:"rev",pullRequestId:"pr",attempts:1,claimGeneration:7}]},
      async defer(_id:string,generation:number){calls.push(`defer:${generation}`)},
      async complete(){calls.push("complete")}, async release(){calls.push("release")},
    } as unknown as ReviewDispatchStore;
    const execution={async execute(){return{kind:"deferred",state:"verifying"} as const}} satisfies ReviewExecutionPort;
    const worker=createApiDispatchWorker({store,reviewExecution:execution,pollIntervalMillis:1});
    expect(await worker.runOnce()).toBe(1); expect(calls).toEqual(["defer:7"]);
  });
});
