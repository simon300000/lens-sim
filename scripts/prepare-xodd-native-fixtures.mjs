/** Diagnostic-only fixtures for xodd-field-gpu.html?native. Source positions
 * are preserved; output is ignored artifacts/, never public lens assets. */
import fs from 'node:fs/promises';
import {loadUpstreamCatalog} from './build-lens-data.mjs';
import {adaptLensRecord} from '../src/optics/prescription.js';
const root=new URL('../',import.meta.url),catalog=await loadUpstreamCatalog();
const ids=['fujifilm-gf-23mm-f4-r-lm-wr','fujifilm-gf-30mm-f3-5-r-wr','fujifilm-xf-14mm-f2-8-r','fujifilm-xf-60mm-f2-4-r-macro'];
await fs.mkdir(new URL('artifacts/',root),{recursive:true});
const lenses=[];
for(const id of ids){
 const record=JSON.parse(await fs.readFile(new URL(`vendor/lens-bench/data/lenses/${id}.json`,root),'utf8'));
 const configurations=(record.cfgs??[null]).map((_,configurationIndex)=>adaptLensRecord(record,catalog,{configurationIndex}));
 const asset=`/artifacts/native-${id}.json`;
 await fs.writeFile(new URL(asset.slice(1),root),JSON.stringify({id,configurations}));lenses.push({id,supported:true,asset});
}
await fs.writeFile(new URL('artifacts/xodd-native-manifest.json',root),JSON.stringify({lenses}));
console.log(`Prepared ${lenses.length} diagnostic lenses / 19 configurations.`);
