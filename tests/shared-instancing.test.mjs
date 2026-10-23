import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {Group,InstancedMesh,BoxGeometry,MeshStandardNodeMaterial,Color} from 'three/webgpu';
import {stack,setCurrentStack} from 'three/tsl';
import {shareInstanceAttributes,hasSharedInstanceAttributes,sourceGeometry,INSTANCE_MATRIX_ATTRIBUTES} from '../src/scene/static-batches.js';

// Observe three's own setupPosition (r186 applies instancing inside it) before
// the patch wraps it; installation is idempotent and global.
const seen=[];
THREE.NodeMaterial.prototype.setupPosition=function(builder){seen.push(builder.object.instanceMatrix);};
const {installSharedInstancing,updateSharedMatrices}=await import('../src/rendering/three-interop.js');
const fakeRenderer=()=>({_nodes:{getForRenderCacheKey(renderObject){return renderObject.initialCacheKey;}}});
installSharedInstancing(fakeRenderer());

test('prepared instanced meshes expose matrices and colours as geometry attributes',()=>{
 const root=new Group(),source=new BoxGeometry(),material=new MeshStandardNodeMaterial();
 const plain=new InstancedMesh(source,material,3),coloured=new InstancedMesh(source,material,2);
 coloured.setColorAt(0,new Color('#ff0000'));coloured.setColorAt(1,new Color('#00ff00'));
 root.add(plain,coloured);
 assert.equal(shareInstanceAttributes(root).shared,2);
 assert.equal(shareInstanceAttributes(root).shared,0,'idempotent');
 for(const mesh of [plain,coloured]){
  const geometry=mesh.geometry;
  assert.notEqual(geometry,source);assert.equal(sourceGeometry(geometry),source);
  assert.equal(geometry.index,source.index);assert.equal(geometry.attributes.position,source.attributes.position);
  assert.deepEqual(geometry.boundingSphere,source.boundingSphere);
  const columns=INSTANCE_MATRIX_ATTRIBUTES.map(name=>geometry.attributes[name]);
  assert.ok(columns[0].data instanceof THREE.InstancedInterleavedBuffer);
  assert.equal(columns[0].data.array,mesh.instanceMatrix.array);
  assert.deepEqual(columns.map(c=>[c.data,c.itemSize,c.offset]),[0,4,8,12].map(offset=>[columns[0].data,4,offset]));
  assert.ok(hasSharedInstanceAttributes(mesh));
 }
 assert.equal(plain.geometry.attributes.instanceColor,undefined);
 assert.equal(coloured.geometry.attributes.instanceColor,coloured.instanceColor);
 // Replacing the mesh's instance data after preparation falls back to Three's own path.
 plain.instanceMatrix=plain.instanceMatrix.clone();
 assert.equal(hasSharedInstanceAttributes(plain),false);
 coloured.instanceColor=null;coloured.setColorAt(0,new Color('#0000ff'));
 assert.equal(hasSharedInstanceAttributes(coloured),false);
});

test('prepared batches of one material share a node builder cache key',()=>{
 const renderer=fakeRenderer();installSharedInstancing(renderer);installSharedInstancing(renderer);
 const root=new Group(),source=new BoxGeometry(),material=new MeshStandardNodeMaterial();
 const a=new InstancedMesh(source,material,3),b=new InstancedMesh(source,material,40),other=new InstancedMesh(source,material,5);
 root.add(a,b);shareInstanceAttributes(root);
 const renderObject=object=>({object,initialCacheKey:`${object.uuid}/initial`,getCacheKey(){return `${object.uuid}/material`;}});
 const key=renderer._nodes.getForRenderCacheKey;
 assert.equal(key(renderObject(a)),key(renderObject(b)));
 assert.notEqual(key(renderObject(a)),key(renderObject(other)));
 assert.equal(key(renderObject(other)),`${other.uuid}/initial`,'unprepared meshes keep their own key');
 assert.equal(a.uuid.length,36,'uuid is restored');
});

test('prepared meshes read attribute matrices and skip three\'s per-mesh instancing',()=>{
 const root=new Group(),material=new MeshStandardNodeMaterial(),prepared=new InstancedMesh(new BoxGeometry(),material,2),plain=new InstancedMesh(new BoxGeometry(),material,2);
 prepared.setColorAt(0,new Color('#ff0000'));root.add(prepared);shareInstanceAttributes(root);
 const builder=object=>({object,geometry:object.geometry,needsPreviousData:()=>false,hasGeometryAttribute:()=>true});
 const run=object=>{const s=stack();setCurrentStack(s);seen.length=0;try{material.setupPosition(builder(object));}finally{setCurrentStack(null);}return s.nodes;};
 const nodes=run(prepared);
 assert.deepEqual(seen,[null],'three\'s instancing branch sees no instance matrix');
 assert.ok(prepared.instanceMatrix?.isInstancedBufferAttribute,'instance matrix restored');
 // positionLocal, normalLocal and the instance colour varying from attributes, plus the per-object upload hook.
 assert.equal(nodes.filter(n=>n.isAssignNode).length,3);
 assert.equal(nodes.filter(n=>n.constructor.name==='EventNode').length,1);
 assert.equal(run(plain).length,0);assert.equal(seen[0],plain.instanceMatrix,'unprepared meshes keep three\'s path');
});

test('prepared meshes re-upload their matrices per object when the mesh attribute changes',()=>{
 const root=new Group(),mesh=new InstancedMesh(new BoxGeometry(),new MeshStandardNodeMaterial(),2);root.add(mesh);shareInstanceAttributes(root);
 const matrices=mesh.geometry.attributes.instanceMatrix0.data,version=matrices.version;
 updateSharedMatrices(mesh);
 assert.equal(matrices.version,version,'unchanged matrices are not re-uploaded');
 mesh.instanceMatrix.needsUpdate=true;updateSharedMatrices(mesh);
 assert.equal(matrices.version,version+1);
 updateSharedMatrices(mesh);assert.equal(matrices.version,version+1);
});
