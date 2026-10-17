// f64 numerical reference for tests / small control calculations. Not a renderer.
import { radialPolynomial, conicOnly } from './asphere.js';
import { phaseGradient } from './diffractive.js';
import { refractiveIndex } from './glass.js';
export const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
export const add = (a,b,t=1) => a.map((v,i)=>v+t*b[i]);
export const unit = a => {const n=Math.hypot(...a);return a.map(v=>v/n);};

export function sag(surface, x, y) {
  const r2=x*x+y*y,c=surface.radiusMm ? 1/surface.radiusMm : 0;
  const q=1-(1+surface.conic)*c*c*r2;
  if(q<0)return null;
  let z=c*r2/(1+Math.sqrt(q));
  const poly=radialPolynomial(surface),u=Math.sqrt(r2)/poly.radiusMm;
  for(const [j,a]of poly.coefficients.entries())z+=a*u**(poly.startPower+poly.step*j);
  return z;
}
export function surfaceNormal(s,x,y) {
  const r2=x*x+y*y,c=s.radiusMm ? 1/s.radiusMm : 0,q=1-(1+s.conic)*c*c*r2;
  if(q<=0)return null;
  let derivative=c/Math.sqrt(q);
  const poly=radialPolynomial(s),u=Math.sqrt(r2)/poly.radiusMm;
  for(const [j,a]of poly.coefficients.entries()){
    const power=poly.startPower+poly.step*j;
    if(!a)continue;
    // A1*r has a cusp at the origin; there is no rotationally unique normal.
    if(power===1&&r2===0)return null;
    derivative+=power*a*u**(power-2)/poly.radiusMm**2;
  }
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
// Cached source-f64 controls used ONLY for reference interval proofs. Sag,
// normals and traced roots still evaluate the original A/Rn prescription.
const intervalControls=new WeakMap();
function sourceBernstein(s){
  const source=s.xodd;
  let scale=s.apertureRadiusMm??Math.max(2*(s.drawRadiusMm??0),100);
  if(s.radiusMm&&1+s.conic>0)scale=Math.min(scale,Math.abs(s.radiusMm)/Math.sqrt(1+s.conic));
  const cached=intervalControls.get(source);
  if(cached&&cached.scale===scale&&cached.normalizationRadiusMm===source.normalizationRadiusMm&&cached.source.length===source.coefficients.length&&cached.source.every((a,j)=>a===source.coefficients[j]))return cached;
  const n=source.coefficients.length,monomial=source.coefficients.map((a,j)=>a*(scale/source.normalizationRadiusMm)**(j+1)),controls=[0];
  for(let k=1;k<=n;k++){
    let ratio=1,sum=0,correction=0;
    for(let j=1;j<=k;j++){
      ratio*=(k-j+1)/(n-j+1);const term=monomial[j-1]*ratio-correction,next=sum+term;
      correction=(next-sum)-term;sum=next;
    }
    controls.push(sum);
  }
  const error=64*Number.EPSILON*n*monomial.reduce((sum,a)=>sum+Math.abs(a),0);
  const value={scale,normalizationRadiusMm:source.normalizationRadiusMm,source:[...source.coefficients],controls,error};intervalControls.set(source,value);return value;
}
/** Conservative sag interval on a radial domain: XODD uses source Bernstein
 * derivative bounds; even terms retain independent signed-power bounds. */
export function sagBounds(s,radius) {
  if(s.radiusMm&&1+s.conic>0)radius=Math.min(radius,Math.abs(s.radiusMm)/Math.sqrt(1+s.conic)*(1-1e-12));
  if(s.xodd){const interval=sagInterval(s,0,radius);return interval?[...interval,radius]:null;}
  const edge=sag(conicOnly(s),radius,0);
  if(edge===null||!Number.isFinite(edge))return null;
  let lo=Math.min(0,edge),hi=Math.max(0,edge);
  const poly=radialPolynomial(s);
  for(const [j,a]of poly.coefficients.entries()){
    const v=a*(radius/poly.radiusMm)**(poly.startPower+poly.step*j);lo+=Math.min(0,v);hi+=Math.max(0,v);
  }
  return [lo,hi,radius];
}
/** Sag interval on an annulus, using Bernstein derivative bounds for XODD
 * and interval Horner otherwise. Strong cancellation cannot turn a failed
 * bracket into a physical miss without covering the full finite cap. */
export function sagInterval(s,rLo,rHi) {
  const base=conicOnly(s),a=sag(base,rLo,0),b=sag(base,rHi,0);
  if(a===null||b===null||!Number.isFinite(a+b))return null;
  if(s.xodd){
    const data=sourceBernstein(s),uLo=rLo/data.scale,uHi=rHi/data.scale,controls=[...data.controls],n=controls.length-1;
    const mid=(uLo+uHi)/2;let derivative=0,maxCoefficient=0;
    for(let j=1;j<=n;j++){derivative=Math.max(derivative,n*Math.abs(controls[j]-controls[j-1]));maxCoefficient=Math.max(maxCoefficient,Math.abs(controls[j]));}
    for(let level=n;level>0;level--)for(let j=0;j<level;j++)controls[j]=controls[j]*(1-mid)+controls[j+1]*mid;
    const growth=Math.max(1,2*uHi-1)**Math.max(n-1,0),variation=derivative*growth*(uHi-uLo)/2;
    const padding=(data.error+1e-12*(1+maxCoefficient+Math.abs(a)+Math.abs(b)))*Math.max(1,2*uHi-1)**n;
    return [Math.min(a,b)+controls[0]-variation-padding,Math.max(a,b)+controls[0]+variation+padding];
  }
  const poly=radialPolynomial(s),uLo=(rLo/poly.radiusMm)**poly.step,uHi=(rHi/poly.radiusMm)**poly.step;
  let lo=0,hi=0,absolute=0;
  for(let j=poly.coefficients.length-1;j>=0;j--){
    const x=lo,y=hi;
    lo=Math.min(x*uLo,x*uHi)+poly.coefficients[j];
    hi=Math.max(y*uLo,y*uHi)+poly.coefficients[j];
    absolute=absolute*uHi+Math.abs(poly.coefficients[j]);
  }
  const pLo=(rLo/poly.radiusMm)**poly.startPower,pHi=(rHi/poly.radiusMm)**poly.startPower;
  const padding=1e-12*(1+absolute*pHi+Math.abs(a)+Math.abs(b));
  return [Math.min(a,b)+Math.min(lo*pLo,lo*pHi)-padding,Math.max(a,b)+Math.max(hi*pLo,hi*pHi)+padding];
}
/** Same ray only. Clip to the finite primary-sheet slab/cylinder, then use
 * interval residual bounds on exact radial ranges of ray segments. Returning
 * false requires a proof that EVERY segment of the complete physical cap is
 * empty. Unknown/truncated domains and unresolved tangencies remain null. */
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
  }else if(c>0)return physicalBound?false:null;
  if(!Number.isFinite(lo)||!Number.isFinite(hi))return null;
  if(hi<lo-epsilon&&physicalBound)return false;
  if(hi<lo)return null;
  const residual=t=>{const q=add(p,d,t),z=sag(s,q[0],q[1]);return z===null?null:q[2]-s.zMm-z;};
  const pending=[[lo,hi,0]];
  for(let work=0;work<2048&&pending.length;work++){
    let [lower,upper,depth]=pending.pop();
    const pa=add(p,d,lower),pb=add(p,d,upper),closest=a>1e-24?Math.max(lower,Math.min(upper,-b/(2*a))):lower;
    const pc=add(p,d,closest),rLo=Math.hypot(pc[0],pc[1]),rHi=Math.max(Math.hypot(pa[0],pa[1]),Math.hypot(pb[0],pb[1]));
    const interval=sagInterval(s,rLo,rHi);if(!interval)return null;
    const fLo=Math.min(pa[2],pb[2])-s.zMm-interval[1],fHi=Math.max(pa[2],pb[2])-s.zMm-interval[0];
    if(fLo>epsilon||fHi < -epsilon)continue;
    let fa=residual(lower),fb=residual(upper);
    if(fa!==null&&Math.abs(fa)<=epsilon)return lower;
    if(fb!==null&&Math.abs(fb)<=epsilon)return upper;
    if(fa!==null&&fb!==null&&fa*fb<0){
      for(let iteration=0;iteration<48;iteration++){
        const mid=(lower+upper)/2,fm=residual(mid);if(fm===null)return null;
        if(Math.abs(fm)<=epsilon)return mid;
        if(fm*fa>0){lower=mid;fa=fm;}else upper=mid;
      }
      return (lower+upper)/2;
    }
    if(depth>=14)return null;
    const mid=(lower+upper)/2;
    // Lower t is processed first. No pupil or wavelength is ever replaced.
    pending.push([mid,upper,depth+1],[lower,mid,depth+1]);
  }
  return pending.length?null:physicalBound?false:null;
}
export function intersectSurface(s,p,d) {
  const scale=Math.max(1,Math.abs(s.radiusMm||0),s.apertureRadiusMm||1);
  const epsilon=1e-9*scale;
  const roots=conicRoots(s,p,d);
  const originSag=sag(s,p[0],p[1]);
  let t=originSag!==null&&Math.abs(p[2]-s.zMm-originSag)<epsilon?0:roots.find(t=>{
    if(t < -epsilon || !Number.isFinite(t))return false;
    const q=add(p,d,t),z=sag(conicOnly(s),q[0],q[1]);
    return z!==null&&Math.abs(q[2]-s.zMm-z)<epsilon*10;
  });
  if(!(radialPolynomial(s).coefficients.some(x=>x!==0))){
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
/** Generalized Snell law on the actual curved carrier surface. The prescribed phase delay is reciprocal: the same transverse kick applies
 * in both directions. Reversing the incident momentum and exchanging media
 * then returns the negative original momentum (including signed orders). */
function diffract(direction,normal,nFrom,nTo,gradient,wavelengthNm) {
  const kick=wavelengthNm*1e-6/(2*Math.PI);
  const momentum=direction.map((v,i)=>nFrom*v+kick*gradient[i]);
  const projected=dot(momentum,normal);
  const tangent=momentum.map((v,i)=>v-projected*normal[i]);
  const q=nTo*nTo-dot(tangent,tangent);
  if(q<0)return null;
  const sign=dot(direction,normal)>=0?1:-1;
  return unit(tangent.map((v,i)=>(v+sign*Math.sqrt(q)*normal[i])/nTo));
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
    const v=s.doe?diffract(d,hit.normal,ni,nt,phaseGradient(s,...hit.point),nm):refract(d,hit.normal,ni,nt);if(!v)return {status:2,point:hit.point,direction:d};
    p=hit.point;d=v;
  }
  return {status:0,point:p,direction:d};
}

export function cameraWeight(sensor,reference,radiusMm){
  const d=Math.abs(sensor[2]-reference[2]),cos=d/Math.hypot(...add(reference,sensor,-1));
  return Math.PI*radiusMm*radiusMm*cos**4/(d*d);
}
