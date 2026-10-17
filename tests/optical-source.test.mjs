import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {opticalSourceForLutPolicy} from '../src/rendering/optical-source.js';
import {preferredOpticalLutReuse} from '../src/rendering/integration-mode.js';
const source=readFileSync(new URL('../src/optics/optical-core.wgsl',import.meta.url),'utf8');
test('LUT reuse is enabled only for validated NVIDIA adapters',()=>{
 for(const vendor of ['nvidia','NVIDIA','0x10de','10de'])assert.equal(preferredOpticalLutReuse({vendor}),true);
 assert.equal(preferredOpticalLutReuse({description:'NVIDIA GeForce RTX 4090'}),true);
 for(const vendor of ['apple','intel','amd',''])assert.equal(preferredOpticalLutReuse({vendor}),false);
});
test('the fallback restores original lookup scope and preserves geometry, phase and refraction code',()=>{
 assert.equal(opticalSourceForLutPolicy(source,true),source);
 const fallback=opticalSourceForLutPolicy(source,false);
 assert.doesNotMatch(fallback,/previousRecord|previousIndex|lutFraction|opticalIndexAt/);
 assert.match(fallback,/opticalIndex\(before,wavelength\)/);
 assert.equal(fallback.slice(0,fallback.indexOf('fn opticalIndex(')),source.slice(0,source.indexOf('fn opticalIndexAt(')));
 assert.equal(fallback.slice(fallback.indexOf('      \/\/ Reciprocal phase delay')),source.slice(source.indexOf('      \/\/ Reciprocal phase delay')));
 assert.equal(opticalSourceForLutPolicy(source.replaceAll('\n','\r\n'),false),fallback);
});
test('source drift fails closed rather than silently changing the requested policy',()=>{
 assert.throws(()=>opticalSourceForLutPolicy(source.replace('fn opticalIndexAt(','fn changed('),false),/specialization changed/);
});
