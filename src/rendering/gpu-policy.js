import {PUPIL_TABLE_BYTES} from '../optics/pupil-sampling.js';
import {statisticsConfiguration} from './statistics-plan.js';

/** Validate effective limits, without choosing vendor-specific workgroups. */
export function computeConfiguration(limits) {
  const statistics=statisticsConfiguration(limits);
  const needs={maxTextureDimension2D:480,maxBindGroups:1,maxBindingsPerBindGroup:22,maxUniformBuffersPerShaderStage:4,
    maxBufferSize:4096,maxStorageBufferBindingSize:4096,maxStorageBuffersPerShaderStage:8,maxStorageTexturesPerShaderStage:1,
    maxSampledTexturesPerShaderStage:6,maxSamplersPerShaderStage:2,maxUniformBufferBindingSize:PUPIL_TABLE_BYTES,
    maxComputeInvocationsPerWorkgroup:Math.max(64,statistics.threads),maxComputeWorkgroupSizeX:statistics.threads,
    maxComputeWorkgroupSizeY:8,maxComputeWorkgroupStorageSize:statistics.threads*48,maxComputeWorkgroupsPerDimension:1};
  for(const [name,minimum]of Object.entries(needs))if(!(limits[name]>=minimum))throw new Error(`此 GPU 无法运行镜头管线：${name} 需要 ${minimum}，设备提供 ${limits[name]??'未知'}`);
  return {sampleX:8,sampleY:8,statisticsThreads:statistics.threads,statisticsPixels:statistics.pixels};
}
export function requiredGPULimits(limits) {
  const c=computeConfiguration(limits);
  return {maxTextureDimension2D:limits.maxTextureDimension2D,maxStorageBufferBindingSize:limits.maxStorageBufferBindingSize,
    maxBufferSize:limits.maxBufferSize,maxStorageBuffersPerShaderStage:limits.maxStorageBuffersPerShaderStage,
    maxUniformBufferBindingSize:Math.max(PUPIL_TABLE_BYTES,Math.min(65536,limits.maxUniformBufferBindingSize)),
    maxComputeInvocationsPerWorkgroup:Math.max(c.statisticsThreads,Math.min(256,limits.maxComputeInvocationsPerWorkgroup)),
    maxComputeWorkgroupSizeX:Math.max(c.statisticsThreads,Math.min(256,limits.maxComputeWorkgroupSizeX)),
    maxComputeWorkgroupStorageSize:Math.max(c.statisticsThreads*48,Math.min(16384,limits.maxComputeWorkgroupStorageSize))};
}

/** Managed allocation accounting, not physical VRAM detection. Enforcement is
 * opt-in: createGPUInterop(renderer,{memoryBudget:{budgetBytes,reserveBytes}}).
 * No fixed 4 GiB cap is imposed on existing high-resolution rendering. */
export function createGPUMemoryBudget({budgetBytes=Infinity,reserveBytes=768*1024**2}={}) {
  budgetBytes??=Infinity;
  if((budgetBytes!==Infinity&&!Number.isSafeInteger(budgetBytes))||!Number.isSafeInteger(reserveBytes)||reserveBytes<0||budgetBytes<=reserveBytes)throw new RangeError('GPU memory budget must exceed its reserve');
  const entries=new Map();let used=0,peak=reserveBytes;
  function check(bytes,label){
    if(!Number.isSafeInteger(bytes)||bytes<0)throw new RangeError('Invalid GPU allocation size');
    if(used+reserveBytes+bytes>budgetBytes)throw new Error(`GPU 估算预算不足：${label} 需 ${(bytes/1024**2).toFixed(1)} MiB，预算剩余 ${Math.max(0,(budgetBytes-reserveBytes-used)/1024**2).toFixed(1)} MiB；请选择较低分辨率。`);
  }
  return {assertAdditional:check,
    reserve(bytes,label){check(bytes,label);const token=Symbol(label);entries.set(token,{bytes,label});used+=bytes;peak=Math.max(peak,used+reserveBytes);return token;},
    release(token){const entry=entries.get(token);if(!entry)return false;used-=entry.bytes;entries.delete(token);return true;},
    get snapshot(){return {enabled:Number.isFinite(budgetBytes),budgetBytes:Number.isFinite(budgetBytes)?budgetBytes:null,reserveBytes,managedBytes:used,estimatedBytes:used+reserveBytes,availableBytes:Number.isFinite(budgetBytes)?budgetBytes-reserveBytes-used:null,peakEstimatedBytes:peak,scope:'Managed buffers/images plus configurable reserve, not physical VRAM residency'};}};
}
