import test from 'node:test';
import assert from 'node:assert/strict';
import {Scene,Group,Mesh,InstancedMesh,PointLight,Matrix4,BoxGeometry,MeshStandardNodeMaterial,PerspectiveCamera} from 'three/webgpu';
import {bundleStaticContent} from '../src/scene/render-bundles.js';

const near=(a,b,eps=1e-6)=>a.every((v,i)=>Math.abs(v-b[i])<=eps);
function fixture(){
  const scene=new Scene(),root=new Group();root.name='Villa';root.position.set(5,0,-3);root.rotation.y=.4;scene.add(root);
  const geometry=new BoxGeometry(),opaque=new MeshStandardNodeMaterial(),glass=new MeshStandardNodeMaterial({transparent:true,opacity:.5});
  const inner=new Group();inner.position.set(1,2,3);root.add(inner);
  const small=new Mesh(geometry,opaque);small.position.set(.5,.5,.5);inner.add(small);
  const other=new Mesh(geometry,opaque);other.position.set(-20,0,0);root.add(other);
  const water=new Mesh(geometry,glass);root.add(water);
  const lantern=new Mesh(geometry,opaque);lantern.add(new PointLight());root.add(lantern);
  const forest=new InstancedMesh(geometry,opaque,400);for(let i=0;i<400;i++)forest.setMatrixAt(i,new Matrix4().makeTranslation(i%20*4,0,Math.floor(i/20)*4));forest.computeBoundingSphere();forest.position.set(100,0,0);root.add(forest);
  return {scene,root,inner,small,other,water,lantern,forest};
}

test('static meshes move into bundle groups with their world transforms intact',()=>{
  const f=fixture();f.root.updateWorldMatrix(true,true);
  const before=Object.fromEntries(['small','other','forest','water','lantern'].map(k=>[k,f[k].matrixWorld.toArray()]));
  const bundles=bundleStaticContent(f.scene,[f.root]);
  f.root.updateWorldMatrix(true,true);
  assert.equal(bundles.bundled,3,'small, other and forest are bundled');
  assert.equal(bundles.groups.length,2,'one shared group plus one for the 400-instance forest');
  for(const k of ['small','other','forest'])assert.ok(f[k].parent.isBundleGroup!==undefined&&bundles.groups.includes(f[k].parent),`${k} is inside a bundle group`);
  assert.equal(f.water.parent,f.root,'transparent water stays a direct draw');
  assert.equal(f.lantern.parent,f.root,'a mesh carrying a light is not moved');
  for(const k of Object.keys(before))assert.ok(near(f[k].matrixWorld.toArray(),before[k],1e-5),`${k} keeps its world matrix`);
  for(const k of ['small','other','forest'])assert.equal(f[k].frustumCulled,false,'bundled draws are complete for every camera');
  assert.equal(f.water.frustumCulled,true);
  const forestGroup=f.forest.parent;assert.ok(forestGroup.userData.bounds.radius>=f.forest.boundingSphere.radius-1e-6);
  assert.ok(forestGroup.userData.bounds.containsPoint(f.forest.getWorldPosition(f.forest.position.clone())));
});

test('recording starts only with enable and every group is re-recorded on invalidate',()=>{
  const f=fixture();const bundles=bundleStaticContent(f.scene,[f.root]);
  for(const group of bundles.groups){assert.equal(group.isBundleGroup,false);assert.equal(group.version,0);}
  bundles.enable();
  for(const group of bundles.groups){assert.equal(group.isBundleGroup,true);assert.equal(group.version,1);}
  bundles.invalidate();
  for(const group of bundles.groups)assert.equal(group.version,2);
  bundles.dispose();
  for(const group of bundles.groups)assert.equal(group.isBundleGroup,false);
});

test('a pass-specific distance limit skips groups entirely beyond it',()=>{
  const f=fixture();const bundles=bundleStaticContent(f.scene,[f.root]);
  const camera=new PerspectiveCamera(50,1,.1,1000);camera.position.set(100,0,60);camera.lookAt(100,0,0);camera.updateMatrixWorld();camera.updateProjectionMatrix();
  const forest=f.forest.parent,shared=f.small.parent;
  bundles.enable();bundles.frameRendered();
  const prepassTarget={name:'prepass'};
  bundles.setDistanceLimit((renderer,passCamera,renderTarget)=>renderTarget===prepassTarget?30:Infinity);
  f.scene.onBeforeRender({},f.scene,camera,prepassTarget);
  assert.equal(forest.visible,false,'the forest starts ~60 m away: beyond the prepass range');
  f.scene.onAfterRender({},f.scene,camera,prepassTarget);
  f.scene.onBeforeRender({},f.scene,camera,{name:'beauty'});
  assert.equal(forest.visible,true,'other passes keep frustum culling only');
  assert.equal(shared.visible,false,'the villa stays frustum-culled behind the camera');
  f.scene.onAfterRender({},f.scene,camera,{name:'beauty'});
  bundles.setDistanceLimit(null);
  f.scene.onBeforeRender({},f.scene,camera,prepassTarget);
  assert.equal(forest.visible,true,'reset to no limit');
  f.scene.onAfterRender({},f.scene,camera,prepassTarget);
});

test('groups are culled per camera before a render and restored afterwards',()=>{
  const f=fixture();const bundles=bundleStaticContent(f.scene,[f.root]);
  const camera=new PerspectiveCamera(50,1,.1,1000);camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();camera.updateProjectionMatrix();
  const shared=f.small.parent,forest=f.forest.parent;
  bundles.enable();
  f.scene.onBeforeRender({},f.scene,camera,null);
  assert.ok(shared.visible&&forest.visible,'the frame after enable records every bundle');
  bundles.frameRendered();
  f.scene.onBeforeRender({},f.scene,camera,null);
  assert.equal(shared.visible,true,'the villa in front of the camera is drawn');
  assert.equal(forest.visible,false,'the forest 100 m to the side is culled');
  assert.equal(bundles.culledLastRender,1);
  f.scene.onAfterRender({},f.scene,camera,null);
  assert.ok(shared.visible&&forest.visible,'traversals after the render see every group');
  camera.position.set(100,0,40);camera.lookAt(100,0,0);camera.updateMatrixWorld();
  f.scene.onBeforeRender({},f.scene,camera,null);
  assert.equal(forest.visible,true);assert.equal(shared.visible,false);
  f.scene.onAfterRender({},f.scene,camera,null);
});
