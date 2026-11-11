(() => {
  const ctx = window.__dsrCtx || {};
  window.__dsrCtx = ctx;
  return JSON.stringify({ ok: true, keys: Object.keys(ctx) });
})()