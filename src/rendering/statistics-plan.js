/** Fixed-size image blocks bound serial work per invocation. The second pass
 * reduces only their 48-byte totals. Sampling workgroup geometry is unchanged. */
export const STATISTICS_PIXELS = 4096;
export function statisticsConfiguration(limits) {
  const threads=[256,128,64].find(n=>n<=limits.maxComputeInvocationsPerWorkgroup&&n<=limits.maxComputeWorkgroupSizeX&&n*48<=limits.maxComputeWorkgroupStorageSize);
  if(!threads)throw new Error('GPU statistics requires 64 threads and 3072 bytes of workgroup storage');
  return {threads,pixels:STATISTICS_PIXELS};
}
export function specializeStatistics(source,{threads,pixels}) {
  if(!source.includes('const STATISTICS_THREADS:u32=256u;'))throw new Error('Statistics shader thread specialization changed');
  return source.replace('const STATISTICS_THREADS:u32=256u;',`const STATISTICS_THREADS:u32=${threads}u;`)
    .replace('const STATISTICS_PIXELS:u32=4096u;',`const STATISTICS_PIXELS:u32=${pixels}u;`);
}
