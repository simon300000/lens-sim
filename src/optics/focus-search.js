/** lens-bench app.js camSearch / planeFocus search conventions (GPL-3.0).
 * Use the existing f64 prescription tracer, in a Worker, with the same 12x12
 * pupil grid, on-axis polychromatic RMS and coarse/golden-section cam search.
 * No GPU or display pixels are involved in finding the focus position.
 *
 * Focus is found in two stages from the same on-axis pupil rays:
 * 1. RMS search (lens-bench): the focusing groups move along the cam
 *    (cam-search) or, without group data, the image plane is scanned around the
 *    paraxial focus for the distance (plane-search), minimising the RMS spot.
 * 2. Contrast trim: the groups stay where the RMS search put them and the image
 *    plane is scanned within ±max(0.5 mm, 0.15·N, 0.01·f) of the RMS plane
 *    (33 positions, then 17 around the best) for the highest mean geometric
 *    polychromatic MTF at 20/40/80 lp/mm. RMS weights the pupil rim by r², so
 *    strong spherical aberration (Canon FL 50/1.8, f/0.95 wide open) pulls the
 *    RMS plane off the sharp core, where contrast is near zero; the trim moves
 *    back onto it. Well-corrected lenses peak in contrast at their RMS plane.
 *    A sensor that must come closer than the last surface moves together with
 *    its cover glass (trailing plane-parallel plates), which keeps the exit rays.
 * Which methods get the trim is the caller's choice (options.trim); by default
 * only plane-search, i.e. lenses without focusing-group data: focus tables and
 * cam searches keep their RMS result, and their contrast is reported.
 */
import {traceLens} from './optical-reference.js';
import {firstOrder,apertureLimits,paraxialSensorZ} from './lens-state.js';
import {focusedPrescription} from './focus-motion.js';

const radialGrid=n=>{
  const bins=new Map();
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){
    const x=-1+(i+.5)*2/n,y=-1+(j+.5)*2/n,r2=x*x+y*y;
    if(r2>1)continue;
    const key=r2.toFixed(12),entry=bins.get(key)??{r:Math.sqrt(r2),count:0};entry.count++;bins.set(key,entry);
  }
  return [...bins.values()];
};

/** On-axis rays leaving the last surface. Rotational symmetry collapses
 * identical grid radii without changing their multiplicity (each ray stands for
 * a ring). Aim at the PRIMARY wavelength's real stop, then reuse each entrance
 * coordinate for the other wavelengths, exactly as pupilXY does. */
function axialBundle(lens,distanceM,{stopRadiusMm,grid=12,dispersion=true,wavelengths,primaryIndex=0}={}){
  const spectrum=dispersion&&wavelengths?.length?wavelengths:[{nm:587.5618,weight:1}];
  const primary=dispersion?(spectrum[primaryIndex]??spectrum[0]).nm:587.5618;
  const fo=firstOrder(lens,primary),front=lens.surfaces[0].zMm,zEP=front+fo.entrancePupilZMm;
  const radius=stopRadiusMm??apertureLimits(lens).maxStopRadiusMm;
  const partial={...lens,surfaces:lens.surfaces.slice(0,lens.stopIndex+1).map(s=>({...s,apertureRadiusMm:null}))};
  const infinite=distanceM===null||distanceM*1000>=1e7;
  const ray=q=>infinite?{p:[q,0,front-Math.max(100,radius*4)],d:[0,0,1]}:{p:[0,0,-distanceM*1000],d:[q,0,zEP+distanceM*1000]};
  const hit=q=>{const {p,d}=ray(q),r=traceLens(partial,p,d,{reverse:false,wavelengthNm:primary,dispersion});return r.status===0?r.point[0]:null;};
  const rays=[];let attempts=0;
  for(const point of radialGrid(grid)){
    const target=point.r*radius;
    let q=target/fo.pupilMagnification,aimed=false;
    for(let it=0;it<14;it++){
      const h=hit(q);if(h===null)break;
      if(Math.abs(h-target)<1e-6){aimed=true;break;}
      const eps=Math.max(1,radius)*1e-5,h1=hit(q+eps);
      if(h1===null||Math.abs(h1-h)<1e-12)break;
      q-=(h-target)*eps/(h1-h);
      if(!Number.isFinite(q))break;
    }
    attempts+=point.count*spectrum.length;
    if(!aimed)continue;
    const {p,d}=ray(q);
    for(const wl of spectrum){
      if(!(wl.weight>0))continue;
      const r=traceLens(lens,p,d,{reverse:false,wavelengthNm:wl.nm,dispersion,stopRadiusMm:radius});
      if(r.status!==0||r.direction[2]<=1e-12)continue;
      rays.push({point:r.point,direction:r.direction,count:point.count,weight:point.count*wl.weight});
    }
  }
  return {rays,attempts};
}

/** The bundle's spot on the plane z = sensorZMm: {x, y, weight} per ray. Empty
 * unless at least half of the attempted rays arrive. */
function spotAt({rays,attempts},sensorZMm){
  const spot=[];let passed=0;
  for(const {point:p,direction:d,count,weight} of rays){
    const t=(sensorZMm-p[2])/d[2];
    const x=p[0]+d[0]*t,y=p[1]+d[1]*t;
    if(!Number.isFinite(x+y))continue;
    spot.push({x,y,weight});passed+=count;
  }
  return {spot:passed>=attempts*.5?spot:[],passed};
}

/** Polychromatic RMS radius of the on-axis spot at sensorZMm (default: the lens's sensor). */
export function axialFocusRms(lens,distanceM,{sensorZMm=lens.sensorZMm,...options}={}){
  const bundle=axialBundle(lens,distanceM,options),{spot,passed}=spotAt(bundle,sensorZMm);
  let sum=0,weight=0;for(const {x,y,weight:w} of spot){sum+=w*(x*x+y*y);weight+=w;}
  return {rmsMm:weight?Math.sqrt(sum/weight):Infinity,passed,attempts:bundle.attempts};
}

/** Bessel J0, Numerical Recipes rational/asymptotic approximation (|error| ~1e-8). */
function besselJ0(x){
  const ax=Math.abs(x);
  if(ax<8){
    const y=x*x;
    return (57568490574+y*(-13362590354+y*(651619640.7+y*(-11214424.18+y*(77392.33017+y*-184.9052456)))))
      /(57568490411+y*(1029532985+y*(9494680.718+y*(59272.64853+y*(267.8532712+y)))));
  }
  const z=8/ax,y=z*z,xx=ax-.785398164;
  const p=1+y*(-.1098628627e-2+y*(.2734510407e-4+y*(-.2073370639e-5+y*.2093887211e-6)));
  const q=-.1562499995e-1+y*(.1430488765e-3+y*(-.6911147651e-5+y*(.7621095161e-6-y*.934935152e-7)));
  return Math.sqrt(.636619772/ax)*(Math.cos(xx)*p-z*Math.sin(xx)*q);
}

/** Spatial frequencies (lp/mm) of the contrast trim's merit. */
export const CONTRAST_FREQUENCIES=[20,40,80];

/** Geometric MTF of the bundle's spot at sensorZMm, one value per frequency: a
 * ring of radius r has OTF J0(2πνr), so MTF(ν) = Σ w·J0(2πνr) / Σ w. */
function spotMtf(bundle,sensorZMm){
  const {spot}=spotAt(bundle,sensorZMm),sum=CONTRAST_FREQUENCIES.map(()=>0);let weight=0;
  for(const {x,y,weight:w} of spot){
    const r=Math.hypot(x,y);weight+=w;
    CONTRAST_FREQUENCIES.forEach((f,i)=>{sum[i]+=w*besselJ0(2*Math.PI*f*r);});
  }
  return sum.map(v=>weight?v/weight:NaN);
}
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;

/** On-axis geometric MTF at CONTRAST_FREQUENCIES, at sensorZMm (default: the lens's sensor). */
export function axialFocusMtf(lens,distanceM,{sensorZMm=lens.sensorZMm,...options}={}){
  return spotMtf(axialBundle(lens,distanceM,options),sensorZMm);
}

/** Trailing plane-parallel plates in the exit medium (sensor cover glass, filters):
 * the index of the first one, or null. A plate shifts each ray independently of
 * where it sits, so moving the sensor together with its plates by dz gives exactly
 * the exit rays extrapolated to sensorZ + dz. The trim needs this when the sensor
 * must come closer than the last surface: some prescriptions (Fujifilm XF 60 Macro,
 * Pentax DA★ 55) put the sensor on the cover glass's rear face. */
function sensorPlates(lens){
  const surfaces=lens.surfaces,exit=surfaces.at(-1).mediumAfter;
  let k=surfaces.length;
  while(k>1&&surfaces[k-1].type==='plane')k--;
  return k<surfaces.length&&surfaces[k-1].mediumAfter===exit?k:null;
}

/** lens with the sensor moved by dz along the axis; its plates move with it only
 * when the sensor would otherwise pass the last surface. */
function moveSensor(lens,dz){
  if(lens.imageDistanceMm+dz>=0)return {...lens,sensorZMm:lens.sensorZMm+dz,imageDistanceMm:lens.imageDistanceMm+dz};
  const plates=sensorPlates(lens);
  const surfaces=lens.surfaces.map((s,k)=>k===plates-1?{...s,thicknessMm:s.thicknessMm+dz}:k>=plates?{...s,zMm:s.zMm+dz}:s);
  return {...lens,surfaces,sensorZMm:lens.sensorZMm+dz,lastVertexZMm:lens.lastVertexZMm+dz};
}

/** Contrast trim of an RMS-focused lens: only the sensor plane moves, the rays are traced once. */
function contrastTrim(lens,distanceM,settings){
  const plates=sensorPlates(lens),gapMm=Math.max(lens.imageDistanceMm,plates===null?0:lens.surfaces[plates-1].thicknessMm);
  const bundle=axialBundle(lens,distanceM,settings),start=lens.sensorZMm,nearest=start-gapMm;
  const fo=firstOrder(lens),f=Math.abs(fo.focalLengthMm),N=Math.abs(f*fo.pupilMagnification)/(2*settings.stopRadiusMm);
  const windowMm=Math.max(.5,.15*N,.01*f),rmsPlaneMtf=spotMtf(bundle,start);
  let best=start,bestMerit=mean(rmsPlaneMtf),lo=start-windowMm,hi=start+windowMm;
  if(Number.isFinite(bestMerit))for(const steps of [32,16]){
    const step=(hi-lo)/steps;
    for(let i=0;i<=steps;i++){
      const z=lo+i*step;if(z<nearest)continue;
      const merit=mean(spotMtf(bundle,z));
      if(merit>bestMerit){best=z;bestMerit=merit;}
    }
    lo=best-step;hi=best+step;
  }
  const offsetMm=best-start;
  return {lens:offsetMm?moveSensor(lens,offsetMm):lens,
    contrast:{frequenciesLpMm:CONTRAST_FREQUENCIES,offsetMm,windowMm,rmsPlaneMtf,mtf:offsetMm?spotMtf(bundle,best):rmsPlaneMtf}};
}

/** lens-bench's RMS search: the focus table, the focusing groups along the cam, or the image plane. */
function rmsSearch(base,distanceM,options,settings){
  const started=performance.now(),motion=base.focusMotion;
  let evaluations=0;
  const evaluate=lens=>{evaluations++;return axialFocusRms(lens,distanceM,settings).rmsMm;};
  if(motion?.kind==='zoomcam'){
    // Explicit manufacturer focus positions are authoritative, as in bench's
    // camFocusAt branch. Do not replace a supplied MTF-based calibration by RMS.
    const moved=focusedPrescription(base,distanceM);
    return {...moved,method:'table',beforeRmsMm:evaluate(options.currentLens??base),afterRmsMm:evaluate(moved.lens),evaluations,solveMs:performance.now()-started};
  }
  if(motion){
    const nodes=motion.nodes,U=nodes.map(n=>n.u),span=U.at(-1)-U[0],uT=distanceM===null?0:1/(distanceM*1000);
    const lo=Math.min(U[0],uT)-.1*span,hi=Math.max(U.at(-1),uT)+.1*span,step=(hi-lo)/16;
    const at=u=>focusedPrescription(base,u===0?null:1/u/1000).lens;
    // Negative u is an extrapolated cam coordinate, not a virtual scene target.
    const candidate=u=>{
      if(u>=0)return at(u);
      const a=nodes[0],b=nodes[1],t=motion.baseThicknessMm.slice(),w=(u-a.u)/(b.u-a.u);
      motion.keys.forEach(k=>{t[k]=a.t[k]+w*(b.t[k]-a.t[k]);});
      if(t.some(x=>!Number.isFinite(x)||x<0))throw Error('invalid cam gaps');
      let z=0;
      const surfaces=base.surfaces.map((s,k)=>{const q={...s,zMm:z,thicknessMm:t[k]};z+=t[k];return q;});
      return {...base,surfaces,sensorZMm:z,lastVertexZMm:surfaces.at(-1).zMm,imageDistanceMm:t.at(-1),objectDistanceMm:distanceM===null?null:distanceM*1000};
    };
    const cost=u=>{try{return evaluate(candidate(u));}catch{return Infinity;}};
    const beforeRmsMm=evaluate(options.currentLens??base);let best=uT,bestRms=cost(best);
    for(let i=0;i<=16;i++){const u=lo+i*step,r=cost(u);if(r<bestRms){best=u;bestRms=r;}}
    let a=best-step,b=best+step;const g=(Math.sqrt(5)-1)/2;
    const rate=Math.max(...motion.keys.map(k=>Math.abs(nodes.at(-1).t[k]-nodes[0].t[k])/span));
    let x=b-g*(b-a),y=a+g*(b-a),fx=cost(x),fy=cost(y);
    for(let i=0;i<60&&(b-a)*rate>2e-4;i++){
      if(fx<fy){b=y;y=x;fy=fx;x=b-g*(b-a);fx=cost(x);}else{a=x;x=y;fx=fy;y=a+g*(b-a);fy=cost(y);}
    }
    if(fx<bestRms){best=x;bestRms=fx;}if(fy<bestRms){best=y;bestRms=fy;}
    if(!Number.isFinite(bestRms))throw Error('对焦搜索没有足够有效光线，保留原焦点');
    const lens=candidate(best);lens.objectDistanceMm=distanceM===null?null:distanceM*1000;
    return {lens,focusDistanceM:distanceM,method:'cam-search',camParameter:best,beforeRmsMm,afterRmsMm:bestRms,extrapolated:best<U[0]-.05*span||best>U.at(-1)+.05*span,clamped:false,evaluations,solveMs:performance.now()-started};
  }
  // No identifiable moving group: unit focusing, bench's two 17-position image-plane scans
  // (±2% of f), centred on the paraxial extension from the prescription's own focus to
  // distanceM. Near focus moves the image plane by about f²/(d−f), well over 2% of f.
  const paraxialAt=d=>paraxialSensorZ(base,d);
  let extension=0;
  try{const e=paraxialAt(distanceM)-paraxialAt(base.objectDistanceMm==null?null:base.objectDistanceMm/1000);if(Number.isFinite(e))extension=e;}catch{}
  const span=.02*Math.abs(firstOrder(base).focalLengthMm);
  let lo=extension-span,hi=extension+span,best=extension,bestRms=Infinity;
  const beforeRmsMm=evaluate(options.currentLens??base);
  for(let pass=0;pass<2;pass++){
    const step=(hi-lo)/16;
    for(let i=0;i<=16;i++){
      const d=lo+i*step;if(base.imageDistanceMm+d<0)continue;
      const lens={...base,sensorZMm:base.sensorZMm+d,imageDistanceMm:base.imageDistanceMm+d},r=evaluate(lens);
      if(r<bestRms){best=d;bestRms=r;}
    }
    lo=best-step;hi=best+step;
  }
  if(!Number.isFinite(bestRms))throw Error('像面搜索没有足够有效光线，保留原焦点');
  return {lens:{...base,sensorZMm:base.sensorZMm+best,imageDistanceMm:base.imageDistanceMm+best},focusDistanceM:distanceM,method:'plane-search',beforeRmsMm,afterRmsMm:bestRms,evaluations,solveMs:performance.now()-started};
}

/** The focus methods, as searchFocus reports them. */
export const FOCUS_METHODS=['table','cam-search','plane-search'];
/** Methods the contrast trim applies to by default: lenses without focusing-group data. */
export const DEFAULT_TRIM_METHODS=['plane-search'];

/** Focus base at distanceM (null: infinity): RMS search, then the contrast trim.
 * method: 'table' | 'cam-search' | 'plane-search'. options.trim: the methods
 * trimmed (default DEFAULT_TRIM_METHODS; FOCUS_METHODS trims every lens).
 * beforeRmsMm: options.currentLens (or base); rmsPlaneRmsMm: the RMS search's
 * minimum; afterRmsMm: at the final plane. contrast: {frequenciesLpMm, offsetMm
 * (final − RMS plane; 0 untrimmed), windowMm (0 untrimmed), rmsPlaneMtf, mtf}.
 * evaluations counts RMS evaluations. cam-search adds camParameter, extrapolated, clamped. */
export function searchFocus(base,distanceM,options={}){
  const started=performance.now(),motion=base.focusMotion,stopRadiusMm=options.stopRadiusMm??apertureLimits(base).maxStopRadiusMm;
  const settings={...options,stopRadiusMm,wavelengths:motion?.wavelengths??base.focusWavelengths??options.wavelengths,primaryIndex:motion?.primaryIndex??base.focusPrimaryIndex??options.primaryIndex??0};
  const found=rmsSearch(base,distanceM,options,settings),rmsPlaneRmsMm=found.afterRmsMm;
  if(!(options.trim??DEFAULT_TRIM_METHODS).includes(found.method)){
    const mtf=axialFocusMtf(found.lens,distanceM,settings);
    return {...found,rmsPlaneRmsMm,contrast:{frequenciesLpMm:CONTRAST_FREQUENCIES,offsetMm:0,windowMm:0,rmsPlaneMtf:mtf,mtf},solveMs:performance.now()-started};
  }
  const {lens,contrast}=contrastTrim(found.lens,distanceM,settings);
  const afterRmsMm=contrast.offsetMm?axialFocusRms(lens,distanceM,settings).rmsMm:rmsPlaneRmsMm;
  return {...found,lens,rmsPlaneRmsMm,afterRmsMm,contrast,solveMs:performance.now()-started};
}
