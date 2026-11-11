(() => {
  const btn = [...document.querySelectorAll('button')].find(e => e.innerText && e.innerText.trim() === '筛选市场');
  if (!btn) return 'NO_BTN';
  btn.click();
  return 'OK';
})()