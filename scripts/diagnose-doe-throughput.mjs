/** Diagnostic only: reproduce the fixed uniform rear-disk sample sequence.
 * Run npm run build:lenses first, then node scripts/diagnose-doe-throughput.mjs 32
 * or 1024. Each stdout line is one configuration with complete status counts,
 * failed-surface counts and directed reciprocal control rays. No ray retries.
 */
import fs from 'node:fs';
import {traceLens,add,unit} from '../src/optics/optical-reference.js';
import {packLens} from '../src/optics/lens-state.js';
import {sampleDimension,concentricDisk} from '../src/spectral/sampler.js';
const asset=JSON.parse(fs.readFileSync(new URL('../public/lenses/nikon-z-600mm-f4-vr-s.json',import.meta.url)));
const report={cases:[]};
for(const lens of asset.configurations){
 const p=packLens(lens,{sensorZMm:lens.sensorZMm});const statuses=[0,0,0,0],surfaceBlocks={},targeted=[],central=[0,0,0,0];
 const spp=Number(process.argv[2]??32);
 for(let pixel=0;pixel<48*32;pixel++)for(let k=0;k<spp;k++){
  const sensor=[-((pixel%48+sampleDimension(pixel,k,0,185))/48-.5)*36,((Math.floor(pixel/48)+sampleDimension(pixel,k,1,185))/32-.5)*24,p.sensorZMm];
  const disk=concentricDisk(sampleDimension(pixel,k,2,185),sampleDimension(pixel,k,3,185));
  const reference=[disk[0]*p.region.radiusMm,disk[1]*p.region.radiusMm,p.region.zMm],nm=380+400*sampleDimension(pixel,k,4,185);
  let point=sensor,direction=unit(add(reference,sensor,-1)),r;
  for(const s of [...lens.surfaces].reverse()){
   r=traceLens({...lens,surfaces:[s]},point,direction,{reverse:true,wavelengthNm:nm,stopRadiusMm:p.stopRadiusMm});
   if(r.status){surfaceBlocks[s.index+1]=(surfaceBlocks[s.index+1]??0)+1;break;}
   point=r.point;direction=r.direction;
  }
  statuses[r.status]++;
 }
 for(const x of [0,1,5,20,50])for(const nm of [390,550,770]){
  const r=traceLens(lens,[x,1,-1],[0,0,1],{reverse:false,wavelengthNm:nm,stopRadiusMm:p.stopRadiusMm});
  if(r.status){targeted.push({x,nm,status:r.status});continue;}
  const sensor=add(r.point,r.direction,(p.sensorZMm-r.point[2])/r.direction[2]);
  const back=traceLens(lens,sensor,r.direction.map(x=>-x),{reverse:true,wavelengthNm:nm,stopRadiusMm:p.stopRadiusMm});
  const reference=add(sensor,r.direction,(p.region.zMm-sensor[2])/r.direction[2]);
  targeted.push({x,nm,status:back.status,sensor,reference,direction:r.direction});
 }
 for(let k=0;k<16384;k++){
  const disk=concentricDisk(sampleDimension(0,k,2,185),sampleDimension(0,k,3,185));
  const reference=[disk[0]*p.region.radiusMm,disk[1]*p.region.radiusMm,p.region.zMm];
  const r=traceLens(lens,[0,0,p.sensorZMm],add(reference,[0,0,p.sensorZMm],-1),{reverse:true,wavelengthNm:550,stopRadiusMm:p.stopRadiusMm});central[r.status]++;
 }
 const row={configurationIndex:lens.configurationIndex,spp,attempts:spp*1536,statuses,surfaceBlocks,centralDisk16384:central,targeted};report.cases.push(row);console.log(JSON.stringify(row));
}
