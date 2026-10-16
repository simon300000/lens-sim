// Opt-in full-application startup probe. No changes to production execution order.
(()=>{
 const events=[],gaps=[],visibility=[],errors=[];let stopped=false,last=performance.now();
 const profile=window.__startupProfile={events,gaps,visibility,errors,started:last,userAgent:navigator.userAgent,query:location.search};
 const state=()=>({hidden:document.hidden,focused:document.hasFocus()});
 function status(){visibility.push({t:performance.now(),...state()});}status();
 for(const name of ['visibilitychange','focus','blur'])addEventListener(name,status);
 addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
 profile.wrap=(proto,name,category)=>{
  if(!proto?.[name])return;const original=proto[name];
  proto[name]=function(...args){
   if(stopped)return original.apply(this,args);
   const e={name,category,start:performance.now(),...state()};
   if(category==='gpu')e.label=args[0]?.label||'';
   if(category==='nodeBuild'){e.material=this.material?.type;e.materialName=this.material?.name||'';e.materialId=this.material?.uuid;e.objectType=this.object?.type;}
   events.push(e);
   try{const result=original.apply(this,args);e.end=performance.now();
    if(result&&typeof result.then==='function')result.then(()=>{e.settled=performance.now();},error=>{e.settled=performance.now();e.error=String(error);});return result;
   }catch(error){e.end=performance.now();e.error=String(error);throw error;}
  };
 };
 for(const name of ['createShaderModule','createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync'])profile.wrap(globalThis.GPUDevice?.prototype,name,'gpu');
 profile.wrap(globalThis.GPUShaderModule?.prototype,'getCompilationInfo','gpu');
 profile.wrap(globalThis.GPUQueue?.prototype,'onSubmittedWorkDone','wait');
 const heartbeat=setInterval(()=>{const now=performance.now(),gap=now-last;if(gap>80)gaps.push({start:last,end:now,ms:gap,...state()});last=now;},16);
 const observer=new MutationObserver(()=>{
  const label=document.querySelector('#loading-message')?.textContent;
  if(profile.stage!==label){profile.stage=label;events.push({category:'stage',name:label,start:performance.now(),...state()});}
  if(document.querySelector('#scene')?.dataset.ready==='true'&&!profile.finishing){profile.finishing=true;setTimeout(finish,1000);}
 });observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-ready']});
 async function finish(){if(stopped)return;stopped=true;clearInterval(heartbeat);observer.disconnect();profile.finished=performance.now();profile.scene=window.__SANTEI__?.diagnostics;profile.viewport={width:innerWidth,height:innerHeight,dpr:devicePixelRatio};profile.state=state();
  const table=window.__SANTEI__?.hybrid?.engine?.pupilTable;
  profile.pupil=table?Object.fromEntries(['bins','globalMix','movingCenter','precomputeMs','deriveMs','buildMs','coldBuildMs','physicalCacheHit','probes'].map(k=>[k,table[k]])):null;
  profile.opticalInitializationMs=window.__SANTEI__?.hybrid?.engine?.initializationMs;
  const report={...profile,wrap:undefined,scene:{ready:profile.scene?.ready,initializationWallMs:profile.scene?.initializationWallMs,errors:profile.scene?.errors,meshes:profile.scene?.meshes,triangles:profile.scene?.triangles}};
  window.__startupReport=report;
  const out=document.createElement('pre');out.id='startup-profile-summary';out.style='position:fixed;top:0;right:0;background:#ffffffe8;color:#111;z-index:10000;max-height:45vh;max-width:60vw;overflow:auto;padding:12px;font:12px monospace';
  out.textContent=JSON.stringify({finished:report.finished,events:events.length,gaps:gaps.length,maxGap:Math.max(0,...gaps.map(x=>x.ms)),state:state(),errors},null,2);document.body.append(out);
  try{await fetch('http://127.0.0.1:5175/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});out.textContent+='\nREPORT SAVED';}catch(e){out.textContent+='\n'+e;}
 }
 profile.finish=finish;
})();
