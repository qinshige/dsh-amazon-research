---
name: amazon-category-selection
description: 亚马逊品类级选品与类目市场调研（SellerSprite 取数 + 五维评分 92 分制归一化）。触发词：品类选品、类目选品、类目分析、类目调研、市场调研、市场容量、集中度、价格带、蓝海类目、细分市场、Amazon category、category selection、category analysis、product selection、niche research、market research。
---

# 亚马逊品类选品（Amazon Category Selection）

把「这个类目值不值得做」拆成一条可复核的流水线：**查数据源 → 一次类目取数 → 读归一层产物 → 按五维解读 → 给出带数据出处的结论**。本技能只处理**类目级**判断，不处理单个 ASIN 的 Listing 体检。

## 0. 边界：做什么、不做什么

### 0.1 本技能负责

- Amazon 站点某个**细分/叶子类目**的市场容量、增长、竞争、壁垒、利润空间判断。
- 用统一口径给类目打分（五维，**92 分制**归一化到 100），并解释分数怎么来的。
- 从集中度、价格带、结构分布、风险项中提炼「能不能进 / 从哪个价格带进 / 首批怎么验证」。
- 输出可复盘的类目选品报告（Markdown 为主，产物由插件运行目录提供）。

### 0.2 本技能不负责（明确拒绝或降级处理）

| 用户诉求 | 处理方式 |
| --- | --- |
| 「帮我看这个 ASIN 的 Listing / 差评 / 关键词」 | **超出边界**：当前版本只做类目级选品，单品 Listing 体检在后续版本提供；不要顺手用类目数据冒充单品结论。 |
| 「帮我查专利 / 商标 / 认证结论」 | **超出口径**：只提示「类目层面存在需人工核验的合规风险」，不做法律定性，不给「安全/侵权」结论。 |
| 「实时销量 / 今天卖了多少」 | 数据源是月度粒度且有延迟；只报**数据月份**与抓取时间，不把月度数据说成实时。 |
| 「直接告诉我哪个品能爆」 | 只能给类目机会与进入条件；爆款判断需要单品/供应链/运营信息，超出数据能力。 |
| 「预测明年这个类目增长多少」 | 没有预测模型；只做「历史月份趋势 + 新品占比」的现状描述，明确标注不是预测。 |

> 触发判断：只要用户问的是**类目/细分市场/类目机会**（「XX 类目能不能做」「帮我分析 XX 市场」「找个蓝海类目」），走本技能。单一 ASIN、单一关键词排名、广告诊断，不走本技能。

## 1. 技能目录与参考文件

本 SKILL.md 所在目录即**技能基准目录**。以下都是相对基准目录的路径；加载技能时若返回了 `resourceBase.path`，它就是基准目录，用 **read 工具**读 `<resourceBase>/references/<文件名>.md`。不要凭记忆编造参考文件内容，也不要在回答里整段照抄。

| 相对路径 | 什么时候必须读 |
| --- | --- |
| `references/five-dimension-scoring.md` | 要解释分数、核对档位、处理缺数据降级、写评分表之前 |
| `references/sellersprite-market-guide.md` | 要手工补数（mcp_call）、核对字段/刻度、排查取数异常、读网页登录态（sellersprite-web）取数口径之前 |
| `references/data-rules.md` | 每次输出结论前；涉及缓存、成本告知、缺失值、可追溯性时 |
| `references/report-outline.md` | 要写/改写类目报告、检查报告完整性时 |

技能目录只包含文档，不含可执行脚本；取数一律走插件工具，不要自己写代码模拟数据。

## 2. 开工前确认 4 件事

用户已经说清楚的就跳过，缺什么问什么；**不要**在信息不全时直接跑付费取数。

| 要素 | 默认值 | 对应工具参数 | 为什么要确认 |
| --- | --- | --- | --- |
| 站点 | US | `marketplace` | 站点不同，类目树、价格带、竞争结构都不同，数据不可跨站点拼。 |
| 类目关键词或 NodeIdPath | 无 | `category` 或 `nodeIdPath`（二选一，NodeId 优先） | 关键词可能对应多个类目；能拿到节点路径最稳。 |
| 样本上限 | 50（面板 defaultLimit；范围 10–100） | `limit` | 决定集中度/均值等指标的**抽样口径**；样本不足 100 要在报告里降级标注，真实 N=limit。 |
| 是否需要采购成本 | 否（不传 unitCost） | `unitCost`（USD/件，采购+头程） | 五维里的「利润空间」在传成本时按毛利口径、不传时按类目均价估算（标注「仅供初筛」）。 |

一次性问清，示例（可合并为 1 个问题组）：

```text
1) 站点：默认 US，是否其他站点（UK/DE/FR/IT/ES/CA/JP/MX/AU/IN/AE/BR/SA）？
2) 类目：给英文关键词（如 "wireless microphones"）或 NodeIdPath；不确定的话我先查节点候选给你选。
3) 样本上限：默认 Top 50（范围 10–100）；样本越大越接近类目全貌。
4) 利润：有没有采购+头程成本（USD/件）？没有就按类目均价估算利润空间，报告会标「仅供初筛」。
```

**类目必须下钻**：一级/根类目的汇总数据经常全 0 或严重失真，且不能作为选品依据。用户给的关键词如果落到大类目，先把候选叶子节点（带商品数）列给用户选，再带 `nodeIdPath` 取数；不要擅自替他决定（工具默认选商品数最多的叶子节点，但歧义类目仍需人工确认）。

## 3. 工具契约（v0.1，只有这四个工具）

工具名就下面四个（snake_case）。不要臆造插件工具名：数据源原始工具不是插件工具，只能用 `mcp_call` 间接调用。

### 3.1 `research_provider_status`（免费）

| 项 | 内容 |
| --- | --- |
| 参数 | `provider?`：`'sellersprite'` / `'sorftime'` / `'all'`，默认 `all` |
| 返回 | `{ ok, version, providers:[{ id, label, configured, ok, latencyMs?, lastError, capabilities? }], config:{ marketplace, defaultLimit, outputRoot, provider } }` |
| 特性 | **免费**；未配置 key 时不发网络请求；`ok:false` 表示有数据源不通 |

- 第一次选品、报告提示鉴权失败、或用户问「key 配没配」时先调它。
- 未配置：引导用户打开左侧栏**「选品研究」→ 设置页「亚马逊选品研究」**填写 SellerSprite Secret Key，**不要在对话里索要密钥**。
- `config` 里的 `marketplace/defaultLimit/outputRoot` 就是后续 `research_category_select` 的默认值，读出来告诉用户，避免重复问。

### 3.2 `research_category_select`（核心，付费）

| 参数 | 类型/范围 | 说明 |
| --- | --- | --- |
| `category` | string | 英文类目词（如 `"Cell Phones"`、`"Sofas"`）；与 `nodeIdPath` 二选一 |
| `nodeIdPath` | string | 类目节点路径（如 `"11091801:11974521:8882489011"`）；知道节点时优先传，避免搜错类目 |
| `marketplace` | enum，默认配置 US | `US/UK/DE/FR/IT/ES/CA/JP/MX/AU/IN/AE/BR/SA` |
| `limit` | integer 10–100，默认 50 | 样本/头部商品数量 |
| `month` | string `yyyyMM` | 数据月份，默认最近自然月；未就绪时厂商回退最近月 |
| `unitCost` | number | 单位采购+头程成本（USD/件）；不传则利润维度按价格带估算并标注「仅供初筛」 |
| `outDir` | string | 报告根目录；默认插件配置或「当前工作区/选品研究」 |
| `provider` | `'sellersprite'` / `'sellersprite-web'`，默认 `'sellersprite'` | 数据源链路：`sellersprite` = 卖家精灵官方 MCP（消耗 MCP 额度）；`sellersprite-web` = 用户 Chrome 里已登录的卖家精灵网页版（不消耗 MCP 额度，改为占用网页端查询次数）。选用条件见 Step 1，两条链路的取数差异见 Step 2 |

**返回（成功）**：`{ ok:true, stage:'completed', runId, dir, site, provider, label, nodeIdPath, candidates, score:{ total, max:92, normalized, grade, dimensions, notes }, market:{ totals, avgs, concentration, structure, newRatio }, artifacts:[{name,path,bytes}], warnings, usage:{ calls, errors, totalMs }, reportPath, outputRoot }`。

**返回（失败）**：`{ ok:false, error:{ code, message, hint? } }`，常见 code：

| code | 含义 | 处理 |
| --- | --- | --- |
| `NO_CREDENTIAL` | 数据源 key 未配置 | 引导去设置页；不要重试同一个付费调用 |
| `NODE_NOT_FOUND` | 类目关键词找不到节点 | 换英文词，或让用户从卖家精灵类目页复制 `nodeIdPath` |
| `EMPTY_MARKET` | 市场数据为空（常见根节点/月份未就绪） | 换叶子类目或换月份；根节点全 0 属正常 |
| `INVALID_ARGS` | 参数缺失/非法 | 补 `category` 或 `nodeIdPath`，检查 `limit` 范围 |
| `TOOL_NOT_ALLOWED` / `secret_unauthorized` | 密钥存在但账号未开通 MCP 服务权限 | 改用 `provider:'sellersprite-web'`（先告知占用网页端查询次数）；不要让用户去改密钥 |
| `NOT_LOGGED_IN` | 网页版未登录（Chrome 里没有 sellersprite.com 的登录态） | 提示用户先在 Chrome 登录 sellersprite.com 再重试；不要尝试绕过登录/验证码 |
| `PROVIDER_ERROR` / `SELECT_FAILED` | 厂商业务错误/网络错误/未知失败 | 复述原始错误，按 data-rules 决定是否重试一次 |

**成本（按 `provider` 分两档）**：

- `provider:'sellersprite'`（默认）：一次调用内部会走 **约 9~11 次**数据源调用（`product_node` 1 + `market_research` 1 + 分布 6 + `product_research` 1，失败重试可能更多），**消耗数据服务额度**。
- `provider:'sellersprite-web'`：插件内部记 **3 次页面读取**（选市场 → 类目报告 → 查竞品），**不消耗 MCP 额度**，但**占用卖家精灵网页端的查询次数**（实际计次以网页端为准）。

**调用前必须告诉用户次数与计费方式**，例如：

```text
这一步会跑 1 次类目选品，内部约 9~11 次卖家精灵调用，按你的数据源额度计费（单价以面板设置为准）。继续吗？
```

网页登录态口径：

```text
这一步会跑 1 次类目选品，走你 Chrome 里已登录的卖家精灵网页版：内部读 3 个页面（选市场/类目报告/查竞品），不消耗 MCP 额度，但会占用卖家精灵网页端的查询次数。继续吗？
```

**歧义处理**：返回的 `candidates` 是节点候选（`nodeIdPath/label/products`）。如果用户给的类目词有歧义（如 "phones" 同时命中手机与配件），把前几个候选列给用户确认，选定后带 `nodeIdPath` **重跑一次**——重跑同样约 9~11 次调用，必须再次告知，不要默默重跑。

### 3.3 `research_runs`（免费，只读本地）

| 参数 | 类型/范围 | 说明 |
| --- | --- | --- |
| `action` | `'list'` / `'get'`，必填 | list 列运行；get 读指定运行 |
| `runId` | string，`get` 必填 | 来自 `research_category_select` 返回或 list 结果 |
| `limit` | integer 1–100，默认 30 | list 返回条数 |
| `outDir` | string | 报告根目录，默认取插件配置 |

- list 返回 `{ ok, outputRoot, count, runs:[{ runId, dir, title, kind, site, provider, createdAt, total, max, normalized, grade }] }`。
- get 返回 `{ ok, runId, dir, manifest, scores, reportMd, artifacts }`；`reportMd` 超过 30000 字符会截断，完整报告读 `dir/report.md`。
- **不产生费用**，但只读本地：跨机器/换工作区找不到 run 时，先确认 `outDir` 是否指对。

### 3.4 `mcp_call`（逃生口，付费）

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | `'sellersprite'` / `'sorftime'`，必填 | 数据源 |
| `tool` | string，必填 | 原始工具名，如 `market_seller_type_concentration`、`market_product_demand_trend` |
| `args` | object | 原样转发给 MCP；**卖家精灵多数工具需要 `{"request":{...}}` 包裹** |
| `saveToFile` | boolean，默认 true | 响应超过 60000 字符时落盘为 JSON，返回 `{ savedTo, bytes, preview }` |

- 只在归一层覆盖不到、或用户明确要某个原始工具数据时用；**优先用高层工具**。
- 一次只调一个工具，调用前先读 `references/sellersprite-market-guide.md` 的参数与刻度。
- 每次调用前告知「这是第 N 次付费调用，预计再消耗 1 次调用」；同一字段不要连续重试超过 1 次。
- 补数结果必须记来源（provider、tool、args、抓取时间），写进报告附录；不要用它拼一套未经归一的数字替换 run 的结论。

## 4. 标准流程（5 步，顺序不要乱）

### Step 1｜查数据源状态（免费）

1. 调 `research_provider_status`（可传 `provider:'sellersprite'` 只看一家）。
2. 读 `providers[].configured/ok/lastError` 与 `config.marketplace/defaultLimit/outputRoot`。
3. 未配置/不通 → 先解决（设置页填 key、检查网络/额度），**不要**用 web_search 拼假数据绕过，也**不要**继续付费取数。
4. **MCP 报 `TOOL_NOT_ALLOWED` / `secret_unauthorized`（密钥是好的，但账号没开通 MCP 服务权限）→ 改用网页登录态**：把 `research_category_select` 的 `provider` 改成 `'sellersprite-web'`，插件会驱动用户自己已登录 sellersprite.com 的 Chrome 页面取数。此时：
   - **不消耗 MCP 额度**，但会**占用卖家精灵网页端的查询次数**——照样要按 Step 2 的口径先告知用户再跑；
   - 前提是用户 Chrome 里已登录 sellersprite.com；未登录会返回 `NOT_LOGGED_IN`，提示用户登录后重试，不要尝试绕过登录；
   - 取数内容比 MCP 少（网页版没有 `market_*` 分布工具），价格带/评论数/上架时间分布改由 Top N 样本推导，解读口径见 6.5 节；
   - 这是**同一数据源的另一条链路**，不是绕过鉴权或免费替代：仍走用户自己的账号与额度，不因此放宽任何数据纪律；未告知用户不要擅自切换链路。

### Step 2｜类目取数（付费）

1. 确认 `marketplace`、`category` 或 `nodeIdPath`、`limit`；有采购成本就传 `unitCost`；**确认走哪条链路**（`provider`，默认 `'sellersprite'`）。
2. 按 3.2 节做**付费告知**（两种链路的口径不同，分别告知）。
3. 调 `research_category_select`。典型参数：

```json
{ "category": "wireless microphones", "marketplace": "US", "limit": 50, "unitCost": 8.5 }
```

```json
{ "nodeIdPath": "11091801:11974521:8882489011", "marketplace": "US", "limit": 100 }
```

网页登录态链路（`provider:'sellersprite-web'`）：

```json
{ "provider": "sellersprite-web", "category": "wireless microphones", "marketplace": "US", "limit": 50, "unitCost": 8.5 }
```

4. 读返回：`score` 摘要、`warnings`、`usage.calls`、`runId/dir`、`candidates`。**不要把整个返回原样贴给用户**，摘要即可。
5. 失败按 code 处理（见 3.2 表）；余额不足/402 立即停，不降级、不伪造。

**两条链路的取数差异**（决定了后面怎么解读报告）：

| `provider` | 链路 | 调用量与费用 | 取数内容 | 产物差异 |
| --- | --- | --- | --- | --- |
| `'sellersprite'`（默认） | 卖家精灵官方 MCP | 内部约 **9~11 次**调用，**消耗 MCP 额度** | 节点解析 → 市场大盘 → **6 个 `market_*` 分布工具**（价格带/品牌/评分/评分数/上架时间/卖家国别）→ Top 商品 | 分布是**类目全量口径**；`distributions.sellerType/product/demandTrend` 仍为空（v0.1 未抓） |
| `'sellersprite-web'` | 用户 Chrome 里已登录的卖家精灵网页版 | **3 次页面读取**（选市场 → 类目报告 → 查竞品），**不消耗 MCP 额度**，占用**网页端查询次数** | 选市场页（细分市场列表）→ 类目报告页（类目大盘）→ 查竞品页（Top 商品明细） | **没有 `market_*` 分布工具**：价格带/评论数/评分/上架时间分布由 **Top N 样本推导**；品牌/卖家集中度取页面 **Top3 占比**；`distributions.sellerCountry/sellerType/product/demandTrend` 为空 |

- 网页版链路的 `manifest.provider` = `sellersprite-web`，解读时按 6.5 节的特有口径读；两条链路的 run **不可并列排名**。

### Step 3｜读运行产物（免费）

1. 用 `research_runs` `action:'get'` + `runId` 取 `manifest/scores/reportMd/artifacts`。
2. 解读前**至少读三份**：`report.md`（引擎初稿）、`scores.json`（分数与 inputs/notes）、`market.json`（原始归一数据）。`market.json` 不在 get 返回的解析结果里，用 read 工具按 `artifacts[].path` 或 `dir/market.json` 读。
3. 运行目录约定（`<outDir>/<YYYYMMDD>_<slug>_<站点>/`，重名自动加 `-2`）：

```text
manifest.json   # runId/kind/title/site/provider/nodeIdPath/month/params/usage/fetchedAt/warnings/score
market.json     # 归一化 Market（分析引擎唯一输入）
scores.json     # 五维评分明细（dimensions/total/max/normalized/grade/notes）
report.md       # 引擎生成的报告初稿
dashboard.html  # 内联 CSS/HTML 可视化看板（无 CDN）
tables/         # market.csv / brands.csv / price_bands.csv / top_products.csv
```

4. v0.1 实际抓取的分布只有 6 个：**price / brand / rating / ratingsCount / listingDate / sellerCountry**；`market.json.distributions` 里的 `sellerType/product/demandTrend` 是空数组，**不要解读成「类目没有数据」或「没有竞争」的结论**——需要就走 `mcp_call` 补（见 3.4），补不到就标「未取到」。

### Step 4｜补数与交叉核对（按需，可能付费）

- 归一层没有、但判断确实需要的字段才补数；典型：卖家类型分布、需求趋势、更多品牌明细。
- 先读 `references/sellersprite-market-guide.md` 的参数与刻度，再一次一个 `mcp_call`。
- 补数只用于**解释已有结论**（如某价格带为何销量高），不能替代 run 结论；补数结果标明来源与抓取时间。
- 补数调用前同样做付费告知；同一参数最多重试 1 次。

### Step 5｜五维解读并输出结论

1. 读 `scores.json`：确认 `total/max=92/normalized/grade` 与每维 `inputs/notes`。**不要自己重算分数、不要手改分数**；发现与 `references/five-dimension-scoring.md` 档位不符，标「评分异常待核」并说明影响。
2. 按五维评分参考解释每一维档位；缺数据维度说明「最低档 + 缺口」。
3. 按第 6 节「报告阅读指引」从评分表 → 集中度 → 价格带 → 风险逐项读，形成 3–5 条关键发现，每条都能指回字段/表格。
4. 按第 7 节给三选一结论 + 进入价格带建议 + 最小验证动作 + 数据缺口。
5. 要正式报告时按 `references/report-outline.md` 组织；报告保留 runId、数据月份、抓取时间、数据源。

## 5. 数据纪律红线（违反任意一条，结论作废）

1. **禁止编造** ASIN、商品标题、销量、销售额、价格、评分、评论数、BSR、集中度、上架时间、退货率、增长率。没有就是没有。
2. **缺数据标「未取到」**：字段缺失/为 null/空数组/整列为 0 时写「未取到」或「数据缺口」，不得用 0 或行业常识代替。0 与「未取到」是两件事。
3. **结论必须带出处**：每条关键结论标注**数据来源（SellerSprite / runId）+ 数据月份 + 抓取时间**；报告头部统一写一次，正文引用表格/字段名。
4. **付费先告知**：`research_category_select` 前说明「约 9~11 次内部调用」，`mcp_call` 前说明「第几次、共几次」；用户拒绝/未回应时不要自行加跑。
5. **不跨口径拼数**：不同站点、不同月份、不同样本上限、不同 topNum 的集中度不能混着比；跨 run 只做方向对照并标注口径差异。
6. **不做实时承诺**：数据是月度粒度、可能有延迟；不要写「当前销量」「今天价格」。
7. **比例与百分数分清**：集中度/新品占比等是 0~1 小数，卖家结构/退货率已是百分数；写进报告前统一换算并标注单位（见 `references/sellersprite-market-guide.md`）。
8. **不把样本当全量**：`limit` 为 Top N 时，集中度/均值是**样本口径**；样本 <100 必须在报告与结论里标注「样本不足」。
9. **不碰密钥**：不索要、不回显、不写入报告/日志；密钥只在设置页维护。
10. **不越权做定性**：专利/商标/合规/认证只提示风险点与人工核验方向，不给法律结论。

## 6. 报告阅读指引（拿到产物后按这个顺序读）

> 详细版见 `references/report-outline.md`；这里给「先看什么、看到什么算信号」。

### 6.1 评分表：先判断「结论能不能说」

- 看 `scores.total`、`normalized`、`grade`，以及 `notes` 里缺了哪些维度。
- 缺 1 个维度：可以给结论，但要点名缺口、该维按最低档处理。
- 缺 ≥2 个维度（`scores.json.dataQuality` 为 `C`/`D`，即 `missingDimensions` ≥2）：引擎报告已做**数据质量守卫**——结论区显示「数据质量 C/D（N 个维度缺数）：兜底评级仅供参考，建议补数后再评，不构成进入建议」，不再输出「强烈推荐进入」。你解读时照此执行：给「数据不足，先补数」或「谨慎试验」+ 补数清单，不得改回「推荐进入」；读取历史 run 时以 `dataQuality` 与报告结论区措辞为准（结论区含「补数后再评」即视为已抑制），产物矛盾时按守卫措辞手动降级并注明。
- `normalized` 应 = `total / 92 * 100`；对不上就标「评分异常待核」，不要直接采信。

### 6.2 集中度：判断「有没有头部垄断」

按 `market.concentration` 与 `distributions.brand` 读：

| 信号 | 读法（经验阈值，非行业定律） |
| --- | --- |
| Top3 品牌销量占比 <30% | 分散市场，白牌/新品牌有切入空间 |
| 30%–50% | 中等集中，需要差异化或价格带错位 |
| >50% | 高度集中，先看头部是否靠品牌/评论墙，再决定是否放弃 |
| 商品集中度（Top3 Product）高、品牌集中度低 | 可能是个别链接强、品牌弱，属于「单品可打」结构 |
| 卖家集中度高 | 头部卖家/铺货型卖家控制类目，新卖家流量成本更高 |

同时看 `distributions.sellerCountry`（中国卖家占比高说明供应链近身竞争）。`sellerType`（FBA/FBM/AMZ 占比）v0.1 没抓，需要判断履约门槛时用 `mcp_call` 补 `market_seller_type_concentration`，补不到就标「未取到」。

### 6.3 价格带：判断「从哪个价格进」

- `distributions.price` 按销量占比（`unitsRatio`）排序，占比最高的 1–2 段 = **主流价格带**。
- 主流带销量占比过高（如 >60%）且均价低 → 价格战市场，新进入者毛利承压。
- 高价带销量占比低但 revenue 占比不低 → 可能有**利润缝隙**，结合评分数分布看是否被高评论产品把守。
- 低价带与高价带都大、中价带空心 → 定位机会或成本结构异常，先别当机会，查产品结构。

### 6.4 风险面：判断「该不该劝退」

| 风险项 | 读法 |
| --- | --- |
| Amazon 自营占比高 | `structure.amazonSelfProportion` >30% 时头部自营挤压第三方；>40% 建议降档 |
| 退货率高 | `structure.returnRatio` 明显高于同类目时，先查产品是否易损/尺码/功能问题 |
| 评论墙 | `distributions.ratingsCount` 高评论段销量占比高 → 新品冷启动成本高 |
| 品牌垄断 | 品牌 CR3/CR10 持续走高（对比历史 run）→ 窗口在收窄 |
| 季节性 | `distributions.demandTrend` v0.1 为空；需要判断时 `mcp_call` 补 `market_product_demand_trend`，补不到标「未取到」，不要凭印象下季节性结论 |
| 数据缺口 | `warnings` 非空、关键维度缺失 → 结论降档并列出待补数据 |
| 合规敏感 | 类目涉及认证/审核（儿童、电子、医疗宣称）→ 提示人工核验，不做定性 |

引擎 `report.md` 第六章还会给「一票否决提示」初筛检查：类目容量 <$1M、Top3 品牌占比 ≥60%、Amazon 自营 ≥40%、均价 <$15、品牌 HHI ≥2500（0~10000）、退货率 >10%。**触发 ≠ 自动否决**（需人工复核），但结论必须降档或在风险章里明确列为待核项。

### 6.5 网页登录态（sellersprite-web）产物的特有口径

`provider:'sellersprite-web'` 跑出的 run，`manifest.provider` = `sellersprite-web`。**不要**照搬 MCP 版的「类目全量分布」解读，按下表读：

| 指标 | web 版口径 | 报告/结论怎么写 |
| --- | --- | --- |
| 类目月销额 | **估算值** = 「子市场月总销量 × 类目均价」（网页版不直接给节点级月销额）；取不到子市场销量时退化为「样本商品数 × 近30天均量」的样本口径（`market.scaleBasis` = `submarket_sum` / `sample`） | 必须写「**估算**」并给出公式与输入（子市场销量、均价）；`sample` 口径时点名规模维度按缺数/最低档处理 |
| 品牌 HHI | **Top N 样本内**的品牌销量份额计算（`distributions.brandCoverage='sample'`），引擎标 `estimated` | 写「HHI xxxx（**样本口径，N=xx，估算值**）」；**不要**说成类目全量品牌集中度，也别直接和 2500 的一票否决阈值硬比 |
| 类目级品牌集中度 | 以**页面 Top3 品牌占比**（`concentration.top3BrandCrn`）为准 | 引用页面 Top3 品牌占比作为类目级集中度依据；Top5/Top10 品牌集中度网页版未取到 → 标「未取到」 |
| 卖家集中度 | 同理取页面 Top3 卖家占比（`concentration.top3SellerCrn`） | 标「页面 Top3 卖家占比」；不推算 CR5/CR10 |
| 新品占比 | 页面「新品占比」对应**页面当前的新品定义窗口（默认 1 个月）**；只落到 `newRatio.l1`，`l3/l6/l12` 未取到 | 写明窗口，如「新品占比 x%（页面口径：1 个月内上架）」；**不可**与 6 个月口径直接比较，也不当成长趋势 |
| 价格带/评论数/评分/上架时间分布 | 由 **Top N 样本**推导（N 取实际取到的商品数，不是 `limit`），非类目全量分布 | 分布表标题标「Top N 样本推导口径」；样本 <100 按样本不足降级 |
| 卖家国别/卖家类型/商品集中度/需求趋势分布 | 网页版**没有对应页面**，分布为空数组 | 一律写「未取到」，**不要**解读成「没有竞争」「无季节性」；需要时改走 MCP 链路补数 |
| 数据月份 | 网页版取最近可分析月，`manifest.month` 为空串 | 写「最近已就绪自然月（未显式指定）」，不要编一个具体月份 |

补充说明：

- 网页版的品牌明细、价格带等是**插件按固定阈值自行分桶**（价格带 0-15/15-30/30-50/50-100/100+，评论数 0-50/51-100/101-300/301-1000/1001+），报告写「按插件分桶（Top N 样本推导）」，不要写成「卖家精灵分布」。
- 网页版 run 与 MCP 版 run **不可并列排名**：口径不同，跨链路只做方向对照并标注口径差异。

## 7. 结论与话术（三选一，不允许模糊）

| 结论 | 触发条件（需同时满足） | 必须附带 |
| --- | --- | --- |
| **推荐进入** | grade 为优秀/良好（normalized ≥60）；无「降档」项；数据质量 A/B | 进入价格带 + 差异化方向 + 首批验证动作 + 风险清单 |
| **谨慎试验** | normalized 40–59，或存在 1 个降档项（Amazon 自营高 / 品牌 CR3 高 / 数据缺口 / 季节性风险） | 为什么降档 + 最小验证方案（小批量/单价格带/先测 1–2 个 SKU）+ 观察指标 |
| **放弃** | normalized <40，或命中硬伤（Amazon 自营 ≥40% 且第三方无空间 / 品牌 CR3 ≥60% 且评论墙高 / 核心数据缺失无法判断 / 用户目标与该类目利润结构明显不符） | 放弃理由（数据点）+ 替代方向（相邻类目/价格带） |

**降档规则**：任何一条成立就最多给「谨慎试验」，不够格给「推荐进入」：

- Amazon 自营占比 ≥40%（引擎一票否决检查的口径）；
- Top3 品牌销量占比 ≥60%（且 Top10 也高）；
- 关键维度（市场规模/利润空间/竞争烈度）有 ≥1 项缺失且无法补；
- 数据月份与用户目标月份不符且没有可比历史；
- 用户明确说预算/供应链不支持该类目的主流价格带。

**结论必须能追溯**：每个判断后面跟「依据：字段 = 数值（数据月份）」。示例：

```text
结论：谨慎试验（normalized 55.4，一般）
依据：样本月销额 $0.9M（规模 10 分档）；Top3 品牌销量占比 35.0%（中等集中）；
     均价 $35.2，主流价格带 $20–40 占销量 62.5%；
     低评论销量占比 15.0%（新品空间有限）；Amazon 自营 25.0%（挤压中等）。
缺口：卖家类型分布未取到（v0.1 未抓），不影响主结论但影响履约门槛判断。
动作：先做 $30–45 价格带 1–2 个差异化 SKU，首批 200–300 件，用 8 周验证评论与动销。
```

## 8. 常见问题（FAQ）

### 8.1 类目根节点统计全 0

- 原因：根/一级节点在数据源里没有有效汇总，或该节点不是可分析节点（`EMPTY_MARKET`）。
- 处理：换**叶子节点**（有商品数、有 Top 商品样本）重跑；工具会把候选放在返回 `candidates` 里，把候选路径给用户确认后再带 `nodeIdPath` 重跑。根节点全 0 时报告写「该节点无有效数据」，不要用 0 当结论。

### 8.2 集中度/占比刻度换算

- `top*Crn`、`l*NewRatio`、`unitsRatio` 等是 **0~1 小数**：展示时 ×100 加 %。
- `fbaProportion/fbmProportion/amazonSelfProportion/returnRatio` **已是百分数**：不要再 ×100。
- 报告里统一写「xx.x%」并标口径；同一张表不要混「0.32」和「32%」。

### 8.3 月份未就绪 / 数据月份不对

- 默认取最近已就绪自然月；`manifest.month` 可能为空串（表示未显式传 `month`），报告写「最近已就绪自然月（未显式指定）」并注明这是**取数口径假设**，不要编一个具体月份。
- 用户指定 `month` 但数据异常：最多回退一个月重试一次；仍不行就报「该月份未取到」，不要用相邻月份冒充。
- 不同 run 月份不同时只能做方向对照，不能直接比大小。

### 8.4 评分看起来不合理

- 先查 `scores.json` 的 `inputs`/`notes`：常见原因是字段缺失按最低档处理、样本上限过小、把百分数/小数弄反、或没传 `unitCost` 导致利润维按价格带估算。
- 不要手动改分；把「哪一维、期望档位、实际档位、inputs 值」列出来，按 data-rules 标异常并说明影响。
- 确认是引擎口径问题就反馈插件维护者（Lead），不要私自在报告里改数字。

### 8.5 付费调用失败

- `NO_CREDENTIAL`/401：让用户去设置页检查 key；**不要让用户在对话里贴密钥**。
- `TOOL_NOT_ALLOWED`/`secret_unauthorized`：密钥没问题，是账号没开通 MCP 服务权限 → 改用 `provider:'sellersprite-web'`（先告知占用网页端查询次数）。
- `NOT_LOGGED_IN`：让用户先在 Chrome 登录 sellersprite.com 再重试；不要尝试绕过登录。
- 402/余额不足：停下，告知用户去数据源账户处理；**禁止**编造结果或降级为「估算」。
- 429/5xx/超时：最多重试 1 次（工具内部已有重试），仍失败就报错并保留已完成的部分产物。
- 任何情况下都不要为了「凑一个结果」连点付费工具。

### 8.6 用户只给中文类目名

- 先问/检索对应英文类目名；数据源类目以英文节点路径（`nodeLabelPath`）为准，中文翻译（`nodeLabelLocale`）不可靠，不能作为判断依据。
- 拿不准的英文名，把候选节点路径给用户确认，不要猜一个相近类目直接跑。

### 8.7 用户要「上次的报告」

- 先 `research_runs` `action:'list'` 找 run，再用 `action:'get'` 取；报告可能截断，完整文件读 `dir/report.md`。
- `outDir` 不对会 list 为空：确认面板设置的输出根目录或用户当时传的 `outDir`。

### 8.8 网页版与 MCP 版结果对不上

- 先看 `manifest.provider`：两条链路口径不同（MCP 的分布是类目全量，网页版是 Top N 样本推导，且月销额是估算值），数字对不上是正常的口径差异，不是数据错。
- 处理：按本次 run 的 provider 用对应口径解读；**不要**把两次 run 的数字并列排名、相减或互相印证。
- 要对齐口径就重跑同一条链路（同 provider + 同站点 + 同 nodeIdPath + 同 limit + 同 unitCost）。

## 9. 产物、落盘与协作

- 运行目录由插件生成（默认「当前工作区/选品研究」，可在面板设置输出根目录）。**不要**把报告写到 `~/.dsh` 或插件安装目录。
- 报告初稿由引擎生成；Agent 的职责是**解读、补缺、重写结论**，不是重造数据。
- 需要交付文件时：优先用运行目录里的 `report.md`（必要时另存用户指定目录），附上 runId、manifest 的 params/fetchedAt、warnings。
- 多个类目横向对比时：用**同一站点、同一月份、同一样本上限**各跑一个 run，再按汇总表比较；口径不同的不并列排名。
- v0.1 没有单品/关键词/评论/广告类高层工具；用户要这些能力时说明「本版本不做，后续版本扩展」，不要用 `mcp_call` 硬凑出一份超出类目选品范围的报告。

## 10. 质量自检（输出前逐条过）

- [ ] 站点/类目/NodeIdPath/数据月份/抓取时间/runId 全在报告头部。
- [ ] 五维分数与 `scores.json` 一致，总分按 92 归一化，评级用 ≥80/≥60/≥40 阈值。
- [ ] 每个关键结论都有字段依据；没有「我感觉」「行业普遍」式结论。
- [ ] 缺失字段全部标「未取到」，没有用 0 或常识替代。
- [ ] 集中度/占比换算正确，单位统一。
- [ ] 样本上限已标注；样本 <100 时结论已降级说明。
- [ ] 风险面至少覆盖：Amazon 自营、品牌集中度、评论墙、退货率、季节性/数据缺口。
- [ ] 结论是「推荐进入 / 谨慎试验 / 放弃」之一，并附进入价格带/验证动作/风险；缺 ≥2 维（`dataQuality` C/D）时未输出「推荐进入」。
- [ ] 付费调用次数与结果已记录；报告未出现密钥。
- [ ] 没有越界写单品 Listing/专利/合规结论。
- [ ] 网页登录态 run：估算值已标「估算」、样本分布已标 N、HHI 已标样本口径（estimated）、网页版没有的分布已标「未取到」。

## 11. 参考文件（Read next）

| 相对路径 | 内容 |
| --- | --- |
| `references/five-dimension-scoring.md` | 五维档位表、92 分归一化与评级、缺失降级规则、完整算例 |
| `references/sellersprite-market-guide.md` | market_research 与 15 个 market_* 工具、必填参数、字段刻度、实测陷阱、MCP→Market 映射 |
| `references/data-rules.md` | 数据来源/时间戳、缺失值、缓存、成本告知、禁止伪造字段、质量分级 |
| `references/report-outline.md` | 报告章节骨架、每章要点、格式规范、交付检查清单 |

> 版本：插件 v0.1 第一版，仅 SellerSprite 数据源。后续版本再扩展单品 Listing 体检、关键词/评论数据源与历史对比。
