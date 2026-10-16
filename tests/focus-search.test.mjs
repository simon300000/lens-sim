import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {searchFocus,axialFocusRms} from '../src/optics/focus-search.js';
import {focusedPrescription} from '../src/optics/focus-motion.js';
import {apertureLimits} from '../src/optics/lens-state.js';
import {refractiveIndex} from '../src/optics/glass.js';
import {loadUpstreamCatalog} from '../scripts/build-lens-data.mjs';
import {adaptLensRecord} from '../src/optics/prescription.js';
const catalogue=await loadUpstreamCatalog();
const read=async id=>adaptLensRecord(JSON.parse(await fs.readFile(new URL(`../vendor/lens-bench/data/lenses/${id}.json`,import.meta.url))),catalogue);
const D=5.999000549316406;

test('Noct native gaps plus cam RMS search fix the supplied 6m focus; agrees with independent bench kernel',async()=>{
 const base=await read('nikon-z-58mm-f0-95-noct-s'),stopRadiusMm=apertureLimits(base).maxStopRadiusMm;
 const old=focusedPrescription(base,D).lens;old.sensorZMm=base.sensorZMm;old.imageDistanceMm=base.sensorZMm-old.lastVertexZMm;old.surfaces.at(-1).thicknessMm=old.imageDistanceMm;
 assert.ok(Math.abs(old.imageDistanceMm-.047665380375008226)<1e-8);
 const opts={stopRadiusMm,wavelengths:base.focusWavelengths,primaryIndex:base.focusPrimaryIndex};
 const before=axialFocusRms(old,D,{...opts,grid:48}),result=searchFocus(base,D,{...opts,currentLens:old}),after=axialFocusRms(result.lens,D,{...opts,grid:48});
 assert.ok(before.rmsMm>.3);assert.ok(after.rmsMm<.01);assert.ok(after.rmsMm<before.rmsMm/40);
 assert.equal(result.lens.imageDistanceMm,1);assert.equal(result.lens.surfaces[0].zMm,0);
 const ctx=vm.createContext({last:{sys:{vig:null}}});
 vm.runInContext(await fs.readFile(new URL('../vendor/lens-bench/js/optics.js',import.meta.url),'utf8'),ctx);
 const app=await fs.readFile(new URL('../vendor/lens-bench/js/app.js',import.meta.url),'utf8');
 for(const name of ['camAt','camSearch']){const a=app.indexOf(`  function ${name}(`),b=app.indexOf('\n  function ',a+1);vm.runInContext(app.slice(a,b),ctx);}
 const surface=l=>l.surfaces.map(s=>({R:s.radiusMm,T:s.thicknessMm,k:s.conic,asph:s.aspheric,sd:s.index===l.stopIndex?stopRadiusMm:s.apertureRadiusMm,n:lam=>refractiveIndex(l.glasses[s.mediumAfter],lam*1000)}));
 const opt={objDist:D*1000,fno:apertureLimits(base).minFNumber,apertureMode:'stop',rayAiming:true,stopIdx:base.stopIndex,lambdas:base.focusWavelengths.map(w=>({nm:w.nm,w:w.weight})),primary:base.focusPrimaryIndex,defocus:0,maxFov:0};
 const m=base.focusMotion,bench=ctx.camSearch({surf:m.keys,u:m.nodes.map(n=>n.u),t:m.nodes.map(n=>m.keys.map(k=>n.t[k]))},surface(base),opt);
 assert.ok(Math.abs(result.lens.surfaces[21].thicknessMm-bench.tv[0])<.0002);
 assert.ok(Math.abs(result.afterRmsMm*1000-bench.rB)<.05);
});

test('cam search preserves native gaps across Nikon, Sony and Sigma focus distances',async()=>{
 for(const [id,distance] of [['nikon-z-58mm-f0-95-noct-s',20],['sony-fe-600mm-f4-gm-oss',20],['sigma-105mm-f2-8-dn-macro-art',2]]){
  const base=await read(id),before=JSON.stringify(base),result=searchFocus(base,distance);
  assert.ok(Number.isFinite(result.afterRmsMm),id);assert.ok(result.afterRmsMm<=result.beforeRmsMm+1e-8,id);
  assert.equal(result.lens.imageDistanceMm,base.imageDistanceMm,id);
  assert.equal(result.lens.surfaces[0].zMm,0);assert.equal(JSON.stringify(base),before);
 }
});

test('a lens without focus cam uses the bench-style image-plane scan',async()=>{
 const base=await read('canon-fl-50mm-f1-8'),result=searchFocus(base,6);
 assert.equal(result.method,'plane-search');assert.ok(result.afterRmsMm<result.beforeRmsMm);
 assert.ok(result.lens.imageDistanceMm>0);assert.equal(result.lens.lastVertexZMm,base.lastVertexZMm);
});
