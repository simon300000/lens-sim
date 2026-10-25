// Scene query result shared by both radiance provider kinds (statuses as in
// docs/scene-query.md). firstT/firstNormal/firstMaterial feed the geometry
// diagnostics; a ray provider leaves them at -1 / 0 when it has no surface.
const SCENE_HIT: u32 = 4u;
const SCENE_BACKGROUND: u32 = 5u;
const SCENE_UNSUPPORTED: u32 = 7u;
const BVH_TRAVERSAL_ERROR: u32 = 8u;
const TRANSPARENCY_LIMIT: u32 = 9u;
// Ray providers through the ray cache only: not answerable yet (resources it needs are
// still pending). The ray stays unresolved for a later retry and is never accumulated.
const SCENE_DEFERRED: u32 = 10u;
struct SceneSample {
  rgb: vec3f, status: u32, firstT: f32, firstNormal: vec3f, firstMaterial: u32,
  layers: u32, reflectionOutside: bool, bvhError: u32,
}
