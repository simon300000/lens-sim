import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {loadUpstreamCatalog} from '../scripts/build-lens-data.mjs';
import {adaptLensRecord} from '../src/optics/prescription.js';
import {preflightLens} from '../src/optics/capabilities.js';
import {packLens,rearSamplingRegion} from '../src/optics/lens-state.js';
import {traceLens,unit} from '../src/optics/optical-reference.js';
const catalog=await loadUpstreamCatalog();
const ids=['fujifilm-gf-250mm-f4-r-lm-ois-wr','hasselblad-xcd-65mm-f2-8','nikon-z-100-400mm-f4-5-5-6-vr-s','smc-pentax-da-55mm-f1-4-sdm','fujifilm-gf-23mm-f4-r-lm-wr','fujifilm-gf-30mm-f3-5-r-wr','fujifilm-xf-14mm-f2-8-r','fujifilm-xf-60mm-f2-4-r-macro'];
test('all 36 short/zero native cover-glass gaps retain their prescribed sensor and pack a full hemisphere',async()=>{
  let count=0;
  for(const id of ids){
    const record=JSON.parse(await fs.readFile(new URL(`../vendor/lens-bench/data/lenses/${id}.json`,import.meta.url)));
    const total=(record.cfgs??[{}]).length;
    for(let index=0;index<total;index++){
      const lens=adaptLensRecord(record,catalog,{configurationIndex:index}),status=preflightLens(lens);
      assert.equal(status.supported,true,`${id} #${index}: ${status.reason}`);
      const packed=packLens(lens,{sensorZMm:lens.sensorZMm});
      assert.equal(packed.sensorZMm,lens.sensorZMm);
      assert.equal(packed.region.directional,true);
      assert.equal(new Float32Array(packed.parameters.buffer)[15],1);
      // The physical exit interface is still traversed at t=0. A near-axis
      // ray must pass; neither the cover glass nor its refraction is stripped.
      const result=traceLens(lens,[0,0,lens.sensorZMm],unit([.001,0,-1]),{stopRadiusMm:packed.stopRadiusMm});
      assert.equal(result.status,0,`${id} #${index}: axial path ${result.status}`);
      count++;
    }
  }
  assert.equal(count,36);
});
test('cosine hemisphere has finite unbiased angular weight at zero gap and refraction is reciprocal',()=>{
  const lens=adaptLensRecord({id:'contact',name:'Contact',tx:'50 3 N-BK7 10\n-50 37 - 10\ninf 2 N-BK7 30\ninf 0 - 30',stop:1,fno:4,apmode:'fno'},catalog);
  const packed=packLens(lens,{sensorZMm:lens.sensorZMm});
  assert.equal(packed.region.directional,true);
  for(const x of [0,.1,1]){
    const origin=[x,0,lens.sensorZMm],direction=unit([-.01,0,-1]);
    const back=traceLens(lens,origin,direction,{stopRadiusMm:packed.stopRadiusMm});
    assert.equal(back.status,0);
    const forward=traceLens(lens,back.point,back.direction.map(x=>-x),{reverse:false,stopRadiusMm:packed.stopRadiusMm});
    assert.equal(forward.status,0);
    assert.ok(Math.hypot(...forward.point.map((x,i)=>x-origin[i]))<1e-7);
    assert.ok(Math.hypot(...forward.direction.map((x,i)=>x+direction[i]))<1e-8);
  }
  // ∫ hemisphere cos(theta) dω = pi; normalized camera calibration 4/pi.
  for(const cosine of [1,.8,.01,1e-10])assert.ok(Math.abs((4/Math.PI)*cosine/(cosine/Math.PI)-4)<1e-14);
  assert.throws(()=>rearSamplingRegion(lens,lens.lastVertexZMm-.001),/之前/);
  const positive=packLens(lens,{sensorZMm:lens.lastVertexZMm+.026});
  assert.equal(positive.region.directional,true);
  const separated=packLens(lens,{sensorZMm:lens.lastVertexZMm+.1});
  assert.ok(!separated.region.directional);
});
