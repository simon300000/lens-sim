import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {pupilSweep} from '../tests/pupil-sweep.js';
const report=await pupilSweep(async id=>JSON.parse(readFileSync(new URL('../public/lenses/'+id+'.json',import.meta.url))).configurations[0],{...(process.env.PUPIL_LENSES?{ids:process.env.PUPIL_LENSES.split(',')}:{}),samples:Number(process.env.PUPIL_SAMPLES??16384),fine:Number(process.env.PUPIL_FINE??192),progress:console.error});
mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/pupil-resolution-cpu.json',JSON.stringify(report,null,2));
for(const r of report.results){for(const b of r.builds){const rows=r.rows.filter(x=>x.variant===b.variant);console.log(JSON.stringify({id:r.id,...b,meanPass:rows.reduce((s,x)=>s+x.passRate,0)/rows.length,meanArea:rows.reduce((s,x)=>s+x.area,0)/rows.length,maxOmitted:Math.max(...rows.map(x=>x.omittedFraction)),globalOutside:rows.reduce((s,x)=>s+x.globalOutside,0)}));}}
