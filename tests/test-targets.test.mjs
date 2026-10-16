import test from 'node:test';
import assert from 'node:assert/strict';
import {Scene,Vector3,Raycaster} from 'three/webgpu';
import {buildTestTargets} from '../src/scene/test-targets.js';
import {classifyMaterial,extractScene} from '../src/scene/scene-extract.js';
import chart from '../src/scene/iso-chart-geometry.json' with {type:'json'};
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

test('chart surfaces including the Cornell vector mesh are supported by physical lens extraction',()=>{
 const scene=new Scene(),targets=buildTestTargets(scene),ex=extractScene(scene);
 assert.equal(ex.report.expandedTriangles,246+chart.indices.length/3);assert.deepEqual(ex.report.unsupported,[]);
 assert.deepEqual(targets.surfaces.map(m=>classifyMaterial(m.material).kind).sort(),[0,4,6,7]);
 for(const mesh of targets.surfaces){assert.equal(classifyMaterial(mesh.material).reason,0);assert.equal(mesh.geometry.attributes.uv.count,mesh.geometry.attributes.position.count);assert.equal(mesh.material.map,null);assert.equal(mesh.material.specularIntensity,0);}
 const iso=targets.surfaces[1],p=iso.geometry.attributes.position;
 assert.equal(iso.material.vertexColors,true);assert.equal(iso.geometry.attributes.color.count,p.count);
 iso.geometry.computeBoundingBox();const size=iso.geometry.boundingBox.getSize(new Vector3());
 assert.ok(Math.abs(size.x/size.y-chart.width/chart.height)<1e-6);
 for(let i=0;i<p.count;i++)assert.equal(p.getZ(i),0);
 assert.equal(chart.sourceSHA256,createHash('sha256').update(readFileSync(new URL('../assets/test-charts/ISO_12233-reschart.svg',import.meta.url),'utf8')).digest('hex'));
 assert.equal(chart.outlinedGlyphs,464);
 // A fully covered, disjoint planar subdivision must have the area of the paper.
 let area=0;const index=iso.geometry.index;
 for(let i=0;i<index.count;i+=3){const a=index.getX(i),b=index.getX(i+1),c=index.getX(i+2);const cross=(p.getX(b)-p.getX(a))*(p.getY(c)-p.getY(a))-(p.getY(b)-p.getY(a))*(p.getX(c)-p.getX(a));assert.ok(cross>=-1e-9);area+=cross/2;}
 assert.ok(Math.abs(area-size.x*size.y)<1e-5);
});
test('45 degree ruler has zero at reference depth and millimetre ticks map to real axial distance',()=>{
 const scene=new Scene(),{ruler,reference}=buildTestTargets(scene);scene.updateMatrixWorld(true);
 const centre=mesh=>mesh.localToWorld(new Vector3()),a=centre(ruler),b=centre(reference);
 assert.ok(Math.abs(a.z-b.z)<1e-12);assert.ok(Math.abs(a.y-b.y)<1e-12);
 const far=ruler.localToWorld(new Vector3(0,.1,0)),near=ruler.localToWorld(new Vector3(0,-.1,0));
 assert.ok(Math.abs((a.z-far.z)-.1*Math.SQRT1_2)<1e-12);assert.ok(near.z>a.z&&far.z<a.z);
});
test('each target preset has a direct real-geometry focus hit on the intended chart',()=>{
 const scene=new Scene(),targets=buildTestTargets(scene);scene.updateMatrixWorld(true);
 const ray=new Raycaster();
 for(const [key,view]of Object.entries(targets.views)){
  const from=new Vector3(...view.position),to=new Vector3(...view.target);ray.set(from,to.sub(from).normalize());
  const hit=ray.intersectObjects(scene.children,true)[0];assert.ok(hit,key);assert.ok(targets.surfaces.includes(hit.object),key);assert.ok(Math.abs(hit.point.z+23.999)<1e-9,key);
 }
});
