import {readFileSync} from 'node:fs';
const report=JSON.parse(readFileSync(process.argv[2],'utf8'));
const events=report.events;
function union(spans,start=-Infinity,end=Infinity){
 const intervals=spans.map(e=>[Math.max(start,e.start),Math.min(end,e.end??e.start)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
 let sum=0,last=-Infinity;for(const [a,b]of intervals){sum+=Math.max(0,b-Math.max(a,last));last=Math.max(last,b);}return sum;
}
const stages=events.filter(e=>e.category==='stage');
const start=stages.find(e=>e.name==='检测 GPU 与 HDR 画布支持')?.start??report.started;
const finish=start+(report.scene?.initializationWallMs??report.finished-start);
const builds=events.filter(e=>e.category==='nodeBuild');
const gpu=events.filter(e=>e.category==='gpu');
const names=[...new Set(gpu.map(e=>e.name))];
const counts=Object.fromEntries(names.map(name=>[name,gpu.filter(e=>e.name===name).length]));
const activeVisibility=report.visibility.filter(v=>v.t>=start&&v.t<=finish);
const summary={query:report.query,userAgent:report.userAgent,viewport:report.viewport,start,finish,initializationMs:finish-start,
 foreground:activeVisibility.every(v=>!v.hidden&&v.focused)&&!events.some(e=>e.start>=start&&e.start<=finish&&(e.hidden||!e.focused)),visibility:report.visibility,errors:report.errors,sceneErrors:report.scene?.errors,
 pupil:report.pupil,opticalInitializationMs:report.opticalInitializationMs,counts,nodeBuildCalls:builds.length,nodeBuildUnionMs:union(builds,start,finish),gpuSynchronousUnionMs:union(gpu,start,finish),
 api:names.map(name=>{const es=gpu.filter(e=>e.name===name);return {name,count:es.length,syncMs:union(es,start,finish),asyncLatencySumMs:es.reduce((s,e)=>s+((e.settled??e.end)-e.start),0)};}),
 warmup:report.scene?.warmup?.map(row=>({...row,finalNodeBuildCalls:events.filter(e=>e.category==='nodeBuild'&&e.start>=row.finalStartMs&&e.start<row.finalEndMs).length,finalPipelineCreates:events.filter(e=>e.name.includes('Pipeline')&&e.category==='gpu'&&e.start>=row.finalStartMs&&e.start<row.finalEndMs).length})),
 stages:stages.filter(e=>e.start>=start).map(e=>{const next=stages[stages.indexOf(e)+1]?.start??finish;return {name:e.name,start:e.start,durationMs:next-e.start,nodeBuildMs:union(builds,e.start,next),gpuSyncMs:union(gpu,e.start,next)};}),
 gaps:report.gaps.filter(g=>g.start>=start&&g.start<=finish).sort((a,b)=>b.ms-a.ms).map(g=>({...g,nodeBuildMs:union(builds,g.start,g.end),gpuSyncMs:union(gpu,g.start,g.end)}))};
console.log(JSON.stringify(summary,null,2));
