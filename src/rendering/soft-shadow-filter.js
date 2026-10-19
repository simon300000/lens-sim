import {Compatibility,PCFSoftShadowMap} from 'three/webgpu';
import {Fn,vec2,fract,reference,renderGroup,texture} from 'three/tsl';

/** Three r183 PCFSoft uses a separable 4x4 comparison kernel with axis
 * weights [1-f, 1, 1, f], normalized by 3. At the snapped texel centers,
 * pair adjacent taps into one hardware bilinear comparison per axis:
 * (2-f) at -1+1/(2-f), (1+f) at 1+f/(1+f). Four filtered comparisons
 * reproduce the sixteen center comparisons, without changing shadow width.
 * Requires a linear comparison sampler; point/cube shadows stay unchanged. */
export const bilinearPCFSoftShadowFilter=Fn(({depthTexture,shadowCoord,shadow,depthLayer})=>{
  const size=reference('mapSize','vec2',shadow).setGroup(renderGroup);
  const texel=vec2(1).div(size);
  const f=fract(shadowCoord.xy.mul(size).add(.5)).toVar();
  const uv=shadowCoord.xy.sub(f.mul(texel)).toVar();
  const a=vec2(2).sub(f).toVar(),b=vec2(1).add(f).toVar();
  const lo=vec2(-1).add(vec2(1).div(a)).toVar();
  const hi=vec2(1).add(f.div(b)).toVar();
  const compare=(x,y)=>{
    let tap=texture(depthTexture,uv.add(vec2(x,y).mul(texel)));
    if(depthTexture.isArrayTexture)tap=tap.depth(depthLayer);
    return tap.compare(shadowCoord.z);
  };
  return compare(lo.x,lo.y).mul(a.x.mul(a.y))
    .add(compare(hi.x,lo.y).mul(b.x.mul(a.y)))
    .add(compare(lo.x,hi.y).mul(a.x.mul(b.y)))
    .add(compare(hi.x,hi.y).mul(b.x.mul(b.y))).mul(1/9);
});

export function installSoftShadowFilter(scene,renderer){
  if(renderer.shadowMap.type!==PCFSoftShadowMap||!renderer.hasCompatibility(Compatibility.TEXTURE_COMPARE))return;
  scene.traverse(light=>{
    if((light.isDirectionalLight||light.isSpotLight)&&light.shadow&&!light.shadow.filterNode)light.shadow.filterNode=bilinearPCFSoftShadowFilter;
  });
}
