import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {installURLState} from '../src/url-state.js';
import {createControlStore} from '../src/rendering/control-store.js';
async function restore(query){
 const calls=[],store=createControlStore({status:'ready',lensId:'noct'});
 store.update({optics:{...store.getState().optics,imageDistanceMm:1,focusDistanceM:null,fNumber:1}});
 store.setHandler(async({type,value})=>{
  calls.push([type,value]);const s=store.getState();
  if(type==='setFocusDistance')store.update({optics:{...s.optics,focusDistanceM:value,imageDistanceMm:1,focusDistanceKnown:true}});
  if(type==='setImageDistance')store.update({optics:{...s.optics,imageDistanceMm:value,focusDistanceKnown:false}});
 });
 const camera=new THREE.PerspectiveCamera(),controls=new EventTarget();controls.target=new THREE.Vector3();controls.update=()=>{};
 const win=new EventTarget();win.location={href:'http://localhost/?'+query};
 const clock=installClock(win);
 win.history={state:null,replaceState(_,__,href){win.location.href=href;}};
 const sync=await installURLState({camera,controls,store,window:win,requestFrame:()=>{}});clock.advance(1000);sync.dispose();
 return {calls,state:store.getState(),url:new URL(win.location.href),camera,controls};
}
test('legacy known focus recomputes focus without reinstalling the old sensor gap',async()=>{
 const r=await restore('lens=noct&focus=5.999&focusKnown=1&imageDistance=.047665&pos=1,2,3&target=1,2,-3&debug=keep');
 assert.equal(r.state.optics.imageDistanceMm,1);assert.ok(r.calls.some(([c])=>c==='setFocusDistance'));
 assert.ok(!r.calls.some(([c])=>c==='setImageDistance'));
 assert.equal(r.url.searchParams.get('focusSolver'),'bench-v1');assert.equal(r.url.searchParams.get('debug'),'keep');
 assert.equal(r.url.searchParams.has('mode'),false);assert.equal(r.state.mode,'raster');assert.deepEqual(r.camera.position.toArray(),[1,2,3]);
});
test('an explicitly manual sensor adjustment survives legacy link restoration',async()=>{
 const r=await restore('lens=noct&focus=6&focusKnown=0&imageDistance=.047665');
 assert.equal(r.state.optics.imageDistanceMm,.047665);assert.equal(r.state.optics.focusDistanceKnown,false);
});
test('current solver links preserve the saved exact image plane',async()=>{
 const r=await restore('lens=noct&focus=6&focusKnown=1&focusSolver=bench-v1&imageDistance=1.1');
 assert.equal(r.state.optics.imageDistanceMm,1.1);assert.equal(r.state.optics.focusDistanceKnown,true);
});

function installClock(win){
 let now=0,id=0;const tasks=new Map();
 win.setTimeout=(fn,ms)=>{tasks.set(++id,{at:now+ms,fn});return id;};
 win.clearTimeout=id=>tasks.delete(id);
 return {get pending(){return tasks.size;},advance(ms){
  const until=now+ms;
  while(true){const next=[...tasks].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
   if(!next)break;tasks.delete(next[0]);now=next[1].at;next[1].fn();}
  now=until;
 }};
}
async function navigation(){
 const win=new EventTarget(),clock=installClock(win),writes=[];
 win.location={href:'http://localhost/?debug=keep#view'};
 win.history={state:{keep:true},replaceState(state,_,href){writes.push({state,href});win.location.href=href;}};
 const camera=new THREE.PerspectiveCamera(),controls=new EventTarget();
 controls.target=new THREE.Vector3(0,0,-1);controls.active=false;
 const store=createControlStore({status:'ready',lensId:'noct'});
 const sync=await installURLState({camera,controls,store,window:win,requestFrame:()=>{}});
 const start=()=>{controls.active=true;controls.dispatchEvent(new Event('start'));};
 const end=()=>{controls.active=false;controls.dispatchEvent(new Event('end'));};
 const move=x=>{camera.position.x=x;controls.dispatchEvent(new Event('change'));};
 return {win,clock,writes,controls,store,sync,start,end,move};
}
test('URL waits for input release and settling, even if a held drag stops moving',async()=>{
 const r=await navigation();r.start();r.move(2);r.clock.advance(5000);
 assert.equal(r.writes.length,0);assert.equal(r.clock.pending,0);
 // An optics update during the same gesture must not schedule a history write.
 r.store.update({optics:{...r.store.getState().optics,fNumber:4}});
 r.clock.advance(5000);assert.equal(r.writes.length,0);
 r.move(3);r.end();r.clock.advance(999);assert.equal(r.writes.length,0);
 r.clock.advance(1);assert.equal(r.writes.length,1);
 const url=new URL(r.writes[0].href);
 assert.equal(url.searchParams.get('pos'),'3,0,0');assert.equal(url.searchParams.get('fNumber'),'4');
 assert.equal(url.searchParams.get('debug'),'keep');assert.equal(url.hash,'#view');
 assert.deepEqual(r.writes[0].state,{keep:true});r.sync.dispose();
});
test('resuming navigation cancels the pending URL write and starts a fresh idle delay',async()=>{
 const r=await navigation();r.start();r.move(1);r.end();r.clock.advance(900);
 r.start();r.clock.advance(2000);assert.equal(r.writes.length,0);
 r.move(4);r.end();r.clock.advance(999);assert.equal(r.writes.length,0);
 r.clock.advance(1);assert.equal(r.writes.length,1);r.sync.dispose();
});
test('programmatic pose changes debounce; disposal and pagehide never force history writes',async()=>{
 const r=await navigation();r.move(1);r.clock.advance(900);r.move(2);
 r.clock.advance(999);assert.equal(r.writes.length,0);r.clock.advance(1);assert.equal(r.writes.length,1);
 r.move(3);r.win.dispatchEvent(new Event('pagehide'));r.clock.advance(2000);assert.equal(r.writes.length,1);
 r.move(4);r.sync.dispose();r.clock.advance(2000);r.move(5);r.clock.advance(2000);
 assert.equal(r.writes.length,1);assert.equal(r.clock.pending,0);
});
