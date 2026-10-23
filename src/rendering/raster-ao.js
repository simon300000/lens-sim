import * as THREE from 'three/webgpu';
import {convertToTexture,texture,screenUV,vec4} from 'three/tsl';

/** Prepare the shared normal/GTAO/denoise graph once before beauty, then give
 * every PBR material a plain GPU texture sample. Embedding the RTT graph in
 * each material reruns its setup and invalidates GTAO while compiling batches.
 *
 * The result texture is the one texture that bundled scene materials bind
 * (see scene/render-bundles). It therefore keeps a fixed size: the CSS size
 * at the base pixel ratio, changed only by setSize on a window resize, never
 * by the adaptive pixel ratio during navigation. A recreated texture would
 * recreate every scene bind group and force every beauty bundle to re-record.
 * It is sampled with normalized screen coordinates, so its size is free. */
export function createRasterAO(renderer,denoised,{pixelRatio=1,width=innerWidth,height=innerHeight}={}){
  // A fixed RTT size (three r186: width/height set, so no per-frame drawing-buffer resize).
  const resize=()=>{const w=Math.max(1,Math.floor(width*pixelRatio)),h=Math.max(1,Math.floor(height*pixelRatio));result.width=w;result.height=h;result.setSize(w,h);};
  const result=convertToTexture(denoised,1,1);resize();
  const pipeline=new THREE.RenderPipeline(renderer);
  pipeline.outputNode=vec4(result.sample(screenUV).r);
  const target=new THREE.RenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false});
  target.texture.name='AO dependency preparation';
  return {
    texture:result.value,
    sample:texture(result.value,screenUV).r,
    /** Window resize or a new base pixel ratio: callers must also re-record render bundles (bind groups change). */
    setSize(nextWidth,nextHeight){width=nextWidth;height=nextHeight;resize();},
    setPixelRatio(nextRatio){pixelRatio=nextRatio;resize();},
    prepare(){
      const previous=renderer.getRenderTarget(),mrt=renderer.getMRT();
      try{renderer.setMRT(null);renderer.setRenderTarget(target);pipeline.render();}
      finally{renderer.setMRT(mrt);renderer.setRenderTarget(previous);}
    },
    dispose(){pipeline.dispose();target.dispose();},
  };
}
