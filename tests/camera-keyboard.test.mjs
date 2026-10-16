import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera,Vector3,EventDispatcher} from 'three';
import {installCameraKeyboardTravel} from '../src/camera-controls.js';
function setup(){
 const target=new EventTarget(),doc=new EventTarget(),controls=new EventDispatcher();
 controls.object=new PerspectiveCamera();controls.object.position.set(0,3,5);controls.object.lookAt(0,1,0);controls.target=new Vector3(0,1,0);controls.enabled=true;
 const events=[];for(const type of ['start','end'])controls.addEventListener(type,()=>events.push(type));
 const keyboard=installCameraKeyboardTravel(controls,{target,document:doc});
 const key=(type,code,extra={})=>{const event=new Event(type,{cancelable:true});Object.assign(event,{code,...extra});target.dispatchEvent(event);return event;};
 return {target,doc,controls,keyboard,key,events};
}
test('WASD preserves height and orbit offset; diagonal speed stays normalized',()=>{
 const {controls,keyboard,key,events}=setup(),offset=controls.object.position.clone().sub(controls.target);
 key('keydown','KeyW');key('keydown','KeyD');key('keydown','KeyW');keyboard.update(.025);
 assert.ok(Math.abs(controls.object.position.distanceTo(new Vector3(0,3,5))-.1)<1e-12);
 assert.ok(controls.object.position.x>0&&controls.object.position.z<5);assert.equal(controls.object.position.y,3);
 assert.ok(controls.object.position.clone().sub(controls.target).distanceTo(offset)<1e-12);
 key('keyup','KeyW');assert.equal(keyboard.active,true);key('keyup','KeyD');assert.deepEqual(events,['start','end']);keyboard.dispose();
});
test('ignores modifiers and clears held keys on focus loss and dispose',()=>{
 const {target,doc,keyboard,key,events}=setup();
 assert.equal(key('keydown','KeyW',{metaKey:true}).defaultPrevented,false);assert.equal(keyboard.active,false);
 key('keydown','KeyA');target.dispatchEvent(new Event('blur'));assert.equal(keyboard.active,false);
 key('keydown','KeyS');doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(keyboard.active,false);
 doc.hidden=false;key('keydown','KeyD');keyboard.dispose();key('keydown','KeyW');assert.equal(keyboard.active,false);
 assert.deepEqual(events,['start','end','start','end','start','end']);
});
