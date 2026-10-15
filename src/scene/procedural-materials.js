import { vec2, vec3, positionWorld, sin, cos, normalMap, reflector, dot, normalize, cameraPosition, pow, mx_noise_float, materialColor } from 'three/tsl';
import { MEADOW, WATER } from './procedural-params.js';
import { setLensMaterial, PROCEDURAL } from './lens-registry.js';

/** Raster TSL graphs of the meadow tint and pond water. The lens evaluator
 * reads the same constants and the registered descriptor. */
export function applyMeadowVariation(material) {
  const variation = mx_noise_float(positionWorld.mul(vec3(...MEADOW.noiseScale))).mul(MEADOW.amplitude).add(MEADOW.bias);
  material.colorNode = materialColor.mul(variation);
  setLensMaterial(material, { kind: PROCEDURAL.MEADOW });
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
