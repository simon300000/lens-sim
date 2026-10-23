import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFakeDevice} from './fake-gpu.mjs';
import {gpuLimits} from './gpu-limits-fixture.mjs';
import {createLensTracer,requiredLimits,createConstantRayProvider,PROVIDER_BINDING_BASE,createLensLibrary} from '../src/lens-tracer.js';
import {createSurfaceRayProvider} from '../src/rendering/radiance-provider.js';
import {xyzToRGB} from '../src/spectral/reconstruction.js';
import {PIXEL_BYTES} from '../src/rendering/sampling-plan.js';

const lens=JSON.parse(readFileSync(new URL('../public/lenses/canon-fl-50mm-f1-8.json',import.meta.url))).configurations[0];
const inline={bvh:false,pupil:false,focus:false};
const stageLabels=passes=>passes.map(p=>p.label);

test('a raw-device tracer with a ray provider runs raygen -> provider without BVH or trace stage',async()=>{
 const device=createFakeDevice(),provider=createConstantRayProvider([.5,.25,1]);
 const tracer=await createLensTracer({device,provider,width:96,workers:inline});
 const scene=device.log.modules.find(m=>m.label.startsWith('Staged scene'));
 assert.match(scene.code,/fn rayRadiance\(ray: LensRay\) -> RayRadiance/);
 assert.match(scene.code,/sceneRadianceFromRay\(worldOrigin,worldDirection,lambda,weight,key\)/);
 assert.doesNotMatch(scene.code,/sceneNodes|stagedHits|@binding\(23\)/,'no BVH bindings or hit records in the ray scene kernel');
 assert.ok(!device.log.modules.some(m=>m.label.startsWith('Staged trace')),'no traversal kernel is compiled');
 const packed=await tracer.setLens(lens,{fNumber:2.8,dispersion:false});
 assert.equal(packed.fNumber,2.8);assert.deepEqual(tracer.dimensions,{width:96,height:64});
 assert.equal(tracer.opticsState.fNumber,2.8);
 tracer.setPose([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
 device.log.passes.length=0;
 assert.equal(tracer.sample({batchSpp:4,targetSpp:4}),true);
 assert.deepEqual(stageLabels(device.log.passes),['Staged lens batch','Staged scene batch']);
 // No hit-record scratch for ray providers.
 assert.ok(![...device.log.buffers].some(b=>b.label==='Staged: first-hit records'));
 assert.ok(tracer.frontElement().clearRadiusMm>0);
 const footprint=tracer.exitFootprint({fields:3,samples:64});
 assert.ok(footprint.passed>0&&footprint.maxRadiusMm>0&&footprint.maxRadiusMm<=footprint.front.clearRadiusMm+1e-6);
 await assert.rejects(tracer.autofocus(),/BVH/);
 tracer.dispose();
});

test('the tracer recentres the pose in f64 and requests provider-sized limits',async()=>{
 const device=createFakeDevice(),tracer=await createLensTracer({device,provider:createConstantRayProvider(),width:96,workers:inline});
 await tracer.setLens(lens,{dispersion:false});
 const far=[1,0,0,0,0,1,0,0,0,0,1,0,123456.789,10.25,-98765.4321,1];
 await tracer.setOrigin([123456,10,-98765]);tracer.setPose(far);
 const pose=tracer.engine.pose;
 assert.ok(Math.abs(pose[12]-.789)<1e-6&&Math.abs(pose[13]-.25)<1e-6&&Math.abs(pose[14]+.4321)<1e-6,'camera-relative translation keeps sub-micrometre precision');
 const ray=requiredLimits(gpuLimits,{provider:createConstantRayProvider()}),garden=requiredLimits(gpuLimits);
 assert.equal(ray.maxStorageBuffersPerShaderStage,gpuLimits.maxStorageBuffersPerShaderStage);
 assert.ok(garden.maxStorageBufferBindingSize>0);
 tracer.dispose();
});

test('readHDR returns the unclamped mean per attempted path in image row order',async()=>{
 const device=createFakeDevice(),tracer=await createLensTracer({device,provider:createConstantRayProvider(),width:96,workers:inline});
 await tracer.setLens(lens,{dispersion:false});
 const {width,height}=tracer.dimensions,tiles=[...device.log.buffers].filter(b=>b.label==='Tiled XYZ and attempted-path counters');
 assert.equal(tiles.length,1);
 // Paired band: buffer rows 0..h/2-1 are image rows from the top, the rest mirror from the bottom.
 const f=new Float32Array(tiles[0].data.buffer),u=new Uint32Array(tiles[0].data.buffer),stride=PIXEL_BYTES/4;
 const pixel=(row,x)=>row*width+x;
 const put=(bufferRow,x,xyz,n)=>{const i=pixel(bufferRow,x)*stride;f.set(xyz.map(v=>v*n),i);u[i+3]=n;};
 put(0,5,[2,3,4],8);put(height/2,7,[1e5,.5,0],2);
 const top=await tracer.readHDR({space:'xyz'}),rgb=await tracer.readHDR();
 assert.deepEqual(Array.from(top.data.subarray(pixel(0,5)*4,pixel(0,5)*4+4)),[2,3,4,8]);
 const bottom=pixel(height-1,7)*4;assert.deepEqual(Array.from(top.data.subarray(bottom,bottom+3)),[1e5,.5,0],'no half-float clamp');
 const expected=xyzToRGB([2,3,4]);for(let c=0;c<3;c++)assert.ok(Math.abs(rgb.data[pixel(0,5)*4+c]-expected[c])<1e-5);
 assert.equal(rgb.data[pixel(0,5)*4+3],1);assert.equal(rgb.space,'linear-srgb');
 tracer.dispose();
});

test('provider splice: the garden-style surface kind binds from the provider base; a surface provider can run as a ray provider',async()=>{
 const device=createFakeDevice();
 const surface={kind:'surface',label:'probe',revision:0,resources:{storageBuffers:1},
  wgsl:base=>`@group(0) @binding(${base}) var<storage,read> probeTable: array<vec4f>;
fn sceneShade(s: SceneSurface, wo: vec3f, key: u32) -> SceneShade { var o: SceneShade; o.rgb = probeTable[s.material].rgb; o.alpha = 1.0; return o; }
fn sceneEnvironmentRadiance(d: vec3f) -> vec3f { return probeTable[0].rgb; }
`,bindings:base=>[{binding:base,resource:{buffer:'table'}}]};
 const tracer=await createLensTracer({device,provider:surface,width:96,workers:inline});
 const scene=device.log.modules.find(m=>m.label.startsWith('Staged scene')).code;
 assert.match(scene,new RegExp(`@binding\\(${PROVIDER_BINDING_BASE}\\) var<storage,read> probeTable`));
 assert.match(scene,/@binding\(23\) var<storage,read> stagedHits/);assert.match(scene,/sceneRadianceFromHit/);
 assert.ok(device.log.modules.some(m=>m.label.startsWith('Staged trace')));
 for(const binding of [10,11,19])assert.doesNotMatch(scene,new RegExp(`@binding\\(${binding}\\)`),'the old garden slots are gone');
 const wrapped=createSurfaceRayProvider({provider:surface,scene:tracer.scene});
 const code=wrapped.wgsl(PROVIDER_BINDING_BASE);
 assert.match(code,/@binding\(24\) var<storage,read> sceneNodes/);assert.match(code,/@binding\(28\) var<storage,read> probeTable/);
 assert.deepEqual(wrapped.resources,{storageBuffers:5,uniformBuffers:0,sampledTextures:0,samplers:0,storageTextures:0});
 await tracer.setRadianceProvider(wrapped);
 const rayScene=device.log.modules.filter(m=>m.label.startsWith('Staged scene')).at(-1).code;
 assert.match(rayScene,/fn rayRadiance/);assert.match(rayScene,/fn sceneIntersect\(/);
 tracer.dispose();
});

test('lens library resolves assets against its base URL or serves preloaded data',async()=>{
 const requested=[];
 const fetch=url=>{requested.push(String(url));return Promise.resolve({ok:true,json:()=>Promise.resolve(String(url).endsWith('manifest.json')?{lenses:[{id:'a',supported:true,asset:'a.json'}]}:{configurations:[{id:'cfg'}],configurationStatus:[]})});};
 const library=createLensLibrary({baseUrl:'https://ghost.example/static/lenses/',fetch});
 assert.deepEqual(await library.prescription('a'),{id:'cfg'});
 assert.deepEqual(requested,['https://ghost.example/static/lenses/manifest.json','https://ghost.example/static/lenses/a.json']);
 const offline=createLensLibrary({manifest:{lenses:[]},assets:{b:{configurations:[{id:'b0'}]}},fetch:null});
 assert.deepEqual(await offline.prescription('b'),{id:'b0'});
 await assert.rejects(offline.asset('c'),/Unknown lens c/);
});
