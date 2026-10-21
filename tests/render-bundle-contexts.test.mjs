import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderTarget,HalfFloatType} from 'three/webgpu';
import RenderContexts from '../node_modules/three/src/renderers/common/RenderContexts.js';
import Renderer from '../node_modules/three/src/renderers/common/Renderer.js';
import {installRenderBundleContexts} from '../src/rendering/three-interop.js';

/** Minimal stand-ins for Renderer._bundles (ChainMap registry) and the WebGPU backend. */
function fakeRenderer(){
  const chain=new Map(),ids=new WeakMap();let serial=0;
  const keyOf=keys=>keys.map(k=>{if(!ids.has(k))ids.set(k,++serial);return ids.get(k);}).join('/');
  const registry={bundles:{get(keys){return chain.get(keyOf(keys));},set(keys,value){chain.set(keyOf(keys),value);}},get(){throw new Error('replaced');},dispose(){chain.clear();}};
  const data=new WeakMap(),executed=[];
  const backend={get(object){let d=data.get(object);if(!d){d={};data.set(object,d);}return d;},addBundle(renderContext,bundle){this.get(renderContext).renderBundles.push(bundle);}};
  const renderer={_bundles:registry,backend,_currentRenderContext:null,target:null,getRenderTarget(){return this.target;},getClearDepth:()=>1,getClearStencil:()=>0};
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

// Use Three's actual context reuse and bundle replay logic: distinct targets
// with equal formats really do share a context, unlike the simple fixture above.
test('single-sample beauty never replays the lighting-refresh subset',()=>{
  const {renderer,backend}=fakeRenderer();installRenderBundleContexts(renderer);
  const contexts=new RenderContexts(renderer);
  const beauty=new RenderTarget(900,600,{type:HalfFloatType,samples:0,depthBuffer:true});
  const refresh=new RenderTarget(16,11,{type:HalfFloatType,depthBuffer:true});
  const shared=contexts.get(beauty,null,2);
  assert.equal(contexts.get(refresh,null,2),shared);
  const executed=[];
  backend.get(shared).currentPass={executeBundles:items=>executed.push(...items)};
  backend.beginBundle=()=>{renderer.recorded=[];};
  backend.finishBundle=(context,bundle)=>{backend.get(bundle).bundleGPU=renderer.recorded.slice();};
  renderer._nodes={needsRefresh:()=>false};renderer.opaque=true;renderer.transparent=false;
  renderer._renderObjects=list=>renderer.recorded.push(...(renderer.target===refresh?['Lighting resource trigger']:list.map(x=>x.name)));
  const bundle={bundleGroup:{version:1},camera:{},renderList:{opaque:[{name:'wall'},{name:'tree'}],transparent:[],transparentDoublePass:[]}};
  for(const target of [refresh,beauty,refresh,beauty]){
    renderer.target=target;renderer._currentRenderContext=shared;
    Renderer.prototype._renderBundle.call(renderer,bundle,{},{});
  }
  assert.deepEqual(executed,[['Lighting resource trigger'],['wall','tree'],['Lighting resource trigger'],['wall','tree']]);
  assert.equal(renderer._bundles.get.records.size,2);
});
