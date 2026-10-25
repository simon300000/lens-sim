import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {searchFocus,axialFocusRms,axialFocusMtf,FOCUS_METHODS} from '../src/optics/focus-search.js';
import {focusedPrescription} from '../src/optics/focus-motion.js';
import {apertureLimits,paraxialSensorZ} from '../src/optics/lens-state.js';
import {refractiveIndex} from '../src/optics/glass.js';
import {loadUpstreamCatalog} from '../scripts/build-lens-data.mjs';
import {adaptLensRecord} from '../src/optics/prescription.js';
const catalogue=await loadUpstreamCatalog();
const read=async id=>adaptLensRecord(JSON.parse(await fs.readFile(new URL(`../vendor/lens-bench/data/lenses/${id}.json`,import.meta.url))),catalogue);
const D=5.999000549316406;
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
/** The plane the RMS search chose, before the contrast trim. */
const rmsPlane=result=>result.lens.sensorZMm-result.contrast.offsetMm;

test('Noct native gaps plus cam RMS search fix the supplied 6m focus; agrees with independent bench kernel',async()=>{
 const base=await read('nikon-z-58mm-f0-95-noct-s'),stopRadiusMm=apertureLimits(base).maxStopRadiusMm;
 const old=focusedPrescription(base,D).lens;old.sensorZMm=base.sensorZMm;old.imageDistanceMm=base.sensorZMm-old.lastVertexZMm;old.surfaces.at(-1).thicknessMm=old.imageDistanceMm;
 assert.ok(Math.abs(old.imageDistanceMm-.047665380375008226)<1e-8);
 const opts={stopRadiusMm,wavelengths:base.focusWavelengths,primaryIndex:base.focusPrimaryIndex};
 const before=axialFocusRms(old,D,{...opts,grid:48}),result=searchFocus(base,D,{...opts,currentLens:old}),after=axialFocusRms(result.lens,D,{...opts,grid:48});
 assert.ok(before.rmsMm>.3);assert.ok(after.rmsMm<.01);assert.ok(after.rmsMm<before.rmsMm/40);
 // The cam search keeps the native 1 mm image gap; a cam lens is not trimmed by default.
 assert.equal(result.lens.imageDistanceMm,1);assert.equal(result.lens.surfaces[0].zMm,0);
 assert.equal(result.contrast.offsetMm,0);
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
 assert.equal(result.method,'plane-search');assert.ok(result.rmsPlaneRmsMm<result.beforeRmsMm);
 assert.ok(result.lens.imageDistanceMm>0);assert.equal(result.lens.lastVertexZMm,base.lastVertexZMm);
});

test('unit focusing reaches near distances beyond the ±2% f scan around the prescription focus',async()=>{
 const base=await read('canon-fl-50mm-f1-8'),stopRadiusMm=apertureLimits(base).maxStopRadiusMm;
 for(const d of [0.8,1.5]){
  const result=searchFocus(base,d,{stopRadiusMm}),rms=D=>axialFocusRms(result.lens,D,{stopRadiusMm,sensorZMm:rmsPlane(result)}).rmsMm;
  const contrast=D=>mean(axialFocusMtf(result.lens,D,{stopRadiusMm}));
  assert.equal(result.method,'plane-search');
  // About f²/(d−f) of extension (3.3 mm at 0.8 m), far outside ±1 mm. The RMS plane has
  // its least RMS at d, the trimmed plane its highest contrast.
  assert.ok(rmsPlane(result)-base.sensorZMm>.8*49**2/(d*1000-49),String(d));
  assert.ok(rms(d)<rms(d*.9)&&rms(d)<rms(d*1.1),String(d));
  assert.ok(contrast(d)>contrast(d*.9)&&contrast(d)>contrast(d*1.1),String(d));
 }
});

test('strong spherical aberration: the contrast trim moves the plane onto the sharp core (Canon FL 50 wide open)',async()=>{
 // FL 50 at f/1.89 has ~0.5 mm over-corrected marginal spherical aberration. The minimum-RMS plane
 // lies ~0.22 mm behind the paraxial focus, where the on-axis geometric MTF at 20-40 lp/mm is ~0.
 const base=await read('canon-fl-50mm-f1-8'),stopRadiusMm=apertureLimits(base).maxStopRadiusMm;
 const opts={stopRadiusMm,wavelengths:base.focusWavelengths,primaryIndex:base.focusPrimaryIndex};
 const result=searchFocus(base,5.9,opts),paraxial=paraxialSensorZ(base,5.9);
 assert.ok(rmsPlane(result)-paraxial>.15,'RMS plane is the rim-pulled plane behind the paraxial focus');
 assert.ok(Math.abs(result.lens.sensorZMm-paraxial)<.08,`trimmed plane ${result.lens.sensorZMm-paraxial} mm from paraxial`);
 // Dense pupil grid, independent of the 12x12 search grid.
 const mtf40=z=>axialFocusMtf(base,5.9,{...opts,grid:48,sensorZMm:z})[1];
 assert.ok(mtf40(rmsPlane(result))<.1,'RMS plane has almost no contrast at 40 lp/mm');
 assert.ok(mtf40(result.lens.sensorZMm)>.3,'trimmed plane resolves 40 lp/mm');
 assert.ok(result.contrast.mtf[1]>3*result.contrast.rmsPlaneMtf[1]);
 assert.ok(result.afterRmsMm>result.rmsPlaneRmsMm,'the trim trades RMS for contrast');
});

test('well-corrected lenses: the trim (all methods) stays at the RMS focus and never loses contrast',async()=>{
 for(const id of ['sony-fe-50mm-f1-2-gm','voigtlander-apo-lanthar-50mm-f2','nikon-z-58mm-f0-95-noct-s','sigma-85mm-f1-4-dn-art']){
  const base=await read(id),stopRadiusMm=apertureLimits(base).maxStopRadiusMm,opts={stopRadiusMm,wavelengths:base.focusWavelengths,primaryIndex:base.focusPrimaryIndex};
  const result=searchFocus(base,5.9,{...opts,trim:FOCUS_METHODS}),dense=z=>mean(axialFocusMtf(result.lens,5.9,{...opts,grid:48,sensorZMm:z}));
  assert.ok(Math.abs(result.contrast.offsetMm)<.02,`${id}: trim ${result.contrast.offsetMm} mm`);
  assert.ok(dense(result.lens.sensorZMm)>=.98*dense(rmsPlane(result)),`${id}: dense contrast ${dense(result.lens.sensorZMm)} vs RMS plane ${dense(rmsPlane(result))}`);
 }
});

test('by default only lenses without focusing groups are trimmed; trim: FOCUS_METHODS trims tables and cams too',async()=>{
 for(const [id,method] of [['sony-fe-16-35mm-f2-8-gm-ii','table'],['sony-fe-50-150mm-f2-gm','table'],['sony-fe-50mm-f1-2-gm','cam-search']]){
  const base=await read(id),result=searchFocus(base,1);
  assert.equal(result.method,method,id);assert.equal(result.contrast.offsetMm,0,id);assert.equal(result.contrast.windowMm,0,id);
  assert.equal(result.afterRmsMm,result.rmsPlaneRmsMm,id);
  assert.equal(result.contrast.mtf.length,3);assert.ok(result.contrast.mtf.every(Number.isFinite),id);
  if(method==='table')assert.equal(result.lens.sensorZMm,focusedPrescription(base,1).lens.sensorZMm,id);
 }
 // Sony 50-150 GM wide open at 1 m: its table plane has MTF40 ~0.38; the trim moves only the sensor, to ~0.94.
 const base=await read('sony-fe-50-150mm-f2-gm'),table=focusedPrescription(base,1).lens,result=searchFocus(base,1,{trim:FOCUS_METHODS});
 assert.equal(result.method,'table');assert.ok(result.contrast.offsetMm<-.01,`trim ${result.contrast.offsetMm} mm`);
 assert.ok(Math.abs(result.lens.sensorZMm-table.sensorZMm-result.contrast.offsetMm)<1e-12);
 assert.deepEqual(result.lens.surfaces.map(s=>s.zMm),table.surfaces.map(s=>s.zMm));
 assert.ok(result.contrast.mtf[1]>2*result.contrast.rmsPlaneMtf[1]);
});

test('a sensor on the cover glass rear face moves with its cover glass (Fujifilm XF 60 Macro, trim: all methods)',async()=>{
 const base=await read('fujifilm-xf-60mm-f2-4-r-macro'),stopRadiusMm=apertureLimits(base).maxStopRadiusMm;
 const opts={stopRadiusMm,wavelengths:base.focusWavelengths,primaryIndex:base.focusPrimaryIndex};
 assert.equal(base.imageDistanceMm,0);
 const result=searchFocus(base,3,{...opts,trim:FOCUS_METHODS}),lens=result.lens,n=lens.surfaces.length;
 assert.ok(result.contrast.offsetMm<-.01,`trim ${result.contrast.offsetMm} mm`);
 assert.equal(lens.imageDistanceMm,0);assert.ok(Math.abs(lens.lastVertexZMm-lens.sensorZMm)<1e-12);
 assert.equal(lens.surfaces[n-2].thicknessMm,base.surfaces[n-2].thicknessMm);
 // Retracing the moved prescription gives the contrast the trim found on the extrapolated rays.
 axialFocusMtf(lens,3,opts).forEach((v,i)=>assert.ok(Math.abs(v-result.contrast.mtf[i])<1e-9));
 assert.ok(result.contrast.mtf[1]>result.contrast.rmsPlaneMtf[1]);
});
