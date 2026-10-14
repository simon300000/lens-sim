import { THREE, mat, makeBatch, leafGeometry, stoneGeometry, rng } from './kit.js';

// All plants are modelled geometry. No texture, alpha card, or downloaded asset.
export function buildVegetation(scene) {
  const garden = new THREE.Group(); garden.name = 'Individually modelled garden planting'; scene.add(garden);
  const random = rng(710213);
  const next = (a,b) => a + random() * (b-a);
  const tau = Math.PI * 2;
  const brown = mat('#685042', .96);
  const twig = mat('#776348', .97);
  const green = mat('#ffffff', .83, { side: THREE.DoubleSide });
  const pale = mat('#ffffff', .77, { side: THREE.DoubleSide });
  const grassMaterial = mat('#ffffff', .94, { side: THREE.DoubleSide });
  const stemMaterial = mat('#547345', .95);
  const petalMaterial = mat('#ffffff', .72, { side: THREE.DoubleSide });
  const leaves = [[], [], [], []];
  const branches = [], twigs = [], grass = [], flowers = [], stems = [], flowerLeaves = [], centers = [];
  const stones = [], moss = [], fernLeaves = [], fernStems = [], shrubLeaves = [], bambooLeaves = [];
  const up = new THREE.Vector3(0, 1, 0);
  const leaf = leafGeometry();
  const woodGeometry = new THREE.CylinderGeometry(.72, 1, 1, 7);
  const thinGeometry = new THREE.CylinderGeometry(.55, 1, 1, 5);
  const rodGeometry = new THREE.CylinderGeometry(.85, 1, 1, 5);

  function addBeam(list, a, b, radius, color) {
    const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), d = bv.clone().sub(av);
    if (d.lengthSq() < .00001) return;
    list.push({ p: av.add(bv).multiplyScalar(.5).toArray(), s: [radius, d.length(), radius],
      q: new THREE.Quaternion().setFromUnitVectors(up, d.normalize()).toArray(), c: color || '#ffffff' });
  }
  function leafAt(list, x,y,z, size, color, angle=next(0,tau), pitch=next(-.65,.65), width=1) {
    if ((list===shrubLeaves||list===fernLeaves||list===flowerLeaves) &&
      (!clearPond(x,z,.12)||!clearPond(x+Math.sin(angle)*size,z+Math.cos(angle)*size,.12))) return;
    list.push({p:[x,y,z],s:[size*width,size,size],r:[pitch,angle,next(-.4,.4)],c:color});
  }
  const broadColors = ['#335e35','#416b39','#50763e','#5b7f43','#69894a','#77914e'];
  const mapleColors = ['#426539','#527641','#658349','#728c4b','#849550','#9a9452'];
  const pineColors = ['#345940','#43694a','#537249','#5e7d4e'];
  function colorFrom(palette) { return palette[Math.floor(random()*palette.length)]; }

  function palmMapleGeometry() {
    // Serrated palmate leaves with five pointed lobes and a raised central vein.
    const outline = [ [0,0],[-.12,.13],[-.34,.16],[-.24,.27],[-.51,.38],[-.28,.39],
      [-.4,.61],[-.18,.52],[-.18,.79],[-.07,.66],[0,1],[.07,.66],[.18,.79],[.18,.52],
      [.4,.61],[.28,.39],[.51,.38],[.24,.27],[.34,.16],[.12,.13] ];
    const vertices = [0,.055,.4];
    for (const [x,z] of outline) vertices.push(x, .006+Math.sin(z*Math.PI)*.026, z);
    const indices=[]; for(let i=0;i<outline.length;i++) indices.push(0,i+1,(i+1)%outline.length+1);
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    g.setIndex(indices);g.computeVertexNormals();return g;
  }
  const mapleLeaf = palmMapleGeometry();

  function tree(x,z,height,spread,type,leafCount) {
    const base = [x,.055,z], top=[x+next(-.17,.17),height*.58,z+next(-.1,.1)];
    addBeam(branches,base,top,height*.044);
    // Sculptural roots emerge from the mulch, each with a distinct direction.
    for(let i=0;i<7;i++) {const a=i/7*tau+next(-.2,.2),r=height*.12;
      addBeam(branches,[x,.13,z],[x+Math.cos(a)*r,.045,z+Math.sin(a)*r],height*.015);}
    const palette = type===1 ? mapleColors : type===2 ? pineColors : broadColors;
    const hubs = [];
    for(let i=0;i<10;i++) {
      const angle = i/10*tau + next(-.23,.23), reach=spread*next(.6,1), lift=next(.3,.95);
      const a=[x+next(-.07,.07),height*next(.32,.59),z+next(-.08,.08)];
      const b=[x+Math.cos(angle)*reach*.63,height*(.66+lift*.12),z+Math.sin(angle)*reach*.63];
      const c=[x+Math.cos(angle)*reach,height*(.73+lift*.16),z+Math.sin(angle)*reach];
      addBeam(branches,a,b,height*next(.012,.021)); addBeam(branches,b,c,height*.008);
      for(let j=0;j<4;j++) {
        const aa=angle+next(-1.0,1.0), end=[c[0]+Math.cos(aa)*spread*.27,
          c[1]+next(-.18,.52),c[2]+Math.sin(aa)*spread*.27];
        addBeam(twigs,b,end,height*.0032); hubs.push(end);
      }
    }
    // Inner crown shoots join the leaf sprays into an airy, continuous canopy.
    // Each leaf remains an independent folded mesh, including in the crown core.
    for(let i=0;i<9;i++) {
      const a=i/9*tau, r=spread*next(.12,.42);
      const h=[x+Math.cos(a)*r,height*next(.75,.91),z+Math.sin(a)*r];
      addBeam(twigs,top,h,height*.0023); hubs.push(h);
    }
    hubs.push([x,height*.93,z]);
    for(let n=0;n<leafCount;n++) {
      const h=hubs[n%hubs.length], a=next(0,tau), r=Math.sqrt(random())*spread*.33,
        y=h[1]+next(-.55,.58), xx=h[0]+Math.cos(a)*r,zz=h[2]+Math.sin(a)*r;
      const size=type===1?next(.208,.299):type===2?next(.17,.26):next(.247,.39);
      leafAt(leaves[type],xx,y,zz,size,colorFrom(palette),a,next(-.45,.5),type===2?.42:1);
    }
    // Small twigs at the visible perimeter keep the crowns connected to the wood.
    for(const h of hubs) for(let j=0;j<3;j++) {
      const a=next(0,tau),b=[h[0]+Math.cos(a)*.32,h[1]+next(-.08,.18),h[2]+Math.sin(a)*.32];
      addBeam(twigs,h,b,height*.0013);
    }
  }
  tree(-12.7,.5,6.7,2.7,0,3300);
  tree(-11.9,11.4,4.85,2.25,1,2900);
  tree(13.4,2.25,7.3,2.5,0,3600);
  tree(17.5,11.8,5.3,2.1,1,3000);
  tree(-14,-5,6.7,2.1,2,2200);
  tree(6.0,-4.7,5.8,1.8,0,2500);

  function clearPond(x,z,pad=0) {return ((x-6.8)/(3.8+pad))**2+((z-7.7)/(4.5+pad))**2>=1;}
  function pathX(z) { return -2.2+1.8*Math.sin(z*.27); }
  function clearLawn(x,z) {
    return clearPond(x,z,.12)&&!(x>-10.2&&x<4.2&&z<1.75)&&
      Math.abs(x-pathX(z))>.61&&Math.hypot(x+5.8,z-4.7)>2.25;
  }
  function bedSpot(x,z) {
    return clearPond(x,z,.12)&&!(x>-10.2&&x<4.2&&z<1.6)&&
      Math.abs(x-pathX(z))>.8&&Math.hypot(x+5.8,z-4.7)>2.35;
  }

  function bladeGeometry() {
    const g=new THREE.BufferGeometry();
    const v=[-.5,0,0, .5,0,0, -.32,.43,.11,.32,.43,.11,-.15,.79,.36,.15,.79,.36,0,1,.58];
    g.setAttribute('position',new THREE.Float32BufferAttribute(v,3));g.setIndex([0,1,2,1,3,2,2,3,4,3,5,4,4,5,6]);
    g.computeVertexNormals();return g;
  }
  const blade=bladeGeometry();
  const grassColors=['#628544','#72904b','#7b984f','#5c7e3c','#8c9e58','#6b8d48'];
  let attempts=0;
  while(grass.length<34000&&attempts++<160000) {
    let x=next(-17,19),z=next(1.8,18);
    if(!clearLawn(x,z))continue;
    const nx=(x-.6)/16.2,nz=(z-7.7)/9.3,angle=Math.atan2(nz,nx);
    const contour=1+.04*Math.sin(angle*3+.8)+.022*Math.cos(angle*7);
    const radial=Math.hypot(nx,nz)/contour;
    const feather=Math.max(0,Math.min(1,(1-radial)/.2));
    const lawnRadius=Math.hypot((x+3)/7,(z-7.6)/6.4);
    const lawnWeight=Math.max(0,Math.min(1,(1.15-lawnRadius)*2.8));
    const naturalDensity=.48+.15*Math.sin(x*.51+z*.39)+.08*Math.cos(z*.9-x*.21);
    if(random()>feather*(naturalDensity*(1-lawnWeight)+.98*lawnWeight))continue;
    const height=next(.1,.25)*(1-lawnWeight)+next(.07,.17)*lawnWeight;
    grass.push({p:[x,.055,z],s:[next(.012,.025),height,next(.06,.15)],r:[0,next(0,tau),next(-.12,.12)],c:colorFrom(grassColors)});
  }

  function shrub(x,z,radius,height,count,palette=broadColors) {
    if(!bedSpot(x,z))return;
    for(let j=0;j<7;j++) {
      const a=j/7*tau, end=[x+Math.cos(a)*radius*.45,.05+height*.72,z+Math.sin(a)*radius*.45];
      addBeam(twigs,[x,.04,z],end,.017);
      for(let k=0;k<3;k++) {const b=[end[0]+next(-.28,.28),end[1]+next(.02,.2),end[2]+next(-.28,.28)];addBeam(twigs,end,b,.007);}
    }
    for(let i=0;i<count;i++) {
      const a=next(0,tau), r=Math.sqrt(random())*radius, hh=Math.sqrt(Math.max(0,1-(r/radius)**2));
      const y=.12+height*(.45+hh*.55)*next(.73,1.06);
      leafAt(shrubLeaves,x+Math.cos(a)*r,y,z+Math.sin(a)*r,next(.095,.18),colorFrom(palette),a,next(-.7,.7));
    }
  }
  const shrubs=[[-10.1,2.7,.7,.7],[-13.6,3.8,.9,.9],[-11.7,7.6,.88,.87],[-10.8,13.0,.9,.7],
    [-7.8,13.9,.75,.65],[1.3,14.3,.72,.73],[4.3,14.7,.72,.65],[9.8,13.6,.67,.72],
    [13.7,8.0,.82,1],[14,5.6,.65,.76],[9.7,2.1,.67,.68],[5.8,1.4,.53,.6],
    [2.5,4.0,.6,.55],[3.1,11.9,.46,.62]];
  for(const [x,z,r,h]of shrubs)shrub(x,z,r,h,260);

  // Hostas and broad ornamental foliage beside the stones, distinct from shrubs.
  const hostaLocations=[[-10.2,5.1],[-10.1,9.4],[2.7,5.3],[3.05,10.5],[11.1,4.0],[11.6,10.2],[-7.1,13.5],[7.0,13.2]];
  for(const[x,z]of hostaLocations)for(let j=0;j<24;j++) {
    const a=j/24*tau,r=next(.05,.22),size=next(.47,.74);
    leafAt(shrubLeaves,x+Math.sin(a)*r,.09+next(.02,.15),z+Math.cos(a)*r,size,
      colorFrom(['#5a774c','#738a51','#8c9b62','#658354']),a,next(-.46,-.16),1.2);
  }

  function fern(x,z,scale=1) {
    if(!bedSpot(x,z))return;
    for(let f=0;f<9;f++) {
      const a=f/9*tau+next(-.13,.13),length=next(.65,1)*scale;
      if(!clearPond(x+Math.sin(a)*length*.78,z+Math.cos(a)*length*.78,.28))continue;
      let prev=[x,.055,z];
      for(let k=1;k<=11;k++) {
        const t=k/11,r=length*t*.78,y=.08+Math.sin(t*Math.PI*.76)*length*.55;
        const p=[x+Math.sin(a)*r,y,z+Math.cos(a)*r]; addBeam(fernStems,prev,p,.005*scale);prev=p;
        const size=(.12+Math.sin(t*Math.PI)*.14)*scale;
        for(const side of[-1,1])leafAt(fernLeaves,p[0],p[1],p[2],size,
          colorFrom(['#4d733e','#658548','#7c9554']),a+side*1.17,-.2,.57);
      }
    }
  }
  const fernLocations=[[-12.3,2.5],[-12.1,5.5],[-10.5,7.9],[-9.6,12.5],[-8.3,14.5],
    [2.6,3.0],[2.8,6.8],[3.3,12.8],[4.2,13.0],[10.7,3.1],[11.8,6.1],[11.4,11.2],[13.8,11.5]];
  for(const [x,z]of fernLocations)fern(x,z,next(.72,1.22));

  function petalGeometry() {
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute([
      0,0,0,-.32,.05,.32,0,.1,.4,.32,.05,.32,-.3,.02,.72,0,.07,.88,.3,.02,.72,0,-.01,1],3));
    g.setIndex([0,1,2,0,2,3,1,4,5,1,5,2,2,5,6,2,6,3,4,7,5,5,7,6]);g.computeVertexNormals();return g;
  }
  const petal=petalGeometry();
  const patches=[
    {x:-10.3,z:3.5,rx:.7,rz:1.0,c:['#f8ecde','#e9e1c9'],n:230,h:.28},
    {x:-9.9,z:8.0,rx:.72,rz:1.6,c:['#c3b7ce','#e5d0df','#aeb9c8'],n:260,h:.36},
    {x:-7.4,z:12.4,rx:1.1,rz:.62,c:['#f2d4c3','#e7b7a1','#f1dfc8'],n:260,h:.24},
    {x:1.5,z:13.4,rx:1.2,rz:.63,c:['#fbefd8','#e3dec1'],n:300,h:.25},
    {x:2.65,z:3.0,rx:.8,rz:.68,c:['#e7bfab','#f5dacc'],n:190,h:.32},
    {x:2.7,z:10.8,rx:.57,rz:1.1,c:['#b4b7cf','#d0c3dc','#e7d9df'],n:220,h:.39},
    {x:11.5,z:6.9,rx:.55,rz:1.5,c:['#fbefd9','#efdfbe'],n:240,h:.28},
    {x:9.7,z:12.55,rx:1,rz:.68,c:['#f0d2c7','#f9e8db','#dea797'],n:220,h:.3},
    {x:7.2,z:2.6,rx:1.2,rz:.55,c:['#c4bfd2','#e1d8e4'],n:240,h:.31},
  ];
  let flowerCount=0;
  for(const patch of patches) {
    for(let i=0;i<patch.n;i++) {
      const a=next(0,tau),r=Math.sqrt(random()),x=patch.x+Math.sin(a)*r*patch.rx,
        z=patch.z+Math.cos(a)*r*patch.rz;
      if(!bedSpot(x,z))continue;
      const h=patch.h*next(.7,1.3),xx=x+next(-.035,.035),zz=z+next(-.035,.035);
      addBeam(stems,[x,.055,z],[xx,h,zz],.0035);
      const petals=5+(i%3===0?1:0),size=next(.025,.042),color=colorFrom(patch.c),spin=next(0,tau);
      for(let j=0;j<petals;j++) flowers.push({p:[xx,h,zz],s:[size*1.1,size,size],r:[next(-.04,.16),spin+j/petals*tau,0],c:color});
      centers.push({p:[xx,h+.006,zz],s:[size*.2,size*.15,size*.2],c:colorFrom(['#c8a655','#b79b51','#dcc17b'])});
      for(let j=0;j<2;j++)leafAt(flowerLeaves,x,h*(.28+j*.24),z,next(.038,.07),colorFrom(['#5b8045','#6c8b4e']),spin+j*2.3,-.24,.72);
      flowerCount++;
    }
  }

  // Tall ornamental grass has long separate blades and seed heads at the edges.
  for(const[x,z]of [[-12.5,9.3],[-10.3,14.1],[12.4,4.2],[11.7,12.1],[4.4,2.1]]) {
    for(let j=0;j<85;j++) {
      const a=next(0,tau),r=next(0,.32),h=next(.44,.88);
      grass.push({p:[x+Math.sin(a)*r,.06,z+Math.cos(a)*r],s:[next(.014,.026),h,.25],r:[0,a,next(-.2,.2)],c:colorFrom(['#75834a','#8d9456','#a4a06b'])});
    }
    for(let j=0;j<9;j++) {
      const a=next(0,tau),xx=x+Math.sin(a)*.25,zz=z+Math.cos(a)*.25,h=next(.8,1.16);
      addBeam(stems,[xx,.06,zz],[xx+.05,h,zz],.004);
      for(let k=0;k<13;k++)leafAt(fernLeaves,xx+.05,h-k*.009,zz,.045,'#c1b890',a+k*.6,-.55,.65);
    }
  }

  // A contained grove at the outer right rear provides finer vertical silhouettes.
  for(let i=0;i<24;i++) {
    const x=next(10.8,14.8),z=next(-4.7,-1.0),h=next(2.7,4.5);
    addBeam(branches,[x,.055,z],[x,h,z],next(.026,.041),'#839260');
    for(let j=1;j<9;j++) {
      const y=h*j/10,a=next(0,tau),end=[x+Math.sin(a)*.45,y+.2,z+Math.cos(a)*.45];
      addBeam(twigs,[x,y,z],end,.008,'#899c69');
      for(let k=0;k<10;k++)leafAt(bambooLeaves,end[0]+next(-.18,.18),end[1]+next(-.1,.12),end[2]+next(-.18,.18),next(.19,.34),colorFrom(['#62804b','#789452','#8ba35b']),a+next(-.5,.5),next(-.9,.1),.35);
    }
  }

  // Low natural stones, nestled in the planting, carry little cushions of moss.
  for(const [x,z,s]of [[-10.7,5.7,.45],[-11.0,8.8,.6],[-9.6,12.2,.34],[2.6,4.5,.35],
    [2.8,10.6,.4],[11.4,3.5,.65],[12.0,8.7,.48],[10.7,12.6,.58],[-13.3,2.3,.55]]) {
    stones.push({p:[x,.17,z],s:[s,.31+s*.17,s*.78],r:[next(-.2,.2),next(0,tau),next(-.1,.1)],c:colorFrom(['#999a81','#8a927a','#b1af94','#737d6c'])});
    for(let j=0;j<12;j++) {
      const a=next(0,tau),r=Math.sqrt(random())*s*.53;
      moss.push({p:[x+Math.sin(a)*r,.34+s*.17,z+Math.cos(a)*r],s:[.065,.025,.05],r:[0,a,0],c:colorFrom(['#637746','#778347','#88925a'])});
    }
  }

  makeBatch(garden,woodGeometry,brown,branches);
  makeBatch(garden,thinGeometry,twig,twigs);
  makeBatch(garden,leaf,green,leaves[0]);
  makeBatch(garden,mapleLeaf,pale,leaves[1]);
  makeBatch(garden,leaf,green,leaves[2]);
  makeBatch(garden,leaf,green,shrubLeaves);
  makeBatch(garden,leaf,green,fernLeaves);
  makeBatch(garden,rodGeometry,stemMaterial,fernStems);
  makeBatch(garden,leaf,green,bambooLeaves);
  makeBatch(garden,blade,grassMaterial,grass,{shadow:false});
  makeBatch(garden,rodGeometry,stemMaterial,stems,{shadow:false});
  makeBatch(garden,leaf,green,flowerLeaves,{shadow:false});
  makeBatch(garden,petal,petalMaterial,flowers,{shadow:false});
  makeBatch(garden,new THREE.IcosahedronGeometry(1,0),mat('#ffffff',.95),centers,{shadow:false});
  makeBatch(garden,stoneGeometry(721,1),mat('#ffffff',.98),stones);
  makeBatch(garden,new THREE.IcosahedronGeometry(1,0),mat('#ffffff',.99),moss,{shadow:false});
  const metadata={trees:6,bamboo:24,shrubs:shrubs.length,ferns:fernLocations.length,flowers:flowerCount,
    grassBlades:grass.length,leaves:leaves.reduce((n,a)=>n+a.length,0)+shrubLeaves.length+fernLeaves.length+bambooLeaves.length+flowerLeaves.length,
    botanicalDrawCalls:garden.children.length};
  garden.userData=metadata;
  return metadata;
}
