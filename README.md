# dsh-amazon-research

亚马逊选品研究插件（DeepSeek Harness）：**Amazon 品类选品** 全流程 —— 类目节点解析 → 市场大盘与分布数据 → 五维评分（上游 92 分制归一化）→ Markdown/CSV/HTML 报告 → 侧栏面板查看。

> 方法论参考 [liangdabiao/amazon-sorftime-research-MCP-skill](https://github.com/liangdabiao/amazon-sorftime-research-MCP-skill)（上游无 LICENSE，本插件为独立实现，仅继承其分析框架思路）。

## 能力（v0.1.2）

| 工具 | 作用 | 费用 |
|---|---|---|
| `research_provider_status` | 检查数据源密钥/连通与插件配置 | 免费 |
| `research_category_select` | 品类选品全流程（MCP 链路 9~11 次调用 / 网页链路 3 次页面读取） | 消耗额度 或 网页端查询次数 |
| `research_runs` | 列出/读取历史运行与报告产物 | 免费 |
| `research_unit_cost` | 1688 采价：搜货源 + 进详情页验证阶梯价/起批量/材质/件重/代发 | 1688 网页端查询次数 |
| `mcp_call` | 直接调用数据源 MCP 工具（逃生口） | 消耗额度 |

内嵌技能 `amazon-category-selection`：装好即可被模型发现，无需手动拷贝到 `~/.dsh/skills`。

**两个数据源口径**：

| provider | 取数方式 | 消耗 | 何时用 |
|---|---|---|---|
| `sellersprite` | 卖家精灵官方 MCP | 9~11 次调用 / 次（额度） | 账号已开通 MCP 服务权限 |
| `sellersprite-web` | 用户 Chrome 里已登录的卖家精灵**网页版** | 网页端查询次数 | MCP 报 `TOOL_NOT_ALLOWED` / `secret_unauthorized` 时 |

`research_category_select` 传 `provider` 切换。网页版读取用户自己的登录态，不绕过任何鉴权；
它能取到「选市场 / 类目报告 / 查竞品」三页数据，但没有 `market_*` 分布工具——
价格带、评论数、上架时间分布由 **Top N 样本推导**，报告会显式标注口径。

**1688 采价链路**（v0.1.2 起）：

| 工具 | 作用 | 消耗 |
|---|---|---|
| `research_unit_cost` | 按子市场关键词去 1688 搜货源、进详情页验证阶梯价/起批量/材质/件重/代发，出采购价明细 | 1688 网页端查询次数（搜索页有频控） |

`research_category_select` 的 `costs` 参数可直接喂入采价结果，把「利润空间」维度从「按均价档位兜底」换成**真实全成本净利率**（售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它）。

⚠️ **包装规格对齐**：1688 的入口价几乎都是单件价，Amazon 售价对应的是一个可售单位（脚垫常见 48/104/162 片装）。必须先取 1688 的多件装档、再按 Amazon 侧实测包装数换算，否则采购成本会被低估 10~100 倍。插件的 `tables/pack_alignment.csv` 会写出这层推导。

## 安装（本地开发）

```bash
cd /path/to/dsh-amazon-research
dsh plugin --profile desktop add "$(pwd)"
dsh --profile desktop --dump-config | grep -A3 amazon-research
# 重启 DeepSeek Harness（Host 代码必须重启；Client 半刷新页面即可）
```

## 配置

1. 打开左侧栏「选品研究」→ 设置页，填写卖家精灵 SellerSprite Secret Key（写入 `ctx.credentials`，不回显、不进日志）。
2. 也可用环境变量 `SELLERSPRITE_SECRET_KEY` 或插件数据目录 `$DSH_HOME/amazon-research/secrets.json`（0600）。
3. 默认站点/样本上限/输出目录在设置页修改，存 `$DSH_HOME/amazon-research/config.json`。

## 产物

```
<outDir>/<YYYYMMDD>_<slug>_<站点>/
  manifest.json    # 运行元数据、调用次数、警告、评分
  market.json      # 归一化市场数据（含原始行）
  scores.json      # 五维评分明细
  report.md        # 中文选品报告
  dashboard.html   # 内联 CSS 图表
  tables/*.csv     # 品牌 / 价格带 / 头部商品
```

默认输出目录：插件配置的 outputRoot；未配置时用宿主 cwd 下的 `选品研究/`，再兜底 `$DSH_HOME/amazon-research/runs`。

## 评分口径

沿用上游五维模型：市场规模 20 / 增长潜力 25（实际最高 22）/ 竞争烈度 20（实际 18）/ 进入壁垒 20 / 利润空间 15（实际 12），合计上限 **92**。
评级按 `normalized = total / 92 * 100`：≥80 优秀、≥60 良好、≥40 一般、<40 较差。
报告的分数同时写 `score/max` 与归一化值，不伪装成 100 分制。

## 开发

```bash
npm test                       # 单测（不联网）
node --check index.js
```

开发期示例脚本（`scripts/`）用于「不重复打数据源、只重算利润维度」这类场景，全部用环境变量指定路径：

```bash
DSR_PACKS_OUT=.cache/amazon-packs.json node scripts/fetch-amazon-packs.mjs
DSR_SKUS_OUT=.cache/offer-skus.json  node scripts/fetch-offer-skus.mjs
DSR_PACKS_IN=.cache/amazon-packs.json DSR_PROFIT_OUT=.cache/profit-input.json \
  node scripts/align-profit-input.mjs
DSR_CACHE_MARKET=<上一轮 market.json> DSR_PROFIT_INPUT=.cache/profit-input.json \
  DSR_OUTPUT_ROOT=<输出目录> node scripts/reprice.mjs
```

目录：

```
index.js            # 插件入口（tools / skills / systemPrompt / routes）
host/               # 宿主半边：MCP 客户端、数据源、归一化、评分、报告、运行目录
skills/             # 内嵌技能（SKILL.md + references）
client.js           # 侧栏面板（Client 半）
test/               # node:test 单测与 fixtures
```

## 已知限制

- 当前只做品类选品；ASIN 体检 / 词库 / 差评 / Listing builder 在后续版本。
- 只接入了卖家精灵（用户自备 key）；Sorftime 适配代码保留但未验收。
- 利润维度未接 1688 采购成本时按价格带估算，报告会显式标注「仅供初筛」。
- 1688 搜索页有频控：连跑约 5 个关键词会撞滑块验证码。插件**不绕过验证码**，命中即抛 `CAPTCHA`；详情页基本不拦。
- 网页登录态链路（`sellersprite-web`）依赖 macOS + Google Chrome + AppleScript，其他平台需自行实现 `host/web/chrome.js`。
- 网页链路没有 `market_*` 分布工具，价格带/评论数/上架时间分布由 **Top N 父体样本推导**，报告已标注口径；与 MCP 链路的 run 不可并列排名。
- 包装规格对齐依赖 Amazon 前台搜索页标题实测（每细分约 48 条结果）；样本不足的细分（如 Tarps）已在报告标注置信度低。