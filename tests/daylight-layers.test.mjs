import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createDaylight } from '../src/lighting.js';
import { LOCAL_LAMP_SHADOW_LAYER } from '../src/scene/render-layers.js';

test('local lamp shadow and main cameras retain the same scene lights without expanding caster geometry',()=>{
  const scene=new THREE.Scene(),lamp=new THREE.PointLight();
  lamp.castShadow=true;lamp.shadow.camera.layers.set(LOCAL_LAMP_SHADOW_LAYER);scene.add(lamp);
  const wall=new THREE.Object3D(),forest=new THREE.Object3D();
  wall.layers.enable(LOCAL_LAMP_SHADOW_LAYER);scene.add(wall,forest);
  const daylight=createDaylight(scene,{}),mainCamera=new THREE.PerspectiveCamera();
  try{
    const seenBy=camera=>{const ids=[];scene.traverseVisible(o=>{if(o.isLight&&o.layers.test(camera.layers))ids.push(o.id);});return ids;};
    assert.equal(seenBy(mainCamera).length,4);
    assert.deepEqual(seenBy(lamp.shadow.camera),seenBy(mainCamera));
    assert.equal(wall.layers.test(lamp.shadow.camera.layers),true);
    assert.equal(forest.layers.test(lamp.shadow.camera.layers),false);
  }finally{daylight.dispose();}
});
