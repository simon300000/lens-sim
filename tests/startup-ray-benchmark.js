// Run after full application startup. Uses the actual RAF/display scheduler,
// same renderer/device, full scene, default lens and fixed sample sequence.
export async function benchmarkApplication({trials=3,targetSpp=256}={}){
 const {hybrid}=window.__SANTEI__,{engine,interop,store}=hybrid;
 const visibility=[],rows=[];const record=()=>visibility.push({t:performance.now(),hidden:document.hidden,focused:document.hasFocus()});record();
 for(const event of ['visibilitychange','focus','blur'])addEventListener(event,record);
 const frame=()=>new Promise(requestAnimationFrame);
 async function complete(target){
  const deadline=performance.now()+120000,gpu=[];let last;
  while(engine.spp<target){
   if(performance.now()>deadline)throw new Error('Application render timed out');
   const state=store.getState();if(state.status!=='ready')throw new Error(state.error||'Application stopped rendering');
   const timing=engine.lastTiming;if(timing&&timing!==last){gpu.push(timing.ms);last=timing;}
   await frame();
  }
  await interop.device.queue.onSubmittedWorkDone();return gpu;
 }
 try{
  await store.dispatch('setPaused',true);await store.dispatch('setTargetSpp',16);
  await store.dispatch('setMode','lens');await store.dispatch('reset');await store.dispatch('setPaused',false);
  await complete(16);await store.dispatch('setPaused',true);
  for(let trial=0;trial<trials;trial++){
   await interop.device.queue.onSubmittedWorkDone();await frame();
   await store.dispatch('setTargetSpp',targetSpp);await store.dispatch('reset');
   const start=performance.now();await store.dispatch('setPaused',false);
   const gpu=await complete(targetSpp),wallMs=performance.now()-start;
   await store.dispatch('setPaused',true);
   // Statistics/hash readback occurs after the timed rendering, never per frame.
   const stats=await engine.statistics(),data=await engine.readAccumulation();
   const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');
   rows.push({trial,wallMs,spp:engine.spp,attempts:engine.dimensions.width*engine.dimensions.height*engine.spp,
    attemptedPerSecond:engine.dimensions.width*engine.dimensions.height*engine.spp/(wallMs/1000),gpuTimestampMs:gpu,stats,pixelAccumSHA256:hash});
  }
  // Separate raw production-kernel timing from the application's RAF/display
  // throughput. A queue fence per measured batch is intentional benchmark work.
  const kernel=[];
  engine.reset();
  for(let i=0;i<2;i++){engine.sample({batchSpp:4,targetSpp:0,seed:1});await interop.device.queue.onSubmittedWorkDone();}
  for(let trial=0;trial<trials;trial++){
    engine.reset();const batches=[];
    for(let i=0;i<16;i++){
      const start=performance.now();engine.sample({batchSpp:4,targetSpp:0,seed:1});
      await interop.device.queue.onSubmittedWorkDone();const wallMs=performance.now()-start;
      await new Promise(resolve=>setTimeout(resolve,0));
      batches.push({wallMs,gpuMs:engine.lastTiming?.ms??null});
    }
    const stats=await engine.statistics(),data=await engine.readAccumulation();
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');
    kernel.push({trial,batches,spp:engine.spp,pixelAccumSHA256:hash,stats});
  }
  const state=store.getState();
  return {rows,kernel,visibility,foreground:visibility.every(v=>!v.hidden&&v.focused),dimensions:engine.dimensions,
   lens:state.lensId,optics:state.optics,batchSpp:state.sampling.batchSpp,seed:state.sampling.seed,
   passed:visibility.every(v=>!v.hidden&&v.focused)&&rows.every(r=>r.stats.numericalErrorRate===0&&r.stats.bvhErrorRate===0&&r.stats.radianceInvalidRate===0)&&kernel.every(r=>r.stats.numericalErrorRate===0&&r.stats.bvhErrorRate===0&&r.stats.radianceInvalidRate===0)};
 }finally{for(const event of ['visibilitychange','focus','blur'])removeEventListener(event,record);await store.dispatch('setPaused',true);}
}
