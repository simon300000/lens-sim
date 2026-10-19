import test from 'node:test';
import assert from 'node:assert/strict';
import {RASTER_QUALITY_DEFAULTS,RASTER_QUALITY_STORAGE_KEY,normalizeRasterQuality,rasterPixelRatio,loadRasterQuality,saveRasterQuality} from '../src/rendering/raster-quality.js';

const memoryStorage=()=>{const map=new Map();return {getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),map};};

test('patches merge into validated settings and reject unknown keys or ratios',()=>{
  const next=normalizeRasterQuality({ambientOcclusion:false},RASTER_QUALITY_DEFAULTS);
  assert.deepEqual(next,{...RASTER_QUALITY_DEFAULTS,ambientOcclusion:false});
  assert.deepEqual(normalizeRasterQuality({pixelRatio:0.75},next).pixelRatio,'0.75','numbers are accepted as the option string');
  assert.throws(()=>normalizeRasterQuality({pixelRatio:'2'}),/渲染分辨率/);
  assert.throws(()=>normalizeRasterQuality({shadows:false}),/未知/);
  assert.throws(()=>normalizeRasterQuality(null),/无效/);
  assert.equal(normalizeRasterQuality({reflection:0}).reflection,false,'booleans are coerced');
});

test('pixel ratio follows the screen up to 1.5 only for auto',()=>{
  assert.equal(rasterPixelRatio('auto',2),1.5);assert.equal(rasterPixelRatio('auto',1),1);
  assert.equal(rasterPixelRatio('1',2),1);assert.equal(rasterPixelRatio('0.75',2),.75);
});

test('settings round-trip through storage and fall back to defaults on garbage',()=>{
  const storage=memoryStorage();
  assert.deepEqual(loadRasterQuality(storage),RASTER_QUALITY_DEFAULTS);
  assert.equal(saveRasterQuality(storage,{...RASTER_QUALITY_DEFAULTS,pixelRatio:'1',reflection:false}),true);
  assert.deepEqual(loadRasterQuality(storage),{...RASTER_QUALITY_DEFAULTS,pixelRatio:'1',reflection:false});
  storage.setItem(RASTER_QUALITY_STORAGE_KEY,'{not json');
  assert.deepEqual(loadRasterQuality(storage),RASTER_QUALITY_DEFAULTS);
  storage.setItem(RASTER_QUALITY_STORAGE_KEY,JSON.stringify({pixelRatio:'9'}));
  assert.deepEqual(loadRasterQuality(storage),RASTER_QUALITY_DEFAULTS,'invalid saved values are ignored');
  assert.deepEqual(loadRasterQuality(null),RASTER_QUALITY_DEFAULTS,'no storage at all');
  assert.equal(saveRasterQuality({setItem(){throw new Error('quota');}},RASTER_QUALITY_DEFAULTS),false);
});


test('MSAA is a validated numeric setting and migrate old preferences',()=>{
  const storage=memoryStorage();
  storage.setItem(RASTER_QUALITY_STORAGE_KEY,JSON.stringify({pixelRatio:'1',reflection:false}));
  assert.deepEqual(loadRasterQuality(storage),{...RASTER_QUALITY_DEFAULTS,pixelRatio:'1',reflection:false});
  const settings=normalizeRasterQuality({msaa:'0'});
  assert.equal(settings.msaa,0);
  assert.equal(saveRasterQuality(storage,settings),true);assert.deepEqual(loadRasterQuality(storage),settings);
  for(const msaa of [2,8,-1,true,null,''])assert.throws(()=>normalizeRasterQuality({msaa}),/MSAA/);
});
