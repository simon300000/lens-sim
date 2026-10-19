import { EventDispatcher, Vector3, Vector2, Raycaster, Plane } from 'three';

/**
 * Photographer's camera rig: one controller for mouse, trackpad, touch and keyboard.
 *
 *   Left drag ............ look around (grab the scene; speed follows the field of view)
 *   Alt/⌥ + drag, middle . orbit around the point under the cursor
 *   Right / Shift + drag . pan, scaled by the distance of the grabbed point
 *   Wheel / pinch ........ dolly toward the cursor, proportional to the distance to it
 *   Double-click ......... aim at that point (smoothly); its distance becomes the orbit distance
 *   W A S D / Q E ........ walk on the ground plane / down, up · Shift fast · arrows look
 *
 * OrbitControls-compatible surface used by the app: `object`, `target`, `enabled`,
 * `enableDamping`, `update()`, and 'start' / 'change' / 'end' events. 'end' fires only once
 * input has stopped AND the smoothed motion has settled, so the lens renderer restores its
 * resolution exactly once. A pose written from outside (URL state, test-target buttons)
 * is adopted on the next update() without any animation.
 */
const UP = new Vector3(0, 1, 0);
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const editing = (el) => Boolean(el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? ''));

export function forwardFromAngles(yaw, pitch, out = new Vector3()) {
  const c = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
}
export function anglesFromForward(f) {
  const n = f.clone().normalize();
  return { yaw: Math.atan2(-n.x, -n.z), pitch: Math.asin(Math.max(-1, Math.min(1, n.y))) };
}
/** Critically damped approach: fraction of the remaining distance covered in `dt` seconds. */
const approach = (dt, rate) => 1 - Math.exp(-rate * Math.max(0, Math.min(0.1, dt)));

export function createCameraRig(camera, element, {
  pick = null, doc = element?.ownerDocument ?? globalThis.document, win = doc?.defaultView ?? globalThis,
  requestFrame = () => {}, walkSpeed = 3.2, bounds = { radius: 260, minY: 0.25, maxY: 140 },
} = {}) {
  const rig = new EventDispatcher();
  const target = new Vector3();
  const goal = { position: camera.position.clone(), yaw: 0, pitch: 0 };
  const velocity = new Vector3();
  const keys = new Set();
  const lastPose = { position: new Vector3(Infinity, 0, 0), target: new Vector3(Infinity, 0, 0) };
  let yaw = 0, pitch = 0, distance = 10;
  let drag = null, wheelTimer = null, busy = false, enabled = true, disposed = false;
  const pointers = new Map();

  // ------------------------------------------------------------- pose helpers
  const fwd = new Vector3(), right = new Vector3(), up = new Vector3(), tmp = new Vector3(), tmp2 = new Vector3();
  function basis(y = yaw, p = pitch) {
    forwardFromAngles(y, p, fwd);
    right.set(Math.cos(y), 0, -Math.sin(y));
    up.crossVectors(right, fwd).normalize();
  }
  function syncFromCamera() {
    if (target.distanceToSquared(camera.position) < 1e-10) target.copy(camera.getWorldDirection(tmp)).add(camera.position);
    const dir = tmp.subVectors(target, camera.position);
    distance = Math.max(0.5, dir.length());
    ({ yaw, pitch } = anglesFromForward(dir));
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    goal.position.copy(camera.position); goal.yaw = yaw; goal.pitch = pitch;
    velocity.set(0, 0, 0);
    apply();
  }
  function apply() {
    basis();
    camera.up.copy(UP);
    camera.lookAt(tmp2.copy(camera.position).add(fwd));
    camera.updateMatrixWorld();
    target.copy(camera.position).addScaledVector(fwd, distance);
    lastPose.position.copy(camera.position); lastPose.target.copy(target);
  }
  function clampPosition(v) {
    const h = Math.hypot(v.x, v.z);
    if (h > bounds.radius) { v.x *= bounds.radius / h; v.z *= bounds.radius / h; }
    v.y = Math.max(bounds.minY, Math.min(bounds.maxY, v.y));
    return v;
  }
  const externallyMoved = () => !camera.position.equals(lastPose.position) || !target.equals(lastPose.target);

  // ------------------------------------------------------------- picking
  const raycaster = new Raycaster(), ground = new Plane(UP, 0), ndc = new Vector2();
  function rayAt(clientX, clientY) {
    const rect = element.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }
  /** World point under the cursor: scene pick, else the ground plane, else a point at the orbit distance. */
  function pointAt(clientX, clientY) {
    const ray = rayAt(clientX, clientY);
    const hit = pick?.(raycaster);
    if (hit && Number.isFinite(hit.distance)) return { point: hit.point.clone(), distance: hit.distance, ray: ray.clone() };
    const g = ray.intersectPlane(ground, new Vector3());
    if (g && g.distanceTo(ray.origin) < 400) return { point: g, distance: g.distanceTo(ray.origin), ray: ray.clone() };
    return { point: ray.at(distance, new Vector3()), distance, ray: ray.clone() };
  }

  // ------------------------------------------------------------- activity
  function setBusy(next) {
    if (next === busy) return;
    busy = next;
    rig.dispatchEvent({ type: next ? 'start' : 'end', travelSource: 'rig' });
  }
  function poke() { setBusy(true); requestFrame(); }
  const inputActive = () => Boolean(drag || keys.size || wheelTimer !== null || pointers.size);
  function settled() {
    return Math.abs(goal.yaw - yaw) < 1e-5 && Math.abs(goal.pitch - pitch) < 1e-5
      && goal.position.distanceToSquared(camera.position) < 1e-8 && velocity.lengthSq() < 1e-6;
  }

  // ------------------------------------------------------------- gestures
  /** Turn the view. A pointer or touch drag is applied immediately (1:1 with the
   * hand, like orbit and pan); the smoothing stays for arrow keys and aiming. */
  // Viewport height is read once per frame (update), not per pointer event: a layout
  // read inside a 120 Hz pointer stream forces synchronous layout whenever styles are dirty.
  let viewHeight = Math.max(1, element.clientHeight || 1);
  function lookBy(dx, dy, immediate = false) {
    const k = ((camera.fov ?? 50) * Math.PI / 180) / viewHeight;
    goal.yaw += dx * k;
    goal.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, goal.pitch + dy * k));
    if (immediate) { yaw = goal.yaw; pitch = goal.pitch; commitImmediate(); }
  }
  function orbitBy(pivot, dx, dy) {
    const k = 0.006;
    let a = -dx * k, b = -dy * k;
    const nextPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, goal.pitch + b));
    b = nextPitch - goal.pitch;
    const offset = tmp.subVectors(goal.position, pivot);
    offset.applyAxisAngle(UP, a);
    const axis = tmp2.set(Math.cos(goal.yaw + a), 0, -Math.sin(goal.yaw + a));
    offset.applyAxisAngle(axis, b);
    goal.position.copy(clampPosition(offset.add(pivot)));
    goal.yaw += a; goal.pitch = nextPitch;
    // Orbit is a rigid motion: apply immediately so the pivot stays under the cursor.
    camera.position.copy(goal.position); yaw = goal.yaw; pitch = goal.pitch;
    commitImmediate();
  }
  function commitImmediate() { apply(); rig.dispatchEvent({ type: 'change' }); }
  function panBy(depth, dx, dy) {
    basis(goal.yaw, goal.pitch);
    const k = (2 * depth * Math.tan(((camera.fov ?? 50) * Math.PI) / 360)) / viewHeight;
    goal.position.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    clampPosition(goal.position);
    camera.position.copy(goal.position);
    commitImmediate();
  }
  function dollyToward(clientX, clientY, amount) {
    const hit = pointAt(clientX, clientY);
    // Measure from the goal pose: several wheel events can arrive before the camera catches up.
    const toward = tmp.copy(hit.point).sub(goal.position);
    const d = Math.max(0.3, toward.length());
    if (toward.lengthSq() < 1e-12) return;
    toward.normalize();
    // Exponential in the wheel delta; never closer than 12 % of the remaining distance per step.
    const step = d * Math.max(-3, Math.min(0.88, 1 - Math.exp(-amount)));
    goal.position.addScaledVector(toward, step);
    clampPosition(goal.position);
    distance = Math.max(0.5, d - step);
  }

  function pointerDown(event) {
    if (!enabled || disposed) return;
    if (event.pointerType === 'touch') { pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); touchStart(); element.setPointerCapture?.(event.pointerId); return; }
    const mode = event.button === 1 || (event.button === 0 && event.altKey) ? 'orbit'
      : event.button === 2 || (event.button === 0 && event.shiftKey) ? 'pan' : event.button === 0 ? 'look' : null;
    if (!mode) return;
    event.preventDefault();
    element.setPointerCapture?.(event.pointerId);
    const grabbed = mode === 'look' ? null : pointAt(event.clientX, event.clientY);
    drag = { mode, id: event.pointerId, x: event.clientX, y: event.clientY, pivot: grabbed?.point ?? null, depth: grabbed?.distance ?? distance };
    if (mode === 'orbit' && grabbed) distance = grabbed.distance;
    element.style && (element.style.cursor = mode === 'look' ? 'grabbing' : mode === 'pan' ? 'move' : 'all-scroll');
    poke();
  }
  function pointerMove(event) {
    if (event.pointerType === 'touch') { if (pointers.has(event.pointerId)) { pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); touchMove(); } return; }
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY;
    if (drag.mode === 'look') lookBy(dx, dy, true);
    else if (drag.mode === 'orbit') orbitBy(drag.pivot, dx, dy);
    else panBy(drag.depth, dx, dy);
    poke();
  }
  function pointerUp(event) {
    if (event.pointerType === 'touch') { pointers.delete(event.pointerId); touch = null; if (pointers.size) touchStart(); requestFrame(); return; }
    if (!drag || event.pointerId !== drag.id) return;
    element.releasePointerCapture?.(event.pointerId);
    drag = null;
    if (element.style) element.style.cursor = '';
    requestFrame();
  }

  // Touch: one finger looks; two fingers pan (midpoint) and pinch-dolly toward the midpoint.
  let touch = null;
  function touchStart() {
    const list = [...pointers.values()];
    if (list.length === 1) touch = { mode: 'look', x: list[0].x, y: list[0].y };
    else if (list.length >= 2) {
      const mx = (list[0].x + list[1].x) / 2, my = (list[0].y + list[1].y) / 2;
      const grabbed = pointAt(mx, my);
      touch = { mode: 'pinch', x: mx, y: my, span: Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y), depth: grabbed.distance };
    }
    poke();
  }
  function touchMove() {
    const list = [...pointers.values()];
    if (!touch) return;
    if (touch.mode === 'look' && list.length === 1) { lookBy(list[0].x - touch.x, list[0].y - touch.y, true); touch.x = list[0].x; touch.y = list[0].y; }
    else if (touch.mode === 'pinch' && list.length >= 2) {
      const mx = (list[0].x + list[1].x) / 2, my = (list[0].y + list[1].y) / 2, span = Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
      panBy(touch.depth, mx - touch.x, my - touch.y);
      if (touch.span > 0 && span > 0) dollyToward(mx, my, Math.log(span / touch.span));
      Object.assign(touch, { x: mx, y: my, span });
    }
    poke();
  }

  function wheel(event) {
    if (!enabled || disposed) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas: make it as responsive as a wheel notch.
    const delta = Math.max(-400, Math.min(400, event.deltaY * unit)) * (event.ctrlKey ? 4 : 1);
    if (!delta) return;
    dollyToward(event.clientX, event.clientY, -delta * 0.0016);
    if (wheelTimer !== null) win.clearTimeout(wheelTimer);
    wheelTimer = win.setTimeout(() => { wheelTimer = null; requestFrame(); }, 140);
    poke();
  }
  function doubleClick(event) {
    if (!enabled || disposed) return;
    const hit = pointAt(event.clientX, event.clientY);
    const dir = tmp.subVectors(hit.point, goal.position);
    if (dir.lengthSq() < 1e-6) return;
    const angles = anglesFromForward(dir);
    // Shortest way round in yaw.
    goal.yaw = yaw + Math.atan2(Math.sin(angles.yaw - yaw), Math.cos(angles.yaw - yaw));
    goal.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, angles.pitch));
    distance = dir.length();
    poke();
  }
  function keyDown(event) {
    if (!enabled || disposed || !MOVE_KEYS.has(event.code) || event.ctrlKey || event.metaKey || editing(event.target)) return;
    event.preventDefault();
    if (keys.has(event.code)) return;
    keys.add(event.code);
    poke();
  }
  function keyUp(event) { if (keys.delete(event.code)) requestFrame(); if (event.key === 'Shift' || event.key === 'Alt') requestFrame(); }
  function releaseKeys() { if (keys.size) { keys.clear(); requestFrame(); } }
  const shift = { held: false };
  function modifiers(event) { shift.held = event.shiftKey; shift.slow = event.altKey; }
  function visibility() { if (doc.hidden) releaseKeys(); }
  function focusIn(event) { if (editing(event.target)) releaseKeys(); }
  const contextMenu = (event) => event.preventDefault();

  element.addEventListener('pointerdown', pointerDown);
  element.addEventListener('pointermove', pointerMove);
  element.addEventListener('pointerup', pointerUp);
  element.addEventListener('pointercancel', pointerUp);
  element.addEventListener('wheel', wheel, { passive: false });
  element.addEventListener('dblclick', doubleClick);
  element.addEventListener('contextmenu', contextMenu);
  win.addEventListener('keydown', keyDown);
  win.addEventListener('keyup', keyUp);
  win.addEventListener('keydown', modifiers, true);
  win.addEventListener('keyup', modifiers, true);
  win.addEventListener('blur', releaseKeys);
  doc.addEventListener('visibilitychange', visibility);
  doc.addEventListener('focusin', focusIn);
  if (element.style) element.style.touchAction = 'none';

  // ------------------------------------------------------------- per frame
  let lastTime = null;
  /** Advance smoothing and keyboard travel. Returns true while another frame is needed. */
  function update(dt) {
    if (disposed) return false;
    const now = (win.performance ?? globalThis.performance).now();
    if (!Number.isFinite(dt)) dt = lastTime === null ? 1 / 60 : (now - lastTime) / 1000;
    lastTime = now;
    viewHeight = Math.max(1, element.clientHeight || viewHeight);
    if (externallyMoved()) { syncFromCamera(); rig.dispatchEvent({ type: 'change' }); return inputActive(); }
    const before = tmp2.copy(camera.position), beforeYaw = yaw, beforePitch = pitch;
    // Keyboard: smoothed walk velocity on the ground plane plus vertical Q/E; arrows look.
    if (keys.size) {
      const turn = 1.1 * Math.min(0.1, dt);
      goal.yaw += turn * (Number(keys.has('ArrowLeft')) - Number(keys.has('ArrowRight')));
      goal.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, goal.pitch + turn * (Number(keys.has('ArrowUp')) - Number(keys.has('ArrowDown')))));
    }
    basis(goal.yaw, 0);
    const wish = tmp.set(0, 0, 0)
      .addScaledVector(fwd, Number(keys.has('KeyW')) - Number(keys.has('KeyS')))
      .addScaledVector(right, Number(keys.has('KeyD')) - Number(keys.has('KeyA')));
    if (wish.lengthSq()) wish.normalize();
    wish.y = Number(keys.has('KeyE')) - Number(keys.has('KeyQ'));
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(walkSpeed * (shift.held ? 3.5 : 1) * (shift.slow ? 0.3 : 1));
    velocity.lerp(wish, enableDampingOn() ? approach(dt, 9) : 1);
    if (velocity.lengthSq() < 1e-6 && !wish.lengthSq()) velocity.set(0, 0, 0);
    goal.position.addScaledVector(velocity, Math.min(0.1, dt));
    clampPosition(goal.position);
    // Smoothing: snappy look, slightly softer travel.
    const look = enableDampingOn() ? approach(dt, 22) : 1, move = enableDampingOn() ? approach(dt, 12) : 1;
    yaw += (goal.yaw - yaw) * look; pitch += (goal.pitch - pitch) * look;
    camera.position.lerp(goal.position, move);
    if (Math.abs(goal.yaw - yaw) < 1e-6) yaw = goal.yaw;
    if (Math.abs(goal.pitch - pitch) < 1e-6) pitch = goal.pitch;
    if (camera.position.distanceToSquared(goal.position) < 1e-10) camera.position.copy(goal.position);
    const moved = !camera.position.equals(before) || yaw !== beforeYaw || pitch !== beforePitch;
    apply();
    if (moved) rig.dispatchEvent({ type: 'change' });
    const active = inputActive() || !settled();
    if (!active) {
      // Snap the last sub-millimetre so an idle rig never drifts (and never resets lens accumulation).
      if (!camera.position.equals(goal.position) || yaw !== goal.yaw || pitch !== goal.pitch) {
        camera.position.copy(goal.position); yaw = goal.yaw; pitch = goal.pitch; apply(); rig.dispatchEvent({ type: 'change' });
      }
      velocity.set(0, 0, 0);
      setBusy(false);
    }
    return active;
  }
  let enableDamping = true;
  const enableDampingOn = () => enableDamping;

  syncFromCamera();
  Object.defineProperties(rig, {
    object: { value: camera },
    target: { value: target },
    enabled: { get: () => enabled, set: (v) => { enabled = Boolean(v); if (!enabled) { drag = null; releaseKeys(); } } },
    enableDamping: { get: () => enableDamping, set: (v) => { enableDamping = Boolean(v); } },
    active: { get: () => busy || inputActive() },
    pointerActive: { get: () => Boolean(drag || pointers.size) },
  });
  rig.update = update;
  /** Make the current camera/target the rig's pose (used after programmatic moves). */
  rig.sync = () => { syncFromCamera(); rig.dispatchEvent({ type: 'change' }); };
  rig.dispose = () => {
    if (disposed) return;
    disposed = true;
    element.removeEventListener('pointerdown', pointerDown);
    element.removeEventListener('pointermove', pointerMove);
    element.removeEventListener('pointerup', pointerUp);
    element.removeEventListener('pointercancel', pointerUp);
    element.removeEventListener('wheel', wheel, { passive: false });
    element.removeEventListener('dblclick', doubleClick);
    element.removeEventListener('contextmenu', contextMenu);
    win.removeEventListener('keydown', keyDown);
    win.removeEventListener('keyup', keyUp);
    win.removeEventListener('keydown', modifiers, true);
    win.removeEventListener('keyup', modifiers, true);
    win.removeEventListener('blur', releaseKeys);
    doc.removeEventListener('visibilitychange', visibility);
    doc.removeEventListener('focusin', focusIn);
    if (wheelTimer !== null) win.clearTimeout(wheelTimer);
    keys.clear(); drag = null; setBusy(false);
  };
  return rig;
}

/** Scene picking for the rig: nearest hit among the given roots (dense vegetation instances excluded by the caller). */
export function createScenePicker(roots) {
  const list = roots.filter(Boolean);
  return (raycaster) => {
    raycaster.far = 500;
    let best = null;
    for (const root of list) {
      const hits = raycaster.intersectObject(root, true);
      for (const hit of hits) {
        if (!hit.object.visible || hit.object.userData?.lensRole === 'environment-sky' || hit.object.isSprite || hit.object.isPoints) continue;
        if (!best || hit.distance < best.distance) best = hit;
        break;
      }
    }
    return best;
  };
}
