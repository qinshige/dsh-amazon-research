(() => {
  const kw = (window.__dsrCtx && window.__dsrCtx.keyword) || '';
  const inp = [...document.querySelectorAll('input')].find(el => (el.placeholder || '').includes('类目关键词'));
  if (!inp) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, kw);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('keyup', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return 'OK';
})()