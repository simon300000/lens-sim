// Proposal construction only. The full physical tracer remains the integrand.
// Failed probes cannot prove zero support: a global disc component is mandatory.
import { traceLens } from './optical-reference.js';
import { concentricDisk } from '../spectral/sampler.js';

const cache=new WeakMap();
export const PUPIL_BINS=32;
export const PUPIL_GLOBAL_MIX=.05;
const PRIMARY=587.5618;

export function buildPupilTable(lens,packed,{enabled=true}={}) {
  const {sensorZMm,stopRadiusMm,region}=packed;
  // Contact-plane configurations use the existing angular sampler; there is
  // no finite area proposal to build in that mode.
  enabled=enabled&&!region.directional;
  const p=new Float32Array(packed.parameters.buffer,packed.parameters.byteOffset,16);
  const sensorMm=[p[12],p[13]],dispersion=new Uint32Array(packed.parameters.buffer,packed.parameters.byteOffset,16)[3]!==0;
  const key=JSON.stringify([sensorZMm,stopRadiusMm,...sensorMm,region.radiusMm,dispersion,enabled]);
  let entries=cache.get(lens);if(!entries){entries=new Map();cache.set(lens,entries);}
  if(entries.has(key))return entries.get(key);
  const started=performance.now(),maxHeight=Math.hypot(...sensorMm)/2;
  // vec4 header, then 32 vec4(xmin,xmax,ymin,ymax); same uniform ABI on GPU.
  const data=new Float32Array(4+PUPIL_BINS*4);data.set([maxHeight,PUPIL_BINS,PUPIL_GLOBAL_MIX,enabled?1:0]);
  const wavelengths=dispersion?[380,PRIMARY,780]:[PRIMARY];
  const rows=[];let probes=0,passed=0;
  // An unclipped rear-to-stop guide is used ONLY to locate a proposal, never to
  // accept a rendering ray. Removing apertures here cannot remove physical light.
  const guide={...lens,surfaces:lens.surfaces.slice(lens.stopIndex).map(s=>({...s,apertureRadiusMm:null}))};
  function stopPoint(h,q,nm){
    const r=traceLens(guide,[h,0,sensorZMm],[q[0]-h,q[1],region.zMm-sensorZMm],{wavelengthNm:nm,dispersion});
    return r.status===0?r.point:null;
  }
  const guideSeeds=new Map();
  function footprint(h,nm){
    const previous=guideSeeds.get(nm);
    let q=previous?[previous.q[0]+h-previous.h,previous.q[1]]:[h,0],inverse;
    const step=Math.max(1e-4,(sensorZMm-region.zMm)*1e-3);
    for(let i=0;i<10;i++){
      const a=stopPoint(h,q,nm),b=stopPoint(h,[q[0]+step,q[1]],nm),c=stopPoint(h,[q[0],q[1]+step],nm);
      if(!a||!b||!c)return null;
      const A=(b[0]-a[0])/step,B=(c[0]-a[0])/step,C=(b[1]-a[1])/step,D=(c[1]-a[1])/step,det=A*D-B*C;
      if(!Number.isFinite(det)||Math.abs(det)<1e-12)return null;
      inverse=[D/det,-B/det,-C/det,A/det];
      if(Math.hypot(a[0],a[1])<1e-5)break;
      const dx=inverse[0]*a[0]+inverse[1]*a[1],dy=inverse[2]*a[0]+inverse[3]*a[1];
      const scale=Math.min(1,region.radiusMm/Math.max(Math.hypot(dx,dy),1e-10));
      q=[q[0]-dx*scale,q[1]-dy*scale];
    }
    if(!inverse)return null;
    guideSeeds.set(nm,{h,q});
    const rx=stopRadiusMm*Math.hypot(inverse[0],inverse[1])*1.6,ry=stopRadiusMm*Math.hypot(inverse[2],inverse[3])*1.6;
    if(!(rx>0&&ry>0)||!Number.isFinite(rx+ry))return null;
    return [q[0]-rx,q[0]+rx,q[1]-ry,q[1]+ry];
  }
  function estimate(h){
    let xmin=Infinity,xmax=-Infinity,ymax=0,padX=0,padY=0;
    for(const nm of wavelengths){
      const box=footprint(h,nm)??[-region.radiusMm,region.radiusMm,-region.radiusMm,region.radiusMm];
      const N=12,dx=(box[1]-box[0])/N,dy=(box[3]-box[2])/N;
      for(let y=0;y<N;y++)for(let x=0;x<N;x++){
        const q=[box[0]+(x+.5)*dx,box[2]+(y+.5)*dy];
        if(Math.hypot(...q)>region.radiusMm)continue;
        probes++;
        const ray=traceLens(lens,[h,0,sensorZMm],[q[0]-h,q[1],region.zMm-sensorZMm],{wavelengthNm:nm,dispersion,stopRadiusMm});
        if(ray.status!==0)continue;
        passed++;xmin=Math.min(xmin,q[0]);xmax=Math.max(xmax,q[0]);ymax=Math.max(ymax,Math.abs(q[1]));padX=Math.max(padX,dx);padY=Math.max(padY,dy);
      }
    }
    if(!Number.isFinite(xmin))return [-region.radiusMm,region.radiusMm,-region.radiusMm,region.radiusMm];
    // Expand by two probe cells AND 15%. This is a heuristic bound; global
    // mixture support, rather than a claim about these probes, ensures no bias.
    const px=Math.max(2*padX,(xmax-xmin)*.15),py=Math.max(2*padY,ymax*.3);
    return [xmin-px,xmax+px,-ymax-py,ymax+py];
  }
  if(enabled){
    const edges=Array.from({length:PUPIL_BINS+1},(_,i)=>estimate(maxHeight*i/PUPIL_BINS));
    for(let i=0;i<PUPIL_BINS;i++){
      const a=edges[i],b=edges[i+1];
      // Union endpoints, then expand for finite radial-bin width. Discrete bins
      // avoid an interpolated bound shrinking between two measured heights.
      const pad=maxHeight/PUPIL_BINS;
      rows.push([Math.min(a[0],b[0])-pad,Math.max(a[1],b[1])+pad,Math.min(a[2],b[2])-pad,Math.max(a[3],b[3])+pad]);
    }
  }else for(let i=0;i<PUPIL_BINS;i++)rows.push([-region.radiusMm,region.radiusMm,-region.radiusMm,region.radiusMm]);
  rows.forEach((r,i)=>data.set(r,4+i*4));
  const result={data,rows,maxHeight,globalMix:PUPIL_GLOBAL_MIX,enabled,probes,passed,buildMs:performance.now()-started};
  entries.set(key,result);if(entries.size>8)entries.delete(entries.keys().next().value);
  return result;
}

export function pupilBox(table,sensor){return table.rows[Math.min(PUPIL_BINS-1,Math.floor(Math.hypot(...sensor)/table.maxHeight*PUPIL_BINS))];}
/** Reference implementation of exactly the GPU's two-dimensional mixture map.
 * Component choice consumes/remaps u; v and all five existing Sobol dimensions
 * remain unchanged. Returns density in the original reference-plane mm^-2.
 */
export function samplePupil(table,sensor,radius,u,v){
  const h=Math.hypot(...sensor),c=h>1e-8?sensor[0]/h:1,s=h>1e-8?sensor[1]/h:0;
  const b=pupilBox(table,sensor),area=(b[1]-b[0])*(b[3]-b[2]);
  const active=table.enabled&&area<Math.PI*radius*radius,alpha=active?table.globalMix:1;
  let q;
  if(u<alpha){q=concentricDisk(u/alpha,v).map(x=>x*radius);q=[c*q[0]+s*q[1],-s*q[0]+c*q[1]];}
  else q=[b[0]+(b[1]-b[0])*(u-alpha)/(1-alpha),b[2]+(b[3]-b[2])*v];
  const inGlobal=q[0]*q[0]+q[1]*q[1]<=radius*radius;
  const inLocal=q[0]>=b[0]&&q[0]<=b[1]&&q[1]>=b[2]&&q[1]<=b[3];
  const pdf=(inGlobal?alpha/(Math.PI*radius*radius):0)+(inLocal?(1-alpha)/area:0);
  return {reference:[c*q[0]-s*q[1],s*q[0]+c*q[1]],pdf,inGlobal,local:u>=alpha};
}
