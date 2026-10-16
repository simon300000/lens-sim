import {InstancedMesh} from 'three/webgpu';

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
