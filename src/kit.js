import * as THREE from 'three/webgpu';
import { positionLocal, positionView, normalView, sin, mix, materialColor, mx_noise_float, vec3 } from 'three/tsl';
import { WOOD } from './scene/procedural-params.js';
import { setLensMaterial, PROCEDURAL } from './scene/lens-registry.js';
export { THREE };

export function rng(seed = 42) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export const palette = {
  wood: '#735039', woodLight: '#a68154', woodDark: '#392b24', plaster: '#e2ddc6',
  roof: '#384446', stone: '#8b8e7a', grass: '#69884a', leaf: '#52743b', leafLight: '#849951',
};

export function mat(color, roughness = .85, extra = {}) {
  return new THREE.MeshStandardNodeMaterial({ color, roughness, ...extra });
}

export function woodMat(tint='#92714b') {
  const m=mat(tint,.79),W=WOOD;
  const p=positionLocal;
  const n=mx_noise_float(p.mul(vec3(...W.noiseScale)));
  const grain=sin(p.y.mul(W.grainFrequency).add(n.mul(W.grainWarp))).mul(.5).add(.5);
  m.colorNode=materialColor.mul(mix(W.colorLow,W.colorHigh,grain.mul(W.colorGrain).add(n.mul(W.colorNoise)).add(W.colorBias)));
  m.roughnessNode=grain.mul(W.roughnessGrain).add(W.roughnessBase);
  // Surface-gradient bump mapping works on the custom gables as well as UV
  // primitives, so procedural grain never requires an image or UV attribute.
  const height=grain.mul(W.bumpHeight);
  const dx=positionView.dFdx(),dy=positionView.dFdy();
  const r1=dy.cross(normalView),r2=normalView.cross(dx),det=dx.dot(r1);
  m.normalNode=normalView.mul(det.abs()).sub(r1.mul(height.dFdx()).add(r2.mul(height.dFdy())).mul(det.sign())).normalize();
  // The lens evaluator re-implements exactly this graph from the same WOOD
  // constants, with an analytic grain/finite-difference noise gradient.
  setLensMaterial(m,{kind:PROCEDURAL.WOOD});
  return m;
}

const boxGeo = new THREE.BoxGeometry(1,1,1);
const sphereGeo = new THREE.SphereGeometry(1,12,8);
const cylinderGeo = new THREE.CylinderGeometry(1,1,1,10);
export function mesh(parent, geometry, material, position=[0,0,0], scale=[1,1,1], rotation=[0,0,0], shadow=true) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(...position); m.scale.set(...scale); m.rotation.set(...rotation);
  m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m;
}
export function box(parent, material, position, scale, rotation=[0,0,0]) { return mesh(parent,boxGeo,material,position,scale,rotation); }
export function sphere(parent, material, position, scale, rotation=[0,0,0]) { return mesh(parent,sphereGeo,material,position,scale,rotation); }
export function cylinder(parent, material, position, radius, height, rotation=[0,0,0]) { return mesh(parent,cylinderGeo,material,position,[radius,height,radius],rotation); }
export function beam(parent, material, start, end, radius=.07, topRadius=radius) {
  const a = new THREE.Vector3(...start), b=new THREE.Vector3(...end), d=b.clone().sub(a);
  const g=new THREE.CylinderGeometry(topRadius,radius,d.length(),7);
  const m=mesh(parent,g,material,a.clone().add(b).multiplyScalar(.5).toArray());
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),d.normalize()); return m;
}

export function makeBatch(parent, geometry, material, records, {shadow=true,receive=true}={}) {
  if (!records.length) return null;
  const m=new THREE.InstancedMesh(geometry,material,records.length), o=new THREE.Object3D();
  records.forEach((v,i)=>{
    o.position.set(...v.p); o.scale.set(...(v.s||[1,1,1]));
    if (v.q) o.quaternion.set(...v.q); else o.rotation.set(...(v.r||[0,0,0]));
    o.updateMatrix(); m.setMatrixAt(i,o.matrix); if(v.c)m.setColorAt(i,new THREE.Color(v.c));
  });
  m.instanceMatrix.needsUpdate=true; if(m.instanceColor)m.instanceColor.needsUpdate=true;
  m.castShadow=shadow; m.receiveShadow=receive; m.computeBoundingSphere();parent.add(m);return m;
}

export function leafGeometry() {
  // A folded, pointed leaf with real volume along its central vein; no texture cards.
  const g=new THREE.BufferGeometry();
  const v=[0,0,0, -.28,.04,.32, 0,.12,.38, .28,.04,.32, -.22,.02,.68, 0,.1,.72, .22,.02,.68, 0,0,1];
  g.setAttribute('position',new THREE.Float32BufferAttribute(v,3));
  g.setIndex([0,1,2,0,2,3,1,4,5,1,5,2,2,5,6,2,6,3,4,7,5,5,7,6]); g.computeVertexNormals(); return g;
}

export function stoneGeometry(seed=1, detail=0) {
  const random=rng(seed),g=new THREE.IcosahedronGeometry(1,detail),p=g.attributes.position;
  const factors=new Map();
  for(let i=0;i<p.count;i++) {const key=[p.getX(i),p.getY(i),p.getZ(i)].map(v=>v.toFixed(3)).join(',');if(!factors.has(key)) factors.set(key,.82+random()*.3);const s=factors.get(key);p.setXYZ(i,p.getX(i)*s,p.getY(i)*s,p.getZ(i)*s);}
  g.computeVertexNormals();return g;
}
