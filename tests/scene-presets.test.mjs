import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Scene} from 'three/webgpu';
import {SCENE_PRESETS,VIDEO_PRESETS,PRESETS} from '../src/scene/scene-presets.js';
import manifest from '../public/lenses/manifest.json' with {type:'json'};
import {computeCelestialState} from '../src/astronomy.js';
import {buildNightLights} from '../src/night-lights.js';
import {extractScene} from '../src/scene/scene-extract.js';

test('every preset is a valid shot with its own button',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.equal(Object.keys(PRESETS).length,Object.keys(SCENE_PRESETS).length+Object.keys(VIDEO_PRESETS).length);
 for(const [key,p] of Object.entries(PRESETS)){
  assert.match(html,new RegExp(`data-scene-preset="${key}"`),key);
  assert.ok(p.position.some((v,i)=>Math.abs(v-p.target[i])>1),key);
  // Same validation as the runtime commands and the date input.
  // A missing focusM means AF-S at the frame centre (video shots only).
  assert.ok(p.focusM===undefined?key in VIDEO_PRESETS:p.focusM===null||(p.focusM>=.1&&p.focusM<=10000),key);
  assert.ok(p.exposureEV>=-6&&p.exposureEV<=6,key);
  assert.ok(p.hour>=0&&p.hour<=24,key);assert.match(p.date,/^\d{4}-\d{2}-\d{2}$/);
 }
});

test('bokeh scenes are at night, with lamps and night sources fully on',()=>{
 // lighting.js: lamp level = 1 - smooth(-3, 3, solar altitude).
 for(const [key,p] of Object.entries(SCENE_PRESETS))
  assert.ok(computeCelestialState({hour:p.hour,date:p.date}).sun.geometricAltitude<-3,key);
});

test('video shots name catalogue lenses; unstated focus uses AF-S',()=>{
 for(const [key,p] of Object.entries(VIDEO_PRESETS)){
  assert.equal(manifest.lenses.find(l=>l.id===p.lens)?.supported,true,`${key}: ${p.lens}`);
  assert.ok(p.fNumber===undefined||p.fNumber>0,key);
 }
 // Only the fisheye and Summilux shots were taken at a stated focus distance.
 assert.deepEqual(Object.keys(VIDEO_PRESETS).filter(k=>VIDEO_PRESETS[k].focusM!==undefined),['fisheyeEave','villaSummilux']);
});

test('night point sources are lens-supported emissive geometry, off until lit',()=>{
 const scene=new Scene(),night=buildNightLights(scene),ex=extractScene(scene);
 assert.deepEqual(ex.report.unsupported,[]);
 let lights=0;scene.traverse(o=>{if(o.isLight)lights++;});
 assert.equal(lights,0);
 for(const {material,nits} of night.emissiveSources){assert.equal(material.emissiveIntensity,0);assert.equal(material.userData.nominalNits,nits);}
 assert.ok(night.metadata.fireflies>60&&night.metadata.stakeLights>=20&&night.metadata.roadLamps>10);
});
