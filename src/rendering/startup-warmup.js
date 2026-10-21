import {renderVariantKey} from './three-interop.js';
import {lensMaterial,PROCEDURAL} from '../scene/lens-registry.js';

const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));

/** Prepare only a small batch of unseen scene variants per UI turn. Shadows
 * retain Three's caster callback. Post-processing quads, water and an AO owner
 * keep running so nested passes can expose their own pending variants.
 * All temporary partial images stay behind the loading curtain. */
export async function warmRender({renderer,scene,camera,render,budgetMs=48,onProgress=()=>{},signal}){
  const objects=new Set();scene.traverse(o=>{if(o.isMesh||o.isPoints)objects.add(o);});
  const previous=renderer.getRenderObjectFunction(),known=new Set();
  let deadline=0,pending=false,owner=null,rounds=0;
  function draw(...args){
    const [object,,passCamera,,material]=args;
    if(objects.has(object)){
      const key=renderVariantKey(renderer,args),prepared=known.has(key);
      if(!owner&&passCamera===camera&&material.isMeshStandardNodeMaterial&&!material.transparent)owner=object;
      const trigger=object===owner||lensMaterial(material)?.kind===PROCEDURAL.WATER;
      if(prepared&&!trigger)return;
      if(!prepared&&performance.now()>=deadline){pending=true;return;}
      if(previous)previous.apply(renderer,args);else renderer.renderObject(...args);
      known.add(key);return;
    }
    if(previous)previous.apply(renderer,args);else renderer.renderObject(...args);
  }
  renderer.setRenderObjectFunction(draw);
  try{
    do{
      if(signal?.aborted)throw new DOMException('Startup cancelled','AbortError');
      if(++rounds>4096)throw new Error('Render warmup failed to converge');
      pending=false;deadline=performance.now()+budgetMs;
      render();onProgress({rounds,variants:known.size});
      // Yield to input and painting, without waiting for/readback from the GPU.
      await paint();
    }while(pending);
  }finally{renderer.setRenderObjectFunction(previous);}
  render();
}
