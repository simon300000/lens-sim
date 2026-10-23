import {buildPupilTable,cachedPupilTable,cachePreparedPupilTable} from './pupil-sampling.js';

/** Pure CPU physical tracing. The worker owns no GPU device and returns only
 * the proposal table/diagnostics, transferring its 32 KiB uniform once.
 * worker: undefined = the bundled module worker, false = run inline,
 * () => Worker = a host-provided worker running pupil-worker.js. */
export const defaultPupilWorker=()=>new Worker(new URL('./pupil-worker.js',import.meta.url),{type:'module',name:'lens-pupil'});
export function createPupilPrecomputer({worker:factory}={}){
  const useWorker=factory!==false;
  let worker=null,nextId=0,disposed=false;
  const pending=new Map();
  function fail(error){for(const p of pending.values())p.reject(error);pending.clear();worker?.terminate();worker=null;}
  function ensureWorker(){
    if(worker)return worker;
    worker=(factory||defaultPupilWorker)();
    worker.onmessage=({data})=>{
      const p=pending.get(data.id);if(!p)return;pending.delete(data.id);
      if(!data.ok){p.reject(new Error(data.error));return;}
      try{p.resolve(cachePreparedPupilTable(p.lens,p.packed,p.options,data.table));}catch(error){p.reject(error);}
    };
    worker.onerror=event=>fail(new Error(event.message||'Pupil worker failed'));
    worker.onmessageerror=()=>fail(new Error('Pupil worker result could not be decoded'));
    return worker;
  }
  return {
    async prepare(lens,packed,options={}){
      if(disposed)throw new Error('Pupil precomputer disposed');
      const cached=cachedPupilTable(lens,packed,options);if(cached)return cached;
      if(!useWorker||typeof Worker==='undefined')return buildPupilTable(lens,packed,options);
      const active=ensureWorker(),id=++nextId;
      return new Promise((resolve,reject)=>{
        pending.set(id,{lens,packed,options,resolve,reject});
        // Do not send the spectral LUT, GPU buffers or previously rendered pixels.
        const physical={parameters:packed.parameters,sensorZMm:packed.sensorZMm,stopRadiusMm:packed.stopRadiusMm,region:packed.region};
        try{active.postMessage({id,lens,packed:physical,options});}catch(error){pending.delete(id);reject(error);}
      });
    },
    dispose(){disposed=true;fail(new Error('Pupil precomputer disposed'));},
  };
}
