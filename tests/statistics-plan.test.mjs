import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {statisticsConfiguration,specializeStatistics} from '../src/rendering/statistics-plan.js';
test('statistics independently adapts to effective workgroup invocation and storage limits',()=>{
 const limits={maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxComputeWorkgroupStorageSize:16384};
 assert.equal(statisticsConfiguration(limits).threads,256);
 assert.equal(statisticsConfiguration({...limits,maxComputeWorkgroupStorageSize:8192}).threads,128);
 assert.equal(statisticsConfiguration({...limits,maxComputeInvocationsPerWorkgroup:64}).threads,64);
 assert.throws(()=>statisticsConfiguration({...limits,maxComputeWorkgroupStorageSize:2048}),/statistics requires/);
});
test('partial and final statistics passes specialize the same reduction width',()=>{
 const config={threads:128,pixels:4096};
 for(const f of ['statistics.wgsl','statistics-reduce.wgsl']){
  const text=specializeStatistics(readFileSync(new URL('../src/rendering/'+f,import.meta.url),'utf8'),config);
  assert.match(text,/STATISTICS_THREADS:u32=128u/);assert.doesNotMatch(text,/STATISTICS_THREADS:u32=256u/);
 }
 assert.throws(()=>specializeStatistics('changed',config),/specialization changed/);
});
