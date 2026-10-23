import * as THREE from 'three/webgpu';
import {installActiveLightNodes} from '../src/rendering/active-lights.js';
const report={label:'active-lights-gpu',userAgent:navigator.userAgent,passed:false,errors:[],comparisons:[]};
const renderer=new THREE.WebGPURenderer({antialias:false});await renderer.init();renderer.setSize(96,64);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
renderer.backend.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
const target=new THREE.RenderTarget(96,64,{type:THREE.HalfFloatType}),camera=new THREE.PerspectiveCamera(45,1.5,.1,30);camera.position.set(3,2,4);camera.lookAt(0,.4,0);
function scene(){const s=new THREE.Scene(),sun=new THREE.DirectionalLight(0xffffff,3),lamp=new THREE.PointLight(0xff9966,10,12);sun.position.set(2,4,3);lamp.position.set(-1,2,1);sun.castShadow=lamp.castShadow=true;sun.shadow.autoUpdate=lamp.shadow.autoUpdate=false;sun.shadow.mapSize.set(128,128);lamp.shadow.mapSize.set(64,64);s.add(sun,lamp);
 const material=new THREE.MeshStandardNodeMaterial({color:0x998877,roughness:.6});const box=new THREE.Mesh(new THREE.BoxGeometry(),material);box.position.y=.5;box.castShadow=box.receiveShadow=true;s.add(box);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(6,6),material);floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;s.add(floor);return {s,sun,lamp};}
async function capture(world,sun,lamp){world.sun.intensity=sun;world.lamp.intensity=lamp;world.sun.shadow.needsUpdate=sun>0;world.lamp.shadow.needsUpdate=lamp>0;await new Promise(requestAnimationFrame);renderer.setRenderTarget(target);renderer.render(world.s,camera);renderer.setRenderTarget(null);return renderer.readRenderTargetPixelsAsync(target,0,0,96,64);}
let uninstall;
try{
 const original=scene(),cases=[[0,0],[3,0],[0,10],[3,10],[0,0]],reference=[];
 // Initialize native shadow attachments once before disabling their updates.
 await capture(original,3,10);for(const [sun,lamp]of cases)reference.push(await capture(original,sun,lamp));
 uninstall=installActiveLightNodes(renderer);const active=scene();await capture(active,3,10);
 for(let i=0;i<cases.length;i++){const result=await capture(active,...cases[i]);let max=0,different=0;for(let j=0;j<result.length;j++){const d=Math.abs(THREE.DataUtils.fromHalfFloat(result[j])-THREE.DataUtils.fromHalfFloat(reference[i][j]));max=Math.max(max,d);if(d)different++;}report.comparisons.push({sun:cases[i][0],lamp:cases[i][1],max,different});if(max>1e-3)throw Error(`Lighting changed: ${max}`);}
 if(report.errors.length)throw Error(report.errors.join('; '));report.passed=true;
}catch(error){report.error=String(error);}
finally{uninstall?.();target.dispose();renderer.dispose();document.querySelector('#result').textContent=JSON.stringify(report,null,2);document.title=`Active lights ${report.passed?'PASS':'FAIL'}`;await fetch('/__raster-report',{method:'POST',body:JSON.stringify(report)});}
