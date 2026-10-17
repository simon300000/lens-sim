import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { prepareImportedModel, fitAndPlace, disposeModel, groupModelFiles, scaleModelAbout, turnModelAbout, moveModelBase, MODEL_IMPORT_DEFAULTS } from './scene/model-import.js';
import { setLensRole } from './scene/lens-registry.js';

/** User-supplied glTF/GLB models: file picker + drag-and-drop, any number of
 * models. In the view, a model is selected by clicking it; drag moves it over
 * the ground, the wheel resizes it, Shift + wheel turns it, Delete removes it.
 * Files are read locally and never leave the browser. */
const MAX_BYTES = 256 * 1024 * 1024, MAX_TEXTURE = 2048, MIN_EXTENT = .02, MAX_EXTENT = 200, COMMIT_DELAY = 350;

/** RGBA8 pixels of a loaded texture image, downscaled to MAX_TEXTURE. */
export function readTexturePixels(texture) {
  const image = texture.image;
  if (!image?.width || !image?.height) return null;
  if (image.data) return image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray ? image : null;
  const s = Math.min(1, MAX_TEXTURE / Math.max(image.width, image.height)), w = Math.max(1, Math.round(image.width * s)), h = Math.max(1, Math.round(image.height * s));
  const context = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, w, h);
  return context.getImageData(0, 0, w, h, { colorSpace: 'srgb' });
}

/** Parse a .glb, or a .gltf with its external .bin/image files among `resources`. */
export async function parseModelFile(main, resources = []) {
  const total = [main, ...resources].reduce((n, f) => n + f.size, 0);
  if (total > MAX_BYTES) throw new Error(`文件共 ${(total / 2 ** 20).toFixed(0)} MB，超过 ${MAX_BYTES / 2 ** 20} MB 上限`);
  const urls = new Map(resources.map(f => [f.name, URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager(), missing = [];
  manager.setURLModifier(url => {
    if (/^(blob|data):/.test(url)) return url;
    const name = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop());
    if (urls.has(name)) return urls.get(name);
    missing.push(name); return url;
  });
  // The loader is fetched on first use, not at startup.
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  try {
    const gltf = await loader.parseAsync(await main.arrayBuffer(), '');
    if (missing.length) throw new Error(`缺少外部文件：${[...new Set(missing)].join('、')}。请一并选择，或改用 .glb`);
    return gltf;
  } catch (error) {
    const message = String(error?.message || error);
    if (/draco/i.test(message)) throw new Error('暂不支持 Draco 压缩的模型，请导出未压缩或 Meshopt 压缩的 GLB');
    if (/ktx2|basisu/i.test(message)) throw new Error('暂不支持 KTX2 压缩纹理，请导出 PNG/JPEG 纹理');
    throw error;
  } finally { for (const url of urls.values()) URL.revokeObjectURL(url); }
}

/**
 * root: group holding user models (also in the camera picker).
 * camera / element: the view, for picking and dragging.
 * groundAt(x, z, fromY): height of the scene surface below, or null.
 * lookTarget(): where new models go.
 * exposure: the camera exposure uniform, so the outline reads at any light level.
 */
export function installUserModels({ root, scene, camera, element, exposure, groundAt, lookTarget, sceneChanged, lightingChanged, requestFrame }) {
  const open = document.querySelector('#model-open'), clear = document.querySelector('#model-clear'), input = document.querySelector('#model-file');
  const list = document.querySelector('#model-list'), status = document.querySelector('#model-status'), sceneElement = document.querySelector('#scene');
  const models = [];
  let selected = null, loading = false, nextId = 1, commitTimer = null, commitChain = Promise.resolve();
  const selection = new THREE.BoxHelper(undefined);
  selection.material = new THREE.LineBasicNodeMaterial({ depthTest: false, toneMapped: false });
  // Scene radiance is physical (exposure ≈ 0.01 at noon); scale the outline to display white-ish.
  selection.material.colorNode = exposure ? color(0xffc040).div(exposure) : color(0xffc040);
  selection.name = 'User model selection'; selection.visible = false; selection.renderOrder = 10;
  setLensRole(selection, 'exclude'); scene.add(selection);

  const setStatus = (text, title = '') => { status.textContent = text; status.title = title; };
  const triangles = () => models.reduce((n, m) => n + m.report.triangles, 0);
  function publish() {
    sceneElement.dataset.userModel = loading ? 'loading' : models.length ? 'ready' : 'none';
    sceneElement.dataset.userModels = String(models.length);
    if (window.__SANTEI__) window.__SANTEI__.userModel = { models: models.map(({ id, name, report, fit }) => ({ id, name, report, fit })), selected: selected?.id ?? null };
  }
  function renderList() {
    list.replaceChildren(...models.map(model => {
      const item = document.createElement('li'); item.className = 'model-item'; item.toggleAttribute('data-selected', model === selected);
      const name = document.createElement('button'); name.type = 'button'; name.className = 'model-name'; name.textContent = model.name;
      name.title = model.detail; name.setAttribute('aria-pressed', String(model === selected));
      name.addEventListener('click', () => select(model === selected ? null : model));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'model-remove'; remove.textContent = '×';
      remove.title = `移除 ${model.name}`; remove.setAttribute('aria-label', `移除 ${model.name}`); remove.disabled = loading;
      remove.addEventListener('click', () => removeModels([model]));
      item.append(name, remove); return item;
    }));
    list.hidden = !models.length; clear.hidden = models.length < 2; open.disabled = clear.disabled = loading;
    publish();
  }
  function select(model) {
    selected = model;
    if (model) selection.setFromObject(model.holder);
    selection.visible = !!model; renderList(); requestFrame();
  }

  /** Lens BVH + shadow maps catch up after edits; calls are serialised. */
  function commit() {
    clearTimeout(commitTimer); commitTimer = null;
    lightingChanged(); requestFrame();
    commitChain = commitChain.then(() => sceneChanged()).catch(error => setStatus(`场景更新失败：${error.message}`)).then(() => requestFrame());
    return commitChain;
  }
  const commitSoon = () => { clearTimeout(commitTimer); commitTimer = setTimeout(commit, COMMIT_DELAY); };

  async function load(fileList) {
    if (loading) return;
    const jobs = groupModelFiles(fileList);
    if (!jobs.length) { setStatus('载入失败：请选择 .glb 或 .gltf 文件'); return; }
    loading = true; renderList();
    const added = [], failures = [];
    // A batch is laid out in a row to the right of the view centre.
    const target = lookTarget(), right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
    let offset = 0;
    for (const [i, { main, resources }] of jobs.entries()) {
      const name = main.name.replace(/\.(glb|gltf)$/i, '');
      setStatus(`正在载入 ${name}（${i + 1}/${jobs.length}）…`);
      let holder = null;
      try {
        const gltf = await parseModelFile(main, resources);
        await new Promise(r => setTimeout(r)); // let the status paint before the synchronous bake
        holder = new THREE.Group(); holder.name = `User model: ${name}`; holder.add(gltf.scene);
        const report = prepareImportedModel(holder, { readTexture: readTexturePixels, triangleBudget: Math.max(0, MODEL_IMPORT_DEFAULTS.triangleBudget - triangles()) });
        if (!report.meshes) throw new Error('模型中没有可显示的网格');
        const fit = fitAndPlace(holder, target), footprint = Math.max(fit.size[0], fit.size[2]);
        if (i > 0) offset += footprint / 2;
        if (offset) {
          const x = target.x + right.x * offset, z = target.z + right.z * offset;
          moveModelBase(holder, x - target.x, z - target.z, target.y, groundAt(x, z, target.y + 40) ?? target.y);
        }
        offset += footprint / 2 + .3;
        root.add(holder);
        const size = fit.size.map(v => v.toFixed(2)).join(' × ');
        const detail = [`${report.meshes} 个网格 · ${report.triangles.toLocaleString()} 个三角形`, `尺寸 ${size} m${fit.scale !== 1 ? `（已缩放 ×${fit.scale.toPrecision(3)}）` : ''}`,
          report.bakedMeshes ? `${report.bakedMeshes} 个网格的颜色贴图已烘焙为顶点色` : '', ...report.notes].filter(Boolean).join('\n');
        // base: lowest world y, maintained through drags (turns and base-centred scales keep it).
        const model = { id: nextId++, name, holder, report, fit, detail, extent: Math.max(...fit.size), base: new THREE.Box3().setFromObject(holder, true).min.y };
        models.push(model); added.push(model);
      } catch (error) {
        if (holder) disposeModel(holder);
        console.error(error); failures.push(`${name}：${error.message}`);
      }
    }
    loading = false;
    if (added.length) { select(added[added.length - 1]); await commit(); } else renderList();
    const summary = added.length ? `已载入 ${added.map(m => m.name).join('、')} · 共 ${triangles().toLocaleString()} 三角形` : '';
    setStatus(failures.length ? `${summary ? summary + ' · ' : ''}载入失败：${failures.join('；')}` : summary, failures.join('\n') || added.map(m => `${m.name}\n${m.detail}`).join('\n\n'));
  }
  async function removeModels(targets) {
    if (loading || !targets.length) return;
    for (const model of targets) { disposeModel(model.holder); models.splice(models.indexOf(model), 1); }
    if (targets.includes(selected)) select(null); else renderList();
    setStatus(targets.length === 1 ? `已移除 ${targets[0].name}` : `已移除 ${targets.length} 个模型`);
    await commit();
  }

  // ------------------------------------------------------- in-view handling
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(), hitPoint = new THREE.Vector3();
  const rayAt = event => { const r = element.getBoundingClientRect(); ndc.set((event.clientX - r.left) / r.width * 2 - 1, -(event.clientY - r.top) / r.height * 2 + 1); raycaster.setFromCamera(ndc, camera); return raycaster.ray; };
  function modelAt(event) {
    if (!models.length) return null;
    rayAt(event);
    const hit = raycaster.intersectObject(root, true).find(h => h.object.visible);
    if (!hit) return null;
    let o = hit.object; while (o.parent && o.parent !== root) o = o.parent;
    return { model: models.find(m => m.holder === o), point: hit.point };
  }
  const centre = model => new THREE.Box3().setFromObject(model.holder).getCenter(new THREE.Vector3()).setY(model.base);
  let drag = null;
  function pointerDown(event) {
    if (loading || event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const hit = modelAt(event);
    if (!hit?.model) { drag = { id: event.pointerId, x: event.clientX, y: event.clientY, empty: true }; return; }
    // Claim the gesture before the camera rig sees it.
    event.stopImmediatePropagation(); event.preventDefault();
    element.setPointerCapture?.(event.pointerId);
    if (selected !== hit.model) select(hit.model);
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), hit.point);
    drag = { id: event.pointerId, model: hit.model, grab: hit.point.clone(), moved: false };
    element.style.cursor = 'grabbing';
  }
  function pointerMove(event) {
    if (!drag || drag.empty || event.pointerId !== drag.id) return;
    event.stopImmediatePropagation();
    if (!rayAt(event).intersectPlane(plane, hitPoint)) return;
    const { model } = drag, dx = hitPoint.x - drag.grab.x, dz = hitPoint.z - drag.grab.z;
    if (!dx && !dz) return;
    const c = centre(model), ground = groundAt(c.x + dx, c.z + dz, model.base + Math.max(2, model.extent) + 40);
    const base = ground ?? model.base;
    moveModelBase(model.holder, dx, dz, model.base, base);
    // Keep the grab plane at the grabbed point's height so the model tracks the cursor.
    plane.constant -= base - model.base; drag.grab.set(hitPoint.x, drag.grab.y + base - model.base, hitPoint.z);
    model.base = base; drag.moved = true;
    selection.setFromObject(model.holder); requestFrame();
  }
  function pointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const ended = drag; drag = null;
    if (ended.empty) {
      // A plain click on the scene (not a camera drag) clears the selection.
      if (selected && Math.hypot(event.clientX - ended.x, event.clientY - ended.y) < 4) select(null);
      return;
    }
    event.stopImmediatePropagation();
    element.releasePointerCapture?.(event.pointerId); element.style.cursor = '';
    if (ended.moved) commit();
  }
  function wheel(event) {
    if (loading || !models.length) return;
    const hit = modelAt(event);
    if (!hit?.model) return;
    event.stopImmediatePropagation(); event.preventDefault();
    const model = hit.model; if (selected !== model) select(model);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
    const delta = Math.max(-400, Math.min(400, (event.shiftKey && !event.deltaY ? event.deltaX : event.deltaY) * unit)) * (event.ctrlKey ? 4 : 1);
    if (!delta) return;
    const pivot = centre(model);
    if (event.shiftKey) turnModelAbout(model.holder, -delta * .004, pivot);
    else {
      const factor = Math.min(MAX_EXTENT / model.extent, Math.max(MIN_EXTENT / model.extent, Math.exp(-delta * .0016)));
      scaleModelAbout(model.holder, factor, pivot); model.extent *= factor;
    }
    selection.setFromObject(model.holder); requestFrame(); commitSoon();
  }
  function keyDown(event) {
    if (!selected || event.ctrlKey || event.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeModels([selected]); }
    else if (event.key === 'Escape') select(null);
  }

  const onOpen = () => input.click(), onClear = () => removeModels([...models]);
  const onInput = () => { if (input.files.length) load([...input.files]); input.value = ''; };
  let depth = 0;
  const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');
  const onEnter = event => { if (!hasFiles(event)) return; event.preventDefault(); depth++; document.body.classList.add('model-drop'); };
  const onOver = event => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } };
  const onLeave = event => { if (hasFiles(event) && --depth <= 0) { depth = 0; document.body.classList.remove('model-drop'); } };
  const onDrop = event => { if (!hasFiles(event)) return; event.preventDefault(); depth = 0; document.body.classList.remove('model-drop'); load([...event.dataTransfer.files]); };
  // Capture phase on the canvas runs before the camera rig's own listeners.
  const listeners = [[element, 'pointerdown', pointerDown, true], [element, 'pointermove', pointerMove, true], [element, 'pointerup', pointerUp, true],
    [element, 'pointercancel', pointerUp, true], [element, 'wheel', wheel, { capture: true, passive: false }], [window, 'keydown', keyDown, false],
    [open, 'click', onOpen, false], [clear, 'click', onClear, false], [input, 'change', onInput, false],
    [window, 'dragenter', onEnter, false], [window, 'dragover', onOver, false], [window, 'dragleave', onLeave, false], [window, 'drop', onDrop, false]];
  for (const [target, type, fn, options] of listeners) target.addEventListener(type, fn, options);
  open.disabled = false; renderList();
  return {
    load, remove: removeModels, select, get models() { return models; }, get selected() { return selected; },
    dispose() {
      clearTimeout(commitTimer);
      for (const [target, type, fn, options] of listeners) target.removeEventListener(type, fn, options);
      selection.removeFromParent(); selection.geometry.dispose(); selection.material.dispose();
    },
  };
}
