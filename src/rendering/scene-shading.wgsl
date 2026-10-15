// SurfaceRadianceEvaluator: scene-linear HDR radiance leaving a REAL scene
// intersection towards the lens (wo = -ray direction). Re-implements the
// pinned Three.js r183 MeshStandard/MeshPhysical node lighting for the light
// and material features registered by src/scene/scene-extract.js.
// Ported math (MIT, three.js authors): PhysicalLightingModel, BRDF_GGX,
// BRDF_GGX_Multiscatter, F_Schlick, D_GGX, V_GGX_SmithCorrelated, DFG LUT,
// getDistanceAttenuation, PCFSoftShadowFilter, PointShadowFilter,
// PMREMUtils.textureCubeUV, MaterialX mx_perlin_noise_float (Apache-2.0 origin).
// Not ported: screen-space geometryRoughness (dFdx of normals) and GTAO,
// because a compute path sample has no raster pixel footprint; see docs.
// Host declares: sceneVertices, sceneTables, sceneLighting, sceneSunShadow,
// sceneMoonShadow, scenePointShadow0/1, sceneEnvironment, sceneReflection,
// sceneCompareSampler, sceneLinearSampler.
struct SceneVertex { normal: vec3f, flags: u32, uv: vec2f, pad: vec2f, color: vec4f }
struct SceneLighting {
  sunDirection: vec4f,     // xyz towards light; w shadow slot (0) or -1
  sunColor: vec4f,         // rgb = colour * intensity
  moonDirection: vec4f,    // w shadow slot (1) or -1
  moonColor: vec4f,
  hemiSky: vec4f, hemiGround: vec4f, hemiUp: vec4f,
  pointPosition: array<vec4f, 8>, // xyz, w = cutoff distance (0 = none)
  pointColor: array<vec4f, 8>,    // rgb, w = decay exponent
  pointShadowSlot: array<vec4f, 8>, // x = slot (0/1) or -1
  counts: vec4u,           // point lights, flags, reserved, reserved
  dirShadowMatrix: array<mat4x4f, 2>,
  dirShadowParams: array<vec4f, 2>,   // bias, normalBias, intensity, mapSize
  pointShadowParams: array<vec4f, 2>, // near, far, bias, normalBias
  pointShadowParams2: array<vec4f, 2>,// intensity, mapSize, radius, 0
  fog: vec4f,              // rgb, density (0 = none)
  environment: vec4f,      // cubeUV texelWidth, texelHeight, maxMip, environmentIntensity
  skyZenith: vec4f, skyHorizon: vec4f, skyGround: vec4f,
  skyParams: vec4f,        // skyLuminance, daylight, twilight, discs
  skySun: vec4f,           // sun direction xyz (astronomical), sunDiscLuminance
  skySunColor: vec4f,      // rgb, w unused
  skySunDisc: vec4f,       // innerCos, outerCos
  moon: vec4f,             // radius, discLuminance, visible, starLuminance
  moonDir: vec4f,          // xyz, w = distance (215)
  moonIllumination: vec4f,
  reflectionViewProj: mat4x4f,
  stars: vec4f,            // angular radius (rad), visible, 0, 0
}
// counts.y flags
const LIGHT_ENVIRONMENT: u32 = 1u;
const LIGHT_REFLECTION: u32 = 2u;
const LIGHT_HEMI: u32 = 4u;
const SCENE_PI: f32 = 3.141592653589793;

// ---------------------------------------------------------------- tables
fn sceneTableF(i: u32) -> vec4f { return bitcast<vec4f>(sceneTables[i]); }
struct SceneMaterial {
  base: vec3f, opacity: f32, emissive: vec3f, roughness: f32,
  f0: vec3f, f90: f32, metalness: f32, clearcoat: f32, clearcoatRoughness: f32, envIntensity: f32,
  kind: u32, flags: u32, reason: u32,
}
const MAT_VERTEX_COLORS: u32 = 1u;
const MAT_TRANSPARENT: u32 = 2u;
const MAT_FOG: u32 = 4u;
const MAT_CLEARCOAT: u32 = 32u;
const PROC_WOOD: u32 = 1u;
const PROC_MEADOW: u32 = 2u;
const PROC_WATER: u32 = 3u;
fn sceneMaterial(index: u32) -> SceneMaterial {
  let o = 1u + index * 5u;
  let q0 = sceneTableF(o); let q1 = sceneTableF(o + 1u); let q2 = sceneTableF(o + 2u); let q3 = sceneTableF(o + 3u); let q4 = sceneTables[o + 4u];
  return SceneMaterial(q0.xyz, q0.w, q1.xyz, q1.w, q2.xyz, q2.w, q3.x, q3.y, q3.z, q3.w, q4.x, q4.y, q4.z);
}

// ---------------------------------------------------------------- MaterialX Perlin noise
fn mxRotl(x: u32, k: u32) -> u32 { return (x << k) | (x >> (32u - k)); }
fn mxHash3(x: i32, y: i32, z: i32) -> u32 {
  let seed = 0xdeadbeefu + (3u << 2u) + 13u;
  var a = seed + u32(x); var b = seed + u32(y); var c = seed + u32(z);
  c ^= b; c -= mxRotl(b, 14u);
  a ^= c; a -= mxRotl(c, 11u);
  b ^= a; b -= mxRotl(a, 25u);
  c ^= b; c -= mxRotl(b, 16u);
  a ^= c; a -= mxRotl(c, 4u);
  b ^= a; b -= mxRotl(a, 14u);
  c ^= b; c -= mxRotl(b, 24u);
  return c;
}
fn mxGrad3(hash: u32, x: f32, y: f32, z: f32) -> f32 {
  let h = hash & 15u;
  let u = select(y, x, h < 8u);
  let v = select(select(z, x, h == 12u || h == 14u), y, h < 4u);
  return select(u, -u, (h & 1u) != 0u) + select(v, -v, (h & 2u) != 0u);
}
fn mxFade(t: f32) -> f32 { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
fn mxNoise3(p: vec3f) -> f32 {
  let fl = floor(p);
  let X = i32(fl.x); let Y = i32(fl.y); let Z = i32(fl.z);
  let f = p - fl;
  let u = mxFade(f.x); let v = mxFade(f.y); let w = mxFade(f.z);
  let g0 = mxGrad3(mxHash3(X, Y, Z), f.x, f.y, f.z);
  let g1 = mxGrad3(mxHash3(X + 1, Y, Z), f.x - 1.0, f.y, f.z);
  let g2 = mxGrad3(mxHash3(X, Y + 1, Z), f.x, f.y - 1.0, f.z);
  let g3 = mxGrad3(mxHash3(X + 1, Y + 1, Z), f.x - 1.0, f.y - 1.0, f.z);
  let g4 = mxGrad3(mxHash3(X, Y, Z + 1), f.x, f.y, f.z - 1.0);
  let g5 = mxGrad3(mxHash3(X + 1, Y, Z + 1), f.x - 1.0, f.y, f.z - 1.0);
  let g6 = mxGrad3(mxHash3(X, Y + 1, Z + 1), f.x, f.y - 1.0, f.z - 1.0);
  let g7 = mxGrad3(mxHash3(X + 1, Y + 1, Z + 1), f.x - 1.0, f.y - 1.0, f.z - 1.0);
  let s1 = 1.0 - u; let t1 = 1.0 - v; let r1 = 1.0 - w;
  let result = r1 * (t1 * (g0 * s1 + g1 * u) + v * (g2 * s1 + g3 * u)) + w * (t1 * (g4 * s1 + g5 * u) + v * (g6 * s1 + g7 * u));
  return 0.982 * result;
}
// Value (x) and central-difference gradient (yzw) in noise-lattice units.
// Step 1/1024: lattice features are unit-sized; truncation error O(h^2) ~ 1e-6.
fn mxNoise3WithGradient(p: vec3f, gradient: bool) -> vec4f {
  let h = 0.0009765625;
  var v = array<f32, 7>();
  let n = select(1u, 7u, gradient);
  for (var k = 0u; k < n; k++) {
    var o = vec3f(0.0);
    if (k > 0u) { o[(k - 1u) / 2u] = select(-h, h, (k & 1u) == 1u); }
    v[k] = mxNoise3(p + o);
  }
  return vec4f(v[0], (v[1] - v[2]) / (2.0 * h), (v[3] - v[4]) / (2.0 * h), (v[5] - v[6]) / (2.0 * h));
}

// ---------------------------------------------------------------- BRDF (three r183)
fn sceneFSchlick(f0: vec3f, f90: f32, dotVH: f32) -> vec3f {
  let fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
  return f0 * (1.0 - fresnel) + f90 * fresnel;
}
fn sceneVSmith(alpha: f32, dotNL: f32, dotNV: f32) -> f32 {
  let a2 = alpha * alpha;
  let gv = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
  let gl = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
  return 0.5 / max(gv + gl, 1e-6);
}
fn sceneDGGX(alpha: f32, dotNH: f32) -> f32 {
  let a2 = alpha * alpha;
  let denom = 1.0 - dotNH * dotNH * (1.0 - a2);
  return a2 / (denom * denom) * (1.0 / SCENE_PI);
}
fn sceneBRDFGGX(L: vec3f, V: vec3f, N: vec3f, f0: vec3f, f90: f32, roughness: f32) -> vec3f {
  let alpha = roughness * roughness;
  let H = normalize(L + V);
  let dotNL = clamp(dot(N, L), 0.0, 1.0); let dotNV = clamp(dot(N, V), 0.0, 1.0);
  let dotNH = clamp(dot(N, H), 0.0, 1.0); let dotVH = clamp(dot(V, H), 0.0, 1.0);
  return sceneFSchlick(f0, f90, dotVH) * sceneVSmith(alpha, dotNL, dotNV) * sceneDGGX(alpha, dotNH);
}
fn sceneBRDFGGXMulti(L: vec3f, V: vec3f, N: vec3f, f0: vec3f, f90: f32, roughness: f32) -> vec3f {
  let single = sceneBRDFGGX(L, V, N, f0, f90, roughness);
  let dotNL = clamp(dot(N, L), 0.0, 1.0); let dotNV = clamp(dot(N, V), 0.0, 1.0);
  let dfgV = sceneDFG(roughness, dotNV); let dfgL = sceneDFG(roughness, dotNL);
  let fssEssV = f0 * dfgV.x + f90 * dfgV.y; let fssEssL = f0 * dfgL.x + f90 * dfgL.y;
  let emsV = 1.0 - (dfgV.x + dfgV.y); let emsL = 1.0 - (dfgL.x + dfgL.y);
  let favg = f0 + (1.0 - f0) * 0.047619;
  let fms = fssEssV * fssEssL * favg / (1.0 - emsV * emsL * favg * favg + 1e-6);
  return single + fms * (emsV * emsL);
}
fn sceneDistanceAttenuation(d: f32, cutoff: f32, decay: f32) -> f32 {
  let falloff = 1.0 / max(pow(d, decay), 0.01);
  if (cutoff > 0.0) { let x = clamp(1.0 - pow(d / cutoff, 4.0), 0.0, 1.0); return falloff * x * x; }
  return falloff;
}

// ---------------------------------------------------------------- PMREM cubeUV (PMREMUtils.js)
fn pmremFace(d: vec3f) -> f32 {
  let a = abs(d);
  if (a.x > a.z) { if (a.x > a.y) { return select(3.0, 0.0, d.x > 0.0); } return select(4.0, 1.0, d.y > 0.0); }
  if (a.z > a.y) { return select(5.0, 2.0, d.z > 0.0); }
  return select(4.0, 1.0, d.y > 0.0);
}
fn pmremFaceUV(d: vec3f, face: f32) -> vec2f {
  var uv: vec2f;
  if (face == 0.0) { uv = vec2f(d.z, d.y) / abs(d.x); }
  else if (face == 1.0) { uv = vec2f(-d.x, -d.z) / abs(d.y); }
  else if (face == 2.0) { uv = vec2f(-d.x, d.y) / abs(d.z); }
  else if (face == 3.0) { uv = vec2f(-d.z, d.y) / abs(d.x); }
  else if (face == 4.0) { uv = vec2f(-d.x, d.z) / abs(d.y); }
  else { uv = vec2f(d.x, d.y) / abs(d.z); }
  return 0.5 * (uv + 1.0);
}
fn pmremRoughnessToMip(r: f32) -> f32 {
  if (r >= 0.8) { return (1.0 - r) * (-1.0 + 2.0) / (1.0 - 0.8) - 2.0; }
  if (r >= 0.4) { return (0.8 - r) * (2.0 + 1.0) / (0.8 - 0.4) - 1.0; }
  if (r >= 0.305) { return (0.4 - r) * (3.0 - 2.0) / (0.4 - 0.305) + 2.0; }
  if (r >= 0.21) { return (0.305 - r) * (4.0 - 3.0) / (0.305 - 0.21) + 3.0; }
  return -2.0 * log2(1.16 * r);
}
fn pmremBilinear(direction: vec3f, mipIn: f32) -> vec3f {
  var face = pmremFace(direction);
  let filterInt = max(4.0 - mipIn, 0.0);
  let mipInt = max(mipIn, 4.0);
  let faceSize = exp2(mipInt);
  var uv = pmremFaceUV(direction, face) * (faceSize - 2.0) + 1.0;
  if (face > 2.0) { uv.y += faceSize; face -= 3.0; }
  uv.x += face * faceSize;
  uv.x += filterInt * 3.0 * 16.0;
  uv.y += 4.0 * (exp2(sceneLighting.environment.z) - faceSize);
  uv *= sceneLighting.environment.xy;
  return textureSampleLevel(sceneEnvironment, sceneLinearSampler, uv, 0.0).rgb;
}
fn scenePMREM(worldDirection: vec3f, roughness: f32) -> vec3f {
  // PMREMNode flips y before textureCubeUV.
  let d = vec3f(worldDirection.x, -worldDirection.y, worldDirection.z);
  let mip = clamp(pmremRoughnessToMip(roughness), -2.0, sceneLighting.environment.z);
  let mipF = fract(mip); let mipInt = floor(mip);
  var c = vec3f(0.0);
  let levels = select(1u, 2u, mipF != 0.0);
  for (var k = 0u; k < levels; k++) {
    c += pmremBilinear(d, mipInt + f32(k)) * select(1.0 - mipF, mipF, k == 1u);
  }
  return c;
}

// ---------------------------------------------------------------- shadows
// ShadowNode + PCFSoftShadowFilter (r183; radius is not used by this filter).
// The nine-term filter equals sum_ij wx(i) wy(j) cmp(uv + (i,j) texel) for
// i,j in {-1,0,1,2} with w(-1)=1-f, w(0)=w(1)=1, w(2)=f, divided by 9.
fn scenePCFWeight(i: u32, f: f32) -> f32 {
  if (i == 0u) { return 1.0 - f; }
  if (i == 3u) { return f; }
  return 1.0;
}
fn sceneDirectionalShadow(slot: u32, P: vec3f, N: vec3f) -> f32 {
  let params = sceneLighting.dirShadowParams[slot];
  let s = sceneLighting.dirShadowMatrix[slot] * vec4f(P + N * params.y, 1.0);
  let c = s.xyz / s.w;
  let coord = vec3f(c.x, 1.0 - c.y, c.z + params.x);
  if (!(coord.x >= 0.0 && coord.x <= 1.0 && coord.y >= 0.0 && coord.y <= 1.0 && coord.z <= 1.0)) { return 1.0; }
  let texel = 1.0 / params.w;
  let f = fract(coord.xy * params.w + 0.5);
  let base = coord.xy - f * texel;
  var sum = 0.0;
  for (var k = 0u; k < sceneRuntimeBound(16u); k++) {
    let i = k % 4u; let j = k / 4u;
    let w = scenePCFWeight(i, f.x) * scenePCFWeight(j, f.y);
    let uv = base + (vec2f(f32(i), f32(j)) - 1.0) * texel;
    var cmp: f32;
    if (slot == 0u) { cmp = textureSampleCompareLevel(sceneSunShadow, sceneCompareSampler, uv, coord.z); }
    else { cmp = textureSampleCompareLevel(sceneMoonShadow, sceneCompareSampler, uv, coord.z); }
    sum += w * cmp;
  }
  return mix(1.0, sum / 9.0, params.z);
}
fn scenePointCompare(slot: u32, d: vec3f, depth: f32) -> f32 {
  // CubeTextureNode flips y for depth cube textures under WebGPU.
  let s = vec3f(d.x, -d.y, d.z);
  if (slot == 0u) { return textureSampleCompareLevel(scenePointShadow0, sceneCompareSampler, s, depth); }
  return textureSampleCompareLevel(scenePointShadow1, sceneCompareSampler, s, depth);
}
// PointShadowNode + PointShadowFilter. The raster rotates its 5-tap Vogel disc
// by screen-space interleaved gradient noise; a lens path uses a stateless
// per-sample rotation instead, which converges to the same disc average.
fn scenePointShadow(slot: u32, P: vec3f, N: vec3f, lightPosition: vec3f, phi: f32) -> f32 {
  let p1 = sceneLighting.pointShadowParams[slot]; let p2 = sceneLighting.pointShadowParams2[slot];
  let sp = P + N * p1.w - lightPosition;
  let a = abs(sp);
  let viewZ = max(a.x, max(a.y, a.z));
  if (!(viewZ - p1.y <= 0.0 && viewZ - p1.x >= 0.0)) { return 1.0; }
  let depth = (viewZ - p1.x) * p1.y / ((p1.y - p1.x) * viewZ) + p1.z;
  let bd = normalize(sp);
  let absDir = abs(bd);
  let tangent = normalize(cross(bd, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), absDir.x > absDir.z)));
  let bitangent = cross(bd, tangent);
  let texel = p2.z / p2.y;
  var sum = 0.0;
  for (var i = 0u; i < sceneRuntimeBound(5u); i++) {
    let r = sqrt((f32(i) + 0.5) / 5.0);
    let theta = f32(i) * 2.399963229728653 + phi;
    let o = vec2f(cos(theta), sin(theta)) * r;
    sum += scenePointCompare(slot, bd + (tangent * o.x + bitangent * o.y) * texel, depth);
  }
  return mix(1.0, sum / 5.0, p2.x);
}

// ---------------------------------------------------------------- environment
fn scenePow(x: f32, y: f32) -> f32 { return select(pow(x, y), 0.0, x <= 0.0); }
fn sceneSky(d: vec3f) -> vec3f {
  let L = sceneLighting;
  let height = max(d.y, 0.0);
  let gradient = scenePow(height, 0.42);
  let sky = mix(L.skyHorizon.rgb, L.skyZenith.rgb, gradient) * L.skyParams.x;
  let sunCos = dot(d, L.skySun.xyz);
  let rayleigh = sunCos * sunCos * 0.22 + 0.78;
  let forward = scenePow(max(sunCos, 0.0), 64.0);
  let oneMinusH = 1.0 - height;
  let duskGlow = scenePow(max(sunCos, 0.0), 6.0) * oneMinusH * oneMinusH;
  let haze = L.skySunColor.rgb * (forward * 0.22 + duskGlow * L.skyParams.z * 0.6) * L.skyParams.x;
  var result = sky * rayleigh + haze;
  var cloudNoise = 0.0;
  for (var octave = 0u; octave < sceneRuntimeBound(2u); octave++) {
    let scale = select(vec3f(21.0), vec3f(8.0, 12.0, 8.0), octave == 0u);
    cloudNoise += mxNoise3(d * scale) * select(0.3, 1.0, octave == 0u);
  }
  let cloud = smoothstep(0.25, 0.64, cloudNoise) * smoothstep(0.02, 0.2, height) * 0.16;
  result = mix(result, L.skyHorizon.rgb * L.skyParams.x * 1.2, cloud * L.skyParams.y);
  let solarDisc = smoothstep(L.skySunDisc.y, L.skySunDisc.x, sunCos) * smoothstep(-0.001, 0.001, d.y) * L.skySun.w * L.skyParams.w;
  result += L.skySunColor.rgb * solarDisc;
  return mix(L.skyGround.rgb, result, smoothstep(-0.025, 0.025, d.y));
}
const STAR_AZ: u32 = 64u;
const STAR_EL: u32 = 16u;
fn sceneStars(d: vec3f) -> vec4f {
  let L = sceneLighting;
  if (L.stars.y == 0.0 || L.moon.w <= 0.0 || d.y < 0.0) { return vec4f(0.0); }
  let header = sceneTables[0];
  let az = (atan2(d.z, d.x) + SCENE_PI) / (2.0 * SCENE_PI);
  let cell = min(u32(az * f32(STAR_AZ)), STAR_AZ - 1u) + min(u32(d.y * f32(STAR_EL)), STAR_EL - 1u) * STAR_AZ;
  let grid = header.w;
  let start = sceneTables[grid + cell / 4u][cell % 4u];
  let end = sceneTables[grid + (cell + 1u) / 4u][(cell + 1u) % 4u];
  let listBase = grid + (STAR_AZ * STAR_EL + 1u + 3u) / 4u;
  let cosRadius = cos(L.stars.x);
  for (var k = start; k < min(end, start + 64u); k++) {
    let index = sceneTables[listBase + k / 4u][k % 4u];
    let star = sceneTableF(header.y + index * 2u);
    if (dot(d, star.xyz) >= cosRadius) {
      return vec4f(sceneTableF(header.y + index * 2u + 1u).rgb * L.moon.w, 1.0);
    }
  }
  return vec4f(0.0);
}
fn sceneMoon(d: vec3f) -> vec4f {
  let L = sceneLighting;
  if (L.moon.z == 0.0) { return vec4f(0.0); }
  let centre = L.moonDir.xyz * L.moonDir.w;
  let R = L.moon.x;
  let b = dot(-centre, d);
  let c = dot(centre, centre) - R * R;
  let disc = b * b - c;
  if (disc < 0.0) { return vec4f(0.0); }
  let t = -b - sqrt(disc);
  if (t <= 0.0) { return vec4f(0.0); }
  let n = (d * t - centre) / R;
  let lightFacing = max(dot(n, L.moonIllumination.xyz), 0.0);
  var octaves = vec2f(0.0);
  for (var octave = 0u; octave < sceneRuntimeBound(2u); octave++) { octaves[octave] = mxNoise3(n * select(35.0, 3.7, octave == 0u)); }
  let maria = octaves.x * 0.5 + 0.5;
  let detail = octaves.y * 0.08;
  let albedo = smoothstep(0.28, 0.72, maria) * 0.32 + 0.52 + detail;
  let colour = vec3f(0.95, 0.93, 0.86) * albedo * lightFacing * L.moon.y;
  let alpha = smoothstep(-0.003, 0.003, n.y * R + L.moonDir.y * L.moonDir.w);
  return vec4f(colour, alpha);
}
/// Analytic environment: the raster sky dome, stars and Moon are registered
/// environment objects, answered here by direction instead of as occluders.
fn sceneEnvironmentRadiance(d: vec3f) -> vec3f {
  var c = sceneSky(d);
  let star = sceneStars(d);
  c = mix(c, star.rgb, star.a);
  let moon = sceneMoon(d);
  return moon.rgb * moon.a + c * (1.0 - moon.a);
}

// ---------------------------------------------------------------- surface
struct SceneSurface {
  P: vec3f, N: vec3f, Ng: vec3f, local: vec3f, uv: vec2f, color: vec3f,
  material: u32, flags: u32, instance: u32, t: f32,
}
fn sceneReconstruct(hit: SceneHit, rayDir: vec3f, rayOrigin: vec3f) -> SceneSurface {
  var s: SceneSurface;
  let I = sceneInstances[hit.instance];
  let tri = sceneTriangles[hit.triangle];
  let b0 = 1.0 - hit.b1 - hit.b2;
  let v0 = sceneVertices[tri.i0]; let v1 = sceneVertices[tri.i1]; let v2 = sceneVertices[tri.i2];
  s.t = hit.t;
  s.P = rayOrigin + rayDir * hit.t;
  let geomLocal = tri.p0 * b0 + tri.p1 * hit.b1 + tri.p2 * hit.b2;
  s.local = vec3f(dot(I.frame0.xyz, geomLocal) + I.frame0.w, dot(I.frame1.xyz, geomLocal) + I.frame1.w, dot(I.frame2.xyz, geomLocal) + I.frame2.w);
  let nLocal = v0.normal * b0 + v1.normal * hit.b1 + v2.normal * hit.b2;
  var n = normalize(sceneWorldNormal(I, nLocal));
  var ng = normalize(sceneWorldNormal(I, cross(tri.p1 - tri.p0, tri.p2 - tri.p0)));
  // three directionToFaceDirection: BackSide always flips, DoubleSide flips on back faces.
  let side = I.info.z & INSTANCE_SIDE_MASK;
  if (side == SIDE_BACK || (side == SIDE_DOUBLE && !hit.front)) { n = -n; ng = -ng; }
  s.N = n; s.Ng = ng;
  s.uv = v0.uv * b0 + v1.uv * hit.b1 + v2.uv * hit.b2;
  var color = I.color.rgb;
  if ((I.info.z & INSTANCE_VERTEX_COLOR) != 0u) { color *= (v0.color * b0 + v1.color * hit.b1 + v2.color * hit.b2).rgb; }
  s.color = color;
  s.material = I.info.y; s.flags = I.info.z; s.instance = hit.instance;
  return s;
}
fn sceneWaterRipple(P: vec3f) -> f32 {
  return sin(dot(P.xz, WATER_RIPPLE_A)) * WATER_RIPPLE_AMP0 + cos(dot(P.xz, WATER_RIPPLE_B)) * WATER_RIPPLE_AMP1;
}
struct SceneShade { rgb: vec3f, alpha: f32, reflectionOutside: bool }
/// Outgoing radiance at a real hit, plus alpha and fog, matching three's
/// fragment output before blending. key decorrelates stochastic filters.
fn sceneShade(s: SceneSurface, wo: vec3f, key: u32) -> SceneShade {
  let L = sceneLighting;
  let m = sceneMaterial(s.material);
  var out: SceneShade;
  var base = m.base;
  var roughness = m.roughness;
  var N = s.N;
  var emissive = m.emissive;
  var noise = vec4f(0.0);
  if (m.kind == PROC_WOOD || m.kind == PROC_MEADOW) {
    let q = select(s.P * MEADOW_NOISE_SCALE, s.local * WOOD_NOISE_SCALE, m.kind == PROC_WOOD);
    noise = mxNoise3WithGradient(q, m.kind == PROC_WOOD);
  }
  if (m.kind == PROC_WOOD) {
    let p = s.local;
    let n = noise.x;
    let u = p.y * WOOD_GRAIN_FREQUENCY + n * WOOD_GRAIN_WARP;
    let grain = sin(u) * 0.5 + 0.5;
    base *= mix(WOOD_COLOR_LOW, WOOD_COLOR_HIGH, grain * WOOD_COLOR_GRAIN + n * WOOD_COLOR_NOISE + WOOD_COLOR_BIAS);
    roughness = grain * WOOD_ROUGHNESS_GRAIN + WOOD_ROUGHNESS_BASE;
    // grad h(p) in positionLocal units -> world (inverse transpose of local->world).
    let gradLocal = WOOD_BUMP_HEIGHT * 0.5 * cos(u) * (vec3f(0.0, WOOD_GRAIN_FREQUENCY, 0.0) + WOOD_GRAIN_WARP * noise.yzw * WOOD_NOISE_SCALE);
    let I = sceneInstances[s.instance];
    let gGeom = I.frame0.xyz * gradLocal.x + I.frame1.xyz * gradLocal.y + I.frame2.xyz * gradLocal.z;
    let g = sceneWorldNormal(I, gGeom);
    N = normalize(N - (g - N * dot(N, g)));
  } else if (m.kind == PROC_MEADOW) {
    base *= noise.x * MEADOW_AMPLITUDE + MEADOW_BIAS;
  } else if (m.kind == PROC_WATER) {
    let r = sceneWaterRipple(s.P);
    // normalMap on the planar uv = (x, -z) mapping: T = +x, B = -z.
    let face = select(-1.0, 1.0, dot(s.N, vec3f(0.0, 1.0, 0.0)) >= 0.0);
    N = normalize(face * (vec3f(1.0, 0.0, 0.0) * (WATER_NORMAL_X * r) + vec3f(0.0, 0.0, -1.0) * (WATER_NORMAL_Y * r) + vec3f(0.0, 1.0, 0.0)));
    // Reference-view planar reflection: project the hit with the main camera.
    var reflection = vec3f(0.0);
    if ((L.counts.y & LIGHT_REFLECTION) != 0u) {
      let clip = L.reflectionViewProj * vec4f(s.P, 1.0);
      var screen = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
      out.reflectionOutside = !(clip.w > 0.0) || any(screen < vec2f(0.0)) || any(screen > vec2f(1.0));
      let uv = vec2f(1.0 - screen.x, screen.y) + r * WATER_REFLECTION_UV;
      reflection = textureSampleLevel(sceneReflection, sceneLinearSampler, uv, 0.0).rgb;
    }
    let up = clamp(dot(wo, vec3f(0.0, 1.0, 0.0)), 0.0, 1.0);
    let fresnel = pow(1.0 - up, WATER_FRESNEL_POWER) * WATER_FRESNEL_SCALE + WATER_FRESNEL_BIAS;
    emissive = reflection * fresnel * WATER_REFLECTION_GAIN;
  }
  let diffuseColor = base * s.color;
  roughness = min(max(roughness, 0.0525), 1.0);
  let metal = m.metalness;
  let diffuseContribution = diffuseColor * (1.0 - metal);
  let specularColorBlended = mix(m.f0, diffuseColor, metal);
  let V = wo;
  let dotNV = clamp(dot(N, V), 0.0, 1.0);
  var directDiffuse = vec3f(0.0); var directSpecular = vec3f(0.0);
  var ccDirect = vec3f(0.0);
  let clearcoat = (m.flags & MAT_CLEARCOAT) != 0u;
  let receive = (s.flags & INSTANCE_RECEIVE_SHADOW) != 0u;
  // Sun, Moon (slots 0,1) then point lights: one loop, one BRDF call site.
  let phi = f32(spectralHash32(key ^ 0x51ed27u)) * (6.28318530718 / 4294967296.0);
  let lightCount = 2u + min(L.counts.x, 8u);
  for (var i = 0u; i < lightCount; i++) {
    var Ld: vec3f; var colour: vec3f;
    if (i < 2u) {
      let dir = select(L.moonDirection, L.sunDirection, i == 0u);
      colour = select(L.moonColor.rgb, L.sunColor.rgb, i == 0u);
      if (all(colour == vec3f(0.0))) { continue; }
      Ld = dir.xyz;
      if (receive && dir.w >= 0.0) { colour *= sceneDirectionalShadow(u32(dir.w), s.P, N); }
    } else {
      let lp = L.pointPosition[i - 2u];
      let toLight = lp.xyz - s.P;
      let dist = length(toLight);
      if (dist <= 0.0) { continue; }
      Ld = toLight / dist;
      colour = L.pointColor[i - 2u].rgb * sceneDistanceAttenuation(dist, lp.w, L.pointColor[i - 2u].w);
      if (all(colour == vec3f(0.0))) { continue; }
      let slot = L.pointShadowSlot[i - 2u].x;
      if (receive && slot >= 0.0) { colour *= scenePointShadow(u32(slot), s.P, N, lp.xyz, phi); }
    }
    let irradiance = clamp(dot(N, Ld), 0.0, 1.0) * colour;
    directDiffuse += irradiance * diffuseContribution / SCENE_PI;
    directSpecular += irradiance * sceneBRDFGGXMulti(Ld, V, N, specularColorBlended, 1.0, roughness);
    if (clearcoat) { ccDirect += irradiance * sceneBRDFGGX(Ld, V, N, vec3f(0.04), 1.0, m.clearcoatRoughness); }
  }
  // Indirect: hemisphere irradiance + PMREM radiance/irradiance (no GTAO).
  var irradiance = vec3f(0.0);
  if ((L.counts.y & LIGHT_HEMI) != 0u) { irradiance = mix(L.hemiGround.rgb, L.hemiSky.rgb, dot(N, L.hemiUp.xyz) * 0.5 + 0.5); }
  var indirectDiffuse = irradiance * diffuseContribution / SCENE_PI;
  var indirectSpecular = vec3f(0.0);
  var ccIndirect = vec3f(0.0);
  if ((L.counts.y & LIGHT_ENVIRONMENT) != 0u) {
    let envI = L.environment.w * m.envIntensity;
    let r4 = roughness * roughness * roughness * roughness;
    let ccR4 = pow(m.clearcoatRoughness, 4.0);
    var env = array<vec3f, 3>();
    let lookups = select(2u, 3u, clearcoat);
    for (var k = 0u; k < lookups; k++) {
      var dir = N; var r = 1.0;
      if (k == 0u) { dir = normalize(mix(reflect(-V, N), N, r4)); r = roughness; }
      if (k == 2u) { dir = normalize(mix(reflect(-V, N), N, ccR4)); r = m.clearcoatRoughness; }
      env[k] = scenePMREM(dir, r) * envI;
    }
    let radiance = env[0];
    let iblIrradiance = env[1] * SCENE_PI;
    let fab = sceneDFG(roughness, dotNV);
    let ssD = m.f0 * fab.x + m.f90 * fab.y;
    let ssM = diffuseColor * fab.x + m.f90 * fab.y;
    let ems = 1.0 - (fab.x + fab.y);
    let favgD = m.f0 + (1.0 - m.f0) * 0.047619;
    let favgM = diffuseColor + (1.0 - diffuseColor) * 0.047619;
    let msD = ssD * favgD / (1.0 - ems * favgD) * ems;
    let msM = ssM * favgM / (1.0 - ems * favgM) * ems;
    let single = mix(ssD, ssM, metal); let multi = mix(msD, msM, metal);
    let cosineWeighted = iblIrradiance / SCENE_PI;
    indirectSpecular += radiance * single + multi * cosineWeighted;
    indirectDiffuse += diffuseContribution * (1.0 - (ssD + msD)) * cosineWeighted;
    if (clearcoat) {
      let ccFab = sceneDFG(m.clearcoatRoughness, dotNV);
      ccIndirect = env[2] * (vec3f(0.04) * ccFab.x + ccFab.y);
    }
  }
  var outgoing = directDiffuse + directSpecular + indirectDiffuse + indirectSpecular;
  if (clearcoat) {
    let fcc = sceneFSchlick(vec3f(0.04), 1.0, dotNV);
    outgoing = outgoing * (1.0 - m.clearcoat * fcc) + (ccDirect + ccIndirect) * m.clearcoat;
  }
  outgoing += emissive;
  outgoing = max(outgoing, vec3f(0.0));
  out.alpha = select(1.0, m.opacity, (m.flags & MAT_TRANSPARENT) != 0u);
  // FogExp2 on the actual path length (raster uses view depth).
  if ((m.flags & MAT_FOG) != 0u && L.fog.w > 0.0) {
    let factor = 1.0 - exp(-L.fog.w * L.fog.w * s.t * s.t);
    outgoing = mix(outgoing, L.fog.rgb, factor);
  }
  out.rgb = outgoing;
  return out;
}

// ---------------------------------------------------------------- composition
const SCENE_HIT: u32 = 4u;
const SCENE_BACKGROUND: u32 = 5u;
const SCENE_UNSUPPORTED: u32 = 7u;
const BVH_TRAVERSAL_ERROR: u32 = 8u;
const TRANSPARENCY_LIMIT: u32 = 9u;
const SCENE_MAX_TRANSPARENT_LAYERS: u32 = 6u;
const SCENE_FAR: f32 = 1.0e7;
struct SceneSample {
  rgb: vec3f, status: u32, firstT: f32, firstNormal: vec3f, firstMaterial: u32,
  layers: u32, reflectionOutside: bool, bvhError: u32,
}
/// The fused lens kernel's SceneRadianceProvider: nearest real surface, its
/// material and lighting, and a BOUNDED front-to-back composite through
/// alpha-blended layers along the same ray (no refraction is simulated).
fn sceneRadiance(origin: vec3f, direction: vec3f, key: u32) -> SceneSample {
  var res: SceneSample;
  res.firstT = -1.0;
  var radiance = vec3f(0.0);
  var transmittance = 1.0;
  var tMin = 0.0;
  let layerBound = sceneRuntimeBound(SCENE_MAX_TRANSPARENT_LAYERS + 1u);
  for (var layer = 0u; layer < layerBound; layer++) {
    let hit = sceneIntersect(origin, direction, tMin, SCENE_FAR);
    if (hit.status == HIT_ERROR) { res.status = BVH_TRAVERSAL_ERROR; res.bvhError = hit.error; res.rgb = vec3f(0.0); return res; }
    if (hit.status == HIT_NONE) {
      radiance += transmittance * sceneEnvironmentRadiance(direction);
      res.rgb = radiance; res.status = select(SCENE_HIT, SCENE_BACKGROUND, layer == 0u); res.layers = layer;
      return res;
    }
    let s = sceneReconstruct(hit, direction, origin);
    if (layer == 0u) { res.firstT = hit.t; res.firstNormal = s.N; res.firstMaterial = s.material; }
    if ((s.flags & INSTANCE_UNSUPPORTED) != 0u) { res.status = SCENE_UNSUPPORTED; res.rgb = vec3f(0.0); return res; }
    let shade = sceneShade(s, -direction, key + layer * 0x9e3779b9u);
    res.reflectionOutside = res.reflectionOutside || shade.reflectionOutside;
    if ((s.flags & INSTANCE_TRANSPARENT) == 0u) {
      res.rgb = radiance + transmittance * shade.rgb; res.status = SCENE_HIT; res.layers = layer;
      return res;
    }
    radiance += transmittance * shade.alpha * shade.rgb;
    transmittance *= 1.0 - shade.alpha;
    // Continue along the SAME ray beyond this layer. The gap excludes the
    // same surface and coplanar duplicates across a shared edge.
    tMin = hit.t + 1.0e-4 + 2.0e-6 * hit.t;
  }
  res.status = TRANSPARENCY_LIMIT; res.rgb = vec3f(0.0); res.layers = SCENE_MAX_TRANSPARENT_LAYERS + 1u;
  return res;
}
