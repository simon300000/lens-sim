import { THREE, mat, makeBatch, rng } from './kit.js';
import { pondPoint } from './garden.js';
import { landscapeSurface } from './landscape.js';

// Small night-time point sources placed to show what a lens does to them.
// Each family is a different colour at a different range of distances:
//  - fireflies hang in the air at every depth from the bank to the far pond,
//    so one frame shows front bokeh, back bokeh and the in-focus pinpoints;
//  - floating candles sit on the pond and appear twice, once in reflection;
//  - neutral-white stake lights line the path at regular spacing: a depth
//    ladder whose discs grow steadily with defocus and show axial colour;
//  - sodium road lamps and two hamlets on the near ridge are effectively at
//    infinity, small enough to show coma, astigmatism and cat's-eye
//    vignetting across the whole frame.
// They are emissive geometry only. Their illumination of the garden is
// negligible next to the lanterns, and the lens tracer's point-light budget is
// kept for the lamps that do light the scene.
const TAU = Math.PI * 2;
const up = new THREE.Vector3(0, 1, 0);

function glow(color, emissive, roughness = .6) {
  // emissiveIntensity is driven by the time of day (lighting.js) from nits.
  return mat(color, roughness, { emissive, emissiveIntensity: 0 });
}
function rod(a, b, radius) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), d = end.clone().sub(start);
  return { p: start.add(end).multiplyScalar(.5).toArray(), s: [radius, d.length(), radius],
    q: new THREE.Quaternion().setFromUnitVectors(up, d.normalize()).toArray() };
}

function fireflies(group, material, random) {
  // Swarms favour damp, sheltered places: the reeds round the pond, the shade
  // under the pine, the moss by the fence and the lawn edge near the terrace.
  const swarms = [
    { count: 70, at: () => { const p = pondPoint(random() * TAU, (random() - .35) * 1.6); return [p.x, p.y]; }, height: [.18, 1.5] },
    { count: 22, at: () => [4.6 + (random() - .5) * 3.2, 4.1 + (random() - .5) * 2.6], height: [.4, 2.3] },
    { count: 24, at: () => [-12.6 + (random() - .5) * 3, 3 + random() * 7], height: [.2, 1.6] },
    { count: 18, at: () => [-9.5 + (random() - .5) * 6, 13.5 + (random() - .5) * 3], height: [.15, 1.2] },
  ];
  const records = [];
  for (const { count, at, height: [low, high] } of swarms) for (let i = 0; i < count; i++) {
    const [x, z] = at(), s = .004 + random() * .002;
    // Most hover low over the grass; a few drift up. Only three in five are
    // kept, drawn from the full sequence so later placements stay put.
    const y = low + (high - low) * random() ** 1.7;
    if (i % 5 < 3) records.push({ p: [x, y, z], s: [s, s, s] });
  }
  makeBatch(group, new THREE.SphereGeometry(1, 8, 6), material, records, { shadow: false, receive: false });
  return records.length;
}

function floatingCandles(group, flame, cup) {
  // Tea-light cups adrift on the open water, away from the bridge and lilies.
  // The first floats close to the east bank, where the firefly view focuses.
  const spots = [[8.0, 6.2], [5.6, 6.1], [6.5, 7.3], [7.7, 6.6], [5.2, 8.6], [8.6, 8.9], [7.1, 9.9], [6.0, 10.6], [4.8, 7.2]];
  const cups = [], wicks = [], flames = [];
  const surface = .11;
  for (const [x, z] of spots) {
    cups.push({ p: [x, surface + .012, z], s: [.045, .03, .045] });
    wicks.push({ p: [x, surface + .034, z], s: [.0012, .012, .0012] });
    flames.push({ p: [x, surface + .052, z], s: [.0055, .014, .0055] });
  }
  makeBatch(group, new THREE.CylinderGeometry(1, .82, 1, 16), cup, cups, { shadow: false });
  makeBatch(group, new THREE.CylinderGeometry(1, 1, 1, 4), mat('#1c1813', .9), wicks, { shadow: false, receive: false });
  // A flame is a teardrop: a stretched sphere is close enough at this size.
  makeBatch(group, new THREE.SphereGeometry(1, 10, 8), flame, flames, { shadow: false, receive: false });
  return spots.length;
}

function stakeLights(group, globe, stake) {
  // Short dark stakes with a frosted globe, both sides of the stepping-stone
  // path at an even 1.2 m pitch: from a low view they recede as a ladder.
  const pathX = z => -2.2 + 1.8 * Math.sin(z * .27);
  const posts = [], globes = [];
  for (let z = 1.9; z < 15.4; z += 1.2) for (const side of [-1, 1]) {
    const x = pathX(z) + side * .62;
    posts.push(rod([x, -.05, z], [x, .37, z], .006));
    globes.push({ p: [x, .38, z], s: [.011, .011, .011] });
  }
  makeBatch(group, new THREE.CylinderGeometry(1, 1, 1, 6), stake, posts, { shadow: false });
  makeBatch(group, new THREE.SphereGeometry(1, 12, 8), globe, globes, { shadow: false, receive: false });
  return globes.length;
}

function ridgeLights(group, sodium, homes, random) {
  // A switchback road climbs the face of the nearest ridge behind the house.
  // Lamp heads sit 5 m above the road; poles are too thin to resolve here.
  const legs = [[-46, -40.5], [30, -43.5], [-30, -49], [18, -54], [-12, -58.5]];
  const lamps = [];
  for (let k = 0; k < legs.length - 1; k++) {
    const [ax, az] = legs[k], [bx, bz] = legs[k + 1], length = Math.hypot(bx - ax, bz - az);
    // Irregular spacing, and an occasional dark or missing lamp.
    for (let d = k ? 6 : 0; d <= length; d += 7 + random() * 5) {
      if (random() < .18) continue;
      const t = d / length, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      lamps.push({ p: [x, landscapeSurface(x, z) + 4.5, z], s: [.12, .09, .12] });
    }
  }
  // Two hamlets: lit windows a little above the ground, irregularly spaced.
  const windows = [];
  for (const [cx, cz, count] of [[-22, -44, 9], [36, -50, 7]]) for (let i = 0; i < count; i++) {
    const x = cx + (random() - .5) * 14, z = cz + (random() - .5) * 6;
    windows.push({ p: [x, landscapeSurface(x, z) + 1.2 + random() * 2.2, z], s: [.24 + random() * .2, .32, .24] });
  }
  makeBatch(group, new THREE.SphereGeometry(1, 8, 6), sodium, lamps, { shadow: false, receive: false });
  makeBatch(group, new THREE.BoxGeometry(1, 1, 1), homes, windows, { shadow: false, receive: false });
  return { roadLamps: lamps.length, windows: windows.length };
}

export function buildNightLights(scene) {
  const group = new THREE.Group(); group.name = 'Night point sources: fireflies, candles, path stakes, ridge lamps'; scene.add(group);
  const random = rng(77031);
  // Firefly bioluminescence peaks near 560 nm: a yellow-green, not white.
  const firefly = glow('#c9d98a', '#b6ff3c', .5);
  const flame = glow('#ffe7b0', '#ffae4a', .5);
  const cup = mat('#e9e4d8', .55);
  const globe = glow('#eef0ee', '#eef2ff', .4);
  const sodium = glow('#d9b582', '#ff9c38', .5);
  const homes = glow('#cdbb98', '#ffd49a', .8);
  const counts = {
    fireflies: fireflies(group, firefly, random),
    floatingCandles: floatingCandles(group, flame, cup),
    stakeLights: stakeLights(group, globe, mat('#23241f', .6, { metalness: .4 })),
    ...ridgeLights(group, sodium, homes, random),
  };
  // Luminances in cd/m². At the lamp-lit night exposure even a 40 cd/m² point
  // clips when sharp, yet stays unclipped once spread over a bokeh disc, so
  // the disc keeps its edge, rings and colour fringes. Flames are brighter.
  const emissiveSources = [{ material: firefly, nits: 60 }, { material: flame, nits: 300 }, { material: globe, nits: 40 },
    { material: sodium, nits: 300 }, { material: homes, nits: 90 }];
  for (const source of emissiveSources) source.material.userData.nominalNits = source.nits;

  group.updateMatrixWorld(true);
  let meshes = 0, instances = 0;
  group.traverse(o => { if (o.isMesh) { meshes++; instances += o.isInstancedMesh ? o.count : 1; } });
  const metadata = { meshes, instances, ...counts, procedural: true };
  group.userData.metadata = metadata;
  return { group, emissiveSources, metadata };
}
