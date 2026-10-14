import * as THREE from 'three/webgpu';
import { mrt, output, normalView } from 'three/tsl';

/** Explicit capture, never attached to the final display's node graph. */
export function createRasterCache({renderer,scene,interop,width=768}) {
  const camera=new THREE.PerspectiveCamera(50,1.5,.02,450);
  const target=new THREE.RenderTarget(width,Math.round(width/1.5),{type:THREE.HalfFloatType,count:2,samples:0,depthBuffer:true});
  // Three r183 MRT resolves output locations by EXACT texture.name.
  target.texture.name='output';
  for(const texture of target.textures){texture.colorSpace=THREE.LinearSRGBColorSpace;texture.generateMipmaps=false;}
  target.textures[1].name='normal';
  target.depthTexture=new THREE.DepthTexture(width,Math.round(width/1.5),THREE.FloatType);
  const captureMRT=mrt({output,normal:normalView});
  let revision=-1,captures=0,captureMs=null,horizontalFov=0;
  return {
    camera,target,
    get captures(){return captures;},get revision(){return revision;},get captureMs(){return captureMs;},
    get horizontalFov(){return horizontalFov;},
    capture({sourceCamera,sceneRevision,focalLengthMm,sensorMm=[36,24],force=false}){
      if(!force&&revision===sceneRevision)return false;
      const start=performance.now();
      const nominal=2*Math.atan(sensorMm[0]/(2*Math.abs(focalLengthMm)))*180/Math.PI;
      horizontalFov=Math.min(140,Math.max(50,nominal*1.6+10));
      camera.fov=2*Math.atan(Math.tan(horizontalFov*Math.PI/360)/1.5)*180/Math.PI;
      camera.position.copy(sourceCamera.position);camera.quaternion.copy(sourceCamera.quaternion);
      camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
      const previous=renderer.getRenderTarget(),previousMRT=renderer.getMRT();
      try{renderer.setRenderTarget(target);renderer.setMRT(captureMRT);renderer.render(scene,camera);}
      finally{renderer.setMRT(previousMRT);renderer.setRenderTarget(previous);}
      captures++;revision=sceneRevision;captureMs=performance.now()-start;return true;
    },
    textures(){return {color:interop.texture(target.textures[0]),normal:interop.texture(target.textures[1]),depth:interop.texture(target.depthTexture)};},
    invalidate(){revision=-1;},
    dispose(){target.dispose();},
  };
}
