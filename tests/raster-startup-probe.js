// Keep compilation API time separate from CPU pupil precomputation and warmed
// rendering. These wrappers are removed before the frame benchmarks start.
(()=>{
 const entries=[],restore=[];
 for(const name of ['createShaderModule','createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync']){
  const proto=globalThis.GPUDevice?.prototype;if(!proto?.[name])continue;const original=proto[name];
  const wrapped=function(...args){const row={name,start:performance.now()};entries.push(row);try{const value=original.apply(this,args);row.cpuMs=performance.now()-row.start;if(value?.then)value.then(()=>row.settledMs=performance.now()-row.start,()=>row.failed=true);return value;}catch(error){row.failed=true;throw error;}};
  proto[name]=wrapped;restore.push(()=>{if(proto[name]===wrapped)proto[name]=original;});
 }
 window.__rasterStartup={finish(){for(const fn of restore)fn();return entries;}};
})();
