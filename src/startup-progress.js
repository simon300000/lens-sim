const loading=document.querySelector('#loading');
const message=document.querySelector('#loading-message');
const progress=document.querySelector('#loading-progress');
const detail=document.querySelector('#loading-detail');
const elapsed=document.querySelector('#loading-elapsed');
const started=performance.now();
const timer=setInterval(()=>{
  elapsed.textContent=`已用 ${Math.floor((performance.now()-started)/1000)} 秒`;
},1000);

// A single rAF runs before painting. The following task lets the updated loading
// curtain paint before synchronous scene construction or driver compilation.
const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
export const startup={
  async stage(completed,label){
    message.textContent=label;
    progress.value=completed;
    detail.textContent=`启动阶段 ${completed+1} / ${progress.max} · 当前阶段耗时取决于设备与编译缓存`;
    await paint();
  },
  complete(){
    clearInterval(timer);
    progress.value=progress.max;
    loading.setAttribute('aria-busy','false');
    loading.classList.add('complete');
  },
  fail(error){
    clearInterval(timer);
    message.textContent=error.message||String(error);
    detail.textContent='加载失败，请刷新页面重试';
    loading.setAttribute('aria-busy','false');
    loading.classList.add('error');
  },
};
