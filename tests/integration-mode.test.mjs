import test from 'node:test';
import assert from 'node:assert/strict';
import {preferredIntegrationMode} from '../src/rendering/integration-mode.js';
test('adapter policy selects Apple split and staged for other or redacted adapters',()=>{
  for(const info of [{vendor:'apple'},{vendor:'Apple Inc.'},{architecture:'apple-gpu'},{description:'Apple M2 Pro'}])assert.equal(preferredIntegrationMode(info),'split');
  for(const info of [undefined,{}, {vendor:'nvidia',description:'NVIDIA GeForce RTX 4090'},{vendor:'intel'},{vendor:'amd',description:'Apple Radeon Pro'},{description:'M2 Pro'}])assert.equal(preferredIntegrationMode(info),'staged');
});
