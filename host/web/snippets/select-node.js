(() => {
  const wanted = (window.__dsrCtx && window.__dsrCtx.nodeIdPath) || '';
  const items = [...document.querySelectorAll('.suggest-item')];
  let target = null;
  if (wanted) {
    target = items.find(el => {
      const path = el.getAttribute('data-node-path') || el.getAttribute('data-nodeidpath') || '';
      return path === wanted;
    });
    if (!target) target = items.find(el => el.innerText.trim().startsWith(wanted.split(':').slice(-1)[0]));
  }
  if (!target) target = items[0];
  if (!target) return 'NO_SUGGEST';
  target.click();
  return 'CLICKED:' + target.innerText.replace(/\s+/g, ' ').trim().slice(0, 120);
})()