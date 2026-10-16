// Foreground end-to-end raster probe. No per-frame queue fence or image readback.
// Optional ?pixels=1&validate=1&gpu=1 adds isolated readbacks after timing.
// window.__rasterReport retains results; an optional collector accepts the POST.
const params=new URLSearchParams(location.search),label=params.get('label')||'probe';
const report={label,userAgent:navigator.userAgent,visibility:[],errors:[],cases:[]};
for(const e of ['blur','focus','visibilitychange'])addEventListener(e,()=>report.visibility.push({event:e,hidden:document.hidden,focused:document.hasFocus()}));
addEventListener('error',e=>report.errors.push(e.message));
const raf=()=>new Promise(resolve=>requestAnimationFrame(resolve));
while(!window.__SANTEI__?.diagnostics.ready)await new Promise(r=>setTimeout(r,200));
report.compilation=window.__rasterStartup?.finish();
await new Promise(r=>setTimeout(r,1000));
const {renderer,camera,pipeline,controls,diagnostics,scenePass}=window.__SANTEI__,queue=renderer.backend.device.queue;
const table=window.__SANTEI__.hybrid.engine.pupilTable;
report.precompute=table?Object.fromEntries(['precomputeMs','deriveMs','buildMs','probes','bins','globalMix'].map(k=>[k,table[k]])):null;
report.startup={wallMs:diagnostics.initializationWallMs,warmup:diagnostics.warmup};
report.features=Array.from(renderer.backend.device.features);
report.viewport={width:innerWidth,height:innerHeight,dpr:devicePixelRatio};report.scene={meshes:diagnostics.meshes,triangles:diagnostics.triangles};
if(params.has('profile')){
 report.visibility.length=0;let stop=false;
 const button=document.createElement('button');button.textContent='结束 Metal 采样';
 Object.assign(button.style,{position:'fixed',top:'16px',left:'40%',zIndex:1000});button.onclick=()=>stop=true;document.body.append(button);
 report.profile={start:performance.now(),frames:0};document.title='Raster Metal: rendering';
 while(!stop&&report.profile.frames<6000){await raf();pipeline.render();report.profile.frames++;}
 await queue.onSubmittedWorkDone();report.profile.wallMs=performance.now()-report.profile.start;button.remove();
 report.errors.push(...diagnostics.errors);report.valid=!report.errors.length&&!document.hidden&&document.hasFocus()&&!report.visibility.some(v=>v.hidden||!v.focused);
 window.__rasterReport=report;await fetch('/__raster-report',{method:'POST',body:JSON.stringify(report)});document.title=`Raster Metal: ${report.valid?'PASS':'INVALID'}`;
}else{
renderer.info.autoReset=false;
const original=renderer.render,rows=[];let activeRenderLabel='';let measuring=false;
renderer.render=function(scene,cam,...args){const t=performance.now();const target=renderer.getRenderTarget(),previousLabel=activeRenderLabel;activeRenderLabel=`${cam===camera?'main':cam.type}/${target?.texture.name||'canvas'}/${target?.samples??0}`;try{return original.call(this,scene,cam,...args);}finally{if(measuring)rows.push({ms:performance.now()-t,camera:cam===camera?'main':cam.type,target:target?.texture.name||'canvas',width:target?.width,height:target?.height});activeRenderLabel=previousLabel;}};
const initialPosition=camera.position.clone(),initialTarget=controls.target.clone();
const count=Number(params.get('frames')||90);
report.visibility.length=0;
for(const moving of [false,true]){
 for(let i=0;i<8;i++){await raf();pipeline.render();}
 await queue.onSubmittedWorkDone();const frames=[],cpu=[];rows.length=0;measuring=true;renderer.info.reset();let last=performance.now();const start=last;
 for(let i=0;i<count;i++){await raf();const now=performance.now();frames.push(now-last);last=now;if(moving){camera.position.x+=.002;camera.updateMatrixWorld();}const t=performance.now();pipeline.render();cpu.push(performance.now()-t);}
 await queue.onSubmittedWorkDone();measuring=false;
 const stages={};for(const row of rows){const key=`${row.camera}/${row.target}/${row.width}x${row.height}`;const s=stages[key]??={calls:0,ms:0};s.calls++;s.ms+=row.ms;}
 report.cases.push({moving,wallMs:performance.now()-start,frames,cpu,stages,render:{...renderer.info.render},hidden:document.hidden,focused:document.hasFocus()});
}
const calls=[],driver=[];const draw=pipeline.render.bind(pipeline);pipeline.render=()=>{const t=performance.now();try{return draw();}finally{calls.push(performance.now()-t);}};
await queue.onSubmittedWorkDone();renderer.info.reset();const actualStart=performance.now();
for(let i=0;i<count;i++){await raf();const t=performance.now();camera.position.x+=.002;controls.target.x+=.002;controls.update();driver.push(performance.now()-t);}
await raf();await queue.onSubmittedWorkDone();pipeline.render=draw;
report.actual={wallMs:performance.now()-actualStart,frames:calls.length,cpu:calls,driver,draws:renderer.info.render.drawCalls,hidden:document.hidden,focused:document.hasFocus()};
await raf();await raf();
if(params.has('gpu')&&renderer.backend.device.features.has('timestamp-query')){
 const device=renderer.backend.device,query=device.createQuerySet({type:'timestamp',count:128});
 const resolve=device.createBuffer({size:1024,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
 const read=device.createBuffer({size:1024,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const proto=GPUCommandEncoder.prototype,begin=proto.beginRenderPass;let index=0;const labels=[];
 proto.beginRenderPass=function(descriptor){const offset=index;index+=2;labels.push(activeRenderLabel);return begin.call(this,{...descriptor,timestampWrites:{querySet:query,beginningOfPassWriteIndex:offset,endOfPassWriteIndex:offset+1}});};
 try{pipeline.render();}finally{proto.beginRenderPass=begin;}
 const encoder=device.createCommandEncoder();encoder.resolveQuerySet(query,0,index,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,index*8);queue.submit([encoder.finish()]);
 await read.mapAsync(GPUMapMode.READ);const values=new BigUint64Array(read.getMappedRange());report.gpu=labels.map((label,i)=>({label,ms:Number(values[i*2+1]-values[i*2])/1e6}));read.unmap();read.destroy();resolve.destroy();query.destroy();
}
if(params.has('pixels')){
 camera.position.copy(initialPosition);controls.target.copy(initialTarget);controls.update();
 renderer.setPixelRatio(1);renderer.setSize(480,320);await raf();await raf();pipeline.render();await queue.onSubmittedWorkDone();
 report.pixelSize={width:scenePass.renderTarget.width,height:scenePass.renderTarget.height};report.pixelPose=camera.matrixWorld.toArray();
 report.pixels=Array.from(await renderer.readRenderTargetPixelsAsync(scenePass.renderTarget,0,0,480,320));
 if(params.has('validate')){
  report.timePixels={};
  for(const hour of [12,0]){window.__SANTEI__.timeControls.setHour(hour);await raf();await raf();await raf();pipeline.render();await queue.onSubmittedWorkDone();report.timePixels[hour]=Array.from(await renderer.readRenderTargetPixelsAsync(scenePass.renderTarget,0,0,480,320));}
 }
}
renderer.render=original;
if(params.has('validate')){
 const {hybrid,timeControls}=window.__SANTEI__;timeControls.setHour(16.5);await raf();await raf();await raf();
 await hybrid.store.dispatch('setTargetSpp',1);await hybrid.store.dispatch('setMode','lens');
 const deadline=performance.now()+30000;while(hybrid.store.getState().sampling.spp<1&&performance.now()<deadline)await new Promise(r=>setTimeout(r,50));
 await queue.onSubmittedWorkDone();report.lensAfterNavigation={spp:hybrid.store.getState().sampling.spp,status:hybrid.store.getState().status,pose:camera.matrixWorld.toArray()};
 report.lensAfterNavigation.statistics=await hybrid.engine.statistics();
 for(const key of ['bvhErrorRate','unsupportedRate','numericalErrorRate','radianceInvalidRate'])if(report.lensAfterNavigation.statistics?.[key]>0)report.errors.push(`Lens ${key} after raster navigation`);
 if(report.lensAfterNavigation.spp<1||report.lensAfterNavigation.status!=='ready')report.errors.push('Lens switch after raster navigation failed');
 await hybrid.store.dispatch('setMode','raster');await raf();
}
controls.update();report.errors.push(...diagnostics.errors);report.valid=!report.errors.length&&!report.visibility.some(v=>v.hidden||!v.focused)&&report.cases.every(c=>!c.hidden&&c.focused)&&!report.actual.hidden&&report.actual.focused;
window.__rasterReport=report;
await fetch('/__raster-report',{method:'POST',body:JSON.stringify(report)});document.title=`Raster ${label}: ${report.valid?'PASS':'INVALID'}`;

// Observe native key tests without synthetic input or a second renderer.
let keyStart;
addEventListener('keydown',event=>{if(event.code==='KeyW'&&!keyStart)keyStart={position:camera.position.toArray(),offset:camera.position.clone().sub(controls.target).toArray(),input:event.target.tagName};});
addEventListener('keyup',async event=>{if(event.code!=='KeyW'||!keyStart)return;const before=keyStart;keyStart=null;await raf();const result={label:before.input==='INPUT'?'keyboard-input':'keyboard-native',before,after:{position:camera.position.toArray(),offset:camera.position.clone().sub(controls.target).toArray()},errors:diagnostics.errors};await fetch('/__raster-report',{method:'POST',body:JSON.stringify(result)});});

}
