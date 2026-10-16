import test from 'node:test';
import assert from 'node:assert/strict';
import {Group,Mesh,BoxGeometry,MeshStandardNodeMaterial} from 'three/webgpu';
import {batchStaticSiblings} from '../src/scene/static-batches.js';
import {createControlStore} from '../src/rendering/control-store.js';
test('static batches preserve sibling transforms, materials and shadow layers',()=>{
 const root=new Group(),geometry=new BoxGeometry(),material=new MeshStandardNodeMaterial();root.position.set(2,3,4);
 const matrices=[];for(let i=0;i<3;i++){const mesh=new Mesh(geometry,material);mesh.position.set(i,2*i,3*i);mesh.scale.set(1,2,3);mesh.castShadow=true;mesh.layers.set(2);mesh.updateMatrix();matrices.push(mesh.matrix.clone());root.add(mesh);}
 const transparent=new Mesh(geometry,new MeshStandardNodeMaterial({transparent:true,opacity:.5}));root.add(transparent);
 assert.equal(batchStaticSiblings(root).savedDraws,2);assert.equal(root.children.length,2);assert.ok(root.children.includes(transparent));
 const batch=root.children.find(o=>o.isInstancedMesh);assert.equal(batch.count,3);assert.equal(batch.material,material);assert.equal(batch.castShadow,true);assert.equal(batch.layers.mask,4);
 for(let i=0;i<3;i++){const actual=matrices[i].clone();batch.getMatrixAt(i,actual);assert.deepEqual(actual.elements,matrices[i].elements);}
 assert.equal(batchStaticSiblings(root).savedDraws,0);
});
test('runtime state reads reuse identity while public snapshots stay isolated',()=>{
 const store=createControlStore();assert.equal(store.peekState(),store.peekState());const snapshot=store.getState();snapshot.optics.fNumber=99;assert.notEqual(store.peekState().optics.fNumber,99);
 const before=store.peekState();store.update({mode:'lens'});assert.notEqual(before,store.peekState());assert.equal(before.mode,'raster');
});

test('spatial partition preserves exact instance matrices and colors',async()=>{
 const {InstancedMesh,Matrix4,Color}=await import('three/webgpu');const {partitionStaticInstances}=await import('../src/scene/static-batches.js');
 const root=new Group(),geometry=new BoxGeometry(),material=new MeshStandardNodeMaterial(),source=new InstancedMesh(geometry,material,4);
 const matrices=[];for(let i=0;i<4;i++){const matrix=new Matrix4().makeTranslation((i-2)*70,0,i);source.setMatrixAt(i,matrix);source.setColorAt(i,new Color(i/4,.5,.2));matrices.push(Array.from(source.instanceMatrix.array.slice(i*16,i*16+16)));}
 source.castShadow=true;source.layers.set(3);root.add(source);const colors=Array.from(source.instanceColor.array);
 assert.equal(partitionStaticInstances(root,{minInstances:2}).addedBatches,3);
 const out=[];root.traverse(o=>{if(o.isInstancedMesh){assert.equal(o.castShadow,true);assert.equal(o.layers.mask,8);for(let i=0;i<o.count;i++)out.push({matrix:Array.from(o.instanceMatrix.array.slice(i*16,i*16+16)),color:Array.from(o.instanceColor.array.slice(i*3,i*3+3))});}});
 assert.equal(out.length,4);for(let i=0;i<4;i++){assert.deepEqual(out[i].matrix,matrices[i]);assert.deepEqual(out[i].color,colors.slice(i*3,i*3+3));}
});
