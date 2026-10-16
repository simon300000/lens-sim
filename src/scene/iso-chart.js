import {BufferGeometry,Float32BufferAttribute,Uint32BufferAttribute} from 'three/webgpu';
import data from './iso-chart-geometry.json' with {type:'json'};

export const ISO_CHART_ASPECT=data.width/data.height;
export function createISOChartGeometry(width){
  const height=width/ISO_CHART_ASPECT,n=data.positions.length/2;
  const positions=new Float32Array(n*3),uvs=new Float32Array(n*2),normals=new Float32Array(n*3),colors=new Float32Array(n*3);
  for(let i=0;i<n;i++){
    const x=data.positions[i*2],y=data.positions[i*2+1];
    positions[i*3]=x*width;positions[i*3+1]=y*height;
    colors.set(data.palette[data.colorIndices[i]],i*3);normals[i*3+2]=1;uvs[i*2]=x+.5;uvs[i*2+1]=y+.5;
  }
  const indices=new Uint32Array(data.indices);
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i],b=indices[i+1],c=indices[i+2];
    const cross=(positions[b*3]-positions[a*3])*(positions[c*3+1]-positions[a*3+1])-(positions[b*3+1]-positions[a*3+1])*(positions[c*3]-positions[a*3]);
    if(cross<0){indices[i+1]=c;indices[i+2]=b;}
  }
  return new BufferGeometry().setAttribute('position',new Float32BufferAttribute(positions,3))
    .setAttribute('normal',new Float32BufferAttribute(normals,3))
    .setAttribute('uv',new Float32BufferAttribute(uvs,2))
    .setAttribute('color',new Float32BufferAttribute(colors,3)).setIndex(new Uint32BufferAttribute(indices,1));
}
