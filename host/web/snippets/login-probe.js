(() => {
  const t = document.body.innerText;
  return JSON.stringify({ url: location.href, title: document.title, len: t.length, hasLogin: /账号登录|立即登录/.test(t.slice(0, 1200)) });
})()