import * as THREE from 'three/webgpu';
import { vec4, float } from 'three/tsl';

export function isHDRConfiguration(configuration) {
  return configuration?.format==='rgba16float' && configuration?.toneMapping?.mode==='extended';
}

/** Probe the browser's canvas API, independently of the monitor's HDR report. */
export async function probeHDRCanvas(adapter,{createCanvas=()=>document.createElement('canvas')}={}) {
  let device,context,scoped=false;
  let result={supported:false,reason:'HDR canvas configuration is unavailable'};
  try {
    device=await adapter.requestDevice();
    device.pushErrorScope('validation');scoped=true;
    const canvas=createCanvas();canvas.width=1;canvas.height=1;
    context=canvas.getContext('webgpu');
    if(!context)throw new Error('WebGPU canvas context is unavailable');
    context.configure({device,format:'rgba16float',colorSpace:'srgb',alphaMode:'opaque',
      usage:17,toneMapping:{mode:'extended'}});
    const configuration=context.getConfiguration?.();
    const texture=context.getCurrentTexture();
    if(isHDRConfiguration(configuration)&&texture.format==='rgba16float'){
      result={supported:true,reason:'Verified extended rgba16float canvas',format:configuration.format,
        colorSpace:configuration.colorSpace||'srgb',toneMapping:configuration.toneMapping.mode};
    }else{
      result.reason='The browser did not retain extended HDR canvas configuration';
    }
  }catch(error){result={supported:false,reason:String(error.message||error)};}
  finally{
    if(scoped){
      try{const error=await device.popErrorScope();if(error)result={supported:false,reason:error.message};}
      catch(error){result={supported:false,reason:String(error.message||error)};}
    }
    try{context?.unconfigure();}catch{}
    device?.destroy();
  }
  return result;
}

export function outputRendererOptions(hdrSupported) {
  return {outputBufferType:THREE.HalfFloatType,outputType:hdrSupported?THREE.HalfFloatType:undefined};
}

/** Exposure is applied exactly once; only the SDR branch compresses highlights.
 * RenderPipeline then performs sRGB encoding once for the canvas's 'srgb' space.
 * A floating-point canvas does NOT implicitly change that transfer function. */
export function displayOutputNode(sceneLinear,exposure,hdrSupported) {
  const exposed=vec4(sceneLinear.rgb.mul(exposure).max(0),sceneLinear.a);
  return hdrSupported?exposed:exposed.toneMapping(THREE.ACESFilmicToneMapping,float(1));
}

/** Enqueue before yielding/presentation: afterwards getCurrentTexture() may be new. */
export function captureCanvasRange(renderer) {
  const {device,context}=renderer.backend;
  const texture=context.getCurrentTexture(),format=texture.format;
  const half=format==='rgba16float',bytesPerPixel=half?8:4;
  if(!half&&format!=='bgra8unorm'&&format!=='rgba8unorm')throw new Error('Unexpected canvas format: '+format);
  const width=texture.width,height=texture.height;
  const bytesPerRow=Math.ceil(width*bytesPerPixel/256)*256;
  const buffer=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const encoder=device.createCommandEncoder();
  encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow},{width,height});
  device.queue.submit([encoder.finish()]);
  return (async()=>{
    try{
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped=buffer.getMappedRange();
      const values=half?new Uint16Array(mapped):new Uint8Array(mapped);
      const rowStride=bytesPerRow/(half?2:1);
      let peak=0,minimum=Infinity,nonFinite=0,aboveWhitePixels=0;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        let above=false;
        for(let c=0;c<3;c++){
          const stored=values[y*rowStride+x*4+c];
          const v=half?THREE.DataUtils.fromHalfFloat(stored):stored/255;
          if(!Number.isFinite(v))nonFinite++;
          else{peak=Math.max(peak,v);minimum=Math.min(minimum,v);if(v>1)above=true;}
        }
        if(above)aboveWhitePixels++;
      }
      return {format,width,height,peak,minimum,nonFinite,aboveWhitePixels,encoding:'sRGB'};
    }finally{if(buffer.mapState==='mapped')buffer.unmap();buffer.destroy();}
  })();
}
