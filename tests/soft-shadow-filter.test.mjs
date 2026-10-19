import test from 'node:test';
import assert from 'node:assert/strict';
import {Scene,DirectionalLight,PointLight,SpotLight,PCFSoftShadowMap,PCFShadowMap} from 'three/webgpu';
import {installSoftShadowFilter,bilinearPCFSoftShadowFilter} from '../src/rendering/soft-shadow-filter.js';

// Independently expand Three's reference 16-tap separable kernel and evaluate
// hardware bilinear comparison samples, including clamp-to-edge footprints.
test('four bilinear comparisons preserve the PCFSoft sixteen-tap kernel',()=>{
  let seed=17;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const size=9,depth=Array.from({length:size*size},random);
  const sample=(x,y,z)=>Number(z<=depth[Math.max(0,Math.min(size-1,y))*size+Math.max(0,Math.min(size-1,x))]);
  function linear(x,y,z){const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;return sample(ix,iy,z)*(1-fx)*(1-fy)+sample(ix+1,iy,z)*fx*(1-fy)+sample(ix,iy+1,z)*(1-fx)*fy+sample(ix+1,iy+1,z)*fx*fy;}
  for(let trial=0;trial<10000;trial++){
    const x=Math.floor(random()*(size+2))-1,y=Math.floor(random()*(size+2))-1,z=random();
    const fx=trial%5===0?0:random(),fy=trial%7===0?1-1e-9:random();
    const wx=[1-fx,1,1,fx],wy=[1-fy,1,1,fy];let expected=0;
    for(let j=0;j<4;j++)for(let i=0;i<4;i++)expected+=sample(x+i-1,y+j-1,z)*wx[i]*wy[j]/9;
    const ax=2-fx,ay=2-fy,bx=1+fx,by=1+fy;
    const loX=x-1+1/ax,loY=y-1+1/ay,hiX=x+1+fx/bx,hiY=y+1+fy/by;
    const actual=(linear(loX,loY,z)*ax*ay+linear(hiX,loY,z)*bx*ay+linear(loX,hiY,z)*ax*by+linear(hiX,hiY,z)*bx*by)/9;
    assert.ok(Math.abs(expected-actual)<2e-15,`${expected} != ${actual}`);
  }
});

test('optimized PCF applies only to supported 2D default soft shadows',()=>{
  const scene=new Scene(),sun=new DirectionalLight(),spot=new SpotLight(),point=new PointLight(),custom=new DirectionalLight();
  const customFilter=()=>{};custom.shadow.filterNode=customFilter;scene.add(sun,spot,point,custom);
  const renderer={shadowMap:{type:PCFSoftShadowMap},hasCompatibility:()=>false};
  installSoftShadowFilter(scene,renderer);assert.equal(sun.shadow.filterNode,undefined);
  renderer.hasCompatibility=()=>true;renderer.shadowMap.type=PCFShadowMap;
  installSoftShadowFilter(scene,renderer);assert.equal(sun.shadow.filterNode,undefined);
  renderer.shadowMap.type=PCFSoftShadowMap;installSoftShadowFilter(scene,renderer);
  assert.equal(sun.shadow.filterNode,bilinearPCFSoftShadowFilter);assert.equal(spot.shadow.filterNode,bilinearPCFSoftShadowFilter);
  assert.equal(point.shadow.filterNode,undefined);assert.equal(custom.shadow.filterNode,customFilter);
});
