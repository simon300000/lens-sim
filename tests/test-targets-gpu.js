import * as THREE from 'three/webgpu';
import {uv,vec2,vec4,uniform,wgslFn} from 'three/tsl';
import {TEST_CHART_WGSL} from '../src/scene/test-chart-patterns.js';
import {createGPUInterop} from '../src/rendering/three-interop.js';
const report={kind:'pattern',passed:false,errors:[],charts:[],userAgent:navigator.userAgent};
const renderer=new THREE.WebGPURenderer({antialias:false});await renderer.init();renderer.setSize(192,128);renderer.outputColorSpace=THREE.LinearSRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;document.body.append(renderer.domElement);
const interop=createGPUInterop(renderer),{device}=interop;device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
try{
 const W=192,H=128,kind=uniform(0,'uint'),pattern=wgslFn(TEST_CHART_WGSL),pipeline=new THREE.RenderPipeline(renderer);
 // Off-grid coordinates avoid testing undefined ownership exactly on black/white edges.
 pipeline.outputNode=vec4(pattern({coord:uv().mul(vec2(.9731,.9617)).add(vec2(.01237,.01891)),chartKind:kind}));
 const target=new THREE.RenderTarget(W,H,{type:THREE.HalfFloatType,depthBuffer:false});
 const output=interop.storageImage(W,H),params=interop.uniform(new Uint32Array(4),'Chart test kind');
 const code=TEST_CHART_WGSL+`\n@group(0) @binding(0) var<uniform> kind:vec4u;\n@group(0) @binding(1) var image:texture_storage_2d<rgba16float,write>;\n@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x>=192u||id.y>=128u){return;}let q=vec2f((f32(id.x)+0.5)/192.0,(f32(id.y)+0.5)/128.0)*vec2f(0.9731,0.9617)+vec2f(0.01237,0.01891);textureStore(image,vec2i(id.xy),vec4f(chartReflectance(q,kind.x)));}`;
 const compute=await interop.computePipeline(code,'Analytic target parity');
 const group=device.createBindGroup({layout:compute.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:params}},{binding:1,resource:output.gpu.createView()}]});
 for(let i=0;i<4;i++){
  kind.value=i;await new Promise(requestAnimationFrame);renderer.setRenderTarget(target);pipeline.render();renderer.setRenderTarget(null);
  device.queue.writeBuffer(params,0,new Uint32Array([i,0,0,0]));const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(compute);pass.setBindGroup(0,group);pass.dispatchWorkgroups(24,16);pass.end();device.queue.submit([encoder.finish()]);
  const a=await interop.readTexture(interop.texture(target.texture)),b=await interop.readTexture(output.gpu);let max=0,different=0;let dark=0,light=0;
  for(let j=0;j<a.length;j+=4){if(!Number.isFinite(a[j]+b[j]))throw Error('Nonfinite reflectance');max=Math.max(max,Math.abs(a[j]-b[j]));if(Math.abs(a[j]-b[j])>.001)different++;if(b[j]<.1)dark++;if(b[j]>.8)light++;}
  report.charts.push({kind:i,max,different,dark,light});if(different>2||dark<10||light<10)throw Error(`Raster/compute pattern mismatch: ${i}`);
 }
 if(report.errors.length)throw Error(report.errors.join(';'));report.passed=true;
}catch(error){report.error=error.message+'\n'+error.stack;}
finally{interop.dispose();renderer.dispose();window.__targetPatternReport=report;document.querySelector('#result').textContent=JSON.stringify(report,null,2);document.title=`Targets ${report.passed?'PASS':'FAIL'}`;await fetch('/__chart-report',{method:'POST',body:JSON.stringify(report)});}
