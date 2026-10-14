import { THREE, mat, woodMat, makeBatch, stoneGeometry, rng } from './kit.js';

// Close-up construction and botanical detail. Every mark is modelled; these
// batches share materials and add no downloaded textures or other assets.
export function buildDetails(scene, { garden, villa } = {}) {
  const group = new THREE.Group();
  group.name = 'Joinery, lamp hardware and quiet garden detail';
  scene.add(group);
  const random = rng(513019), tau = Math.PI * 2;
  const next = (a, b) => a + random() * (b - a);
  const boxes = new Map(), rods = new Map();
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const rodGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
  const up = new THREE.Vector3(0, 1, 0);
  const metal = mat('#494b43', .62, { metalness: .62 });
  const brass = mat('#8c7754', .55, { metalness: .62 });
  const cedar = woodMat('#71543c');
  const limestone = mat('#9d9b86', .94);
  const leafVein = mat('#9aa468', .91);
  const leafColor = mat('#ffffff', .78, { side: THREE.DoubleSide });
  const add = (map, material, record) => {
    if (!map.has(material)) map.set(material, []);
    map.get(material).push(record);
  };
  const box = (material, p, s, r = [0, 0, 0]) => add(boxes, material, { p, s, r });
  const rod = (material, a, b, radius) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const d = end.clone().sub(start), length = d.length();
    if (length < 1e-7) return;
    add(rods, material, { p: start.add(end).multiplyScalar(.5).toArray(),
      s: [radius, length, radius], q: new THREE.Quaternion().setFromUnitVectors(up, d.normalize()).toArray() });
  };

  // Roof fasteners are perpendicular to the roof sheets, with tiny washer
  // rims; rain gutters and bracket returns follow the existing eave geometry.
  const fasteners = [], slope = Math.atan2(2.3, 4.45);
  for (const front of [true, false]) {
    const zSign = front ? 1 : -1;
    for (let i = 0; i < 24; i++) {
      const x = -9.706 + i * .5833 + .285;
      for (const t of [-.34, .35]) {
        const z = (front ? -2.625 : -7.075) + t * 4.45;
        const y = 5.456 - zSign * t * 2.3;
        fasteners.push({ p: [x, y, z], s: [.027, .008, .027], r: [front ? slope : -slope, 0, 0] });
      }
    }
    for (let i = 0; i < 15; i++) {
      const x = -9.74 + i * .96, z = front ? -.37 : -9.34;
      box(metal, [x, 4.167, z + zSign * .062], [.037, .096, .21]);
      box(metal, [x, 4.207, z + zSign * .12], [.037, .026, .105]);
    }
  }
  makeBatch(group, new THREE.CylinderGeometry(1, 1, 1, 8), metal, fasteners);

  // Exposed joinery plates and wooden pegs at the deck's structural columns.
  const pegs = [];
  for (const x of [-9.33, 3.33]) {
    for (const y of [.78, 3.92]) {
      box(metal, [x, y, -.208], [.12, .105, .012]);
      for (const dx of [-.036, .036]) pegs.push({ p: [x + dx, y, -.197], s: [.008, .017, .008], r: [Math.PI / 2, 0, 0] });
    }
  }
  for (const x of [-8.28, 2.30]) {
    box(brass, [x + .408, 2.19, -1.277], [.073, .173, .014]);
    box(cedar, [x + .408, 2.19, -1.263], [.037, .120, .012]);
  }
  makeBatch(group, rodGeometry, brass, pegs);

  // A bamboo roller blind tucked above the reading bay, and restrained folds
  // in the linen throw. Both stay out of the clear garden-facing opening.
  const blind = [];
  for (let i = 0; i < 22; i++) {
    blind.push({ p: [1.53, 3.75 - i * .013, -1.52], s: [.014, 1.88, .014], r: [0, 0, Math.PI / 2] });
  }
  makeBatch(group, rodGeometry, woodMat('#a29063'), blind);
  for (const x of [.83, 2.23]) rod(cedar, [x, 3.86, -1.485], [x, 3.47, -1.485], .007);
  const linen = mat('#c2b99d', .99);
  box(linen, [2.05, 1.225, -3.40], [.54, .026, .64]);
  for (let i = 0; i < 7; i++) box(linen, [1.807 + i * .077, 1.24, -3.40], [.052, .016, .625]);
  box(linen, [2.05, 1.16, -3.032], [.54, .17, .025], [.12, 0, 0]);

  // Slender mature hostas live in existing flower beds. The raised midrib and
  // paired secondary veins have real relief, catching low morning light.
  const hostas = [], veinRecords = [];
  const segments = 12, positions = [], indices = [];
  const widthAt = t => Math.sin(Math.PI * t) ** .8 * .34;
  const midY = t => Math.sin(Math.PI * t) * .105 + t * .09;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, w = widthAt(t), y = midY(t);
    positions.push(-w, y - w * .19, t, 0, y + .017, t, w, y - w * .19, t);
    if (i < segments) {
      const k = i * 3;
      indices.push(k, k + 3, k + 1, k + 1, k + 3, k + 4,
        k + 1, k + 4, k + 2, k + 2, k + 4, k + 5);
    }
  }
  const hostaGeometry = new THREE.BufferGeometry();
  hostaGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  hostaGeometry.setIndex(indices); hostaGeometry.computeVertexNormals();
  const localVeins = [];
  for (let j = 1; j <= 9; j++) {
    const t = .05 + j * .087;
    localVeins.push([[0, midY(t) + .020, t], [0, midY(t + .075) + .020, t + .075]]);
    if (j % 2 === 1) for (const side of [-1, 1]) {
      const endT = Math.min(.94, t + .12), w = widthAt(endT) * .89;
      localVeins.push([[0, midY(t) + .020, t], [side * w, midY(endT) - w * .19 + .006, endT]]);
    }
  }
  const leafTransform = new THREE.Object3D();
  for (const [x, z, scale] of [[2.78, 3.04, .78], [11.76, 6.0, .94], [2.83, 10.57, .77], [-10.5, 7.85, .92]]) {
    for (let i = 0; i < 9; i++) {
      const angle = i / 9 * tau + next(-.16, .16), s = scale * next(.52, .88);
      const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(next(-.42, -.10), angle, next(-.15, .15), 'YXZ'));
      const record = { p: [x + Math.sin(angle) * .065, .07 + next(0, .055), z + Math.cos(angle) * .065],
        s: [s, s, s], q: orientation.toArray(),
        c: i % 3 ? '#68864e' : '#889957' };
      hostas.push(record);
      leafTransform.position.set(...record.p); leafTransform.scale.set(...record.s);
      leafTransform.quaternion.copy(orientation); leafTransform.updateMatrix();
      for (const [a, b] of localVeins) {
        const va = new THREE.Vector3(...a).applyMatrix4(leafTransform.matrix);
        const vb = new THREE.Vector3(...b).applyMatrix4(leafTransform.matrix);
        const d = vb.clone().sub(va);
        veinRecords.push({ p: va.add(vb).multiplyScalar(.5).toArray(), s: [.0015, d.length(), .0015],
          q: new THREE.Quaternion().setFromUnitVectors(up, d.normalize()).toArray() });
      }
    }
  }
  makeBatch(group, hostaGeometry, leafColor, hostas);
  makeBatch(group, rodGeometry, leafVein, veinRecords, { shadow: false });

  // Localised mulch and small mixed river gravel help root plants into the
  // earth. None of the patches crosses the paths, pond opening or dining area.
  const mulch = [], gravel = [], detritus = [];
  for (const [x, z, rx, rz] of [[-11.9, 11.4, 1.0, .72], [13.4, 2.25, 1.08, .8], [2.8, 10.6, .38, .5]]) {
    for (let i = 0; i < 115; i++) {
      const a = next(0, tau), r = Math.sqrt(random());
      mulch.push({ p: [x + Math.sin(a) * r * rx, .047, z + Math.cos(a) * r * rz],
        s: [next(.012, .025), next(.007, .014), next(.055, .12)], r: [0, next(0, tau), 0],
        c: ['#5c5741', '#756348', '#867653', '#55553e'][i % 4] });
    }
    for (let i = 0; i < 25; i++) {
      const a = next(0, tau), r = Math.sqrt(random());
      gravel.push({ p: [x + Math.sin(a) * r * rx, .055, z + Math.cos(a) * r * rz],
        s: [next(.018, .038), next(.013, .029), next(.023, .044)], r: [0, next(0, tau), 0],
        c: i % 3 ? '#a4a18b' : '#777e69' });
    }
  }
  makeBatch(group, boxGeometry, mat('#ffffff', .98), mulch, { shadow: false });
  makeBatch(group, stoneGeometry(619, 1), limestone, gravel, { shadow: false });
  const fallenOutline = [[0, 0], [-.22, .1], [-.13, .22], [-.48, .37], [-.21, .4],
    [-.25, .65], [-.1, .57], [0, .94], [.1, .57], [.25, .65], [.21, .4], [.48, .37], [.13, .22], [.22, .1]];
  const fallenPositions = [0, .028, .37], fallenIndices = [];
  for (const [x, z] of fallenOutline) fallenPositions.push(x, Math.sin(z * Math.PI) * .01, z);
  for (let i = 0; i < fallenOutline.length; i++) fallenIndices.push(0, i + 1, (i + 1) % fallenOutline.length + 1);
  const fallenGeometry = new THREE.BufferGeometry();
  fallenGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fallenPositions, 3));
  fallenGeometry.setIndex(fallenIndices); fallenGeometry.computeVertexNormals();
  for (let i = 0; i < 18; i++) {
    const deck = i < 6, s = next(.09, .14);
    detritus.push({ p: deck ? [next(-9.7, -8.3), .677, next(.3, 1.3)] : [next(-10.1, -8.8), .025, next(8.8, 11.8)],
      s: [s, s, s], r: [0, next(0, tau), 0], c: ['#9b884e', '#897645', '#a69659', '#74814b'][i % 4] });
  }
  makeBatch(group, fallenGeometry, mat('#ffffff', .92, { side: THREE.DoubleSide }), detritus, { shadow: false });
  for (const [material, records] of boxes) makeBatch(group, boxGeometry, material, records);
  for (const [material, records] of rods) makeBatch(group, rodGeometry, material, records);

  // PointLight intensity is candela (power / 4pi). Parent time-of-day lighting
  // controls these nominal values and the emissive materials together. Paper
  // shells must not block their own bulbs in opaque-material shadow passes.
  const emissiveMaterials = [], existingWarm = [], gardenWarm = [];
  const villaGroup = villa?.group ?? villa;
  const gardenGroup = garden?.garden ?? garden;
  const collectWarm = (root, target) => root?.traverse(o => {
    if (!o.isMesh) return;
    for (const material of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (material.emissive?.getHex() > 0 && material.emissiveIntensity > 0) {
        if (!target.includes(material)) target.push(material);
        if (!emissiveMaterials.includes(material)) emissiveMaterials.push(material);
        o.castShadow = false;
      }
    }
  });
  collectWarm(villaGroup, existingWarm); collectWarm(gardenGroup, gardenWarm);
  const lamps = [];
  const addLamp = (name, position, candela, distance, materials, shadow, existing) => {
    const light = existing ?? new THREE.PointLight('#ffcf94', 0, distance, 2);
    light.name = name; light.intensity = 0; light.color.set('#ffcf94');
    light.distance = distance; light.decay = 2; light.position.set(...position);
    light.castShadow = shadow;
    if (shadow) {
      light.shadow.mapSize.set(512, 512); light.shadow.camera.near = .08;
      light.shadow.camera.far = distance; light.shadow.bias = -.00008;
      light.shadow.normalBias = .035;
    }
    if (!existing) group.add(light);
    const nits = name.startsWith('Carved') ? 45 : 30;
    for (const material of materials) material.userData.nominalNits = nits;
    const lamp = { light, nominalIntensity: candela, candela, lumens: candela * 4 * Math.PI,
      nits, nominalEmissive: nits, emissiveMaterials: materials, name };
    lamps.push(lamp); return lamp;
  };
  let oldRoomLight;
  villaGroup?.traverse(o => { if (o.isPointLight && !oldRoomLight) oldRoomLight = o; });
  addLamp('Left paper pendant · 2700 K', [-6.59, 3.39, -4.24], 56, 11, existingWarm, true, oldRoomLight);
  addLamp('Right paper pendant · 2700 K', [-.49, 3.41, -5.97], 56, 11, existingWarm, false);
  addLamp('Engawa lantern · 2400 K', [-8.77, 1.00, .47], 14, 5, existingWarm, false);
  addLamp('Carved stone garden lantern · 2400 K', [3.4, 1.39, 5], 8, 4.5, gardenWarm, false);

  group.updateMatrixWorld(true);
  let meshes = 0, instances = 0, triangles = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    meshes++; const count = o.isInstancedMesh ? o.count : 1; instances += count;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * count;
  });
  const bounds = new THREE.Box3().setFromObject(group);
  const metadata = { meshes, instances, triangles, lamps: lamps.length,
    shadowedLamps: lamps.filter(v => v.light.castShadow).length, hostaLeaves: hostas.length,
    modelledLeafVeins: veinRecords.length, roofFasteners: fasteners.length,
    fallenLeaves: detritus.length, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, procedural: true };
  group.userData.metadata = metadata;
  const emissiveSources = emissiveMaterials.map(material => ({ material, nits: material.userData.nominalNits ?? 30 }));
  return { group, lamps, emissiveMaterials, emissiveSources, metadata };
}
