/** Single source of truth for procedural material constants. The raster TSL
 * graphs (kit.js, main.js) and the lens compute evaluator (scene-shading.wgsl,
 * via packMaterials) both read these values, so they cannot drift apart.
 * Units: positions are metres in the space named per field.
 */
export const WOOD = Object.freeze({
  // positionLocal (InstancedMesh: instanceMatrix * geometry position).
  noiseScale: [3.2, 25, 3.2],
  grainFrequency: 185,   // radians per local unit along y
  grainWarp: 12,         // radians per unit of MaterialX Perlin noise
  colorLow: .77, colorHigh: 1.08,
  colorGrain: .48, colorNoise: .2, colorBias: .2,
  roughnessBase: .70, roughnessGrain: .10,
  bumpHeight: .00028,    // metres of height per unit grain
});

export const MEADOW = Object.freeze({
  // positionWorld scaling of the multiplicative colour variation.
  noiseScale: [2.5, 1, 2.5], amplitude: .065, bias: .95,
  // Broad patches of drier, yellower turf: mix towards patchTint by
  // smoothstep(patchLow, patchHigh, noise(positionWorld * patchScale)) * patchAmount.
  patchScale: [.19, .5, .23], patchLow: -.05, patchHigh: .45, patchAmount: .55,
  patchTint: [1.22, 1.06, .62],
});

export const GRAVEL = Object.freeze({
  // Raked karesansui gravel, positionWorld metres. Rings of rake lines follow
  // each rock (xz centre, radius); outside every ring band the lines run along x.
  rocks: [[-5.45, 11.25, .62], [-4.42, 12.32, .36], [.15, 11.95, .5]],
  ringBand: .62,              // metres of concentric rings beyond each rock radius
  spacing: .085,              // metres between rake furrows
  depth: .014,                // furrow height amplitude, metres
  shade: .3,                  // furrow cavity darkening
  grainScale: 38,             // stones per metre (MaterialX noise frequency)
  grainContrast: .2,
  roughness: .93,
});

export const WATER = Object.freeze({
  // ripple(p) = sin(a·p.xz) * amp0 + cos(b·p.xz) * amp1, world metres.
  rippleA: [3.5, 2.3], rippleAmp0: .018,
  rippleB: [5, -4.1], rippleAmp1: .012,
  // normalMap(vec3(r + .5, r * .7 + .5, 1)) -> tangent-space (2r, 1.4r, 1).
  normalScaleX: 2, normalScaleY: 1.4,
  reflectionUVOffset: [.016, .01],
  fresnelPower: 5, fresnelScale: .98, fresnelBias: .02,
  reflectionGain: 2.2,
  opacity: .35, roughness: .115, metalness: 0,
  reflectionResolutionScale: .45,
});
