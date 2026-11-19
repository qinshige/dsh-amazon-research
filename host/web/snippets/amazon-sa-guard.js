(() => {
  const text = String((document.body && document.body.innerText) || '').slice(0, 6000);
  const clean = text.replace(/\s+/g, ' ');
  const url = location.href;
  const origin = location.origin;
  const captcha = /api-services-support@amazon\.com|Enter the characters you see below|Type the characters you see|Robot Check|تحقق من أنك لست روبوتًا|أدخل الأحرف التي تراها/i.test(clean) || /\/errors\/validateCaptcha/i.test(url);
  const signIn = /\/ap\/signin/i.test(url) || /Sign in to continue|تسجيل الدخول للمتابعة/i.test(clean);
  const accessDenied = /Access Denied|Sorry, we just need to make sure you're not a robot/i.test(clean);
  const rateLimited = /automated access to Amazon data|Request was throttled|503 Service Unavailable|Too many requests/i.test(clean);
  const currencySAR = /(?:SAR|ريال|ر\.?\s?س\.?|﷼)\s?[\d,]+/.test(clean) || /\bSAR\b/.test(clean);
  const currencyUSD = /\$\s?[\d,]+/.test(clean);
  const lang = document.documentElement.getAttribute('lang') || '';
  const empty = clean.replace(/\s+/g, '').length < 200;
  const noResults = /No results for|did not match any products|لم يتم العثور على نتائج|لا توجد نتائج/i.test(clean);
  const resultCount = document.querySelectorAll('[data-component-type="s-search-result"]').length;
  const rankCount = document.querySelectorAll('#gridItemRoot, .zg-grid-general-faceout').length;
  return JSON.stringify({ url, origin, lang, captcha, signIn, accessDenied, rateLimited, currencySAR, currencyUSD, empty, noResults, resultCount, rankCount, textLength: clean.length });
})()
