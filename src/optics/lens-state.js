import { refractiveIndex, createGlassLUT } from './glass.js';
import { sag } from './optical-reference.js';

/** ABCD in (height mm, reduced slope n*u); only an initial/control estimate. */
export function firstOrder(lens,wavelengthNm=587.5618) {
  let A=1,B=0,C=0,D=1,stopA=1,stopB=0;
  for(const s of lens.surfaces){
    if(s.index===lens.stopIndex){stopA=A;stopB=B;}
    const ni=refractiveIndex(lens.glasses[s.mediumBefore],wavelengthNm),nt=refractiveIndex(lens.glasses[s.mediumAfter],wavelengthNm);
    const power=s.radiusMm?(nt-ni)/s.radiusMm:0;
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
  if(!Number.isFinite(z)||z<=lens.lastVertexZMm+.05)throw new Error('该物距没有可用像方焦点');
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
  if(sensorZMm<=zRef+.05)throw new Error('传感器必须位于最后面之后');
  const base={...rear,aspheric:[]},d=sensorZMm-zRef;
  let max=0;
  for(let j=0;j<1024;j++){
    const lo=bound*j/1024,hi=bound*(j+1)/1024;
    const a=sag(base,lo,0),b=sag(base,hi,0);
    if(a===null||b===null)throw new Error('后表面求交域无效');
    let sagLo=Math.min(a,b),sagHi=Math.max(a,b);
    for(let k=0;k<rear.aspheric.length;k++){
      const aa=rear.aspheric[k]*lo**(4+2*k),bb=rear.aspheric[k]*hi**(4+2*k);
      sagLo+=Math.min(aa,bb);sagHi+=Math.max(aa,bb);
    }
    if(sagHi>=d-.01)throw new Error('像面与镜头后表面包络相交，当前配置不支持');
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
  const numericalRadiusMm=Math.max(surface.apertureRadiusMm??0,(surface.drawRadiusMm??0)*2,100);
  const scaleMm=Math.fround(surface.apertureRadiusMm??numericalRadiusMm);
  if(!(scaleMm>=1e-6&&scaleMm<=1e6))throw new Error(`S${surface.index+1}: 非球面归一化尺度超出 GPU 支持范围`);
  if((surface.aspheric?.length??0)>12)throw new Error(`S${surface.index+1}: GPU 内核只支持 A4 至 A26`);
  const coefficients=(surface.aspheric??[]).map((a,j)=>{
    const b=a*scaleMm**(4+2*j),f=Math.fround(b);
    // WebGPU is permitted to flush f32 subnormals to zero. Requiring normal
    // values prevents a silently platform-dependent missing polynomial term.
    if(!Number.isFinite(f)||Math.abs(f)>1e25||(a!==0&&Math.abs(f)<1.1754943508222875e-38)){
      throw new Error(`S${surface.index+1}: A${4+2*j} 无法以归一化 f32 表示，当前 GPU 光学内核不支持此配置`);
    }
    return f;
  });
  return {scaleMm,numericalRadiusMm,coefficients};
}

/** Fixed ABI: 96 bytes per surface: geometry/media/3 even-asphere vectors/bound. */
export function packLens(lens,{fNumber,sensorZMm,sensorMm=[36,24],dispersion=true,samplingScale=1}={}) {
  const limits=apertureLimits(lens),fno=fNumber??limits.minFNumber;
  if(fno<limits.minFNumber-1e-5||fno>limits.maxFNumber+1e-5)throw new Error('光圈超出数据约束');
  const stopRadiusMm=Math.abs(limits.focalLengthMm*limits.pupilMagnification)/(2*fno);
  const lut=createGlassLUT(lens.glasses),buffer=new ArrayBuffer(lens.surfaces.length*96),f=new Float32Array(buffer),u=new Uint32Array(buffer);
  for(const s of lens.surfaces){const j=s.index*24;
    const normalized=normalizeAsphere(s);
    f.set([s.zMm,s.radiusMm,s.conic,s.apertureRadiusMm??-1],j);
    u.set([lut.ids.indexOf(s.mediumBefore),lut.ids.indexOf(s.mediumAfter),s.aspheric.length,s.index===lens.stopIndex?1:0],j+4);
    f.set(normalized.coefficients,j+8);
    f[j+20]=normalized.numericalRadiusMm;
    f[j+21]=normalized.scaleMm;
  }
  const z=sensorZMm??paraxialSensorZ(lens,20),region=rearSamplingRegion(lens,z,sensorMm,samplingScale);
  const parameters=new ArrayBuffer(64),pf=new Float32Array(parameters),pu=new Uint32Array(parameters);
  pu.set([lens.surfaces.length,lut.count,lens.stopIndex,dispersion?1:0]);
  pf.set([lut.minNm,lut.maxNm,lut.stepNm,587.5618,z,region.zMm,region.radiusMm,stopRadiusMm,...sensorMm,0,0],4);
  return {surfaces:new Uint8Array(buffer),parameters:new Uint8Array(parameters),lut,region,limits,stopRadiusMm,sensorZMm:z,fNumber:fno};
}
