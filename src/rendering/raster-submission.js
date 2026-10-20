/** Bound raster submissions without waiting on the browser's synchronous
 * canvas backpressure. Two frames retain CPU/GPU overlap; further requests
 * coalesce and render the latest camera after a completion frees capacity.
 * Every submission runs in a task so pending pointer input can arrive first. */
export function createRasterSubmission({queue,render,canSubmit=()=>true,maxInFlight=2,schedule=fn=>setTimeout(fn,0),cancel=clearTimeout}){
  let inFlight=0,requested=false,task=null,disposed=false;
  function cancelPending(){
    requested=false;
    if(task!==null){cancel(task);task=null;}
  }
  function schedulePending(){
    if(disposed||!requested||inFlight>=maxInFlight||task!==null)return;
    task=schedule(pump);
  }
  function pump(){
    task=null;
    if(disposed||!requested)return;
    if(!canSubmit()){requested=false;return;}
    if(inFlight>=maxInFlight)return;
    requested=false;
    render();
    inFlight++;
    queue.onSubmittedWorkDone().then(()=>{
      inFlight--;
      schedulePending();
    },()=>{
      inFlight--;
      // A lost/rejected queue must not launch more work from its completion.
      cancelPending();
    });
  }
  return {
    request(){if(disposed)return;requested=true;schedulePending();},
    cancel:cancelPending,
    dispose(){disposed=true;cancelPending();},
  };
}
