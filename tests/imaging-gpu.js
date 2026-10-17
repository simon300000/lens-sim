import * as THREE from 'three/webgpu';
import {texture,float} from 'three/tsl';
import {createLensRig,stripedPanel,emissivePanel,focusTestLens} from './gpu-fixtures.js';
import {paraxialSensorZ} from '../src/optics/lens-state.js';
import {outputRendererOptions,probeHDRCanvas,displayOutputNode} from '../src/hdr-output.js';
const out=document.querySelector('#result'),check=(c,m)=>{if(!c)throw new Error(m);};
try{
  const adapter=await navigator.gpu.requestAdapter(),hdr=await probeHDRCanvas(adapter),errors=[];
  const renderer=new THREE.WebGPURenderer({antialias:false,...outputRendererOptions(hdr.supported)});await renderer.init();renderer.setSize(900,600);renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.appendChild(renderer.domElement);
  const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  // 24 cycles across each target, as real emissive strips (8 bright, .8 dim).
  function striped(x,z,w,h){stripedPanel(scene,{x,z,w,h,color:[7.2,7.2,7.2],stripes:24,dim:.1/.9});}
  striped(-.14,-.6,.14,.24);striped(0,-1.2,.20,.44);striped(.44,-3,.48,.9);
  function marker(x,y,z,size,rgb){emissivePanel(scene,{x,y,z,w:size,h:size,color:rgb});}
  marker(-.14,.135,-.6,.025,[16,16,.01]);marker(.44,-.5,-2.99,.1,[.01,16,16]);marker(.06,.10,-1.19,.004,[100,100,100]);
  const {interop,engine,lighting,sceneResources}=await createLensRig({renderer,scene,camera,width:240});interop.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const lens=(await(await fetch('/lenses/canon-fl-50mm-f1-8.json')).json()).configurations[0];
  engine.setLens(lens,{fNumber:2.8,sensorZMm:paraxialSensorZ(lens,1.2),dispersion:false});
  const node=texture(engine.texture),pipeline=new THREE.RenderPipeline(renderer);pipeline.outputNode=displayOutputNode(node,float(1),hdr.supported);
  const width=240,height=160,rows=[];
  function contrast(pixels,x0,x1){const column=[];for(let x=Math.round(width*x0);x<width*x1;x++){let v=0,n=0;for(let y=Math.round(height*.37);y<height*.63;y++){const i=(y*width+x)*4;v+=(pixels[i]+pixels[i+1]+pixels[i+2])/3;n++;}column.push(v/n);}const mean=column.reduce((a,b)=>a+b,0)/column.length;return Math.sqrt(column.reduce((s,v)=>s+(v-mean)**2,0)/column.length)/Math.max(1e-6,mean);}
  function markers(pixels){let yellow=[0,0,0],cyan=[0,0,0];for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];if(r>.3&&g>.3&&r>2*b&&g>2*b){yellow[0]+=x;yellow[1]+=y;yellow[2]++;}if(g>.3&&b>.3&&g>2*r&&b>2*r){cyan[0]+=x;cyan[1]+=y;cyan[2]++;}}return {yellow:{x:yellow[0]/Math.max(1,yellow[2])/width,y:yellow[1]/Math.max(1,yellow[2])/height,pixels:yellow[2]},cyan:{x:cyan[0]/Math.max(1,cyan[2])/width,y:cyan[1]/Math.max(1,cyan[2])/height,pixels:cyan[2]}};}
  for(const distance of [.6,1.2,3]){
    out.textContent=`Physical focus at ${distance} m, 512 fixed attempts per pixel…`;
    const focus=focusTestLens(engine,lens,distance);engine.setLens(focus.lens,{sensorZMm:focus.lens.sensorZMm,fNumber:2.8,dispersion:false});
    for(let i=0;i<128;i++)engine.sample({batchSpp:4,targetSpp:512,seed:43});pipeline.render();
    const pixels=await interop.readTexture(engine.outputGPU),stats=await engine.statistics();check(stats.numericalErrorRate===0,'Numerical failure in multi-depth chart');
    rows.push({focusDistanceM:distance,imageDistanceMm:focus.lens.imageDistanceMm,contrasts:[contrast(pixels,.08,.28),contrast(pixels,.42,.57),contrast(pixels,.66,.78)],markers:markers(pixels),stats,computeMs:engine.computeMs});
  }
  const improvement=rows.map((row,i)=>row.contrasts[i]/Math.max(...rows.filter((_,j)=>j!==i).map(other=>other.contrasts[i])));
  check(improvement.every(r=>r>1.02),'Different depths did not become individually sharp: '+JSON.stringify({rows,improvement}));
  const orientation=rows[1].markers;check(orientation.yellow.pixels>0&&orientation.yellow.x<.5&&orientation.yellow.y<.5&&orientation.cyan.pixels>0&&orientation.cyan.x>.5&&orientation.cyan.y>.5,'Physical sensor/image orientation failed '+JSON.stringify(orientation));
  check(lighting.refreshes===1&&sceneResources.counters.fullBuilds===1,'Focus rebuilt BVH or refreshed raster resources');check(errors.length===0,'Validation errors '+errors.join('\n'));
  const result={passed:true,environment:{userAgent:navigator.userAgent,platform:navigator.platform,deviceFeatures:[...interop.device.features],adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}},
    lens:lens.id,surfaces:lens.surfaces.length,width,height,spp:512,batchSpp:4,bloom:false,exposure:1,dispersion:false,rows,improvement,lightingRefreshes:lighting.refreshes,bvh:sceneResources.stats,
    opticalInitializationWallMs:engine.initializationMs,memoryBytes:engine.memoryBytes+sceneResources.stats.gpuBytes,errors};
  out.textContent=JSON.stringify(result,null,2);document.body.dataset.passed='true';window.__imagingTest={result,engine,interop,renderer};
}catch(error){out.textContent=error.message+'\n'+(error.stack||String(error));document.body.dataset.passed='false';console.error(error);}
