import * as THREE from 'three/webgpu';
import { buildTestTargets } from './test-targets.js';
import { buildVilla } from '../villa.js';
import { buildVegetation } from '../vegetation.js';
import { buildGarden } from '../garden.js';
import { buildLandscape } from '../landscape.js';
import { buildDetails } from '../details.js';
import { applyMeadowVariation, applyWaterSurface } from './procedural-materials.js';
import { batchStaticSiblings, partitionStaticInstances } from './static-batches.js';
import { LOCAL_LAMP_SHADOW_LAYER } from './render-layers.js';

/** The SANTEI villa scene, shared by the application and GPU benchmarks.
 * Lights from daylight (Sun/Moon/sky) are added by the caller. */
export function buildSanteiScene() {
  const scene=new THREE.Scene();
  scene.background=new THREE.Color('#e1e5d5');
  scene.fog=new THREE.FogExp2('#dce3d5',.0065);
  const garden=buildGarden(scene);
  const landscape=buildLandscape(scene,garden.pondOutline);
  const villa=buildVilla(scene);
  const vegetation=buildVegetation(scene);
  const details=buildDetails(scene,{garden,villa,vegetation,landscape});
  // Both paper lanterns need wall/roof occlusion. Their shadow cameras see the
  // local joinery layer, keeping the entire remote forest out of six cube faces.
  villa.group.traverse(o=>{if(o.isMesh)o.layers.enable(LOCAL_LAMP_SHADOW_LAYER);});
  details.group.traverse(o=>{if(o.isMesh)o.layers.enable(LOCAL_LAMP_SHADOW_LAYER);});
  for(const lamp of details.lamps.slice(0,2)){
    lamp.light.castShadow=true;
    lamp.light.shadow.mapSize.set(512,512);
    lamp.light.shadow.camera.near=.08;lamp.light.shadow.camera.far=11;
    lamp.light.shadow.camera.layers.set(LOCAL_LAMP_SHADOW_LAYER);
    lamp.light.shadow.bias=-.00008;lamp.light.shadow.normalBias=.025;
  }
  details.metadata.shadowedLamps=2;
  // Terrain can occlude low Sun/Moon rays. Dense tree silhouettes also cast
  // shadows; the individual distant needles keep their cheaper static shading.
  landscape.root.traverse(o=>{
    if(o.isMesh&&(o.name.startsWith('Atmospheric mountain')||o.geometry.type==='IcosahedronGeometry'))o.castShadow=true;
  });
  applyMeadowVariation(landscape.meadow.material);
  if(garden.water)applyWaterSurface(garden.water);
  villa.group.userData.staticBatches=batchStaticSiblings(villa.group);
  garden.garden.userData.staticBatches=batchStaticSiblings(garden.garden);
  landscape.root.userData.spatialBatches=partitionStaticInstances(landscape.root);
  const testTargets=buildTestTargets(scene);
  return { scene, garden, landscape, villa, vegetation, details, testTargets };
}
