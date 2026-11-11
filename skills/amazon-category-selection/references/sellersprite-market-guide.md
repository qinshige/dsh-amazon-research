# SellerSprite 市场取数指南（v0.1）

本文件是 `references/sellersprite-market-guide.md`，供三类场景使用：

1. **理解一次 `research_category_select` 到底取了哪些数**（内部固定调用链、参数、口径）；
2. **用 `mcp_call` 手工补数/排查**时，查到正确的原始工具名、参数与字段刻度；
3. **网页登录态（`sellersprite-web`）取数**时，查三个页面各自能取到什么、网页版缺哪些字段、样本推导的局限（第 8 节）。

> 重要：下文的 `product_node`、`market_research`、`market_seller_type_concentration` 等是**数据源原始工具名**，不是插件工具。它们 **只能**作为 `mcp_call` 的 `tool` 参数出现（配 `provider:'sellersprite'`），模型不能直接调用。插件工具只有四个：`research_provider_status`、`research_category_select`、`research_runs`、`mcp_call`。

## 1. 连接与认证（只读提醒）

| 项 | 值 |
| --- | --- |
| 数据源 | 卖家精灵 SellerSprite，MCP 端点 `https://mcp.sellersprite.com/mcp` |
| 认证 | 请求头 `secret-key`；密钥由插件凭证层托管 |
| 配置入口 | 左侧栏「选品研究」→ 设置页「亚马逊选品研究」填写 Secret Key |
| key 环境变量名 | `SELLERSPRITE_SECRET_KEY`（仅插件内部回退用，不要展示给用户） |

- 不要向用户索要 key，不要把 key 写进报告、日志或 `mcp_call.args`。
- 密钥未配置时，任何取数都会返回 `NO_CREDENTIAL`；先 `research_provider_status` 确认再收费。
- 参数结构：绝大多数卖家精灵工具要求 `{"request": { ... }}` 包裹；少数扁平参数工具（如 `keyword_research_trends`）直接传字段。**拿不准时先按 `request` 包裹试一次**。

## 2. 插件内部调用链（v0.1 固定）

`research_category_select` 的执行顺序（`host/category.js`）：

| # | 原始工具 | 内部参数（request 内） | 作用 | 失败影响 |
| --- | --- | --- | --- | --- |
| 1 | `product_node` | `{marketplace, keyword: category}` | 关键词 → 节点候选；挑商品数>0 的叶子，取候选第一条 | 致命：`NODE_NOT_FOUND` |
| 2 | `market_research` | `{marketplace, nodeIdPath, topNum:10, newProduct:6, size:limit}` | 市场大盘 + 集中度 + 结构 + 新品占比 | 致命：`EMPTY_MARKET` |
| 3–8 | 6 个分布工具：`market_price_distribution`、`market_brand_concentration`、`market_rating_distribution`、`market_ratings_count_distribution`、`market_listing_date_distribution`、`market_seller_country_distribution` | `{marketplace, nodeIdPath, month?}` | 价格带/品牌/评分/评分数/上架时间/卖家所属地 | 单条失败只记 warning，不中断 |
| 9 | `product_research` | `{marketplace, nodeIdPath, size:limit}` | 头部商品明细（Top N） | 失败只记 warning |

- 最小调用数 **9 次**；出现重试/额外候选查询时约 **9~11 次**。工具描述里按 9~11 次向用户报价。
- **月份口径注意**：v0.1 的 `month` 只传给 6 个分布工具；`market_research` 大盘不传 `month`，仍取厂商默认最近可分析月。因此指定月份时，`totals/avgs/concentration` 与分布数据的月份可能不同步——报告要注明「大盘取默认最近月，分布按指定月」，不要把两者当同月数据硬比。
- 6 个分布工具并发 3 个执行；输出经 `host/normalize.js` 归一化，比原始字段更适合直接引用。
- v0.1 **不会**自动抓：`market_seller_type_concentration`、`market_product_concentration`、`market_seller_concentration`、`market_ebc_distribution`、`market_product_demand_trend`、`market_listing_trend_distribution`、`market_research_statistics`。需要时走 `mcp_call`。
- 以上是 **MCP 链路**（`provider:'sellersprite'`）的调用链。网页登录态链路（`provider:'sellersprite-web'`）是另一条链路：3 次页面读取，没有 `market_*` 分布工具，见第 8 节。

## 3. 参数总表

### 3.1 通用参数

| 参数 | 类型/取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `marketplace` | `US/UK/DE/FR/IT/ES/CA/JP/MX/AU/IN/AE/BR/SA` | US | 站点；不同站点类目树不同，不能跨站拼数 |
| `nodeIdPath` | 冒号分隔节点路径，如 `11091801:11974521:8882489011` | 无 | **优先传**；必须是叶子节点，根节点统计常为 0 |
| `keyword` | 英文类目词 | 无 | 节点解析用；中文/翻译词不可靠 |
| `month` | `yyyyMM`，如 `202610` | 最近自然月 | 未就绪时厂商回退最近月；归一层输出为 `yyyy-MM` 或空串 |
| `topNum` | int，常用 10/20 | 10 | 头部样本数；直接影响 `top*Crn` 集中度口径 |
| `newProduct` | 1/3/6/12 | 6 | 新品定义月数；影响 `l*NewRatio` 的「新品」边界 |
| `size` | int，最大 100 | 50 | 返回/样本条数；插件按 `limit` 传 10–100 |
| `sellerLocation` | 单值字符串 | 无 | **多选无效**；要多个地区必须拆成多次调用再并集 |

### 3.2 `market_research` 要点

- 用途：给父类目（节点/关键词）+ 筛选条件，返回**细分市场列表**（每行一个市场），每行带约百个市场级指标。
- 参数模式：`{"request": {...}}`；`nodeIdPath` 优先于 `keyword`。
- 返回 `data.items` 里既有子市场，也可能有父节点自身汇总行；按 `ranking`/`totalProducts` 过滤，归一层用 `pickMarketRow` 按 nodeIdPath/label/销量挑一行。
- 关键字段与刻度：

| 字段 | 含义 | 刻度 |
| --- | --- | --- |
| `nodeLabelName` / `nodeLabelPath` | 细分市场名 / 英文路径 | 文本；以英文路径为准，`nodeLabelLocale` 中文翻译不可靠 |
| `topProducts/topBrands/topSellers` | 样本商品/品牌/卖家数 | 整数 |
| `totalProducts` | 类目在售商品总数 | 整数（根节点常为 0） |
| `totalUnits` / `totalRevenue` | 样本月总销量/销售额 | 数量/金额 |
| `avgUnits/avgRevenue/avgPrice/avgBsr/avgRating/avgRatings` | 各项均值 | 与字段同单位 |
| `top{3,5,10,20}{Product,Brand,Seller}Crn` | 分层集中度 | **0~1 小数，展示 ×100** |
| `fbaProportion/fbmProportion/amazonSelfProportion` | 卖家结构占比 | **已是百分数（0~100）** |
| `returnRatio` | 退货率 | **已是百分数** |
| `l{1,3,6,12}NewRatio` / `NewCount` | 新品占比/数量 | Ratio **0~1**；Count 整数 |

## 4. 市场相关 15 个工具

> 计数口径：**1 个节点前置 + 1 个全景 + 1 个深入统计 + 12 个分布/趋势 = 15 个入口**；其中命名以 `market_` 开头的 14 个，`product_node` 是类目前置工具。上游资料标题写作「15 个 market_*」，以实际可调用清单为准，遇到清单外的名字先 `mcp_call` 试一次并记录结果。

| # | 工具 | 用途 | v0.1 自动调用 | 关键字段/口径 |
| --- | --- | --- | --- | --- |
| 1 | `product_node` | 类目节点查询/关键词→节点 | ✅ | `nodeIdPath`、`nodeLabelPath`、`products`（有商品数才是可分析叶子）、`ranking` |
| 2 | `market_research` | 市场全景（一行=一个细分市场） | ✅ | 见 3.2；`top*Crn` 为 0~1、`*Proportion` 已是百分数 |
| 3 | `market_research_statistics` | 市场深入统计（补 `market_research` 未覆盖的统计口径） | ❌ | 字段以实测为准：先 `mcp_call` 一次看返回，再引用 |
| 4 | `market_price_distribution` | 价格区间分布 | ✅ | `label`(价格带)、`products/units/revenue`、`unitsRatio`（0~1） |
| 5 | `market_brand_concentration` | 品牌集中度/份额 | ✅ | `brand`、`ranking`、`products/newProducts`、`avgPrice`、`ratings/rating`、**`totalUnits/totalRevenue/totalUnitsRatio`**（不是 units） |
| 6 | `market_product_concentration` | 商品(ASIN)集中度 | ❌ | `label`、`asinNum`、`unitsRatio`（0~1） |
| 7 | `market_seller_concentration` | 卖家集中度 | ❌ | `sellerName/sellerId`、`totalUnits/totalRevenue/totalUnitsRatio` |
| 8 | `market_rating_distribution` | 评分值分布 | ✅ | `label`(评分区间)、`products/units`、`unitsRatio`（0~1） |
| 9 | `market_ratings_count_distribution` | 评分数分布（评论墙） | ✅ | `label`(评分数区间)、`products/units`、`unitsRatio`（0~1） |
| 10 | `market_listing_date_distribution` | 上架时间分布 | ✅ | `label`(时间)、`products/units`、`unitsRatio`；样本小时可能全 0 |
| 11 | `market_listing_trend_distribution` | 上架趋势分布 | ❌ | `label`(时间)、`products/units`、`unitsRatio` |
| 12 | `market_seller_country_distribution` | 卖家所属地分布 | ✅ | `country`、`products/units/revenue`、`unitsRatio`（0~1） |
| 13 | `market_seller_type_concentration` | 发货类型（FBA/FBM/AMZ）分布 | ❌ | `asinNum`（非 products）、`asinRatio`、`units`、`unitsRatio`、`productNum` |
| 14 | `market_ebc_distribution` | A+ 页面/视频分布 | ❌ | `label`、`products`、`productsRatio`（**已是百分数**）、`units/unitsRatio` |
| 15 | `market_product_demand_trend` | 需求趋势（按月） | ❌ | `label`(月份)、`products/units/revenue`；用于季节性判断 |

**分布工具返回结构不统一**：可能是 `data: {items:[...]}`，也可能是 `data: [...]` 直接数组。归一层已用 `itemsOf` 兼容；手工补数时先判类型再取数组，不要把对象当数组遍历。

## 5. 刻度与改名陷阱（最高频错误）

### 5.1 两类刻度，必须分清

| 类别 | 字段例子 | 读数规则 |
| --- | --- | --- |
| **0~1 小数** | `top*Crn`、`l*NewRatio`、`unitsRatio`、`revenueRatio`、`asinRatio` | 展示 ×100 加 %；若原始值 >1.5，可能厂商已按百分数返回（归一层按 >1.5 视作百分数处理） |
| **已是百分数** | `fbaProportion`、`fbmProportion`、`amazonSelfProportion`、`returnRatio`、`productsRatio`（A+专用） | 直接读，**不要再 ×100** |
| **真实比值，不换算** | `supplyDemandRatio` 等 | 按原值理解（如 78.88 表示供需比 78.88） |

> 归一层 `market.json` 已统一：集中度/新品占比为 0~1，结构/退货率为百分数；写报告时只信 `market.json` 的刻度，不要拿原始响应和归一值混算。

### 5.2 网页字段 → MCP 字段改名

| 网页/文档字段 | MCP 实际字段 |
| --- | --- |
| `HeadListing*` | `Top*` |
| `*Ratio`（集中度/新品占比） | `*Crn` 或 `*NewRatio` |
| `*Sales` | `*Units` |
| `*Reviews` | `*Ratings` |
| `*TotalProducts` | `*GoodsCount` |
| `marketId` | `marketplace` |
| `monthName` | `month` |
| `topn` | `topNum` |
| `newReleaseNum` | `newProduct` |
| `sellerType` | `fulfillment`（部分工具） |
| `totalUnits` | `units`（部分分布工具仍用 totalUnits） |
| `totalAmount` | `revenue` |
| `bsrRank` | `bsr` |
| `reviews` | `ratings` |

> 同一含义在不同工具里可能叫不同名字（如品牌工具用 `totalUnits`，价格工具用 `units`）。手工补数时**先看返回键名再引用数值**，不要按记忆硬套。

### 5.3 实测陷阱清单

1. **根节点统计全 0**：`product_node` 找到的节点若 `products=0` 或 `market_research.totalProducts=0`，基本是根/非叶子节点。必须下钻到有商品数的叶子；全 0 不是「市场为 0」。
2. **topNum 改变集中度口径**：`top3BrandCrn` 是「Top3 品牌销量 / 样本总销量」，样本由 `topNum`/`size` 决定；不同 `topNum` 的 CRn 不能直接比。
3. **`sellerLocation` 多选无效**：该参数仅单值有效；要「中国+美国」卖家结构，需拆成 2 次调用再合并（合并时不能把两个占比简单相加，要先明确分母）。
4. **月份未就绪**：当月数据常未生成，厂商会回退最近自然月；如果返回全 0/空，先确认月份，最多回退一个月重试一次。
5. **类目中文翻译不可靠**：`nodeLabelLocale` 常见错译（如把 Microphones 译成「显微镜」）；一律以 `nodeLabelPath` 英文路径为准。
6. **多值参数用逗号字符串**：`brands`/`sellers`/`fulfillment` 等参数传逗号分隔字符串，不要传数组（部分工具会直接报错或忽略）。
7. **均值不能当加权平均**：`avgPrice` 是样本均值；要算价格带加权均价，用分布工具的 `units` 做权重，不要对 `avgPrice` 再求平均。
8. **占比不要跨分布相加**：价格带 `unitsRatio` 与品牌 `totalUnitsRatio` 的分母/样本不同，不能把两套占比加在一起说「共 xx%」。
9. **响应可能超大**：`mcp_call` 超过 60000 字符会自动落盘（`savedTo`），用 read 工具读文件；不要把大 JSON 整个贴回对话。
10. **类目返回多行**：`market_research` 的 `data.items` 可能混入父节点/子市场行；归一层按 nodeIdPath 选行，手工补数时要自己过滤 `totalProducts` 异常或 `ranking` 不在目标范围的行。

## 6. MCP 原始字段 → `market.json` 归一字段

一次 `research_category_select` 后，报告应以 `market.json` 为准。映射关系（`host/normalize.js`）：

| `market.json` 字段 | 来源（原始工具/字段） | 刻度约定 |
| --- | --- | --- |
| `provider` / `marketplace` / `month` / `nodeIdPath` / `label` | 参数 + 节点解析结果 | month 为 `yyyy-MM` 或空串 |
| `totals.products` | market_research `totalProducts` | 整数 |
| `totals.units` | market_research `totalUnits` | 数量 |
| `totals.revenue` | market_research `totalRevenue` | 金额（站点币种，US 为 USD） |
| `avgs.price/units/revenue/bsr/rating/ratings` | market_research `avg*` | 同原字段 |
| `concentration.top3ProductCrn/top3BrandCrn/top3SellerCrn/top5BrandCrn/top10BrandCrn` | market_research `top*Crn` | **0~1** |
| `structure.fbaProportion/fbmProportion/amazonSelfProportion/returnRatio` | market_research 同名字段 | **百分数（0~100）** |
| `newRatio.l1/l3/l6/l12` | market_research `l*NewRatio` | **0~1** |
| `distributions.price` | market_price_distribution | `unitsRatio` 0~1 |
| `distributions.brand` | market_brand_concentration | `totalUnits→units`、`totalUnitsRatio→unitsRatio`（0~1） |
| `distributions.rating` | market_rating_distribution | `unitsRatio` 0~1 |
| `distributions.ratingsCount` | market_ratings_count_distribution | `unitsRatio` 0~1 |
| `distributions.listingDate` | market_listing_date_distribution | `unitsRatio` 0~1 |
| `distributions.sellerCountry` | market_seller_country_distribution | `country` + `unitsRatio` 0~1 |
| `distributions.sellerType` | **v0.1 未抓取，空数组** | 需要时 mcp_call 补 |
| `distributions.product` | **v0.1 未抓取，空数组** | 需要时 mcp_call 补 |
| `distributions.demandTrend` | **v0.1 未抓取，空数组** | 需要时 mcp_call 补 |
| `products[]` | product_research（字段容错映射） | `asin/title/price/rating/reviews/brand/seller/sellerSource/monthlySales/monthlyRevenue/launchDays` |
| `fetchedAt` | 归一层写入 | ISO 8601 UTC |
| `warnings[]` | 节点层级提示、分布缺失、月份回退、缺 unitCost 等 | 数组 |

## 7. `mcp_call` 补数配方（按需，均付费）

调用前先读第 3 节参数与第 5 节刻度；每次调用前告知用户付费次数。以下示例中的字段名以实际返回为准。

### 7.1 补卖家类型/履约结构

```json
{
  "provider": "sellersprite",
  "tool": "market_seller_type_concentration",
  "args": { "request": { "marketplace": "US", "nodeIdPath": "11091801:11974521:8882489011" } }
}
```

读法：`asinNum/asinRatio` 是 ASIN 数量口径，`units/unitsRatio` 是销量口径；FBA 占比高说明履约门槛与退货成本更依赖 FBA。`asinRatio` 是 0~1。

### 7.2 补需求趋势/季节性

```json
{
  "provider": "sellersprite",
  "tool": "market_product_demand_trend",
  "args": { "request": { "marketplace": "US", "nodeIdPath": "11091801:11974521:8882489011" } }
}
```

读法：按月看 `units/revenue` 的峰谷；单月尖峰、其余月份低 = 强季节性，新卖家要写清备货/现金流风险。样本可能只在部分月份有值，缺月标「未取到」。

### 7.3 补商品/卖家集中度

```json
{
  "provider": "sellersprite",
  "tool": "market_product_concentration",
  "args": { "request": { "marketplace": "US", "nodeIdPath": "11091801:11974521:8882489011" } }
}
```

读法：`asinNum` + `unitsRatio`（0~1）；商品集中度高而品牌集中度低 = 单品强、品牌弱的结构，可提示「单链接可打但要看评论墙」。

### 7.4 补深入统计

```json
{
  "provider": "sellersprite",
  "tool": "market_research_statistics",
  "args": { "request": { "marketplace": "US", "nodeIdPath": "11091801:11974521:8882489011", "topN": 10, "newProduct": 6 } }
}
```

先看返回键名再引用；不要假设字段名与 `market_research` 相同。

### 7.5 补数纪律

- 一次一个工具；同一参数失败最多重试 1 次。
- 补数结果要记：`provider`、`tool`、`args`、抓取时间、是否落盘（`savedTo`）。
- 补数只用于解释/交叉验证已有结论；**不要**用零散补数拼一份「替代 run」的报告。
- 若补数与 `market.json` 冲突：以 run 产物为准并写「口径差异待核」，把两边数值都列出来，不要悄悄选一个。

## 8. 网页登录态取数（sellersprite-web）

### 8.1 什么时候用、怎么用

- **触发条件**：卖家精灵 MCP（mcp.sellersprite.com）需要账号开通 MCP 服务权限；密钥本身有效但没开通时，MCP 侧会返回 `TOOL_NOT_ALLOWED` / `secret_unauthorized`。
- **用法**：把 `research_category_select` 的 `provider` 改成 `'sellersprite-web'`。插件驱动**用户自己**已登录 sellersprite.com 的 Chrome 标签页读取页面，走用户自己的登录态与网页端额度。
- **前提**：用户 Chrome 里已登录 sellersprite.com。未登录时返回 `NOT_LOGGED_IN`，让用户先登录再重试（**不要**尝试绕过登录/验证码/付费墙）。
- **费用口径**：**不消耗 MCP 额度**，但**占用卖家精灵网页端的查询次数**——调用前照样要告知用户。
- **性质**：这是同一数据源的另一条链路，不是绕过鉴权的手段，也不放宽任何数据纪律；未告知用户不要擅自切换链路。
- **注意**：`provider:'sellersprite-web'` 不支持 `month` 参数（网页版取最近可分析月，`manifest.month` 为空串）。

### 8.2 三个页面分别能取到什么

| # | 页面 | 页面形态 | 能取到的字段 | 取不到的东西 |
| --- | --- | --- | --- | --- |
| 1 | **选市场**（细分市场列表） | `/v2/market-research?marketplace=<站点>` | 每行：`rank`、`name`、`nodeIdPath`、样本量（商品/品牌/卖家数）、`totalUnits`（子市场月总销量）、`averageUnits`、`averagePrice`（均价）、`headAverageRevenue`（头部均销额）、`averageRatings`/`averageRating`、`concentration.brandCr3/productCr3/sellerCr3`（页面 Top3 占比）、`structure.fbaProportion/fbmProportion/amazonSelfProportion`、`newItems.count/ratio`、`goodsTotal`（商品总数）、`returnRate`（退货率） | 节点级**月销额**、CR5/CR10、任何分布类指标 |
| 2 | **类目报告**（类目大盘） | `/v2/market-research/1/<nodeIdPath>?topN=10&newReleaseNum=6&currentMonth=` | `sampleProducts`（样本商品数）、`sampleBrandsSellers`、`avgBsr`、`avgUnits`（近30天均销量）、`avgRevenue`（近30天均销售额）、`avgPrice`、`avgRatings`、`avgRating`、`avgSellers`、`grossMargin`（平均毛利率）、`newItems`（新品数量）、`newRatio`（新品占比 %）、`newAvgPrice/newAvgUnits/newAvgRevenue`、`firstListed/lastListed`、`productCr3/brandCr3/sellerCr3`（页面集中度 %）、`peer*Cr3`（同级类目对比）、`topProductsCount`、`goodsTotal` | 节点级**月销额**、`l3/l6/l12` 新品占比、任何 `market_*` 分布 |
| 3 | **查竞品**（Top 商品明细） | `/v3/competitor-lookup/?market=<站点>&nodeIdPathEqual=true&nodeIdPaths=[...]` | 每行：`rank`、`asin`、`parentAsin`、`title`、`brand`、`bsrBig`、`bsrCategory`、`units`（月销量）、`revenue`（月销售额）、`variants`、`price`、`qa`、`reviews`（评分数）、`rating`、`reviewRate`、`fbaFee`、`margin`（毛利率）、`listedDate`（上架时间）、`sellers`（卖家数）、`fulfillment`（FBA/FBM）、`buyBox`、`lqs`、`weight`、`packWeight` | 卖家国别、卖家类型分布、需求趋势、商品集中度 |

- 三次页面读取的来源会记在 `manifest.sources`（`sellersprite-web:选市场` / `:类目报告` / `:查竞品`），便于报告溯源。
- **节点推断的坑**：选市场页按关键词过滤后列出的是「所选节点的**下一级**细分市场」，插件用所有行的 `nodeIdPath` **最长公共前缀**反推所选节点，并在 `warnings` 里提示「若与页面实际选中项不符，请直接传 nodeIdPath」。**web 链路下最好直接传 `nodeIdPath`**，不要只靠关键词。
- 页面改版或渲染失败会导致某个数值取不到（工具会记 warning，如「Top 商品明细未取到」）：按「未取到」处理，不要用常识补。

### 8.3 网页版没有的字段（对照 MCP 的 `market_*` 分布工具）

> 下表左列是**数据源原始工具名**，只能作为 `mcp_call` 的 `tool` 参数使用；网页版本身没有对应页面。

| MCP 侧（原始工具名） | 网页版能拿到的近似物 | 网页版口径 |
| --- | --- | --- |
| `market_price_distribution` | 查竞品页的价格 + 销量 | 由 Top N 样本分桶：0-15 / 15-30 / 30-50 / 50-100 / 100+ |
| `market_ratings_count_distribution` | 查竞品页评分数 | 由 Top N 样本分桶：0-50 / 51-100 / 101-300 / 301-1000 / 1001+ |
| `market_rating_distribution` | 查竞品页评分 | 由 Top N 样本分桶：<4.0 / 4.0-4.3 / 4.3-4.6 / 4.6-5.0 |
| `market_listing_date_distribution` | 查竞品页上架时间 | 由 Top N 样本按年月分组 |
| `market_brand_concentration` | 类目报告页 Top3 品牌占比 + Top 商品品牌聚合 | 类目级看页面 Top3；品牌明细由 Top N 聚合 |
| `market_seller_concentration` | 类目报告页 Top3 卖家占比 | 只有 Top3，无 CR5/CR10 |
| `market_seller_country_distribution` | —— | **无对应页面**，标「未取到」 |
| `market_seller_type_concentration` | 查竞品页 `fulfillment` 字段（FBA/FBM/AMZ） | **无页面级分布**，标「未取到」 |
| `market_product_concentration` | —— | **无对应页面**，标「未取到」 |
| `market_product_demand_trend` | —— | **无对应页面**，标「未取到」 |

结论：网页版的价格带/评论数/评分/上架时间分布是 **Top N 样本推导**，不是类目全量分布；报告里必须标「Top N 样本推导口径」。

### 8.4 从页面数值解析集中度与新品占比

- **集中度刻度**：页面文本形如 `品牌: 62.3%` / `商品: 41.0%` / `卖家: 28.5%`；插件解析时 **÷100 转成 0~1 小数**，与 MCP 版 `*Crn` 同刻度，写报告时再 ×100 加 %。
- **类目级品牌集中度以页面 Top3 品牌占比为准**（`concentration.top3BrandCrn`）；**Top5/Top10 品牌集中度网页版取不到**，标「未取到」，不要用 Top3 推算。
- **卖家集中度**同理取页面 Top3 卖家占比（`concentration.top3SellerCr3`）。
- **品牌 HHI 只能按 Top N 样本内的品牌销量份额计算**，并标 `estimated`：分母是样本内销量，不是类目全量销量。插件用 `market.json` 的 `distributions.brandCoverage='sample'` 标记，报告引擎据此把 HHI 标成估算值。写法：「品牌 HHI xxxx（Top N 样本内销量份额，估算值，非类目全量）」。
- **新品占比**来自类目报告页「新品占比 xx%」，其**窗口由页面当前设置决定（默认 1 个月）**；网页版只落到 `newRatio.l1`，`l3/l6/l12` 为空。写报告时注明窗口，不与 MCP 版的 6 个月口径并列比较，也不当成长趋势。

### 8.5 市场规模与销额的推导

- 网页版**没有节点级月销额**。插件优先用**选市场页的子市场月总销量求和**（`scaleBasis='submarket_sum'`），销额用「该销量 × 类目均价」**估算**。
- 取不到子市场销量时退化为**样本口径**（`scaleBasis='sample'`）：「样本商品数 × 近30天均量」，并写入 `warnings`。
- 两种口径都要在报告里写清公式与输入，不能直接写成「类目月销额 $x」。

### 8.6 Top N 样本推导的局限

1. **样本偏差**：Top N 是头部商品，头部价格带与头部品牌的权重被天然放大，不能代表长尾结构。
2. **分母不同**：样本分布的占比分母是「Top N 销量」，与类目全量销量不同，**不能**与 MCP 版分布占比并列或相加。
3. **N 以实际取到的行数为准**：页面表格行数、解析失败都会让实际行数小于 `limit`；报告里的 N 取 `market.json` 中的实际商品数，不是 `limit`。
4. **分桶是插件口径**：价格带/评论数/评分的分桶阈值由插件定义（见 8.3），与厂商口径不一定一致；报告写「按插件分桶」，不写「卖家精灵分布」。
5. **HHI 只能当参考**：样本 HHI 与类目全量 HHI 不同量级，不能直接与引擎的「品牌 HHI ≥2500」阈值硬比；要判断品牌垄断，用页面 Top3 品牌占比。
6. **新品占比不来自样本**：新品占比来自类目报告页大盘，不要用 Top N 的上架时间反推新品占比。

## 9. 取数质量自检（每次补数/排查后过一遍）

- [ ] `nodeIdPath` 至少 2 段、节点 `products>0`（叶子）。
- [ ] `market_research` 返回行里 `totalProducts/totalUnits/totalRevenue` 不全为 0。
- [ ] 集中度字段在 0~1 范围；结构占比在 0~100 范围；越界说明刻度理解错了。
- [ ] `top*Crn` 随 `topNum` 变化时，报告口径写的是同一个 `topNum`。
- [ ] 分布工具返回值非空；空数组/全 0 记为「未取到」，不是「没有竞争」。
- [ ] 月份是 `yyyyMM` 入参、`yyyy-MM` 或空串出参；报告不把「空 month」写成一个具体月份。
- [ ] 大响应已落盘并记录路径；没有把完整 JSON 塞回对话。
- [ ] 没有在 args/日志/报告里出现密钥。
- [ ] 网页登录态 run：三个页面的来源都记进了 `manifest.sources`；缺哪个页面就按「未取到」写。
- [ ] 网页登录态 run：节点是显式传的 `nodeIdPath`（否则报告标出「按最长公共前缀推断」）。
- [ ] 网页登录态 run：分布标了「Top N 样本推导（N=实际取到的商品数）」；HHI 标了样本口径 + 估算；月销额标了估算公式与输入。
