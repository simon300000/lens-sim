import test from 'node:test';
import assert from 'node:assert/strict';
import {computeConfiguration,requiredGPULimits,createGPUMemoryBudget} from '../src/rendering/gpu-policy.js';
import {createGPUInterop} from '../src/rendering/three-interop.js';
import {gpuLimits as limits} from './gpu-limits-fixture.mjs';
test('effective capabilities keep 8x8 sampling and independently select statistics threads',()=>{
 assert.equal(computeConfiguration(limits).statisticsThreads,256);
 assert.equal(computeConfiguration({...limits,maxComputeInvocationsPerWorkgroup:128}).statisticsThreads,128);
 assert.equal(computeConfiguration(limits).sampleX,8);
 assert.throws(()=>computeConfiguration({...limits,maxStorageBuffersPerShaderStage:7}),/maxStorageBuffersPerShaderStage/);
 assert.throws(()=>computeConfiguration({...limits,maxUniformBufferBindingSize:16384}),/maxUniformBufferBindingSize/);
 assert.equal(requiredGPULimits(limits).maxStorageBuffersPerShaderStage,limits.maxStorageBuffersPerShaderStage);
});
test('default accounting has no fixed 4GiB cap; explicit budgets preserve replacement headroom',()=>{
 const unbounded=createGPUMemoryBudget();const token=unbounded.reserve(8*1024**3,'logical reservation');
 assert.equal(unbounded.snapshot.enabled,false);assert.equal(unbounded.snapshot.budgetBytes,null);unbounded.release(token);
 const b=createGPUMemoryBudget({budgetBytes:1000,reserveBytes:100}),old=b.reserve(400,'old image');
 assert.throws(()=>b.assertAdditional(501,'replacement'),/预算不足/);const next=b.reserve(500,'replacement');assert.equal(b.snapshot.peakEstimatedBytes,1000);
 b.release(old);assert.equal(b.release(old),false);b.release(next);assert.equal(b.snapshot.managedBytes,0);
 assert.throws(()=>createGPUMemoryBudget({budgetBytes:100,reserveBytes:100}),/budget/);
});
test('interop rolls back allocation, upload and readback failures without retaining managed bytes',async t=>{
 const usage=globalThis.GPUBufferUsage;globalThis.GPUBufferUsage={STORAGE:1,UNIFORM:2,COPY_DST:4,COPY_SRC:8,MAP_READ:16};t.after(()=>{if(usage)globalThis.GPUBufferUsage=usage;else delete globalThis.GPUBufferUsage;});
 let failCreate=false,failUpload=false,destroyed=0;
 const device={limits,lost:new Promise(()=>{}),queue:{writeBuffer(){if(failUpload)throw Error('upload');}},
  createBuffer({size}){if(failCreate)throw Error('allocation');return {size,mapState:'unmapped',destroy(){destroyed++;}};},
  createCommandEncoder(){throw Error('encoder');}};
 const renderer={backend:{isWebGPUBackend:true,device,get(){}}};
 const interop=createGPUInterop(renderer,{memoryBudget:{budgetBytes:1000,reserveBytes:100}});
 failCreate=true;assert.throws(()=>interop.storage(16,'failure'),/allocation/);assert.equal(interop.memoryBudget.snapshot.managedBytes,0);
 failCreate=false;failUpload=true;assert.throws(()=>interop.storage(new Uint8Array(16),'upload'),/upload/);assert.equal(interop.liveBuffers,0);
 failUpload=false;const original=interop.storage(16,'valid');await assert.rejects(interop.readBuffer(original,16),/encoder/);
 assert.equal(interop.liveBuffers,1);assert.equal(interop.memoryBudget.snapshot.managedBytes,16);assert.ok(destroyed>=2);
 interop.dispose();assert.equal(interop.memoryBudget.snapshot.managedBytes,0);
});
