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
 const win=new EventTarget();win.location={href:'http://localhost/?'+query};win.setTimeout=setTimeout;win.clearTimeout=clearTimeout;
 win.history={state:null,replaceState(_,__,href){win.location.href=href;}};
 const sync=await installURLState({camera,controls,store,window:win,requestFrame:()=>{}});sync.dispose();
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
