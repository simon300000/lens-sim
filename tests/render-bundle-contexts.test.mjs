import test from 'node:test';
import assert from 'node:assert/strict';
import {installRenderBundleContexts} from '../src/rendering/three-interop.js';

/** Minimal stand-ins for Renderer._bundles (ChainMap registry) and the WebGPU backend. */
function fakeRenderer(){
  const chain=new Map();const keyOf=keys=>keys.map(k=>k.id).join('/');
  const registry={bundles:{get(keys){return chain.get(keyOf(keys));},set(keys,value){chain.set(keyOf(keys),value);}},get(){throw new Error('replaced');},dispose(){chain.clear();}};
  const data=new WeakMap(),executed=[];
  const backend={get(object){let d=data.get(object);if(!d){d={};data.set(object,d);}return d;},addBundle(renderContext,bundle){this.get(renderContext).renderBundles.push(bundle);}};
  const renderer={_bundles:registry,backend,_currentRenderContext:null};
  return {renderer,registry,backend,executed};
}

test('bundles are registered per group, camera and render context, and executed immediately',()=>{
  const {renderer,registry,backend}=fakeRenderer();
  const api=installRenderBundleContexts(renderer);
  const group={id:'g'},camera={id:'c'},prepass={id:'prepass',renderTarget:{name:'normals'}},beauty={id:'beauty',renderTarget:{name:'beauty'}};
  renderer._currentRenderContext=prepass;const a=registry.get(group,camera);
  renderer._currentRenderContext=beauty;const b=registry.get(group,camera);
  assert.notEqual(a,b,'one bundle record per render context');
  assert.equal(registry.get(group,camera),b,'stable per context');
  assert.equal(a.renderContext,prepass);assert.equal(api.recorded,2);
  renderer._currentRenderContext=null;assert.throws(()=>registry.get(group,camera),/outside of a render context/);
  // Execution: immediate, with the backend's redundant-state tracking reset.
  const executed=[];const contextData=backend.get(beauty);
  contextData.currentPass={executeBundles(list){executed.push(...list);}};contextData.currentSets={pipeline:'stale',attributes:{a:1},bindingGroups:[1],index:'i'};
  backend.get(b).bundleGPU='bundle-gpu';
  backend.addBundle(beauty,b);
  assert.deepEqual(executed,['bundle-gpu']);
  assert.deepEqual(contextData.currentSets,{attributes:{},bindingGroups:[],pipeline:null,index:null});
  assert.equal(contextData.renderBundles,undefined,'nothing deferred to the end of the pass');
  // Targeted invalidation forces Three's version check to re-record only the matching bundles.
  backend.get(a).version=3;backend.get(b).version=3;
  assert.equal(api.invalidate(record=>record.renderContext.renderTarget.name==='beauty'),1);
  assert.equal(backend.get(b).version,-1);assert.equal(backend.get(a).version,3);
  assert.equal(api.invalidate(),2);
  // Idempotent install keeps the existing registry.
  installRenderBundleContexts(renderer);
  renderer._currentRenderContext=beauty;assert.equal(registry.get(group,camera),b);
  registry.dispose();assert.equal(api.recorded,0);
});
