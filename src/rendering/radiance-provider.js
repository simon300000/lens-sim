import {normalizeShaderEOL} from './shader-source.js';
import {SCENE_INTERSECTOR_WGSL,SCENE_COMPOSITE_WGSL} from './scene-wgsl.js';

/** Radiance provider: what a lens ray sees, spliced into the tracer's shading
 * stage. The engine owns bindings 0..23 (optics, sampling, accumulation, BVH,
 * staged packets); a provider declares its resources from PROVIDER_BINDING_BASE.
 *
 *   {
 *     kind: 'surface' | 'ray',
 *     label: string,
 *     wgsl(base) -> string,             // declarations @binding(base + i) and the functions below
 *     bindings(base) -> GPUBindGroupEntry[],  // current resources, one entry per declared binding
 *     revision: number,                 // changes whenever bindings(base) would return other resources
 *     ready?: boolean,                  // false until the resources exist (default true)
 *     resources?: { storageBuffers, uniformBuffers, sampledTextures, samplers, storageTextures },
 *   }
 *
 * kind 'surface' (garden PBR, provider #1): raygen -> BVH trace -> shade. WGSL defines
 *   fn sceneShade(s: SceneSurface, wo: vec3f, key: u32) -> SceneShade
 *   fn sceneEnvironmentRadiance(d: vec3f) -> vec3f
 * The engine reconstructs SceneSurface at the nearest hit and composites up
 * to six alpha-blended layers along the same ray (scene-surface.wgsl).
 *
 * kind 'ray' (e.g. a raster radiance lookup): raygen -> provider; no trace stage
 * and no BVH is required. WGSL defines
 *   fn rayRadiance(ray: LensRay) -> RayRadiance
 * with LensRay {origin, lambda, direction, weight, key} in the tracer's world
 * frame (after its origin recentring) and the ray's exit point on the front
 * element as origin (ray-radiance.wgsl).
 *
 * Every declared binding must be statically used by the provider's WGSL: the
 * pipelines use automatic layouts. Work tallies (workCounters[WORK_*]) may be
 * incremented by provider code; they are compiled only into the counting variant. */
export const PROVIDER_BINDING_BASE=24;
export const PROVIDER_KINDS=Object.freeze(['surface','ray']);
const RESOURCE_KEYS=['storageBuffers','uniformBuffers','sampledTextures','samplers','storageTextures'];

export function providerSource(provider,base=PROVIDER_BINDING_BASE){
  if(!PROVIDER_KINDS.includes(provider?.kind))throw new TypeError(`Radiance provider kind must be one of ${PROVIDER_KINDS.join(', ')}`);
  const source=typeof provider.wgsl==='function'?provider.wgsl(base):provider.wgsl;
  if(typeof source!=='string')throw new TypeError(`${provider.label??'Radiance provider'}: wgsl(base) must return WGSL source`);
  return normalizeShaderEOL(source);
}
/** Per-stage resource counts the provider adds to the scene kernel. */
export function providerResources(provider){
  return Object.fromEntries(RESOURCE_KEYS.map(key=>[key,provider?.resources?.[key]??0]));
}

/** Smallest useful ray provider: constant RGB radiance for every ray (a white
 * furnace for the lens alone). No resources; a template for host providers. */
export function createConstantRayProvider(rgb=[1,1,1],{label='Constant ray radiance'}={}){
  const [r,g,b]=rgb.map(v=>{const s=String(Number(v));return /[.eE]/.test(s)?s:s+'.0';});
  return {kind:'ray',label,revision:0,ready:true,
    wgsl:()=>`fn rayRadiance(ray: LensRay) -> RayRadiance { return RayRadiance(vec3f(${r}, ${g}, ${b}), SCENE_BACKGROUND, -1.0, 0u); }\n`,
    bindings:()=>[]};
}

/** A surface provider (e.g. the garden PBR port) as a ray provider: each ray
 * traces the scene BVH itself and composites through transparent layers with
 * the staged surface path's code. It validates the ray-cache path against
 * today's output, and serves hosts that want the BVH for some rays.
 * scene: the tracer's scene BVH (scene-bvh.js). */
export function createSurfaceRayProvider({provider,scene,label=`${provider.label??'Surface provider'} via BVH rays`}){
  if(provider.kind!=='surface')throw new TypeError('createSurfaceRayProvider wraps a surface provider');
  let revision=0,bound=null;
  const resources=providerResources(provider);
  const declarations=base=>[['sceneNodes','array<BvhNode>'],['sceneInstances','array<SceneInstance>'],['sceneTriangles','array<SceneTriangle>'],['sceneVertices','array<SceneVertex>']]
    .map(([name,type],i)=>`@group(0) @binding(${base+i}) var<storage,read> ${name}: ${type};`).join('\n')+'\n';
  return {kind:'ray',label,
    resources:{...resources,storageBuffers:resources.storageBuffers+4},
    get ready(){return scene.ready&&provider.ready!==false;},
    get revision(){const key=scene.revision+'/'+provider.revision;if(key!==bound){bound=key;revision++;}return revision;},
    wgsl:base=>declarations(base)+SCENE_INTERSECTOR_WGSL+SCENE_COMPOSITE_WGSL+providerSource(provider,base+4)+`
fn rayRadiance(ray: LensRay) -> RayRadiance {
  let s = sceneRadiance(ray.origin, ray.direction, ray.key);
  return RayRadiance(s.rgb, s.status, s.firstT, select(0u, RAY_OUTSIDE_REFERENCE, s.reflectionOutside) | (s.layers << 16u));
}
`,
    bindings:base=>[...scene.bindings(base),...provider.bindings(base+4)]};
}
