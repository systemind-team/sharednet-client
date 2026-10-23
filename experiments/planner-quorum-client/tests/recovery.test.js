import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordination, coordinationOptions } from '../dist/coordination.js';
const flush = () => new Promise(r => setImmediate(r));
function fixture({ cancelFails = false, deferConfirmation = false } = {}) {
    let clock = 0, sequence = 0, confirm;
    const turns = [], events = [], cancelled = [], notices = [];
    const records = [1,2,3].map(i => ({name:`codex-${i}`,member_id:`id-${i}`,driver:'codex',model:'luna',tokens:0,turns:0}));
    const c = new Coordination({records, options:coordinationOptions({startupMode:'simultaneous',completionPolicy:'all-agents-done',plannerSeed:'recovery'},['check true']),goal:'test',roomId:'test',
        now:()=>new Date(clock),event:e=>events.push(e),notifyRecovery:async n=>notices.push(n),
        runTurn:(seat,prompt)=>new Promise(resolve=>{ seat.turns++; turns.push({seat,prompt,resolve}); }),
        cancelTurn:async seat=>{cancelled.push(seat.name);if(cancelFails)throw Error('stop failed');turns.findLast(t=>t.seat===seat).resolve(true);if(deferConfirmation)await new Promise(r=>confirm=r);}
    });
    const tick=async(ms=0)=>{clock+=ms;c.tick();await flush();};
    const say=(i,content)=>c.observe({sequence:++sequence,sender_instance_id:`id-${i}`,content});
    const exit=async()=>{for(let i=0;i<3;i++){turns.findLast(t=>t.seat.name==='codex-1').resolve(true);await flush();if(i<2)await tick(5000);}};
    return {c,turns,events,cancelled,notices,tick,say,exit,confirm:()=>confirm()};
}
test('stuck dependants cancel after grace; no new turn until cancellation confirmation; requests survive',async()=>{
    const f=fixture({deferConfirmation:true});await f.tick();
    f.say(3,'@codex-2 REOPEN audit-1: verify the final report');await f.exit();
    assert.equal(f.c.phase,'planning');assert.equal(f.notices.length,1);
    await f.tick(29999);assert.equal(f.cancelled.length,0);
    // One worker voluntarily leaves. Only the remaining busy seat is cancelled.
    f.turns.findLast(t=>t.seat.name==='codex-3').resolve(false);await flush();
    await f.tick(1);assert.deepEqual(f.cancelled,['codex-2']);
    const count=f.turns.length;await f.tick();assert.equal(f.turns.length,count);
    assert.equal(f.c.live.find(s=>s.record.name==='codex-2').failures,0);
    assert.equal(f.c.live.find(s=>s.record.name==='codex-2').successes,0);
    assert.equal(f.c.ready,false);assert.equal(f.c.exits.length,1);
    f.confirm();await flush();await f.tick();
    assert.equal(f.turns.length,count+1);assert.match(f.turns.at(-1).prompt,/redistribute all their unfinished work/);
    assert.equal(f.c.live.find(s=>s.record.name==='codex-2').requests.length,1);
    const planner=f.c.planner;f.say(Number(planner.split('-')[1]),'New task allocation');f.say(Number(planner.split('-')[1]),'PLAN_READY');
    f.turns.at(-1).resolve(false);await flush();await f.tick();
    for(const s of f.c.live){f.say(Number(s.record.name.split('-')[1]),'DONE');f.turns.findLast(t=>t.seat===s.record).resolve(false);}
    await flush();assert.equal(f.c.ready,true);f.c.approveCompletion();f.c.finish({trigger:'check true'});
    assert.equal(f.c.status,'completed_degraded');assert.equal(f.c.summary().configured_count,3);
});
test('failed cancellation never releases a new planner or approves completion',async()=>{
    const f=fixture({cancelFails:true});await f.tick();await f.exit();await f.tick(30000);
    const count=f.turns.length;assert.throws(()=>f.c.tick(),/confirm recovery cancellation/);
    assert.equal(f.turns.length,count);assert.equal(f.c.ready,false);assert.equal(f.c.exits.length,1);
    assert.ok(f.events.some(e=>e.type==='recovery_cancel_failed'));
});
test('voluntary old-turn drain avoids cancellation; old DONE cannot satisfy new epoch',async()=>{
    const f=fixture();await f.tick();await f.exit();
    for(const i of [2,3]){f.say(i,'DONE');f.turns.findLast(t=>t.seat.name===`codex-${i}`).resolve(false);}
    await flush();await f.tick(1000);assert.equal(f.cancelled.length,0);assert.equal(f.c.ready,false);
    assert.match(f.turns.at(-1).prompt,/randomly selected as planner/);
});
test('time bound stops recovery without launching or cancelling more turns',async()=>{
    const f=fixture();await f.tick();await f.exit();f.c.finish({trigger:'after 45m'});
    const count=f.turns.length;await f.tick(60000);assert.equal(f.cancelled.length,0);assert.equal(f.turns.length,count);assert.equal(f.c.status,'timeout');
});
