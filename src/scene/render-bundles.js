import {BundleGroup,Frustum,Matrix4,Object3D,Sphere,Vector3} from 'three/webgpu';

/** Record the static scene into WebGPU render bundles.
 *
 * Three's WebGPU renderer spends ~10 µs of main-thread time per draw call
 * (chain-map lookup, pipeline/binding checks, setBindGroup/setVertexBuffer/
 * draw through the browser's command serialisation). This scene issues ~370
 * draws per scene pass and three scene passes per raster frame (normal/depth
 * prepass, 4x MSAA beauty, water reflection), so submission alone took
 * ~11 ms of every frame on Safari. Objects under a BundleGroup are recorded
 * into a GPURenderBundle once per (group, camera, render pass) and replayed
 * afterwards for a handful of calls, while Three still refreshes their
 * uniforms per frame.
 *
 * A recorded bundle contains exactly the draws present when it was recorded,
 * so every bundled mesh is drawn without Three's per-object frustum culling.
 * Culling moves to the group level instead: each bundle group carries the
 * world bounding sphere of its contents and is hidden per camera in
 * scene.onBeforeRender, and restored in onAfterRender so traversals (lens
 * scene extraction, picking, scene diagnostics) never see a culled group.
 * Large or widespread meshes (woodland cells, dense planting batches) get a
 * group of their own so cells behind the camera are still skipped; the small
 * joinery, stones and furniture of a root share one group.
 *
 * Only opaque, childless, visible meshes without custom onBeforeRender hooks
 * are moved: transparent surfaces keep Three's per-frame depth sorting,
 * lights and animated objects stay where they are. World transforms are
 * preserved (Object3D.attach).
 *
 * Bundles are recorded through the renderer's current render-object hook, so
 * they must only be enabled after startup warm-up (which deliberately draws
 * partial scenes) has finished. A bundle also bakes the GPU bind groups of
 * its draws: whenever a texture those materials sample is recreated (the AO
 * and water-reflection targets follow the drawing-buffer size, so every
 * resize or pixel-ratio change), call invalidate() before the next frame or
 * the replayed bundle references a destroyed texture ("Invalid
 * CommandEncoder"). Uniform value changes need no re-record here: every scene
 * material is refreshed per object and frame by NodeMaterialObserver. */
export function bundleStaticContent(scene,roots,{largeInstances=256,largeRadius=40}={}){
  const groups=[];
  const eligible=object=>object.isMesh&&!object.isPoints&&!object.isSprite&&!object.isLine&&object.visible&&object.children.length===0
    &&!Array.isArray(object.material)&&object.material&&!object.material.transparent&&object.material.opacity>=1&&!object.material.alphaHash
    &&object.onBeforeRender===Object3D.prototype.onBeforeRender&&object.onAfterRender===Object3D.prototype.onAfterRender
    &&!object.userData.lensRole?.startsWith('environment')&&!object.isSkinnedMesh&&!object.morphTargetInfluences;
  const worldSphere=(mesh,target)=>{
    const local=mesh.isInstancedMesh?(mesh.boundingSphere??(mesh.computeBoundingSphere(),mesh.boundingSphere)):(mesh.geometry.boundingSphere??(mesh.geometry.computeBoundingSphere(),mesh.geometry.boundingSphere));
    return target.copy(local).applyMatrix4(mesh.matrixWorld);
  };
  const sphere=new Sphere();
  function createGroup(root,name){
    const group=new BundleGroup();group.name=name;
    // Recording starts with enable(); until then the group renders like any Group.
    group.isBundleGroup=false;group.userData.bounds=new Sphere();group.userData.empty=true;
    root.add(group);group.updateWorldMatrix(true,false);groups.push(group);return group;
  }
  function attach(group,mesh){
    worldSphere(mesh,sphere);
    const bounds=group.userData.bounds;
    if(group.userData.empty){bounds.copy(sphere);group.userData.empty=false;}else bounds.union(sphere);
    group.attach(mesh);
    // The bundle must contain every draw regardless of the recording camera.
    mesh.frustumCulled=false;
  }
  let bundled=0;
  for(const root of roots){
    if(!root)continue;
    root.updateWorldMatrix(true,true);
    const meshes=[];root.traverse(object=>{if(eligible(object))meshes.push(object);});
    if(!meshes.length)continue;
    let shared=null;
    for(const mesh of meshes){
      const large=(mesh.isInstancedMesh&&mesh.count>=largeInstances)||worldSphere(mesh,sphere).radius>=largeRadius;
      if(large)attach(createGroup(root,`${mesh.name||'mesh'} render bundle`),mesh);
      else attach(shared??=createGroup(root,`${root.name||'static'} render bundle`),mesh);
      bundled++;
    }
  }
  // Parents holding several groups get their children ordered near-to-far per render.
  const sortedParents=[...new Set(groups.map(group=>group.parent))].filter(parent=>groups.filter(group=>group.parent===parent).length>=2);
  const originalIndex=new WeakMap();
  for(const parent of sortedParents)parent.children.forEach((child,index)=>originalIndex.set(child,index));
  // Group-level culling per camera, including reflection and shadow cameras.
  const frustum=new Frustum(),projection=new Matrix4();
  const previousBefore=scene.onBeforeRender,previousAfter=scene.onAfterRender;
  // Recording a group's bundle (render objects, bind groups, bundle encoder)
  // costs tens of milliseconds per camera and pass. The frame after enable()
  // or invalidate() therefore draws every group so all bundles are recorded
  // at once, instead of in hitches as groups first enter the view.
  let culled=0,recordAll=false,distanceLimit=()=>Infinity;
  const cameraPosition=new Vector3();
  scene.onBeforeRender=function(renderer,passScene,camera,renderTarget,...rest){
    if(recordAll||camera.isArrayCamera===true){for(const group of groups)group.visible=true;}
    else{
      projection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projection,camera.coordinateSystem,camera.reversedDepth);
      // Secondary passes (AO prepass, water reflection) may skip groups whose nearest
      // point is beyond a pass-specific distance; the beauty pass keeps everything.
      const limit=distanceLimit(renderer,camera,renderTarget);
      cameraPosition.setFromMatrixPosition(camera.matrixWorld);
      culled=0;
      for(const group of groups){
        const bounds=group.userData.bounds,near=bounds.center.distanceTo(cameraPosition)-bounds.radius;
        group.userData.near=near;
        group.visible=frustum.intersectsSphere(bounds)&&(limit===Infinity||near<=limit);
        if(!group.visible)culled++;
      }
      // Bundles execute in traversal order, not Three's per-frame depth sort: order sibling
      // groups near-to-far so dense far cells are rejected by early depth testing.
      for(const parent of sortedParents)parent.children.sort((a,b)=>(a.userData.near??-Infinity)-(b.userData.near??-Infinity));
    }
    previousBefore.call(this,renderer,passScene,camera,renderTarget,...rest);
  };
  scene.onAfterRender=function(...args){
    for(const group of groups)group.visible=true;
    // Traversals outside rendering (scene extraction, diagnostics) see the original order.
    for(const parent of sortedParents)parent.children.sort((a,b)=>(originalIndex.get(a)??Infinity)-(originalIndex.get(b)??Infinity));
    previousAfter.call(this,...args);
  };
  return {
    groups,bundled,
    get culledLastRender(){return culled;},
    /** Start recording. Call only after every warm-up pass that draws partial scenes. */
    enable(){for(const group of groups){group.isBundleGroup=true;group.needsUpdate=true;}recordAll=true;},
    /** Re-record every bundle on the next render. Not needed for uniform value
     * changes: every scene material here refreshes per object and frame
     * (NodeMaterialObserver.hasNode via the AO context and node slots). */
    invalidate(){for(const group of groups)group.needsUpdate=true;recordAll=true;},
    /** Draw every group on the next frame so externally invalidated bundles re-record at once. */
    recordAllNextFrame(){recordAll=true;},
    /** (renderer, camera, renderTarget) → metres: groups entirely beyond this distance are
     * skipped for that render. Return Infinity (the default) to keep everything. */
    setDistanceLimit(fn){distanceLimit=typeof fn==='function'?fn:()=>Infinity;},
    /** The application frame (all scene passes) has been submitted: resume culling. */
    frameRendered(){recordAll=false;},
    dispose(){scene.onBeforeRender=previousBefore;scene.onAfterRender=previousAfter;for(const group of groups){group.visible=true;group.isBundleGroup=false;}},
  };
}
