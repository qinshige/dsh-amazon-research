/** Official consumer storefronts, observed from the already-loaded Saudi website.
 * enabled is authoritative; storefront ids are NOT unique across countries.
 * Currency is the storefront currency, not necessarily the national currency.
 */
import { readFileSync } from 'node:fs';
const snapshot = JSON.parse(readFileSync(new URL('./trendyol-countries.snapshot.json', import.meta.url), 'utf8'));
const names = {
  TR:'土耳其', DE:'德国', AE:'阿联酋', SA:'沙特阿拉伯', QA:'卡塔尔', KW:'科威特', OM:'阿曼', BH:'巴林',
  UA:'乌克兰', MD:'摩尔多瓦', AT:'奥地利', BE:'比利时', BG:'保加利亚', HR:'克罗地亚', CZ:'捷克', DK:'丹麦',
  EE:'爱沙尼亚', FI:'芬兰', FR:'法国', GR:'希腊', HU:'匈牙利', IT:'意大利', LV:'拉脱维亚', LT:'立陶宛',
  NL:'荷兰', PL:'波兰', PT:'葡萄牙', RO:'罗马尼亚', SK:'斯洛伐克', RS:'塞尔维亚', SI:'斯洛文尼亚',
  ES:'西班牙', SE:'瑞典', AZ:'阿塞拜疆', LU:'卢森堡', GE:'格鲁吉亚', KZ:'哈萨克斯坦', KG:'吉尔吉斯斯坦', IQ:'伊拉克',
};
export const TRENDYOL_COUNTRY_SOURCE = Object.freeze({ url: snapshot.source, observedAt: snapshot.observedAt });
export const TRENDYOL_SITES = Object.freeze(snapshot.countries.filter(c => c.enabled === true).map(c => {
  if (!names[c.code]) throw new Error('Missing Chinese country label: ' + c.code);
  return Object.freeze({ value:c.code, label:names[c.code], currency:c.currency, currencySymbol:c.currencySymbol,
    origin:'https://www.trendyol' + c.tld, storefrontId:c.id, culture:c.culture, language:c.language,
    otherLanguages:Object.freeze([...c.otherLanguages]), subPathStrategy:c.subPathStrategy,
    captureSupported:['TR','SA'].includes(c.code),
    entryPath:c.code === 'SA' ? '/en' : '/', searchPath:c.code === 'SA' ? '/en/sr' : '/sr',
  });
}));
export function getTrendyolSite(code) {
  return TRENDYOL_SITES.find(s => s.value === String(code || '').toUpperCase()) || null;
}
export function requireTrendyolCaptureSite(code = 'TR') {
  const site = getTrendyolSite(code);
  if (!site) throw Object.assign(new Error('Trendyol 未启用该国家：' + code), { code:'INVALID_ARGS' });
  if (!site.captureSupported) throw Object.assign(new Error(site.label + '是官网已启用国家，但插件暂未接通该站抓取；当前可抓取土耳其、沙特阿拉伯。'), { code:'UNSUPPORTED_SITE' });
  return site;
}
