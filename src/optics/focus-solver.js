/** CPU-only focus search; the renderer's GPU queue is used only for acquiring
 * the scene target, never for the subsequent lens-bench-style search. */
export function createFocusSolver(){
  let worker=null,serial=0,disposed=false;const pending=new Map();
  const fail=error=>{for(const p of pending.values())p.reject(error);pending.clear();worker?.terminate();worker=null;};
  return {
    solve(lens,distanceM,options){
      if(disposed)return Promise.reject(Error('Focus solver disposed'));
      if(!worker){
        worker=new Worker(new URL('./focus-worker.js',import.meta.url),{type:'module',name:'lens-focus'});
        worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.ok?p.resolve(data.result):p.reject(Error(data.error));};
        worker.onerror=event=>fail(Error(event.message||'Focus worker failed'));
        worker.onmessageerror=()=>fail(Error('Focus worker result could not be decoded'));
      }
      const id=++serial;
      return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});try{worker.postMessage({id,lens,distanceM,options});}catch(error){pending.delete(id);reject(error);}});
    },
    dispose(){disposed=true;fail(Error('Focus solver disposed'));},
  };
}
