import * as THREE from 'three/webgpu';
import {normalView,vec4} from 'three/tsl';

/** The normal/depth pass needs surface normals, not PBR lighting or reflectors.
 * Keep procedural normal/vertex graphs and raster state from each material.
 * All objects and GPU resources stay on the renderer's existing device. */
export function installNormalPassReuse({renderer,normalMRT,beautyTarget,camera}) {
  const normalMaterials=new Map();
  const previous=renderer.getRenderObjectFunction();
  let beautyContext=null;
  const normalOutput=vec4(normalView,1);
  function normalMaterial(source){
    let material=normalMaterials.get(source);
    if(source.fragmentNode||source.mrtNode||source.alphaTest>0||source.alphaTestNode||source.alphaHash||source.normalMap||source.bumpMap||source.clippingPlanes?.length)return source;
    if(material&&material.userData.sourceVersion===source.version)return material;
    material?.dispose();
    material=new THREE.MeshStandardNodeMaterial();
    material.userData.sourceVersion=source.version;
    material.name='Surface normal prepass';
    for(const key of ['side','transparent','forceSinglePass','depthTest','depthWrite','depthFunc','colorWrite','blending','blendSrc','blendDst','blendEquation','blendSrcAlpha','blendDstAlpha','blendEquationAlpha','premultipliedAlpha','polygonOffset','polygonOffsetFactor','polygonOffsetUnits','flatShading','wireframe','vertexNode','positionNode','geometryNode','depthNode','normalNode','clippingPlanes','clipIntersection','clipShadows']){
      if(source[key]!==undefined)material[key]=source[key];
    }
    material.fog=false;
    material.fragmentNode=normalOutput;
    normalMaterials.set(source,material);
    return material;
  }
  function renderObject(object,scene,passCamera,geometry,material,...rest){
    if(passCamera===camera&&renderer.getRenderTarget()===beautyTarget)beautyContext=renderer.contextNode;
    if(renderer.getMRT()===normalMRT&&object.isMesh)material=normalMaterial(material);
    if(previous)previous.call(renderer,object,scene,passCamera,geometry,material,...rest);
    else renderer.renderObject(object,scene,passCamera,geometry,material,...rest);
  }
  renderer.setRenderObjectFunction(renderObject);
  return {get beautyContext(){return beautyContext;},dispose(){if(renderer.getRenderObjectFunction()===renderObject)renderer.setRenderObjectFunction(previous);for(const material of normalMaterials.values())material.dispose();normalMaterials.clear();}};
}
