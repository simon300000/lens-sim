import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {loadUpstreamCatalog} from '../scripts/build-lens-data.mjs';
import {adaptLensRecord} from '../src/optics/prescription.js';
import {focusedPrescription} from '../src/optics/focus-motion.js';
import {apertureLimits,packLens} from '../src/optics/lens-state.js';
const catalog=await loadUpstreamCatalog();
const read=async id=>JSON.parse(await fs.readFile(new URL(`../vendor/lens-bench/data/lenses/${id}.json`,import.meta.url),'utf8'));
const close=(a,b,tol=1e-8)=>assert.ok(Math.abs(a-b)<tol,`${a} vs ${b}`);
const fixture=extra=>({id:'test',name:'test',tx:'50 3 N-BK7 10\n-50 10 - 10\n0 30 - 10',stop:2,fno:4,...extra});

test('configuration focus reproduces prescribed internal gaps, interpolates inverse distance, and never drifts the sensor',async()=>{
  const record=await read('sony-fe-600mm-f4-gm-oss'),base=adaptLensRecord(record,catalog),before=JSON.stringify(base);
  assert.equal(base.focusMotion.kind,'configurations');
  for(const node of base.focusMotion.nodes){
    const result=focusedPrescription(base,node.u===0?null:1/node.u/1000).lens;
    for(const k of base.focusMotion.keys)if(k!==result.surfaces.length-1)close(result.surfaces[k].thicknessMm,node.t[k]);
    close(result.sensorZMm,base.sensorZMm);
    close(result.lastVertexZMm+result.imageDistanceMm,base.sensorZMm);
    assert.equal(packLens(result,{fNumber:apertureLimits(result).minFNumber,sensorZMm:result.sensorZMm}).sensorZMm,base.sensorZMm);
  }
  const [a,b]=base.focusMotion.nodes,u=(a.u+b.u)/2;
  const mid=focusedPrescription(base,1/u/1000).lens;
  for(const k of base.focusMotion.keys)close(mid.surfaces[k].thicknessMm,(a.t[k]+b.t[k])/2);
  const again=focusedPrescription(mid,null).lens;
  for(const k of base.focusMotion.keys)close(again.surfaces[k].thicknessMm,a.t[k]);
  assert.equal(JSON.stringify(base),before);
});

test('wide-open group focus preserves the native physical stop calibration',async()=>{
  const base=adaptLensRecord(await read('7artisans-af-135mm-f1-8-max'),catalog,{configurationIndex:1});
  const native=apertureLimits(base),next=focusedPrescription(base,20).lens,limits=apertureLimits(next);
  close(limits.maxStopRadiusMm,native.maxStopRadiusMm);
  const fNumber=Math.abs(limits.focalLengthMm*limits.pupilMagnification)/(2*native.maxStopRadiusMm);
  close(packLens(next,{fNumber,sensorZMm:next.sensorZMm}).stopRadiusMm,native.maxStopRadiusMm);
  close(apertureLimits(focusedPrescription(next,null).lens).maxStopRadiusMm,native.maxStopRadiusMm);
});

test('missing, final-gap-only, curvature-changing, and ambiguous zoom configurations use sensor fallback',()=>{
  assert.equal(adaptLensRecord(fixture(),catalog).focusMotion,null);
  for(const cfgs of [
    [{obj:null},{obj:1000,thi:{2:31}}],
    [{obj:null},{obj:1000,thi:{1:11},rdy:{0:51}}],
    [{obj:null},{obj:1000,thi:{1:11}},{obj:1000,thi:{1:12}}],
  ])assert.equal(adaptLensRecord(fixture({cfgs}),catalog).focusMotion,null);
});

test('invalid motion fails without mutating the current prescription or falling back',()=>{
  const base=adaptLensRecord(fixture({cfgs:[{obj:null},{obj:1000,thi:{1:11,2:29}}]}),catalog),before=JSON.stringify(base);
  assert.throws(()=>focusedPrescription(base,.001),/负间隔/);
  assert.throws(()=>focusedPrescription(base,NaN),/Invalid focus distance/);
  assert.equal(JSON.stringify(base),before);
  assert.throws(()=>adaptLensRecord(fixture({zoomcam:{focus:{}}}),catalog),/Invalid upstream zoomcam/);
});

// Upstream code executes ONLY in this test sandbox as an independent oracle.
const source=await fs.readFile(new URL('../vendor/lens-bench/js/app.js',import.meta.url),'utf8');
const oracle=vm.createContext({CAMCACHE:null});
for(const name of ['natSpline','camPrep','camEstimate','camRowAt','camFocusAt']){
  const start=source.indexOf(`  function ${name}(`),end=source.indexOf('\n  function ',start+1);
  assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),oracle);
}
test('all explicit focus tables agree with upstream spline / log-focal / inverse-distance interpolation',async()=>{
  let tested=0;
  for(const file of await fs.readdir(new URL('../vendor/lens-bench/data/lenses/',import.meta.url))){
    if(!file.endsWith('.json'))continue;
    const record=await read(file.slice(0,-5));if(!record.zoomcam?.focus)continue;
    let base;try{base=adaptLensRecord(record,catalog);}catch{continue;}
    const motion=base.focusMotion,P=oracle.camPrep(record.zoomcam),gm=Object.fromEntries(motion.baseThicknessMm.map((t,k)=>[k,t]));
    const estimated=oracle.camEstimate(P,gm);close(motion.focalLengthMm,-1/estimated.x,1e-5);
    for(const distanceM of [null,20,1,.1]){
      const v=distanceM===null?Infinity:distanceM*1000+base.sensorZMm;
      const expected=oracle.camFocusAt(P,motion.focalLengthMm,v);
      const thickness=motion.infinityThicknessMm.slice();
      motion.keys.forEach(k=>{thickness[k]+=expected.dt[k];});
      thickness[thickness.length-1]=base.sensorZMm-thickness.slice(0,-1).reduce((sum,x)=>sum+x,0);
      if(thickness.some(t=>t<0)){assert.throws(()=>focusedPrescription(base,distanceM),/负间隔/);continue;}
      const result=focusedPrescription(base,distanceM);
      for(const k of motion.keys){
        if(k===base.surfaces.length-1)continue;
        const q=P.keys.indexOf(k),inf=P.spl[q](-1/motion.focalLengthMm);
        close(motion.infinityThicknessMm[k],inf,1e-8);
        close(result.lens.surfaces[k].thicknessMm,inf+expected.dt[k]);
      }
      assert.equal(result.clamped,expected.clamp);assert.equal(result.extrapolated,expected.ex);
      close(result.lens.sensorZMm,base.sensorZMm);
    }
    tested++;
  }
  assert.equal(tested,23);
});

test('focus table mfd is clamped in sensor distance and reported back in first-vertex distance',()=>{
  const base=adaptLensRecord(fixture({zoomcam:{keys:[1],fW:40,fT:60,nodes:[{x:-1/40,t:[10]},{x:-1/60,t:[10]}],
    focus:{surf:[1],rows:[{zu:0,v:[0,.002],dt:[[0],[1]],mfd:500},{zu:1,v:[0,.002],dt:[[0],[1]],mfd:500}]}}}),catalog);
  const result=focusedPrescription(base,.1);
  assert.equal(result.clamped,true);close(result.focusDistanceM,(500-base.sensorZMm)/1000);
  close(result.lens.surfaces[1].thicknessMm,11);close(result.lens.sensorZMm,base.sensorZMm);
});
