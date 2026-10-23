// Engine side of the shading stage: surface reconstruction from the BVH hit and
// the bounded front-to-back composite along one ray. Radiance comes from the
// active radiance provider (see radiance-provider.js), whose WGSL defines
//   fn sceneShade(s: SceneSurface, wo: vec3f, key: u32) -> SceneShade
//   fn sceneEnvironmentRadiance(d: vec3f) -> vec3f
// and declares its own resources from the provider binding base. The engine
// declares sceneNodes, sceneInstances, sceneTriangles and sceneVertices.
struct SceneVertex { normal: vec3f, flags: u32, uv: vec2f, pad: vec2f, color: vec4f }

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
struct SceneShade { rgb: vec3f, alpha: f32, reflectionOutside: bool }

// ---------------------------------------------------------------- composition
const SCENE_MAX_TRANSPARENT_LAYERS: u32 = 6u;
const SCENE_FAR: f32 = 1.0e7;
/// sceneRadiance when the nearest surface along the ray is already known: the
/// staged integrator's traversal kernel supplies layer 0 and this composites
/// exactly as sceneRadiance does, continuing inline through transparent layers.
fn sceneRadianceFromHit(origin: vec3f, direction: vec3f, key: u32, first: SceneHit) -> SceneSample {
  var res: SceneSample;
  res.firstT = -1.0;
  var radiance = vec3f(0.0);
  var transmittance = 1.0;
  var tMin = 0.0;
  var hit = first;
  let layerBound = sceneRuntimeBound(SCENE_MAX_TRANSPARENT_LAYERS + 1u);
  for (var layer = 0u; layer < layerBound; layer++) {
    if (layer > 0u) { hit = sceneIntersect(origin, direction, tMin, SCENE_FAR); }
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
    tMin = hit.t + 1.0e-4 + 2.0e-6 * hit.t;
  }
  res.status = TRANSPARENCY_LIMIT; res.rgb = vec3f(0.0); res.layers = SCENE_MAX_TRANSPARENT_LAYERS + 1u;
  return res;
}
/// The lens shading stage's SceneRadianceProvider: nearest real surface, its
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
