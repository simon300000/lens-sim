/** Explicit lens-imaging registration. Nothing here guesses from object names.
 *
 * Objects:
 *   - 'environment-sky' / 'environment-moon' / 'environment-stars': drawn by the
 *     raster scene, but answered by the analytic environment query in lens mode.
 *     They are never inserted as occluding triangles.
 *   - 'exclude': explicitly not imaging geometry (e.g. helpers).
 * Materials: a compact descriptor of the procedural node graph that the WGSL
 * surface evaluator re-implements. A material with node overrides but no
 * descriptor is reported as unsupported, never replaced by a grey default.
 */
export const LENS_ROLES = Object.freeze(['environment-sky', 'environment-moon', 'environment-stars', 'exclude']);

export function setLensRole(object, role) {
  if (!LENS_ROLES.includes(role)) throw new Error(`Unknown lens role: ${role}`);
  object.userData.lensRole = role;
  return object;
}
export const lensRole = object => object.userData?.lensRole ?? null;

/** Procedural material kinds understood by src/rendering/scene-shading.wgsl. */
export const PROCEDURAL = Object.freeze({ NONE: 0, WOOD: 1, MEADOW: 2, WATER: 3 });

export function setLensMaterial(material, descriptor) {
  if (!Object.values(PROCEDURAL).includes(descriptor.kind)) throw new Error('Unknown procedural lens material');
  material.userData.lensMaterial = descriptor;
  return material;
}
export const lensMaterial = material => material.userData?.lensMaterial ?? null;
