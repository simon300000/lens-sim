import test from 'node:test';
import assert from 'node:assert/strict';
import {loadUpstreamCatalog} from '../scripts/build-lens-data.mjs';
import {adaptLensRecord} from '../src/optics/prescription.js';
import {packLens,firstOrder} from '../src/optics/lens-state.js';
import {refractiveIndex} from '../src/optics/glass.js';
import {traceLens,unit,add} from '../src/optics/optical-reference.js';
import {preflightLens} from '../src/optics/capabilities.js';
const catalog=await loadUpstreamCatalog();
test('joint XODD carrier and DOE phase retain both powers and reciprocal spectral paths',()=>{
  const lens=adaptLensRecord({id:'joint',name:'Joint surface',tx:'50 3 N-BK7 10 0 XODD 10 0 .02 .001 DOE -1 10 10\n-50 40 - 10',stop:1,apmode:'fno',fno:4},catalog);
  assert.equal(preflightLens(lens).supported,true);
  const s=lens.surfaces[0];assert.ok(s.xodd&&s.doe);
  const packed=packLens(lens,{sensorZMm:lens.sensorZMm}),f=new Float32Array(packed.surfaces.buffer);
  assert.equal(f[38],3);assert.equal(f[39],1);assert.equal(f[40],1);assert.equal(f[42],-1);
  for(const wavelengthNm of [390,550,770]){
    const n=refractiveIndex(lens.glasses[s.mediumAfter],wavelengthNm);
    const p1=(n-1)*(1/50+2*.02/100)+wavelengthNm*1e-6*10/(Math.PI*100);
    const p2=(1-n)/-50,expectedC=-p1-p2*(1-3/n*p1);
    assert.ok(Math.abs(firstOrder(lens,wavelengthNm).C-expectedC)<1e-12);
    const origin=[2,.3,-10],direction=unit([.005,-.002,1]);
    const forward=traceLens(lens,origin,direction,{reverse:false,wavelengthNm});assert.equal(forward.status,0);
    const backward=traceLens(lens,forward.point,forward.direction.map(v=>-v),{reverse:true,wavelengthNm});assert.equal(backward.status,0);
    const returned=add(backward.point,backward.direction,(origin[2]-backward.point[2])/backward.direction[2]);
    assert.ok(Math.hypot(...returned.map((v,i)=>v-origin[i]))<1e-8);
  }
});
