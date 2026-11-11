# dsh-amazon-research · 内部接口契约（v0.1，团队共用）

> 上游参考仓库：[liangdabiao/amazon-sorftime-research-MCP-skill](https://github.com/liangdabiao/amazon-sorftime-research-MCP-skill)（只读参考）
> 目标：Amazon 品类选品（第一家数据源 Sellersprite，key 由用户在设置页自己填）。

## 1. 归一化对象 `Market`（`host/normalize.js` 产出，分析引擎唯一输入）

```js
{
  provider: 'sellersprite',
  marketplace: 'US',
  month: '2026-10',                 // yyyy-MM，缺省取最近自然月
  nodeIdPath: '11091801:...',       // 类目路径
  label: 'Cell Phones & Accessories',
  totals: { products, units, revenue },
  avgs: { price, units, revenue, bsr, rating, ratings },
  concentration: {                  // 全部 0~1 小数
    top3ProductCrn, top3BrandCrn, top3SellerCrn,
    top5BrandCrn, top10BrandCrn
  },
  structure: { fbaProportion, fbmProportion, amazonSelfProportion, returnRatio }, // 已是百分数(%)，如 95.2
  newRatio: { l1, l3, l6, l12 },    // 0~1 小数
  distributions: {
    price:        [{ label, products, units, revenue, unitsRatio }],       // unitsRatio 0~1
    brand:        [{ brand, products, newProducts, avgPrice, ratings, rating, totalUnits, totalRevenue, totalUnitsRatio }],
    sellerCountry:[{ country, products, units, revenue, unitsRatio }],
    rating:       [{ label, products, units, unitsRatio }],
    ratingsCount: [{ label, products, units, unitsRatio }],
    listingDate:  [{ label, products, units, unitsRatio }],
    sellerType:   [{ label, asinNum, asinRatio, units, unitsRatio, productNum }],
    product:      [{ label, asinNum, unitsRatio }],
    demandTrend:  [{ label, products, units, revenue }]
  },
  products: [ { asin, title, price, rating, reviews, brand, seller, sellerSource, monthlySales, monthlyRevenue, launchDays } ], // 可为空
  fetchedAt: '2026-11-10T15:00:00.000Z',
  warnings: ['...']                 // 数据缺失/口径替换
}
```

## 2. 分析引擎 API（engine-dev 负责）

```js
// host/metrics.js
brandHHI(brandRows) -> { hhi, basis: 'brand_units', coveredShare, estimated:boolean }
crn(rows, key, n) -> number                    // 0~1
normalizeScore(total, max = 92) -> { normalized, grade, thresholds }
// host/scoring.js
scoreMarket(market, opts?) -> {
  dimensions: [{ key, label, score, max, normalized, detail, inputs }],
  total, max: 92, normalized, grade, notes: []
}
// host/report.js
renderCategoryReport({ market, score, site, generatedAt, warnings }) -> string (markdown)
renderScoresJson(score) -> object
toCsv(rows, columns) -> string
renderDashboardHtml({ market, score, generatedAt }) -> string   // 内联 CSS/纯 HTML，禁止 CDN
```

评分口径（**用户已拍板：保持上游 92 分上限，按 92 归一化**）：
- 维度与档位：市场规模 20 / 增长潜力 25（实际最高 22）/ 竞争烈度 20（最高 18）/ 进入壁垒 20 / 利润空间 15（最高 12），合计上限 92。
- 评级按 `normalized = total / 92 * 100`：≥80 优秀、≥60 良好、≥40 一般、<40 较差。
- 数据缺失时该维度给最低档并在 `notes` 说明，禁止编造。
- 上游实现参考：`repo/SKILLS/skills/category-selection/scripts/data_utils.py:300-375`、`references/scoring-standard.md`。

## 3. 运行目录与产物（Lead 负责 `host/runs.js`）

```
<outputRoot>/<YYYYMMDD>_<slug>_<site>/
  manifest.json   # runId/kind/title/site/provider/params/usage/fetchedAt/warnings/createdAt
  market.json     # 归一化 Market
  scores.json
  report.md
  tables/market.csv, tables/brands.csv, tables/price_bands.csv
  dashboard.html
```

## 4. 面板接口（Lead 实现，ui-dev 只消费）

- `GET  /amazon-research/api/overview` → `{ pluginVersion, defaultMarketplace, outputRoot, providers:[{id,label,configured,ok,lastError}], runs:[{runId,title,site,createdAt,total,grade,dir}] }`
- `GET  /amazon-research/api/runs/:runId` → `{ runId, manifest, scores, reportMd, artifacts:[{name,path,bytes}] }`
- `POST /amazon-research/api/settings` `{marketplace, defaultLimit, outputRoot}` → `{ok:true}`
- `POST /amazon-research/api/credentials` `{provider:'sellersprite', key}` → `{ok:true}`
- `DELETE /amazon-research/api/credentials` `{provider}` → `{ok:true}`
- `GET  /amazon-research/api/health` → `{ok:true}`

## 5. 工具名（模型可见，snake_case）

`research_provider_status`（免费）、`research_category_select`（付费）、`research_runs`（免费）、`mcp_call`（付费逃生口）。

## 6. 文件归属（不要越界写）

- engine-dev：`host/metrics.js`、`host/scoring.js`、`host/report.js`、`test/analysis.test.mjs`、`test/fixtures/*`
- skill-dev：`skills/**`
- ui-dev：`client.js`、`icon.svg`
- Lead：其余全部（`package.json`、`index.js`、`host/*` 其它、`test/smoke.mjs`、安装）
