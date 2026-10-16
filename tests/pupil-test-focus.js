// Visible preflight for native browser automation; an AX button press can run a
// background window without giving the web document keyboard focus.
const status=document.createElement('p');status.id='focusState';document.body.prepend(status);
const update=()=>{status.textContent=`测试焦点：${document.hasFocus()?'已获得':'未获得'}；页面${document.hidden?'后台':'可见'}。性能测试需要已获得焦点且可见。`;};
for(const type of ['focus','blur','visibilitychange'])window.addEventListener(type,update);
update();requestAnimationFrame(update);
