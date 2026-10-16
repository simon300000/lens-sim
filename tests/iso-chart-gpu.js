import * as THREE from 'three/webgpu';
import {createISOChartGeometry,ISO_CHART_ASPECT} from '../src/scene/iso-chart.js';
import {createTestChartMaterial} from '../src/scene/test-targets.js';
import {extractScene} from '../src/scene/scene-extract.js';
const report={passed:false,errors:[],userAgent:navigator.userAgent};
try{
  const renderer=new THREE.WebGPURenderer({antialias:true});await renderer.init();
  renderer.backend.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
  renderer.setSize(2242,1396,false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
  document.querySelector('img').before(renderer.domElement);
  const scene=new THREE.Scene(),geometry=createISOChartGeometry(ISO_CHART_ASPECT);
  const mesh=new THREE.Mesh(geometry,createTestChartMaterial(1));scene.add(mesh);
  scene.add(new THREE.AmbientLight(0xffffff,Math.PI));
  const camera=new THREE.OrthographicCamera(-ISO_CHART_ASPECT/2,ISO_CHART_ASPECT/2,.5,-.5,.1,10);camera.position.z=2;
  await document.querySelector('img').decode();
  await renderer.renderAsync(scene,camera);await renderer.backend.device.queue.onSubmittedWorkDone();
  const canvas=document.createElement('canvas');canvas.width=1121;canvas.height=698;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(renderer.domElement,0,0,1121,698);
  const actual=ctx.getImageData(0,0,1121,698).data;
  ctx.fillStyle='white';ctx.fillRect(0,0,1121,698);ctx.drawImage(document.querySelector('img'),0,0,1121,698);
  const expected=ctx.getImageData(0,0,1121,698).data;let error=0,large=0,dark=0,light=0;
  for(let i=0;i<actual.length;i+=4){const d=Math.max(...[0,1,2].map(c=>Math.abs(actual[i+c]-expected[i+c])));error+=d;if(d>64)large++;if(actual[i]<60)dark++;if(actual[i]>240)light++;}
  report.meanPixelError=error/(1121*698);report.largePixelDifferenceFraction=large/(1121*698);report.dark=dark;report.light=light;
  // SVG antialiases in sRGB; the physical material resolves coverage in linear
  // light. Check flat interiors separately so edge coverage is not a failure.
  let interiors=0,mismatches=0;
  for(let y=2;y<696;y++)for(let x=2;x<1119;x++){
    let low=255,high=0;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const v=expected[((y+dy)*1121+x+dx)*4];low=Math.min(low,v);high=Math.max(high,v);}
    if(high-low>16)continue;
    interiors++;if(Math.abs(actual[(y*1121+x)*4]-expected[(y*1121+x)*4])>32)mismatches++;
  }
  report.interiorMismatchFraction=mismatches/interiors;
  const extracted=extractScene(scene);
  report.triangles=extracted.report.expandedTriangles;report.unsupported=extracted.report.unsupported;
  report.passed=report.errors.length===0&&report.unsupported.length===0&&report.triangles>10000&&report.meanPixelError<8&&report.interiorMismatchFraction<.003&&dark>10000&&light>10000;
  window.__isoChartRenderer=renderer;
}catch(error){report.error=error.stack;}
window.__isoChartReport=report;document.querySelector('#result').textContent=JSON.stringify(report,null,2);document.title=`ISO vector ${report.passed?'PASS':'FAIL'}`;
