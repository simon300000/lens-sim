// Numerical preview data only: source f64 prescription, no image synthesis.
// Render with scripts/plot-pupil-bounds.py (Pillow).
import fs from 'node:fs';
import {packLens} from '../src/optics/lens-state.js';
import {buildPupilTable,pupilBox} from '../src/optics/pupil-sampling.js';
import {traceLens} from '../src/optics/optical-reference.js';
const id='7artisans-af-135mm-f1-8-max',lens=JSON.parse(fs.readFileSync(new URL('../public/lenses/'+id+'.json',import.meta.url))).configurations[0];
const packed=packLens(lens,{sensorZMm:lens.sensorZMm}),moving=buildPupilTable(lens,packed),fixed=buildPupilTable(lens,packed,{bins:128,movingCenter:false});
if(!moving.movingCenter||moving.bins!==128||moving.globalMix!==.05)throw Error('Default pupil configuration changed');
const R=packed.region.radiusMm,N=224,wavelengths=[650,550,450],heights=[0,5,10,15,moving.maxHeight];
const report={id,name:lens.name,fNumber:packed.fNumber,sensorZMm:packed.sensorZMm,gapMm:packed.sensorZMm-lens.lastVertexZMm,referenceRadiusMm:R,bins:moving.bins,movingCenter:moving.movingCenter,globalMix:moving.globalMix,probeWavelengths:[380,587.5618,780],displayRGBWavelengths:wavelengths,gridSize:N,panels:[]};
function scan(h,cx,cy,extent){
 const rgb=Buffer.alloc(N*N*3);let passed550=0;
 for(let j=0;j<N;j++)for(let i=0;i<N;i++){
  const x=cx+((i+.5)/N-.5)*extent,y=cy+(.5-(j+.5)/N)*extent;
  if(x*x+y*y>R*R)continue;
  for(let k=0;k<3;k++)if(traceLens(lens,[h,0,packed.sensorZMm],[x-h,y,packed.region.zMm-packed.sensorZMm],{wavelengthNm:wavelengths[k],stopRadiusMm:packed.stopRadiusMm}).status===0){rgb[(j*N+i)*3+k]=255;if(k===1)passed550++;}
 }
 return {cx,cy,extent,rgb:rgb.toString('base64'),passed550};
}
for(const h of heights){
 const a=pupilBox(fixed,[h,0]),b=pupilBox(moving,[h,0]),u=[Math.min(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.max(a[3],b[3])];
 const common=scan(h,(u[0]+u[1])/2,(u[2]+u[3])/2,Math.max(u[1]-u[0],u[3]-u[2])*1.18);
 const zoom=scan(h,(b[0]+b[1])/2,(b[2]+b[3])/2,Math.max(b[1]-b[0],b[3]-b[2])*1.18);
 report.panels.push({heightMm:h,fixed:a,moving:b,common,zoom});
 console.error(`Traced pupil preview h=${h.toFixed(3)}mm`);
}
fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/pupil-default-preview-data.json',JSON.stringify(report));
