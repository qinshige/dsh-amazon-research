import { openTab, runJson, waitFor, closeTab } from '../host/web/chrome.js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SNIPPET = fileURLToPath(new URL('../host/web/snippets/amazon-search.js', import.meta.url));
const OUT = process.env.DSR_PACKS_OUT || fileURLToPath(new URL('../.cache/amazon-packs.json', import.meta.url));
const js = await readFile(SNIPPET, 'utf8');

const QUERIES = [
  ['Furniture Pads (脚垫)', 'furniture pads felt'],
  ['Picture Hangers (图片挂架)', 'picture hangers for wall'],
  ['Tarps (防水布)', 'tarp cover'],
  ['Robe & Towel Hooks (睡袍和浴巾挂钩)', 'bath towel hooks'],
  ['Pulls (拉手)', 'cabinet pulls'],
];

const PACK_RE = /(\d+)\s*(?:pcs|pieces|pack|pieces|count)\b/i;

const results = [];
for (const [name, query] of QUERIES) {
  const url = 'https://www.amazon.com/s?k=' + encodeURIComponent(query);
  const tabId = await openTab(url);
  try {
    await waitFor(tabId, 'document.querySelectorAll(\'[data-component-type="s-search-result"]\').length > 0', { timeout: 45 });
    await new Promise((r) => setTimeout(r, 2500));
    const data = await runJson(tabId, js);
    const items = (data.items || []).map((it) => {
      const m = String(it.title || '').match(PACK_RE);
      return { ...it, packQty: m ? Number(m[1]) : null };
    });
    const qtys = items.map((i) => i.packQty).filter((v) => v !== null && v > 0).sort((a, b) => a - b);
    const prices = items.map((i) => Number(String(i.price || '').replace(/[^\d.]/g, ''))).filter((v) => v > 0).sort((a, b) => a - b);
    const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
    results.push({
      name, query,
      resultCount: data.count,
      items,
      packSample: qtys.length,
      packMedian: median(qtys),
      packQuantiles: qtys.length ? { min: qtys[0], q25: qtys[Math.floor(qtys.length*0.25)], median: median(qtys), q75: qtys[Math.floor(qtys.length*0.75)], max: qtys[qtys.length-1] } : null,
      priceMedian: median(prices),
      priceRange: prices.length ? [prices[0], prices[prices.length-1]] : null,
    });
    console.log('OK ' + name + ' q=' + query + ' results=' + data.count + ' packSample=' + qtys.length + ' packMedian=' + median(qtys) + ' priceMedian=' + median(prices));
    if (qtys.length) console.log('   样例: ' + qtys.slice(0, 12).join(', '));
  } catch (error) {
    console.log('ERR ' + name + ' ' + String(error?.message ?? error));
  } finally {
    await closeTab(tabId);
  }
  await new Promise((r) => setTimeout(r, 4000));
}

const fs = await import('node:fs/promises');
await writeFile(OUT, JSON.stringify(results, null, 2));
console.log('saved ' + OUT);