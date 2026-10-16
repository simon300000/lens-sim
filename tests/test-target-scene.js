// End-to-end validation through the actual application, physical AF and lens
// scene shader. The target point-function parity is tested separately.
const report={kind:'scene',passed:false,errors:[],targets:[],userAgent:navigator.userAgent};
const raf=()=>new Promise(resolve=>requestAnimationFrame(resolve));
try{
 const deadline=performance.now()+180000;while(!window.__SANTEI__?.diagnostics.ready&&performance.now()<deadline)await new Promise(r=>setTimeout(r,200));
 const app=window.__SANTEI__;if(!app?.diagnostics.ready)throw Error('Application did not initialize');
 const {hybrid,camera,renderer,diagnostics,testTargets}=app,store=hybrid.store;
 report.initializationWallMs=diagnostics.initializationWallMs;report.precomputeMs=hybrid.engine.pupilTable?.precomputeMs;
 for(const key of ['focus','siemens','iso']){
  await store.dispatch('setMode','raster');app.showTestTarget(key);await raf();await raf();
  await store.dispatch('autofocus');const af=store.getState().af;
  report.lastAttempt={key,af:af.lastResult,camera:camera.position.toArray(),matrix:camera.matrixWorld.toArray()};
  if(af.status!=='success'||!af.lastResult?.target||af.lastResult.target.infinity)throw Error(`AF did not hit ${key}`);
  if(Math.abs(af.lastResult.target.world[2]+23.999)>.01)throw Error(`AF hit the wrong depth for ${key}`);
  await store.dispatch('setTargetSpp',16);await store.dispatch('setMode','lens');
  const end=performance.now()+45000;while(hybrid.engine.spp<16&&performance.now()<end)await new Promise(r=>setTimeout(r,50));
  if(hybrid.engine.spp<16)throw Error(`Lens tracing did not complete for ${key}`);
  const stats=await hybrid.engine.statistics();
  for(const field of ['numericalErrorRate','bvhErrorRate','unsupportedRate','radianceInvalidRate'])if(stats[field]>0)throw Error(`${key}: ${field}`);
  const pixels=await hybrid.interop.readTexture(hybrid.engine.outputGPU);let peak=0,min=Infinity;
  for(let i=0;i<pixels.length;i+=4){if(!Number.isFinite(pixels[i]+pixels[i+1]+pixels[i+2]))throw Error('Nonfinite target radiance');peak=Math.max(peak,pixels[i]);min=Math.min(min,pixels[i]);}
  if(!(peak>min+.001))throw Error(`Flat or missing target image: ${key}`);
  report.targets.push({key,af:af.lastResult,stats,peak,min,spp:hybrid.engine.spp,camera:camera.position.toArray()});
 }
 await store.dispatch('setMode','raster');report.errors.push(...diagnostics.errors);
 if(report.errors.length)throw Error(report.errors.join(';'));
 report.scene={surfaces:testTargets.surfaces.length,ruler:testTargets.group.userData};report.passed=true;
}catch(error){report.error=error.message+'\n'+error.stack;}
finally{window.__targetSceneReport=report;document.title=`Target scene ${report.passed?'PASS':'FAIL'}`;await fetch('/__chart-report',{method:'POST',body:JSON.stringify(report)});}
