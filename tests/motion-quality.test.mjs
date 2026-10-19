import test from 'node:test';
import assert from 'node:assert/strict';
import {createMotionQuality} from '../src/rendering/motion-quality.js';

function harness({latencyMs,rampFrames=0}){
  let clock=0,ratio=1.5;const sizes=[],changes=[],done=[];
  const renderer={setPixelRatio(v){ratio=v;},getPixelRatio(){return ratio;},setSize(w,h){sizes.push([w,h,ratio]);}};
  const queue={onSubmittedWorkDone(){let resolve;const promise=new Promise(r=>{resolve=r;});done.push(()=>{clock+=latencyMs();resolve();});return promise;}};
  // Deterministic rest timer: fireTimers() runs the pending restore.
  const timeouts=new Map();let timerId=0;
  const timers={setTimeout(fn,ms){timeouts.set(++timerId,{fn,ms});return timerId;},clearTimeout(id){timeouts.delete(id);}};
  const quality=createMotionQuality({renderer,queue,baseRatio:1.5,viewport:()=>({width:1324,height:907}),rampFrames,sampleCount:8,holdMs:500,timers,now:()=>clock,onChange:(level,r)=>changes.push([level,r])});
  const flush=async()=>{while(done.length){done.shift()();await Promise.resolve();}await new Promise(r=>setTimeout(r,0));};
  const fireTimers=()=>{for(const [id,{fn}] of [...timeouts]){timeouts.delete(id);fn();}};
  return {quality,renderer,sizes,changes,flush,fireTimers,timeouts,tick(ms){clock+=ms;},get ratio(){return ratio;}};
}

test('a GPU-bound interaction steps the pixel ratio down once per hold period and rest restores it',async()=>{
  const h=harness({latencyMs:()=>24});
  h.quality.setInteracting(true);
  for(let i=0;i<7;i++){h.quality.frameSubmitted();await h.flush();h.tick(16);}
  assert.equal(h.ratio,1.5,'seven samples are not enough for a decision');
  h.quality.frameSubmitted();await h.flush();
  assert.equal(h.quality.level,1);assert.ok(Math.abs(h.ratio-1.275)<1e-9);
  assert.deepEqual(h.sizes.at(-1),[1324,907,1.275],'the canvas is resized at the reduced ratio');
  for(let i=0;i<8;i++){h.quality.frameSubmitted();await h.flush();h.tick(16);}
  assert.equal(h.quality.level,1,'the hold period blocks a second step');
  h.tick(600);
  for(let i=0;i<8;i++){h.quality.frameSubmitted();await h.flush();h.tick(16);}
  assert.equal(h.quality.level,2);assert.ok(Math.abs(h.ratio-1.05)<1e-9);
  for(let i=0;i<20;i++){h.tick(600);h.quality.frameSubmitted();await h.flush();}
  assert.equal(h.quality.level,2,'the lowest level is the floor');
  // A short pause between two drags keeps the level; the restore timer is cancelled.
  h.quality.setInteracting(false);
  assert.equal(h.quality.level,2,'nothing changes at release');assert.equal(h.timeouts.size,1,'restore is scheduled');
  h.quality.setInteracting(true);
  assert.equal(h.timeouts.size,0,'the next press cancels the restore');assert.equal(h.quality.level,2);
  h.quality.setInteracting(false);h.fireTimers();
  assert.equal(h.quality.level,0);assert.equal(h.ratio,1.5);
  assert.deepEqual(h.changes.map(c=>c[0]),[1,2,0]);
});

test('a GPU that keeps up never changes the ratio, and samples outside an interaction are ignored',async()=>{
  const h=harness({latencyMs:()=>9});
  for(let i=0;i<10;i++){h.quality.frameSubmitted();await h.flush();}
  h.quality.setInteracting(true);
  for(let i=0;i<30;i++){h.quality.frameSubmitted();await h.flush();h.tick(16);}
  assert.equal(h.quality.level,0);assert.equal(h.ratio,1.5);assert.equal(h.sizes.length,0);
  h.quality.setInteracting(false);
  assert.equal(h.sizes.length,0,'returning to rest at full quality does not resize');
});

test('the slow frames while the GPU leaves idle are not samples',async()=>{
  let frame=0;const h=harness({latencyMs:()=>frame<=10?60:9,rampFrames:10});
  h.quality.setInteracting(true);
  for(frame=1;frame<=40;frame++){h.quality.frameSubmitted();await h.flush();h.tick(16);}
  assert.equal(h.quality.level,0,'ramp-up latency never counted');
  h.quality.setInteracting(false);h.quality.setInteracting(true);
  for(frame=1;frame<=10;frame++){h.quality.frameSubmitted();await h.flush();h.tick(16);}
  const slow=harness({latencyMs:()=>30,rampFrames:10});slow.quality.setInteracting(true);
  for(let i=0;i<17;i++){slow.quality.frameSubmitted();await slow.flush();slow.tick(16);}
  assert.equal(slow.quality.level,0,'ten ramp frames plus seven samples');
  slow.quality.frameSubmitted();await slow.flush();
  assert.equal(slow.quality.level,1,'the eighth sample after the ramp decides');
});

test('dispose restores the base ratio',async()=>{
  const h=harness({latencyMs:()=>30});
  h.quality.setInteracting(true);
  for(let i=0;i<8;i++){h.quality.frameSubmitted();await h.flush();h.tick(16);}
  assert.equal(h.quality.level,1);
  h.quality.dispose();
  assert.equal(h.ratio,1.5);
  h.quality.frameSubmitted();await h.flush();assert.equal(h.quality.level,0);
});
