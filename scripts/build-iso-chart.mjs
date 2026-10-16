// Rebuild with: node scripts/build-iso-chart.mjs
// Source: Stephen H. Westin, Cornell University (see assets/test-charts/README.md).
// Outline embedded fonts, tessellate SVG fills/strokes, then resolve painter order
// in 2D. The result is one coplanar mesh, without image sampling or depth layers.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DOMParser} from '@xmldom/xmldom';
import clipping from 'polygon-clipping';
import {SVGLoader} from 'three/addons/loaders/SVGLoader.js';
import {Shape,Path,ShapeGeometry,Color,SRGBColorSpace} from 'three';

const source=readFileSync(new URL('../assets/test-charts/ISO_12233-reschart.svg',import.meta.url),'utf8');
const xml=execFileSync('python3',[new URL('./outline-iso-fonts.py',import.meta.url).pathname],{input:source,encoding:'utf8',maxBuffer:8*1024*1024});
const doc=new DOMParser().parseFromString(xml,'image/svg+xml');
const outlinedGlyphs=Number(doc.documentElement.getAttribute('data-outlined-glyphs'));
// SVGLoader needs only the DOM API supplied by xmldom for this document.
globalThis.DOMParser=class{parseFromString(){return doc;}};
const {paths}=new SVGLoader().parse('');
const batches=[];
function paint(polygons,color){
  if(!polygons.length)return;
  const previous=batches.at(-1);
  if(previous?.color===color)previous.polygons.push(...polygons);
  else batches.push({color,polygons});
}
const ring=points=>{const r=points.map(p=>[p.x,p.y]);r.push(r[0]);return r;};
for(const path of paths){
  const s=path.userData.style;
  if(s.fill!=='none')paint(SVGLoader.createShapes(path).map(shape=>{
    const points=shape.extractPoints(8);return [ring(points.shape),...points.holes.map(ring)];
  }),s.fill);
  if(s.stroke&&s.stroke!=='none'){
    const triangles=[];
    for(const sub of path.subPaths){
      const geometry=SVGLoader.pointsToStroke(sub.getPoints(8),s);
      if(!geometry)continue;
      const p=geometry.attributes.position;
      for(let i=0;i<p.count;i+=3)triangles.push([[[p.getX(i),p.getY(i)],[p.getX(i+1),p.getY(i+1)],[p.getX(i+2),p.getY(i+2)],[p.getX(i),p.getY(i)]]]);
      geometry.dispose();
    }
    paint(triangles,s.stroke);
  }
}
// Begin with opaque white paper, including the credit beneath the black border.
const regions=new Map([['#FFFFFF',[[[[0,0],[1121.273,0],[1121.273,697.5],[0,697.5],[0,0]]]]]]);
for(const {color,polygons} of batches){
  const merged=clipping.union(...polygons);
  for(const [key,region] of regions)if(key!==color&&region.length)regions.set(key,clipping.difference(region,merged));
  regions.set(color,clipping.union(regions.get(color)||[],merged));
}
const positions=[],colorIndices=[],indices=[],palette=[],vertices=new Map();
for(const [fill,polygons] of regions){
  const color=new Color().setStyle(fill,SRGBColorSpace),colorIndex=palette.length;
  palette.push([color.r,color.g,color.b]);
  for(const polygon of polygons){
    const shape=new Shape();
    const trace=(path,r)=>{path.moveTo(...r[0]);for(const p of r.slice(1))path.lineTo(...p);};
    trace(shape,polygon[0]);
    for(const hole of polygon.slice(1)){const path=new Path();trace(path,hole);shape.holes.push(path);}
    const indexed=new ShapeGeometry(shape),geometry=indexed.toNonIndexed(),p=geometry.attributes.position;
    for(let i=0;i<p.count;i++){
      // UV origin in Three is bottom left; SVG's origin is top left.
      const x=Number((p.getX(i)/1121.273-.5).toFixed(9)),y=Number((.5-p.getY(i)/697.5).toFixed(9));
      const key=`${x},${y},${colorIndex}`;
      if(!vertices.has(key)){vertices.set(key,positions.length/2);positions.push(x,y);colorIndices.push(colorIndex);}
      indices.push(vertices.get(key));
    }
    indexed.dispose();geometry.dispose();
  }
}
const data={sourceSHA256:createHash('sha256').update(source).digest('hex'),width:1121.273,height:697.5,outlinedGlyphs,positions,colorIndices,palette,indices};
writeFileSync(new URL('../src/scene/iso-chart-geometry.json',import.meta.url),JSON.stringify(data));
console.log(`ISO chart: ${paths.length} paths, ${outlinedGlyphs} outlined glyphs, ${indices.length/3} triangles`);
