import test from 'node:test';
import assert from 'node:assert/strict';
import {reflector} from 'three/tsl';
import {RenderTarget,Vector2} from 'three/webgpu';
import {withReflectionPixelRatio} from '../src/rendering/three-interop.js';

test('lens reflection keeps full-density dimensions at every raster quality',()=>{
  const mirror=reflector({resolutionScale:.45}).reflector,target=new RenderTarget();
  const renderer={ratio:1.5,getSize:v=>v.set(1370,907),getDrawingBufferSize(v){return this.getSize(v).multiplyScalar(this.ratio).floor();}};
  const original=mirror._updateResolution,own=Object.hasOwn(mirror,'_updateResolution');
  const size=new Vector2(1370,907).multiplyScalar(1.5).floor();
  const expected=[Math.round(size.x*.45),Math.round(size.y*.45)];
  for(const ratio of [1.5,1,.75]){
    renderer.ratio=ratio;
    withReflectionPixelRatio(renderer,[mirror,mirror],1.5,()=>mirror._updateResolution(target,renderer));
    assert.deepEqual([target.width,target.height],expected);
    assert.equal(renderer.ratio,ratio,'lens refresh must not resize the display or AO');
    assert.equal(mirror._updateResolution,original);
    assert.equal(Object.hasOwn(mirror,'_updateResolution'),own);
    mirror._updateResolution(target,renderer);
    const rasterSize=renderer.getDrawingBufferSize(new Vector2());
    assert.deepEqual([target.width,target.height],[Math.round(rasterSize.x*.45),Math.round(rasterSize.y*.45)],'raster resolution policy is restored');
  }
  target.dispose();
});

test('reflection sizing restores custom hooks after a failed render',()=>{
  const original=()=>{},mirror={_updateResolution:original,resolutionScale:.45};
  assert.throws(()=>withReflectionPixelRatio({getSize:v=>v.set(10,10)},[mirror],1.5,()=>{throw new Error('render failed');}),/render failed/);
  assert.equal(mirror._updateResolution,original);
});
