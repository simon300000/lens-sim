import * as THREE from 'three/webgpu';
import {pass,mrt,normalView,vec4,builtinAOContext,screenUV,uniform,convertToTexture} from 'three/tsl';
import {ao} from 'three/addons/tsl/display/GTAONode.js';
import {denoise} from 'three/addons/tsl/display/DenoiseNode.js';
import {bloom} from 'three/addons/tsl/display/BloomNode.js';
import {buildSanteiScene} from '../src/scene/santei-scene.js';
import {createDaylight} from '../src/lighting.js';
import {displayOutputNode,probeHDRCanvas,outputRendererOptions} from '../src/hdr-output.js';
const out=document.querySelector('#result'),rows=[],errors=[];
function report(data){out.textContent=JSON.stringify(data,null,2);document.body.dataset.status=data.status;if(typeof data.passed==='boolean')document.body.dataset.passed=String(data.passed);}
const raf=()=>new Promise(requestAnimationFrame);
let r,daylight,pipeline;
try{
 const adapter=await navigator.gpu.requestAdapter();const hdr=await probeHDRCanvas(adapter);
 r=new THREE.WebGPURenderer({antialias:true,...outputRendererOptions(hdr.supported)});await r.init();
 r.setPixelRatio(1);r.setSize(960,640);r.shadowMap.enabled=true;r.shadowMap.type=THREE.PCFShadowMap;r.toneMapping=THREE.NoToneMapping;r.outputColorSpace=THREE.SRGBColorSpace;document.body.appendChild(r.domElement);
 const d=r.backend.device;d.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 let created=0;
 const labels=[];for(const name of ['createRenderPipeline','createRenderPipelineAsync']){const original=d[name].bind(d);d[name]=(...args)=>{created++;labels.push(args[0]?.label);return original(...args);};}
 const sceneParts=buildSanteiScene(),{scene,details}=sceneParts;
 const camera=new THREE.PerspectiveCamera(40,1.5,.15,450);camera.position.set(21,13,27);camera.lookAt(0,2.7,2);
 daylight=createDaylight(scene,r,{details});const exposure=uniform(1);
 const pre=pass(scene,camera,{type:THREE.HalfFloatType,samples:0});pre.setMRT(mrt({output:normalView}));
 const normal=pre.getTextureNode('output'),depth=pre.getTextureNode('depth');
 const scenePass=pass(scene,camera,{type:THREE.HalfFloatType});scenePass.renderTarget.texture.colorSpace=THREE.LinearSRGBColorSpace;
 const beauty=scenePass.getTextureNode('output'),ambient=ao(depth,normal,camera);ambient.resolutionScale=.5;ambient.radius.value=.45;ambient.thickness.value=.8;ambient.samples.value=8;
 const smooth=denoise(ambient.getTextureNode(),depth,normal,camera);scenePass.contextNode=builtinAOContext(convertToTexture(smooth).sample(screenUV).r);
 const glare=bloom(beauty.mul(exposure),.1,.25,1.8);pipeline=new THREE.RenderPipeline(r);pipeline.outputNode=displayOutputNode(vec4(beauty.rgb.add(glare.rgb.div(exposure)),beauty.a),exposure,hdr.supported);
 for(const hour of [0,5.5,16.5,12,5.5,12,5.5,0,18,12,12.1,12.2]){
  await raf();await d.queue.onSubmittedWorkDone();
  const row={hour,hidden:document.hidden,focused:document.hasFocus()};const before=created,start=performance.now();
  daylight.update({hour,date:'2026-09-26'});exposure.value=r.toneMappingExposure;row.daylightMs=performance.now()-start;
  const submit=performance.now();pipeline.render();row.submitMs=performance.now()-submit;
  await d.queue.onSubmittedWorkDone();row.wallMs=performance.now()-start;row.pipelines=created-before;if(row.pipelines&&rows.length>=3)row.labels=labels.slice(-row.pipelines);rows.push(row);report({status:'running',rows,errors});
  // three r186 finishes some pass pipelines (GTAO, its RTT) a few frames after first
  // use; the startup warm-up likewise renders until no new variants appear.
  if(rows.length===3)for(let i=0;i<16;i++){const known=created;await raf();pipeline.render();await d.queue.onSubmittedWorkDone();if(created===known)break;}
 }
 const measured=rows.slice(3);
 if(measured.some(row=>row.pipelines!==0))throw new Error('Time changes recreated render pipelines after startup warmup');
 if(errors.length)throw new Error(errors.join('\n'));
 report({status:'complete',passed:true,rows,errors,userAgent:navigator.userAgent});
}catch(e){report({status:'error',passed:false,error:String(e),rows,errors});}

finally{pipeline?.dispose();daylight?.dispose();r?.dispose();}
