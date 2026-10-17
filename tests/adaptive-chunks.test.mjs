import test from 'node:test';
import assert from 'node:assert/strict';
import {createChunkBudget,chunkDispatch,createCompletionClock} from '../src/rendering/adaptive-chunks.js';
const capacity=1500000;
function measurement(plan,interactive=false){return {...plan,interactive,chunked:true,capacity};}
test('idle grows past the previous fixed ray ceiling and slow outliers never shrink it',()=>{
 const budget=createChunkBudget();let plan;
 for(let i=0;i<12;i++){plan=budget.plan(false,4,375000);budget.observe(measurement(plan),5);}
 plan=budget.plan(false,4,375000);assert.ok(plan.work>32768);assert.equal(plan.targetMs,30);
 const previous=plan.work;for(const ms of [31,100,800])budget.observe(measurement(plan),ms);
 assert.equal(budget.plan(false,4,375000).work,previous);
});
test('interaction has independent feedback, grows past 2048 rays and can consume a short tail exactly',()=>{
 const budget=createChunkBudget();let plan=budget.plan(true,1,375000);budget.observe(measurement(plan,true),.2);
 plan=budget.plan(true,1,375000);assert.ok(plan.work>32);assert.equal(plan.targetMs,3);
 assert.equal(budget.plan(false,4,375000).work,1024);
 assert.equal(budget.plan(true,1,3).groups,3);assert.equal(budget.plan(true,1,3).tail,true);
});
test('large linear chunks cross the dispatch row limit without exceeding GPU limits',()=>{
 for(const count of [1,65535,65536,375000]){
  const {x,y}=chunkDispatch(count,65535);
  assert.ok(x<=65535&&y<=65535);assert.ok(x*y>=count);assert.ok(x*(y-1)<count);
 }
 assert.throws(()=>chunkDispatch(0,65535),RangeError);
});
test('completion clock times queued chunks from the previous completion, idle ones from submission',()=>{
 const clock=createCompletionClock();
 assert.equal(clock.complete(0,30),30,'idle queue: submit to done');
 assert.equal(clock.complete(10,62),32,'queued behind the first: starts when it finished');
 assert.equal(clock.complete(100,104),4,'queue drained before submit');
});
