import { THREE, mat, woodMat, sphere, cylinder, beam, makeBatch, rng } from './kit.js';

// Every surface is built from geometry. The small joins, board gaps and roof
// seams are modeled, so the house needs no image maps or downloaded assets.
export function buildVilla(scene) {
  const group = new THREE.Group();
  group.name = 'Kaze mountain villa';
  scene.add(group);
  const random = rng(9064);
  const materials = {
    cedar: woodMat('#906945'), cedarLight: woodMat('#b28b61'), cedarDark: woodMat('#543e2d'),
    beam: woodMat('#6d4c33'), grain: mat('#7a5538', .93), plaster: mat('#e7e0cb', .94),
    base: mat('#76756a', .96), foundation: mat('#545b4e', .97), roof: mat('#354243', .8),
    roofSeam: mat('#253234', .72), roofLight: mat('#425050', .84), metal: mat('#414845', .58),
    tatami: mat('#c6bf87', .98), tatami2: mat('#bab781', .98), tatamiEdge: mat('#5a6246', .96),
    tatamiWeave: mat('#aca879', .99), paper: mat('#eee4ca', .95, { side: THREE.DoubleSide }),
    glass: mat('#9fb8ad', .2, { transparent: true, opacity: .2, side: THREE.DoubleSide, depthWrite: false }),
    cushion: mat('#7f8067', .96), cushion2: mat('#b08b66', .96), linen: mat('#d9ceb6', .99),
    ceramic: mat('#d0d4c3', .45), ceramicDark: mat('#344f4e', .43), bronze: mat('#64533a', .51),
    scroll: mat('#eee3c7', .94), ink: mat('#4d5a47', .98), warm: mat('#f1d9a3', .85, { emissive: '#d8a46a', emissiveIntensity: .27 }),
  };
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const batches = new Map();
  const addBox = (material, p, s, r = [0, 0, 0]) => {
    if (!batches.has(material)) batches.set(material, []);
    batches.get(material).push({ p, s, r });
  };
  const squareBeam = (material, a, b, thickness = .12, depth = thickness) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const delta = end.clone().sub(start);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize());
    if (!batches.has(material)) batches.set(material, []);
    batches.get(material).push({ p: start.add(end).multiplyScalar(.5).toArray(), s: [thickness, delta.length(), depth], q: q.toArray() });
  };
  const ring = (material, p, radius, tube, rotation = [0, 0, 0]) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 5, 20), material);
    m.position.set(...p); m.rotation.set(...rotation); m.castShadow = true; group.add(m); return m;
  };
  const pottery = (material, p, height, radius, profile = 'vase') => {
    const points = profile === 'bowl'
      ? [[0, 0], [.43, 0], [.55, .09], [.77, .32], [1, .7], [1.01, .83], [.92, .85], [.79, .35], [.46, .11], [0, .11]]
      : [[0, 0], [.53, 0], [.77, .12], [1, .39], [.91, .64], [.57, .83], [.48, 1], [.37, 1], [.41, .82], [.73, .61], [.78, .39], [.58, .15], [0, .13]];
    const g = new THREE.LatheGeometry(points.map(v => new THREE.Vector2(v[0] * radius, v[1] * height)), 18);
    const m = new THREE.Mesh(g, material); m.position.set(...p); m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
  };

  // Concrete footing sits well behind the timber edge, with individual stone
  // pier feet visible through the open space below the engawa.
  addBox(materials.foundation, [-3, .23, -5], [11.7, .46, 6.85]);
  addBox(materials.base, [-3, .49, -5], [12.12, .18, 7.12]);
  addBox(materials.cedarDark, [-3, .555, 0], [14, .15, 3]);
  for (const x of [-9.4, -6.8, -3.6, -.4, 3.4]) {
    for (const z of [-.85, .95]) {
      cylinder(group, materials.foundation, [x, .19, z], .23, .38);
      addBox(materials.beam, [x, .41, z], [.19, .34, .19]);
    }
  }
  // Planks run out toward the garden; each has an actual expansion joint.
  for (let i = 0; i < 100; i++) {
    const x = -9.93 + i * .14;
    const wood = i % 5 === 0 ? materials.cedarLight : materials.cedar;
    addBox(wood, [x, .633, 0], [.134, .075, 3]);
    for (let j = 0; j < 2; j++) {
      addBox(materials.grain, [x + (j ? .031 : -.042), .672, -.92 + random() * 1.8], [.005, .002, .25 + random() * .6]);
    }
  }
  addBox(materials.cedarDark, [-3, .563, 1.52], [14.08, .2, .11]);
  addBox(materials.cedarDark, [-10.025, .56, 0], [.09, .2, 3.07]);
  addBox(materials.cedarDark, [4.025, .56, 0], [.09, .2, 3.07]);
  for (let i = 0; i < 3; i++) {
    const z = 1.73 + i * .3, y = .49 - i * .15;
    addBox(materials.cedarDark, [-1, y - .07, z], [2.5, .15, .36]);
    for (let k = 0; k < 18; k++) addBox(materials.cedarLight, [-2.19 + k * .14, y + .015, z], [.133, .035, .33]);
  }
  // Room perimeter and the quieter timber-floored tea/reading nook at right.
  addBox(materials.cedarDark, [-3, .64, -5], [12, .14, 7]);
  for (let i = 0; i < 85; i++) addBox(i % 6 === 0 ? materials.cedarLight : materials.cedar, [-8.94 + i * .14, .735, -5], [.133, .07, 6.93]);
  for (let ix = 0; ix < 6; ix++) {
    for (let iz = 0; iz < 4; iz++) {
      const x = -8.02 + ix * 1.31, z = -7.28 + iz * 1.53;
      addBox((ix + iz) % 2 ? materials.tatami2 : materials.tatami, [x, .79, z], [1.283, .064, 1.5]);
      addBox(materials.tatamiEdge, [x - .619, .826, z], [.041, .005, 1.5]);
      addBox(materials.tatamiEdge, [x + .619, .826, z], [.041, .005, 1.5]);
      for (let w = 0; w < 9; w++) addBox(materials.tatamiWeave, [x, .824, z - .674 + w * .167], [1.23, .002, .008]);
    }
  }

  // Walls have real openings. The garden-facing wall is an exposed cedar beam
  // and stacked shoji screens at its edges, leaving an 8.8 metre clear opening.
  addBox(materials.plaster, [-3, 2.455, -8.44], [12, 3.43, .18]);
  addBox(materials.plaster, [-8.94, 2.455, -5], [.18, 3.43, 7]);
  addBox(materials.plaster, [2.94, 1.145, -5], [.18, .79, 7]);
  addBox(materials.plaster, [2.94, 3.89, -5], [.18, .51, 7]);
  addBox(materials.plaster, [2.94, 2.58, -7.775], [.18, 1.85, 1.45]);
  addBox(materials.plaster, [2.94, 2.58, -2.14], [.18, 1.85, 1.3]);
  const rightGlass = new THREE.Mesh(new THREE.PlaneGeometry(4.22, 1.88), materials.glass);
  rightGlass.rotation.y = Math.PI / 2; rightGlass.position.set(2.95, 2.58, -4.98); group.add(rightGlass);
  for (const z of [-7.08, -4.98, -2.88]) addBox(materials.cedarDark, [2.98, 2.59, z], [.13, 2.03, .07]);
  for (const y of [1.56, 2.61, 3.62]) addBox(materials.cedarDark, [2.98, y, -4.98], [.13, .07, 4.33]);
  addBox(materials.cedarLight, [3.055, 1.52, -4.98], [.36, .08, 4.48]);
  for (const x of [-9, 3]) {
    for (const z of [-8.42, -1.48]) addBox(materials.beam, [x, 2.43, z], [.24, 3.54, .24]);
  }
  for (const x of [-9.33, 3.33]) addBox(materials.beam, [x, 2.43, -.32], [.21, 3.54, .21]);
  for (const z of [-8.4, -1.45]) addBox(materials.beam, [-3, 4.07, z], [12.3, .27, .23]);
  for (const x of [-8.92, 2.92]) addBox(materials.beam, [x, 4.09, -5], [.22, .26, 7.1]);
  addBox(materials.beam, [-3, 4.09, -.34], [13, .24, .23]);
  for (const z of [-7.1, -5.3, -3.5]) addBox(materials.cedarDark, [-3, 4.03, z], [11.9, .18, .16]);
  addBox(materials.cedarLight, [-3, 4.17, -5], [11.83, .07, 6.94]);
  for (let i = 0; i < 42; i++) addBox(materials.cedarDark, [-8.76 + i * .28, 4.115, -5], [.025, .02, 6.91]);
  for (const x of [-8.83, 2.82]) addBox(materials.cedarDark, [x, .87, -5], [.055, .16, 6.77]);
  addBox(materials.cedarDark, [-3, .87, -8.30], [11.75, .16, .055]);
  // Exterior battens give the side facade a distinct fine vertical rhythm.
  for (let i = 0; i < 37; i++) {
    const z = -8.39 + i * .19;
    addBox(i % 4 ? materials.cedar : materials.cedarLight, [-9.075, 2.46, z], [.085, 3.22, .045]);
  }
  for (let i = 0; i < 28; i++) {
    const z = -8.33 + i * .247;
    addBox(materials.cedar, [3.065, 1.14, z], [.075, .67, .045]);
  }
  // Pair of sliding panels, parked across the fixed outer bays.
  for (const centerX of [-8.30, 2.30]) {
    for (let layer = 0; layer < 2; layer++) {
      const x = centerX + (centerX < 0 ? -.10 : .10) * layer, z = -1.385 + layer * .105;
      addBox(materials.paper, [x, 2.33, z], [1.07, 2.89, .027]);
      for (const edge of [-.565, .565]) addBox(materials.cedarDark, [x + edge, 2.33, z + .036], [.058, 3.04, .058]);
      for (const y of [.80, 3.86]) addBox(materials.cedarDark, [x, y, z + .036], [1.185, .075, .058]);
      for (let ix = 0; ix < 3; ix++) addBox(materials.cedar, [x - .36 + ix * .36, 2.34, z + .042], [.025, 2.91, .024]);
      for (let iy = 0; iy < 9; iy++) addBox(materials.cedar, [x, .96 + iy * .344, z + .042], [1.09, .023, .025]);
      addBox(materials.cedarDark, [x + .41, 2.19, z + .065], [.065, .16, .028]);
    }
  }
  for (const z of [-1.33, -1.23]) {
    addBox(materials.cedarDark, [-3, .773, z], [12.1, .015, .013]);
    addBox(materials.cedarDark, [-3, 3.91, z], [12.1, .018, .013]);
  }

  // Pitched, standing-seam roof. Every sheet and its raised folded seam is
  // separate geometry, with modeled ridge caps, rake trims, fascia and soffits.
  const rise = 2.3, run = 4.45, slope = Math.atan2(rise, run), slopeLength = Math.hypot(rise, run);
  for (const front of [true, false]) {
    const angle = front ? slope : -slope;
    const z = front ? -2.625 : -7.075;
    for (let i = 0; i < 24; i++) {
      const x = -9.706 + i * .5833;
      addBox(i % 7 === 0 ? materials.roofLight : materials.roof, [x, 5.352, z], [.579, .084, slopeLength], [angle, 0, 0]);
      addBox(materials.roofSeam, [x + .285, 5.408, z], [.023, .065, slopeLength + .018], [angle, 0, 0]);
    }
    for (let ix = 0; ix < 20; ix++) addBox(materials.beam, [-9.75 + ix * .71, 5.21, z], [.085, .14, slopeLength + .055], [angle, 0, 0]);
    addBox(materials.cedarDark, [-3, 5.232, z], [14.09, .065, slopeLength + .018], [angle, 0, 0]);
    for (const x of [-10.025, 4.025]) addBox(materials.roofSeam, [x, 5.36, z], [.115, .16, slopeLength + .10], [angle, 0, 0]);
    addBox(materials.beam, [-3, 4.177, front ? -.39 : -9.31], [14.16, .21, .17]);
    addBox(materials.roofSeam, [-3, 4.286, front ? -.365 : -9.335], [14.28, .045, .19]);
    // Eaves expose rounded rafter ends beyond the darker soffit.
    for (let ix = 0; ix < 20; ix++) addBox(materials.cedarLight, [-9.75 + ix * .71, 4.14, front ? -.32 : -9.38], [.08, .105, .14]);
  }
  addBox(materials.roofSeam, [-3, 6.545, -4.85], [14.38, .17, .35]);
  addBox(materials.roofLight, [-3, 6.639, -4.85], [14.43, .039, .19]);
  for (let i = 0; i < 12; i++) addBox(materials.roofSeam, [-9.84 + i * 1.245, 6.643, -4.85], [.035, .035, .38]);
  for (const x of [-8.98, 2.98]) {
    const gable = new THREE.BufferGeometry();
    gable.setAttribute('position', new THREE.Float32BufferAttribute([x, 4.18, -8.46, x, 6.32, -4.85, x, 4.18, -1.24], 3));
    gable.setIndex(x < 0 ? [2, 1, 0] : [0, 1, 2]); gable.computeVertexNormals();
    const gableMesh = new THREE.Mesh(gable, materials.cedar); gableMesh.castShadow = true; gableMesh.receiveShadow = true; group.add(gableMesh);
    for (let i = 0; i < 29; i++) {
      const z = -8.3 + i * .247, height = 2.05 * (1 - Math.abs(z + 4.85) / 3.61);
      if (height > .09) addBox(materials.cedarDark, [x + (x < 0 ? -.038 : .038), 4.2 + height * .5, z], [.028, height, .037]);
    }
    squareBeam(materials.beam, [x, 4.16, -8.43], [x, 6.36, -4.85], .16);
    squareBeam(materials.beam, [x, 6.36, -4.85], [x, 4.16, -1.27], .16);
  }
  // A small flue and quiet rain chain add asymmetry to the roof silhouette.
  addBox(materials.metal, [-7.20, 6.10, -6.25], [.34, 1.21, .34]);
  addBox(materials.roofSeam, [-7.20, 6.78, -6.25], [.56, .10, .52]);
  addBox(materials.metal, [-7.20, 6.91, -6.25], [.42, .04, .38]);
  for (const dx of [-.16, .16]) addBox(materials.metal, [-7.20 + dx, 6.86, -6.25], [.027, .18, .28]);
  beam(group, materials.metal, [-10.07, 4.18, -9.37], [4.09, 4.18, -9.37], .065);
  beam(group, materials.metal, [3.38, 4.18, -9.37], [3.38, .33, -9.37], .055);
  const chainGeometry = new THREE.TorusGeometry(.056, .012, 5, 12), chainRecords = [];
  for (let i = 0; i < 29; i++) chainRecords.push({ p: [3.69, 1.02 + i * .108, -.38], r: [0, i % 2 ? Math.PI / 2 : 0, 0] });
  makeBatch(group, chainGeometry, materials.bronze, chainRecords);
  pottery(materials.ceramicDark, [3.69, .68, -.38], .3, .36, 'bowl');

  // Tokonoma: dark inset, a hand-built branch arrangement and an ink scroll.
  addBox(materials.cedarDark, [-5.52, 1.93, -8.28], [2.61, 2.10, .08]);
  addBox(materials.cedarLight, [-5.52, .92, -7.99], [2.72, .14, .65]);
  addBox(materials.beam, [-5.52, 3.02, -8.12], [2.75, .1, .36]);
  addBox(materials.scroll, [-5.73, 2.12, -8.19], [.74, 1.25, .012]);
  for (const y of [1.48, 2.77]) beam(group, materials.bronze, [-6.15, y, -8.15], [-5.31, y, -8.15], .017);
  // Abstract tiny mountain brush strokes are geometry on the scroll.
  squareBeam(materials.ink, [-6.01, 1.98, -8.17], [-5.76, 2.30, -8.17], .016);
  squareBeam(materials.ink, [-5.76, 2.30, -8.17], [-5.59, 2.05, -8.17], .019);
  squareBeam(materials.ink, [-5.79, 2.05, -8.16], [-5.51, 2.28, -8.16], .013);
  squareBeam(materials.ink, [-5.51, 2.28, -8.16], [-5.36, 1.97, -8.16], .014);
  pottery(materials.ceramicDark, [-4.90, 1.0, -7.87], .32, .18);
  beam(group, materials.cedarDark, [-4.90, 1.28, -7.87], [-4.72, 2.08, -7.80], .009);
  beam(group, materials.cedarDark, [-4.79, 1.70, -7.84], [-5.13, 1.95, -7.78], .007);
  beam(group, materials.cedarDark, [-4.76, 1.87, -7.82], [-4.51, 1.99, -7.72], .006);
  for (const p of [[-4.73, 2.06, -7.8], [-5.09, 1.94, -7.78], [-4.53, 2.00, -7.72]]) {
    sphere(group, materials.plaster, p, [.055, .035, .06]);
    sphere(group, materials.ink, [p[0] + .025, p[1] - .063, p[2]], [.075, .018, .034], [0, .6, .35]);
  }

  // Low solid-cedar table, tea service, six floor cushions and folded cloth.
  addBox(materials.cedarDark, [-3.92, 1.23, -4.89], [3.10, .16, 1.69]);
  for (let i = 0; i < 8; i++) addBox(materials.cedar, [-5.275 + i * .388, 1.316, -4.89], [.383, .020, 1.676]);
  for (const x of [-5.14, -2.70]) for (const z of [-5.49, -4.28]) addBox(materials.beam, [x, 1.00, z], [.18, .46, .18]);
  addBox(materials.cedarDark, [-3.92, 1.07, -4.89], [2.6, .12, .11]);
  for (let side = 0; side < 2; side++) {
    for (let ix = 0; ix < 3; ix++) {
      const x = -5.01 + ix * 1.06, z = side ? -3.64 : -6.14;
      const color = (ix + side) % 2 ? materials.cushion : materials.cushion2;
      addBox(color, [x, .93, z], [.79, .18, .69], [0, (random() - .5) * .08, 0]);
      addBox(materials.linen, [x, 1.025, z], [.047, .004, .047]);
      for (const edge of [-.377, .377]) addBox(materials.linen, [x + edge, .93, z], [.012, .024, .59]);
    }
  }
  addBox(materials.linen, [-4.18, 1.333, -4.77], [1.49, .012, .38], [0, .03, 0]);
  addBox(materials.cedarDark, [-3.70, 1.37, -4.97], [.77, .045, .52]);
  pottery(materials.ceramicDark, [-3.70, 1.40, -4.99], .17, .16);
  sphere(group, materials.ceramicDark, [-3.70, 1.53, -4.99], [.12, .028, .12]);
  sphere(group, materials.cedarDark, [-3.70, 1.569, -4.99], [.025, .025, .025]);
  beam(group, materials.ceramicDark, [-3.58, 1.47, -4.99], [-3.48, 1.55, -4.99], .025, .016);
  ring(materials.ceramicDark, [-3.82, 1.51, -4.99], .084, .012, [0, Math.PI / 2, 0]);
  for (const x of [-3.94, -3.43]) pottery(materials.ceramic, [x, 1.40, -4.79], .079, .048, 'bowl');
  pottery(materials.ceramic, [-4.87, 1.335, -4.96], .05, .21, 'bowl');
  for (let i = 0; i < 3; i++) sphere(group, materials.cushion2, [-4.99 + i * .095, 1.387, -4.95], [.041, .027, .035]);

  // Built-in cedar library and a secondary reading bench in the right bay.
  addBox(materials.cedarDark, [1.64, 1.91, -8.16], [1.75, 2.23, .09]);
  for (const x of [.73, 2.55]) addBox(materials.cedar, [x, 1.89, -7.89], [.09, 2.28, .58]);
  for (const y of [.79, 1.38, 1.97, 2.56, 3.04]) addBox(materials.cedarLight, [1.64, y, -7.89], [1.88, .066, .64]);
  const bookColors = ['#9f9a75', '#61716c', '#a57453', '#d0c6ab', '#555e4e', '#86765d'].map(c => mat(c, .95));
  for (let i = 0; i < 22; i++) {
    const level = Math.floor(i / 8), col = i % 8, height = .30 + random() * .18;
    const x = .86 + col * .112, y = .83 + level * .59 + height * .5;
    addBox(bookColors[i % bookColors.length], [x, y, -7.86], [.072 + random() * .028, height, .32], [0, 0, i % 8 === 7 ? -.12 : 0]);
    addBox(materials.linen, [x, y - height * .31, -7.693], [.062, .011, .004]);
  }
  pottery(materials.ceramic, [2.18, 2.595, -7.83], .30, .13);
  pottery(materials.ceramicDark, [1.05, 2.595, -7.84], .22, .09);
  addBox(materials.cedarDark, [1.55, 1.02, -3.41], [1.85, .16, .75]);
  for (const x of [.87, 2.23]) addBox(materials.cedar, [x, .875, -3.41], [.12, .26, .58]);
  addBox(materials.cushion, [1.55, 1.15, -3.42], [1.74, .14, .67]);
  addBox(materials.cedarDark, [2.52, 1.44, -5.70], [.45, 1.3, 1.9]);
  addBox(materials.cedarLight, [2.43, 2.11, -5.70], [.66, .08, 2.07]);
  for (const z of [-6.18, -5.23]) {
    addBox(materials.cedar, [2.285, 1.45, z], [.019, 1.12, .87]);
    addBox(materials.bronze, [2.266, 1.72, z], [.026, .025, .2]);
  }
  pottery(materials.ceramic, [2.40, 2.153, -6.09], .09, .17, 'bowl');
  pottery(materials.ceramicDark, [2.45, 2.153, -5.34], .22, .10);

  // Paper pendants with complete fine timber ribs, also visible through the
  // open doors. A soft local light reveals the otherwise deeply shaded room.
  const ribGeometry = new THREE.TorusGeometry(1, .008, 4, 32), ribRecords = [];
  for (const p of [[-6.59, 3.39, -4.24], [-.49, 3.41, -5.97]]) {
    beam(group, materials.cedarDark, [p[0], 4.11, p[2]], [p[0], p[1] + .27, p[2]], .008);
    sphere(group, materials.warm, p, [.29, .28, .29]);
    for (let i = 0; i < 9; i++) {
      const y = -.224 + i * .056, radius = .29 * Math.sqrt(Math.max(.05, 1 - (y / .28) ** 2));
      ribRecords.push({ p: [p[0], p[1] + y, p[2]], s: [radius, radius, radius], r: [Math.PI / 2, 0, 0] });
    }
    cylinder(group, materials.cedarDark, [p[0], p[1] + .274, p[2]], .054, .028);
    cylinder(group, materials.cedarDark, [p[0], p[1] - .274, p[2]], .052, .028);
  }
  makeBatch(group, ribGeometry, materials.cedar, ribRecords);
  const roomGlow = new THREE.PointLight('#ffddb1', 2.8, 8, 2);
  roomGlow.position.set(-3.2, 2.8, -4.6); group.add(roomGlow);
  // Small deck lantern and sandals indicate a lived-in retreat.
  addBox(materials.cedarDark, [-8.77, .73, .47], [.42, .11, .42]);
  addBox(materials.warm, [-8.77, 1.00, .47], [.29, .47, .29]);
  for (const x of [-8.96, -8.58]) for (const z of [.28, .66]) addBox(materials.cedarDark, [x, 1.00, z], [.043, .49, .043]);
  addBox(materials.cedarDark, [-8.77, 1.29, .47], [.47, .09, .47]);
  for (const y of [.89, 1.08]) {
    for (const z of [.27, .67]) addBox(materials.cedarDark, [-8.77, y, z], [.4, .022, .025]);
    for (const x of [-8.97, -8.57]) addBox(materials.cedarDark, [x, y, .47], [.025, .022, .4]);
  }
  for (const x of [.9, 1.16]) {
    addBox(materials.cedarLight, [x, .702, -.93], [.18, .057, .41], [0, .13, 0]);
    squareBeam(materials.cedarDark, [x - .067, .746, -.91], [x, .799, -.88], .023);
    squareBeam(materials.cedarDark, [x, .799, -.88], [x + .067, .746, -.91], .023);
  }

  for (const [material, records] of batches) makeBatch(group, unitBox, material, records);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  let meshes = 0, instances = 0, triangles = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    const count = o.isInstancedMesh ? o.count : 1; instances += count;
    triangles += (o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3) * count;
  });
  const metadata = { name: group.name, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, meshes, instances, triangles, clearOpening: 8.8 };
  group.userData.metadata = metadata;
  return { group, metadata };
}
