/** Browser GPU test helpers: emissive/patterned diagnostic geometry made only
 * of registered MeshStandardNodeMaterial meshes, and the BVH + lighting +
 * optical-engine wiring the application uses. */
import * as THREE from 'three/webgpu';
import { createGPUInterop } from '../src/rendering/three-interop.js';
import { createSceneResources } from '../src/rendering/scene-resources.js';
import { createLightingResources } from '../src/rendering/lighting-resources.js';
import { createOpticalEngine } from '../src/rendering/optical-engine.js';

export function absorber() { return new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1, metalness: 0 }); }
export function emitter(rgb) {
  return new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1, metalness: 0, emissive: new THREE.Color(...rgb), emissiveIntensity: 1 });
}
export function emissivePanel(scene, { x = 0, y = 0, z = -5, w = 1, h = 1, color = [1, 1, 1], ry = 0 } = {}) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), emitter(color)); m.position.set(x, y, z); m.rotation.y = ry; scene.add(m); return m;
}
/** Vertical stripes as real geometry: alternating bright and dim emitters. */
export function stripedPanel(scene, { x = 0, y = 0, z = -5, w = 1, h = 1, color = [1, 1, 1], stripes = 12, dim = .1 } = {}) {
  const sw = w / stripes, bright = [], dark = [];
  for (let i = 0; i < stripes; i++) (i % 2 ? dark : bright).push(x - w / 2 + (i + .5) * sw);
  const geometry = new THREE.PlaneGeometry(sw, h), o = new THREE.Object3D();
  for (const [list, rgb] of [[bright, color], [dark, color.map(c => c * dim)]]) {
    const mesh = new THREE.InstancedMesh(geometry, emitter(rgb), list.length);
    list.forEach((cx, i) => { o.position.set(cx, y, z); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix); });
    scene.add(mesh);
  }
}
export async function createLensRig({ renderer, scene, camera, width = 96, environment = null, refreshSize, engineOptions = {} }) {
  const interop = createGPUInterop(renderer);
  const sceneResources = createSceneResources({ interop, scene, camera, starAngularRadius: 0, useWorker: true });
  const lighting = createLightingResources({ interop, renderer, scene, camera, environment, refreshSize });
  const engine = await createOpticalEngine({ interop, sceneResources, lighting, width, ...engineOptions });
  const sceneStats = await sceneResources.build();
  lighting.refresh();
  if (!lighting.status.ok) throw new Error('lighting bridge: ' + lighting.status.errors.join('; '));
  engine.setPose(camera);
  return { interop, sceneResources, lighting, engine, sceneStats };
}
