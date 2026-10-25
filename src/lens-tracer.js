import {createGPUInterop} from './rendering/gpu-interop.js';
import {createOpticalEngine} from './rendering/optical-engine.js';
import {createSceneBVH} from './rendering/scene-bvh.js';
import {requiredGPULimits} from './rendering/gpu-policy.js';
import {providerResources} from './rendering/radiance-provider.js';
import {createFocusSolver} from './optics/focus-solver.js';
import {apertureLimits} from './optics/lens-state.js';
import {frontElement,exitFootprint} from './optics/front-element.js';

/** GPU limits a host passes to adapter.requestDevice({requiredLimits}) for the
 * tracer with the given radiance provider (garden resources by default). */
export function requiredLimits(adapterLimits,{provider}={}){
  return requiredGPULimits(adapterLimits,provider?{resources:providerResources(provider)}:undefined);
}

/** Embeddable real-lens tracer: no DOM, no window, no fixed URLs, no rendering
 * framework. The host owns the GPUDevice (request it with requiredLimits()) and
 * supplies the radiance provider; geometry comes as a scene source
 * (scene/scene-source.js) when the provider traces the BVH.
 *
 *   createLensTracer({ device | interop, provider, width = 960, sensorMm = [36, 24],
 *     outputFormat = 'rgba16float', workers = { bvh, pupil, focus }, memoryBudget, scene, ...engine options })
 *
 * workers.* is undefined (bundled module workers), false (run inline) or a
 * () => Worker factory. `interop` (three-interop.js createThreeInterop) replaces
 * `device` when the host wants three textures for the output image. */
export async function createLensTracer({device,interop,provider,width=960,sensorMm=[36,24],outputFormat='rgba16float',workers={},memoryBudget,scene,chunkTiming='queue',...engineOptions}){
  if(!provider)throw new TypeError('createLensTracer needs a radiance provider');
  interop??=createGPUInterop(device,{memoryBudget,resources:providerResources(provider)});
  const bvh=scene??createSceneBVH({interop,worker:workers.bvh});
  const engine=await createOpticalEngine({interop,sceneResources:bvh,provider,width,aspect:sensorMm[0]/sensorMm[1],outputFormat,chunkTiming,workers,...engineOptions});
  const solver=createFocusSolver({worker:workers.focus});
  let baseLens=null,state={sensorMm,dispersion:true},origin=[0,0,0],pose=null,disposed=false;
  const writePose=()=>{if(!pose)return;const p=Float64Array.from(pose);p[12]-=origin[0];p[13]-=origin[1];p[14]-=origin[2];engine.setPose(p);};
  // stale(): the host's own cancellation check; a stale request changes nothing and resolves to null.
  async function applyLens(lens,next,stale){
    await engine.prepareLens(lens,next);if(disposed)throw new Error('Lens tracer disposed');
    if(stale?.())return null;
    return engine.setLens(lens,next);
  }
  const tracer={
    interop,engine,scene:bvh,
    /** The resolved display image (GPUTexture, outputFormat): clamped linear sRGB of the mean. */
    get outputTexture(){return engine.outputGPU;},
    /** {gpu, texture?}: texture is the host adapter's wrapper (e.g. a three StorageTexture). */
    get outputImage(){return {gpu:engine.outputGPU,texture:engine.texture};},
    get dimensions(){return engine.dimensions;},get spp(){return engine.spp;},get progress(){return engine.progress;},
    /** spp traced, including held ray batches that are not yet accumulated (rayBatch hold). */
    get tracedSpp(){return engine.tracedSpp;},
    get lens(){return engine.lens;},get baseLens(){return baseLens;},get packed(){return engine.packed;},get provider(){return engine.provider;},
    get origin(){return [...origin];},get opticsState(){return {...state};},
    /** prescription: a lens configuration (lens-library.js prescription()). state:
     * {fNumber, sensorZMm, sensorMm, dispersion, pupilSampling}; omitted fields keep
     * their previous values (fNumber/sensorZMm reset to the prescription's). */
    async setLens(prescription,{fNumber,sensorZMm=prescription.sensorZMm,...rest}={},{stale}={}){
      const next={...state,...rest,fNumber,sensorZMm};
      const packed=await applyLens(prescription,next,stale);if(!packed)return null;
      baseLens=prescription;state={...next,fNumber:packed.fNumber};return packed;
    },
    /** Aperture, sensor position or dispersion of the current lens; no recompile. */
    updateOptics(patch){state={...state,...patch};const packed=engine.updateOptics(state);state.fNumber=packed.fNumber;return packed;},
    /** Focus the base prescription at distanceM (null = infinity) with the same
     * search as lens-sim (focus table, moving groups or the sensor), keeping the
     * physical stop radius. trim: the focus methods given the contrast trim
     * (focus-search.js; default: plane-search only). Resolves to the solver
     * result plus the new f-number. */
    async focus(distanceM,{stale,trim}={}){
      if(!baseLens)throw new Error('setLens before focus');
      const packed=engine.packed;
      const moved=await solver.solve(baseLens,distanceM,{currentLens:{...engine.lens,sensorZMm:packed.sensorZMm},stopRadiusMm:packed.stopRadiusMm,dispersion:state.dispersion,...(trim?{trim}:{})});
      if(disposed)throw new Error('Lens tracer disposed');if(stale?.())return null;
      const limits=apertureLimits(moved.lens);
      const fNumber=Math.max(limits.minFNumber,Math.min(limits.maxFNumber,Math.abs(limits.focalLengthMm*limits.pupilMagnification)/(2*packed.stopRadiusMm)));
      const next={...state,fNumber,sensorZMm:moved.lens.sensorZMm};
      if(!await applyLens(moved.lens,next,stale))return null;state=next;
      return {...moved,fNumber,limits};
    },
    /** AF-S: the reference chief ray against the scene BVH (first opaque surface), then focus. */
    async autofocus(){
      const target=await engine.referenceTarget();
      const result=await tracer.focus(target.infinity?null:target.distanceM);
      return {...result,target};
    },
    referenceTarget:()=>engine.referenceTarget(),
    /** cameraToWorld: column-major 4x4, world metres (the tracer subtracts its origin in f64). */
    setPose(cameraToWorld){pose=Array.prototype.slice.call(cameraToWorld,0,16);writePose();},
    /** Recentre the world frame at origin (f64): scene transforms and the pose are
     * expressed relative to it, so rays near a far-away camera keep f32 precision.
     * Providers receive positions in this recentred frame. */
    async setOrigin(next){origin=[...next];writePose();await bvh.setOrigin(origin);},
    /** Build/upload a scene source (scene/scene-source.js); resolves to {stats, instances}. */
    setScene(source,options){return bvh.setScene(source,options);},
    setRadianceProvider:next=>engine.setRadianceProvider(next),
    sample:options=>engine.sample(options),
    /** Sample until targetSpp is reached (or signal aborts), yielding to the queue between chunks. */
    async render({targetSpp=64,batchSpp=4,seed=1,signal=null,onProgress=null,diagnostic='beauty'}={}){
      while(engine.spp<targetSpp){
        if(signal?.aborted)throw signal.reason??new DOMException('Render aborted','AbortError');
        if(!engine.sample({batchSpp,targetSpp,seed,diagnostic}))break;
        await interop.device.queue.onSubmittedWorkDone();onProgress?.(engine.progress);
      }
      return engine.spp;
    },
    /** Ray cache (ray providers): trace a batch of S spp into GPU packets and bin the
     * rays by exit point into grid x grid cells over the exit disk (rotated and
     * jittered per batch). Resolves to { spp, rays, cells: [{ index, count,
     * centroidMm, originWorld, exitBoundsMm, directionMin/Max (lens space),
     * parallaxResidualMm }], resolve(k), finish() } or null when targetSpp is reached.
     * Between rayBatch and finish the host renders a view per non-empty cell
     * (e.g. from originWorld), updates the provider's resources and calls
     * resolve(k); finish() accumulates every attempt as the direct path does.
     * hold: the batch keeps its own buffers until finish(), so several batches can
     * wait for views (finish them in trace order; retry(k) resolves deferred rays
     * again; resolve() then displays the resolved part). An exhausted cache budget or
     * device memory throws an error with code 'ray-cache-memory'. band: a sensor band
     * of engine.setBands() (with hold).
     * options: { spp = 16, targetSpp, seed, grid = 4, memoryBytes = 512 MiB (one batch), rotation, jitter, radiusMm, hold, band } */
    rayBatch:options=>engine.rayBatch(options),
    /** rayBatch loop until targetSpp: renderCell(cell, batch) prepares the provider
     * for one cell (may be async); resolves to the per-batch statistics. */
    async renderCached({targetSpp=64,renderCell,signal=null,onBatch=null,...options}={}){
      if(!(targetSpp>0))throw new RangeError("renderCached needs a positive targetSpp");
      const stats=[];
      for(;;){
        if(signal?.aborted)throw signal.reason??new DOMException('Render aborted','AbortError');
        const batch=await engine.rayBatch({...options,targetSpp});if(!batch)break;
        for(const cell of batch.cells)if(cell.count){await renderCell?.(cell,batch);batch.resolve(cell.index);}
        stats.push(batch.finish());onBatch?.(stats.at(-1));
        await interop.device.queue.onSubmittedWorkDone();
      }
      return stats;
    },
    resolve:diagnostic=>engine.resolve(diagnostic),
    reset:()=>engine.reset(),
    resize:nextWidth=>engine.resizeChecked(nextWidth),
    statistics:()=>engine.statistics(),
    /** Float linear export of the accumulation: {width, height, space, spp, data: Float32Array RGBA}. */
    readHDR:options=>engine.readHDR(options),
    /** readHDR of image rows [y, y + rows) only (streaming exports). */
    readHDRRows:options=>engine.readHDRRows(options),
    /** Object-side geometry of the current lens (lens space, mm). */
    frontElement(){if(!engine.lens)throw new Error('setLens first');return frontElement(engine.lens);},
    /** Where rays of the current lens/stop leave the front element (CPU trace, lens space mm). */
    exitFootprint(options){if(!engine.lens)throw new Error('setLens first');return exitFootprint(engine.lens,engine.packed,options);},
    dispose(){disposed=true;solver.dispose();engine.dispose();if(!scene)bvh.dispose();},
  };
  return tracer;
}

export {createGPUInterop} from './rendering/gpu-interop.js';
export {createSceneBVH} from './rendering/scene-bvh.js';
export {PROVIDER_BINDING_BASE,PROVIDER_KINDS,createConstantRayProvider} from './rendering/radiance-provider.js';
export {SIDE,INSTANCE_FLAGS} from './scene/scene-source.js';
export {createLensLibrary} from './optics/lens-library.js';
