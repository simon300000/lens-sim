import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripWorkCounting} from '../src/rendering/shader-variants.js';
import {linearMirrorGroups} from '../src/rendering/split-mirror.js';

test('production shader strips diagnostic storage bindings with LF and CRLF',()=>{
  const source=readFileSync(new URL('../src/rendering/optical-integrator.wgsl',import.meta.url),'utf8').replaceAll('\r\n','\n');
  for(const eol of ['\n','\r\n']){
    const stripped=stripWorkCounting(source.replaceAll('\n',eol));
    assert.ok(!stripped.includes('@binding(21)'));
    assert.ok(!stripped.includes('workgroupWork'));
    assert.ok(stripped.includes('fn integrateMirrors'));
    assert.ok(linearMirrorGroups(source.replaceAll('\n',eol)).includes('let linear=group*64u'));
  }
  assert.equal(stripWorkCounting('keep\n// WORK-COUNTING-BEGIN\nhide\n// WORK-COUNTING-END'),'keep\n');
});
