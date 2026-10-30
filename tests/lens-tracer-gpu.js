import * as THREE from 'three/webgpu';
import {createLensTracer,requiredLimits,createConstantRayProvider,createLensLibrary} from '../src/lens-tracer.js';
import {createSurfaceRayProvider} from '../src/rendering/radiance-provider.js';
import {cellOf} from '../src/rendering/ray-cache.js';
import {requiredGPULimits} from '../src/rendering/gpu-policy.js';
import {cameraPose,installShadowMapInit} from '../src/rendering/three-interop.js';
import {buildSanteiScene} from '../src/scene/santei-scene.js';
import {createDaylight} from '../src/lighting.js';
import {createLensRig,focusTestLens} from './gpu-fixtures.js';
/** The embeddable tracer on the real GPU:
 *  A. a raw GPUDevice (no three.js) with a ray provider and default module workers;
 *  B. the ray cache: GPU binning checked ray by ray, and cached == direct accumulation,
 *     also with held batches (all traced before the first finish) and sensor bands;
 *  C. the garden scene: direct surface path == ray path (BVH-wrapping provider) ==
 *     ray-cache path, so the cache is validated against today's output. */
const out=document.querySelector('#result'),check=(c,m)=>{if(!c)throw new Error(m);};
const step=l=>console.log('[step] '+l+' '+performance.now().toFixed(0));
const report={passed:false,errors:[]};
function compare(a,b){
  let maxRel=0,maxAbs=0,attempts=0,sum=0;
  for(let i=0;i<a.data.length;i+=4){
    if(a.data[i+3]!==b.data[i+3])attempts++;
    for(let c=0;c<3;c++){const d=Math.abs(a.data[i+c]-b.data[i+c]);maxAbs=Math.max(maxAbs,d);maxRel=Math.max(maxRel,d/Math.max(1e-3,Math.abs(a.data[i+c])));sum+=Math.abs(a.data[i+c]);}
  }
  return {maxAbs,maxRel,attemptMismatches:attempts,meanValue:sum/(a.data.length*.75)};
}
async function runCached(engine,{targetSpp,spp,grid,seed=1,validate=null}){
  const batches=[];
  for(;;){
    const batch=await engine.rayBatch({targetSpp,spp,grid,seed});if(!batch)break;
    if(validate)await validate(batch);
    const started=performance.now();
    for(const cell of batch.cells)if(cell.count)batch.resolve(cell.index);
    batches.push(batch.finish());
    await new Promise(r=>setTimeout(r,0));batches.at(-1).resolveSubmitMs=performance.now()-started;
  }
  return batches;
}
try{
  // ---------------------------------------------------------------- A: raw device
  const adapter=await navigator.gpu.requestAdapter();
  const furnace=createConstantRayProvider([.8,.8,.8]);
  const device=await adapter.requestDevice({requiredLimits:requiredLimits(adapter.limits,{provider:furnace})});
  device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
  const library=createLensLibrary({baseUrl:'/lenses/'});
  const tracer=await createLensTracer({device,provider:furnace,width:192});
  await tracer.setLens(await library.prescription('canon-fl-50mm-f1-8'),{fNumber:2.8,dispersion:false});
  tracer.setPose([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  await tracer.render({targetSpp:32});step('raw direct');
  const direct=await tracer.readHDR({space:'xyz'}),stats=await tracer.statistics();
  const {width,height}=tracer.dimensions,centre=((height/2)*width+width/2)*4;
  check(stats.bvhErrorRate===0&&stats.backgroundOfPassed>.9999,'ray provider statuses: '+JSON.stringify(stats));
  check(direct.data.every(Number.isFinite),'nonfinite raw-device output');
  check(direct.data[centre+1]>.01&&direct.data[centre+1]<1,'furnace centre Y '+direct.data[centre+1]);
  report.raw={width,height,spp:tracer.spp,centreY:direct.data[centre+1],stats,front:tracer.frontElement()};
  // ---------------------------------------------------------------- B: ray cache
  tracer.reset();
  const validate=async batch=>{
    const {indices,packets,capacity}=await batch.readBack(),f=new Float32Array(packets),u=new Uint32Array(packets);
    const seen=new Set(indices);check(seen.size===indices.length,'a ray is binned twice');
    let mismatched=0,border=0;
    for(const cell of batch.cells)for(let i=cell.offset;i<cell.offset+cell.count;i++){
      const index=indices[i],packet=index%capacity,jq=Math.floor(index/capacity),j=jq>>2,q=jq&3,o=(j*capacity+packet)*12;
      check(u[o+3]===0,'binned an optical failure');
      const p=[f[o]*(q&1?-1:1),f[o+1]*(q&2?-1:1)];
      const k=cellOf(p,{n:batch.grid,radiusMm:batch.radiusMm,rotation:batch.rotation,jitter:batch.jitter});
      if(k!==cell.index){
        // f32 vs f64 rounding may flip a ray lying on a cell border.
        const c=Math.cos(batch.rotation),s=Math.sin(batch.rotation),r=[c*p[0]-s*p[1],s*p[0]+c*p[1]];
        const near=r.some((v,a)=>{const x=(v/(2*batch.radiusMm)+.5)*batch.grid+batch.jitter[a];return Math.abs(x-Math.round(x))<1e-4;});
        if(near)border++;else mismatched++;
      }
    }
    check(mismatched===0,`${mismatched} rays in the wrong cell`);
    (report.binning??=[]).push({rays:indices.length,cells:batch.cells.filter(c=>c.count).length,borderRounding:border});
  };
  const furnaceBatches=await runCached(tracer.engine,{targetSpp:32,spp:16,grid:4,validate});step('raw cached');
  const cached=await tracer.readHDR({space:'xyz'}),furnaceDiff=compare(direct,cached);
  check(furnaceDiff.attemptMismatches===0&&furnaceDiff.maxRel<1e-5,'cached furnace differs: '+JSON.stringify(furnaceDiff));
  report.furnace={batches:furnaceBatches,diff:furnaceDiff};
  // Held batches: every batch is traced before the first is accumulated; their sample keys
  // start after the attempts of the batches before them, so the result is the direct one.
  tracer.reset();
  const held=[];for(let batch;(batch=await tracer.rayBatch({targetSpp:32,spp:8,grid:4,hold:true}));)held.push(batch);
  check(held.length===4&&tracer.tracedSpp===32&&tracer.spp===0&&tracer.engine.held.batches===4,'held batches: '+JSON.stringify({n:held.length,traced:tracer.tracedSpp,spp:tracer.spp}));
  for(const batch of held){batch.resolveAll();tracer.resolve();}
  for(const batch of held)batch.finish();
  const heldDiff=compare(direct,await tracer.readHDR({space:'xyz'}));
  check(tracer.spp===32&&tracer.engine.held.batches===0&&heldDiff.attemptMismatches===0&&heldDiff.maxRel<1e-5,'held batches differ: '+JSON.stringify(heldDiff));
  // Sensor bands: whole group rows and two column windows, traced band by band.
  tracer.reset();
  const layout=tracer.engine.bandLayout,rows=layout.tiles[0].rows,cols=layout.blocksX,split=Math.floor(rows/2),window=Math.floor(cols/3);
  check(layout.tiles.length===1&&rows>2&&cols>2,'band layout '+JSON.stringify(layout));
  tracer.engine.setBands([{tile:0,rows:[0,split]},{tile:0,rows:[split,rows],cols:[0,window]},{tile:0,rows:[split,rows],cols:[window,cols]}]);
  let bandBatches=0;
  for(let band=0;band<3;band++)for(let batch;(batch=await tracer.rayBatch({targetSpp:32,spp:16,grid:4,hold:true,band}));bandBatches++){batch.resolveAll();batch.finish();}
  const bandDiff=compare(direct,await tracer.readHDR({space:'xyz'}));
  check(bandBatches===6&&tracer.spp===32&&bandDiff.attemptMismatches===0&&bandDiff.maxRel<1e-5,'sensor bands differ: '+JSON.stringify({bandBatches,spp:tracer.spp,bandDiff}));
  report.held={batches:held.length,diff:heldDiff,bandBatches,bandDiff};
  tracer.reset();await tracer.render({targetSpp:3});
  const partitionReference=await tracer.readHDR({space:'xyz'});
  tracer.reset();
  const packetGroups=tracer.engine.bandLayout.blocksX*tracer.engine.bandLayout.tiles[0].rows,perGroup=64*96,partitioned=[];
  for(const memoryBytes of [packetGroups,packetGroups/2,packetGroups/2,packetGroups,packetGroups].map(n=>n*perGroup)){
    const batch=await tracer.rayBatch({spp:1,targetSpp:3,hold:true,memoryBytes});partitioned.push(batch);
  }
  for(const batch of partitioned){batch.resolveAll();batch.finish();}
  const partitionDiff=compare(partitionReference,await tracer.readHDR({space:'xyz'}));
  check(tracer.spp===3&&partitionDiff.attemptMismatches===0&&partitionDiff.maxRel<1e-5,'changed cache partition differs: '+JSON.stringify(partitionDiff));
  tracer.reset();
  const firstBatch=tracer.rayBatch({spp:1,hold:true});
  const concurrent=await tracer.rayBatch({spp:1,hold:true}).then(()=>null,e=>e);
  check(concurrent?.message.includes('being created'),'concurrent batch creation was accepted');
  const onlyBatch=await firstBatch;onlyBatch.resolveAll();onlyBatch.finish();
  report.partitioned={diff:partitionDiff,concurrentRejected:true};
  tracer.dispose();device.destroy();
  // ---------------------------------------------------------------- C: garden equivalence
  const W=240,SPP=8;
  installShadowMapInit();
  const renderer=new THREE.WebGPURenderer({antialias:false,requiredLimits:requiredGPULimits(adapter.limits)});
  await renderer.init();renderer.setSize(W,W/1.5);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.NoToneMapping;
  renderer.backend.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
  const {scene,details}=buildSanteiScene();
  for(const lamp of details.lamps.slice(0,2)){lamp.light.castShadow=true;lamp.light.shadow.mapSize.set(512,512);lamp.light.shadow.camera.near=.08;lamp.light.shadow.camera.far=11;lamp.light.shadow.camera.layers.set(1);}
  const daylight=createDaylight(scene,renderer,{details});
  const camera=new THREE.PerspectiveCamera(40,1.5,.15,450);camera.position.set(21,13,27);camera.lookAt(0,2.7,2);camera.updateMatrixWorld();
  daylight.update({hour:16.5,date:'2026-09-26'},true);
  const first=new THREE.RenderTarget(W,W/1.5,{type:THREE.HalfFloatType});renderer.setRenderTarget(first);await renderer.compileAsync(scene,camera);renderer.render(scene,camera);renderer.setRenderTarget(null);
  await renderer.backend.device.queue.onSubmittedWorkDone();step('garden raster');
  const rig=await createLensRig({renderer,scene,camera,width:W,environment:daylight});
  const {engine,interop}=rig;
  const lens=(await library.asset('canon-fl-50mm-f1-8')).configurations[0];
  engine.setLens(lens,{fNumber:2.8,sensorZMm:lens.sensorZMm,dispersion:false});const focus=focusTestLens(engine,lens,30);engine.setLens(focus.lens,{sensorZMm:focus.lens.sensorZMm,fNumber:2.8,dispersion:false});engine.setPose(cameraPose(camera));
  const sampleDirect=async()=>{engine.reset();const t=performance.now();while(engine.spp<SPP){engine.sample({batchSpp:4,targetSpp:SPP,seed:3});await interop.device.queue.onSubmittedWorkDone();}return performance.now()-t;};
  const surfaceMs=await sampleDirect();const surface=await engine.readHDR({space:'xyz'}),surfaceStats=await engine.statistics();step('garden surface');
  await engine.setRadianceProvider(createSurfaceRayProvider({provider:rig.provider,scene:rig.sceneResources}));
  const rayMs=await sampleDirect();const ray=await engine.readHDR({space:'xyz'}),rayStats=await engine.statistics();step('garden ray');
  engine.reset();const t=performance.now();
  const gardenBatches=await runCached(engine,{targetSpp:SPP,spp:SPP,grid:4,seed:3});await interop.device.queue.onSubmittedWorkDone();
  const cachedMs=performance.now()-t,viaCache=await engine.readHDR({space:'xyz'}),cacheStats=await engine.statistics();step('garden cached');
  const rayDiff=compare(surface,ray),cacheDiff=compare(surface,viaCache);
  report.garden={width:W,spp:SPP,surfaceMs,rayMs,cachedMs,rayDiff,cacheDiff,batches:gardenBatches,
    hitOfPassed:[surfaceStats.sceneHitOfPassed,rayStats.sceneHitOfPassed,cacheStats.sceneHitOfPassed],bvhError:[surfaceStats.bvhErrorRate,rayStats.bvhErrorRate,cacheStats.bvhErrorRate]};
  for(const [name,d] of [['ray',rayDiff],['cache',cacheDiff]])check(d.attemptMismatches===0&&d.maxRel<1e-4,`garden ${name} path differs: ${JSON.stringify(d)}`);
  check(surfaceStats.sceneHitOfPassed===cacheStats.sceneHitOfPassed&&cacheStats.bvhErrorRate===0,'garden statuses differ');
  await renderer.backend.device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,0));
  check(report.errors.length===0,'GPU errors: '+report.errors.join('\n'));
  report.passed=true;
}catch(error){report.error=String(error.stack||error);console.error(error);}
out.textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);
