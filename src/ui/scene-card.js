/** Garden card chrome: collapse and the camera-help popover. Per-viewer state only (localStorage, guarded). */
export function installSceneCard(doc = document) {
  const card = doc.querySelector('#scene-card');
  if (!card) return () => {};
  const body = card.querySelector('#scene-card-body');
  const collapse = card.querySelector('.scene-card-collapse');
  const help = card.querySelector('.scene-card-help');
  const hints = card.querySelector('#camera-hints');
  const key = 'scene-card:open';
  const read = () => { try { return doc.defaultView.localStorage.getItem(key); } catch { return null; } };
  const setOpen = (open, remember) => {
    body.hidden = !open;
    collapse.setAttribute('aria-expanded', String(open));
    collapse.setAttribute('aria-label', open ? '收起庭院面板' : '展开庭院面板');
    collapse.title = open ? '收起' : '展开';
    if (remember) { try { doc.defaultView.localStorage.setItem(key, String(open)); } catch { /* storage unavailable */ } }
  };
  const narrow = doc.defaultView.matchMedia?.('(max-width: 700px)').matches;
  setOpen(read() === null ? !narrow : read() === 'true', false);
  const onCollapse = () => setOpen(body.hidden, true);
  const onHelp = () => {
    const show = hints.hidden;
    if (show && body.hidden) setOpen(true, false);
    hints.hidden = !show;
    help.setAttribute('aria-expanded', String(show));
  };
  collapse.addEventListener('click', onCollapse);
  help.addEventListener('click', onHelp);
  return () => { collapse.removeEventListener('click', onCollapse); help.removeEventListener('click', onHelp); };
}
