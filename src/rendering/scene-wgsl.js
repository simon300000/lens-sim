import intersectorSource from './scene-intersector.wgsl?raw';
import shadingSource from './scene-shading.wgsl?raw';
import { TEST_CHART_WGSL } from '../scene/test-chart-patterns.js';
import { DFG_WGSL } from './dfg-lut.js';
import { WOOD, MEADOW, WATER } from '../scene/procedural-params.js';

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
export const SCENE_INTERSECTOR_WGSL = intersectorSource;
export const SCENE_SHADING_WGSL = DFG_WGSL + PROCEDURAL_WGSL + TEST_CHART_WGSL + shadingSource;
