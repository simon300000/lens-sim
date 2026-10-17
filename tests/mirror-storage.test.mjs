import test from 'node:test';
import assert from 'node:assert/strict';
import {imagePlan,PIXEL_BYTES,CAMERA_WIDTHS} from '../src/rendering/sampling-plan.js';
test('paired storage covers each image row once and keeps all mirror destinations in the same buffer',()=>{
  for(const width of [48,99,480,...CAMERA_WIDTHS])for(const cap of [width*PIXEL_BYTES*16,128*1024**2,2**31-1]){
    const p=imagePlan(width,{maxTextureDimension2D:16384,maxBufferSize:2**31-1,maxStorageBufferBindingSize:cap},{paired:true});
    const owners=new Int32Array(p.height).fill(-1);let bytes=0;
    p.tiles.forEach((t,i)=>{
      assert.ok(t.bytes<=cap);assert.equal(t.height,t.halfHeight*2);bytes+=t.bytes;
      for(let y=0;y<t.halfHeight;y++)for(const row of [t.y+y,p.height-1-t.y-y]){
        assert.equal(owners[row],-1);owners[row]=i;
      }
    });
    assert.equal(bytes,p.width*p.height*PIXEL_BYTES);
    for(let y=0;y<p.height;y++){assert.ok(owners[y]>=0);assert.equal(owners[y],owners[p.height-1-y]);}
  }
});
