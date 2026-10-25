import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePlan, CAMERA_WIDTHS, sampleBudget, hasSamplesRemaining, PIXEL_BYTES, MAX_IMAGE_WIDTH } from '../src/rendering/sampling-plan.js';
const limits={maxTextureDimension2D:16384,maxBufferSize:256*1024**2,maxStorageBufferBindingSize:128*1024**2};
test('camera images cover the entire sensor within per-buffer GPU limits',()=>{
  for(const width of [480,...CAMERA_WIDTHS]){
    const p=imagePlan(width,limits);let y=0,bytes=0;
    for(const tile of p.tiles){assert.equal(tile.y,y);assert.ok(tile.bytes<=limits.maxStorageBufferBindingSize);assert.equal(tile.y%8,0);bytes+=tile.bytes;y+=tile.height;}
    assert.equal(y,p.height);assert.equal(PIXEL_BYTES,64);assert.equal(bytes,p.width*p.height*PIXEL_BYTES);
  }
  assert.equal(imagePlan(6000,limits).width*imagePlan(6000,limits).height,24000000);
  assert.ok(imagePlan(9504,limits).tiles.length>1);
  assert.throws(()=>imagePlan(9504,{...limits,maxTextureDimension2D:8192}),/GPU/);
});
test('the width ceiling is MAX_IMAGE_WIDTH unless the embedder lifts it to the device limit',()=>{
  assert.throws(()=>imagePlan(MAX_IMAGE_WIDTH+3,limits),/GPU/);
  const wide=imagePlan(16383,limits,{maxWidth:Infinity});
  assert.equal(wide.width,16383);assert.equal(wide.height,10922);
  assert.throws(()=>imagePlan(16386,limits,{maxWidth:Infinity}),/GPU/,'the output texture still bounds the width');
  assert.throws(()=>imagePlan(6000,limits,{maxWidth:4800}),/GPU/);
});
test('continuous sampling continues beyond former limits; finite budgets remain exact',()=>{
  assert.equal(sampleBudget(4096,0,4),4);assert.equal(hasSamplesRemaining(5000,0),true);
  assert.equal(sampleBudget(63,64,4),1);assert.equal(sampleBudget(64,64,4),0);
  assert.equal(hasSamplesRemaining(64,64),false);
});
