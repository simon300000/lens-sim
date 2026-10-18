import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { THREE, mat, woodMat, box, sphere, cylinder, beam, makeBatch, stoneGeometry, rockGeometry, leafGeometry, rng } from './kit.js';
import { nearBridge } from './garden-layout.js';

// All surfaces in this garden are geometry and colour. There are no image assets.
const TAU = Math.PI * 2;
const random = rng(7283);
const pondCentre = new THREE.Vector2(6.8, 7.7);
const pondRadius = new THREE.Vector2(3.5, 4.2);
export function pondPoint(t, extra = 0) {
  const wobble = 1 + .085 * Math.sin(t * 3 + .4) + .047 * Math.cos(t * 5 - .6);
  return new THREE.Vector2(pondCentre.x + (pondRadius.x * wobble + extra) * Math.cos(t), pondCentre.y + (pondRadius.y * wobble + extra) * Math.sin(t));
}

function pondShape() {
  const shape = new THREE.Shape();
  const points = Array.from({ length: 128 }, (_, i) => pondPoint(i / 128 * TAU));
  shape.moveTo(points[0].x, -points[0].y);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i].x, -points[i].y);
  shape.closePath();
  return { shape, points };
}

export function slab(parent, material, p, width, depth, height, angle = 0, seed = 1) {
  const draw = rng(seed), outline = new THREE.Shape();
  // Smoothly irregular natural outline: two random harmonics, not a polygon.
  const p1 = draw() * TAU, p2 = draw() * TAU, a1 = .05 + draw() * .05, a2 = .03 + draw() * .04;
  for (let i = 0; i < 18; i++) {
    const a = i / 18 * TAU, r = .9 + a1 * Math.sin(2 * a + p1) + a2 * Math.sin(3 * a + p2) + draw() * .03;
    const x = Math.cos(a) * width * .5 * r, z = Math.sin(a) * depth * .5 * r;
    if (i === 0) outline.moveTo(x, z); else outline.lineTo(x, z);
  }
  outline.closePath();
  const geometry = new THREE.ExtrudeGeometry(outline, { depth: height, bevelEnabled: true, bevelSegments: 2, bevelSize: .03, bevelThickness: .02, steps: 1 });
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...p); mesh.rotation.y = angle; mesh.receiveShadow = true; mesh.castShadow = true;
  parent.add(mesh); return mesh;
}

function addStoneLantern(parent) {
  const lantern = new THREE.Group(); lantern.name = 'Hand carved garden stone lantern'; lantern.position.set(3.4, .07, 5.0); parent.add(lantern);
  const granite = mat('#999988', .94), dark = mat('#777d6b', .94), roof = mat('#888e78', .95);
  slab(lantern, dark, [0, 0, 0], .79, .71, .11, .17, 50);
  cylinder(lantern, granite, [0, .2, 0], .24, .18);
  const postGeo = new THREE.CylinderGeometry(.16, .21, .7, 6);
  const post = new THREE.Mesh(postGeo, granite); post.position.y = .62; post.castShadow = true; lantern.add(post);
  cylinder(lantern, dark, [0, 1.01, 0], .31, .12, [0, Math.PI / 6, 0]);
  box(lantern, granite, [0, 1.11, 0], [.65, .12, .65]);
  const warm = mat('#edc17a', .5, { emissive: new THREE.Color('#d89b41'), emissiveIntensity: .45 });
  box(lantern, warm, [0, 1.32, 0], [.26, .34, .26]);
  for (const x of [-.23, .23]) for (const z of [-.23, .23]) box(lantern, granite, [x, 1.34, z], [.12, .43, .12]);
  box(lantern, granite, [0, 1.56, 0], [.64, .1, .64]);
  const roofGeo = new THREE.ConeGeometry(.58, .25, 4); roofGeo.rotateY(Math.PI / 4);
  const roofMesh = new THREE.Mesh(roofGeo, roof); roofMesh.position.y = 1.725; roofMesh.castShadow = true; lantern.add(roofMesh);
  box(lantern, roof, [0, 1.61, 0], [.86, .065, .86]);
  cylinder(lantern, dark, [0, 1.88, 0], .105, .08);
  sphere(lantern, granite, [0, 1.98, 0], [.12, .14, .12]);
  return lantern;
}

function addFurniture(parent) {
  const outdoor = new THREE.Group(); outdoor.name = 'Outdoor teak dining set with tea service'; outdoor.position.set(-5.8, .075, 4.7); outdoor.rotation.y = -.17; parent.add(outdoor);
  const wood = woodMat('#b59162'), darker = woodMat('#806441'), edge = woodMat('#9d764f');
  const plankRecords = [], darkRecords = [], edgeRecords = [];
  // The tabletop has real gaps between each plank, rounded corner pegs and bracing underneath.
  for (let i = 0; i < 10; i++) plankRecords.push({ p: [-.855 + i * .19, 1.03, 0], s: [.173, .075, 1.27], c: i % 3 ? '#b59162' : '#be9a6b' });
  edgeRecords.push({ p: [0, .965, -.48], s: [1.78, .12, .065] }, { p: [0, .965, .48], s: [1.78, .12, .065] });
  for (const x of [-.7, .7]) for (const z of [-.45, .45]) darkRecords.push({ p: [x, .49, z], s: [.09, .98, .09], r: [0, 0, x > 0 ? -.06 : .06] });
  darkRecords.push({ p: [0, .31, -.45], s: [1.45, .07, .055] }, { p: [0, .31, .45], s: [1.45, .07, .055] });
  const pegGeo = new THREE.CylinderGeometry(.011, .011, .012, 6);
  const pegs = [];
  for (let i = 0; i < 10; i++) for (const z of [-.44, .44]) pegs.push({ p: [-.855 + i * .19, 1.073, z] });
  makeBatch(outdoor, pegGeo, darker, pegs);
  makeBatch(outdoor, new THREE.BoxGeometry(1, 1, 1), wood, plankRecords);
  makeBatch(outdoor, new THREE.BoxGeometry(1, 1, 1), darker, darkRecords);
  makeBatch(outdoor, new THREE.BoxGeometry(1, 1, 1), edge, edgeRecords);

  const chairPositions = [[-1.42, .05, 0, -Math.PI / 2], [1.42, .05, 0, Math.PI / 2], [0, .05, 1.15, 0], [0, .05, -1.15, Math.PI]];
  for (const [x, y, z, angle] of chairPositions) {
    const chair = new THREE.Group(); chair.position.set(x, y, z); chair.rotation.y = angle; outdoor.add(chair);
    const lightParts = [], structuralParts = [];
    for (let i = 0; i < 5; i++) lightParts.push({ p: [-.26 + i * .13, .49, 0], s: [.115, .045, .62] });
    for (const cx of [-.29, .29]) {
      structuralParts.push({ p: [cx, .24, -.25], s: [.058, .5, .065], r: [-.06, 0, 0] });
      structuralParts.push({ p: [cx, .54, .25], s: [.062, 1.1, .065], r: [.07, 0, 0] });
      structuralParts.push({ p: [cx, .685, -.2], s: [.048, .4, .048] });
      lightParts.push({ p: [cx, .88, .02], s: [.085, .045, .65] });
      structuralParts.push({ p: [cx, .42, 0], s: [.055, .08, .64] });
      structuralParts.push({ p: [cx, .2, 0], s: [.043, .043, .53] });
    }
    for (let i = 0; i < 4; i++) lightParts.push({ p: [0, .66 + i * .105, .284 + i * .007], s: [.6, .074, .035], r: [.07, 0, 0] });
    structuralParts.push({ p: [0, .44, -.26], s: [.62, .08, .065] });
    makeBatch(chair, new THREE.BoxGeometry(1, 1, 1), wood, lightParts);
    makeBatch(chair, new THREE.BoxGeometry(1, 1, 1), darker, structuralParts);
  }

  // A low tray, glazed ceramic teapot, curved handle, open cups, and a tiny flower vase.
  const glaze = mat('#d3ddd2', .25, { metalness: .04 }), tea = mat('#6a4225', .48), clay = mat('#a7795c', .7);
  cylinder(outdoor, darker, [-.18, 1.084, .07], .36, .025);
  const teapot = new THREE.Group(); teapot.position.set(-.23, 1.1, .08); teapot.rotation.y = -.5; outdoor.add(teapot);
  sphere(teapot, glaze, [0, .105, 0], [.135, .105, .125]);
  cylinder(teapot, glaze, [0, .21, 0], .075, .026);
  sphere(teapot, darker, [0, .24, 0], [.025, .025, .025]);
  const spoutCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(.105, .085, 0), new THREE.Vector3(.17, .11, 0), new THREE.Vector3(.205, .18, 0)]);
  const spout = new THREE.Mesh(new THREE.TubeGeometry(spoutCurve, 8, .026, 7, false), glaze); spout.castShadow = true; teapot.add(spout);
  const handleCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(-.1, .15, 0), new THREE.Vector3(-.2, .19, 0), new THREE.Vector3(-.23, .1, 0), new THREE.Vector3(-.11, .04, 0)]);
  teapot.add(new THREE.Mesh(new THREE.TubeGeometry(handleCurve, 12, .015, 6, false), darker));
  const cupGeo = new THREE.LatheGeometry([new THREE.Vector2(.025, 0), new THREE.Vector2(.055, .008), new THREE.Vector2(.067, .064), new THREE.Vector2(.059, .067), new THREE.Vector2(.048, .016), new THREE.Vector2(0, .016)], 16);
  for (const [cx, cz] of [[.06, .15], [-.08, -.15], [.55, .37]]) {
    const cup = new THREE.Mesh(cupGeo, glaze); cup.position.set(cx, 1.1, cz); cup.castShadow = true; outdoor.add(cup);
    cylinder(outdoor, tea, [cx, 1.14, cz], .055, .002);
  }
  const vaseGeo = new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(.085, .005), new THREE.Vector2(.104, .11), new THREE.Vector2(.062, .2), new THREE.Vector2(.06, .23), new THREE.Vector2(.052, .23), new THREE.Vector2(.052, .205)], 16);
  const vase = new THREE.Mesh(vaseGeo, clay); vase.position.set(.56, 1.072, -.31); vase.castShadow = true; outdoor.add(vase);
  for (let i = 0; i < 3; i++) {
    const x = .55 + (i - 1) * .045, z = -.31 + (i % 2) * .025;
    beam(outdoor, mat('#637e43'), [.56, 1.25, -.31], [x, 1.57 + i * .02, z], .006);
    sphere(outdoor, mat(i === 1 ? '#e4d99e' : '#c1b46d'), [x, 1.58 + i * .02, z], [.036, .026, .036]);
  }
  return outdoor;
}

function koiGeometry(index) {
  const geometry = new THREE.BufferGeometry(), vertices = [], colors = [], indices = [];
  const rings = 26, sides = 16, cream = new THREE.Color(index % 4 === 3 ? '#eeb44f' : '#e9e0bf'), orange = new THREE.Color(index % 3 === 0 ? '#bd3c21' : '#df702d'), black = new THREE.Color('#263733');
  // A thick head, tapered caudal peduncle and slightly flattened underside.
  const profile = [[-.58, .012], [-.43, .05], [-.28, .102], [-.08, .147], [.16, .151], [.34, .119], [.44, .061], [.475, .018]];
  const widthAt = z => {
    let k = 0; while (k < profile.length - 2 && z > profile[k + 1][0]) k++;
    const a = profile[k], b = profile[k + 1], t = (z - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * t;
  };
  for (let i = 0; i <= rings; i++) {
    const z = -.58 + i / rings * 1.055, width = widthAt(z);
    for (let j = 0; j <= sides; j++) {
      const a = j / sides * TAU, x = Math.cos(a) * width, y = Math.sin(a) * width * .67;
      vertices.push(x, y, z);
      const blotch = Math.sin(z * 14 + index * 1.9) + .53 * Math.cos(a * 3 + z * 8 + index) + .22 * Math.sin(z * 36 - a * 2);
      let c = cream;
      if (blotch > .13 && y > -width * .47) c = orange;
      if ((index % 3 === 1 || index % 5 === 0) && Math.sin(z * 22 - index) + .7 * Math.cos(a * 4 + index) > 1.0 && y > -.02) c = black;
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < sides; j++) {
    const a = i * (sides + 1) + j, b = a + sides + 1; indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

function finGeometry(points, indices) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3)); g.setIndex(indices); g.computeVertexNormals(); return g;
}

// Fins/barbels share one plain material. Merge only within each fish and within
// identical shadow states; its parent pose, two-sided transparency and all
// triangles remain. This avoids hundreds of tiny PBR render objects per frame.
function mergeKoiFins(koi,material){
  const groups=new Map();
  for(const part of koi.children){
    if(part.material!==material)continue;
    const key=`${part.castShadow}/${part.receiveShadow}`;
    const group=groups.get(key)??[];group.push(part);groups.set(key,group);
  }
  for(const parts of groups.values()){
    if(parts.length<2)continue;
    const geometries=parts.map(part=>{
      part.updateMatrix();const geometry=part.geometry.clone().applyMatrix4(part.matrix);
      // Plain fin shading reads positions/normals; primitive rods also carry
      // unused UVs which are absent on the modelled sheet fins.
      geometry.deleteAttribute('uv');return geometry;
    });
    const geometry=mergeGeometries(geometries);for(const item of geometries)item.dispose();
    const merged=new THREE.Mesh(geometry,material);merged.name='Modelled koi fins';
    merged.castShadow=parts[0].castShadow;merged.receiveShadow=parts[0].receiveShadow;
    for(const part of parts)koi.remove(part);koi.add(merged);
  }
}

function addKoi(parent) {
  const bodies = mat('#ffffff', .43, { vertexColors: true, metalness: .04 });
  const fin = mat('#e3c898', .42, { side: THREE.DoubleSide, transparent: true, opacity: .86 }), eye = mat('#172422', .21), eyeRim = mat('#d9b36a', .55);
  const placements = [[5.7, 7.0, .6, 1.15], [7.15, 5.75, -1.0, 1.0], [8.65, 7.7, -2.3, 1.14], [6.6, 8.45, 2.5, .91], [5.0, 9.0, 1.15, .85], [8.0, 9.4, -1.85, 1.0], [7.3, 10.7, 2.75, .8], [6.0, 5.7, -.5, .78], [8.8, 5.8, -2.7, .84], [9.0, 8.95, .25, .83], [5.6, 10.35, -1.1, .74]];
  const fish = [];
  const tailGeometry = finGeometry([[0, 0, -.49], [0, 0, -.7], [-.24, .008, -.86], [-.1, .003, -.91], [0, 0, -.77], [.1, .003, -.91], [.24, .008, -.86]], [0, 1, 2, 1, 3, 2, 1, 4, 3, 0, 6, 1, 1, 6, 5, 1, 5, 4]);
  const dorsalGeometry = finGeometry([[0, .089, -.2], [0, .187, -.13], [0, .193, .08], [0, .091, .23]], [0, 1, 2, 0, 2, 3]);
  for (let i = 0; i < placements.length; i++) {
    const [x, z, angle, size] = placements[i], koi = new THREE.Group(); koi.name = `Koi ${i + 1}`; koi.position.set(x, -.012 + (i % 3) * .012, z); koi.rotation.y = angle; koi.scale.setScalar(size); parent.add(koi); fish.push(koi);
    const body = new THREE.Mesh(koiGeometry(i), bodies); body.castShadow = false; koi.add(body);
    koi.add(new THREE.Mesh(tailGeometry, fin), new THREE.Mesh(dorsalGeometry, fin));
    for (const side of [-1, 1]) {
      const pectoral = finGeometry([[side * .1, -.025, .17], [side * .3, -.018, .05], [side * .29, -.021, -.11], [side * .1, -.03, .015]], [0, 1, 2, 0, 2, 3]);
      koi.add(new THREE.Mesh(pectoral, fin));
      sphere(koi, eyeRim, [side * .077, .042, .362], [.032, .026, .028]);
      sphere(koi, eye, [side * .089, .057, .37], [.017, .017, .017]);
      beam(koi, fin, [side * .06, -.027, .434], [side * .086, -.027, .505], .005);
      // Thin fin rays make the broad transparent tails read as fins rather than wings.
      for (let k = 0; k < 3; k++) beam(koi, fin, [0, .004, -.55], [side * (.09 + k * .058), .006, -.855 + k * .018], .003);
    }
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(.019, .004, 4, 10), mat('#cfb690', .56)); mouth.position.set(0, -.006, .479); koi.add(mouth);
    mergeKoiFins(koi,fin);
  }
  return fish;
}

function lilyPadGeometry() {
  const shape = new THREE.Shape(); shape.moveTo(0, 0);
  const start = .22, end = TAU - .22;
  for (let i = 0; i <= 40; i++) {
    const a = start + (end - start) * i / 40, r = 1 - .035 * Math.sin(a * 5);
    shape.lineTo(Math.cos(a) * r, -Math.sin(a) * r);
  }
  shape.lineTo(0, 0); shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape); geometry.rotateX(-Math.PI / 2); return geometry;
}

function addLilies(parent) {
  const pad = mat('#476d3d', .49, { side: THREE.DoubleSide }), rib = mat('#6e8b50', .58);
  const pads = [], veins = [], blooms = [];
  const coords = [[4.62, 8.85, .34], [4.82, 9.46, .48], [5.28, 10.02, .39], [4.65, 10.21, .35], [8.37, 10.6, .43], [8.94, 10.2, .33], [8.61, 11.0, .31], [9.38, 6.38, .36], [9.63, 6.92, .45], [9.13, 7.03, .3]];
  const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 4);
  for (let i = 0; i < coords.length; i++) {
    const [x, z, scale] = coords[i], angle = random() * TAU;
    pads.push({ p: [x, .127 + (i % 2) * .005, z], s: [scale, 1, scale], r: [0, angle, 0], c: i % 2 ? '#597f45' : '#44693c' });
    for (let j = 0; j < 8; j++) {
      const a = angle + .3 + j / 8 * (TAU - .6), len = scale * .91;
      const start = new THREE.Vector3(x, .138, z), end = new THREE.Vector3(x + Math.cos(a) * len, .138, z + Math.sin(a) * len), d = end.clone().sub(start);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      veins.push({ p: start.add(end).multiplyScalar(.5).toArray(), s: [.003, d.length(), .003], q: q.toArray() });
    }
    if ([1, 4, 8].includes(i)) blooms.push([x + .05, .15, z - .04]);
  }
  makeBatch(parent, lilyPadGeometry(), pad, pads, { shadow: false });
  makeBatch(parent, unitCylinder, rib, veins, { shadow: false });
  const petalGeo = finGeometry([[0, 0, 0], [-.26, .06, .33], [0, .08, .38], [.26, .06, .33], [-.19, .27, .68], [0, .31, .82], [.19, .27, .68]], [0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3]);
  const petals = [], stamen = [], dots = [];
  for (let b = 0; b < blooms.length; b++) {
    const [x, y, z] = blooms[b];
    for (let layer = 0; layer < 3; layer++) {
      const number = 10 - layer * 2, scale = .47 - layer * .09;
      for (let k = 0; k < number; k++) petals.push({ p: [x, y + layer * .028, z], s: [scale, scale * (1 + layer * .7), scale], r: [0, k / number * TAU + layer * .28, 0], c: b === 2 ? (layer === 0 ? '#deded0' : '#f0eee1') : (layer === 0 ? '#cfa6a2' : '#e6c5bd') });
    }
    for (let k = 0; k < 12; k++) {
      const a = k / 12 * TAU, sx = x + Math.cos(a) * .034, sz = z + Math.sin(a) * .034;
      stamen.push({ p: [sx, y + .103, sz], s: [.0035, .087, .0035] });
      dots.push({ p: [sx, y + .15, sz], s: [.008, .01, .008] });
    }
  }
  makeBatch(parent, petalGeo, mat('#ffffff', .65, { vertexColors: false, side: THREE.DoubleSide }), petals, { shadow: false });
  makeBatch(parent, unitCylinder, mat('#c6a052', .75), stamen, { shadow: false });
  makeBatch(parent, new THREE.SphereGeometry(1, 6, 4), mat('#e4c46e', .65), dots, { shadow: false });
}

function addReeds(parent) {
  const stalks = [], blades = [], cattails = [], seedheads = [];
  const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 5), leaf = leafGeometry();
  for (const t of [.18, .65, .97, 1.47, 4.78, 5.4]) {
    const centre = pondPoint(t, -.06);
    for (let i = 0; i < 11; i++) {
      const x = centre.x + (random() - .5) * .42, z = centre.y + (random() - .5) * .42, height = .62 + random() * .6;
      if (nearBridge(x, z, .12)) continue;
      const bend = (random() - .5) * .28, start = new THREE.Vector3(x, .07, z), end = new THREE.Vector3(x + bend, .07 + height, z + bend * .6), d = end.clone().sub(start);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      stalks.push({ p: start.clone().add(end).multiplyScalar(.5).toArray(), s: [.008, d.length(), .008], q: q.toArray(), c: i % 3 ? '#708551' : '#8b9567' });
      for (let j = 0; j < 2; j++) {
        const a = random() * TAU, length = .46 + random() * .26, dir = new THREE.Vector3(Math.cos(a) * .48, .88, Math.sin(a) * .48).normalize();
        const lq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        blades.push({ p: [x, .13 + j * height * .23, z], s: [.1, .36, length], q: lq.toArray(), c: j ? '#658049' : '#7b9258' });
      }
      if (i % 4 === 0) {
        cattails.push({ p: end.clone().add(new THREE.Vector3(0, .05, 0)).toArray(), s: [.031, .21, .031], q: q.toArray() });
        seedheads.push({ p: end.clone().add(new THREE.Vector3(0, .19, 0)).toArray(), s: [.008, .09, .008] });
      }
    }
  }
  makeBatch(parent, unitCylinder, mat('#ffffff', .84), stalks);
  makeBatch(parent, leaf, mat('#ffffff', .8, { side: THREE.DoubleSide }), blades);
  makeBatch(parent, unitCylinder, mat('#6b5035', .92), cattails);
  makeBatch(parent, unitCylinder, mat('#aa9868', .86), seedheads);
}

function addBambooSpout(parent) {
  const bamboo = woodMat('#a0a26a'), rim = mat('#747e45', .9), inside = mat('#414a31', .9);
  const stand = new THREE.Group(); stand.name = 'Bamboo water spout'; stand.position.set(9.63, 0, 4.43); parent.add(stand);
  cylinder(stand, bamboo, [0, .57, 0], .075, 1.14);
  for (const y of [.16, .49, .91]) {
    const node = new THREE.Mesh(new THREE.TorusGeometry(.076, .011, 5, 12), rim); node.position.y = y; node.rotation.x = Math.PI / 2; stand.add(node);
  }
  beam(stand, rim, [-.16, .06, -.16], [.06, .81, .03], .034);
  const from = new THREE.Vector3(.15, .97, -.16), to = new THREE.Vector3(-.42, .78, .69), length = from.distanceTo(to), direction = to.clone().sub(from).normalize();
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(.112, .112, length, 12, 1, true), bamboo); pipe.position.copy(from.clone().add(to).multiplyScalar(.5)); pipe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction); pipe.castShadow = true; stand.add(pipe);
  const lining = new THREE.Mesh(new THREE.CylinderGeometry(.098, .098, length, 12, 1, true), inside); lining.position.copy(pipe.position); lining.quaternion.copy(pipe.quaternion); stand.add(lining);
  for (const p of [from, to]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(.096, .113, 12), rim); ring.position.copy(p); ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction); stand.add(ring);
  }
  const streamCurve = new THREE.CatmullRomCurve3([to.clone().add(direction.clone().multiplyScalar(.02)), new THREE.Vector3(-.48, .53, .8), new THREE.Vector3(-.48, .115, .83)]);
  const stream = new THREE.Mesh(new THREE.TubeGeometry(streamCurve, 10, .018, 6, false), mat('#bbd8d2', .13, { transparent: true, opacity: .57, metalness: .14 })); stand.add(stream);
  return new THREE.Vector3(9.15, .119, 5.26);
}

function addPondStones(parent) {
  const stones = [], small = [], moss = [], gravel = [];
  for (let i = 0; i < 69; i++) {
    const t = i / 69 * TAU + (random() - .5) * .023, p = pondPoint(t, .05 + random() * .12), width = .32 + random() * .29, h = .14 + random() * .23;
    // The bridge abutments replace the edging stones where it lands.
    if (nearBridge(p.x, p.y, .12)) continue;
    stones.push({ p: [p.x, .045 + h * .15, p.y], s: [width, h, .29 + random() * .22], r: [random() * .6, random() * TAU, random() * .3], c: ['#919084', '#8c9284', '#a6a594', '#7c8675', '#b1ab96'][i % 5] });
    if (i % 3 === 0) moss.push({ p: [p.x - .05, .046 + h * .74, p.y + .03], s: [width * .56, .035, .19], r: [0, random() * TAU, .1], c: i % 2 ? '#617849' : '#7a8750' });
    if (i % 2 === 0) {
      const q = pondPoint(t + .04, .49 + random() * .19);
      small.push({ p: [q.x, .08, q.y], s: [.12 + random() * .17, .07 + random() * .07, .14 + random() * .12], r: [random(), random() * TAU, random()], c: i % 3 ? '#96958a' : '#b2ae97' });
    }
  }
  for (let i = 0; i < 130; i++) {
    const a = random() * TAU, radius = Math.sqrt(random()) * .9;
    const p = pondPoint(a); const x = pondCentre.x + (p.x - pondCentre.x) * radius, z = pondCentre.y + (p.y - pondCentre.y) * radius;
    gravel.push({ p: [x, -.315, z], s: [.06 + random() * .12, .04 + random() * .025, .05 + random() * .1], r: [0, random() * TAU, 0], c: i % 3 ? '#8b927c' : '#c0b899' });
  }
  makeBatch(parent, stoneGeometry(778, 1), mat('#ffffff', .94), stones);
  makeBatch(parent, stoneGeometry(341), mat('#ffffff', .96), small);
  makeBatch(parent, new THREE.SphereGeometry(1, 8, 5), mat('#ffffff', .96), moss);
  makeBatch(parent, stoneGeometry(901), mat('#ffffff', .91), gravel, { shadow: false });
  // Three large weathered rocks anchor the pond composition; low pebbles fill their bases.
  const boulders = [[9.92, .25, 9.33, .72, .47, .65], [9.95, .19, 9.87, .5, .31, .41], [4.5, .16, 4.34, .63, .36, .51], [4.75, .12, 4.0, .38, .26, .34]];
  makeBatch(parent, rockGeometry(703), mat('#8b9382', .93), boulders.map(([x, y, z, sx, sy, sz], i) => ({ p: [x, y, z], s: [sx, sy, sz], r: [.13, i * 1.7, -.12] })));
}

function addPaths(parent) {
  const stone = mat('#b0ad9a', .95), stone2 = mat('#a09f8d', .97), grout = mat('#7d826d', 1);
  // Natural cut pavers under the table leave narrow grass joints around each stone.
  for (let ix = -2; ix <= 2; ix++) for (let iz = -2; iz <= 2; iz++) {
    const x = -5.8 + ix * .98, z = 4.7 + iz * .91;
    if (Math.abs(ix) === 2 && Math.abs(iz) === 2) continue;
    slab(parent, (ix + iz) % 3 === 0 ? stone2 : stone, [x, .045, z], .91 + random() * .07, .84 + random() * .05, .055, (random() - .5) * .13, 900 + ix * 30 + iz);
  }
  for (let z = 1.5, i = 0; z < 15.2; z += .94, i++) {
    const x = -2.2 + 1.8 * Math.sin(z * .27);
    slab(parent, i % 3 ? stone : stone2, [x + (i % 2 ? .14 : -.11), .048, z], .82 + random() * .24, .63 + random() * .2, .06, (random() - .5) * .4, 150 + i);
  }
  for (let i = 0; i < 4; i++) slab(parent, i % 2 ? stone2 : stone, [1.08 + i * .59, .045, 6.78 - i * .35], .6 + random() * .15, .5 + random() * .13, .06, random(), 201 + i);
  // A low, partly buried stone edging beside the terrace, with no enclosing diorama rim.
  const edging = [];
  for (let i = 0; i < 12; i++) edging.push({ p: [-8.32 + i * .44, .076, 2.18 + .05 * Math.sin(i)], s: [.22, .095, .17], r: [0, random() * TAU, .07] });
  makeBatch(parent, stoneGeometry(20), grout, edging);
}

function addRipples(parent, impact) {
  const rippleMaterial = mat('#b4cdc1', .2, { metalness: .08, transparent: true, opacity: .2, depthWrite: false });
  const rippleRecords = [];
  for (const [x, z, size] of [[impact.x, impact.z, .19], [6.0, 6.7, .42], [8.0, 8.3, .49], [6.4, 10.05, .3]]) for (let ring = 0; ring < 2; ring++) {
    rippleRecords.push({ p: [x, .115 + ring * .001, z], s: [(size + ring * .18) * 1.3, size + ring * .18, 1], r: [-Math.PI / 2, 0, .3] });
  }
  // A torus provides a real narrow reflective wave, instead of painting a texture onto water.
  makeBatch(parent, new THREE.TorusGeometry(1, .007, 3, 40, Math.PI * 1.75), rippleMaterial, rippleRecords, { shadow: false, receive: false });
}

export function buildGarden(scene) {
  const garden = new THREE.Group(); garden.name = 'Koi pond and garden living'; scene.add(garden);
  const { shape, points } = pondShape();
  const surfaceGeo = new THREE.ShapeGeometry(shape); surfaceGeo.rotateX(-Math.PI / 2);
  const bed = new THREE.Mesh(surfaceGeo, mat('#667465', .92)); bed.position.y = -.34; bed.receiveShadow = true; garden.add(bed);
  // Vertical dark banks make the depth legible when the terrain has its pond recess.
  const bankPositions = [], bankIndices = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], base = bankPositions.length / 3;
    bankPositions.push(a.x, -.35, a.y, b.x, -.35, b.y, b.x, .045, b.y, a.x, .045, a.y); bankIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const bankGeo = new THREE.BufferGeometry(); bankGeo.setAttribute('position', new THREE.Float32BufferAttribute(bankPositions, 3)); bankGeo.setIndex(bankIndices); bankGeo.computeVertexNormals();
  garden.add(new THREE.Mesh(bankGeo, mat('#62715e', .93, { side: THREE.DoubleSide })));
  const waterMaterial = new THREE.MeshPhysicalNodeMaterial({ color: '#72988c', transparent: true, opacity: .4, roughness: .16, metalness: .13, side: THREE.DoubleSide, depthWrite: false, clearcoat: 1, clearcoatRoughness: .14 });
  const water = new THREE.Mesh(surfaceGeo, waterMaterial); water.name = 'Clear pond water'; water.position.y = .11; water.receiveShadow = true; water.renderOrder = 3; garden.add(water);
  addPondStones(garden);
  const koi = addKoi(garden);
  addLilies(garden); addReeds(garden);
  const impact = addBambooSpout(garden); addRipples(garden, impact);
  const lantern = addStoneLantern(garden), furniture = addFurniture(garden); addPaths(garden);
  return { garden, water, koi, lantern, furniture, pondShape: shape, pondOutline: points.map(p => ({ x: p.x, z: p.y })), pondPoint };
}
