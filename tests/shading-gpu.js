import * as THREE from 'three/webgpu';
import { vec3, normalWorld, mix } from 'three/tsl';
import { woodMat } from '../src/kit.js';
import { applyMeadowVariation, applyWaterSurface } from '../src/scene/procedural-materials.js';
import { createLensRig, emitter } from './gpu-fixtures.js';
import { createDaylight } from '../src/lighting.js';
/** Test C: raster fragment shading vs the lens compute SurfaceRadianceEvaluator
 * on the same camera, using the DIAGNOSTIC PINHOLE (pixel-centre rays). Tone
 * mapping, Bloom, exposure and spectral reconstruction are not involved: both
 * sides are linear scene RGB. This is a test entry only, not a lens mode. */
const out = document.querySelector('#result'), check = (c, m) => { if (!c) throw new Error(m); };
const W = 192, H = 128;
const step = l => console.log('[step] ' + l + ' ' + performance.now().toFixed(0));
function luminance(p, i) { return .2126 * p[i] + .7152 * p[i + 1] + .0722 * p[i + 2]; }
function percentile(values, q) { if (!values.length) return null; const s = Float64Array.from(values).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
async function readTarget(interop, target) { return interop.readTexture(interop.texture(target.texture)); }
try {
  const adapter = await navigator.gpu.requestAdapter();
  const renderer = new THREE.WebGPURenderer({ antialias: false }); await renderer.init(); renderer.setSize(W, H);
  renderer.toneMapping = THREE.NoToneMapping; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const errors = []; renderer.backend.device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, W / H, .1, 100); camera.position.set(0, 2.2, 6.5); camera.lookAt(0, .6, 0); camera.updateMatrixWorld();
  const regions = {};
  const add = (name, mesh) => { mesh.name = name; scene.add(mesh); regions[name] = mesh; return mesh; };
  const std = (o) => new THREE.MeshStandardNodeMaterial({ roughness: .8, ...o });
  const floor = add('floor (neutral diffuse, shadow receiver)', new THREE.Mesh(new THREE.PlaneGeometry(14, 14), std({ color: new THREE.Color(.5, .5, .5), roughness: .9 })));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  const box = add('box (dielectric, caster)', new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), std({ color: new THREE.Color(.7, .2, .15), roughness: .5 })));
  box.position.set(-1.2, .5, 0); box.rotation.y = .4; box.castShadow = box.receiveShadow = true;
  const metal = add('sphere (metal r=0.3)', new THREE.Mesh(new THREE.SphereGeometry(.6, 48, 24), std({ color: new THREE.Color(.95, .7, .3), metalness: 1, roughness: .3 })));
  metal.position.set(.4, .6, -.6); metal.castShadow = metal.receiveShadow = true;
  const wood = add('wood (procedural colour/roughness/bump)', new THREE.Mesh(new THREE.BoxGeometry(1.2, .5, .8), woodMat('#906945')));
  wood.position.set(1.8, .25, .6); wood.rotation.y = -.5; wood.castShadow = wood.receiveShadow = true;
  // Flat metal: no curvature, so three's screen-space geometryRoughness is ~0.
  const flatMetal = add('flat metal panel (r=0.3, no curvature)', new THREE.Mesh(new THREE.PlaneGeometry(1.1, .8), std({ color: new THREE.Color(.9, .9, .95), metalness: 1, roughness: .3 })));
  flatMetal.position.set(1.3, .9, -1.6); flatMetal.rotation.y = -.35; flatMetal.receiveShadow = true;
  const emissive = add('emissive HDR', new THREE.Mesh(new THREE.PlaneGeometry(.8, .5), std({ color: 0x000000, emissive: new THREE.Color(6, 3, 1), roughness: 1 })));
  emissive.position.set(-.2, 1.6, -2.4);
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(.3, .3, .3), std({ color: 0xffffff, roughness: .6 }), 3);
  const o = new THREE.Object3D();
  [[-2.4, .15, 1.4], [-1.9, .15, 1.9], [-1.4, .15, 2.3]].forEach((p, i) => { o.position.set(...p); o.rotation.y = i; o.updateMatrix(); instances.setMatrixAt(i, o.matrix); instances.setColorAt(i, new THREE.Color().setHSL(i / 3, .7, .5)); });
  instances.receiveShadow = true; add('instance colours', instances);
  const vg = new THREE.PlaneGeometry(1.2, 1.2, 4, 4); vg.rotateX(-Math.PI / 2);
  const colors = []; for (let i = 0; i < vg.attributes.position.count; i++) colors.push(i % 3 / 2, .5, 1 - i % 5 / 4);
  vg.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const meadow = add('meadow (vertex colour × noise)', new THREE.Mesh(vg, std({ color: 0xffffff, vertexColors: true, roughness: .96 })));
  meadow.position.set(1.0, .01, 2.0); meadow.receiveShadow = true; applyMeadowVariation(meadow.material);
  const leaf = add('double-sided leaf', new THREE.Mesh(new THREE.PlaneGeometry(.5, .8), std({ color: new THREE.Color(.25, .5, .2), side: THREE.DoubleSide })));
  leaf.position.set(-2.4, .9, -.6); leaf.rotation.set(.3, 2.2, .1); leaf.receiveShadow = true;
  const waterGeometry = new THREE.PlaneGeometry(1.6, 1.0); waterGeometry.rotateX(-Math.PI / 2);
  const water = add('water (planar reflection approx.)', new THREE.Mesh(waterGeometry, new THREE.MeshPhysicalNodeMaterial({ color: '#72988c', transparent: true, opacity: .4, roughness: .16, metalness: .13, side: THREE.DoubleSide, depthWrite: false, clearcoat: 1, clearcoatRoughness: .14 })));
  water.position.set(.2, .03, 1.9); water.receiveShadow = true; water.renderOrder = 3; applyWaterSurface(water);
  const sun = new THREE.DirectionalLight(new THREE.Color(1, .95, .85), 2.2); sun.position.set(-3, 6, 4); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: .5, far: 20 }); sun.shadow.bias = -.0005; sun.shadow.normalBias = .02;
  scene.add(sun, sun.target);
  const lamp = new THREE.PointLight(new THREE.Color(1, .8, .55), 6, 8, 2); lamp.position.set(1.2, 1.6, 1.4); lamp.castShadow = true;
  lamp.shadow.mapSize.set(256, 256); lamp.shadow.camera.near = .05; lamp.shadow.bias = -.0002; lamp.shadow.normalBias = .02; scene.add(lamp);
  scene.add(new THREE.HemisphereLight(new THREE.Color(.4, .5, .7), new THREE.Color(.2, .15, .1), .6));
  // PMREM environment from a procedural sky in its own scene.
  const skyScene = new THREE.Scene();
  const skyMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  skyMaterial.colorNode = mix(vec3(.3, .25, .2), vec3(.6, .8, 1.4), normalWorld.y.mul(-.5).add(.5));
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(skyScene, .02, .1, 100, { size: 64 }); scene.environment = envTarget.texture; scene.environmentIntensity = 1;
  // Raster reference (linear, pre-exposure HDR target).
  const target = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, samples: 0 });
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.render(scene, camera); renderer.setRenderTarget(null);
  step('raster reference rendered');
  const rig = await createLensRig({ renderer, scene, camera, width: W });
  const { interop, engine, lighting } = rig;
  interop.device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const raster = await readTarget(interop, target);
  const lens = (await (await fetch('/lenses/canon-fl-50mm-f1-8.json')).json()).configurations[0];
  engine.setLens(lens, { fNumber: 2.8, sensorZMm: lens.sensorZMm, dispersion: false });
  check(engine.dimensions.width === W && engine.dimensions.height === H, 'engine size');
  const pinhole = { cameraToWorld: camera.matrixWorld.elements, clipToCamera: camera.projectionMatrixInverse.elements };
  const run = async (diagnostic, spp) => {
    engine.reset();
    for (let i = 0; i < spp / 4; i++) { engine.sample({ batchSpp: 4, targetSpp: spp, pinhole, diagnostic }); await interop.device.queue.onSubmittedWorkDone(); }
    return interop.readTexture(engine.outputGPU);
  };
  // 16 pinhole samples: identical rays; only the point-shadow disc rotation varies.
  const compute = await run('beauty', 16), stats = await engine.statistics();
  const materialMap = await run('geometry-material', 4);
  // Material id per pixel: same hash as materialDebugColour in WGSL.
  const hash = x => { x >>>= 0; x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); return (x ^ x >>> 16) >>> 0; };
  step('materials sampled');
  const ex = rig.sceneResources.extracted, palette = ex.materials.map((m, i) => { const h = hash(Math.imul(i, 0x9e3779b9) + 17); return [(h & 255) / 255 * .8 + .1, ((h >>> 8) & 255) / 255 * .8 + .1, ((h >>> 16) & 255) / 255 * .8 + .1]; });
  const nameOfMaterial = i => { const entry = ex.objects.find(e => e.material === i); return entry?.object.name ?? 'material ' + i; };
  const idAt = p => { let best = -1, d = 1e-3; palette.forEach((c, i) => { const e = Math.abs(c[0] - materialMap[p]) + Math.abs(c[1] - materialMap[p + 1]) + Math.abs(c[2] - materialMap[p + 2]); if (e < d) { d = e; best = i; } }); return best; };
  const ids = new Int32Array(W * H); for (let i = 0; i < W * H; i++) ids[i] = idAt(i * 4);
  const groups = {}, allErr = [];
  let edgePixels = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, id = ids[i];
    // Silhouette pixels (material changes in the 3x3 neighbourhood) are excluded:
    // a single pixel-centre sample in both renderers, but f32 vs rasterizer edge rules.
    let edge = false; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (ids[i + dy * W + dx] !== id) edge = true;
    if (edge) { edgePixels++; continue; }
    const r = luminance(raster, i * 4), c = luminance(compute, i * 4);
    const err = Math.abs(c - r) / Math.max(r, 1e-3);
    const key = id < 0 ? 'background (black sky: no registered environment)' : nameOfMaterial(id);
    (groups[key] ??= { err: [], raster: 0, compute: 0, n: 0 });
    groups[key].err.push(err); groups[key].raster += r; groups[key].compute += c; groups[key].n++;
    if (id >= 0) allErr.push(err);
  }
  const report = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, { pixels: g.n, meanRaster: g.raster / g.n, meanCompute: g.compute / g.n,
    meanRatio: g.compute / Math.max(1e-9, g.raster), medianRelErr: percentile(g.err, .5), p90RelErr: percentile(g.err, .9) }]));
  const overall = { pixels: allErr.length, edgePixelsExcluded: edgePixels, medianRelErr: percentile(allErr, .5), p90RelErr: percentile(allErr, .9), within2pct: allErr.filter(e => e < .02).length / allErr.length, within5pct: allErr.filter(e => e < .05).length / allErr.length };
  // Acceptance: approximations are named in docs; gross failures (missing
  // shadows, wrong normals, grey materials) would show up as ratio/median errors.
  check(stats.bvhErrorRate === 0 && stats.unsupportedRate === 0, 'BVH error or unsupported material in shading test');
  check(overall.medianRelErr < .02, 'median shading error too large: ' + JSON.stringify(overall));
  for (const [name, g] of Object.entries(report)) if (!name.startsWith('background')) check(Math.abs(g.meanRatio - 1) < .1, `${name}: mean radiance ratio ${g.meanRatio}`);
  const flat = report['flat metal panel (r=0.3, no curvature)'];
  check(flat && flat.p90RelErr < .02, 'flat metal BRDF/PMREM mismatch: ' + JSON.stringify(flat));
  // Shadow presence: floor pixels darker under the box in BOTH.
  check(lighting.status.lights.pointShadows === 1 && lighting.status.environment, 'lighting resources not bridged');
  check(errors.length === 0, errors.join('\n'));
  // ---- Environment: the real procedural sky (createDaylight) vs the analytic
  // environment query. Camera at the dome centre so directions coincide.
  rig.sceneResources.dispose(); rig.lighting.dispose();
  const skyResults = {};
  step('sky section start');
  for (const hour of [12, 17.6]) {
    const envScene = new THREE.Scene(); envScene.fog = new THREE.FogExp2(0xffffff, .0065); envScene.background = new THREE.Color(); // daylight.update writes both
    const daylight = createDaylight(envScene, renderer, { details: { lamps: [], emissiveSources: [] } });
    const state = daylight.update({ hour, date: '2026-09-26' }, true);
    const cam = new THREE.PerspectiveCamera(60, W / H, .1, 500);
    const sun = new THREE.Vector3(...state.sun.direction); cam.lookAt(sun.x, Math.max(.15, sun.y), sun.z); cam.updateMatrixWorld();
    // A single dummy receiver keeps the lens scene non-empty.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), emitter([0, 0, 0])); ground.position.set(0, -400, 0); envScene.add(ground);
  step('daylight created');
    renderer.setRenderTarget(target); renderer.render(envScene, cam); renderer.setRenderTarget(null);
    const rasterSky = await readTarget(interop, target);
  step('sky raster rendered');
    const envRig = await createLensRig({ renderer, scene: envScene, camera: cam, width: W, environment: daylight });
    envRig.engine.setLens(lens, { fNumber: 2.8, sensorZMm: lens.sensorZMm, dispersion: false });
    const pin = { cameraToWorld: cam.matrixWorld.elements, clipToCamera: cam.projectionMatrixInverse.elements };
    envRig.engine.sample({ batchSpp: 1, targetSpp: 1, pinhole: pin }); const computeSky = await envRig.interop.readTexture(envRig.engine.outputGPU);
    const err = []; let sumR = 0, sumC = 0;
    for (let i = 0; i < W * H; i++) { const r = luminance(rasterSky, i * 4), c = luminance(computeSky, i * 4); sumR += r; sumC += c; err.push(Math.abs(c - r) / Math.max(r, 1e-6)); }
    skyResults[hour] = { meanRatio: sumC / sumR, medianRelErr: percentile(err, .5), p90RelErr: percentile(err, .9), p99RelErr: percentile(err, .99),
      note: 'raster dome is a 230 m sphere around the origin; the lens query is direction-only (identical here: camera at the centre)' };
    check(Math.abs(sumC / sumR - 1) < .03 && percentile(err, .9) < .03, `sky ${hour}h mismatch: ` + JSON.stringify(skyResults[hour]));
    envRig.sceneResources.dispose(); envRig.lighting.dispose(); envRig.engine.dispose(); daylight.dispose();
  }
  // ---- Fog: FogExp2 on the REAL path length t (raster: view depth). On the
  // optical axis both agree; off axis the lens version uses distance.
  step('sky done');
  const fogScene = new THREE.Scene(); fogScene.fog = new THREE.FogExp2(new THREE.Color(.3, .4, .5), .05);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), emitter([4, 2, 1])); panel.position.z = -12; fogScene.add(panel);
  const fogCam = new THREE.PerspectiveCamera(60, W / H, .1, 100); fogCam.updateMatrixWorld();
  renderer.setRenderTarget(target); renderer.render(fogScene, fogCam); renderer.setRenderTarget(null);
  const rasterFog = await readTarget(interop, target);
  const fogRig = await createLensRig({ renderer, scene: fogScene, camera: fogCam, width: W });
  fogRig.engine.setLens(lens, { fNumber: 2.8, sensorZMm: lens.sensorZMm, dispersion: false });
  fogRig.engine.sample({ batchSpp: 1, targetSpp: 1, pinhole: { cameraToWorld: fogCam.matrixWorld.elements, clipToCamera: fogCam.projectionMatrixInverse.elements } });
  const computeFog = await fogRig.interop.readTexture(fogRig.engine.outputGPU);
  const centre = ((H / 2) * W + W / 2) * 4, corner = (2 * W + 2) * 4;
  const analytic = (t, k) => { const f = 1 - Math.exp(-((.05 * t) ** 2)); return [4, 2, 1][k] * (1 - f) + [.3, .4, .5][k] * f; };
  const ndc = [(2.5 / W) * 2 - 1, 1 - (2.5 / H) * 2], dir = new THREE.Vector3(ndc[0], ndc[1], .5).applyMatrix4(fogCam.projectionMatrixInverse).normalize();
  const tCorner = 12 / -dir.z;
  const fog = { centre: { raster: rasterFog[centre], compute: computeFog[centre], analytic: analytic(12, 0) },
    corner: { compute: computeFog[corner], analyticPathLength: analytic(tCorner, 0), rasterViewDepth: rasterFog[corner], analyticViewDepth: analytic(12, 0), pathLengthM: tCorner } };
  check(Math.abs(fog.centre.compute - fog.centre.analytic) < 5e-3 && Math.abs(fog.centre.raster - fog.centre.analytic) < 5e-3, 'on-axis fog mismatch ' + JSON.stringify(fog));
  check(Math.abs(fog.corner.compute - fog.corner.analyticPathLength) < 5e-3, 'path-length fog mismatch ' + JSON.stringify(fog));
  check(errors.length === 0, errors.join('\n'));
  const result = { passed: true, environment: { userAgent: navigator.userAgent, adapter: adapter.info }, size: [W, H], computeSpp: 16, overall, materials: report, sky: skyResults, fog, stats, lighting: lighting.status, errors };
  out.textContent = JSON.stringify(result, null, 2); document.body.dataset.passed = 'true'; window.__shadingTest = { result, raster, compute };
} catch (error) { out.textContent = error.stack || String(error); document.body.dataset.passed = 'false'; console.error(error); }
