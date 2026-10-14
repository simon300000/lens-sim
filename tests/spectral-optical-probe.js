import { SPECTRAL_WGSL, rgbToXYZ } from '../src/spectral/reconstruction.js';
import { SAMPLING_WGSL, sampleDimension } from '../src/spectral/sampler.js';
import probeKernel from './spectral-optical-probe.wgsl?raw';

const COLORS = Object.freeze([
  [0,0,0], [1,1,1], [1,0,0], [0,1,0], [0,0,1],
  [0,1,1], [1,0,1], [1,1,0], [.18,.18,.18], [4,2,.5], [200,20,2],
]);
const INDICES = [0,1,2,7,31,255,16383,1048575];

/**
 * Actual native-GPU numerical checks, on the caller's existing Three device.
 * Run from the browser harness: await runSpectralProbe(interop).
 * Throws on compilation, validation, nonfinite output or failed assertions.
 * No renderer/device creation, retained per-pixel readback, or image fallback.
 * The returned elapsedMs is expressly CPU wall time, not GPU timestamp timing.
 */
export async function runSpectralProbe(interop) {
  if (!interop?.device || !interop.computePipeline || !interop.storage || !interop.readBuffer || !interop.release) {
    throw new TypeError('runSpectralProbe requires initialized shared-device GPU interop.');
  }
  const started = performance.now();
  const fixtures=[];
  for (const pixelId of [0, 19, 100003]) for (let dimension=0;dimension<5;dimension++) {
    for (const sampleIndex of INDICES) fixtures.push([pixelId,sampleIndex,dimension,42]);
  }
  const strata=16384, outputRows=fixtures.length+2*COLORS.length;
  const inputWords=Uint32Array.from([[fixtures.length,strata,COLORS.length,0],...fixtures].flat());
  const colorCode=`const PROBE_COLORS: array<vec3f,${COLORS.length}> = array<vec3f,${COLORS.length}>(\n`
    +COLORS.map(rgb=>`vec3f(${rgb.map(x=>Number(x).toExponential(9)).join(',')})`).join(',\n')+'\n);';
  const code=SAMPLING_WGSL+'\n'+SPECTRAL_WGSL+'\n'+probeKernel.replace('/*PROBE_COLORS*/',colorCode);
  const pipeline=await interop.computePipeline(code,'Native spectral/Sobol numerical probe');
  let input,output,scopePending=false;
  try {
    input=interop.storage(inputWords,'Spectral probe u32 fixtures');
    output=interop.storage(outputRows*16,'Spectral probe f32 results');
    const {device}=interop;
    device.pushErrorScope('validation');scopePending=true;
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:input}}, {binding:1,resource:{buffer:output}},
    ]});
    const encoder=device.createCommandEncoder({label:'Spectral numerical probe'});
    const pass=encoder.beginComputePass();
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);
    pass.dispatchWorkgroups(Math.ceil((fixtures.length+COLORS.length)/64));pass.end();
    device.queue.submit([encoder.finish()]);
    const raw=await interop.readBuffer(output,outputRows*16);
    const validation=await device.popErrorScope();scopePending=false;
    if(validation)throw new Error(`Spectral GPU probe validation: ${validation.message}`);
    const floats=new Float32Array(raw),words=new Uint32Array(raw);
    if(!floats.every(Number.isFinite))throw new Error('Spectral GPU probe produced nonfinite data.');
    const expectedView=new DataView(new ArrayBuffer(4));
    let exactParityCount=0;
    for(let i=0;i<fixtures.length;i++){
      const fixture=fixtures[i],expected=sampleDimension(...fixture);
      expectedView.setFloat32(0,expected,true);
      const expectedBits=expectedView.getUint32(0,true);
      if(words[i*4]!==expectedBits)throw new Error(`GPU Sobol parity mismatch ${fixture}: ${floats[i*4]} != ${expected} (${words[i*4]} != ${expectedBits})`);
      exactParityCount++;
    }
    let maxAbsoluteError=0,maxScaledError=0;
    const roundtrips=COLORS.map((rgb,index)=>{
      const offset=(fixtures.length+2*index)*4;
      const xyz=Array.from(floats.slice(offset,offset+3));
      const outputRGB=Array.from(floats.slice(offset+4,offset+7));
      if(floats[offset+3]!==1 || floats[offset+7]!==1)throw new Error(`GPU spectral finite check failed for ${rgb}`);
      const expectedXYZ=rgbToXYZ(rgb);
      for(const [actual,expected] of [[xyz,expectedXYZ],[outputRGB,rgb]])for(let c=0;c<3;c++){
        const absoluteError=Math.abs(actual[c]-expected[c]);
        const scaledError=absoluteError/Math.max(1,Math.abs(expected[c]));
        maxAbsoluteError=Math.max(maxAbsoluteError,absoluteError);
        maxScaledError=Math.max(maxScaledError,scaledError);
        if(scaledError>1e-4)throw new Error(`GPU spectral roundtrip error rgb=${rgb}, channel=${c}, actual=${actual[c]}, expected=${expected[c]}, scaledError=${scaledError}`);
      }
      return {inputRGB:rgb,xyz,outputRGB};
    });
    return {
      passed:true,sharedDevice:true,sobolFixtures:fixtures.length,exactParityCount,
      dimensions:5,pixels:3,sampleIndices:INDICES,wavelengthStrata:strata,
      spectralColors:COLORS.length,tolerance:'abs(error) <= 1e-4 * max(1, abs(expected channel))',
      maxAbsoluteError,maxScaledError,roundtrips,
      memoryBytes:inputWords.byteLength+outputRows*16,
      elapsedMs:performance.now()-started,timingKind:'CPU wall time including compilation and one diagnostic readback; not GPU time',
    };
  } finally {
    if(scopePending)await interop.device.popErrorScope();
    if(input)interop.release(input);
    if(output)interop.release(output);
  }
}
