(() => {
  const url = location.href;
  const text = document.body ? document.body.innerText : '';
  const title = document.title || '';
  const head = title + '\n' + text.slice(0, 1500);
  const captcha = /verify (?:you are|that you are)|are you a robot|insan olduğunuzu|güvenlik doğrulaması|just a moment|attention required|captcha/i.test(head);
  const rateLimited = /too many requests|rate limit|çok fazla istek|istek sınır|(?:http|status|error)\s*:?\s*429\b|^429\s*$/i.test(head);
  const accessDenied = /access denied|access forbidden|erişim engellendi|erişiminiz engellendi/i.test(head);
  let storefront = null;
  // Hydration removes globals; parse the already-loaded JSON, never execute page scripts.
  try {
    const s = Array.from(document.scripts || []).find(s => s.textContent.startsWith('window["__navigation__PROPS"]='));
    if (s) storefront = JSON.parse(s.textContent.slice(s.textContent.indexOf('=') + 1).replace(/;\s*$/, '')).context?.storefront;
  } catch {}
  const cookieCountry = (String(document.cookie || '').match(/(?:^|;\s*)countryCode=([^;]+)/) || [])[1];
  const country = storefront?.code || cookieCountry || null;
  const wanted = typeof expectedCountry === 'string' ? expectedCountry : 'TR';
  const origin = typeof expectedOrigin === 'string' ? expectedOrigin : 'https://www.trendyol.com';
  const currency = storefront?.currency || null;
  const wrongOrigin = !(url === origin || url.startsWith(origin + '/'));
  const wrongCountry = Boolean((country && country !== wanted) || (cookieCountry && cookieCountry !== wanted));
  const wrongCurrency = Boolean(currency && typeof expectedCurrency === 'string' && currency !== expectedCurrency);
  return JSON.stringify({ url, title, len:text.length, country, currency, language:storefront?.language || null,
    wrongCountry, wrongOrigin, wrongCurrency, countryUnknown:!country, currencyUnknown:wanted === 'SA' && !currency,
    countrySelect:/select-country/i.test(url), captcha, rateLimited, accessDenied,
    empty:text.length < 120, noResults:/sonuç bulunamadı|ürün bulunamadı|no results found|no products found/i.test(text) });
})()
