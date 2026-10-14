import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AIR, modelGlass, createGlassLUT, lookupGlassLUT } from '../src/optics/glass.js';
import { sag, surfaceNormal, intersectSurface, refract, traceLens, unit, dot, add, cameraWeight } from '../src/optics/optical-reference.js';
import { firstOrder, apertureLimits, paraxialSensorZ, rearSamplingRegion, packLens, normalizeAsphere } from '../src/optics/lens-state.js';
import { sampleDimension, concentricDisk } from '../src/spectral/sampler.js';

const defaultLens=JSON.parse(fs.readFileSync(new URL('../public/lenses/zemax-55.json',import.meta.url))).configurations[0];
const close=(a,b,tol=1e-10)=>assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}; tolerance ${tol}`);
const closeV=(a,b,tol=1e-10)=>a.forEach((v,i)=>close(v,b[i],tol));
const surface=(extra={})=>({ index:0,zMm:0,radiusMm:0,conic:0,aspheric:[],apertureRadiusMm:20,drawRadiusMm:20,thicknessMm:5,mediumBefore:'air',mediumAfter:'air',...extra });
const blankLens=surfaces=>({surfaces,glasses:{air:AIR},stopIndex:-1});

test('signed spheres choose the primary sag branch, plane and conic intersections match analytic geometry',()=>{
  for(const R of [50,-50]){
    const s=surface({radiusMm:R}),expected=R-Math.sign(R)*Math.sqrt(R*R-100);
    const hit=intersectSurface(s,[10,0,-10],[0,0,1]);
    assert.equal(hit.status,0);close(hit.point[2],expected,1e-12);
    closeV(hit.normal,unit([-10/R,0,Math.sqrt(1-.04)]));
  }
  const parabola=surface({radiusMm:40,conic:-1});
  close(intersectSurface(parabola,[10,0,-5],[0,0,1]).point[2],100/80);
  const plane=surface({zMm:3});
  closeV(intersectSurface(plane,[1,2,-4],unit([.1,.2,1])).point,[1.7,3.4,3]);
});

test('even asphere uses mm powers and has the independent analytic derivative',()=>{
  const s=surface({aspheric:[1e-4,-2e-7]});
  // At r=5: A4*r4 + A6*r6; ds/dr=4*A4*r3+6*A6*r5.
  close(sag(s,3,4),.0625-.003125);
  const radialDerivative=.05-.00375;
  closeV(surfaceNormal(s,3,4),unit([-.6*radialDerivative,-.8*radialDerivative,1]));
  const hit=intersectSurface(s,[3,4,-2],[0,0,1]);
  assert.equal(hit.status,0);close(hit.point[2],.059375,1e-9);
});

test('Snell refraction, total internal reflection and plane plate lateral displacement',()=>{
  const angle=.3,n=1.5,dir=[Math.sin(angle),0,Math.cos(angle)];
  const transmitted=refract(dir,[0,0,1],1,n);
  close(transmitted[0],Math.sin(angle)/n);
  assert.equal(refract(unit([.9,0,.1]),[0,0,1],n,1),null);
  const glass=modelGlass(n,60),lens=blankLens([
    surface({mediumAfter:glass.id}),surface({index:1,zMm:5,mediumBefore:glass.id})
  ]);lens.glasses[glass.id]=glass;
  // Fix the wavelength at d: model n(d) is exactly the requested index.
  const result=traceLens(lens,[0,0,-2],dir,{reverse:false});
  assert.equal(result.status,0);closeV(result.direction,dir,1e-12);
  close(result.point[0],2*Math.tan(angle)+5*Math.tan(Math.asin(Math.sin(angle)/n)),1e-12);
  for(const [p,d] of [[[NaN,0,0],[0,0,1]],[[0,0,0],[0,0,0]],[[0,0,0],[Infinity,0,1]]]){
    const invalid=traceLens(lens,p,d);assert.equal(invalid.status,3);assert.ok(invalid.point.every(Number.isFinite));
  }
});

test('f64 reverse propagation retraces a plane plate, an asphere and the real 23-surface default',()=>{
  const g=modelGlass(1.6,40),glasses={air:AIR,[g.id]:g};
  const asphere={...blankLens([
    surface({radiusMm:70,aspheric:[2e-6,-1e-9],mediumAfter:g.id}),
    surface({index:1,zMm:5,radiusMm:-70,aspheric:[-1e-6],mediumBefore:g.id})
  ]),glasses};
  for(const lens of [asphere,defaultLens])for(const nm of [390,486.1327,587.5618,770])for(const x of [0,.1,1,3]){
    const start=[x,.3,-10],direction=unit([.001,-.002,1]);
    const forward=traceLens(lens,start,direction,{reverse:false,wavelengthNm:nm});
    assert.equal(forward.status,0,`forward ${lens.id??'asphere'} ${nm} ${x}`);
    const reverse=traceLens(lens,forward.point,forward.direction.map(v=>-v),{reverse:true,wavelengthNm:nm});
    assert.equal(reverse.status,0);
    const t=(start[2]-reverse.point[2])/reverse.direction[2];
    closeV(add(reverse.point,reverse.direction,t),start,2e-7);
    closeV(reverse.direction,direction.map(v=>-v),2e-8);
  }
});

test('default ABCD agrees with pinned upstream reference and only stop aperture changes',()=>{
  const p=firstOrder(defaultLens);
  close(p.focalLengthMm,55.01175165669065,1e-10);
  close(p.pupilMagnification,.6053716868795971,1e-12);
  close(p.A*p.D-p.B*p.C,1,1e-12);
  const limits=apertureLimits(defaultLens);
  close(limits.maxStopRadiusMm,9.3137,1e-10);
  close(limits.minFNumber,1.787827484,2e-6);
  const packed=packLens(defaultLens,{fNumber:4});
  close(packed.stopRadiusMm,Math.abs(p.focalLengthMm*p.pupilMagnification)/8);
  const numbers=new Float32Array(packed.surfaces.buffer);
  defaultLens.surfaces.forEach((s,i)=>close(numbers[i*24+3],s.apertureRadiusMm,1e-6));
  assert.throws(()=>packLens(defaultLens,{fNumber:.5}),/光圈/);
  assert.ok(paraxialSensorZ(defaultLens,2)>paraxialSensorZ(defaultLens,20));
  assert.ok(paraxialSensorZ(defaultLens,20)>paraxialSensorZ(defaultLens,null));
});

test('rear sampling includes all rear cap projections, also between interval endpoints and for signed polynomial sag',()=>{
  for(const rear of [surface({radiusMm:40,conic:-.4,apertureRadiusMm:15}),surface({radiusMm:-40,aspheric:[-2e-5,1e-8],apertureRadiusMm:15}),surface({radiusMm:0,aspheric:[2e-4,-1e-6,1e-9],apertureRadiusMm:12})]){
    const sensorZ=20,lens=blankLens([rear]),region=rearSamplingRegion(lens,sensorZ);
    // Independent projective geometry, arbitrary angular point pairs. Dense
    // radial test is evidence in addition to the interval proof in production.
    for(let j=0;j<20000;j++){
      const r=rear.apertureRadiusMm*(j+.373)/20000,z=sag(rear,r,0),ratio=sensorZ/(sensorZ-z);
      const extreme=Math.abs(ratio)*r+Math.abs(1-ratio)*Math.hypot(18,12);
      assert.ok(extreme<=region.radiusMm,`cap ${r} -> ${extreme} outside ${region.radiusMm}`);
    }
    close(region.areaPdf,1/(Math.PI*region.radiusMm**2));
    close(rearSamplingRegion(lens,sensorZ,[36,24],2).areaPdf,region.areaPdf/4);
    assert.throws(()=>rearSamplingRegion(lens,sensorZ,[36,24],.9),/scale/);
  }
  const unknown=rearSamplingRegion(blankLens([surface({apertureRadiusMm:null})]),30);
  assert.equal(unknown.unknownAperture,true);assert.match(unknown.source,/unknown/);
});

test('fixed attempts preserve blockage and PDF makes enlarged sampling areas converge to the same energy',()=>{
  const integrate=(samplingRadius,clearRadius,N=100000)=>{
    let sum=0,passed=0;
    for(let sampleIndex=0;sampleIndex<N;sampleIndex++){
      const r=samplingRadius*Math.sqrt((sampleIndex+.5)/N);
      // Exactly one attempt. No successful-ray denominator and no retry.
      if(r<=clearRadius){sum+=cameraWeight([0,0,0],[r,0,10],samplingRadius);passed++;}
    }
    return {energy:sum/N,attempted:N,passed};
  };
  const a=integrate(8,4),b=integrate(16,4),closed=integrate(8,2);
  close(a.energy,Math.PI*16/116,1e-8);close(a.energy,b.energy,1e-8);
  assert.ok(closed.energy<a.energy*.3);assert.equal(a.attempted,b.attempted);
  assert.equal(a.passed,25000);assert.equal(b.passed,6250);
});

test('current-lens 0.25nm f32 index LUT bounds actual default optical path error',()=>{
  const lut=createGlassLUT(defaultLens.glasses);
  let maxPoint=0,maxDirection=0,compared=0;
  for(const nm of [380.125,400.125,486.125,550.125,650.125,779.875]){
    const approximated={...defaultLens,glasses:Object.fromEntries(lut.ids.map((id,i)=>{
      const n=lookupGlassLUT(lut,i,nm);
      return [id,id==='air'?AIR:{id,name:id,formula:'L',coefficients:[n*n],rangeNm:[380,780]}];
    }))};
    for(const x of [-10,0,10])for(const y of [-5,0,5]){
      const p=[x,y,70],v=unit([-x*.95,-y*.95,-70]);
      const exact=traceLens(defaultLens,p,v,{wavelengthNm:nm}),approx=traceLens(approximated,p,v,{wavelengthNm:nm});
      assert.equal(approx.status,exact.status);
      if(exact.status)continue;
      maxPoint=Math.max(maxPoint,Math.hypot(...add(exact.point,approx.point,-1)));
      maxDirection=Math.max(maxDirection,Math.hypot(...add(exact.direction,approx.direction,-1)));compared++;
    }
  }
  assert.ok(compared>=50);assert.ok(maxPoint<2e-5,`position ${maxPoint} mm`);assert.ok(maxDirection<5e-7,`direction ${maxDirection}`);
  console.log(`Default LUT optical-path error: ${compared} paths, max ${maxPoint} mm / ${maxDirection} unit direction`);
  // Dispersion-off must use the very same reference path, for all wavelengths.
  for(const nm of [380,500,780])closeV(traceLens(defaultLens,[2,1,70],unit([-1,-1,-70]),{dispersion:false,wavelengthNm:nm}).direction,
    traceLens(defaultLens,[2,1,70],unit([-1,-1,-70]),{dispersion:false,wavelengthNm:587.5618}).direction,0);
});

test('selected full-frame Canon FL 50 default has documented apertures, useful conservative throughput and reciprocal rays',()=>{
  const lens=JSON.parse(fs.readFileSync(new URL('../public/lenses/canon-fl-50mm-f1-8.json',import.meta.url))).configurations[0];
  const packed=packLens(lens,{fNumber:2.8});
  assert.equal(lens.surfaces.length,11);assert.ok(lens.surfaces.every(s=>s.aspheric.every(a=>a===0)));
  assert.deepEqual(lens.missingApertureSurfaces,[lens.stopIndex+1]);
  assert.equal(lens.apertureMode,'fno');close(lens.apertureValue,1.86);
  assert.ok(lens.metadata.fieldExtent>=21.63);
  close(packed.sensorZMm-lens.lastVertexZMm,33.96410860971952,1e-9);
  let passed=0;
  for(let i=0;i<1024;i++){
    const xy=concentricDisk(sampleDimension(0,i,2,1234),sampleDimension(0,i,3,1234));
    const origin=[0,0,packed.sensorZMm],q=[xy[0]*packed.region.radiusMm,xy[1]*packed.region.radiusMm,packed.region.zMm];
    const direction=unit(add(q,origin,-1)),wavelengthNm=380+400*sampleDimension(0,i,4,1234);
    const reverse=traceLens(lens,origin,direction,{wavelengthNm,stopRadiusMm:packed.stopRadiusMm});
    assert.notEqual(reverse.status,3);
    if(reverse.status)continue;
    passed++;
    const forward=traceLens(lens,reverse.point,reverse.direction.map(v=>-v),{reverse:false,wavelengthNm,stopRadiusMm:packed.stopRadiusMm});
    assert.equal(forward.status,0);
    const t=(origin[2]-forward.point[2])/forward.direction[2];
    closeV(add(forward.point,forward.direction,t),origin,2e-7);
    closeV(forward.direction,direction.map(v=>-v),2e-8);
  }
  assert.ok(passed>230&&passed<340,`useful but unnormalized pass count ${passed}/1024`);
});

test('normalized GPU Horner preserves high-order coefficients below f32 range without r^26 overflow',()=>{
  const aspheric=Array(12).fill(0);aspheric[0]=1e-9;aspheric[10]=-1e-43;aspheric[11]=2e-46;
  const s=surface({radiusMm:200,apertureRadiusMm:50,aspheric});
  assert.equal(Math.fround(aspheric[11]),0);assert.equal(Math.fround(50**26),Infinity);
  const normalized=normalizeAsphere(s);
  close(normalized.scaleMm,50);
  assert.notEqual(normalized.coefficients[11],0);
  const f=Math.fround;
  for(let i=0;i<=1000;i++){
    const r=50*i/1000,u2=f(f(r*r)/f(normalized.scaleMm*normalized.scaleMm));
    let p=0,dp=0;
    for(let j=11;j>=0;j--){p=f(f(p*u2)+normalized.coefficients[j]);dp=f(f(dp*u2)+f((4+2*j)*normalized.coefficients[j]));}
    const polynomial=f(f(p*u2)*u2),derivative=f(f(dp*u2)/f(normalized.scaleMm**2));
    let expectedSag=0,expectedDerivative=0;
    aspheric.forEach((a,j)=>{expectedSag+=a*r**(4+2*j);expectedDerivative+=(4+2*j)*a*r**(2+2*j);});
    close(polynomial,expectedSag,2e-7);close(derivative,expectedDerivative,2e-9);
    assert.ok(Number.isFinite(polynomial)&&Number.isFinite(derivative));
  }
  // Explicit numerical data limits; no coefficient is silently rounded away.
  assert.throws(()=>normalizeAsphere(surface({aspheric:[1e-90]})),/无法.*f32/);
  assert.throws(()=>normalizeAsphere(surface({aspheric:[1e38]})),/无法.*f32/);
});
