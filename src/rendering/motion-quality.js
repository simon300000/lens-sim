/** Adaptive raster resolution while the camera moves.
 * Queue completion latency includes both GPU work and main-thread delivery.
 * Use it as an end-to-end pressure signal, not a GPU execution timer. Lower
 * resolution only during interaction; restore the base ratio after settling.
 * Keep the learned motion level for the next gesture, and stop querying the
 * queue at the resolution floor because no further decision is possible.
 */
export function createMotionQuality({renderer,queue,baseRatio,viewport=()=>({width:innerWidth,height:innerHeight}),levels=[1,.85,.7,.5],minPixelRatio=.75,lowerAboveMs=17,sampleCount=5,rampFrames=6,holdMs=400,now=()=>performance.now(),onChange=()=>{}}){
  let level=0,rememberedLevel=0,interacting=false,pending=0,lastChange=-Infinity,disposed=false,submitted=0;
  const samples=[];
  const ratioAt=index=>Math.max(Math.min(baseRatio,minPixelRatio),baseRatio*levels[index]);
  function apply(next){
    if(next===level||ratioAt(next)===ratioAt(level))return;
    level=next;if(next>0)rememberedLevel=next;samples.length=0;lastChange=now();
    renderer.setPixelRatio(ratioAt(level));
    const size=viewport();renderer.setSize(size.width,size.height);
    onChange(level,renderer.getPixelRatio());
  }
  return {
    get level(){return level;},
    get pixelRatio(){return ratioAt(level);},
    /** Restore full quality in the same update that settles the camera. Keep
     * the learned motion ratio ready for the next gesture. */
    setInteracting(value){
      value=Boolean(value);if(value===interacting)return;
      interacting=value;samples.length=0;submitted=0;
      if(value&&rememberedLevel>0)apply(rememberedLevel);
      if(!value)apply(0);
    },
    /** A raster frame was submitted while interacting: sample its queue completion latency.
     * The first frames after idle are slow while the GPU leaves its idle clock; they are not samples. */
    frameSubmitted(){
      if(!interacting||disposed||pending>=2||level>=levels.length-1||ratioAt(level+1)===ratioAt(level))return;
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
    setBaseRatio(ratio){baseRatio=ratio;level=0;rememberedLevel=0;samples.length=0;},
    dispose(){if(disposed)return;disposed=true;interacting=false;if(level)apply(0);},
  };
}
