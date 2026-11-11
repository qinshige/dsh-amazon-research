# dsh-amazon-research · 第二批接口契约（1688 采价 + 利润重算）

> 延续 CONTRACTS.md。目标：把「利润空间」维度从「按均价档位兜底」换成**真实 1688 采购价 + 全成本净利率**。

## 1. 1688 采价模块（sourcing-1688 负责）

文件：`host/sourcing/1688.js`，导出两个纯函数（依赖 `host/web/chrome.js` 的 Chrome 驱动）：

```js
/** 搜索 1688 供应货源，返回搜索页卡片级数据 */
export async function searchOffers({ keyword, limit = 20, log = () => {} })
  // → { rows: Array<OfferCard>, count, keyword, fetchedAt, source: '1688:搜索页' }

/** 进入 offer 详情页逐项验证 */
export async function fetchOfferDetail({ url, log = () => {} })
  // → { offerId, title, url, priceTiers: [{qty, priceCNY}], moq, moqText,
  //     material, skuVariants, weightG, packDimsCm, supplier, location,
  //     onePieceDropship, monthlySales, fetchedAt, source: '1688:详情页' }
```

`OfferCard` 形状：
```js
{ offerId: string, title: string, url: string, priceCNY: number|null,
  moqText: string|null, supplier: string|null, location: string|null,
  monthlySales: string|null, badges: string[] }
```

硬要求：
- 只读公开搜索页与详情页，**不绕��登录、不绕过验证码**；遇到「请登录/验证码」立即抛 `NOT_LOGGED_IN` / `CAPTCHA` 并停止；
- 每个 offer 的价格必须来自**页面真实文本**，不推断、不用记忆值；
- 详情页要抓：阶梯价（qty → price）、起批量、材质、SKU 变体、件重、包装尺寸、供应商、一件代发标识；
- 每次调用记录 `fetchedAt` 与 `source`；
- 所有 JS 片段放 `host/sourcing/snippets/`，每个片段一个文件（照 `host/web/snippets/` 的做法），避免转义地狱。

## 2. 成本模型（cost-model 负责）

文件：`host/sourcing/cost-model.js`：

```js
/** 单件全成本拆解 */
export function landedCost({
  priceCNY,        // 1688 采购价（阶梯价已选定）
  weightG,         // 件重（克），用于头程与 FBA 档位
  fx = 7.1,        // 汇率 CNY/USD
  firstMilePerKgCNY = 35,   // 头程 ¥/kg（含海运+贴标摊销）
  referralRate = 0.15,     // 平台佣金
  fbaFeeUSD = null,        // 若给 FBA 费则用；否则按重量档估算
  adRate = 0.10,           // 广告
  returnRate = 0.05,       // 退货损耗
  otherUSD = 0.35,         // 仓储/其他
  priceUSD,                // 售价（Amazon 侧）
})
  // → { purchaseUSD, firstMileUSD, referralUSD, fbaFeeUSD, adUSD, returnUSD, otherUSD,
  //      totalCostUSD, grossProfitUSD, grossMargin, netMargin, fbaEstimated, notes: [] }
```

口径照抄工作区既有方法论（`research/supply/supply_成本与变体.md` §2）：
- 净利率 = 毛利 ÷ 售价；红线：净利率 > 25%，小体量品 > 30%；
- 物流占比（头程+FBA）应落在售价的 10%–15%，> 20% 建议放弃；
- FBA 费档位（**估算值**）：小号标准 ≤4oz $3.22 / 4–8oz $3.40 / 8–12oz $3.55 / 12–16oz $3.77；
- 所有估算参数必须在 `notes` 里标注「估算值」，实测值标注「实测值」。

## 3. 利润维度重算（cost-model 负责）

`host/scoring.js` 新增导出：

```js
/** 用真实全成本净利率替换「利润空间」维度（92 分制里的 12 分档） */
export function profitScoreFromNetMargin({ netMargin, priceUSD })
  // → { score: 0|4|7|10|12, max: 12, basis: 'net_margin', detail, notes }
  // 档位：净利率 >30% → 12；>20% → 10；>12% → 7；>0% → 4；≤0% → 0
  // 与上游「毛利率档位」不同：这是**净利率**口径（扣完佣金/广告/退货），必须在 detail 里写明。
```

## 4. 运行产物新增

`host/category-web.js` 增加可选参数 `costs`（每个子市场一条 1688 采价结果），落盘：
- `tables/sourcing_1688.csv`：子市场 → 关键词 → offerId → 采购价 → 起批量 → 材质 → 重量 → 链接 → 验证状态；
- `tables/profit_by_submarket.csv`：子市场 → 售价 → 采购$ → 头程$ → FBA$ → 佣金$ → 广告$ → 退货$ → 其它$ → 全成本$ → 净利$ → 净利率 → 判定；
- `market.json` 里增加 `sourcing[]`（明细）与 `profitBySubMarket[]`（测算）；
- 报告新增「八、1688 采购价与净利测算」章：逐子市场列出测算表 + 口径说明 + 缺失标记（「未取到」）。

## 5. 工具新增（cost-model 负责）

`research_unit_cost`：
- 输入：`{ category?, subMarkets?: [{name, keyword, avgPriceUSD}], limit?, provider? }`
- 输出：`{ ok, offers: [...], profit: [...], warnings, fetchedAt }`
- 说明文案必须写明「会打开 1688 页面并消耗网页端查询次数」。
