import {PointLight,DirectionalLight,PointLightNode,DirectionalLightNode} from 'three/webgpu';
import {If,Fn,vec3} from 'three/tsl';

/** Keep one light layout across day/night, but skip shadow taps
 * when a light's uniform radiance is zero. Removing lights would compile new
 * material variants at every sunrise/sunset. The branch is uniform per draw. */
export function installActiveLightNodes(renderer){
  const library=renderer.library,previous=[];
  for(const [lightClass,Base] of [[PointLight,PointLightNode],[DirectionalLight,DirectionalLightNode]]){
    const Original=library.getLightNodeClass(lightClass);
    if(Original!==Base)throw new Error('Active-light optimization requires the standard Three light library');
    class ActiveLightNode extends Base{
      setupShadow(builder){
        super.setupShadow(builder);
        if(!this.baseColorNode||!this.shadowColorNode)return;
        const radiance=this.baseColorNode,shadowed=this.colorNode;
        this.colorNode=Fn(()=>{
          const color=vec3(0).toVar();
          If(radiance.dot(radiance).greaterThan(0),()=>color.assign(shadowed));
          return color;
        })();
      }
    }
    previous.push([lightClass,Original]);library.lightNodes.delete(lightClass);library.addLight(ActiveLightNode,lightClass);
  }
  return ()=>{for(const [lightClass,Original] of previous){library.lightNodes.delete(lightClass);library.addLight(Original,lightClass);}};
}
