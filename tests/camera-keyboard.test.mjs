import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { createCameraRig, forwardFromAngles, anglesFromForward } from '../src/camera-controls.js';

function setup({ pick = null } = {}) {
  const element = new EventTarget();
  Object.assign(element, { clientHeight: 800, clientWidth: 1200, style: {}, setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) });
  const doc = new EventTarget();
  const win = new EventTarget();
  Object.assign(win, { setTimeout, clearTimeout, performance });
  const camera = new PerspectiveCamera(40, 1.5, 0.15, 450);
  camera.position.set(0, 3, 5); camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
  let frames = 0;
  const rig = createCameraRig(camera, element, { doc, win, pick, requestFrame: () => frames++ });
  rig.target.set(0, 1, 0); rig.update(0);
  const events = [];
  for (const type of ['start', 'end']) rig.addEventListener(type, () => events.push(type));
  const key = (type, code, { target, ...extra } = {}) => { const e = new Event(type, { cancelable: true }); Object.assign(e, { code, key: code, ...extra }); if (target) Object.defineProperty(e, 'target', { value: target }); win.dispatchEvent(e); return e; };
  const pointer = (type, extra) => { const e = new Event(type, { cancelable: true }); Object.assign(e, { pointerType: 'mouse', pointerId: 1, button: 0, ...extra }); element.dispatchEvent(e); return e; };
  const settle = () => { for (let i = 0; i < 400 && rig.update(1 / 60); i++); };
  return { element, doc, win, camera, rig, key, pointer, settle, events, frames: () => frames };
}

test('angle helpers round-trip', () => {
  for (const [y, p] of [[0, 0], [1.2, -0.4], [-2.5, 0.9]]) {
    const back = anglesFromForward(forwardFromAngles(y, p));
    assert.ok(Math.abs(Math.atan2(Math.sin(back.yaw - y), Math.cos(back.yaw - y))) < 1e-9 && Math.abs(back.pitch - p) < 1e-9);
  }
});

test('adopts an external pose immediately and keeps the target in view', () => {
  const { camera, rig } = setup();
  camera.position.set(10, 4, -3); rig.target.set(2, 1, 0);
  rig.update(1 / 60);
  assert.deepEqual(camera.position.toArray(), [10, 4, -3], 'no animation towards the old pose');
  const dir = camera.getWorldDirection(new Vector3()), want = new Vector3(2, 1, 0).sub(camera.position).normalize();
  assert.ok(dir.distanceTo(want) < 1e-6);
  assert.ok(rig.target.distanceTo(new Vector3(2, 1, 0)) < 1e-6);
});

test('WASD walks on the ground plane at normalized diagonal speed; start/end bracket the whole motion', () => {
  const { camera, rig, key, settle, events } = setup();
  key('keydown', 'KeyW'); key('keydown', 'KeyD');
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
  assert.equal(camera.position.y, 3, 'height preserved');
  const travelled = camera.position.clone().sub(new Vector3(0, 3, 5));
  assert.ok(travelled.x > 0 && travelled.z < 0);
  assert.ok(Math.abs(Math.abs(travelled.x) - Math.abs(travelled.z)) < 1e-6, 'diagonal');
  assert.ok(travelled.length() < 3.2 * 2 + 1e-9, 'never faster than walk speed');
  key('keyup', 'KeyW'); key('keyup', 'KeyD');
  assert.deepEqual(events, ['start'], 'end waits for the motion to settle');
  settle();
  assert.deepEqual(events, ['start', 'end']);
});

test('Q/E move vertically; keys are ignored while typing or with ctrl/meta', () => {
  const { camera, rig, key, settle } = setup();
  key('keydown', 'KeyE'); for (let i = 0; i < 30; i++) rig.update(1 / 60); key('keyup', 'KeyE'); settle();
  assert.ok(camera.position.y > 3);
  const y = camera.position.y;
  assert.equal(key('keydown', 'KeyW', { metaKey: true }).defaultPrevented, false);
  assert.equal(key('keydown', 'KeyW', { target: { tagName: 'INPUT' } }).defaultPrevented, false);
  settle();
  assert.equal(camera.position.y, y);
});

test('left drag looks around in place', () => {
  const { camera, pointer, settle } = setup();
  const before = camera.position.clone(), dir0 = camera.getWorldDirection(new Vector3());
  pointer('pointerdown', { clientX: 600, clientY: 400 });
  pointer('pointermove', { clientX: 700, clientY: 380 });
  pointer('pointerup', { clientX: 700, clientY: 380 });
  settle();
  assert.ok(camera.position.distanceTo(before) < 1e-9, 'no translation');
  const dir = camera.getWorldDirection(new Vector3());
  assert.ok(dir.angleTo(dir0) > 0.05, 'view turned');
  assert.ok(dir.x < dir0.x, 'grab semantics: dragging right turns the view left');
});

test('pointer events buffer the latest position; a frame consumes it without easing', () => {
  const { camera, pointer, rig } = setup();
  let changes = 0; rig.addEventListener('change', () => changes++);
  const dir0 = camera.getWorldDirection(new Vector3());
  pointer('pointerdown', { clientX: 600, clientY: 400 });
  pointer('pointermove', { clientX: 640, clientY: 400 });
  pointer('pointermove', { clientX: 680, clientY: 400 });
  pointer('pointermove', { clientX: 700, clientY: 400 });
  assert.equal(changes, 0, 'events do not update matrices or notify observers');
  assert.ok(camera.getWorldDirection(new Vector3()).angleTo(dir0) < 1e-9);
  rig.update(1 / 60);
  const afterMove = camera.getWorldDirection(new Vector3());
  assert.ok(afterMove.angleTo(dir0) > 0.05);
  assert.equal(changes, 1, 'one change for the entire event burst');
  rig.update(1 / 60);
  assert.ok(camera.getWorldDirection(new Vector3()).angleTo(afterMove) < 1e-9, 'nothing left to smooth');
  // Arrow keys keep the smoothed, rate-limited turn.
  const second = setup();
  second.key('keydown', 'ArrowLeft');
  const before = second.camera.getWorldDirection(new Vector3());
  second.rig.update(1 / 60);
  const after = second.camera.getWorldDirection(new Vector3());
  assert.ok(after.angleTo(before) > 0 && after.angleTo(before) < 1.1 / 60, 'arrow turn is rate limited and eased');
});

test('a deferred render reads newer pointer input without advancing keyboard motion', () => {
  const { camera, pointer, rig, key } = setup();
  key('keydown', 'KeyW');
  pointer('pointerdown', { clientX: 600, clientY: 400 });rig.update(1 / 60);
  const before = camera.quaternion.clone(), position = camera.position.clone();
  pointer('pointermove', { clientX: 700, clientY: 400 });
  assert.equal(rig.samplePointer(), true);
  assert.ok(camera.quaternion.angleTo(before) > .05);
  assert.deepEqual(camera.position, position);
  assert.equal(rig.samplePointer(), false, 'the same sample cannot be applied twice');
});

test('the newest coalesced pointer position is sampled when it is newer than the event', () => {
  const a=setup(),b=setup();
  for(const h of [a,b])h.pointer('pointerdown',{clientX:600,clientY:400});
  a.pointer('pointermove',{clientX:650,clientY:400,getCoalescedEvents:()=>[{timeStamp:performance.now()+1,clientX:700,clientY:400}]});
  b.pointer('pointermove',{clientX:700,clientY:400});
  a.rig.update(1/60);b.rig.update(1/60);
  assert.ok(a.camera.quaternion.angleTo(b.camera.quaternion)<1e-7);
});

test('release between frames preserves its final coordinate and ends without a tail', () => {
  const a = setup(), b = setup();
  a.pointer('pointerdown', { clientX: 600, clientY: 400 });
  a.pointer('pointermove', { clientX: 650, clientY: 400 });
  a.pointer('pointerup', { clientX: 710, clientY: 400 });
  assert.equal(a.rig.pointerActive, false);
  a.rig.update(1 / 60);
  b.pointer('pointerdown', { clientX: 600, clientY: 400 });
  b.pointer('pointermove', { clientX: 710, clientY: 400 });b.rig.update(1 / 120);
  assert.ok(a.camera.quaternion.angleTo(b.camera.quaternion) < 1e-7, 'displacement is independent of frame duration');
  assert.equal(a.rig.active, false);
});

test('quick consecutive gestures keep separate origins and disabling discards pending input', () => {
  const a = setup(), b = setup();
  for (const x of [600,900]) {
    a.pointer('pointerdown', { clientX: x, clientY: 400 });
    a.pointer('pointermove', { clientX: x+50, clientY: 400 });
    a.pointer('pointerup', {});
  }
  a.rig.update(1 / 60);
  b.pointer('pointerdown', { clientX: 600, clientY: 400 });
  b.pointer('pointermove', { clientX: 700, clientY: 400 });b.rig.update(1 / 60);
  assert.ok(a.camera.quaternion.angleTo(b.camera.quaternion) < 1e-7);
  const before = b.camera.quaternion.clone();
  b.pointer('pointermove', { clientX: 800, clientY: 400 });b.rig.enabled=false;b.rig.update(1 / 60);
  assert.ok(before.angleTo(b.camera.quaternion) < 1e-7);
});

test('an external pose replaces pending mouse samples and releases a completed gesture',()=>{
  const {camera,rig,pointer}=setup();
  pointer('pointerdown',{clientX:600,clientY:400});
  pointer('pointermove',{clientX:800,clientY:400});
  pointer('pointerup',{});
  camera.position.set(10,4,-3);rig.target.set(2,1,0);
  rig.update(1/60);
  const direction=camera.getWorldDirection(new Vector3());
  assert.ok(direction.distanceTo(new Vector3(2,1,0).sub(camera.position).normalize())<1e-6);
  assert.equal(rig.active,false);assert.equal(rig.samplePointer(),false);
});

test('wheel dollies toward the picked surface without passing it', () => {
  const surface = new Vector3(0, 1, 0);
  const pick = (raycaster) => { const d = raycaster.ray.origin.distanceTo(surface); return { point: raycaster.ray.at(d, new Vector3()), distance: d }; };
  const { camera, element, settle } = setup({ pick });
  const start = camera.position.distanceTo(surface);
  for (let i = 0; i < 40; i++) { const e = new Event('wheel', { cancelable: true }); Object.assign(e, { deltaY: -400, deltaMode: 0, clientX: 600, clientY: 400 }); element.dispatchEvent(e); }
  settle();
  const end = camera.position.distanceTo(surface);
  assert.ok(end < start * 0.2 && end > 0, `closer but never through (${end})`);
});

test('alt-drag orbits around the grabbed point at constant distance', () => {
  const pivot = new Vector3(0, 1, 0);
  const pick = () => ({ point: pivot.clone(), distance: 0 });
  const { camera, pointer, settle } = setup({ pick });
  const radius = camera.position.distanceTo(pivot);
  pointer('pointerdown', { clientX: 600, clientY: 400, altKey: true });
  pointer('pointermove', { clientX: 800, clientY: 350 });
  pointer('pointerup', {});
  settle();
  assert.ok(Math.abs(camera.position.distanceTo(pivot) - radius) < 1e-6);
  assert.ok(camera.position.x !== 0, 'moved around the pivot');
  const toPivot = pivot.clone().sub(camera.position).normalize();
  assert.ok(camera.getWorldDirection(new Vector3()).angleTo(toPivot) < 0.25, 'pivot stays near where it was grabbed');
});

test('dispose removes listeners and clears held keys', () => {
  const { rig, key, events } = setup();
  key('keydown', 'KeyA');
  rig.dispose();
  assert.deepEqual(events, ['start', 'end']);
  key('keydown', 'KeyW');
  assert.equal(rig.active, false);
});


test('pointer activity is separate from keyboard activity for frame scheduling',()=>{
  const {rig,pointer,key,settle}=setup();
  key('keydown','KeyW');assert.equal(rig.active,true);assert.equal(rig.pointerActive,false);
  pointer('pointerdown',{clientX:600,clientY:400});assert.equal(rig.pointerActive,true);
  pointer('pointermove',{clientX:650,clientY:400});assert.equal(rig.pointerActive,true);
  pointer('pointercancel',{});assert.equal(rig.pointerActive,false);assert.equal(rig.active,true);
  key('keyup','KeyW');settle();assert.equal(rig.active,false);
});
