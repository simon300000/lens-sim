import { refractiveIndex, createGlassLUT } from './glass.js';
import { radialPolynomial, conicOnly, axialCurvature } from './asphere.js';
import { diffractivePower, normalizeDiffraction } from './diffractive.js';
import { sag } from './optical-reference.js';

/** ABCD in (height mm, reduced slope n*u); only an initial/control estimate. */
export function firstOrder(lens,wavelengthNm=587.5618) {
  let A=1,B=0,C=0,D=1,stopA=1,stopB=0;
  for(const s of lens.surfaces){
    if(s.index===lens.stopIndex){stopA=A;stopB=B;}
    const ni=refractiveIndex(lens.glasses[s.mediumBefore],wavelengthNm),nt=refractiveIndex(lens.glasses[s.mediumAfter],wavelengthNm);
    const power=(nt-ni)*axialCurvature(s)+diffractivePower(s,wavelengthNm);
    C-=power*A;D-=power*B;
    if(s.index<lens.surfaces.length-1){const t=s.thicknessMm/nt;A+=t*C;B+=t*D;}
  }
  if(Math.abs(C)<1e-12)throw new Error('无有限近轴焦点');
  return {A,B,C,D,focalLengthMm:-1/C,backFocusMm:-A/C,pupilMagnification:stopA,entrancePupilZMm:stopB/stopA};
}
export function paraxialSensorZ(lens,objectDistanceM=null) {
  const p=firstOrder(lens),inv=objectDistanceM===null?0:1/(objectDistanceM*1000);
  const den=p.C+p.D*inv;
  const z=lens.lastVertexZMm-(p.A+p.B*inv)/den;
  if(!Number.isFinite(z)||z<lens.lastVertexZMm)throw new Error('该物距没有可用像方焦点');
  return z;
}
export function apertureLimits(lens) {
  const p=firstOrder(lens),mag=Math.abs(p.pupilMagnification),f=Math.abs(p.focalLengthMm);
  if(mag<1e-7||!Number.isFinite(mag))throw new Error('入瞳倍率退化，无法标定光圈');
  let epd;
  if(lens.apertureMode==='stop'){
    const stop=lens.surfaces[lens.stopIndex].apertureRadiusMm;
    if(!(stop>0))throw new Error('光阑模式缺少真实 stop 半径');
    epd=2*stop/mag;
  }else if(lens.apertureMode==='epd')epd=lens.apertureValue;
  else if(lens.apertureMode==='fno'&&lens.objectDistanceMm!==null){
    const L=lens.objectDistanceMm,uEnd=p.C*L+p.D;
    epd=Math.abs(p.entrancePupilZMm+L)/(lens.apertureValue*Math.abs(uEnd));
  }else epd=f/lens.apertureValue;
  const explicit=lens.surfaces[lens.stopIndex].apertureRadiusMm;
  const maxStop=Math.min(epd*mag/2,explicit??Infinity);
  return {minFNumber:f*mag/(2*maxStop),maxFNumber:Math.max(22,f*mag/(2*maxStop)*8),maxStopRadiusMm:maxStop,...p};
}

/** Rear reference plane is the rear vertex plane, NOT the curved surface.
 * Bound follows projecting every possible rear-surface point to this plane from
 * any sensor point. For cap z and sensor Z, q.xy = s.xy + (p.xy-s.xy)*(Z-zRef)/(Z-z).
 * Triangle inequality yields Rref <= max |ratio|*Rcap + |1-ratio|*Rsensor.
 * Each annulus uses interval bounds: the conic term is monotonic in r, while
 * each signed polynomial term is bounded independently at the two endpoints.
 * The resulting radius is conservative even between evaluated endpoints.
 * Lenses whose sensor intersects this swept cap are rejected, not clipped.
 * Unknown aperture uses explicit, warned numerical domain (not a physical stop).
 */
export function rearSamplingRegion(lens,sensorZMm,sensorMm=[36,24],scale=1) {
  if(!(scale>=1&&Number.isFinite(scale)))throw new Error('采样包围区域仅可保守扩大 (scale >= 1)');
  const rear=lens.surfaces.at(-1),known=rear.apertureRadiusMm;
  let bound=known??Math.max(rear.drawRadiusMm??0,...lens.surfaces.map(s=>s.apertureRadiusMm??0),Math.hypot(...sensorMm))*2;
  // A conic has no physical sag outside this domain; do not include its other
  // algebraic branch. Equality is allowed in the bound, never in normal tracing.
  if(rear.radiusMm&&1+rear.conic>0)bound=Math.min(bound,Math.abs(rear.radiusMm)/Math.sqrt(1+rear.conic));
  const sensorR=Math.hypot(...sensorMm)/2,zRef=rear.zMm;
  if(!Number.isFinite(sensorZMm)||sensorZMm<zRef)throw new Error('传感器不能位于最后面顶点之前');
  // A sensor on a planar cover-glass exit has no finite rear-plane disk:
  // every backward direction meets the interface at the sensor itself. Sample
  // the full cosine hemisphere instead, without moving the prescribed sensor
  // or omitting the t=0 glass/air refraction. Also use it for short planar gaps
  // to avoid a nearly singular area-to-angle mapping (and f32 gap collapse).
  const planar=rear.radiusMm===0&&!radialPolynomial(rear).coefficients.some(a=>a!==0);
  if(planar&&sensorZMm-zRef<=.05){
    return {zMm:sensorZMm-1,radiusMm:1,areaPdf:1/Math.PI,capRadiusMm:bound,
      directional:true,source:'full cosine-weighted sensor hemisphere; no finite rear-plane disk',unknownAperture:!known};
  }
  const base=conicOnly(rear),d=sensorZMm-zRef;
  let max=0;
  for(let j=0;j<1024;j++){
    const lo=bound*j/1024,hi=bound*(j+1)/1024;
    const a=sag(base,lo,0),b=sag(base,hi,0);
    if(a===null||b===null)throw new Error('后表面求交域无效');
    let sagLo=Math.min(a,b),sagHi=Math.max(a,b);
    const poly=radialPolynomial(rear);
    for(let k=0;k<poly.coefficients.length;k++){
      const p=poly.startPower+poly.step*k;
      const aa=poly.coefficients[k]*(lo/poly.radiusMm)**p,bb=poly.coefficients[k]*(hi/poly.radiusMm)**p;
      sagLo+=Math.min(aa,bb);sagHi+=Math.max(aa,bb);
    }
    if(sagHi>=d)throw new Error('像面与镜头后表面包络相交，当前配置不支持');
    const denominator=d-sagHi;
    max=Math.max(max,(d*hi+Math.max(Math.abs(sagLo),Math.abs(sagHi))*sensorR)/denominator);
  }
  const radiusMm=(max*(1+1e-7)+1e-5)*scale;
  return {zMm:zRef,radiusMm,areaPdf:1/(Math.PI*radiusMm**2),capRadiusMm:bound,
    source:known?'interval-proven rear physical cap projection bound':'unknown rear clear aperture: explicit numerical domain from 2x max documented drawing/physical/sensor diagonal; interval-proven only within this domain',unknownAperture:!known};
}

/** GPU polynomial coefficients use u=r/rScale, not raw mm powers. In
 * particular A24/A26 may be below the f32 range even though A26*r^26 is not.
 * A surface that cannot be represented is rejected; terms are never dropped. */
export function normalizeAsphere(surface) {
  if(surface.xodd){
    if(!(Number.isFinite(surface.xodd.normalizationRadiusMm)&&surface.xodd.normalizationRadiusMm>0))throw new Error(`S${surface.index+1}: XODD 归一化半径必须为正有限数`);
    if(!Array.isArray(surface.xodd.coefficients)||!surface.xodd.coefficients.length)throw new Error(`S${surface.index+1}: XODD 缺少系数`);
    if(surface.aspheric?.some(a=>a!==0))throw new Error(`S${surface.index+1}: XODD 与偶次系数不能同时定义；拒绝丢弃任一项`);
  }
  const numericalRadiusMm=Math.max(surface.apertureRadiusMm??0,(surface.drawRadiusMm??0)*2,100);
  let radialScale=surface.apertureRadiusMm??numericalRadiusMm;
  if(surface.xodd&&surface.radiusMm&&1+surface.conic>0)radialScale=Math.min(radialScale,Math.abs(surface.radiusMm)/Math.sqrt(1+surface.conic));
  const scaleMm=Math.fround(radialScale);
  if(!(scaleMm>=1e-6&&scaleMm<=1e6))throw new Error(`S${surface.index+1}: 非球面归一化尺度超出 GPU 支持范围`);
  const poly=radialPolynomial(surface);
  if(poly.coefficients.length>(surface.xodd?28:12))throw new Error(`S${surface.index+1}: GPU 内核支持偶次 A4 至 A26 或 XODD A1 至 A28`);
  const monomial=poly.coefficients.map((a,j)=>{
    const power=poly.startPower+poly.step*j,b=a*(scaleMm/poly.radiusMm)**power,f=Math.fround(b);
    // WebGPU is permitted to flush f32 subnormals to zero. Requiring normal
    // values prevents a silently platform-dependent missing polynomial term.
    if(!Number.isFinite(f)||Math.abs(f)>1e25||(a!==0&&Math.abs(f)<1.1754943508222875e-38)){
      throw new Error(`S${surface.index+1}: A${poly.startPower+poly.step*j} 无法以归一化 f32 表示，当前 GPU 光学内核不支持此配置`);
    }
    return b;
  });
  // On [0,1], Bernstein/de Casteljau evaluation is a convex combination. This
  // retains f32 accuracy for alternating XODD coefficients whose monomial
  // terms can exceed the actual sag by five or more orders of magnitude.
  // b0=0 is implicit; b1..bN fit the same 28 slots. Source A/Rn stay untouched.
  let converted=monomial,conversionErrorMm=0;
  if(surface.xodd){
    const degree=monomial.length;
    converted=Array.from({length:degree},(_,index)=>{
      const k=index+1;let ratio=1,sum=0,correction=0;
      for(let j=1;j<=k;j++){
        ratio*=(k-j+1)/(degree-j+1);
        const value=monomial[j-1]*ratio-correction,next=sum+value;
        correction=(next-sum)-value;sum=next;
      }
      return sum;
    });
    conversionErrorMm=16*Number.EPSILON*degree*monomial.reduce((v,a)=>v+Math.abs(a),0);
    if(conversionErrorMm>1e-6)throw new Error(`S${surface.index+1}: XODD Bernstein 基转换舍入界超过 1e-6 mm`);
  }
  const coefficients=converted.map(a=>{
    const f=Math.fround(a);
    if(!Number.isFinite(f)||Math.abs(f)>1e25||(a!==0&&Math.abs(f)<1.1754943508222875e-38))throw new Error(`S${surface.index+1}: 非球面基系数无法以归一化 f32 表示`);
    return f;
  });
  return {scaleMm,numericalRadiusMm,coefficients,startPower:poly.startPower,step:poly.step,encoding:surface.xodd?3:2,conversionErrorMm};
}

/** Joint ABI: geometry/media, 28 sag terms, bounds, DOE metadata, 12 phase terms. */
export const SURFACE_BYTES=224, SURFACE_FLOATS=56;
export function packOpticalSurfaces(lens) {
  const lut=createGlassLUT(lens.glasses),buffer=new ArrayBuffer(lens.surfaces.length*SURFACE_BYTES),f=new Float32Array(buffer),u=new Uint32Array(buffer);
  for(const s of lens.surfaces){const j=s.index*SURFACE_FLOATS;
    const normalized=normalizeAsphere(s),phase=normalizeDiffraction(s,normalized.scaleMm);
    f.set([s.zMm,s.radiusMm,s.conic,s.apertureRadiusMm??-1],j);
    u.set([lut.ids.indexOf(s.mediumBefore),lut.ids.indexOf(s.mediumAfter),normalized.coefficients.length,s.index===lens.stopIndex?1:0],j+4);
    f.set(normalized.coefficients,j+8);
    f.set([normalized.numericalRadiusMm,normalized.scaleMm,normalized.encoding,normalized.startPower],j+36);
    f.set([phase.length,normalized.scaleMm,s.doe?.order??0,s.doe?.normalizationRadiusMm??1],j+40);
    f.set(phase,j+44);
  }
  return {surfaces:new Uint8Array(buffer),lut};
}
export function packLens(lens,{fNumber,sensorZMm,sensorMm=[36,24],dispersion=true,samplingScale=1}={}) {
  const limits=apertureLimits(lens),fno=fNumber??limits.minFNumber;
  if(fno<limits.minFNumber-1e-5||fno>limits.maxFNumber+1e-5)throw new Error('光圈超出数据约束');
  const stopRadiusMm=Math.abs(limits.focalLengthMm*limits.pupilMagnification)/(2*fno);
  const {surfaces,lut}=packOpticalSurfaces(lens);
  const z=sensorZMm??paraxialSensorZ(lens,20),region=rearSamplingRegion(lens,z,sensorMm,samplingScale);
  const parameters=new ArrayBuffer(64),pf=new Float32Array(parameters),pu=new Uint32Array(parameters);
  pu.set([lens.surfaces.length,lut.count,lens.stopIndex,dispersion?1:0]);
  pf.set([lut.minNm,lut.maxNm,lut.stepNm,587.5618,z,region.zMm,region.radiusMm,stopRadiusMm,...sensorMm,0,region.directional?1:0],4);
  return {surfaces,parameters:new Uint8Array(parameters),lut,region,limits,stopRadiusMm,sensorZMm:z,fNumber:fno};
}
