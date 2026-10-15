import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {packLens} from '../src/optics/lens-state.js';
import {buildPupilTable,samplePupil,pupilBox} from '../src/optics/pupil-sampling.js';
import {traceLens} from '../src/optics/optical-reference.js';
import {sampleDimension} from '../src/spectral/sampler.js';
import {pupilReference} from './pupil-reference.js';
const load=id=>JSON.parse(fs.readFileSync(new URL('../public/lenses/'+id+'.json',import.meta.url))).configurations[0];
const otus=load('zeiss-otus-55mm-f1-4'),packed=packLens(otus,{sensorZMm:otus.lastVertexZMm+1.373}),table=buildPupilTable(otus,packed);
function estimate(lens,p,t,h,nm,N,seed=1,spotBox=null){
  let energy=0,pass=0,outside=0,sum2=0,max=0;const weights=[];const spotHistogram=Array(64).fill(0),hist=Array(16).fill(0),moments=[0,0];
  for(let i=0;i<N;i++){
    const q=samplePupil(t,[h,0],p.region.radiusMm,sampleDimension(0,i,2,seed),sampleDimension(0,i,3,seed));
    if(!q.inGlobal)continue;const [x,y]=q.reference,d=p.sensorZMm-p.region.zMm;
    const ray=traceLens(lens,[h,0,p.sensorZMm],[x-h,y,-d],{wavelengthNm:nm,stopRadiusMm:p.stopRadiusMm});if(ray.status!==0)continue;pass++;
    const w=4/Math.PI*d*d/(d*d+(x-h)**2+y*y)**2/q.pdf;energy+=w;sum2+=w*w;max=Math.max(max,w);weights.push(w);
    const b=pupilBox(t,[h,0]);if(x<b[0]||x>b[1]||y<b[2]||y>b[3])outside+=w;
    hist[Math.min(15,Math.floor((Math.atan2(y,x-h)+Math.PI)/(2*Math.PI)*16))]+=w/N;
    const dt=(-1000-ray.point[2])/ray.direction[2],X=ray.point[0]+dt*ray.direction[0],Y=ray.point[1]+dt*ray.direction[1];moments[0]+=w*X*X;moments[1]+=w*Y*Y;
    if(spotBox){const ix=Math.max(0,Math.min(7,Math.floor((X-spotBox[0])/(spotBox[1]-spotBox[0])*8))),iy=Math.max(0,Math.min(7,Math.floor((Y-spotBox[2])/(spotBox[3]-spotBox[2])*8)));spotHistogram[iy*8+ix]+=w/N;}

  }
  weights.sort((a,b)=>a-b);
  const weightQuantiles=[.05,.5,.95].map(q=>weights[Math.min(weights.length-1,Math.floor(weights.length*q))]??0);
  return {spotHistogram,weightQuantiles,energy:energy/N,passRate:pass/N,outside:outside/N,sum2:sum2/N,max,histogram:hist,moments:moments.map(x=>x/energy)};
}

test('pupil cache keys optics, not pose/light; fallback and mixture retain full support',()=>{
  assert.equal(buildPupilTable(otus,packed),table);
  assert.notEqual(buildPupilTable(otus,packLens(otus,{sensorZMm:packed.sensorZMm+.01})),table);
  assert.notEqual(buildPupilTable(otus,packLens(otus,{sensorZMm:packed.sensorZMm,fNumber:2})),table);
  assert.notEqual(buildPupilTable(otus,packed,{enabled:false}),table);
  // Deliberately wrong small proposal: global component must still carry a
  // remote unit integrand. Also exercise overlap and points outside the disc.
  const t={...table,rows:table.rows.map(()=>[-.1,.1,-.1,.1])};
  const a=samplePupil(t,[0,0],1,.025,.5),b=samplePupil(t,[0,0],1,.525,.5);
  assert.ok(a.pdf>0&&b.pdf>0);assert.ok(Math.abs(b.pdf-(.05/Math.PI+.95/.04))<1e-10);
  let integral=0;const N=400;
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){
    const q=samplePupil(t,[0,0],1,(i+.5)/N,(j+.5)/N);if(q.inGlobal)integral+=1/q.pdf/N/N;
  }
  assert.ok(Math.abs(integral-Math.PI)<.06,`${integral} != pi; global-only contributions were lost`);
  for(const h of [5,17]){
    const a=samplePupil(table,[h,0],packed.region.radiusMm,.7,.3),b=samplePupil(table,[0,h],packed.region.radiusMm,.7,.3);
    assert.ok(Math.abs(a.reference[0]-b.reference[1])<1e-9&&Math.abs(a.reference[1]+b.reference[0])<1e-9);assert.equal(a.pdf,b.pdf);
  }
});

test('Otus white radiance, wavelength, vignetting and defocus shape match independent f64 disc quadrature',()=>{
  const rows=[];
  for(const [h,nm]of [[0,390],[0,550],[0,770],[5,550],[15,390],[15,550],[15,770]]){
    const ref=pupilReference(otus,packed,h,nm),ref2=pupilReference(otus,packed,h,nm,{fine:384,box:ref.box});
    assert.ok(Math.abs(ref.energy-ref2.energy)<.006*ref2.energy,'Reference quadrature not converged');
    const got=estimate(otus,packed,table,h,nm,32768,1,ref2.spotBox);
    assert.ok(Math.abs(got.energy-ref2.energy)<.025*ref2.energy,`energy h=${h} nm=${nm}: ${got.energy} vs ${ref2.energy}`);
    const shapeError=got.histogram.reduce((s,x,i)=>s+Math.abs(x-ref2.histogram[i]),0)/ref2.energy;
    assert.ok(shapeError<.07,`pupil shape changed ${shapeError}`);
    const psfError=got.spotHistogram.reduce((s,x,i)=>s+Math.abs(x-ref2.spotHistogram[i]),0)/ref2.energy;
    assert.ok(psfError<.15,`Defocused point shape changed ${psfError}`);
    for(let i=0;i<2;i++)assert.ok(Math.abs(got.moments[i]/ref2.moments[i]-1)<.05,'Defocused point spread second moment changed');
    assert.equal(got.outside,0,'Detected omitted physical contribution: increase proposal padding');
    assert.ok(got.passRate>.05,'Otus proposal did not improve efficiency');
    rows.push({h,nm,reference:ref2.energy,...got});
  }
  // Original full-domain estimator: enough aggregate samples to compare its
  // mean without mistaking the expected sparse-ray variance for a bias.
  const baseline=buildPupilTable(otus,packed,{enabled:false}),base=estimate(otus,packed,baseline,0,550,1048576,9);
  const ref=rows.find(r=>r.h===0&&r.nm===550).reference;
  assert.ok(Math.abs(base.energy-ref)<.10*ref,`original estimator inconsistent ${base.energy} vs ${ref}`);
  console.log(JSON.stringify({pupilAcceptance:rows,original:base,buildMs:table.buildMs}));
});

test('other optical layouts, smaller aperture and empty proposals retain finite densities',()=>{
  for(const [id,fno]of [['canon-fl-50mm-f1-8',4],['canon-ef-40mm-f2-8-stm',8],['zeiss-otus-55mm-f1-4',8]]){
    const l=load(id),p=packLens(l,{fNumber:fno}),t=buildPupilTable(l,p);
    assert.ok(t.data.every(Number.isFinite));
    for(const h of [0,10,21])for(let i=0;i<128;i++){
      const q=samplePupil(t,[h,0],p.region.radiusMm,(i+.5)/128,.37);assert.ok(Number.isFinite(q.pdf)&&q.pdf>0);
    }
  }
});

test('radiometry also agrees at a smaller stop and in a different lens layout',()=>{
  for(const [id,fNumber,h]of [['canon-fl-50mm-f1-8',4,10],['zeiss-otus-55mm-f1-4',8,5]]){
    const l=load(id),p=packLens(l,{fNumber,...(id.startsWith('zeiss')?{sensorZMm:l.lastVertexZMm+1.373}:{})}),t=buildPupilTable(l,p);
    const ref=pupilReference(l,p,h,550,{coarse:1024,fine:384}),got=estimate(l,p,t,h,550,131072,7);
    assert.ok(ref.energy>0);assert.ok(Math.abs(got.energy/ref.energy-1)<.04,`${id} f/${fNumber}: ${got.energy} vs ${ref.energy}`);
  }
});
