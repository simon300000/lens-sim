import {PUPIL_TABLE_BYTES} from '../optics/pupil-sampling.js';

export const DEFAULT_GPU_MEMORY_BYTES=4*1024**3;
export const DEFAULT_GPU_RESERVE_BYTES=768*1024**2;
export const DEFAULT_COMPUTE_CONFIG=Object.freeze({sampleX:8,sampleY:8,statisticsThreads:256,statisticsPixels:4096});

export function computeConfiguration(limits,options={}){
  const c={...DEFAULT_COMPUTE_CONFIG,...options};
  if(options.statisticsThreads===undefined)c.statisticsThreads=[c.statisticsThreads,...[128,64].filter(n=>n<c.statisticsThreads)].find(n=>n<=limits.maxComputeInvocationsPerWorkgroup&&n<=limits.maxComputeWorkgroupSizeX&&n*48<=limits.maxComputeWorkgroupStorageSize)??64;
  if(![8,16].includes(c.sampleX)||![8,16].includes(c.sampleY)||![64,128,256].includes(c.statisticsThreads)||
    !Number.isInteger(c.statisticsPixels)||c.statisticsPixels<c.statisticsThreads||c.statisticsPixels>16384||c.statisticsPixels%c.statisticsThreads)
    throw new RangeError('Invalid optical compute configuration');
  const needs={maxTextureDimension2D:480,maxBindGroups:1,maxBindingsPerBindGroup:22,maxUniformBuffersPerShaderStage:4,
    maxBufferSize:65536*32,maxStorageBufferBindingSize:65536*32,
    maxStorageBuffersPerShaderStage:8,maxStorageTexturesPerShaderStage:1,maxSampledTexturesPerShaderStage:6,maxSamplersPerShaderStage:2,
    maxUniformBufferBindingSize:PUPIL_TABLE_BYTES,maxComputeInvocationsPerWorkgroup:Math.max(c.sampleX*c.sampleY,c.statisticsThreads),
    maxComputeWorkgroupSizeX:Math.max(c.sampleX,c.statisticsThreads),maxComputeWorkgroupSizeY:c.sampleY,
    maxComputeWorkgroupStorageSize:c.statisticsThreads*48,maxComputeWorkgroupsPerDimension:1};
  for(const [name,minimum] of Object.entries(needs))if(!(limits[name]>=minimum))
    throw new Error(`此 GPU 无法运行镜头管线：${name} 需要 ${minimum}，设备提供 ${limits[name]??'未知'}`);
  return Object.freeze(c);
}

/** Request capacities we use; runtime validation always uses device.limits. */
export function requiredGPULimits(limits){
  const c=computeConfiguration(limits);
  return {maxTextureDimension2D:limits.maxTextureDimension2D,maxStorageBufferBindingSize:limits.maxStorageBufferBindingSize,
    maxBufferSize:limits.maxBufferSize,maxStorageBuffersPerShaderStage:Math.min(9,limits.maxStorageBuffersPerShaderStage),
    maxUniformBufferBindingSize:Math.max(PUPIL_TABLE_BYTES,Math.min(65536,limits.maxUniformBufferBindingSize)),
    maxComputeInvocationsPerWorkgroup:Math.max(c.sampleX*c.sampleY,c.statisticsThreads),
    maxComputeWorkgroupSizeX:Math.max(c.sampleX,c.statisticsThreads),maxComputeWorkgroupStorageSize:Math.max(c.statisticsThreads*48,
      limits.maxStorageBuffersPerShaderStage>=9&&limits.maxComputeWorkgroupStorageSize>=c.sampleX*c.sampleY*56?c.sampleX*c.sampleY*56:0)};
}

export function createGPUMemoryBudget({budgetBytes=DEFAULT_GPU_MEMORY_BYTES,reserveBytes=DEFAULT_GPU_RESERVE_BYTES}={}){
  if(!Number.isSafeInteger(budgetBytes)||!Number.isSafeInteger(reserveBytes)||reserveBytes<0||budgetBytes<=reserveBytes)
    throw new RangeError('GPU memory budget must exceed its untracked-resource reserve');
  const entries=new Map();let used=0,peak=reserveBytes;
  function check(bytes,label){
    if(!Number.isSafeInteger(bytes)||bytes<0)throw new RangeError('Invalid GPU allocation size');
    if(used+reserveBytes+bytes>budgetBytes)throw new Error(`GPU 估算预算不足：${label} 需 ${(bytes/1024**2).toFixed(1)} MiB，预算剩余 ${Math.max(0,(budgetBytes-reserveBytes-used)/1024**2).toFixed(1)} MiB；请选择较低分辨率。`);
  }
  return {
    assertAdditional:check,
    reserve(bytes,label){check(bytes,label);const token=Symbol(label);entries.set(token,{bytes,label});used+=bytes;peak=Math.max(peak,used+reserveBytes);return token;},
    release(token){const entry=entries.get(token);if(!entry)return false;used-=entry.bytes;entries.delete(token);return true;},
    get snapshot(){return {budgetBytes,reserveBytes,managedBytes:used,estimatedBytes:used+reserveBytes,availableBytes:budgetBytes-reserveBytes-used,peakEstimatedBytes:peak,scope:'Application-managed buffers/images plus fixed reserve; not physical VRAM residency'};},
  };
}
