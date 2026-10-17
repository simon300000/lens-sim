import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {parsePrescriptionText,adaptLensRecord} from '../src/optics/prescription.js';
import {sag,sagBounds,sagInterval,surfaceNormal,intersectSurface,traceLens,unit,add} from '../src/optics/optical-reference.js';
import {normalizeAsphere,packLens,SURFACE_BYTES,SURFACE_FLOATS,firstOrder,rearSamplingRegion} from '../src/optics/lens-state.js';
import {loadUpstreamCatalog} from '../scripts/build-lens-data.mjs';
import {preflightLens} from '../src/optics/capabilities.js';
const catalog=await loadUpstreamCatalog();
const fixture=tx=>adaptLensRecord({id:'xodd-test',name:'xodd',tx,stop:1,fno:4},catalog);
const close=(a,b,tol=1e-11)=>assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}`);
const source='100 5 N-BK7 10 -.5 XODD 2.5 0 .002 -.0003 .00001 0 0\n-100 60 air 10';

test('XODD preserves source normalization, all powers and zero tails; invalid input never substitutes a sphere',()=>{
 const p=parsePrescriptionText(source)[0];assert.deepEqual(p.xodd,{normalizationRadiusMm:2.5,coefficients:[0,.002,-.0003,.00001,0,0]});assert.deepEqual(p.aspheric,[]);
 for(const token of ['XODD 0 1','XODD -1 0','XODD 1','XODD 1 NaN',`XODD 1 ${Array(29).fill(0).join(' ')}`])assert.throws(()=>parsePrescriptionText(`100 5 N-BK7 10 0 ${token}`));
});
test('XODD sag, analytic normal and axis A2 curvature agree with independent formula',()=>{
 const lens=fixture(source),s=lens.surfaces[0];assert.equal(s.type,'extended-odd-asphere');
 for(const radius of [0,.01,.3,2,5,9]){
  const x=radius*.6,y=radius*.8,u=radius/2.5,c=.01,q=1-.5*c*c*radius*radius;
  close(sag(s,x,y),c*radius*radius/(1+Math.sqrt(q))+.002*u*u-.0003*u**3+.00001*u**4);
  const derivative=c/Math.sqrt(q)+(.004-.0009*u+.00004*u*u)/2.5**2;
  const expected=unit([-x*derivative,-y*derivative,1]);surfaceNormal(s,x,y).forEach((v,j)=>close(v,expected[j]));
  const h=1e-5;if(radius>0)close((sag(s,x+h,y)-sag(s,x-h,y))/(2*h),x*derivative,1e-8);
 }
 const without=structuredClone(lens);without.surfaces[0].xodd.coefficients[1]=0;
 assert.notEqual(firstOrder(lens).focalLengthMm,firstOrder(without).focalLengthMm);
 const cusp=fixture(source.replace('2.5 0 .002','2.5 .001 .002'));
 assert.equal(surfaceNormal(cusp.surfaces[0],0,0),null);assert.match(preflightLens(cusp).reason,/A1/);
 assert.equal(intersectSurface(cusp.surfaces[0],[0,0,-10],[0,0,1]).status,3);
});
test('XODD normalization keeps high powers representable and packs the production 224-byte ABI',()=>{
 const lens=fixture(source),s=lens.surfaces[0],n=normalizeAsphere(s),packed=packLens(lens,{sensorZMm:lens.sensorZMm});
 assert.equal(SURFACE_BYTES,224);assert.equal(SURFACE_FLOATS,56);assert.equal(packed.surfaces.byteLength,lens.surfaces.length*224);
 const f=new Float32Array(packed.surfaces.buffer),u=new Uint32Array(packed.surfaces.buffer);assert.equal(u[6],6);assert.deepEqual(Array.from(f.slice(36,40)),[100,10,3,1]);
 const controls=[0,...n.coefficients];
 for(let k=0;k<=100;k++){
  const u=k/100,work=[...controls];for(let level=work.length-1;level>0;level--)for(let j=0;j<level;j++)work[j]=(1-u)*work[j]+u*work[j+1];
  const expected=s.xodd.coefficients.reduce((sum,a,j)=>sum+a*(u*4)**(j+1),0);close(work[0],expected,1e-8);
 }
 const high={...s,apertureRadiusMm:50,xodd:{normalizationRadiusMm:1e4,coefficients:Array(27).fill(0).concat(1e30)}};
 assert.equal(Math.fround(1e30/1e4**28),0);assert.notEqual(normalizeAsphere(high).coefficients[27],0);
 assert.throws(()=>normalizeAsphere({...s,xodd:{normalizationRadiusMm:1,coefficients:[1e-100]}}),/f32/);
});
test('all 24 upstream XODD records and 102 configurations retain every coefficient and agree with authoritative upstream sag',async()=>{
 const context=vm.createContext({});vm.runInContext(await fs.readFile(new URL('../vendor/lens-bench/js/glassdb.js',import.meta.url),'utf8')+'\n'+await fs.readFile(new URL('../vendor/lens-bench/js/optics.js',import.meta.url),'utf8'),context);
 const dir=new URL('../vendor/lens-bench/data/lenses/',import.meta.url);let records=0,configs=0,comparisons=0;
 for(const file of await fs.readdir(dir)){
  const record=JSON.parse(await fs.readFile(new URL(file,dir),'utf8'));if(!record.tx.includes('XODD'))continue;records++;
  for(let i=0;i<(record.cfgs?.length??1);i++){
   const lens=adaptLensRecord(record,catalog,{configurationIndex:i}),upstream=context.OPT.parsePrescription(record.tx).surfaces;configs++;
   for(const s of lens.surfaces.filter(s=>s.xodd))for(const fraction of [0,.02,.1,.3,.6]){
    const radius=fraction*(s.apertureRadiusMm??s.drawRadiusMm??5),reference={...upstream[s.index],R:s.radiusMm};
    const actual=sag(s,radius,0),expected=context.OPT.sag(reference,radius*radius);if(actual!==null&&Number.isFinite(expected)){close(actual,expected,1e-7*Math.max(1,Math.abs(expected)));comparisons++;}
   }
  }
 }
 assert.equal(records,24);assert.equal(configs,102);assert.ok(comparisons>1000);
});
test('XODD off-axis refraction retraces at short, middle and long wavelengths',()=>{
 const lens=fixture(source);for(const nm of [390,550,770])for(const x of [.1,1,3,6]){
  const origin=[x,.3,-10],direction=unit([.01,-.005,1]),a=traceLens(lens,origin,direction,{reverse:false,wavelengthNm:nm});assert.equal(a.status,0);
  const b=traceLens(lens,a.point,a.direction.map(v=>-v),{reverse:true,wavelengthNm:nm});assert.equal(b.status,0);
  const back=add(b.point,b.direction,(origin[2]-b.point[2])/b.direction[2]);back.forEach((v,j)=>close(v,origin[j],1e-7));
 }
});

test('XODD signed powers have conservative intersection slabs and rear sampling projection bounds',()=>{
 const lens=fixture(source),s={...lens.surfaces[0],zMm:0,radiusMm:-100},radius=10;
 const [lo,hi]=sagBounds(s,radius);for(let j=0;j<=1000;j++){const z=sag(s,radius*j/1000,0);assert.ok(z>=lo&&z<=hi);}
 const rearLens={...lens,surfaces:[s]},zSensor=30,region=rearSamplingRegion(rearLens,zSensor,[36,24]);
 for(let j=0;j<=1000;j++){
  const r=radius*j/1000,z=sag(s,r,0),ratio=zSensor/(zSensor-z);
  assert.ok(Math.abs(ratio)*r+Math.abs(1-ratio)*Math.hypot(36,24)/2<=region.radiusMm);
 }
 assert.throws(()=>normalizeAsphere({...s,aspheric:[1e-6]}),/不能同时/);
 assert.throws(()=>normalizeAsphere({...s,xodd:{normalizationRadiusMm:-1,coefficients:[0,1]}}),/正有限数/);
});

test('Canon RF28 full-frame original ray prefix proves finite-cap misses instead of reporting numerical failure',async()=>{
 const record=JSON.parse(await fs.readFile(new URL('../vendor/lens-bench/data/lenses/canon-rf-28mm-f2-8-stm.json',import.meta.url),'utf8'));
 const lens=adaptLensRecord(record,catalog),packed=packLens(lens,{sensorZMm:lens.sensorZMm});
 const {sampleDimension,concentricDisk}=await import('../src/spectral/sampler.js');const counts=[0,0,0,0];
 for(let pixel=0;pixel<48*32;pixel++)for(let k=0;k<32;k++){
  const dim=j=>sampleDimension(pixel,k,j,185),disk=concentricDisk(dim(2),dim(3));
  const origin=[-((pixel%48+dim(0))/48-.5)*36,((Math.floor(pixel/48)+dim(1))/32-.5)*24,packed.sensorZMm];
  const direction=unit(add([disk[0]*packed.region.radiusMm,disk[1]*packed.region.radiusMm,packed.region.zMm],origin,-1));
  counts[traceLens(lens,origin,direction,{wavelengthNm:380+400*dim(4),stopRadiusMm:packed.stopRadiusMm}).status]++;
 }
 assert.deepEqual(counts,[1,49151,0,0]); // Before interval proof: [1,4753,0,44398].
});
test('Nikon35 S12 drawing-radius fallback blocks a miss; an unbounded cap remains unresolved',async()=>{
 const record=JSON.parse(await fs.readFile(new URL('../vendor/lens-bench/data/lenses/nikon-af-s-nikkor-35mm-f1-4g.json',import.meta.url),'utf8'));
 const surface=adaptLensRecord(record,catalog).surfaces[11];
 const p=[-16.545095756392662,3.6140373712304967,76.10157898678621],d=[.17129670479788217,.05856267434810089,-.9834774283625353];
 assert.equal(surface.apertureSource,'sdDraw-approximation');
 assert.equal(surface.apertureRadiusMm,surface.drawRadiusMm);
 close(Math.abs(surface.radiusMm)/Math.sqrt(1+surface.conic),16.06219882334983,1e-10);
 assert.equal(intersectSurface(surface,p,d).status,1);
 // Without either aperture bound, keep the tracer's unresolved status rather
 // than suppressing a numerical failure globally.
 assert.equal(intersectSurface({...surface,apertureRadiusMm:null},p,d).status,3);
});

test('source-f64 Bernstein conversion and f32 de Casteljau retain dense XODD sag and analytic derivatives',async()=>{
 const dir=new URL('../vendor/lens-bench/data/lenses/',import.meta.url);let comparisons=0,maxSagMm=0,maxSlope=0,maxConversionBoundMm=0;
 const f=Math.fround,mix=(a,b,u)=>f(f(a*f(1-u))+f(b*u));
 for(const file of await fs.readdir(dir)){
  const record=JSON.parse(await fs.readFile(new URL(file,dir),'utf8'));if(!record.tx.includes('XODD'))continue;
  for(const s of adaptLensRecord(record,catalog).surfaces.filter(s=>s.xodd)){
   const n=normalizeAsphere(s),degree=n.coefficients.length;assert.equal(n.encoding,3);maxConversionBoundMm=Math.max(maxConversionBoundMm,n.conversionErrorMm);
   for(let k=0;k<=1000;k++){
    // Includes extrapolation beyond the normalized cap. No convex-hull claim
    // is made there; the polynomial identity and analytic derivative still hold.
    const u=f(1.02*k/1000),work=[0,...n.coefficients];
    for(let level=degree;level>1;level--)for(let j=0;j<level;j++)work[j]=mix(work[j],work[j+1],u);
    const actual=mix(work[0],work[1],u),slope=f(f(degree*f(work[1]-work[0]))/n.scaleMm);
    let expected=0,expectedSlope=0;
    for(const [j,a]of s.xodd.coefficients.entries()){
     const radius=u*n.scaleMm/s.xodd.normalizationRadiusMm;
     expected+=a*radius**(j+1);expectedSlope+=(j+1)*a*radius**j/s.xodd.normalizationRadiusMm;
    }
    maxSagMm=Math.max(maxSagMm,Math.abs(actual-expected));maxSlope=Math.max(maxSlope,Math.abs(slope-expectedSlope));comparisons++;
   }
  }
 }
 console.log({comparisons,maxSagMm,maxSlope,maxConversionBoundMm});
 assert.ok(comparisons>50000);assert.ok(maxSagMm<1e-5,`dense sag error ${maxSagMm}mm`);assert.ok(maxSlope<1e-5,`dense slope error ${maxSlope}`);
});

test('XF14 native cfg3 hemisphere prefix proves known S15 misses without changing transmitted rays',async()=>{
 const record=JSON.parse(await fs.readFile(new URL('../vendor/lens-bench/data/lenses/fujifilm-xf-14mm-f2-8-r.json',import.meta.url),'utf8'));
 const lens=adaptLensRecord(record,catalog,{configurationIndex:3});
 // Only obtain the stop radius from the legacy camera setup. Every traced
 // origin remains on the native sensor; no prescribed gap is translated.
 const packed=packLens(lens,{sensorZMm:lens.sensorZMm+.1}),counts=[0,0,0,0];
 const {sampleDimension,concentricDisk}=await import('../src/spectral/sampler.js');
 for(let pixel=0;pixel<48*32;pixel++)for(let k=0;k<128;k++){
  const dim=j=>sampleDimension(pixel,k,j,214),xy=concentricDisk(dim(2),dim(3));
  const origin=[-((pixel%48+dim(0))/48-.5)*36,((Math.floor(pixel/48)+dim(1))/32-.5)*24,lens.sensorZMm];
  const direction=[...xy,-Math.sqrt(Math.max(0,1-xy[0]**2-xy[1]**2))];
  counts[traceLens(lens,origin,direction,{dispersion:false,stopRadiusMm:packed.stopRadiusMm}).status]++;
 }
 assert.deepEqual(counts,[2543,193420,645,0]); // Previous CPU result: [2543,193282,645,138].
 const surface=lens.surfaces[14],p=[-6.852892603512302,-1.888960646470711,45.78178484080398],d=[-.8678459525272548,.3026278543527543,-.3940301821585629];
 assert.equal(surface.apertureRadiusMm,7.823);assert.equal(intersectSurface(surface,p,d).status,1);
});

test('source interval bounds refresh when XODD normalization radius changes',()=>{
 const surface=fixture(source).surfaces[0],before=sagInterval(surface,5,5);
 surface.xodd.normalizationRadiusMm/=2;
 const actual=sag(surface,5,0),after=sagInterval(surface,5,5);
 assert.ok(actual>=after[0]&&actual<=after[1]);
 assert.ok(actual<before[0]||actual>before[1]);
});
