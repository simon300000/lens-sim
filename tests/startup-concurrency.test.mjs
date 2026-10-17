import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGPUInterop} from '../src/rendering/three-interop.js';
import {buildPupilTable,cachePreparedPupilTable} from '../src/optics/pupil-sampling.js';
import {packLens} from '../src/optics/lens-state.js';

test('concurrent pipeline compilation closes every device error scope before awaiting',async()=>{
 let depth=0,maxDepth=0,started=0,complete;
 const ready=new Promise(resolve=>{complete=resolve;});
 const limits={maxTextureDimension2D:8192,maxBindGroups:4,maxBindingsPerBindGroup:1000,maxUniformBuffersPerShaderStage:12,maxStorageBuffersPerShaderStage:8,maxStorageTexturesPerShaderStage:4,maxSampledTexturesPerShaderStage:16,maxSamplersPerShaderStage:16,maxUniformBufferBindingSize:65536,maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxComputeWorkgroupSizeY:256,maxComputeWorkgroupStorageSize:16384,maxComputeWorkgroupsPerDimension:65535,maxBufferSize:256*1024**2,maxStorageBufferBindingSize:128*1024**2};
 const device={limits,lost:new Promise(()=>{}),pushErrorScope(){maxDepth=Math.max(maxDepth,++depth);},popErrorScope(){assert.equal(depth,1);depth--;return Promise.resolve(null);},
  createShaderModule({label}){return {getCompilationInfo:()=>ready.then(()=>({messages:label==='invalid'?[{type:'error',lineNum:1,linePos:1,message:'fixture error'}]:[]}))};},
  createComputePipelineAsync({label}){started++;return ready.then(()=>{if(label==='invalid')throw Error('fixture pipeline rejected');return {label};});}};
 const interop=createGPUInterop({backend:{device,isWebGPUBackend:true,get(){}}});
 const jobs=['sample','resolve','invalid','focus'].map(label=>interop.computePipeline('fixture',label));
 assert.equal(started,4);assert.equal(depth,0);assert.equal(maxDepth,1);complete();
 const results=await Promise.allSettled(jobs);assert.equal(results[2].status,'rejected');assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.equal(interop.compilations,3);
});

test('prepared pupil tables retain exact uniform bytes and reject a stale optics key',()=>{
 const lens=JSON.parse(readFileSync(new URL('../public/lenses/canon-fl-50mm-f1-8.json',import.meta.url))).configurations[0];
 const packed=packLens(lens,{sensorZMm:lens.sensorZMm}),options={enabled:false,bins:1};
 const table=buildPupilTable(lens,packed,options),copy=structuredClone(table),fresh=structuredClone(lens);
 assert.equal(cachePreparedPupilTable(fresh,packed,options,copy),copy);
 assert.equal(buildPupilTable(fresh,packed,options),copy);
 assert.deepEqual(copy.data,table.data);
 const moved=packLens(lens,{sensorZMm:lens.sensorZMm+.01});
 assert.throws(()=>cachePreparedPupilTable(fresh,moved,options,copy),/does not match/);
});
