import {InstancedMesh,BufferGeometry,InstancedInterleavedBuffer,InterleavedBufferAttribute} from 'three/webgpu';

/** Batch identical static opaque siblings without baking local geometry. Local
 * procedural wood coordinates, parent transforms and shadow layers stay intact. */
export function batchStaticSiblings(root){
  let savedDraws=0;
  root.traverse(parent=>{
    const groups=new Map();
    for(const object of parent.children){
      const material=object.material;
      if(!object.isMesh||object.isInstancedMesh||object.children.length||!object.visible||Array.isArray(material)||material.transparent||material.opacity<1||object.onBeforeRender!==InstancedMesh.prototype.onBeforeRender||Object.keys(object.userData).length)continue;
      const key=[object.geometry.id,material.id,object.castShadow,object.receiveShadow,object.layers.mask,object.renderOrder,object.frustumCulled].join('/');
      const group=groups.get(key)??[];group.push(object);groups.set(key,group);
    }
    for(const objects of groups.values()){
      if(objects.length<2)continue;
      const source=objects[0],batch=new InstancedMesh(source.geometry,source.material,objects.length);
      batch.name=`Static ${source.name||'geometry'} batch`;
      batch.castShadow=source.castShadow;batch.receiveShadow=source.receiveShadow;
      batch.layers.mask=source.layers.mask;batch.renderOrder=source.renderOrder;batch.frustumCulled=source.frustumCulled;
      objects.forEach((object,i)=>{object.updateMatrix();batch.setMatrixAt(i,object.matrix);parent.remove(object);});
      batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();parent.add(batch);savedDraws+=objects.length-1;
    }
  });
  return {savedDraws};
}

/** Large woodland batches span both sides of the view. Spatial cells let the
 * renderer cull whole invisible regions for each main, reflected and shadow
 * camera, while retaining every original instance and its exact float matrix. */
export function partitionStaticInstances(root,{cellSize=64,minInstances=2048}={}){
  let addedBatches=0;
  root.traverse(parent=>{
    for(const source of [...parent.children]){
      if(!source.isInstancedMesh||!source.visible||source.count<minInstances||Array.isArray(source.material)||source.material.transparent||source.morphTexture||source.children.length||!source.frustumCulled)continue;
      const cells=new Map(),data=source.instanceMatrix.array;
      for(let i=0;i<source.count;i++){
        const key=`${Math.floor(data[i*16+12]/cellSize)}/${Math.floor(data[i*16+14]/cellSize)}`;
        const ids=cells.get(key)??[];ids.push(i);cells.set(key,ids);
      }
      if(cells.size<2)continue;
      source.updateMatrix();
      for(const [key,ids] of cells){
        const batch=new InstancedMesh(source.geometry,source.material,ids.length);
        batch.name=`${source.name||'Woodland'} cell ${key}`;
        batch.position.copy(source.position);batch.quaternion.copy(source.quaternion);batch.scale.copy(source.scale);
        batch.castShadow=source.castShadow;batch.receiveShadow=source.receiveShadow;batch.layers.mask=source.layers.mask;batch.renderOrder=source.renderOrder;
        for(let j=0;j<ids.length;j++)batch.instanceMatrix.array.set(data.subarray(ids[j]*16,ids[j]*16+16),j*16);
        if(source.instanceColor){batch.instanceColor=source.instanceColor.clone();batch.instanceColor.array=new Float32Array(ids.length*3);batch.instanceColor.count=ids.length;
          for(let j=0;j<ids.length;j++)batch.instanceColor.array.set(source.instanceColor.array.subarray(ids[j]*3,ids[j]*3+3),j*3);
        }
        batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();parent.add(batch);
      }
      parent.remove(source);addedBatches+=cells.size-1;
    }
  });
  return {addedBatches};
}

export const INSTANCE_MATRIX_ATTRIBUTES=Object.freeze(['instanceMatrix0','instanceMatrix1','instanceMatrix2','instanceMatrix3']);
export const INSTANCE_COLOR_ATTRIBUTE='instanceColor';

/** Give every InstancedMesh its own thin geometry: the source geometry's index
 * and vertex attributes by reference, plus its instance matrices (four vec4
 * columns of one instanced interleaved buffer over the mesh's own array) and
 * instance colours as ordinary geometry attributes. Three then resolves the
 * instance data per draw, so batches of one material can share a single shader
 * build instead of compiling one per batch and pass (see three-interop). */
export function shareInstanceAttributes(root){
  let shared=0;
  root.traverse(mesh=>{
    if(!mesh.isInstancedMesh||mesh.geometry.userData.instanceSource)return;
    const source=mesh.geometry,geometry=new BufferGeometry();
    geometry.name=source.name;
    if(source.index)geometry.setIndex(source.index);
    for(const [name,attribute] of Object.entries(source.attributes))geometry.setAttribute(name,attribute);
    for(const [name,targets] of Object.entries(source.morphAttributes))geometry.morphAttributes[name]=targets;
    geometry.morphTargetsRelative=source.morphTargetsRelative;
    for(const group of source.groups)geometry.addGroup(group.start,group.count,group.materialIndex);
    geometry.setDrawRange(source.drawRange.start,source.drawRange.count);
    if(!source.boundingSphere)source.computeBoundingSphere();
    geometry.boundingSphere=source.boundingSphere.clone();
    if(source.boundingBox)geometry.boundingBox=source.boundingBox.clone();
    const matrices=new InstancedInterleavedBuffer(mesh.instanceMatrix.array,16,1);
    matrices.setUsage(mesh.instanceMatrix.usage);matrices.sourceVersion=mesh.instanceMatrix.version;
    INSTANCE_MATRIX_ATTRIBUTES.forEach((name,column)=>geometry.setAttribute(name,new InterleavedBufferAttribute(matrices,4,column*4)));
    if(mesh.instanceColor)geometry.setAttribute(INSTANCE_COLOR_ATTRIBUTE,mesh.instanceColor);
    geometry.userData.instanceSource=source;
    mesh.geometry=geometry;shared++;
  });
  return {shared};
}

/** True when the object's geometry still carries its own live instance data. */
export function hasSharedInstanceAttributes(object){
  const geometry=object?.geometry;
  if(!object?.isInstancedMesh||!geometry?.userData.instanceSource||Array.isArray(object.morphTargetInfluences))return false;
  const matrices=geometry.attributes[INSTANCE_MATRIX_ATTRIBUTES[0]];
  if(matrices?.data?.array!==object.instanceMatrix.array)return false;
  return !object.instanceColor||geometry.attributes[INSTANCE_COLOR_ATTRIBUTE]===object.instanceColor;
}

/** Geometry identity for caches keyed on vertex data, seeing through the per-mesh instance wrapper. */
export function sourceGeometry(geometry){return geometry.userData?.instanceSource??geometry;}
