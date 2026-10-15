/** Focus cam conventions adapted from lens-bench js/app.js (GPL-3.0).
 * Static data only: no upstream application code executes at runtime.
 */
const lerp=(a,b,w)=>a+(b-a)*w;
function interval(xs,x){let j=0;while(j<xs.length-2&&x>xs[j+1])j++;return j;}
function spline(xs,ys,x){
  const n=xs.length;if(n===1)return ys[0];
  const second=Array(n).fill(0),u=Array(n).fill(0);
  for(let i=1;i<n-1;i++){
    const sig=(xs[i]-xs[i-1])/(xs[i+1]-xs[i-1]),p=sig*second[i-1]+2;
    second[i]=(sig-1)/p;
    u[i]=(6*((ys[i+1]-ys[i])/(xs[i+1]-xs[i])-(ys[i]-ys[i-1])/(xs[i]-xs[i-1]))/(xs[i+1]-xs[i-1])-sig*u[i-1])/p;
  }
  for(let i=n-2;i>=0;i--)second[i]=second[i]*second[i+1]+u[i];
  const j=interval(xs,x),h=xs[j+1]-xs[j],a=(xs[j+1]-x)/h,b=(x-xs[j])/h;
  return a*ys[j]+b*ys[j+1]+((a*a*a-a)*second[j]+(b*b*b-b)*second[j+1])*h*h/6;
}
function minimize(cost,lo,hi){
  const step=(hi-lo)/400;let best=lo;
  for(let i=0;i<=400;i++){const x=lo+step*i;if(cost(x)<cost(best))best=x;}
  let a=Math.max(lo,best-step),b=Math.min(hi,best+step);
  for(let i=0;i<60;i++){const x=a+(b-a)/3,y=b-(b-a)/3;if(cost(x)<cost(y))b=y;else a=x;}
  return (a+b)/2;
}
function validKeys(keys,n){return Array.isArray(keys)&&keys.length&&new Set(keys).size===keys.length&&keys.every(k=>Number.isInteger(k)&&k>=0&&k<n);}
function increasing(xs){return xs.every((x,i)=>Number.isFinite(x)&&(!i||x>xs[i-1]));}

/** Normalize the explicit table first; otherwise infer the same configuration
 * family as upstream focusCam, excluding curvature changes / ambiguous zooms. */
export function buildFocusMotion(record,baseSurfaces,configurationIndex){
  const cfgs=record.cfgs??[],current=cfgs[configurationIndex]??{},n=baseSurfaces.length;
  const thickness=c=>baseSurfaces.map((s,k)=>c.thi?.[k]??s.thicknessMm);
  const baseThicknessMm=thickness(current),C=record.zoomcam;
  if(C?.focus){
    const fail=()=>{throw new Error('Invalid upstream zoomcam focus data');};
    if(!validKeys(C.keys,n)||!validKeys(C.focus.surf,n)||!C.nodes?.length||!C.focus.rows?.length)fail();
    if(!increasing(C.nodes.map(q=>q.x))||C.nodes.some(q=>q.t?.length!==C.keys.length||q.t.some(t=>!Number.isFinite(t))))fail();
    const rows=structuredClone(C.focus.rows).sort((a,b)=>a.zu-b.zu);
    if(!increasing(rows.map(r=>r.zu))||rows.some(r=>!Array.isArray(r.v)||r.v.length<2||!increasing(r.v)||r.v[0]!==0||r.dt?.length!==r.v.length||r.dt.some(d=>d.length!==C.focus.surf.length||d.some(t=>!Number.isFinite(t)))))fail();
    if(!(C.fW>0&&C.fT>C.fW)||!C.focus.surf.every(k=>C.keys.includes(k)))fail();
    // Estimate zoom from NON-focus gaps, as upstream camEstimate does. This
    // preserves focal length when the selected configuration is close focused.
    const fixed=C.keys.filter((k,q)=>!C.focus.surf.includes(k)&&C.nodes.some(p=>Math.abs(p.t[q]-C.nodes[0].t[q])>1e-9));
    const keys=fixed.length?fixed:C.keys,xs=C.nodes.map(q=>q.x);
    const at=(k,x)=>spline(xs,C.nodes.map(q=>q.t[C.keys.indexOf(k)]),x);
    const x=minimize(x=>keys.reduce((sum,k)=>sum+(at(k,x)-baseThicknessMm[k])**2,0),xs[0],xs.at(-1));
    const infinityThicknessMm=baseThicknessMm.slice();C.keys.forEach(k=>{infinityThicknessMm[k]=at(k,x);});
    return {kind:'zoomcam',source:'zoomcam.focus',keys:C.focus.surf.slice(),baseThicknessMm,infinityThicknessMm,rows,focalLengthMm:-1/x,fW:C.fW,fT:C.fT};
  }
  if(cfgs.length<2)return null;
  const inv=c=>c.obj==null||!Number.isFinite(c.obj)||c.obj<=0||c.obj>=1e7?0:1/c.obj;
  const radii=c=>baseSurfaces.map((s,k)=>c.rdy?.[k]??s.radiusMm);
  const r0=radii(current),t0=baseThicknessMm;
  const diff=c=>thickness(c).flatMap((t,k)=>Math.abs(t-t0[k])>1e-9?[k]:[]);
  const sameR=c=>radii(c).every((r,k)=>Math.abs(r-r0[k])<=1e-9);
  const candidates=cfgs.filter(c=>Math.abs(inv(c)-inv(current))>1e-12).sort((a,b)=>(diff(a).length+radii(a).filter((r,k)=>Math.abs(r-r0[k])>1e-9).length)-(diff(b).length+radii(b).filter((r,k)=>Math.abs(r-r0[k])>1e-9).length));
  const near=candidates[0];if(!near||!sameR(near))return null;
  const keys=diff(near);if(!keys.length||keys.every(k=>k===n-1))return null;
  const nodes=cfgs.filter(c=>sameR(c)&&diff(c).every(k=>keys.includes(k))).map(c=>({u:inv(c),t:thickness(c)})).sort((a,b)=>a.u-b.u);
  for(let i=1;i<nodes.length;i++)if(Math.abs(nodes[i].u-nodes[i-1].u)<1e-12){
    if(keys.some(k=>Math.abs(nodes[i].t[k]-nodes[i-1].t[k])>1e-9))return null;
    nodes.splice(i--,1);
  }
  if(nodes.length<2)return null;
  return {kind:'configurations',source:'cfgs.thi / cfgs.obj',keys,baseThicknessMm,nodes};
}
function rowAt(row,v){
  const j=interval(row.v,v),w=(v-row.v[j])/(row.v[j+1]-row.v[j]);
  return row.dt[j].map((a,q)=>lerp(a,row.dt[j+1][q],w));
}

/** Distance is from the first vertex (UI/scene convention). Table v=1/D
 * instead uses object-to-sensor distance. The prescribed sensor stays fixed. */
export function focusedPrescription(base,distanceM){
  const motion=base.focusMotion;if(!motion)throw new Error('Lens has no focus motion');
  if(distanceM!==null&&!(Number.isFinite(distanceM)&&distanceM>0))throw new Error('Invalid focus distance');
  let t=motion.baseThicknessMm.slice(),actual=distanceM,extrapolated=false,clamped=false;
  if(motion.kind==='zoomcam'){
    t=motion.infinityThicknessMm.slice();
    const rows=motion.rows,zu=Math.log(motion.focalLengthMm/motion.fW)/Math.log(motion.fT/motion.fW);
    const j=rows.length===1?0:interval(rows.map(r=>r.zu),zu),a=rows[j],b=rows[Math.min(j+1,rows.length-1)];
    const w=a===b?0:Math.max(0,Math.min(1,(zu-a.zu)/(b.zu-a.zu)));
    let D=distanceM===null?Infinity:distanceM*1000+base.sensorZMm;
    const mfd=a.mfd&&b.mfd?lerp(a.mfd,b.mfd,w):null;
    if(mfd&&D<mfd){D=mfd;actual=(D-base.sensorZMm)/1000;clamped=true;}
    if(!(D>base.sensorZMm)||actual!==null&&actual<=0)throw new Error('对焦表最近距离位于镜头内部');
    const v=Number.isFinite(D)?1/D:0,A=rowAt(a,v),B=rowAt(b,v);
    extrapolated=v>a.v.at(-1)*(1+1e-7)||v>b.v.at(-1)*(1+1e-7);
    motion.keys.forEach((k,q)=>{t[k]+=lerp(A[q],B[q],w);});
  }else{
    const nodes=motion.nodes,u=distanceM===null?0:1/(distanceM*1000),j=interval(nodes.map(p=>p.u),u);
    const a=nodes[j],b=nodes[j+1],w=(u-a.u)/(b.u-a.u);
    extrapolated=u<nodes[0].u||u>nodes.at(-1).u;
    motion.keys.forEach(k=>{t[k]=lerp(a.t[k],b.t[k],w);});
  }
  // The last T is the sensor gap, not another moving optical surface.
  t[t.length-1]=base.sensorZMm-t.slice(0,-1).reduce((s,x)=>s+x,0);
  if(t.some(x=>!Number.isFinite(x)||x<0))throw new Error('对焦镜组超出有效行程（负间隔）；保留原焦点');
  let z=0;const surfaces=base.surfaces.map((s,k)=>{const q={...s,zMm:z,thicknessMm:t[k]};z+=t[k];return q;});
  const lens={...base,surfaces,lastVertexZMm:surfaces.at(-1).zMm,imageDistanceMm:t.at(-1),objectDistanceMm:actual===null?null:actual*1000};
  return {lens,focusDistanceM:actual,extrapolated,clamped};
}
