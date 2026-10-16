import * as THREE from 'three/webgpu';
import {convertToTexture,texture,screenUV,vec4} from 'three/tsl';

/** Prepare the shared normal/GTAO/denoise graph once before beauty, then give
 * every PBR material a plain GPU texture sample. Embedding the RTT graph in
 * each material reruns its setup and invalidates GTAO while compiling batches. */
export function createRasterAO(renderer,denoised){
  const result=convertToTexture(denoised);
  const pipeline=new THREE.RenderPipeline(renderer);
  pipeline.outputNode=vec4(result.sample(screenUV).r);
  const target=new THREE.RenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false});
  target.texture.name='AO dependency preparation';
  return {
    texture:result.value,
    sample:texture(result.value,screenUV).r,
    prepare(){
      const previous=renderer.getRenderTarget(),mrt=renderer.getMRT();
      try{renderer.setMRT(null);renderer.setRenderTarget(target);pipeline.render();}
      finally{renderer.setMRT(mrt);renderer.setRenderTarget(previous);}
    },
    dispose(){pipeline.dispose();target.dispose();},
  };
}
