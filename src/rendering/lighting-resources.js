import * as THREE from 'three/webgpu';
import {uniform as nodeUniform,vec4,context} from 'three/tsl';
import { lensMaterial, PROCEDURAL } from '../scene/lens-registry.js';
import { withReflectionPixelRatio } from './three-interop.js';

/** Lighting resource bridge (the only module that reaches into Three's
 * shadow-map, PMREM and reflector render targets). Raster continues to
 * GENERATE these resources; the lens compute only reads them on the same
 * GPUDevice. Nothing is copied through the CPU.
 *
 * Supported (pinned r183): up to 2 DirectionalLights with PCFSoft shadow maps,
 * up to 8 PointLights of which up to 2 have cube shadow maps, 1 HemisphereLight,
 * scene.environment as a PMREM cubeUV texture, FogExp2, and the registered
 * water reflector. Anything else is an explicit error, never a silent drop.
 */
export const LIGHTING_UNIFORM_BYTES = 1008;
const F = { sunDirection: 0, sunColor: 4, moonDirection: 8, moonColor: 12, hemiSky: 16, hemiGround: 20, hemiUp: 24,
  pointPosition: 28, pointColor: 60, pointShadowSlot: 92, counts: 124, dirShadowMatrix: 128, dirShadowParams: 160,
  pointShadowParams: 168, pointShadowParams2: 176, fog: 184, environment: 188, skyZenith: 192, skyHorizon: 196, skyGround: 200,
  skyParams: 204, skySun: 208, skySunColor: 212, skySunDisc: 216, moon: 220, moonDir: 224, moonIllumination: 228,
  reflectionViewProj: 232, stars: 248 };
const FLAG_ENVIRONMENT = 1, FLAG_REFLECTION = 2, FLAG_HEMI = 4;
// Area-equivalent angular radius of the raster 1.25 px star sprite at a
// 1080 px tall, 40 degree reference view; radiance equals the sprite value.
export const STAR_ANGULAR_RADIUS = 1.25 * (40 * Math.PI / 180 / 1080) / Math.sqrt(Math.PI);

function cubeUVSize(height) {
  const maxMip = Math.log2(height) - 2;
  return { texelWidth: 1 / (3 * Math.max(2 ** maxMip, 7 * 16)), texelHeight: 1 / height, maxMip };
}

export function createLightingResources({ interop, renderer, scene, camera, environment, refreshContext, reflectionPixelRatio = () => renderer.getPixelRatio(), refreshSize = [16, 11] }) {
  if (THREE.REVISION !== '183') throw new Error(`Lighting bridge requires tested Three r183; got ${THREE.REVISION}`);
  if (renderer.reversedDepthBuffer || renderer.logarithmicDepthBuffer) throw new Error('镜头光照桥接只支持标准深度缓冲（非反向/对数深度）');
  const { device } = interop;
  const uniform = interop.uniform(new Uint8Array(LIGHTING_UNIFORM_BYTES), 'Lens lighting / environment parameters');
  const compareSampler = device.createSampler({ label: 'Lens shadow compare', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
  const linearSampler = device.createSampler({ label: 'Lens linear clamp', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const dummyDepth = device.createTexture({ label: 'Lens unused shadow slot', size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  const dummyCube = device.createTexture({ label: 'Lens unused cube shadow slot', size: [1, 1, 6], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  const dummyColor = device.createTexture({ label: 'Lens unused colour slot', size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  // A tiny target only to trigger resource passes (shadow maps, reflector).
  // Its own pixels are never read by the lens path.
  const refreshTarget = new THREE.RenderTarget(refreshSize[0], refreshSize[1], { type: THREE.HalfFloatType, depthBuffer: true });
  refreshTarget.texture.name = 'Lens lighting-resource refresh (pixels unused)';
  // Match the application's RenderPipeline -> scene pass -> reflector nesting.
  // Three keys render contexts by nesting depth as well as target attachments.
  // A direct outer render would rebuild the same reflected PBR scene at depth 2.
  let refreshPipeline=null;
  if(refreshContext){
    const trigger=nodeUniform(0).onRenderUpdate(()=>{renderer.render(scene,camera);return 0;});
    refreshPipeline=new THREE.RenderPipeline(renderer);refreshPipeline.outputNode=vec4(trigger);
  }
  const receiverMaterial=new THREE.MeshStandardNodeMaterial({color:0xffffff,roughness:1,fog:false,depthWrite:false});
  receiverMaterial.name='Lighting resource trigger';
  // This draw exists only to update shadow hooks, never to generate beauty/AO.
  // Its own material key prevents reuse of a beauty receiver's AO dependency.
  receiverMaterial.contextNode=context({getAO:input=>input});
  const textureIds = new WeakMap(); let nextTextureId = 0;
  let views = null, viewKey = '', revision = 0, refreshes = 0, lastRefreshMs = null, status = { ok: false, errors: [], warnings: [] };
  const data = new Float32Array(LIGHTING_UNIFORM_BYTES / 4), u32 = new Uint32Array(data.buffer);

  function gpuTexture(texture, expect) {
    const resource = interop.texture(texture);
    if (expect.dimension && resource.dimension !== expect.dimension) throw new Error(`${texture.name}: 维度 ${resource.dimension}`);
    if (expect.formats && !expect.formats.includes(resource.format)) throw new Error(`${texture.name}: 不支持的格式 ${resource.format}`);
    if (expect.layers && resource.depthOrArrayLayers !== expect.layers) throw new Error(`${texture.name}: 层数 ${resource.depthOrArrayLayers}`);
    return resource;
  }
  const depthFormats = ['depth16unorm', 'depth24plus', 'depth24plus-stencil8', 'depth32float', 'depth32float-stencil8'];

  function collectLights() {
    const lights = { directional: [], point: [], hemisphere: [], unsupported: [] };
    scene.traverseVisible(o => {
      if (!o.isLight) return;
      if (o.isDirectionalLight) lights.directional.push(o);
      else if (o.isPointLight) lights.point.push(o);
      else if (o.isHemisphereLight) lights.hemisphere.push(o);
      else lights.unsupported.push(o.type);
    });
    return lights;
  }

  /** Rebuild the uniform from the CURRENT raster resources. Call after any
   * lighting/time/camera refresh render; returns true if texture views changed. */
  function update() {
    const errors = [], warnings = [];
    data.fill(0);
    const textures = { sun: dummyDepth, moon: dummyDepth, point0: dummyCube, point1: dummyCube, environment: dummyColor, reflection: dummyColor };
    const lights = collectLights();
    if (lights.unsupported.length) errors.push(`镜头光照未实现的灯型：${[...new Set(lights.unsupported)].join(', ')}`);
    if (lights.directional.length > 2) errors.push('镜头光照最多支持 2 个方向光');
    if (lights.hemisphere.length > 1) errors.push('镜头光照最多支持 1 个半球光');
    if (lights.point.length > 8) errors.push('镜头光照最多支持 8 个点光源');
    // Three allocates a light's shadow map only when a shadow RECEIVER is
    // rendered; with no registered receivers the map is legitimately absent.
    let receivers = false;
    scene.traverseVisible(o => { if (o.isMesh && o.receiveShadow && !o.userData?.lensRole) receivers = true; });
    const shadowsOn = renderer.shadowMap.enabled && receivers;
    if (shadowsOn && renderer.shadowMap.type !== THREE.PCFSoftShadowMap) errors.push('镜头光照只移植了 PCFSoftShadowMap 过滤');
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    lights.directional.slice(0, 2).forEach((light, slot) => {
      const base = slot === 0 ? F.sunDirection : F.moonDirection, colour = slot === 0 ? F.sunColor : F.moonColor;
      v.setFromMatrixPosition(light.matrixWorld); w.setFromMatrixPosition(light.target.matrixWorld);
      const dir = v.sub(w).normalize();
      data.set([dir.x, dir.y, dir.z, -1], base);
      data.set([light.color.r * light.intensity, light.color.g * light.intensity, light.color.b * light.intensity, 0], colour);
      if (shadowsOn && light.castShadow && light.intensity > 0) {
        const depth = light.shadow.map?.depthTexture;
        if (!depth) { errors.push(`${light.name || '方向光'} 的阴影贴图尚未由光栅生成`); return; }
        try {
          textures[slot === 0 ? 'sun' : 'moon'] = gpuTexture(depth, { dimension: '2d', formats: depthFormats });
          data[base + 3] = slot;
          data.set(light.shadow.matrix.elements, F.dirShadowMatrix + slot * 16);
          data.set([light.shadow.bias, light.shadow.normalBias, light.shadow.intensity, light.shadow.mapSize.width], F.dirShadowParams + slot * 4);
        } catch (error) { errors.push(`${light.name}: ${error.message}`); }
      }
    });
    let pointShadows = 0;
    lights.point.slice(0, 8).forEach((light, i) => {
      v.setFromMatrixPosition(light.matrixWorld);
      data.set([v.x, v.y, v.z, light.distance], F.pointPosition + i * 4);
      data.set([light.color.r * light.intensity, light.color.g * light.intensity, light.color.b * light.intensity, light.decay], F.pointColor + i * 4);
      data[F.pointShadowSlot + i * 4] = -1;
      if (!(shadowsOn && light.castShadow)) return;
      if (pointShadows >= 2) { errors.push('镜头光照最多支持 2 个点光阴影'); return; }
      const slot = pointShadows++;
      if (light.intensity <= 0) return;
      const depth = light.shadow.map?.depthTexture;
      if (!depth) { errors.push(`${light.name || '点光源'} 的立方体阴影尚未由光栅生成`); return; }
      try {
        textures[`point${slot}`] = gpuTexture(depth, { formats: depthFormats, layers: 6 });
        data[F.pointShadowSlot + i * 4] = slot;
        const far = light.distance || light.shadow.camera.far;
        data.set([light.shadow.camera.near, far, light.shadow.bias, light.shadow.normalBias], F.pointShadowParams + slot * 4);
        data.set([light.shadow.intensity, light.shadow.mapSize.width, light.shadow.radius, 0], F.pointShadowParams2 + slot * 4);
      } catch (error) { errors.push(`${light.name}: ${error.message}`); }
    });
    let flags = 0;
    const hemi = lights.hemisphere[0];
    if (hemi) {
      flags |= FLAG_HEMI;
      data.set([hemi.color.r * hemi.intensity, hemi.color.g * hemi.intensity, hemi.color.b * hemi.intensity, 0], F.hemiSky);
      data.set([hemi.groundColor.r * hemi.intensity, hemi.groundColor.g * hemi.intensity, hemi.groundColor.b * hemi.intensity, 0], F.hemiGround);
      v.setFromMatrixPosition(hemi.matrixWorld).normalize(); data.set([v.x, v.y, v.z, 0], F.hemiUp);
    }
    if (scene.environment) {
      const env = scene.environment;
      if (!env.isPMREMTexture) errors.push('scene.environment 不是 PMREM cubeUV 纹理');
      else {
        try {
          textures.environment = gpuTexture(env, { dimension: '2d', formats: ['rgba16float', 'rgba32float'] });
          const size = cubeUVSize(env.image.height);
          data.set([size.texelWidth, size.texelHeight, size.maxMip, scene.environmentIntensity], F.environment);
          flags |= FLAG_ENVIRONMENT;
        } catch (error) { errors.push(`PMREM: ${error.message}`); }
      }
    }
    if (scene.fog) {
      if (!scene.fog.isFogExp2) errors.push('镜头模式只实现 FogExp2');
      else data.set([scene.fog.color.r, scene.fog.color.g, scene.fog.color.b, scene.fog.density], F.fog);
    }
    // Registered water reflector: the main camera's reflection target.
    let reflectors = 0;
    scene.traverseVisible(o => {
      const descriptor = o.isMesh && !Array.isArray(o.material) ? lensMaterial(o.material) : null;
      if (descriptor?.kind !== PROCEDURAL.WATER) return;
      if (++reflectors > 1) { errors.push('镜头模式只支持一个平面反射水面'); return; }
      const base = descriptor.reflector.reflector, virtual = base.virtualCameras.get(camera);
      const target = virtual && base.renderTargets.get(virtual);
      if (!target || !target.width) { warnings.push('水面反射尚未由光栅生成；反射项暂为 0'); return; }
      try {
        textures.reflection = gpuTexture(target.texture, { dimension: '2d', formats: ['rgba16float'] });
        flags |= FLAG_REFLECTION;
      } catch (error) { errors.push(`水面反射: ${error.message}`); }
    });
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    data.set(vp.elements, F.reflectionViewProj);
    if (environment) {
      const p = environment.parameters;
      data.set([...p.zenith.value.toArray(), 0], F.skyZenith); data.set([...p.horizon.value.toArray(), 0], F.skyHorizon);
      data.set([...p.ground.value.toArray(), 0], F.skyGround);
      data.set([p.skyLuminance.value, p.daylight.value, p.twilight.value, p.discs.value], F.skyParams);
      data.set([...p.sunDirection.value.toArray(), p.sunDiscLuminance.value], F.skySun);
      data.set([...p.sunColor.value.toArray(), 0], F.skySunColor);
      data.set([p.sunInnerCos.value, p.sunOuterCos.value, 0, 0], F.skySunDisc);
      data.set([p.moonRadius.value, p.moonDiscLuminance.value, environment.moonMesh?.visible ? 1 : 0, p.starLuminance.value], F.moon);
      data.set([...p.moonDirection.value.toArray(), 215], F.moonDir);
      data.set([...p.moonIllumination.value.toArray(), 0], F.moonIllumination);
      data.set([STAR_ANGULAR_RADIUS, environment.starsMesh?.visible ? 1 : 0, 0, 0], F.stars);
    } else warnings.push('未注册天空/日月环境：背景辐亮度为 0（仅诊断场景）');
    u32[F.counts] = Math.min(8, lights.point.length); u32[F.counts + 1] = flags;
    device.queue.writeBuffer(uniform, 0, data);
    revision++;
    status = { ok: errors.length === 0, errors, warnings, lights: { directional: lights.directional.length, point: lights.point.length, pointShadows, hemisphere: lights.hemisphere.length },
      environment: !!(flags & FLAG_ENVIRONMENT), reflection: !!(flags & FLAG_REFLECTION) };
    const key = Object.values(textures).map(t => { if (!textureIds.has(t)) textureIds.set(t, ++nextTextureId); return textureIds.get(t); }).join('|');
    const changed = key !== viewKey;
    if (changed) {
      viewKey = key;
      views = { sun: textures.sun.createView({ dimension: '2d' }), moon: textures.moon.createView({ dimension: '2d' }),
        point0: textures.point0.createView({ dimension: 'cube' }), point1: textures.point1.createView({ dimension: 'cube' }),
        environment: textures.environment.createView({ dimension: '2d' }), reflection: textures.reflection.createView({ dimension: '2d' }) };
    }
    return changed;
  }

  /** Raster resource pass: renders the scene once into a tiny target from the
   * main camera. This updates only what Three schedules for that render
   * (shadow maps flagged needsUpdate, the camera-dependent water reflector).
   * The lens path never samples refreshTarget. */
  function refresh() {
    const started = performance.now();
    const previous = renderer.getRenderTarget(), previousMRT = renderer.getMRT();
    const previousContext=renderer.contextNode,previousRenderObject=renderer.getRenderObjectFunction();
    const reflectors=new Set();
    scene.traverseVisible(object=>{
      const descriptor=object.isMesh&&!Array.isArray(object.material)?lensMaterial(object.material):null;
      if(descriptor?.kind===PROCEDURAL.WATER&&descriptor.reflector?.reflector)reflectors.add(descriptor.reflector.reflector);
    });
    let receiverDrawn=false;
    // Only a receiver and registered water need the outer draw: their updateBefore
    // hooks generate complete shadow maps and the complete reflected scene. Shadow
    // passes install their own caster callback; reflected cameras pass through.
    const renderResourceObject=(object,passScene,passCamera,geometry,material,...rest)=>{
      const reflector=lensMaterial(material)?.kind===PROCEDURAL.WATER;
      if(passCamera===camera&&renderer.getRenderTarget()===refreshTarget&&!reflector){
        if(receiverDrawn||!object.receiveShadow||!material.isMeshStandardNodeMaterial)return;
        receiverDrawn=true;material=receiverMaterial;
      }
      if(previousRenderObject)previousRenderObject.call(renderer,object,passScene,passCamera,geometry,material,...rest);
      else renderer.renderObject(object,passScene,passCamera,geometry,material,...rest);
    };
    try {
      const context=refreshContext?.();if(context)renderer.contextNode=context;
      renderer.setRenderObjectFunction(renderResourceObject);
      renderer.setMRT(null); renderer.setRenderTarget(refreshTarget);
      withReflectionPixelRatio(renderer,reflectors,reflectionPixelRatio(),()=>{
        if(refreshPipeline)refreshPipeline.render();else renderer.render(scene,camera);
      });
    }finally {
      renderer.setRenderObjectFunction(previousRenderObject);renderer.contextNode=previousContext;
      renderer.setMRT(previousMRT); renderer.setRenderTarget(previous);
    }
    refreshes++; lastRefreshMs = performance.now() - started;
    return update();
  }
  return {
    uniform, compareSampler, linearSampler,
    get views() { return views; }, get status() { return status; }, get revision() { return revision; },
    get refreshes() { return refreshes; }, get refreshMs() { return lastRefreshMs; },
    bindings(base) {
      return [
        { binding: base, resource: { buffer: uniform } },
        { binding: base + 1, resource: views.sun }, { binding: base + 2, resource: views.moon },
        { binding: base + 3, resource: views.point0 }, { binding: base + 4, resource: views.point1 },
        { binding: base + 5, resource: views.environment }, { binding: base + 6, resource: views.reflection },
        { binding: base + 7, resource: compareSampler }, { binding: base + 8, resource: linearSampler },
      ];
    },
    update, refresh,
    dispose() { receiverMaterial.dispose();refreshPipeline?.dispose();refreshTarget.dispose(); dummyDepth.destroy(); dummyCube.destroy(); dummyColor.destroy(); interop.release(uniform); },
  };
}
