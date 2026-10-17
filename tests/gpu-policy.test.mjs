import test from 'node:test';
import assert from 'node:assert/strict';
import {computeConfiguration,requiredGPULimits,createGPUMemoryBudget} from '../src/rendering/gpu-policy.js';
import {specializeIntegrator,specializeStatistics} from '../src/rendering/shader-variants.js';
import {readFileSync} from 'node:fs';

const limits={maxTextureDimension2D:16384,maxBindGroups:4,maxBindingsPerBindGroup:1000,maxUniformBuffersPerShaderStage:12,
 maxStorageBuffersPerShaderStage:10,maxStorageTexturesPerShaderStage:4,maxSampledTexturesPerShaderStage:16,maxSamplersPerShaderStage:16,
 maxUniformBufferBindingSize:65536,maxComputeInvocationsPerWorkgroup:1024,maxComputeWorkgroupSizeX:1024,maxComputeWorkgroupSizeY:1024,
 maxComputeWorkgroupStorageSize:32768,maxComputeWorkgroupsPerDimension:65535,maxBufferSize:2**31-4,maxStorageBufferBindingSize:2**31-4};

test('capability checks use effective limits, choose compatible statistics groups and reject unsupported bindings',()=>{
 assert.equal(computeConfiguration(limits).statisticsThreads,256);
 assert.equal(computeConfiguration({...limits,maxComputeInvocationsPerWorkgroup:128}).statisticsThreads,128);
 assert.throws(()=>computeConfiguration({...limits,maxStorageBuffersPerShaderStage:7}),/maxStorageBuffersPerShaderStage/);
 assert.throws(()=>computeConfiguration({...limits,maxUniformBufferBindingSize:16384}),/maxUniformBufferBindingSize/);
 assert.throws(()=>computeConfiguration({...limits,maxComputeInvocationsPerWorkgroup:128},{sampleX:16,sampleY:16}),/maxComputeInvocationsPerWorkgroup/);
 assert.throws(()=>computeConfiguration(limits,{statisticsThreads:96}),/configuration/);
 assert.equal(requiredGPULimits(limits).maxStorageBuffersPerShaderStage,9);
});

test('logical GPU budget covers replacement peaks, reserve and idempotent resource release',()=>{
 const b=createGPUMemoryBudget({budgetBytes:1000,reserveBytes:100}),old=b.reserve(400,'old image');
 assert.throws(()=>b.assertAdditional(501,'replacement'),/预算不足/);
 assert.equal(b.snapshot.managedBytes,400);
 const next=b.reserve(500,'new image');assert.equal(b.snapshot.peakEstimatedBytes,1000);
 b.release(old);assert.equal(b.snapshot.managedBytes,500);assert.equal(b.release(old),false);
 const staging=b.reserve(400,'readback');assert.throws(()=>b.reserve(1,'overflow'),/预算不足/);
 b.release(staging);b.release(next);assert.equal(b.snapshot.managedBytes,0);
 assert.throws(()=>createGPUMemoryBudget({budgetBytes:99,reserveBytes:100}),/budget/);
});

test('workgroup and statistics specialization keeps host and shader geometry explicit',()=>{
 const integrator=readFileSync(new URL('../src/rendering/optical-integrator.wgsl',import.meta.url),'utf8');
 const config=computeConfiguration(limits,{sampleX:16,sampleY:8,statisticsThreads:128,statisticsPixels:2048});
 const shader=specializeIntegrator(integrator,config);assert.match(shader,/SAMPLE_GROUP_THREADS:u32=128u/);
 const statistics=specializeStatistics(readFileSync(new URL('../src/rendering/statistics.wgsl',import.meta.url),'utf8'),config);
 assert.match(statistics,/STATISTICS_THREADS:u32=128u/);assert.match(statistics,/STATISTICS_PIXELS:u32=2048u/);
});
