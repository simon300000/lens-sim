import * as THREE from 'three/webgpu';
const p=window.__startupProfile;
p.events.push({category:'stage',name:'Three module loaded',start:performance.now(),hidden:document.hidden,focused:document.hasFocus()});
p.wrap(THREE.NodeBuilder.prototype,'build','nodeBuild');
p.wrap(THREE.WebGPURenderer.prototype,'render','render');
for(const [type,names] of [[globalThis.GPURenderPassEncoder,['setPipeline','draw','drawIndexed','end']],[globalThis.GPUCommandEncoder,['finish']],[globalThis.GPUQueue,['submit']]])for(const name of names)p.wrap(type?.prototype,name,'encode');
p.wrap(THREE.RenderPipeline.prototype,'render','renderPipeline');
await import('/src/startup.js');
