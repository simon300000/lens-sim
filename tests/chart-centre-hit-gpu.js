import * as THREE from 'three/webgpu';
import source from '../src/rendering/scene-intersector.wgsl?raw';
import workCounters from '../src/rendering/work-counters.wgsl?raw';
import {createThreeInterop,cameraPose} from '../src/rendering/three-interop.js';
const report={kind:'centre-hit',passed:false,errors:[],cases:[]};let renderer,interop;
try{
 renderer=new THREE.WebGPURenderer();await renderer.init();interop=createThreeInterop(renderer);interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
 let seed=314159;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const sizes=new Float32Array([.425,.455,1.35,1.5,.5,.37,.3333,123.456,.0001,...Array.from({length:128},()=>10**(-4+7*random()))]);
 const vertices=new Float32Array(sizes.length*28);sizes.forEach((s,i)=>vertices.set([-s,s,0,0,-s,-s,0,0,s,s,0,0,-s,-s,0,0,s,-s,0,0,s,s,0,0,s,0,6,0],i*28));
 const input=interop.storage(vertices,'Independent shared-edge vertices'),output=interop.storage(sizes.length*16,'Shared-edge hits');
 const math=workCounters+source.slice(source.indexOf('struct WatertightRay'),source.indexOf('fn sceneAcceptsFace'));
 const code=`const SCENE_NO_HIT:f32=3e38;\n`+math+`\n@group(0)@binding(0)var<storage,read> vertices:array<vec4f>;@group(0)@binding(1)var<storage,read_write> results:array<vec4f>;
 fn panel(o:vec3f,base:u32)->f32{let ray=sceneWatertight(o,vec3f(0,0,-1));let a=sceneTriangle(ray,vertices[base].xyz,vertices[base+1u].xyz,vertices[base+2u].xyz,0,100);let b=sceneTriangle(ray,vertices[base+3u].xyz,vertices[base+4u].xyz,vertices[base+5u].xyz,0,100);return min(a.x,b.x);}
 @compute @workgroup_size(32)fn main(@builtin(global_invocation_id) id:vec3u){if(id.x>=arrayLength(&vertices)/7u){return;}let base=id.x*7u;let s=vertices[base+6u].x;results[id.x]=vec4f(panel(vec3f(0,0,6),base),panel(vec3f(s,s,6),base),panel(vec3f(s+0.0001,s+0.0001,6),base),s);}`;
 const pipeline=await interop.computePipeline(code,'Chart centre shared edges');const {device}=interop,group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(sizes.length/32));pass.end();device.queue.submit([encoder.finish()]);
 const values=new Float32Array(await interop.readBuffer(output,sizes.length*16));
 for(let i=0;i<sizes.length;i++)report.cases.push({halfSize:sizes[i],centre:values[i*4],vertex:values[i*4+1],outside:values[i*4+2]});
 if(report.cases.some(c=>Math.abs(c.centre-6)>1e-5||Math.abs(c.vertex-6)>1e-5||c.outside<1e30))throw Error('Shared edge or vertex hole, or false outside hit');if(report.errors.length)throw Error(report.errors.join(';'));report.passed=true;
}catch(error){report.error=error.message+'\n'+error.stack;}
finally{interop?.dispose();renderer?.dispose();document.querySelector('#result').textContent=JSON.stringify(report,null,2);document.title=`Chart centre ${report.passed?'PASS':'FAIL'}`;await fetch('/__chart-report',{method:'POST',body:JSON.stringify(report)});}
