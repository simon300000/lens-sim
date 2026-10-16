import * as THREE from 'three/webgpu';
import {uniform,vec4} from 'three/tsl';
import {createHybridRuntime} from '../src/rendering/hybrid-runtime.js';
import {emissivePanel} from './gpu-fixtures.js';
const report={kind:'noct-runtime',passed:false,errors:[]};let renderer,runtime,raster;
try{
 renderer=new THREE.WebGPURenderer({antialias:false});await renderer.init();renderer.setSize(48,32);renderer.shadowMap.enabled=true;
 const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
 const scene=new THREE.Scene();emissivePanel(scene,{z:-5.999,w:4,h:4});
 raster=new THREE.RenderPipeline(renderer);raster.outputNode=vec4(0,0,0,1);
 runtime=await createHybridRuntime({renderer,scene,camera,rasterPipeline:raster,cameraExposure:uniform(1),hdr:{supported:false},requestFrame:()=>{}});
 runtime.interop.device.addEventListener('uncapturederror',event=>report.errors.push(event.error.message));
 await runtime.initialize();await runtime.store.dispatch('selectLens','nikon-z-58mm-f0-95-noct-s');
 await runtime.store.dispatch('autofocus');const s=runtime.store.getState();report.af=s.af;report.optics=s.optics;report.pupil=runtime.engine.pupilTable.diagnostics;
 if(s.af.status!=='success'||s.af.lastResult.method!=='cam-search'||Math.abs(s.af.lastResult.target.distanceM-5.999)>.01||s.af.lastResult.afterRmsMm>.01||Math.abs(s.optics.imageDistanceMm-1)>1e-8)throw Error('Production AF did not restore correct Noct focus');
 if(report.errors.length)throw Error(report.errors.join(';'));
 report.passed=true;
}catch(error){report.error=error.message+'\n'+error.stack;}
finally{runtime?.dispose();raster?.dispose();renderer?.dispose();document.title=`Noct runtime ${report.passed?'PASS':'FAIL'}`;document.querySelector('#result').textContent=JSON.stringify(report,null,2);await fetch('/__chart-report',{method:'POST',body:JSON.stringify(report)}).catch(()=>{});}
