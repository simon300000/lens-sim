/** Shared small scenes for Node (CPU f64 reference) and browser GPU tests. */
import * as THREE from 'three/webgpu';
import { setLensRole } from '../src/scene/lens-registry.js';

export function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const mat = (side = THREE.FrontSide, extra = {}) => new THREE.MeshStandardNodeMaterial({ color: 0xffffff, side, ...extra });

export function diagnosticScene() {
  const scene = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, .5), mat()); box.position.set(0, 0, -4); box.rotation.set(.3, .5, .1); scene.add(box);
  // Non-uniform and NEGATIVE scale instances sharing one BLAS.
  const inst = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.4, 1), mat(), 6); // non-indexed geometry
  const o = new THREE.Object3D();
  for (let i = 0; i < 6; i++) {
    o.position.set(-2 + i * .8, (i % 2) * .5, -6 - i * .3); o.scale.set(i === 2 ? -1 : 1 + i * .2, i === 4 ? -.5 : .7, 1.3); o.rotation.set(i, i * .7, 0);
    o.updateMatrix(); inst.setMatrixAt(i, o.matrix); inst.setColorAt(i, new THREE.Color(i / 6, .5, 1 - i / 6));
  }
  scene.add(inst);
  const leaf = new THREE.Mesh(new THREE.PlaneGeometry(.6, .9), mat(THREE.DoubleSide)); leaf.position.set(.4, -.2, -3); leaf.rotation.y = 2.6; scene.add(leaf);
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1.2, 10, 6), mat(THREE.BackSide)); shell.position.set(-1.5, 0, -7); scene.add(shell);
  const ranged = new THREE.BufferGeometry().copy(new THREE.PlaneGeometry(3, 3, 4, 4)); ranged.setDrawRange(6, 30);
  const wall = new THREE.Mesh(ranged, mat()); wall.position.set(0, 0, -9); scene.add(wall);
  const grouped = new THREE.Mesh(new THREE.BoxGeometry(.7, .7, .7), [mat(), mat(THREE.DoubleSide), mat(), mat(), mat(), mat()]); grouped.position.set(1.5, .5, -5); grouped.scale.set(1, -1, 1); scene.add(grouped);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(50), new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide })); setLensRole(sky, 'environment-sky'); scene.add(sky);
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(), mat()); hidden.visible = false; scene.add(hidden);
  return scene;
}

