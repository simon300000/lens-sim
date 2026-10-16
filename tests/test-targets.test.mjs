import test from 'node:test';
import assert from 'node:assert/strict';
import {Scene,Vector3,Raycaster} from 'three/webgpu';
import {buildTestTargets} from '../src/scene/test-targets.js';
import {classifyMaterial,extractScene} from '../src/scene/scene-extract.js';

test('all analytic chart surfaces are registered imaging materials with real UVs and no textures',()=>{
 const scene=new Scene(),targets=buildTestTargets(scene),ex=extractScene(scene);
 assert.equal(ex.report.expandedTriangles,248);assert.deepEqual(ex.report.unsupported,[]);
 assert.deepEqual(targets.surfaces.map(m=>classifyMaterial(m.material).kind).sort(),[4,5,6,7]);
 for(const mesh of targets.surfaces){assert.equal(classifyMaterial(mesh.material).reason,0);assert.equal(mesh.geometry.attributes.uv.count,4);assert.equal(mesh.material.map,null);assert.equal(mesh.material.specularIntensity,0);}
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
