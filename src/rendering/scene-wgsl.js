import intersectorSource from './scene-intersector.wgsl?raw';
import workCountersSource from './work-counters.wgsl?raw';
/** Declares the per-invocation work tallies; prepend once per shader module. */
export const WORK_COUNTERS_WGSL = workCountersSource;
import shadingSource from './scene-shading.wgsl?raw';
import { TEST_CHART_WGSL } from '../scene/test-chart-patterns.js';
import { DFG_WGSL } from './dfg-lut.js';
import { WOOD, MEADOW, WATER, GRAVEL } from '../scene/procedural-params.js';
import { normalizeShaderEOL } from './shader-source.js';
export { normalizeShaderEOL };

const f = x => { const s = String(x); return /[.eE]/.test(s) ? s : s + '.0'; };
const v2 = a => `vec2f(${a.map(f).join(', ')})`, v3 = a => `vec3f(${a.map(f).join(', ')})`;
/** Generated from procedural-params.js: the raster TSL graphs use the same object. */
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
/** Expand the traversal template (see scene-intersector.wgsl): one copy per
 * slab test. FAST_ONLY lines stay only in the fast variant. */
export function expandIntersector(source) {
  const text = normalizeShaderEOL(source);
  const begin = text.indexOf('// TRAVERSAL-TEMPLATE-BEGIN'), end = text.indexOf('// TRAVERSAL-TEMPLATE-END');
  if (begin < 0 || end < 0) throw new Error('scene-intersector.wgsl: traversal template markers missing');
  const template = text.slice(begin, end);
  const variant = (name, fast) => template.replaceAll('_VARIANT', name)
    .replace(/^([ \t]*)\/\/FAST_ONLY: ?(.*)$/gm, fast ? '$1$2' : '');
  return text.slice(0, begin) + variant('Fast', true) + variant('Parallel', false) + text.slice(end);
}
export const SCENE_INTERSECTOR_WGSL = expandIntersector(intersectorSource);
export const SCENE_SHADING_WGSL = DFG_WGSL + PROCEDURAL_WGSL + TEST_CHART_WGSL + shadingSource;
