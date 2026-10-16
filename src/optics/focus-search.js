/** lens-bench app.js camSearch / planeFocus search conventions (GPL-3.0).
 * Use the existing f64 prescription tracer, in a Worker, with the same 12x12
 * pupil grid, on-axis polychromatic RMS and coarse/golden-section cam search.
 * No GPU or display pixels are involved in finding the focus position.
 */
import {traceLens} from './optical-reference.js';
import {firstOrder,apertureLimits} from './lens-state.js';
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

/** Rotational symmetry collapses identical grid radii without changing their
 * multiplicity. Aim at the PRIMARY wavelength's real stop, then reuse each
 * entrance coordinate for the other wavelengths, exactly as pupilXY does. */
export function axialFocusRms(lens,distanceM,{stopRadiusMm,grid=12,dispersion=true,wavelengths,primaryIndex=0,sensorZMm=lens.sensorZMm}={}){
  const spectrum=dispersion&&wavelengths?.length?wavelengths:[{nm:587.5618,weight:1}];
  const primary=dispersion?(spectrum[primaryIndex]??spectrum[0]).nm:587.5618;
  const fo=firstOrder(lens,primary),front=lens.surfaces[0].zMm,zEP=front+fo.entrancePupilZMm;
  const radius=stopRadiusMm??apertureLimits(lens).maxStopRadiusMm;
  const partial={...lens,surfaces:lens.surfaces.slice(0,lens.stopIndex+1).map(s=>({...s,apertureRadiusMm:null}))};
  const infinite=distanceM===null||distanceM*1000>=1e7;
  const ray=q=>infinite?{p:[q,0,front-Math.max(100,radius*4)],d:[0,0,1]}:{p:[0,0,-distanceM*1000],d:[q,0,zEP+distanceM*1000]};
  const hit=q=>{const {p,d}=ray(q),r=traceLens(partial,p,d,{reverse:false,wavelengthNm:primary,dispersion});return r.status===0?r.point[0]:null;};
  let sum=0,weight=0,attempts=0,passed=0;
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
      const t=(sensorZMm-r.point[2])/r.direction[2];
      const x=r.point[0]+r.direction[0]*t,y=r.point[1]+r.direction[1]*t;
      if(!Number.isFinite(x+y))continue;
      const w=point.count*wl.weight;sum+=w*(x*x+y*y);weight+=w;passed+=point.count;
    }
  }
  return {rmsMm:weight&&passed>=attempts*.5?Math.sqrt(sum/weight):Infinity,passed,attempts};
}

export function searchFocus(base,distanceM,options={}){
  const started=performance.now(),motion=base.focusMotion,stopRadiusMm=options.stopRadiusMm??apertureLimits(base).maxStopRadiusMm;
  const settings={...options,stopRadiusMm,wavelengths:motion?.wavelengths??base.focusWavelengths??options.wavelengths,primaryIndex:motion?.primaryIndex??base.focusPrimaryIndex??options.primaryIndex??0};
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
  // No identifiable moving group: bench's two 17-position image-plane scans.
  let lo=-.02*Math.abs(firstOrder(base).focalLengthMm),hi=-lo,best=0,bestRms=Infinity;
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
