import test from "node:test";
import assert from "node:assert/strict";
import { workOptions, workTriggers, workPrompt } from "../dist/work-window.js";
test("options default off and reject invalid modes or planner/quorum combinations", () => {
 assert.deepEqual(workOptions(), { fixedWorkMs: 0, researchEffort: "standard" });
 for (const x of [-1, 1000, NaN]) assert.throws(() => workOptions({ fixedWorkMs:x }));
 assert.throws(() => workOptions({ researchEffort:"unknown" }));
 assert.throws(() => workOptions({ fixedWorkMs:1800000 }, {enabled:true}));
 assert.throws(() => workOptions({ researchEffort:"persistent" }, {enabled:true}));
});
test("fixed mode removes early termination triggers but retains token bound and diagnostic checks", () => {
 const original=["said DONE", "check bash check.sh", "after 45m", "count 2", "budget 15M tokens"];
 assert.equal(workTriggers(original,workOptions()),original);
 assert.deepEqual(workTriggers(original,workOptions({fixedWorkMs:1800000})),["check bash check.sh","budget 15M tokens","after 1800s"]);
});
test("persistent instructions independent of timing; fixed-only does not add experimental research advice", () => {
 assert.equal(workPrompt(workOptions(),null,0),"");
 const prompt=workPrompt(workOptions({researchEffort:"persistent"}),null,0);
 assert.ok(prompt.includes("Never fabricate")); assert.ok(!prompt.includes("no early finish"));
 const fixed=workPrompt(workOptions({fixedWorkMs:60000}),60000,0);
 assert.ok(fixed.includes("Remaining: 60 seconds")); assert.ok(!fixed.includes("highest-priority"));
 assert.ok(workPrompt(workOptions({fixedWorkMs:60000,researchEffort:"persistent"}),60000,60001).includes("Remaining: 0 seconds"));
});
import { goalWatch } from '../dist/goal.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
for (const reason of ['budget', 'owner']) test(`fixed mode preserves ${reason} safety termination`, async t => {
 const out=await mkdtemp(join(tmpdir(),'window-test-'));t.after(()=>rm(out,{recursive:true,force:true}));
 const started='2026-10-21T00:00:00Z';let closed=null;
 const view=()=>({room:{state:closed?'closed':'open',goal:{sequence:1,started_at:started,until:['after 1800s','budget 15M tokens'],ended_by:closed}},memberships:[]});
 const client={async request(method,path,token,body){
  if(path.endsWith('/close')){closed={...body,at:started};return view();}
  if(path.includes('/wait?')){closed={trigger:'owner',at:started};return {items:[]};}
  return view();
 }};
 const result=await goalWatch(client,'member','owner',{roomId:'test',workspace:out,out,checkEveryMs:60000,quietChecks:true,fixedWorkMs:1800000,roomCheckMs:0},{now:()=>new Date(started),snapshot:null,spend:()=>reason==='budget'?15000000:0});
 assert.equal(result.ended_by.trigger,reason==='budget'?'budget 15M tokens':'owner');
});
