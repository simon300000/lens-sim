import { THREE, mat, mesh, makeBatch, rng, stoneGeometry } from './kit.js';

const smooth = (a,b,x) => { const t=Math.max(0,Math.min(1,(x-a)/(b-a))); return t*t*(3-2*t); };
const gaussian = (x,c,w) => Math.exp(-(((x-c)/w)**2));
const yAxis = new THREE.Vector3(0,1,0);

function terrainHeight(x,z) {
  const outside=smooth(24,46,Math.max(Math.abs(x)*.94,Math.abs(z)*1.08));
  const hills=1.8*Math.sin(x*.038+.8)*Math.cos(z*.047)+.65*Math.sin(x*.11-z*.045);
  const outer=.9+Math.max(-.7,hills)+1.3*gaussian(x,-40,24)*gaussian(z,-24,25);
  // The ground beneath the koi pond is deliberately well below the water.
  const pondDepression=(1-smooth(4.8,7.6,Math.hypot((x-6.8)*1.03,(z-7.7)*.84)))*1.35;
  return -.09+outside*outer-pondDepression;
}

const ranges = [
  { center:-57, spread:20, near:-33, far:-84, width:132,
    peaks:[[-92,12,23],[-62,20,18],[-32,17,17],[-9,13,20],[20,20,19],[53,27,19],[84,19,23]],
    low:'#687760', high:'#8c9582', rock:'#9b9c88' },
  { center:-90, spread:25, near:-60, far:-125, width:156,
    peaks:[[-123,19,23],[-88,24,22],[-57,31,21],[-22,23,20],[10,27,22],[45,32,21],[83,24,26],[119,21,22]],
    low:'#8e9d90', high:'#afbaad', rock:'#b1b8a9' },
  { center:-127, spread:31, near:-90, far:-172, width:198,
    peaks:[[-150,20,26],[-116,28,24],[-79,37,22],[-39,28,24],[1,34,23],[46,26,22],[89,35,26],[136,23,28]],
    low:'#adbab5', high:'#c8d1c8', rock:'#c4cdc3' },
];

function mountainHeight(range,x,z) {
  const ridge=range.peaks.reduce((sum,[cx,h,w])=>sum+h*gaussian(x,cx,w),0)*.48;
  const center=range.center+3.7*Math.sin(x*.048)+1.8*Math.sin(x*.11);
  const profile=gaussian(z,center,range.spread);
  const taper=smooth(range.near,range.near-8,z)*(1-smooth(range.far+8,range.far,z));
  const crags=(Math.sin(x*.27+z*.17)*.58+Math.sin(x*.53-z*.24)*.32+Math.cos(x*.13-z*.1)*.72)*profile;
  return Math.max(-.12,(ridge*profile+crags)*taper-.12);
}

function landscapeSurface(x,z) {
  return Math.max(terrainHeight(x,z), ...ranges.filter(r=>z<=r.near).map(r=>mountainHeight(r,x,z)));
}

function heightField(parent, bounds, nx, nz, getY, colorFor, name) {
  const positions=[], colors=[], indices=[];
  for(let iz=0;iz<=nz;iz++) for(let ix=0;ix<=nx;ix++) {
    const x=THREE.MathUtils.lerp(bounds[0],bounds[1],ix/nx);
    const z=THREE.MathUtils.lerp(bounds[2],bounds[3],iz/nz);
    const y=getY(x,z);
    positions.push(x,y,z);
    const c=colorFor(x,y,z); colors.push(c.r,c.g,c.b);
  }
  for(let iz=0;iz<nz;iz++) for(let ix=0;ix<nx;ix++) {
    const a=iz*(nx+1)+ix,b=a+1,c=a+nx+1,d=c+1;
    indices.push(a,c,b,b,c,d);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const surface=mesh(parent,geometry,mat('#ffffff',1,{vertexColors:true}),[0,0,0],[1,1,1],[0,0,0],false);
  surface.name=name; return surface;
}

function addSegment(records,a,b,radius,topScale=1) {
  const direction=new THREE.Vector3().subVectors(b,a), length=direction.length();
  const q=new THREE.Quaternion().setFromUnitVectors(yAxis,direction.normalize());
  records.push({p:a.clone().add(b).multiplyScalar(.5).toArray(),s:[radius,length,radius*topScale],q:q.toArray()});
}

function needleSprayGeometry() {
  // A small, folded fan of pointed needles gives each twig a visible foliage silhouette.
  const geometry=new THREE.BufferGeometry(),positions=[],indices=[],colors=[];
  for(let i=0;i<11;i++) {
    const a=(i-5)*.145,length=.52+.15*Math.cos(i*2.1),dx=Math.sin(a),dz=Math.cos(a);
    const bx=-Math.sin(a)*.05,bz=.035*Math.abs(i-5),width=.038+.012*Math.sin(i*1.8);
    const px=Math.cos(a)*width,pz=-Math.sin(a)*width;
    const k=positions.length/3,fold=.027+.025*Math.cos(i*1.7);
    positions.push(bx,0,bz,bx+dx*length*.4-px,fold*.3,bz+dz*length*.4-pz,
      bx+dx*length*.52,fold,bz+dz*length*.52,bx+dx*length,fold*.1,bz+dz*length,
      bx+dx*length*.4+px,fold*.3,bz+dz*length*.4+pz);
    indices.push(k,k+1,k+2,k+1,k+3,k+2,k+2,k+3,k+4,k,k+2,k+4);
    for(let v=0;v<5;v++){const shade=.84+v*.035+(i%3)*.035;colors.push(shade,shade,shade);}
  }
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
}

function irregularConiferTier() {
  const geometry=new THREE.ConeGeometry(1,1,13,5),positions=geometry.attributes.position;
  for(let i=0;i<positions.count;i++) {
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i),angle=Math.atan2(z,x);
    const radiusVariation=1+.13*Math.sin(angle*5+y*11)+.08*Math.cos(angle*9-y*14);
    positions.setXYZ(i,x*radiusVariation,y+Math.hypot(x,z)*.055*Math.sin(angle*7),z*radiusVariation);
  }
  geometry.computeVertexNormals();return geometry;
}

function woodland(parent) {
  const random=rng(1827), trunks=[], branches=[], needles=[[],[],[]], sprays=[[],[],[]], tufts=[[],[]], distantCanopies=[];
  const trunkColor=mat('#655849'), branchColor=mat('#635a49');
  const needleColors=['#294d34','#31573a','#3c6142'];
  const trunkGeo=new THREE.CylinderGeometry(.58,1,1,7);
  const branchGeo=new THREE.CylinderGeometry(.55,1,1,5);
  const needleGeo=new THREE.ConeGeometry(1,1,3,1);
  let detailedTrees=0;
  for(let i=0;i<55;i++) {
    const side=i%2===0?-1:1;
    const x=side*(19+random()*20),z=-9-random()*28;
    if(x>0 && z>-16) continue;
    const ground=landscapeSurface(x,z),height=5.1+random()*5.4, radius=1.3+random()*1.25;
    const treeHue=Math.floor(random()*3), lean=(random()-.5)*.2;
    const trunkTop=new THREE.Vector3(x+lean,ground+height,z);
    addSegment(trunks,new THREE.Vector3(x,ground,z),trunkTop,.1+height*.009);
    // Each tier contains woody arms, small side twigs and individually modelled needles.
    for(let tier=0;tier<7;tier++) {
      const t=tier/7, by=ground+height*(.25+.67*t), extent=radius*(1-t)*(.9+random()*.18);
      const count=6+(tier%2), phase=random()*Math.PI*2;
      tufts[tier%2].push({p:[x+lean*t*.7,by+extent*.08,z],s:[extent*.38,extent*.30,extent*.38],r:[.1,phase,0]});
      for(let k=0;k<count;k++) {
        const angle=phase+k/count*Math.PI*2,dx=Math.cos(angle),dz=Math.sin(angle);
        const origin=new THREE.Vector3(x+lean*t*.7,by,z), elbow=origin.clone().add(new THREE.Vector3(dx*extent*.57,-extent*.13,dz*extent*.57));
        const tip=origin.clone().add(new THREE.Vector3(dx*extent,extent*.07,dz*extent));
        addSegment(branches,origin,elbow,.029*(1-t)+.009);
        addSegment(branches,elbow,tip,.016*(1-t)+.004);
        // Compact, irregular needle masses support the tiny visible needles and sprays.
        for(let cluster=0;cluster<3;cluster++) {
          const fraction=.43+cluster*.265,p=origin.clone().lerp(tip,fraction);
          p.y+=extent*(.05+cluster*.025);
          const width=extent*(.32-cluster*.025),shade=.89+.09*Math.sin(angle*3+cluster);
          tufts[(k+cluster)%2].push({p:p.toArray(),s:[width,extent*.22,width*1.22],r:[.13*Math.sin(angle),angle,cluster*.09],c:new THREE.Color(shade,shade,shade)});
        }
        for(let n=0;n<10;n++) {
          const s=.18+n*.082;
          const sample=origin.clone().lerp(tip,s); sample.y-=Math.sin(s*Math.PI)*extent*.15;
          const twigLength=(.19+.29*(1-s))*(1-t*.4);
          for(const sign of [-1,1]) {
            const sideAngle=angle+sign*(.72+random()*.14),sx=Math.cos(sideAngle),sz=Math.sin(sideAngle);
            const twigEnd=sample.clone().add(new THREE.Vector3(sx*twigLength,.05+twigLength*.12,sz*twigLength));
            if(n%2===0)addSegment(branches,sample,twigEnd,.0046);
            for(let needle=0;needle<3;needle++) {
              const np=sample.clone().lerp(twigEnd,.22+needle*.3);
              const na=sideAngle+sign*(needle-1)*.47;
              const dir=new THREE.Vector3(Math.cos(na),.28+random()*.28,Math.sin(na)).normalize();
              const length=(.31+random()*.26)*(1-t*.35);
              const q=new THREE.Quaternion().setFromUnitVectors(yAxis,dir);
              needles[(treeHue+(needle===2?1:0))%3].push({p:np.addScaledVector(dir,length*.5).toArray(),s:[.056,length,.037],q:q.toArray()});
            }
            if(n===3 || n===6 || n===9) {
              const dir=new THREE.Vector3(sx,.14+Math.sin(n+angle)*.13,sz).normalize();
              const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),dir);
              const size=.82-t*.30;
              sprays[(treeHue+n)%3].push({p:sample.clone().lerp(twigEnd,.35).toArray(),s:[size,.85,size*1.1],q:q.toArray()});
            }
          }
        }
      }
    }
    detailedTrees++;
  }
  makeBatch(parent,trunkGeo,trunkColor,trunks);
  makeBatch(parent,branchGeo,branchColor,branches,{shadow:false});
  tufts.forEach((records,i)=>makeBatch(parent,stoneGeometry(914+i*37,1),mat('#294d34',.95),records,{shadow:false}));
  needles.forEach((records,i)=>makeBatch(parent,needleGeo,mat(needleColors[i],.96),records,{shadow:false}));
  const sprayGeometry=needleSprayGeometry();
  sprays.forEach((records,i)=>makeBatch(parent,sprayGeometry,mat(needleColors[i],.94,{side:THREE.DoubleSide,vertexColors:true}),records,{shadow:false}));

  const farTrunks=[];
  // Small forest silhouettes continue up the hills; these resolve as tiered branches at their distance.
  for(let i=0;i<100;i++) {
    const cluster=[[-47,-39],[-19,-44],[23,-38],[54,-43]][i%4];
    const x=cluster[0]+(random()-.5)*25,z=cluster[1]+(random()-.5)*14;
    const ground=landscapeSurface(x,z),height=2.9+random()*3.9;
    farTrunks.push({p:[x,ground+height*.44,z],s:[.08,height*.9,.08]});
    const hue=new THREE.Color('#35533c').multiplyScalar(.78+random()*.27);
    for(let tier=0;tier<4;tier++) {
      const t=tier/4,r=(.85+height*.09)*(1-t);
      distantCanopies.push({p:[x,ground+height*(.32+t*.50),z],s:[r,height*.42,r],r:[0,random()*Math.PI*2,0],c:hue});
    }
  }
  makeBatch(parent,trunkGeo,mat('#7c8270'),farTrunks,{shadow:false});
  makeBatch(parent,irregularConiferTier(),mat('#ffffff',.95),distantCanopies,{shadow:false});
  return {detailedTrees,distantTrees:100,needles:needles.reduce((sum,v)=>sum+v.length,0),needleSprays:sprays.reduce((sum,v)=>sum+v.length,0),needleTufts:tufts.reduce((sum,v)=>sum+v.length,0)};
}

export function buildLandscape(scene, pondOutline=[]) {
  const root=new THREE.Group(); root.name='Procedural mountains, meadow and woodland';scene.add(root);
  const random=rng(633), meadowDark=new THREE.Color('#596f44'),meadowLight=new THREE.Color('#7b8b5b');
  heightField(root,[-210,210,-200,165],150,130,terrainHeight,(x,y,z)=>{
    const noise=.42+.18*Math.sin(x*.09+z*.12)+.1*Math.sin(x*.31-z*.16);
    return meadowDark.clone().lerp(meadowLight,noise);
  },'Continuous rolling meadow');

  // A single earth surface with an actual opening, rather than water drawn on opaque grass.
  const outline=[];
  for(let i=0;i<48;i++) {
    const angle=i/48*Math.PI*2,variation=1+.035*Math.sin(angle*5)+.024*Math.cos(angle*7);
    outline.push([Math.cos(angle)*28.5*variation,Math.sin(angle)*26.5*variation]);
  }
  const shape=new THREE.Shape();outline.forEach(([x,z],i)=>i?shape.lineTo(x,-z):shape.moveTo(x,-z));shape.closePath();
  if(pondOutline.length>2) {
    const hole=new THREE.Path();
    pondOutline.forEach((p,i)=>{
      const x=Array.isArray(p)?p[0]:p.x, z=Array.isArray(p)?p[p.length-1]:p.z;
      if(i)hole.lineTo(x,-z);else hole.moveTo(x,-z);
    });hole.closePath();shape.holes.push(hole);
  }
  const grassGeometry=new THREE.ShapeGeometry(shape,1),grassColors=[],positions=grassGeometry.attributes.position;
  const grassA=new THREE.Color('#586f40'),grassB=new THREE.Color('#708447');
  for(let i=0;i<positions.count;i++) {
    const x=positions.getX(i),z=-positions.getY(i),mix=.36+.14*Math.sin(x*.19+z*.16);
    const c=grassA.clone().lerp(grassB,mix);grassColors.push(c.r,c.g,c.b);
  }
  grassGeometry.setAttribute('color',new THREE.Float32BufferAttribute(grassColors,3));
  const garden=mesh(root,grassGeometry,mat('#ffffff',.96,{vertexColors:true}),[0,.015,0],[1,1,1],[-Math.PI/2,0,0],false);
  garden.name='Meadow garden with koi pond opening';

  ranges.forEach((range,index)=>{
    const low=new THREE.Color(range.low),high=new THREE.Color(range.high),rock=new THREE.Color(range.rock);
    heightField(root,[-range.width,range.width,range.far,range.near],150,46,(x,z)=>mountainHeight(range,x,z),(x,y,z)=>{
      const altitude=Math.min(1,y/30),bands=.07*Math.sin(x*.17+z*.23),c=low.clone().lerp(high,Math.max(0,altitude*.6+bands));
      const slope=Math.abs(mountainHeight(range,x+.5,z)-mountainHeight(range,x-.5,z));
      if(slope>.6)c.lerp(rock,Math.min(.5,(slope-.6)*.17));return c;
    },`Atmospheric mountain ridge ${index+1}`);
  });

  const rocks=[];
  for(let i=0;i<44;i++) {
    const side=i%2?-1:1,x=side*(23+random()*27),z=-17-random()*21;
    const s=.45+random()*1.6;
    rocks.push({p:[x,landscapeSurface(x,z)+s*.32,z],s:[s,s*.55,s*(.75+random()*.6)],r:[random()*.4,random()*6.28,random()*.3],c:new THREE.Color().setHSL(.13,.07,.39+random()*.12)});
  }
  makeBatch(root,stoneGeometry(831,1),mat('#ffffff'),rocks);
  const forest=woodland(root);
  return {root, meadow:garden, metadata:{...forest,mountainRanges:ranges.length,pondHole:pondOutline.length>2,procedural:true}};
}
