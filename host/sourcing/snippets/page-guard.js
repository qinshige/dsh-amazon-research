/**
 * 登录墙 / 验证码守卫。
 *
 * 在任何 1688 页面上先跑一次：命中登录墙或验证码就立刻停手报错，不绕过、不尝试破解。
 * 返回：JSON 字符串 { url, status: 'OK'|'LOGIN'|'CAPTCHA', reason, textLen }
 */
(() => {
  const href = location.href || '';
  const text = (document.body ? document.body.innerText : '') || '';
  const head = text.slice(0, 4000);
  const hay = href + '\n' + head;

  const captcha = /验证码|安全验证|滑动验证|滑动|拖动|完成验证|通过验证|访问过于频繁|请求过于频繁|系统繁忙|captcha|punish|x5sec|tmd_____/i.test(hay);
  const login = /login\.1688\.com|passport\.1688\.com|\/login\?/i.test(href)
    || /请登录后查看|登录后可查看|登录后查看更多|请先登录|账号密码登录|扫码登录/.test(head)
    || !!document.querySelector('input[type="password"]');

  // 软限流：页面被清空（只剩插件浮层），或标题退化成通用标题，且没有任何商品卡
  const cards = document.querySelectorAll('a[href*="detail.1688.com/offer/"]').length;
  const emptyPage = text.length < 200 && cards === 0 && !/punish|x5sec/.test(href);

  let status = 'OK';
  let reason = '';
  if (captcha) {
    status = 'CAPTCHA';
    reason = '页面出现验证码/安全校验';
  } else if (login) {
    status = 'LOGIN';
    reason = '页面出现登录墙';
  } else if (emptyPage) {
    status = 'BLOCKED';
    reason = '页面返回空白（1688 频控拦截，未渲染商品列表）';
  }
  return JSON.stringify({ url: href, status: status, reason: reason, textLen: text.length, cards: cards });
})()
