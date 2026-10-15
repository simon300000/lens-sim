import * as THREE from 'three/webgpu';
import { uniform, mix, vec3, vec4, normalize, positionWorld, positionLocal, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, dot, smoothstep, pow, max, normalWorld, normalLocal, mx_noise_float } from 'three/tsl';
import { computeCelestialState } from './astronomy.js';
import { rng } from './kit.js';

// Every photometric source uses the same normalization. This keeps half-float
// render targets finite while preserving the Sun/Moon/lamp brightness ratios.
export const LIGHT_SCALE = 100;
const RAD = Math.PI / 180;
const luma = a => a[0] * .2126 + a[1] * .7152 + a[2] * .0722;
const chromatic = a => new THREE.Color(...a).multiplyScalar(1 / Math.max(.001, luma(a)));
const smooth = (a,b,v) => {const t=THREE.MathUtils.clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};

function celestialLight(scene, name, size) {
  const light = new THREE.DirectionalLight('#ffffff', 0);
  light.name=name; light.castShadow=true;
  light.target.position.set(0,1,1);
  light.shadow.mapSize.set(size,size);
  Object.assign(light.shadow.camera,{left:-34,right:34,top:30,bottom:-30,near:1,far:360});
  light.shadow.bias=-.00016;light.shadow.normalBias=.025;
  light.shadow.radius=2.2;light.shadow.autoUpdate=false;
  scene.add(light,light.target);
  return light;
}

function skyMaterial(parameters) {
  const m = new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false,fog:false});
  const direction=normalize(positionWorld.sub(cameraPosition));
  const height=max(direction.y,0);
  const gradient=pow(height,.42);
  const sky=mix(parameters.horizon,parameters.zenith,gradient).mul(parameters.skyLuminance);
  // The angular Rayleigh phase and a narrow forward Mie lobe orient haze
  // towards the actual Sun. Weather is an explicit clear-sky approximation.
  const sunCos=dot(direction,parameters.sunDirection);
  const rayleigh=sunCos.mul(sunCos).mul(.22).add(.78);
  const forward=pow(max(sunCos,0),64);
  const duskGlow=pow(max(sunCos,0),6).mul(pow(height.oneMinus(),2));
  const haze=parameters.sunColor.mul(forward.mul(.22).add(duskGlow.mul(parameters.twilight).mul(.6))).mul(parameters.skyLuminance);
  let result=sky.mul(rayleigh).add(haze);
  const cloudNoise=mx_noise_float(direction.mul(vec3(8,12,8))).add(mx_noise_float(direction.mul(21)).mul(.3));
  const cloud=smoothstep(.25,.64,cloudNoise).mul(smoothstep(.02,.2,height)).mul(.16);
  result=mix(result,parameters.horizon.mul(parameters.skyLuminance).mul(1.2),cloud.mul(parameters.daylight));
  const solarDisc=smoothstep(parameters.sunOuterCos,parameters.sunInnerCos,sunCos)
    .mul(smoothstep(-.001,.001,direction.y)).mul(parameters.sunDiscLuminance).mul(parameters.discs);
  result=result.add(parameters.sunColor.mul(solarDisc));
  // Below the horizon, the environment sees ground-reflected sky rather than
  // an impossible luminous sky under the lawn.
  result=mix(parameters.ground,result,smoothstep(-.025,.025,direction.y));
  m.colorNode=result;
  return m;
}

function stars(scene, parameters) {
  const random=rng(267409),positions=[],colors=[],sizes=[];
  for(let i=0;i<1100;i++) {
    const y=.025+random()*.975,a=random()*Math.PI*2,r=Math.sqrt(1-y*y),strength=.25+random()*.75;
    positions.push(Math.cos(a)*r*218,y*218,Math.sin(a)*r*218);
    colors.push(strength,strength*(.82+random()*.16),strength*(.85+random()*.3));
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  const material=new THREE.PointsNodeMaterial({size:1.25,sizeAttenuation:false,vertexColors:true,depthWrite:false,fog:false,transparent:true});
  material.colorNode=vec3(1,1,1).mul(parameters.starLuminance);
  material.vertexNode=cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(positionLocal.add(cameraPosition),1));
  const mesh=new THREE.Points(geometry,material);mesh.name='Procedural night stars';mesh.renderOrder=-5;
  mesh.frustumCulled=false;
  scene.add(mesh);return mesh;
}

function moon(scene, parameters) {
  const material=new THREE.MeshBasicNodeMaterial({fog:false,transparent:true});
  const moonWorld=positionLocal.mul(parameters.moonRadius).add(parameters.moonDirection.mul(215)).add(cameraPosition);
  material.vertexNode=cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(moonWorld,1));
  material.opacityNode=smoothstep(-.003,.003,positionLocal.y.mul(parameters.moonRadius).add(parameters.moonDirection.y.mul(215)));
  const lightFacing=max(dot(normalWorld,parameters.moonIllumination),0);
  // Procedural lunar maria and crater texture, entirely generated in the shader.
  const maria=mx_noise_float(normalLocal.mul(3.7)).mul(.5).add(.5);
  const detail=mx_noise_float(normalLocal.mul(35)).mul(.08);
  const albedo=smoothstep(.28,.72,maria).mul(.32).add(.52).add(detail);
  material.colorNode=vec3(.95,.93,.86).mul(albedo).mul(lightFacing).mul(parameters.moonDiscLuminance);
  const mesh=new THREE.Mesh(new THREE.SphereGeometry(1,32,20),material);
  mesh.name='Moon with true illuminated limb';mesh.frustumCulled=false;scene.add(mesh);return mesh;
}

/** Accurate ephemerides + calibrated clear-sky rendering; no downloaded HDR. */
export function createDaylight(scene, renderer, {details,invalidate=()=>{}}={}) {
  const sun=celestialLight(scene,'Physical Sun',3072);
  const moonLight=celestialLight(scene,'Physical Moon',2048);
  const bounce=new THREE.HemisphereLight('#ffffff','#ffffff',0);
  bounce.name='Low-order ground bounce';scene.add(bounce);
  const parameters={
    zenith:uniform(new THREE.Color()),horizon:uniform(new THREE.Color()),ground:uniform(new THREE.Color('#34442b')),
    skyLuminance:uniform(.1),daylight:uniform(1),twilight:uniform(0),discs:uniform(1),
    sunDirection:uniform(new THREE.Vector3()),sunColor:uniform(new THREE.Color('#ffffff')),
    sunInnerCos:uniform(.99996),sunOuterCos:uniform(.99996),sunDiscLuminance:uniform(0),
    moonIllumination:uniform(new THREE.Vector3()),moonDiscLuminance:uniform(0),starLuminance:uniform(0),
    moonDirection:uniform(new THREE.Vector3()),moonRadius:uniform(1),
  };
  const sky=new THREE.Mesh(new THREE.SphereGeometry(230,48,24),skyMaterial(parameters));
  sky.name='Procedural atmosphere';sky.renderOrder=-10;scene.add(sky);
  const starsMesh=stars(scene,parameters),moonMesh=moon(scene,parameters);
  const environmentScene=new THREE.Scene();
  environmentScene.add(new THREE.Mesh(sky.geometry,skyMaterial(parameters)));
  const pmrem=new THREE.PMREMGenerator(renderer);
  let environmentTarget=null,state=null;
  function refreshEnvironment() {
    parameters.discs.value=0;
    environmentTarget=pmrem.fromScene(environmentScene,.04,.1,260,{size:64,renderTarget:environmentTarget});
    scene.environment=environmentTarget.texture;
    scene.environmentIntensity=1;
    parameters.discs.value=1;
    invalidate();
  }
  function update({hour,date='2026-09-26'},immediate=false) {
    state=computeCelestialState({hour,date});
    const {lighting,sky:skyState}=state;
    sun.position.copy(sun.target.position).addScaledVector(new THREE.Vector3(...state.sun.direction),145);
    moonLight.position.copy(moonLight.target.position).addScaledVector(new THREE.Vector3(...state.moon.direction),145);
    // For a partially risen disk, its visible cap sends downward rays; a below-
    // ground disk centre must not illuminate the lawn from underneath.
    if(state.sun.visibleFraction>0&&state.sun.direction[1]<0)sun.position.y=sun.target.position.y+.05;
    if(state.moon.visibleFraction>0&&state.moon.direction[1]<0)moonLight.position.y=moonLight.target.position.y+.05;
    sun.color.setRGB(...lighting.sunColor);sun.intensity=lighting.sunLux/LIGHT_SCALE;
    moonLight.color.setRGB(...lighting.moonColor);moonLight.intensity=lighting.moonLux/LIGHT_SCALE;
    sun.shadow.radius=2.0+2.5*(1-smooth(0,25,state.sun.altitude));
    moonLight.shadow.radius=2.2;
    sun.shadow.needsUpdate=sun.intensity>0;moonLight.shadow.needsUpdate=moonLight.intensity>0;
    bounce.color.copy(chromatic(skyState.horizon));
    bounce.groundColor.setRGB(.23,.27,.17);
    bounce.intensity=lighting.ambientLux/LIGHT_SCALE*.08;
    renderer.toneMappingExposure=lighting.exposure*LIGHT_SCALE;
    parameters.zenith.value.copy(chromatic(skyState.zenith));
    parameters.horizon.value.copy(chromatic(skyState.horizon));
    const groundAlbedo=new THREE.Color('#586f40');
    const incident=lighting.sunColor.map((c,i)=>
      c*lighting.sunHorizontalLux+lighting.moonColor[i]*lighting.moonHorizontalLux+
      parameters.horizon.value.toArray()[i]*lighting.ambientLux);
    parameters.ground.value.setRGB(...incident).multiply(groundAlbedo).multiplyScalar(1/(Math.PI*LIGHT_SCALE));
    parameters.skyLuminance.value=lighting.ambientLux/(Math.PI*LIGHT_SCALE);
    parameters.daylight.value=lighting.daylight;parameters.twilight.value=lighting.twilight;
    parameters.sunDirection.value.set(...state.sun.direction);parameters.sunColor.value.setRGB(...lighting.sunColor);
    const radius=state.sun.angularRadius*RAD;
    parameters.sunInnerCos.value=Math.cos(radius*.96);parameters.sunOuterCos.value=Math.cos(radius*1.04);
    const unobscuredSunLux=state.sun.visibleFraction>0?lighting.sunLux/state.sun.visibleFraction:0;
    parameters.sunDiscLuminance.value=Math.min(1000,unobscuredSunLux/LIGHT_SCALE/Math.max(.00001,Math.PI*radius*radius));
    parameters.moonIllumination.value.set(...state.moon.illuminationDirection);
    parameters.moonDirection.value.set(...state.moon.direction);
    parameters.moonRadius.value=215*Math.tan(state.moon.angularRadius*RAD);
    moonMesh.visible=state.moon.visibleFraction>0;
    const phase=state.moon.phaseAngle*RAD;
    const lambertDiskMean=2/(3*Math.PI)*(Math.sin(phase)+(Math.PI-phase)*Math.cos(phase));
    const unobscuredMoonLux=state.moon.visibleFraction>0?lighting.moonLux/state.moon.visibleFraction:0;
    parameters.moonDiscLuminance.value=unobscuredMoonLux/LIGHT_SCALE/
      Math.max(.00001,Math.PI*(state.moon.angularRadius*RAD)**2)/Math.max(.0001,.65*lambertDiskMean);
    parameters.starLuminance.value=skyState.starVisibility*.55/LIGHT_SCALE;
    starsMesh.visible=skyState.starVisibility>.0001;
    const lampLevel=1-smooth(-3,3,state.sun.geometricAltitude);
    for(const lamp of details?.lamps||[]) {
      lamp.light.intensity=lamp.candela/LIGHT_SCALE*lampLevel;
      lamp.light.shadow.autoUpdate=false;
      if(lamp.light.castShadow)lamp.light.shadow.needsUpdate=lampLevel>0;
    }
    for(const source of details?.emissiveSources||[])source.material.emissiveIntensity=source.nits/LIGHT_SCALE*lampLevel;
    // Fog represents scattered sky radiance, in the same units as scene light.
    const fogRGB=parameters.horizon.value.clone().multiplyScalar(parameters.skyLuminance.value*.55);
    scene.fog.color.copy(fogRGB);
    scene.background.copy(fogRGB);
    // Commit sky reflections with the new lighting, before its new exposure
    // can render. A delayed daytime PMREM at night exposure whites out the frame.
    refreshEnvironment();
    return state;
  }
  return {update,refreshEnvironment,sun,moon:moonLight,moonMesh,sky,parameters,
    getState:()=>state,dispose(){environmentTarget?.dispose();pmrem.dispose();}};
}
