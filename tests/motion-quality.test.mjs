import test from 'node:test';
import assert from 'node:assert/strict';
import {createMotionQuality} from '../src/rendering/motion-quality.js';

function harness({latencyMs,rampFrames=0,baseRatio=1.5}){
  let clock=0,ratio=baseRatio,queries=0;const sizes=[],changes=[],done=[];
  const renderer={setPixelRatio(v){ratio=v;},getPixelRatio(){return ratio;},setSize(w,h){sizes.push([w,h,ratio]);}};
  const queue={onSubmittedWorkDone(){queries++;let resolve;const promise=new Promise(r=>{resolve=r;});done.push(()=>{clock+=latencyMs();resolve();});return promise;}};
  const quality=createMotionQuality({renderer,queue,baseRatio,viewport:()=>({width:1324,height:907}),rampFrames,sampleCount:8,holdMs:500,now:()=>clock,onChange:(level,r)=>changes.push([level,r])});
  const flush=async()=>{while(done.length){done.shift()();await Promise.resolve();}await new Promise(r=>setTimeout(r,0));};
  return {quality,renderer,sizes,changes,flush,tick(ms){clock+=ms;},get ratio(){return ratio;},get queries(){return queries;}};
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
  assert.equal(h.quality.level,3,'the new level reaches the 0.75x floor');assert.equal(h.ratio,.75);
  // Every stop restores immediately; the next gesture reuses the learned level.
  h.quality.setInteracting(false);
  assert.equal(h.quality.level,0);assert.equal(h.ratio,1.5);
  h.quality.setInteracting(true);assert.equal(h.quality.level,3);
  h.quality.setInteracting(false);
  assert.equal(h.quality.level,0);assert.equal(h.ratio,1.5);
  assert.deepEqual(h.changes.map(c=>c[0]),[1,2,3,0,3,0]);
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


test('the next gesture reuses the learned motion ratio after the still image restores',async()=>{
  const h=harness({latencyMs:()=>30});h.quality.setInteracting(true);
  for(let i=0;i<32;i++){h.tick(600);h.quality.frameSubmitted();await h.flush();}
  assert.equal(h.ratio,.75);
  h.quality.setInteracting(false);assert.equal(h.ratio,1.5);
  h.quality.setInteracting(true);assert.equal(h.ratio,.75,'no full-resolution slow ramp on every drag');
  h.quality.setInteracting(false);h.quality.setBaseRatio(1);h.renderer.setPixelRatio(1);
  h.quality.setInteracting(true);assert.equal(h.ratio,1,'a user quality change resets the learned budget');
});
test('adaptive motion never drops below the lowest selectable raster ratio',async()=>{
  for(const baseRatio of [1,.75,.5]){
    const h=harness({baseRatio,latencyMs:()=>30});h.quality.setInteracting(true);
    for(let i=0;i<40;i++){h.tick(600);h.quality.frameSubmitted();await h.flush();}
    assert.equal(h.ratio,Math.min(baseRatio,.75));
    const changes=h.changes.length,queries=h.queries;
    for(let i=0;i<16;i++){h.tick(600);h.quality.frameSubmitted();await h.flush();}
    assert.equal(h.changes.length,changes,'no duplicate target allocations at the floor');
    assert.equal(h.queries,queries,'no queue completion fences when no lower level exists');
  }
});


test('the default restores full resolution synchronously when motion ends',async()=>{
  const h=harness({latencyMs:()=>30});h.quality.setInteracting(true);
  for(let i=0;i<8;i++){h.quality.frameSubmitted();await h.flush();h.tick(16);}
  assert.ok(h.ratio<1.5);
  h.quality.setInteracting(false);
  assert.equal(h.ratio,1.5);
  h.quality.setInteracting(true);assert.ok(h.ratio<1.5,'the learned motion level is retained');
});
