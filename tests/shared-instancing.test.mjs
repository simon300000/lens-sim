import test from 'node:test';
import assert from 'node:assert/strict';
import {Group,InstancedMesh,InstancedMeshNode,InstancedInterleavedBuffer,StorageInstancedBufferAttribute,BoxGeometry,MeshStandardNodeMaterial,DynamicDrawUsage,Color,NodeUpdateType} from 'three/webgpu';
import {installSharedInstancing} from '../src/rendering/three-interop.js';
import {shareInstanceAttributes,hasSharedInstanceAttributes,sourceGeometry,INSTANCE_MATRIX_ATTRIBUTES} from '../src/scene/static-batches.js';

const fakeRenderer=()=>({_nodes:{getForRenderCacheKey(renderObject){return renderObject.initialCacheKey;}}});
// A uniform buffer limit that would make Three keep small batches in uniforms.
const builder={getUniformBufferLimit:()=>65536};

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
  assert.ok(columns[0].data instanceof InstancedInterleavedBuffer);
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

test('prepared meshes re-upload their matrices per object when the mesh attribute changes',()=>{
 installSharedInstancing(fakeRenderer());
 const root=new Group(),mesh=new InstancedMesh(new BoxGeometry(),new MeshStandardNodeMaterial(),2);root.add(mesh);shareInstanceAttributes(root);
 const node=new InstancedMeshNode(mesh),matrices=mesh.geometry.attributes.instanceMatrix0.data,version=matrices.version;
 node.update({object:mesh});
 assert.equal(matrices.version,version,'unchanged matrices are not re-uploaded');
 mesh.instanceMatrix.needsUpdate=true;node.update({object:mesh});
 assert.equal(matrices.version,version+1);
 node.update({object:mesh});assert.equal(matrices.version,version+1);
});

test('unprepared small batches still use attribute instancing so their shaders are shared',()=>{
 installSharedInstancing(fakeRenderer());
 const mesh=new InstancedMesh(new BoxGeometry(),new MeshStandardNodeMaterial(),3);
 const node=new InstancedMeshNode(mesh);
 const matrix=node._createInstanceMatrixNode(true,builder);
 assert.ok(node.buffer instanceof InstancedInterleavedBuffer,'instance matrices are a vertex attribute buffer');
 assert.equal(node.buffer.array,mesh.instanceMatrix.array);
 assert.deepEqual(matrix.node.nodes.map(c=>[c.bufferStride,c.bufferOffset]),[[16,0],[16,4],[16,8],[16,12]],'four vec4 columns of one interleaved buffer');
 assert.equal(node.updateType,NodeUpdateType.FRAME);
 mesh.instanceMatrix.needsUpdate=true;node.update({object:mesh});
 assert.equal(node.buffer.version,mesh.instanceMatrix.version);
 node._createInstanceMatrixNode(false,builder);
 assert.equal(node.buffer.array,mesh.instanceMatrix.array);
});

test('dynamic and storage instance matrices keep their own paths',()=>{
 installSharedInstancing(fakeRenderer());
 const dynamic=new InstancedMesh(new BoxGeometry(),new MeshStandardNodeMaterial(),2);
 dynamic.instanceMatrix.setUsage(DynamicDrawUsage);
 const dynamicNode=new InstancedMeshNode(dynamic),columns=dynamicNode._createInstanceMatrixNode(true,builder).node.nodes;
 assert.deepEqual(columns.map(c=>[c.usage,c.bufferStride,c.bufferOffset]),[0,4,8,12].map(offset=>[DynamicDrawUsage,16,offset]));
 const storage=new InstancedMesh(new BoxGeometry(),new MeshStandardNodeMaterial(),2);
 storage.instanceMatrix=new StorageInstancedBufferAttribute(storage.instanceMatrix.array,16);
 const storageNode=new InstancedMeshNode(storage);
 assert.ok(storageNode.isStorageMatrix);
 const matrix=storageNode._createInstanceMatrixNode(true,builder);
 assert.equal(storageNode.buffer,null);
 assert.ok(matrix.isStorageArrayElementNode,'storage matrices still index the storage buffer');
});
