import gardenShadingSource from './garden-shading.wgsl.js';
import { TEST_CHART_WGSL } from '../scene/test-chart-patterns.js';
import { DFG_WGSL } from './dfg-lut.js';
import { WOOD, MEADOW, WATER, GRAVEL } from '../scene/procedural-params.js';
import { PROVIDER_BINDING_BASE } from './radiance-provider.js';

/** Generated from procedural-params.js: the raster TSL graphs use the same object. */
const f = x => { const s = String(x); return /[.eE]/.test(s) ? s : s + '.0'; };
const v2 = a => `vec2f(${a.map(f).join(', ')})`, v3 = a => `vec3f(${a.map(f).join(', ')})`;
export const PROCEDURAL_WGSL = `
const WOOD_NOISE_SCALE: vec3f = ${v3(WOOD.noiseScale)};
const WOOD_GRAIN_FREQUENCY: f32 = ${f(WOOD.grainFrequency)};
const WOOD_GRAIN_WARP: f32 = ${f(WOOD.grainWarp)};
const WOOD_COLOR_LOW: f32 = ${f(WOOD.colorLow)};
const WOOD_COLOR_HIGH: f32 = ${f(WOOD.colorHigh)};
const WOOD_COLOR_GRAIN: f32 = ${f(WOOD.colorGrain)};
const WOOD_COLOR_NOISE: f32 = ${f(WOOD.colorNoise)};
const WOOD_COLOR_BIAS: f32 = ${f(WOOD.colorBias)};
const WOOD_ROUGHNESS_BASE: f32 = ${f(WOOD.roughnessBase)};
const WOOD_ROUGHNESS_GRAIN: f32 = ${f(WOOD.roughnessGrain)};
const WOOD_BUMP_HEIGHT: f32 = ${f(WOOD.bumpHeight)};
const MEADOW_NOISE_SCALE: vec3f = ${v3(MEADOW.noiseScale)};
const MEADOW_AMPLITUDE: f32 = ${f(MEADOW.amplitude)};
const MEADOW_BIAS: f32 = ${f(MEADOW.bias)};
const MEADOW_PATCH_SCALE: vec3f = ${v3(MEADOW.patchScale)};
const MEADOW_PATCH_LOW: f32 = ${f(MEADOW.patchLow)};
const MEADOW_PATCH_HIGH: f32 = ${f(MEADOW.patchHigh)};
const MEADOW_PATCH_AMOUNT: f32 = ${f(MEADOW.patchAmount)};
const MEADOW_PATCH_TINT: vec3f = ${v3(MEADOW.patchTint)};
const GRAVEL_ROCK_COUNT: u32 = ${GRAVEL.rocks.length}u;
const GRAVEL_ROCKS = array<vec3f, ${GRAVEL.rocks.length}>(${GRAVEL.rocks.map(v3).join(', ')});
const GRAVEL_RING_BAND: f32 = ${f(GRAVEL.ringBand)};
const GRAVEL_SPACING: f32 = ${f(GRAVEL.spacing)};
const GRAVEL_DEPTH: f32 = ${f(GRAVEL.depth)};
const GRAVEL_SHADE: f32 = ${f(GRAVEL.shade)};
const GRAVEL_GRAIN_SCALE: f32 = ${f(GRAVEL.grainScale)};
const GRAVEL_GRAIN_CONTRAST: f32 = ${f(GRAVEL.grainContrast)};
const WATER_RIPPLE_A: vec2f = ${v2(WATER.rippleA)};
const WATER_RIPPLE_AMP0: f32 = ${f(WATER.rippleAmp0)};
const WATER_RIPPLE_B: vec2f = ${v2(WATER.rippleB)};
const WATER_RIPPLE_AMP1: f32 = ${f(WATER.rippleAmp1)};
const WATER_NORMAL_X: f32 = ${f(WATER.normalScaleX)};
const WATER_NORMAL_Y: f32 = ${f(WATER.normalScaleY)};
const WATER_REFLECTION_UV: vec2f = ${v2(WATER.reflectionUVOffset)};
const WATER_FRESNEL_POWER: f32 = ${f(WATER.fresnelPower)};
const WATER_FRESNEL_SCALE: f32 = ${f(WATER.fresnelScale)};
const WATER_FRESNEL_BIAS: f32 = ${f(WATER.fresnelBias)};
const WATER_REFLECTION_GAIN: f32 = ${f(WATER.reflectionGain)};
`;
export const GARDEN_SHADING_WGSL = DFG_WGSL + PROCEDURAL_WGSL + TEST_CHART_WGSL + gardenShadingSource;
/** Garden resources: the material/star table, then the raster lighting bridge
 * (lighting-resources.js) in its binding order. */
export function gardenBindingDeclarations(base = PROVIDER_BINDING_BASE) {
  const decl = [['var<storage,read> sceneTables', 'array<vec4<u32>>'], ['var<uniform> sceneLighting', 'SceneLighting'],
    ['var sceneSunShadow', 'texture_depth_2d'], ['var sceneMoonShadow', 'texture_depth_2d'],
    ['var scenePointShadow0', 'texture_depth_cube'], ['var scenePointShadow1', 'texture_depth_cube'],
    ['var sceneEnvironment', 'texture_2d<f32>'], ['var sceneReflection', 'texture_2d<f32>'],
    ['var sceneCompareSampler', 'sampler_comparison'], ['var sceneLinearSampler', 'sampler']];
  return decl.map(([name, type], i) => `@group(0) @binding(${base + i}) ${name}: ${type};`).join('\n') + '\n';
}

/** Radiance provider #1: the garden's hand-ported three.js PBR shading of
 * registered materials, lit by the raster-generated shadow maps, PMREM and
 * water reflection. materials: { tables: GPUBuffer } (the packed material/star
 * table, scene-resources.js); lighting: createLightingResources(). */
export function createGardenProvider({ lighting, materials }) {
  let revision = 0, boundTables = null, boundViews = null;
  const current = () => {
    if (materials.tables !== boundTables || lighting.views !== boundViews) { boundTables = materials.tables; boundViews = lighting.views; revision++; }
    return revision;
  };
  return {
    kind: 'surface', label: 'Garden PBR (three.js port)',
    resources: { storageBuffers: 1, uniformBuffers: 1, sampledTextures: 6, samplers: 2 },
    wgsl: base => gardenBindingDeclarations(base) + GARDEN_SHADING_WGSL,
    get ready() { return !!(materials.tables && lighting.views); },
    get revision() { return current(); },
    bindings(base) { return [{ binding: base, resource: { buffer: materials.tables } }, ...lighting.bindings(base + 1)]; },
  };
}
