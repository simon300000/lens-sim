// Shared Node/browser parameter experiment. Legacy estimator is frozen at the
// pre-change implementation; all acceptance and integrals use full f64 tracing.
import {packLens} from '../src/optics/lens-state.js';
import {buildPupilTable,samplePupil,pupilBox} from '../src/optics/pupil-sampling.js';
import {buildPupilTable as legacyBuild,samplePupil as legacySample} from './fixtures/pupil-sampling-legacy.js';
import {traceLens} from '../src/optics/optical-reference.js';
import {sampleDimension} from '../src/spectral/sampler.js';
export const sweepIds=['7artisans-af-135mm-f1-8-max','zeiss-otus-55mm-f1-4','canon-fl-50mm-f1-8','canon-ef-40mm-f2-8-stm','sony-fe-24mm-f1-4-gm'];
const area=b=>(b[1]-b[0])*(b[3]-b[2]);
export async function pupilSweep(load,{ids=sweepIds,bins=[128,256,512,1024],movingModes=[false,true],samples=16384,fine=192,progress=()=>{}}={}){
 const results=[];
 for(const id of ids){
  const lens=await load(id),p=packLens(lens,{sensorZMm:lens.sensorZMm}),legacy=legacyBuild(lens,p),variants=[];
  for(const n of bins)for(const movingCenter of movingModes)variants.push({name:(movingCenter?'moving':'fixed')+n,table:buildPupilTable(lens,p,{bins:n,movingCenter}),sample:samplePupil});
  const rows=[];
  // Independent heights include interior quarter-bin locations, not just the
  // endpoints/midpoints used during construction. Cover band and outer field.
  for(const fraction of [0,.231,.499,.773,.995])for(const nm of [390,550,770]){
   const h=legacy.maxHeight*fraction,b=pupilBox(legacy,[h,0]);
   const R=p.region.radiusMm,d=p.sensorZMm-p.region.zMm;
   const ray=(x,y)=>traceLens(lens,[h,0,p.sensorZMm],[x-h,y,-d],{wavelengthNm:nm,stopRadiusMm:p.stopRadiusMm});
   const good=[];let refEnergy=0,numerical=0;
   // Reference rectangle is frozen legacy (large margins), independent of new
   // bounds. In addition, coarse full-disc probes detect detached support.
   const dx=(b[1]-b[0])/fine,dy=(b[3]-b[2])/fine;
   for(let j=0;j<fine;j++)for(let i=0;i<fine;i++){
    const x=b[0]+(i+.5)*dx,y=b[2]+(j+.5)*dy;if(x*x+y*y>R*R)continue;
    const r=ray(x,y);if(r.status===3)numerical++;if(r.status!==0)continue;
    const w=4/Math.PI*d*d/(d*d+(x-h)**2+y*y)**2*dx*dy;refEnergy+=w;good.push([x,y,w]);
   }
   const globalGood=[];const coarse=96;
   for(let j=0;j<coarse;j++)for(let i=0;i<coarse;i++){
    const x=-R+(i+.5)*2*R/coarse,y=-R+(j+.5)*2*R/coarse;
    if(x*x+y*y<=R*R&&ray(x,y).status===0)globalGood.push([x,y]);
   }
   for(const v of variants){
    const box=pupilBox(v.table,[h,0]);
    const outside=([x,y])=>x<box[0]||x>box[1]||y<box[2]||y>box[3];
    let pass=0,energy=0,sum2=0;
    for(let i=0;i<samples;i++){
     const q=v.sample(v.table,[h,0],R,sampleDimension(0,i,2,123),sampleDimension(0,i,3,123));if(!q.inGlobal)continue;
     const [x,y]=q.reference;if(ray(x,y).status!==0)continue;pass++;
     const w=4/Math.PI*d*d/(d*d+(x-h)**2+y*y)**2/q.pdf;energy+=w;sum2+=w*w;
    }
    const omittedEnergy=good.reduce((s,q)=>s+(outside(q)?q[2]:0),0);
    rows.push({variant:v.name,h,nm,area:area(box),passRate:pass/samples,energy:energy/samples,refEnergy,relativeError:refEnergy?energy/samples/refEnergy-1:null,standardError:Math.sqrt(Math.max(0,sum2/samples-(energy/samples)**2)/samples),referencePassed:good.length,omittedPoints:good.filter(outside).length,omittedEnergy,omittedFraction:refEnergy?omittedEnergy/refEnergy:0,globalOutside:globalGood.filter(outside).length,numerical});
   }
   progress(`${id} h=${h.toFixed(2)} nm=${nm}`);await new Promise(r=>setTimeout(r,0));
  }
  results.push({id,sensorZMm:p.sensorZMm,region:p.region,builds:variants.map(v=>({variant:v.name,buildMs:v.table.buildMs,precomputeMs:v.table.precomputeMs,deriveMs:v.table.deriveMs,physicalCacheHit:v.table.physicalCacheHit,coldBuildMs:v.table.coldBuildMs,probes:v.table.probes,diagnostics:v.table.diagnostics})),rows});
 }
 return {date:new Date().toISOString(),samples,fine,results};
}
