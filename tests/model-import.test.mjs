import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { prepareImportedModel, subdivideGeometry, createTextureSampler, fitAndPlace, disposeModel, groupModelFiles, scaleModelAbout, turnModelAbout, moveModelBase } from '../src/scene/model-import.js';
import { classifyMaterial, extractScene } from '../src/scene/scene-extract.js';

// 2×2 sRGB texture: red, green / blue, white (row 0 is the top of the image).
function checker() {
  const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const texture = new THREE.Texture({ width: 2, height: 2, data });
  texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; // as GLTFLoader sets
  return texture;
}
const readTexture = texture => texture.image;
const close = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('sampler follows glTF orientation, wrap modes and the texture transform', () => {
  const texture = checker(), out = [0, 0, 0, 0];
  let at = createTextureSampler(texture, texture.image);
  assert.ok(close(at(.25, .25, out), [1, 0, 0, 1]));
  assert.ok(close(at(.75, .75, out), [1, 1, 1, 1]));
  assert.ok(close(at(1.25, .25, out), [1, 0, 0, 1]), 'repeat wraps');
  texture.wrapS = THREE.ClampToEdgeWrapping;
  assert.ok(close(createTextureSampler(texture, texture.image)(1.25, .25, out), [0, 1, 0, 1]), 'clamp holds the edge texel');
  texture.wrapS = THREE.RepeatWrapping; texture.offset.set(.5, 0);
  assert.ok(close(createTextureSampler(texture, texture.image)(.25, .25, out), [0, 1, 0, 1]), 'offset moves the lookup');
  texture.offset.set(0, 0); texture.flipY = true;
  assert.ok(close(createTextureSampler(texture, texture.image)(.25, .25, out), [0, 0, 1, 1]), 'flipY reads from the bottom row');
  // Halfway between red and green texel centres, in linear space.
  texture.flipY = false;
  assert.ok(close(createTextureSampler(texture, texture.image)(.5, .25, out), [.5, .5, 0, 1]));
});

test('subdivision stays watertight, flat and area preserving', () => {
  const source = new THREE.BoxGeometry(1, 2, 3), g = subdivideGeometry(source, 2);
  assert.equal(g.index.count / 3, source.index.count / 3 * 16);
  const area = geometry => { let sum = 0; const p = geometry.attributes.position, i = geometry.index, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < i.count; t += 3) { a.fromBufferAttribute(p, i.getX(t)); b.fromBufferAttribute(p, i.getX(t + 1)); c.fromBufferAttribute(p, i.getX(t + 2)); sum += b.sub(a).cross(c.sub(a)).length() / 2; } return sum; };
  assert.ok(Math.abs(area(g) - area(source)) < 1e-9);
  // Every interior edge is shared by exactly two triangles within each box face.
  const edges = new Map(), i = g.index;
  for (let t = 0; t < i.count; t += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) { const u = i.getX(t + a), v = i.getX(t + b), k = Math.min(u, v) + ':' + Math.max(u, v); edges.set(k, (edges.get(k) ?? 0) + 1); }
  assert.ok([...edges.values()].every(n => n <= 2));
  const n = g.attributes.normal; for (let k = 0; k < n.count; k++) assert.ok(Math.abs(Math.hypot(n.getX(k), n.getY(k), n.getZ(k)) - 1) < 1e-6);
});

test('loader materials become lens-supported node materials with baked colour maps', () => {
  const root = new THREE.Group(), map = checker();
  const textured = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map, color: 0xffffff, roughness: .4, metalness: .2, normalMap: checker() }));
  const physical = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ clearcoat: .5, transmission: .3 }));
  const cutout = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ alphaTest: .5 }));
  const skinnedGeometry = new THREE.BoxGeometry(), skinned = new THREE.SkinnedMesh(skinnedGeometry, new THREE.MeshBasicMaterial({ color: 0x336699 }));
  skinned.position.set(3, 0, 0);
  root.add(textured, physical, cutout, skinned, new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()), new THREE.PointLight());
  const report = prepareImportedModel(root, { readTexture });
  assert.equal(report.meshes, 4); assert.equal(report.bakedMeshes, 1);
  assert.ok(report.notes.some(n => n.includes('法线贴图')) && report.notes.some(n => n.includes('透射')) && report.notes.some(n => n.includes('alpha')) && report.notes.some(n => n.includes('骨骼')));
  assert.equal(root.children.filter(o => o.isPoints || o.isLight).length, 0);
  const meshes = []; root.traverse(o => { if (o.isMesh) meshes.push(o); });
  assert.ok(!meshes.some(o => o.isSkinnedMesh)); assert.ok(meshes.some(o => o.position.x === 3));
  for (const mesh of meshes) {
    assert.ok(mesh.material.isMeshStandardNodeMaterial || mesh.material.isMeshPhysicalNodeMaterial);
    assert.equal(classifyMaterial(mesh.material).reason, 0, mesh.material.name);
    assert.ok(mesh.castShadow && mesh.receiveShadow);
  }
  const baked = meshes.find(m => m.material.vertexColors);
  assert.equal(baked.material.map, null); assert.equal(baked.material.roughness, .4);
  // The 1 m plane spans 2 texels: no subdivision needed, corner colours match the texels.
  const uv = baked.geometry.attributes.uv, color = baked.geometry.attributes.color, at = createTextureSampler(map, map.image), out = [0, 0, 0, 0];
  for (let i = 0; i < uv.count; i++) assert.ok(close([color.getX(i), color.getY(i), color.getZ(i)], at(uv.getX(i), uv.getY(i), out).slice(0, 3)));
  assert.ok(meshes.find(m => m.material.isMeshPhysicalNodeMaterial).material.clearcoat === .5);
  const scene = new THREE.Scene(); scene.add(root);
  assert.deepEqual(extractScene(scene).report.unsupported, []);
});

test('large textures on coarse meshes are subdivided within the triangle budget', () => {
  const size = 256, data = new Uint8Array(size * size * 4).fill(200), texture = new THREE.Texture({ width: size, height: size, data });
  const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ map: texture })));
  const report = prepareImportedModel(root, { readTexture });
  assert.equal(report.subdividedMeshes, 1); assert.equal(report.triangles, 2 * 4 ** 4, 'capped at maxSubdivision');
  const tight = new THREE.Group(); tight.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.Texture({ width: size, height: size, data }) })));
  assert.ok(prepareImportedModel(tight, { readTexture, triangleBudget: 40 }).triangles <= 40);
});

test('unreadable colour maps are reported rather than silently baked', () => {
  const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.Texture() })));
  const report = prepareImportedModel(root, { readTexture: () => null });
  assert.equal(report.bakedMeshes, 0); assert.ok(report.notes.some(n => n.includes('颜色贴图无法读取')));
});

test('fit keeps plausible real-world units and rests the model on the ground', () => {
  const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardNodeMaterial()); mesh.position.set(5, 5, 5); root.add(mesh);
  const fit = fitAndPlace(root, new THREE.Vector3(1, .5, -2));
  assert.equal(fit.scale, 1);
  const box = new THREE.Box3().setFromObject(root);
  assert.ok(close(box.min.toArray(), [.5, .5, -2.5], 1e-9)); assert.ok(close(box.max.toArray(), [1.5, 2.5, -1.5], 1e-9));
  const huge = new THREE.Group(); huge.add(new THREE.Mesh(new THREE.BoxGeometry(400, 100, 100), new THREE.MeshStandardNodeMaterial()));
  const big = fitAndPlace(huge, new THREE.Vector3());
  assert.ok(Math.abs(Math.max(...big.size) - 2) < 1e-9);
  assert.ok(Math.abs(new THREE.Box3().setFromObject(huge).min.y) < 1e-9);
  const scene = new THREE.Scene(); scene.add(huge); disposeModel(huge); assert.equal(scene.children.length, 0);
});

test('model file sets split into one model per .glb and .gltf, with resources only for .gltf', () => {
  const f = name => ({ name, size: 1 });
  const groups = groupModelFiles([f('a.glb'), f('b.gltf'), f('b.bin'), f('tex.png'), f('c.GLB')]);
  assert.deepEqual(groups.map(g => [g.main.name, g.resources.map(r => r.name)]), [['a.glb', []], ['b.gltf', ['b.bin', 'tex.png']], ['c.GLB', []]]);
  assert.deepEqual(groupModelFiles([f('notes.txt')]), []);
});

test('scaling about the base centre and turning keep the lowest point in place', () => {
  const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshStandardNodeMaterial()); root.add(mesh);
  fitAndPlace(root, new THREE.Vector3(4, 1, -3));
  const box = () => new THREE.Box3().setFromObject(root, true), pivot = box().getCenter(new THREE.Vector3()).setY(box().min.y);
  scaleModelAbout(root, 2.5, pivot);
  let b = box(); assert.ok(Math.abs(b.min.y - 1) < 1e-9); assert.ok(close(b.getSize(new THREE.Vector3()).toArray(), [2.5, 5, 7.5], 1e-9));
  assert.ok(close(b.getCenter(new THREE.Vector3()).toArray().filter((_, i) => i !== 1), [4, -3], 1e-9));
  turnModelAbout(root, Math.PI / 2, pivot);
  b = box(); assert.ok(Math.abs(b.min.y - 1) < 1e-9); assert.ok(close(b.getSize(new THREE.Vector3()).toArray(), [7.5, 5, 2.5], 1e-9));
  assert.ok(close(b.getCenter(new THREE.Vector3()).toArray().filter((_, i) => i !== 1), [4, -3], 1e-9));
  moveModelBase(root, 1, -2, 1, .25);
  b = box(); assert.ok(Math.abs(b.min.y - .25) < 1e-9); assert.ok(close(b.getCenter(new THREE.Vector3()).toArray().filter((_, i) => i !== 1), [5, -5], 1e-9));
});
