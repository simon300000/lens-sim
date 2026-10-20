import test from 'node:test';
import assert from 'node:assert/strict';
import {createRasterSubmission} from '../src/rendering/raster-submission.js';
function harness(){
  const tasks=new Map(),done=[],renders=[];let id=0,pose=0,allowed=true;
  const submission=createRasterSubmission({
    queue:{onSubmittedWorkDone(){return new Promise((resolve,reject)=>done.push({resolve,reject}));}},
    render:()=>renders.push(pose),canSubmit:()=>allowed,
    schedule:fn=>{tasks.set(++id,fn);return id;},cancel:key=>tasks.delete(key),
  });
  return {submission,renders,tasks,done,setPose:value=>{pose=value;},allow:value=>{allowed=value;},
    run(){const batch=[...tasks.values()];tasks.clear();for(const fn of batch)fn();},
    async finish(index=0){done[index].resolve();await Promise.resolve();},
    async reject(index=0){done[index].reject(new Error('device lost'));await Promise.resolve();},
  };
}
test('two frames overlap; overload coalesces to the latest pose after GPU completion',async()=>{
  const h=harness();
  h.setPose(1);h.submission.request();assert.equal(h.renders.length,0,'input gets a task turn');h.run();
  h.setPose(2);h.submission.request();h.run();
  for(let i=3;i<=9;i++){h.setPose(i);h.submission.request();h.run();}
  assert.deepEqual(h.renders,[1,2]);assert.equal(h.done.length,2);
  await h.finish();assert.deepEqual(h.renders,[1,2]);assert.equal(h.tasks.size,1);
  h.setPose(10);h.submission.request();assert.equal(h.tasks.size,1);h.run();
  assert.deepEqual(h.renders,[1,2,10],'completion submits the current pose without waiting for another rAF');
  await h.finish(1);h.run();assert.equal(h.renders.length,3,'no repeated frame without a request');
});
test('cancelling pending pointer work leaves room for an immediate still or lens frame',async()=>{
  const h=harness();h.submission.request();h.run();h.submission.request();h.run();h.submission.request();
  h.submission.cancel();await h.finish();h.run();assert.equal(h.renders.length,2);
  h.submission.request();h.submission.cancel();h.run();assert.equal(h.renders.length,2);
});
test('a queued callback rechecks pointer and render mode before submitting',()=>{
  const h=harness();h.submission.request();h.allow(false);h.run();assert.deepEqual(h.renders,[]);
  h.allow(true);h.submission.request();h.run();assert.equal(h.renders.length,1);
});
test('new gestures still respect completions outstanding from the previous gesture',async()=>{
  const h=harness();h.submission.request();h.run();h.submission.request();h.run();h.submission.cancel();
  h.setPose(8);h.submission.request();h.run();assert.equal(h.renders.length,2);
  await h.finish();h.run();assert.deepEqual(h.renders,[0,0,8]);
});
test('dispose cancels scheduled work and late GPU completions',async()=>{
  const h=harness();h.submission.request();h.run();h.submission.request();h.run();h.submission.request();
  h.submission.dispose();await h.finish();h.submission.request();h.run();assert.equal(h.renders.length,2);
  const idle=harness();idle.submission.request();idle.submission.dispose();idle.run();assert.deepEqual(idle.renders,[]);
});
test('a rejected completion never automatically retries pending work',async()=>{
  const h=harness();h.submission.request();h.run();h.submission.request();h.run();h.submission.request();
  await h.reject();await h.finish(1);h.run();assert.equal(h.renders.length,2);
});
