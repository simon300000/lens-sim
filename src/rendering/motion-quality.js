/** Adaptive raster resolution while the camera moves.
 * Queue completion latency includes both GPU work and main-thread delivery.
 * Use it as an end-to-end pressure signal, not a GPU execution timer. Lower
 * resolution only during interaction; restore the base ratio after settling.
 */
export function createMotionQuality({renderer,queue,baseRatio,viewport=()=>({width:innerWidth,height:innerHeight}),levels=[1,.85,.7],lowerAboveMs=17,sampleCount=5,rampFrames=6,holdMs=400,restoreDelayMs=1500,timers=globalThis,now=()=>performance.now(),onChange=()=>{}}){
  let level=0,interacting=false,pending=0,lastChange=-Infinity,disposed=false,submitted=0,restoreTimer=null;
  const samples=[];
  function apply(next){
    if(next===level)return;
    level=next;samples.length=0;lastChange=now();
    renderer.setPixelRatio(baseRatio*levels[level]);
    const size=viewport();renderer.setSize(size.width,size.height);
    onChange(level,renderer.getPixelRatio());
  }
  return {
    get level(){return level;},
    get pixelRatio(){return baseRatio*levels[level];},
    /** Input started or settled (camera rig start/end). Full quality returns once the
     * camera has rested for restoreDelayMs: a series of short mouse drags keeps the
     * chosen level instead of reallocating every target on each press and release. */
    setInteracting(value){
      value=Boolean(value);if(value===interacting)return;
      interacting=value;samples.length=0;submitted=0;
      if(restoreTimer!==null){timers.clearTimeout(restoreTimer);restoreTimer=null;}
      if(!value&&level!==0)restoreTimer=timers.setTimeout(()=>{restoreTimer=null;if(!interacting&&!disposed)apply(0);},restoreDelayMs);
    },
    /** A raster frame was submitted while interacting: sample its queue completion latency.
     * The first frames after idle are slow while the GPU leaves its idle clock; they are not samples. */
    frameSubmitted(){
      if(!interacting||disposed||pending>=2)return;
      if(++submitted<=rampFrames)return;
      pending++;const at=now();
      queue.onSubmittedWorkDone().then(()=>{
        pending--;if(disposed||!interacting)return;
        samples.push(now()-at);if(samples.length>sampleCount)samples.shift();
        if(samples.length<sampleCount||now()-lastChange<holdMs||level>=levels.length-1)return;
        const sorted=[...samples].sort((a,b)=>a-b);
        if(sorted[sampleCount>>1]>lowerAboveMs)apply(level+1);
      },()=>{pending--;});
    },
    /** The user picked another base ratio (raster quality settings); the caller resizes the renderer. */
    setBaseRatio(ratio){baseRatio=ratio;level=0;samples.length=0;},
    dispose(){if(disposed)return;disposed=true;interacting=false;if(restoreTimer!==null){timers.clearTimeout(restoreTimer);restoreTimer=null;}if(level)apply(0);},
  };
}
