/** Strip optional bindings before automatic pipeline layouts are reflected.
 * Accept repository sources with LF, Windows CRLF, and a final line without EOL.
 */
export function stripWorkCounting(source) {
  return source.replace(/\/\/ WORK-COUNTING-BEGIN[^\r\n]*\r?\n[\s\S]*?\/\/ WORK-COUNTING-END(?:\r?\n|$)/g, '');
}

export function specializeIntegrator(source,c){
  for(const [name,value] of Object.entries({SAMPLE_GROUP_X:c.sampleX,SAMPLE_GROUP_Y:c.sampleY,SAMPLE_GROUP_THREADS:c.sampleX*c.sampleY})){
    const pattern=new RegExp(`const ${name}:u32=\\d+u;`);
    if(!pattern.test(source))throw new Error(`Missing shader specialization ${name}`);
    source=source.replace(pattern,`const ${name}:u32=${value}u;`);
  }
  return source;
}

export function specializeStatistics(source,c){
  return source.replace(/const STATISTICS_THREADS:u32=\d+u;/,`const STATISTICS_THREADS:u32=${c.statisticsThreads}u;`)
    .replace(/const STATISTICS_PIXELS:u32=\d+u;/,`const STATISTICS_PIXELS:u32=${c.statisticsPixels}u;`);
}
