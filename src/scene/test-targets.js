import * as THREE from 'three/webgpu';
import {Fn,uv,uint,vec3,wgslFn} from 'three/tsl';
import {setLensMaterial,PROCEDURAL} from './lens-registry.js';
import {CHART_KIND,TEST_CHART_WGSL} from './test-chart-patterns.js';
import {createISOChartGeometry,ISO_CHART_ASPECT} from './iso-chart.js';

const reflectance=wgslFn(TEST_CHART_WGSL);
export function createTestChartMaterial(kind){
  const material=new THREE.MeshPhysicalNodeMaterial({color:0xffffff,roughness:1,metalness:0,specularIntensity:0});
  material.name=['Siemens star 72 line pairs','ISO 12233 — Stephen H. Westin / Cornell University','45 degree focus ruler, millimetres','Upright zero-depth focus reference'][kind];
  if(kind===CHART_KIND.ISO12233){material.vertexColors=true;return material;}
  material.colorNode=Fn(()=>{
    const p=uv(),dx=p.dFdx().mul(.25),dy=p.dFdy().mul(.25);
    // Four analytic subpixel evaluations for navigation. Lens tracing evaluates
    // the identical point function per real ray; its pixel/aperture integration
    // comes from Monte Carlo samples, never from this preview filter.
    const sample=q=>reflectance({coord:q,chartKind:uint(kind)});
    return vec3(sample(p.add(dx).add(dy)).add(sample(p.sub(dx).add(dy))).add(sample(p.add(dx).sub(dy))).add(sample(p.sub(dx).sub(dy))).mul(.25));
  })();
  setLensMaterial(material,{kind:PROCEDURAL.CHART_SIEMENS+kind});
  return material;
}
export const TEST_TARGET_DEPTH=-24;
export const TEST_TARGET_VIEWS=Object.freeze({
  siemens:{position:[-8,2.35,-17.9],target:[-8,2.35,-24]},
  iso:{position:[-3.1,2.35,-17.9],target:[-3.1,2.35,-24]},
  focus:{position:[1.45,1.95,-18],target:[1.45,1.95,-24]},
});
export function buildTestTargets(scene){
  const group=new THREE.Group();group.name='Behind-house optical test targets';scene.add(group);
  const support=new THREE.MeshStandardNodeMaterial({color:0x40464a,roughness:.9});
  const box=(width,height,depth,x,y,z)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(width,height,depth),support);m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;group.add(m);return m;};
  const surfaces=[];
  function panel(kind,x,y,z,width,height,tilt=0){
    const holder=new THREE.Group();holder.position.set(x,y,z);holder.rotation.x=tilt;group.add(holder);
    const backing=new THREE.Mesh(new THREE.BoxGeometry(width+.06,height+.06,.045),support);backing.position.z=-.035;backing.castShadow=backing.receiveShadow=true;holder.add(backing);
    const geometry=kind===CHART_KIND.ISO12233?createISOChartGeometry(width):new THREE.PlaneGeometry(width,height);
    const mesh=new THREE.Mesh(geometry,createTestChartMaterial(kind));mesh.name=mesh.material.name;mesh.receiveShadow=true;mesh.position.z=.001;holder.add(mesh);surfaces.push(mesh);
    for(const side of [-1,1]){const legX=x+side*(tilt?width*.5+.09:width*.38);box(.045,y,.045,legX,y*.5-.04,z-.10);box(.36,.05,.85,legX,-.025,z-.10);}
    return mesh;
  }
  panel(CHART_KIND.SIEMENS,-8.0,2.35,TEST_TARGET_DEPTH,2.7,2.7);
  panel(CHART_KIND.ISO12233,-3.1,2.35,TEST_TARGET_DEPTH,4.5,4.5/ISO_CHART_ASPECT);
  const reference=panel(CHART_KIND.FOCUS,1.45,1.95,TEST_TARGET_DEPTH,.85,.85);
  const ruler=panel(CHART_KIND.RULER,2.65,1.95,TEST_TARGET_DEPTH,.65,3.0,-Math.PI/4);
  // Plane front offsets are applied in local normal directions; align their
  // zero points exactly in world depth, not approximately at backing centres.
  ruler.parent.position.z=reference.parent.position.z+.001-.001*Math.cos(Math.PI/4);
  ruler.parent.position.y=reference.parent.position.y-.001*Math.sin(Math.PI/4);
  group.userData={rulerTiltDegrees:45,rulerTickMm:10,rulerLabelMm:100,rulerExtentMm:[-1500,1500],rulerLabelRangeMm:[-1400,1400],rulerLabels:'distance along ruler; axial depth = label * sin(45 degrees)',isoChart:'Stephen H. Westin / Cornell University SVG; not certified',isoChartSource:'https://www.graphics.cornell.edu/~westin/misc/res-chart.html'};
  return {group,surfaces,reference,ruler,views:TEST_TARGET_VIEWS};
}
