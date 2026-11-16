(() => {
  // 目标：把站点切到土耳其（countryCode=TR / language=tr）。
  // 三种情况：
  //   1) 已经在正常页面 → 直接返回 already-ok
  //   2) 停在选国家页 → 点 Türkiye
  //   3) 找不到入口 → 返回 no-entry，由调用方报错（不猜、不绕）
  const onSelect = /select-country/i.test(location.href);

  const findCountry = () => {
    const nodes = [...document.querySelectorAll('a, button, div, span, li')];
    return nodes.find((el) => {
      const t = (el.innerText || '').trim();
      if (t !== 'Türkiye' && t !== 'Turkey') return false;
      // 排除巨大的容器（innerText 太长说明它包了很多东西）
      return t.length <= 10;
    }) || null;
  };

  if (!onSelect) {
    const cookie = (document.cookie.match(/(?:^|;\s*)countryCode=([^;]+)/) || [])[1];
    if (cookie && cookie !== 'TR') return JSON.stringify({ status: 'wrong-country', url: location.href });
    const hasNav = /Sepetim|Giriş Yap|Kategoriler|Favorilerim/.test(document.body.innerText || '');
    if (hasNav) return JSON.stringify({ status: 'already-ok', url: location.href });
    // 页面既不是选国家页、也没有导航：可能还没渲染完，交给调用方重试
    return JSON.stringify({ status: 'pending', url: location.href });
  }

  const el = findCountry();
  if (!el) return JSON.stringify({ status: 'no-entry', url: location.href });
  el.click();
  return JSON.stringify({ status: 'clicked', tag: el.tagName, url: location.href });
})()