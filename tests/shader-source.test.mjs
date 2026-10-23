import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripWorkCounting} from '../src/rendering/shader-source.js';
import {stagedIntegratorSources} from '../src/rendering/staged-integrator.js';
import source from '../src/rendering/optical-integrator.wgsl.js';
import opticalCore from '../src/optics/optical-core.wgsl.js';
import workCounters from '../src/rendering/work-counters.wgsl.js';
test('LF, CRLF and EOF diagnostic blocks strip identical bindings and reductions',()=>{
 const original=stripWorkCounting(source);assert.doesNotMatch(original,/workTotals|workAdd|local_invocation_index/);
 assert.equal(stripWorkCounting(source.replaceAll('\n','\r\n')).replaceAll('\r\n','\n'),original);
 assert.equal(stripWorkCounting('before\n// WORK-COUNTING-BEGIN binding\r\nsecret\r\n// WORK-COUNTING-END'),'before\n');
 assert.match(source,/workAdd\(15u, workCounters\[15\]\)/);assert.match(source,/atomicAdd\(&workTotals\[counter \* 2u \+ 1u\], 1u\)/);
});
test('staged mapping is identical across checkout line endings, including counted stages',()=>{
 const common={optical:opticalCore,work:workCounters,intersector:'',shading:'',spectral:'',sampling:'',pupil:''};
 for(const mode of ['surface','ray'])for(const counting of [false,true])assert.deepEqual(stagedIntegratorSources({...common,mode,counting,integrator:source.replaceAll('\n','\r\n')}),stagedIntegratorSources({...common,mode,counting,integrator:source}));
});
