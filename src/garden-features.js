import { THREE, mat, woodMat, makeBatch, stoneGeometry, rockGeometry, rng } from './kit.js';
import { slab } from './garden.js';
import { applyRakedGravel } from './scene/procedural-materials.js';
import { GRAVEL } from './scene/procedural-params.js';
import { GRAVEL_BED, BRIDGE, FENCE, PINE } from './garden-layout.js';

// Composed garden features chosen to show what a lens does: fine raked furrows
// and fence slats for resolution and moiré, long straight rails for distortion,
// small warm bulbs and lanterns at many depths for bokeh, and polished bronze
// and lacquer for specular highlights in daylight. All geometry; no images.
const TAU = Math.PI * 2;
const up = new THREE.Vector3(0, 1, 0), along = new THREE.Vector3(1, 0, 0);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitRod = new THREE.CylinderGeometry(1, 1, 1, 8);
const roundRod = new THREE.CylinderGeometry(1, 1, 1, 14);

/** Instance record for a rod (unit cylinder along y) from a to b. */
function rod(a, b, radius) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), d = end.clone().sub(start);
  return { p: start.add(end).multiplyScalar(.5).toArray(), s: [radius, d.length(), radius],
    q: new THREE.Quaternion().setFromUnitVectors(up, d.normalize()).toArray() };
}
/** Instance record for a unit box whose x axis runs from a to b. */
function bar(a, b, height, depth) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), d = end.clone().sub(start);
  return { p: start.add(end).multiplyScalar(.5).toArray(), s: [d.length(), height, depth],
    q: new THREE.Quaternion().setFromUnitVectors(along, d.normalize()).toArray() };
}
/** Hanging line between two supports: parabolic sag, n + 1 points. */
function catenary(a, b, sag, n) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
  });
}
function lathe(profile, segments = 20) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}
function warmMaterial(color, emissive, roughness = .85) {
  // emissiveIntensity is driven by the time of day (lighting.js) from nits.
  return mat(color, roughness, { emissive, emissiveIntensity: 0 });
}

// ---------------------------------------------------------------- karesansui
function rakedGravel(group, random) {
  const [cx, cz] = GRAVEL_BED.centre, [rx, rz] = GRAVEL_BED.radius;
  const shape = new THREE.Shape();
  for (let i = 0; i < 128; i++) {
    const a = i / 128 * TAU, x = cx + Math.cos(a) * rx, z = cz + Math.sin(a) * rz;
    if (i) shape.lineTo(x, -z); else shape.moveTo(x, -z);
  }
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape, 1); geometry.rotateX(-Math.PI / 2);
  const bed = new THREE.Mesh(geometry, applyRakedGravel(mat('#b4b0a3', GRAVEL.roughness)));
  bed.name = 'Raked karesansui gravel'; bed.position.y = GRAVEL_BED.y; bed.receiveShadow = true; bed.castShadow = false;
  group.add(bed);
  // A kerb of dark river cobbles separates the gravel from the lawn.
  const kerb = [];
  for (let i = 0; i < 190; i++) {
    const a = (i + random() * .4) / 190 * TAU, s = .085 + random() * .05;
    kerb.push({ p: [cx + Math.cos(a) * (rx + .05), .05, cz + Math.sin(a) * (rz + .05)], s: [s, s * (.5 + random() * .2), s * (.75 + random() * .35)],
      r: [0, random() * TAU, 0], c: ['#5e6058', '#6c6b61', '#4f534c', '#77756a'][i % 4] });
  }
  makeBatch(group, stoneGeometry(4402, 1), mat('#ffffff', .9), kerb);
  // Rock islands: a standing stone with its low companions, each in a collar of moss.
  const rocks = [], moss = [], pebbles = [];
  GRAVEL.rocks.forEach(([x, z, r], i) => {
    const h = [1.45, .7, .62][i] * r;
    rocks.push({ p: [x, GRAVEL_BED.y + h * .36, z], s: [r * .8, h, r * .7], r: [random() * .2 - .1, random() * TAU, random() * .14 - .07],
      c: ['#a3a194', '#ada899', '#979b8e'][i] });
    for (let k = 0; k < 90; k++) {
      const a = random() * TAU, d = r * (.62 + random() * .36), s = .03 + random() * .05;
      moss.push({ p: [x + Math.cos(a) * d, GRAVEL_BED.y + .012, z + Math.sin(a) * d], s: [s, s * .38, s * .8], r: [0, a, 0],
        c: ['#3f5a2c', '#4e6a33', '#5d7639', '#36502a'][k % 4] });
    }
    for (let k = 0; k < 5; k++) {
      const a = random() * TAU, d = r * (.72 + random() * .18), s = .06 + random() * .06;
      pebbles.push({ p: [x + Math.cos(a) * d, GRAVEL_BED.y + .02, z + Math.sin(a) * d], s: [s, s * .6, s * .8], r: [0, random() * TAU, 0], c: '#6f7066' });
    }
  });
  makeBatch(group, rockGeometry(5170), mat('#ffffff', .86), rocks);
  makeBatch(group, stoneGeometry(5175, 1), mat('#ffffff', .97), moss, { shadow: false });
  makeBatch(group, stoneGeometry(5181, 1), mat('#ffffff', .9), pebbles);
}

// ---------------------------------------------------------------- bridge
function archedBridge(group, bronze) {
  const [ax, az] = BRIDGE.from, [bx, bz] = BRIDGE.to;
  const span = Math.hypot(bx - ax, bz - az), width = BRIDGE.width, rise = BRIDGE.rise;
  const root = new THREE.Group(); root.name = 'Vermilion arched bridge (taiko-bashi)';
  root.position.set((ax + bx) / 2, 0, (az + bz) / 2); root.rotation.y = -Math.atan2(bz - az, bx - ax);
  group.add(root);
  const deckY = x => BRIDGE.deck + rise * Math.cos(Math.PI * x / span);
  const slope = x => -rise * Math.PI / span * Math.sin(Math.PI * x / span);
  const lacquer = new THREE.MeshPhysicalNodeMaterial({ color: '#b3341e', roughness: .42, metalness: 0, clearcoat: .6, clearcoatRoughness: .2 });
  lacquer.name = 'Vermilion lacquer';
  const boards = [], red = [], redRound = [], stone = [];
  const planks = 40, half = span / 2;
  for (let i = 0; i < planks; i++) {
    const x = -half + (i + .5) * span / planks, s = slope(x);
    boards.push({ p: [x, deckY(x) - .025, 0], s: [span / planks * Math.hypot(1, s) * .93, .05, width], r: [0, 0, Math.atan(s)],
      c: i % 5 ? '#ffffff' : '#e8ddd0' });
  }
  // Curved side stringers and cross beams under the deck.
  const segments = 32;
  for (const side of [-1, 1]) for (let i = 0; i < segments; i++) {
    const x0 = -half + i * span / segments, x1 = x0 + span / segments, z = side * (width / 2 - .02);
    red.push(bar([x0, deckY(x0) - .13, z], [x1, deckY(x1) - .13, z], .17, .09));
  }
  for (let i = 1; i < 10; i++) {
    const x = -half + i * span / 10;
    red.push({ p: [x, deckY(x) - .12, 0], s: [.09, .1, width - .05], r: [0, 0, Math.atan(slope(x))] });
  }
  // Two pairs of piers stand on the pond bed, tied by a through-beam (nuki).
  for (const x of [-span * .21, span * .21]) {
    for (const side of [-1, 1]) redRound.push(rod([x, -.34, side * (width / 2 - .08)], [x, deckY(x) - .2, side * (width / 2 - .08)], .065));
    red.push({ p: [x, deckY(x) - .42, 0], s: [.07, .11, width + .12] });
  }
  // Railing: posts with bronze giboshi caps, a heavy top rail and a lower rail.
  const postXs = Array.from({ length: 7 }, (_, k) => -half + .2 + k * (span - .4) / 6), caps = [];
  for (const side of [-1, 1]) {
    const z = side * (width / 2 - .02);
    for (const x of postXs) {
      const y = deckY(x);
      red.push({ p: [x, y + .3, z], s: [.09, .66, .09] });
      caps.push({ p: [x, y + .63, z] });
    }
    const railPoints = 28;
    for (let i = 0; i < railPoints; i++) {
      const x0 = postXs[0] + i * (postXs[6] - postXs[0]) / railPoints, x1 = x0 + (postXs[6] - postXs[0]) / railPoints;
      red.push(bar([x0, deckY(x0) + .58, z], [x1, deckY(x1) + .58, z], .055, .085));
      red.push(bar([x0, deckY(x0) + .3, z], [x1, deckY(x1) + .3, z], .04, .045));
      // Short struts between the rails every half bay.
      if (i % 2 === 1) red.push({ p: [x0, deckY(x0) + .44, z], s: [.035, .27, .035] });
    }
  }
  // Granite abutments and a landing step at each bank.
  for (const sign of [-1, 1]) {
    stone.push({ p: [sign * (half + .12), .06, 0], s: [.5, .18, width + .34], c: '#9b998b' });
    stone.push({ p: [sign * (half + .5), .035, 0], s: [.32, .1, width - .1], c: '#a8a596' });
  }
  makeBatch(root, unitBox, woodMat('#8b7560'), boards);
  makeBatch(root, unitBox, lacquer, red);
  makeBatch(root, unitRod, lacquer, redRound);
  makeBatch(root, unitBox, mat('#ffffff', .93), stone);
  const giboshi = lathe([[0, 0], [.052, 0], [.056, .025], [.045, .045], [.064, .075], [.071, .105], [.058, .145], [.033, .18], [.014, .205], [.008, .235], [.016, .25], [0, .272]], 20);
  makeBatch(root, giboshi, bronze, caps);
  return { span };
}

// ---------------------------------------------------------------- lights
function stringLights(group, bulbMaterial, cable) {
  // Warm bulbs on a sagging cable along the full engawa eave.
  const supports = Array.from({ length: 8 }, (_, i) => [-9.22 + i * (12.44 / 7), 4.02, -.24]);
  const bulbs = [], sockets = [], wires = [];
  for (let s = 0; s < supports.length - 1; s++) {
    const line = catenary(supports[s], supports[s + 1], .2, 24);
    for (let i = 0; i < line.length - 1; i++) wires.push(rod(line[i], line[i + 1], .0045));
    for (let j = 0; j < 6; j++) {
      const t = (j + .5) / 6, p = line[Math.round(t * 24)], drop = .05 + (j % 2) * .025;
      wires.push(rod(p, [p[0], p[1] - drop, p[2]], .0025));
      sockets.push({ p: [p[0], p[1] - drop - .012, p[2]], s: [.011, .028, .011] });
      bulbs.push({ p: [p[0], p[1] - drop - .048, p[2]], s: [.024, .032, .024] });
    }
  }
  makeBatch(group, new THREE.SphereGeometry(1, 12, 8), bulbMaterial, bulbs, { shadow: false });
  makeBatch(group, unitRod, cable, sockets, { shadow: false });
  makeBatch(group, unitRod, cable, wires, { shadow: false });
  return bulbs.length;
}

function chochinLines(group, materials, cable) {
  // Two lines of paper lanterns run from the eave to a bamboo pole past the table.
  const pole = [-7.65, 3.32, 7.55];
  const lines = [[[-9.2, 3.62, -.2], pole], [[-2.6, 3.92, -.24], pole]];
  const bodies = [[], []], ribs = [], caps = [], wires = [];
  let n = 0;
  for (const [a, b] of lines) {
    const line = catenary(a, b, .55, 30);
    for (let i = 0; i < line.length - 1; i++) wires.push(rod(line[i], line[i + 1], .006));
    for (let k = 0; k < 6; k++) {
      const p = line[3 + k * 5], top = p[1] - .16, centre = top - .2;
      wires.push(rod(p, [p[0], top, p[2]], .003));
      bodies[n % 3 === 1 ? 1 : 0].push({ p: [p[0], centre, p[2]], r: [0, k, 0] });
      caps.push({ p: [p[0], centre + .185, p[2]], s: [.072, .035, .072] }, { p: [p[0], centre - .185, p[2]], s: [.078, .035, .078] });
      for (let j = 1; j < 10; j++) {
        const y = -.17 + j * .034, r = .145 * Math.sqrt(Math.max(.2, 1 - (y / .19) ** 2)) + .001;
        ribs.push({ p: [p[0], centre + y, p[2]], s: [r, r, r], r: [Math.PI / 2, 0, 0] });
      }
      n++;
    }
  }
  const profile = Array.from({ length: 13 }, (_, i) => { const y = -.17 + i * .34 / 12; return [.145 * Math.sqrt(Math.max(.2, 1 - (y / .19) ** 2)), y]; });
  const body = lathe(profile, 24);
  makeBatch(group, body, materials.paper, bodies[0], { shadow: false });
  makeBatch(group, body, materials.red, bodies[1], { shadow: false });
  makeBatch(group, new THREE.TorusGeometry(1, .012, 3, 28), mat('#5a3a24', .8), ribs, { shadow: false });
  makeBatch(group, unitRod, mat('#1d1a18', .35), caps, { shadow: false });
  makeBatch(group, unitRod, cable, wires, { shadow: false });
  // The bamboo pole with its raised nodes.
  const bamboo = woodMat('#a7a16c'), nodes = [];
  const poleMesh = new THREE.Mesh(roundRod, bamboo); poleMesh.position.set(pole[0], pole[1] / 2 + .05, pole[2]);
  poleMesh.scale.set(.042, pole[1] + .1, .042); poleMesh.castShadow = poleMesh.receiveShadow = true; group.add(poleMesh);
  for (let y = .3; y < pole[1]; y += .38) nodes.push({ p: [pole[0], y, pole[2]], s: [.047, .018, .047] });
  makeBatch(group, roundRod, mat('#8a8656', .7), nodes);
  return n;
}

function pathLanterns(group, pane) {
  // Low granite oki-doro alternate along the stepping-stone path.
  const pathX = z => -2.2 + 1.8 * Math.sin(z * .27);
  const spots = [3.3, 6.2, 9.0, 11.8, 14.6].map((z, i) => [pathX(z) + (i % 2 ? -.86 : .86), z]);
  const stone = [], roofs = [], panes = [], knobs = [];
  for (const [x, z] of spots) {
    stone.push({ p: [x, .07, z], s: [.36, .07, .36], c: '#8f8d80' }, { p: [x, .25, z], s: [.13, .3, .13], c: '#999788' },
      { p: [x, .41, z], s: [.3, .035, .3], c: '#8f8d80' });
    for (const dx of [-.105, .105]) for (const dz of [-.105, .105]) stone.push({ p: [x + dx, .52, z + dz], s: [.04, .19, .04], c: '#999788' });
    panes.push({ p: [x, .52, z], s: [.18, .17, .18] });
    roofs.push({ p: [x, .66, z], s: [.27, .12, .27], r: [0, Math.PI / 4, 0] });
    knobs.push({ p: [x, .74, z], s: [.04, .05, .04] });
  }
  makeBatch(group, unitBox, mat('#ffffff', .93), stone);
  makeBatch(group, unitBox, pane, panes, { shadow: false });
  makeBatch(group, new THREE.ConeGeometry(1, 1, 4), mat('#86887a', .92), roofs);
  makeBatch(group, new THREE.SphereGeometry(1, 8, 6), mat('#86887a', .92), knobs);
  return spots;
}

function windChimes(group, bronze) {
  // Bronze furin with paper tanzaku under the eave; the bells catch the Sun.
  const bell = lathe([[0, .075], [.012, .075], [.03, .068], [.046, .045], [.054, .012], [.058, 0], [.052, 0], [.048, .01], [.04, .04], [.026, .062], [0, .068]], 20);
  const strings = [], bells = [], strips = [];
  [[-7.05, '#2f4a7a'], [-1.15, '#b3341e'], [2.45, '#e9e2cf']].forEach(([x, colour]) => {
    strings.push(rod([x, 4.08, -.3], [x, 3.8, -.3], .0025), rod([x, 3.74, -.3], [x, 3.56, -.3], .0018));
    bells.push({ p: [x, 3.73, -.3] });
    strips.push({ p: [x, 3.47, -.3], s: [.052, .17, .003], r: [0, .4, 0], c: colour });
  });
  makeBatch(group, bell, bronze, bells, { shadow: false });
  makeBatch(group, unitRod, mat('#e8e0cc', .9), strings, { shadow: false });
  makeBatch(group, unitBox, mat('#ffffff', .9, { side: THREE.DoubleSide }), strips, { shadow: false });
}

// ---------------------------------------------------------------- cloud-pruned pine
function needleTuft() {
  // A burst of fine needles from one twig tip, each a thin pointed blade.
  const positions = [], random = rng(3301);
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * TAU + random() * .3, tilt = .35 + random() * .5;
    const d = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(.035);
    const length = .8 + random() * .4;
    positions.push(0, 0, 0, ...d.clone().multiplyScalar(length * .45).add(side).toArray(), ...d.multiplyScalar(length).toArray());
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals(); return g;
}

function cloudPine(group, random) {
  // A black pine pruned into cloud pads, leaning out from the bank over the pond.
  const [bx, bz] = PINE.base, lean = new THREE.Vector2(6.8 - bx, 7.7 - bz).normalize();
  const local = (a, y, c) => new THREE.Vector3(bx + lean.x * a - lean.y * c, y, bz + lean.y * a + lean.x * c);
  const trunkPoints = [[0, 0, 0], [.12, .6, .1], [.6, 1.15, -.1], [1.3, 1.6, .05], [1.8, 2.15, .2], [2.0, 2.7, .1]].map(p => local(...p));
  const curve = new THREE.CatmullRomCurve3(trunkPoints), wood = [];
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    const a = curve.getPoint(i / steps), b = curve.getPoint((i + 1) / steps);
    wood.push(rod(a.toArray(), b.toArray(), .15 - i * .0075));
  }
  // Pads of foliage: a dense core with needle tufts over its upper surface.
  const pads = [[-.6, 1.05, .55, .62, .2, .5], [.6, 1.42, -.75, .7, .22, .55], [1.3, 1.95, .6, .66, .2, .55], [2.45, 1.82, -.25, .86, .24, .66],
    [1.3, 2.45, -.45, .56, .18, .46], [2.3, 2.62, .5, .6, .19, .5], [2.0, 2.98, 0, .5, .2, .42]];
  const cores = [], tufts = [[], []], palette = ['#2c4a2a', '#355730', '#3f6335', '#294326'];
  pads.forEach(([along, y, across, rx, ry, rz], i) => {
    const c = local(along, y, across);
    let nearest = trunkPoints[0], best = Infinity;
    for (let k = 0; k <= 20; k++) { const p = curve.getPoint(k / 20); const d = p.distanceTo(c); if (d < best && p.y < c.y + .2) { best = d; nearest = p; } }
    const elbow = nearest.clone().lerp(c, .55).add(new THREE.Vector3(0, -.12, 0));
    wood.push(rod(nearest.toArray(), elbow.toArray(), .055), rod(elbow.toArray(), [c.x, c.y - ry * .4, c.z], .035));
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * TAU + i;
      wood.push(rod([c.x, c.y - ry * .4, c.z], [c.x + Math.cos(a) * rx * .7, c.y - ry * .2, c.z + Math.sin(a) * rz * .7], .016));
    }
    cores.push({ p: c.toArray(), s: [rx * .78, ry * .66, rz * .78], r: [0, random() * TAU, 0], c: '#263f25' });
    for (let k = 0; k < 560; k++) {
      // Needles cover the crown and the rounded flanks, thinning underneath.
      const a = random() * TAU, h = Math.pow(random(), .8) * 1.35 - .4, r = Math.sqrt(Math.max(0, 1 - h * h)) * (.8 + random() * .25);
      const dir = new THREE.Vector3(Math.cos(a) * r, h - .1, Math.sin(a) * r);
      const p = new THREE.Vector3(c.x + dir.x * rx, c.y + dir.y * ry, c.z + dir.z * rz);
      const axis = new THREE.Vector3(dir.x * .8, Math.max(-.1, dir.y) + .45, dir.z * .8).normalize();
      const s = .085 + random() * .065;
      tufts[k % 2].push({ p: p.toArray(), s: [s, s, s], q: new THREE.Quaternion().setFromUnitVectors(up, axis).toArray(), c: palette[(k + i) % 4] });
    }
  });
  makeBatch(group, unitRod, woodMat('#5b4838'), wood);
  makeBatch(group, rockGeometry(7702, 5), mat('#ffffff', .95), cores);
  const tuft = needleTuft();
  for (const records of tufts) makeBatch(group, tuft, mat('#ffffff', .82, { side: THREE.DoubleSide }), records, { shadow: true });
  return pads.length;
}

// ---------------------------------------------------------------- bamboo fence
function bambooFence(group, random) {
  // Kenninji-gaki: tight split-bamboo slats held by bundled horizontal rails.
  const { x, z0, z1, height } = FENCE, length = z1 - z0, zc = (z0 + z1) / 2;
  const slats = [], rails = [], posts = [], knots = [];
  const tones = ['#b9a46c', '#a8955e', '#c4b27a', '#9e8c57', '#b2a067'];
  for (let z = z0; z <= z1; z += .049) {
    const h = height + (random() - .5) * .02;
    slats.push({ p: [x, h / 2, z], s: [.016, h, .045], c: tones[Math.floor(random() * tones.length)] });
  }
  const horizontal = [Math.PI / 2, 0, 0];
  for (const y of [.34, .76, 1.18, 1.6]) for (const side of [-1, 1]) for (const dy of [-.022, 0, .022]) {
    rails.push({ p: [x + side * (.03 + Math.abs(dy) * .3), y + dy, zc], s: [.014, length + .1, .014], r: horizontal, c: tones[(Math.round(dy * 100) + 9) % tones.length] });
  }
  rails.push({ p: [x, height + .035, zc], s: [.055, length + .14, .04], r: horizontal, c: '#a08d58' });
  for (const z of [z0 - .06, z1 + .06, ...Array.from({ length: 3 }, (_, k) => z0 + (k + 1) * length / 4)]) {
    posts.push({ p: [x - .08, (height + .14) / 2, z], s: [.048, height + .14, .048], c: '#a99a62' });
  }
  for (const y of [.34, .76, 1.18, 1.6]) for (let z = z0 + .2; z < z1; z += .46) knots.push({ p: [x + .052, y, z], s: [.018, .05, .036] });
  const bamboo = mat('#ffffff', .55);
  makeBatch(group, unitBox, bamboo, slats);
  makeBatch(group, roundRod, bamboo, rails);
  makeBatch(group, roundRod, bamboo, posts);
  makeBatch(group, unitBox, mat('#1b1a17', .9), knots, { shadow: false });
  return slats.length;
}

export function buildGardenFeatures(scene) {
  const group = new THREE.Group(); group.name = 'Karesansui, bridge, lanterns, pine and fence'; scene.add(group);
  const random = rng(88017);
  const bronze = mat('#b38a4e', .26, { metalness: 1 });
  bronze.name = 'Polished bronze';
  rakedGravel(group, random);
  const bridge = archedBridge(group, bronze);
  // Stepping stones lead from the path to the bridge landing.
  const stone = mat('#a9a693', .95);
  for (let i = 0; i < 4; i++) slab(group, stone, [-.05 + i * .64, .048, 8.62 + (i % 2 ? .08 : -.06)], .55 + random() * .12, .46 + random() * .1, .06, random(), 7100 + i);

  const cable = mat('#1e1d1b', .6);
  const bulb = warmMaterial('#fff4dc', '#ffb35c', .4);
  const paper = warmMaterial('#efe3c8', '#ffcf8c');
  const red = warmMaterial('#c23a22', '#ff5a24');
  const pane = warmMaterial('#efe2c4', '#ffc27a', .9);
  const bulbs = stringLights(group, bulb, cable);
  const chochin = chochinLines(group, { paper, red }, cable);
  const lanterns = pathLanterns(group, pane);
  windChimes(group, bronze);
  const pads = cloudPine(group, random);
  const slats = bambooFence(group, random);

  // PointLight intensity is candela; lighting.js scales lamps and emissive
  // materials by the same day/night level as the house lanterns.
  const lamps = [];
  const addLamp = (name, position, candela, distance) => {
    const light = new THREE.PointLight('#ffcf94', 0, distance, 2); light.name = name; light.position.set(...position);
    light.castShadow = false; group.add(light);
    lamps.push({ light, nominalIntensity: candela, candela, lumens: candela * 4 * Math.PI, name, emissiveMaterials: [] });
  };
  addLamp('Paper lantern lines · 2200 K', [-6.4, 2.6, 3.6], 11, 8);
  const [lx, lz] = lanterns[2];
  addLamp('Path lantern · 2400 K', [lx, .52, lz], 2.6, 3.5);
  const emissiveSources = [{ material: bulb, nits: 260 }, { material: paper, nits: 42 }, { material: red, nits: 36 }, { material: pane, nits: 34 }];
  for (const source of emissiveSources) source.material.userData.nominalNits = source.nits;

  group.updateMatrixWorld(true);
  let meshes = 0, instances = 0, triangles = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    meshes++; const count = o.isInstancedMesh ? o.count : 1; instances += count;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * count;
  });
  const metadata = { meshes, instances, triangles, bulbs, chochin, pathLanterns: lanterns.length, pinePads: pads, fenceSlats: slats,
    bridgeSpan: bridge.span, gravelRocks: GRAVEL.rocks.length, procedural: true };
  group.userData.metadata = metadata;
  return { group, lamps, emissiveSources, metadata };
}
