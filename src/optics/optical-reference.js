// f64 numerical reference for tests / small control calculations. Not a renderer.
import { refractiveIndex } from './glass.js';
export const OpticalStatus = Object.freeze({ OK: 0, OPTICAL_BLOCKED: 1, OPTICAL_TIR: 2, OPTICAL_NUMERICAL_ERROR: 3 });
export const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
export const add = (a,b,t=1) => a.map((v,i)=>v+t*b[i]);
export const unit = a => {const n=Math.hypot(...a);return a.map(v=>v/n);};

export function sag(surface, x, y) {
  const r2=x*x+y*y,c=surface.radiusMm ? 1/surface.radiusMm : 0;
  const q=1-(1+surface.conic)*c*c*r2;
  if(q<0)return null;
  let z=c*r2/(1+Math.sqrt(q)),p=r2*r2;
  for(const a of surface.aspheric??[]){z+=a*p;p*=r2;}
  return z;
}
export function surfaceNormal(s,x,y) {
  const r2=x*x+y*y,c=s.radiusMm ? 1/s.radiusMm : 0,q=1-(1+s.conic)*c*c*r2;
  if(q<=0)return null;
  let derivative=c/Math.sqrt(q),p=r2;
  for(let j=0;j<(s.aspheric?.length??0);j++){derivative+=(4+2*j)*s.aspheric[j]*p;p*=r2;}
  return unit([-x*derivative,-y*derivative,1]);
}
function conicRoots(s,p,d) {
  if(!s.radiusMm){return Math.abs(d[2])>1e-15?[(s.zMm-p[2])/d[2]]:[];}
  const c=1/s.radiusMm,k=1+s.conic,w=p[2]-s.zMm;
  const A=c*(d[0]**2+d[1]**2+k*d[2]**2);
  const B=2*c*(p[0]*d[0]+p[1]*d[1]+k*w*d[2])-2*d[2];
  const C=c*(p[0]**2+p[1]**2+k*w*w)-2*w;
  if(Math.abs(A)<1e-15)return Math.abs(B)>1e-15?[-C/B]:[];
  const disc=B*B-4*A*C;if(disc<0)return [];
  const q=-.5*(B+(B>=0?1:-1)*Math.sqrt(disc));
  return (Math.abs(q)>1e-20?[q/A,C/q]:[-B/(2*A)]).sort((a,b)=>a-b);
}
/** Conservative sag interval on a radial domain. Signed polynomial terms are
 * bounded independently, so high-order cancellation cannot escape the bound. */
export function sagBounds(s,radius) {
  if(s.radiusMm&&1+s.conic>0)radius=Math.min(radius,Math.abs(s.radiusMm)/Math.sqrt(1+s.conic)*(1-1e-12));
  const edge=sag({...s,aspheric:[]},radius,0);
  if(edge===null||!Number.isFinite(edge))return null;
  let lo=Math.min(0,edge),hi=Math.max(0,edge);
  for(let j=0;j<(s.aspheric?.length??0);j++){
    const v=s.aspheric[j]*radius**(4+2*j);lo+=Math.min(0,v);hi+=Math.max(0,v);
  }
  return [lo,hi,radius];
}
/** Same ray only: finite primary sag slab/cylinder, scan 64 intervals then
 * bisection 48 times. Returns false for a proven physical miss, null for
 * unresolved failure; never resamples a ray. */
function bracketAsphere(s,p,d,epsilon) {
  const bounds=sagBounds(s,s.apertureRadiusMm>0?s.apertureRadiusMm*(1+8e-6)+epsilon:Math.max((s.drawRadiusMm??0)*2,100));
  if(!bounds||Math.abs(d[2])<1e-14)return null;
  let [zLo,zHi,radius]=bounds;
  let lo=Math.max(0,Math.min((s.zMm+zLo-p[2])/d[2],(s.zMm+zHi-p[2])/d[2])-epsilon);
  let hi=Math.max((s.zMm+zLo-p[2])/d[2],(s.zMm+zHi-p[2])/d[2])+epsilon;
  const physicalBound=s.apertureRadiusMm>0&&radius>s.apertureRadiusMm;
  const a=d[0]**2+d[1]**2,b=2*(p[0]*d[0]+p[1]*d[1]),c=p[0]**2+p[1]**2-radius**2;
  if(a>1e-24){
    const discriminant=b*b-4*a*c;
    if(discriminant<0)return physicalBound&&discriminant < -1e-12*Math.max(b*b+Math.abs(4*a*c),1)?false:null;
    lo=Math.max(lo,(-b-Math.sqrt(discriminant))/(2*a));hi=Math.min(hi,(-b+Math.sqrt(discriminant))/(2*a));
  }else if(c>0)return null;
  if(!Number.isFinite(lo)||!Number.isFinite(hi))return null;
  if(hi<lo-epsilon&&physicalBound)return false;
  if(hi<lo)return null;
  const residual=t=>{const q=add(p,d,t),z=sag(s,q[0],q[1]);return z===null?null:q[2]-s.zMm-z;};
  let previousT=lo,previousF=residual(lo);
  for(let j=0;j<=64;j++){
    const t=lo+(hi-lo)*j/64,f=residual(t);
    if(f!==null&&Math.abs(f)<=epsilon)return t;
    if(f!==null&&previousF!==null&&f*previousF<0){
      let a=previousT,b=t,fa=previousF;
      for(let iteration=0;iteration<48;iteration++){
        const mid=(a+b)/2,fm=residual(mid);if(fm===null)return null;
        if(Math.abs(fm)<=epsilon)return mid;
        if(fm*fa>0){a=mid;fa=fm;}else b=mid;
      }
      return (a+b)/2;
    }
    previousT=t;previousF=f;
  }
  return null;
}
export function intersectSurface(s,p,d) {
  const scale=Math.max(1,Math.abs(s.radiusMm||0),s.apertureRadiusMm||1);
  const epsilon=1e-9*scale;
  const roots=conicRoots(s,p,d);
  const originSag=sag(s,p[0],p[1]);
  let t=originSag!==null&&Math.abs(p[2]-s.zMm-originSag)<epsilon?0:roots.find(t=>{
    if(t < -epsilon || !Number.isFinite(t))return false;
    const q=add(p,d,t),z=sag({...s,aspheric:[]},q[0],q[1]);
    return z!==null&&Math.abs(q[2]-s.zMm-z)<epsilon*10;
  });
  if(!(s.aspheric?.some(x=>x!==0))){
    if(t===undefined)return {status:1};
  }else{
    t??=(s.zMm-p[2])/d[2];
    let converged=false;
    for(let i=0;i<24;i++){
      if(!Number.isFinite(t)||t < -epsilon)break;
      const q=add(p,d,t),z=sag(s,q[0],q[1]),n=surfaceNormal(s,q[0],q[1]);
      if(z===null||!n)break;
      const f=q[2]-s.zMm-z;
      if(Math.abs(f)<epsilon){converged=true;break;}
      const df=dot(n,d)/n[2];if(Math.abs(df)<1e-12)break;
      t-=Math.max(-scale,Math.min(scale,f/df));
    }
    if(!converged){
      const bracketed=bracketAsphere(s,p,d,epsilon);
      if(bracketed===false)return {status:1};
      if(bracketed===null)return {status:3};
      t=bracketed;
    }
  }
  const point=add(p,d,Math.max(0,t)),r=Math.hypot(point[0],point[1]);
  if(s.apertureRadiusMm!==null&&s.apertureRadiusMm>0&&r>s.apertureRadiusMm*(1+1e-9))return {status:1,point};
  const normal=surfaceNormal(s,point[0],point[1]);
  if(!normal||!point.every(Number.isFinite))return {status:3};
  return {status:0,point,normal,t};
}
export function refract(direction,normal,nFrom,nTo) {
  let N=normal;if(dot(direction,N)>0)N=N.map(x=>-x);
  const eta=nFrom/nTo,cos=-dot(N,direction),q=1-eta*eta*(1-cos*cos);
  if(q<0)return null;
  return unit(direction.map((v,i)=>eta*v+(eta*cos-Math.sqrt(q))*N[i]));
}
export function traceLens(lens,origin,direction,{reverse=true,wavelengthNm=587.5618,dispersion=true,stopRadiusMm=null}={}) {
  if(!origin.every(Number.isFinite)||!direction.every(Number.isFinite)||Math.hypot(...direction)<1e-12||!Number.isFinite(wavelengthNm))return {status:3,point:[0,0,0],direction:[0,0,1]};
  let p=[...origin],d=unit(direction);
  const surfaces=reverse?[...lens.surfaces].reverse():lens.surfaces;
  for(const raw of surfaces){
    const s=raw.index===lens.stopIndex&&stopRadiusMm!==null?{...raw,apertureRadiusMm:stopRadiusMm}:raw;
    const hit=intersectSurface(s,p,d);if(hit.status)return {...hit,direction:d};
    const nm=dispersion?wavelengthNm:587.5618;
    const ni=refractiveIndex(lens.glasses[reverse?s.mediumAfter:s.mediumBefore],nm);
    const nt=refractiveIndex(lens.glasses[reverse?s.mediumBefore:s.mediumAfter],nm);
    const v=refract(d,hit.normal,ni,nt);if(!v)return {status:2,point:hit.point,direction:d};
    p=hit.point;d=v;
  }
  return {status:0,point:p,direction:d};
}

export function cameraWeight(sensor,reference,radiusMm){
  const d=Math.abs(sensor[2]-reference[2]),cos=d/Math.hypot(...add(reference,sensor,-1));
  return Math.PI*radiusMm*radiusMm*cos**4/(d*d);
}
