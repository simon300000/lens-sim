import {Compatibility,PCFShadowMap,PCFSoftShadowMap} from 'three/webgpu';
import {Fn,vec2,fract,mix,add,reference,renderGroup,texture} from 'three/tsl';

/** PCFSoft: a separable 4x4 comparison kernel with axis weights [1-f, 1, 1, f],
 * normalized by 9 (three r183's PCFSoftShadowFilter; r186 no longer has it
 * and maps PCFSoftShadowMap to its 5-tap rotated PCF). The lens shading port
 * (garden-shading.wgsl) evaluates exactly this kernel, so raster and lens
 * shadows stay comparable. */
const compareAt=(depthTexture,depthLayer,uv,z)=>{let tap=texture(depthTexture,uv);if(depthTexture.isArrayTexture)tap=tap.depth(depthLayer);return tap.compare(z);};

/** At the snapped texel centers, pair adjacent taps into one hardware bilinear
 * comparison per axis: (2-f) at -1+1/(2-f), (1+f) at 1+f/(1+f). Four filtered
 * comparisons reproduce the sixteen center comparisons, without changing
 * shadow width. Requires a linear comparison sampler (TEXTURE_COMPARE). */
export const bilinearPCFSoftShadowFilter=Fn(({depthTexture,shadowCoord,shadow,depthLayer})=>{
  const size=reference('mapSize','vec2',shadow).setGroup(renderGroup);
  const texel=vec2(1).div(size);
  const f=fract(shadowCoord.xy.mul(size).add(.5)).toVar();
  const uv=shadowCoord.xy.sub(f.mul(texel)).toVar();
  const a=vec2(2).sub(f).toVar(),b=vec2(1).add(f).toVar();
  const lo=vec2(-1).add(vec2(1).div(a)).toVar();
  const hi=vec2(1).add(f.div(b)).toVar();
  const compare=(x,y)=>compareAt(depthTexture,depthLayer,uv.add(vec2(x,y).mul(texel)),shadowCoord.z);
  return compare(lo.x,lo.y).mul(a.x.mul(a.y))
    .add(compare(hi.x,lo.y).mul(b.x.mul(a.y)))
    .add(compare(lo.x,hi.y).mul(a.x.mul(b.y)))
    .add(compare(hi.x,hi.y).mul(b.x.mul(b.y))).mul(1/9);
});

/** The same kernel as nine (partly mixed) point comparisons, for adapters
 * without filtered depth comparison (three emulates compare there). */
export const pcfSoftShadowFilter=Fn(({depthTexture,shadowCoord,shadow,depthLayer})=>{
  const size=reference('mapSize','vec2',shadow).setGroup(renderGroup);
  const texel=vec2(1).div(size),dx=texel.x,dy=texel.y;
  const f=fract(shadowCoord.xy.mul(size).add(.5)).toVar();
  const uv=shadowCoord.xy.sub(f.mul(texel)).toVar();
  const c=(x,y)=>compareAt(depthTexture,depthLayer,uv.add(vec2(x,y)),shadowCoord.z);
  return add(
    c(0,0),c(dx,0),c(0,dy),c(dx,dy),
    mix(c(dx.negate(),0),c(dx.mul(2),0),f.x),
    mix(c(dx.negate(),dy),c(dx.mul(2),dy),f.x),
    mix(c(0,dy.negate()),c(0,dy.mul(2)),f.y),
    mix(c(dx,dy.negate()),c(dx,dy.mul(2)),f.y),
    mix(mix(c(dx.negate(),dy.negate()),c(dx.mul(2),dy.negate()),f.x),mix(c(dx.negate(),dy.mul(2)),c(dx.mul(2),dy.mul(2)),f.x),f.y),
  ).mul(1/9);
});

export const isPCFSoftShadowFilter=filter=>filter===bilinearPCFSoftShadowFilter||filter===pcfSoftShadowFilter;

/** Directional and spot shadows of a PCF renderer use the PCFSoft kernel; custom
 * filters, point lights (three's PointShadowFilter) and other map types keep theirs. */
export function installSoftShadowFilter(scene,renderer){
  if(renderer.shadowMap.type!==PCFShadowMap&&renderer.shadowMap.type!==PCFSoftShadowMap)return;
  const filter=renderer.hasCompatibility(Compatibility.TEXTURE_COMPARE)?bilinearPCFSoftShadowFilter:pcfSoftShadowFilter;
  scene.traverse(light=>{
    if((light.isDirectionalLight||light.isSpotLight)&&light.shadow&&!light.shadow.filterNode)light.shadow.filterNode=filter;
  });
}
