// Proposal construction only. The full physical tracer remains the integrand.
// Failed probes cannot prove zero support: a global disc component is mandatory.
import { traceLens } from './optical-reference.js';
import { concentricDisk } from '../spectral/sampler.js';

const cache=new WeakMap();
export const PUPIL_BINS=128;
// Fixed uniform capacity keeps one GPU layout for all benchmark resolutions.
export const PUPIL_MAX_BINS=256;
export const PUPIL_TABLE_BYTES=16+PUPIL_MAX_BINS*16;
export const PUPIL_GLOBAL_MIX=.05;
const PRIMARY=587.5618;
const union=(a,b)=>[Math.min(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.max(a[3],b[3])];

export function buildPupilTable(lens,packed,{enabled=true,bins=PUPIL_BINS}={}) {
  if(!Number.isInteger(bins)||bins<1||bins>PUPIL_MAX_BINS)throw new RangeError(`Pupil bins must be an integer from 1 to ${PUPIL_MAX_BINS}`);
  const {sensorZMm,stopRadiusMm,region}=packed;
  // Contact-plane configurations retain the angular sampler.
  enabled=enabled&&!region.directional;
  const p=new Float32Array(packed.parameters.buffer,packed.parameters.byteOffset,16);
  const sensorMm=[p[12],p[13]],dispersion=new Uint32Array(packed.parameters.buffer,packed.parameters.byteOffset,16)[3]!==0;
  const key=JSON.stringify([sensorZMm,stopRadiusMm,...sensorMm,region.zMm,region.radiusMm,dispersion,enabled,bins]);
  let entries=cache.get(lens);if(!entries){entries=new Map();cache.set(lens,entries);}
  if(entries.has(key))return entries.get(key);
  const started=performance.now(),maxHeight=Math.hypot(...sensorMm)/2,R=region.radiusMm;
  const full=[-R,R,-R,R],data=new Float32Array(PUPIL_TABLE_BYTES/4);
  data.set([maxHeight,bins,PUPIL_GLOBAL_MIX,enabled?1:0]);
  const wavelengths=dispersion?[380,PRIMARY,780]:[PRIMARY];
  const rows=[],nodes=[],nodeStates=[];let probes=0,passed=0;
  const diagnostics={guideProbes:0,seedProbes:0,edgeProbes:0,midpointProbes:0,refinementProbes:0,seedFallbacks:0,midpointExpansions:0,midpointSeedFallbacks:0,uncertainFallbacks:0,iterationLimits:0,numericalErrors:0,endpointNodes:enabled?bins+1:0,midpointChecks:enabled?bins:0};
  // Aperture-free rear-to-stop tracing only proposes a seed and a scale.
  // Every acceptance test below traces the unmodified complete physical lens.
  const guide={...lens,surfaces:lens.surfaces.slice(lens.stopIndex).map(s=>({...s,apertureRadiusMm:null}))};
  const guideSeeds=new Map();
  function stopPoint(h,q,nm){
    diagnostics.guideProbes++;
    const r=traceLens(guide,[h,0,sensorZMm],[q[0]-h,q[1],region.zMm-sensorZMm],{wavelengthNm:nm,dispersion});
    return r.status===0?r.point:null;
  }
  function footprint(h,nm){
    const previous=guideSeeds.get(nm);
    let q=previous?[previous.q[0]+h-previous.h,previous.q[1]]:[h,0],inverse;
    const step=Math.max(1e-4,Math.abs(sensorZMm-region.zMm)*1e-3);
    for(let i=0;i<10;i++){
      const a=stopPoint(h,q,nm),b=stopPoint(h,[q[0]+step,q[1]],nm),c=stopPoint(h,[q[0],q[1]+step],nm);
      if(!a||!b||!c)return null;
      const A=(b[0]-a[0])/step,B=(c[0]-a[0])/step,C=(b[1]-a[1])/step,D=(c[1]-a[1])/step,det=A*D-B*C;
      if(!Number.isFinite(det)||Math.abs(det)<1e-12)return null;
      inverse=[D/det,-B/det,-C/det,A/det];
      if(Math.hypot(a[0],a[1])<1e-5)break;
      const dx=inverse[0]*a[0]+inverse[1]*a[1],dy=inverse[2]*a[0]+inverse[3]*a[1];
      const scale=Math.min(1,R/Math.max(Math.hypot(dx,dy),1e-10));
      q=[q[0]-dx*scale,q[1]-dy*scale];
    }
    if(!inverse)return null;
    const rx=stopRadiusMm*Math.hypot(inverse[0],inverse[1]),ry=stopRadiusMm*Math.hypot(inverse[2],inverse[3]);
    if(!(rx>0&&ry>0)||!Number.isFinite(rx+ry+q[0]+q[1]))return null;
    guideSeeds.set(nm,{h,q});return {q,rx,ry};
  }
  function atHeight(h){
    // Repeated corners and refinement probes at one height share exact results.
    const memo=new Map();
    function probe(q,nm,kind){
      if(q[0]*q[0]+q[1]*q[1]>R*R)return false;
      const key=`${nm}/${q[0]}/${q[1]}`;
      if(memo.has(key))return memo.get(key);
      probes++;diagnostics[kind]++;
      const ray=traceLens(lens,[h,0,sensorZMm],[q[0]-h,q[1],region.zMm-sensorZMm],{wavelengthNm:nm,dispersion,stopRadiusMm});
      const ok=ray.status===0;if(ok)passed++;if(ray.status===3)diagnostics.numericalErrors++;
      memo.set(key,ok);return ok;
    }
    return {probe,any:(q,kind)=>wavelengths.some(nm=>probe(q,nm,kind))};
  }
  // Include seed projections as well as evenly spaced points so even the first
  // very narrow rectangle has a known transmitting cross-section on each edge.
  function edgePass(box,side,value,seeds,any,kind){
    const vertical=side<2,lo=box[vertical?2:0],hi=box[vertical?3:1];
    const positions=[...seeds.map(q=>q[vertical?1:0]),(lo+hi)/2];
    for(let i=0;i<=16;i++)positions.push(lo+(hi-lo)*i/16);
    const seen=new Set();
    for(const t of positions){
      if(t<lo||t>hi||seen.has(t))continue;seen.add(t);
      if(any(vertical?[value,t]:[t,value],kind))return true;
    }
    return false;
  }
  function grow(box,seeds,any,scales,previous=null,kind='edgeProbes'){
    const tolerance=scales.map(s=>Math.max(R*1e-6,s*.003));
    // A second sweep is essential: widening y may expose x support that was
    // absent from the initial narrow seed rectangle (and vice versa).
    for(let sweep=0;sweep<4;sweep++){
      let changed=false;
      for(let side=0;side<4;side++){
        const axis=side<2?0:1,sign=side%2===0?-1:1,limit=sign*R,tol=tolerance[axis];
        let inside=box[side];
        if(!edgePass(box,side,inside,seeds,any,kind))continue;
        let step=Math.max(scales[axis]*.08,tol*2),outside=inside;
        // Continue near the previous height's boundary, but test that point:
        // the old box is a search hint, never a physical acceptance decision.
        let next=previous?previous[side]-sign*scales[axis]*.025:inside+sign*step;
        if(sign*(next-inside)<=tol)next=inside+sign*step;
        let bracketed=false;
        for(let iteration=0;iteration<24;iteration++){
          outside=sign>0?Math.min(limit,next):Math.max(limit,next);
          if(!edgePass(box,side,outside,seeds,any,kind)){
            bracketed=true;
            // A previous boundary can land just outside the new footprint.
            // Find an inner bracket nearby rather than bisecting all the way
            // from the seed rectangle at every height.
            if(iteration===0&&previous){
              let retreat=Math.max(scales[axis]*.025,tol*2);
              while(sign*(outside-inside)>retreat){
                const candidate=outside-sign*retreat;
                if(edgePass(box,side,candidate,seeds,any,kind)){inside=candidate;break;}
                outside=candidate;retreat*=1.7;
              }
            }
            break;
          }
          inside=outside;if(outside===limit)break;
          step*=1.7;next=inside+sign*step;
          if(iteration===23)diagnostics.iterationLimits++;
        }
        if(bracketed){
          for(let iteration=0;iteration<12&&Math.abs(outside-inside)>tol;iteration++){
            const mid=(inside+outside)/2;
            if(edgePass(box,side,mid,seeds,any,'refinementProbes'))inside=mid;else outside=mid;
          }
        }
        if(sign*(outside-box[side])>tol*.25){box[side]=outside;changed=true;}
      }
      if(!changed)break;
      if(sweep===3)diagnostics.iterationLimits++;
    }
    return box;
  }
  function pad(box,scales){
    // Small finite-probe and float32 margins. Global mixture covers any support
    // that remains undiscovered, including disconnected or spectral islands.
    const px=Math.max(scales[0]*.025,(box[1]-box[0])*.0125,R*2e-6);
    const py=Math.max(scales[1]*.025,(box[3]-box[2])*.0125,R*2e-6);
    return [Math.max(-R,box[0]-px),Math.min(R,box[1]+px),Math.max(-R,box[2]-py),Math.min(R,box[3]+py)];
  }
  function uncertain(before){
    // Isolated numerical failures are recorded. Repeated numerical failures or
    // an unfinished edge search make this height's proposal uninformative.
    return diagnostics.iterationLimits>before.limits||
      (diagnostics.numericalErrors-before.errors>8&&diagnostics.numericalErrors-before.errors>.1*(probes-before.probes));
  }
  const snapshot=()=>({probes,errors:diagnostics.numericalErrors,limits:diagnostics.iterationLimits});
  let previous=null;
  if(enabled){
    for(let i=0;i<=bins;i++){
      const before=snapshot(),h=maxHeight*i/bins,{probe,any}=atHeight(h),seeds=[],seedByNm=new Map(),scales=[R*.01,R*.01];
      for(const nm of wavelengths){
        const guide=footprint(h,nm),center=guide?.q??[h,0];
        const rx=guide?.rx??R,ry=guide?.ry??R;
        let seed=null;
        const candidates=[center];
        if(previous)for(const q of previous.seeds)candidates.push([q[0]+center[0]-previous.center[0],q[1]]);
        for(const q of candidates)if(probe(q,nm,'seedProbes')){seed=q;break;}
        // Only seed acquisition uses a bounded coarse search. Empty or unknown
        // regions fall back instead of interpreting failed probes as zero light.
        if(!seed)for(const fraction of [.25,.6,1]){
          for(let y=-2;y<=2&&!seed;y++)for(let x=-2;x<=2;x++){
            const q=[center[0]+x*rx*fraction/2,center[1]+y*ry*fraction/2];
            if(probe(q,nm,'seedProbes')){seed=q;break;}
          }
          if(seed)break;
        }
        if(seed){seeds.push(seed);seedByNm.set(nm,seed);scales[0]=Math.max(scales[0],rx);scales[1]=Math.max(scales[1],ry);}
      }
      if(!seeds.length){diagnostics.seedFallbacks++;nodes.push([...full]);nodeStates.push(null);previous=null;continue;}
      const center=seeds[0],small=scales.map(s=>Math.max(s*.01,R*1e-6));
      let box=[center[0]-small[0],center[0]+small[0],center[1]-small[1],center[1]+small[1]];
      for(const q of seeds)box=union(box,[q[0]-small[0],q[0]+small[0],q[1]-small[1],q[1]+small[1]]);
      const hint=previous?.box.map((v,j)=>v+center[j<2?0:1]-previous.center[j<2?0:1]);
      box=grow(box,seeds,any,scales,hint);
      // Padding is applied after all search/refinement, never fed back as hits.
      if(uncertain(before)){diagnostics.uncertainFallbacks++;nodes.push([...full]);nodeStates.push(null);previous=null;continue;}
      nodes.push(pad(box,scales));nodeStates.push({seedByNm,scales});previous={box,seeds,center,scales};
    }
    for(let i=0;i<bins;i++){
      const before=snapshot(),a=nodes[i],b=nodes[i+1],initial=union(a,b),h=maxHeight*(i+.5)/bins;
      const {probe,any}=atHeight(h),scales=[(initial[1]-initial[0])/2,(initial[3]-initial[2])/2],seeds=[];
      let candidate=[...initial];
      for(const nm of wavelengths){
        const left=nodeStates[i]?.seedByNm.get(nm),right=nodeStates[i+1]?.seedByNm.get(nm);
        let q=left&&right?left.map((v,j)=>(v+right[j])/2):null;
        if(!q||!probe(q,nm,'midpointProbes')){
          const guide=footprint(h,nm);q=guide?.q;
          if(!q||!probe(q,nm,'midpointProbes'))continue;
        }
        seeds.push(q);
        // A valid midpoint seed can have moved outside both endpoint bounds.
        // Include it before testing the four edges of their union.
        const dx=Math.max(scales[0]*.01,R*1e-6),dy=Math.max(scales[1]*.01,R*1e-6);
        candidate=union(candidate,[q[0]-dx,q[0]+dx,q[1]-dy,q[1]+dy]);
      }
      if(!seeds.length){diagnostics.midpointSeedFallbacks++;rows.push([...full]);continue;}
      // Endpoint union plus midpoint seed/edge validation assumes smoothly
      // varying connected footprints; it is not a support proof. The unchanged
      // global mixture also covers missed islands and interior wavelengths.
      const box=grow(candidate,seeds,any,scales,null,'midpointProbes');
      if(uncertain(before)){diagnostics.uncertainFallbacks++;rows.push([...full]);continue;}
      if(box.some((v,j)=>v!==initial[j])){diagnostics.midpointExpansions++;rows.push(pad(box,scales));}
      else rows.push(initial);
    }
  }else for(let i=0;i<bins;i++)rows.push([...full]);
  rows.forEach((r,i)=>data.set(r,4+i*4));
  const result={data,rows,nodes,bins,maxHeight,globalMix:PUPIL_GLOBAL_MIX,enabled,probes,passed,diagnostics,buildMs:performance.now()-started};
  entries.set(key,result);if(entries.size>8)entries.delete(entries.keys().next().value);
  return result;
}

export function pupilBox(table,sensor){
  const bins=table.bins??table.rows.length;
  const index=table.maxHeight>0?Math.floor(Math.hypot(...sensor)/table.maxHeight*bins):0;
  return table.rows[Math.min(bins-1,Math.max(0,index))];
}
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
