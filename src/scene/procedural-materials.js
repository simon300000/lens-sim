import { vec2, vec3, positionWorld, sin, cos, normalMap, reflector, dot, normalize, cameraPosition, pow, mx_noise_float, materialColor, mix, smoothstep, min, select, float } from 'three/tsl';
import { MEADOW, WATER, GRAVEL } from './procedural-params.js';
import { bumpNormal } from '../kit.js';
import { setLensMaterial, PROCEDURAL } from './lens-registry.js';

/** Raster TSL graphs of the meadow tint and pond water. The lens evaluator
 * reads the same constants and the registered descriptor. */
export function applyMeadowVariation(material) {
  const variation = mx_noise_float(positionWorld.mul(vec3(...MEADOW.noiseScale))).mul(MEADOW.amplitude).add(MEADOW.bias);
  const patch = smoothstep(MEADOW.patchLow, MEADOW.patchHigh, mx_noise_float(positionWorld.mul(vec3(...MEADOW.patchScale)))).mul(MEADOW.patchAmount);
  material.colorNode = materialColor.mul(variation).mul(mix(vec3(1), vec3(...MEADOW.patchTint), patch));
  setLensMaterial(material, { kind: PROCEDURAL.MEADOW });
}

/** Raked karesansui gravel: concentric furrows around each rock, straight
 * furrows elsewhere, and fine stone grain. scene-shading.wgsl mirrors it. */
export function applyRakedGravel(material) {
  const p = positionWorld, G = GRAVEL;
  let ring = null;
  for (const [x, z, r] of G.rocks) {
    const e = p.xz.sub(vec2(x, z)).length().sub(r);
    ring = ring ? min(ring, e) : e;
  }
  const u = select(ring.lessThan(G.ringBand), ring, p.z);
  const k = 2 * Math.PI / G.spacing;
  // The raster preview fades furrows narrower than its pixels to their mean
  // instead of aliasing; lens rays evaluate every furrow at its true scale.
  const resolved = float(1).sub(smoothstep(.3, .7, u.dFdx().abs().add(u.dFdy().abs()).div(G.spacing)));
  const ridge = mix(float(.5), sin(u.mul(k)).mul(.5).add(.5), resolved);
  const grain = mx_noise_float(p.mul(G.grainScale));
  material.colorNode = materialColor.mul(ridge.oneMinus().mul(G.shade).oneMinus()).mul(grain.mul(G.grainContrast).add(1));
  material.normalNode = bumpNormal(ridge.mul(G.depth));
  setLensMaterial(material, { kind: PROCEDURAL.GRAVEL });
  return material;
}

export function applyWaterSurface(water) {
  const p = positionWorld, W = WATER, material = water.material;
  const ripples = sin(p.x.mul(W.rippleA[0]).add(p.z.mul(W.rippleA[1]))).mul(W.rippleAmp0)
    .add(cos(p.x.mul(W.rippleB[0]).add(p.z.mul(W.rippleB[1]))).mul(W.rippleAmp1));
  material.normalNode = normalMap(vec3(ripples.add(.5), ripples.mul(W.normalScaleY / 2).add(.5), 1));
  material.metalness = W.metalness;
  material.roughness = W.roughness;
  const mirror = reflector({ resolutionScale: W.reflectionResolutionScale, bounces: false, generateMipmaps: false });
  mirror.target.rotation.x = -Math.PI / 2;
  water.add(mirror.target);
  mirror.uvNode = mirror.uvNode.add(vec2(ripples.mul(W.reflectionUVOffset[0]), ripples.mul(W.reflectionUVOffset[1])));
  const view = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(dot(view, vec3(0, 1, 0)).clamp(0, 1).oneMinus(), W.fresnelPower).mul(W.fresnelScale).add(W.fresnelBias);
  material.emissiveNode = mirror.rgb.mul(fresnel).mul(W.reflectionGain);
  material.opacity = W.opacity;
  // The lens evaluator samples this reflector's render target for the main
  // camera: a reference-view planar reflection, not traced reflection rays.
  setLensMaterial(material, { kind: PROCEDURAL.WATER, reflector: mirror });
  return mirror;
}
