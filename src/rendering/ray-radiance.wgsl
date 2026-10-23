// Ray radiance provider contract: no BVH, no trace stage. Every optical sample
// that leaves the front element becomes one world ray, and the provider's
//   fn rayRadiance(ray: LensRay) -> RayRadiance
// answers its scene-linear RGB radiance directly (e.g. by looking the ray up in
// raster views rendered from origins on the front element). status is one of
// SCENE_HIT, SCENE_BACKGROUND, SCENE_UNSUPPORTED (counted, zero contribution) or
// BVH_TRAVERSAL_ERROR (provider failure, stops accumulation like a BVH error).
// t is the distance to the surface when known (geometry-depth diagnostic), else -1.
// flags: RAY_OUTSIDE_REFERENCE when the answer came from outside the provider's
// reference data (e.g. off a raster view; counted like the water reflection's
// outside-view diagnostic), plus transparent layers crossed << 16.
const RAY_OUTSIDE_REFERENCE: u32 = 1u;
struct LensRay { origin: vec3f, lambda: f32, direction: vec3f, weight: f32, key: u32 }
struct RayRadiance { rgb: vec3f, status: u32, t: f32, flags: u32 }
fn sceneRadianceFromRay(origin: vec3f, direction: vec3f, lambda: f32, weight: f32, key: u32) -> SceneSample {
  let r = rayRadiance(LensRay(origin, lambda, direction, weight, key));
  var res: SceneSample;
  res.rgb = select(vec3f(0.0), r.rgb, r.status == SCENE_HIT || r.status == SCENE_BACKGROUND);
  res.status = r.status; res.firstT = select(-1.0, r.t, r.status == SCENE_HIT);
  res.firstMaterial = 0u; res.layers = r.flags >> 16u; res.reflectionOutside = (r.flags & RAY_OUTSIDE_REFERENCE) != 0u;
  return res;
}
