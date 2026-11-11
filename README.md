# dsh-amazon-research

**DeepSeek Harness 插件 · 亚马逊品类选品研究**

把「这个美国站类目能不能进」从经验判断变成可复核的数据结论：类目节点解析 → 市场大盘与分布数据 → 五维评分 → 全成本净利测算 → 中文选品报告 → 侧栏面板查看。

```
卖家精灵（MCP / 网页登录态）        1688（详情页验证）
        ↓                                  ↓
   类目大盘 · 分布 · Top 商品         采购价 · 起批量 · 件重
        └──────────────┬───────────────────┘
                       ↓
          五维评分（92 分制归一化）+ 全成本净利率
                       ↓
        report.md · scores.json · dashboard.html · tables/*.csv
```

---

## 这个插件解决什么问题

跨境选品里最贵的错误不是「选错品」，而是**用错口径算出来的利润**。市面上的选品报告普遍有两个洞：

1. **利润用毛利率冒充净利率** —— 毛利率只扣采购成本，不扣佣金、广告、退货、头程、FBA。一个毛利率 60% 的品，算完全成本可能是 −9%。
2. **采购价拿单件价对多件装售价** —— 1688 上脚垫 ¥0.25/个是单件价，Amazon 卖的是 48/104/162 片装。直接相减会把采购成本低估 10~100 倍。

本插件的每一个数字都带口径标注，取不到就写「未取到」，**不用经验值补齐**。

---

## 能力

| 工具 | 作用 | 消耗 |
|---|---|---|
| `research_provider_status` | 检查数据源密钥/连通与插件配置 | 免费 |
| `research_category_select` | 品类选品全流程 | MCP 链路 9~11 次调用 ／ 网页链路 3 次页面读取 |
| `research_unit_cost` | 1688 采价：搜货源 + 进详情页验证阶梯价/起批量/材质/件重/代发 | 1688 网页端查询次数 |
| `research_runs` | 列出/读取历史运行与报告产物 | 免费 |
| `mcp_call` | 直接调用数据源 MCP 工具（逃生口） | 消耗额度 |

内嵌技能 `amazon-category-selection`：装好即可被模型发现，无需手动拷贝到 `~/.dsh/skills`。

---

## 方法论

### 一、五维评分（92 分制）

五个维度独立打分，**原始上限 92 分**（不是 100），归一化后给出评级：

| 维度 | 满分 | 看什么 |
|---|---|---|
| 市场规模 | 20 | 月销额、销量、在售商品数 |
| 增长潜力 | 22 | 低评论商品销量占比、需求趋势 |
| 竞争烈度 | 18 | Top3 品牌/商品/卖家集中度、品牌 HHI |
| 进入壁垒 | 20 | Amazon 自营占比、新品占比、评论壁垒 |
| 利润空间 | 12 | 全成本净利率（见下） |

```
归一化 = 总分 ÷ 92 × 100
评级：≥80 优秀 ／ ≥60 良好 ／ ≥40 一般 ／ <40 较差
```

**缺数不编造**：某维度取不到数据就按该维度最低档计，并在报告里写明「按最低档计（不编造数据）」。缺 ≥2 个维度时结论降级为「数据质量 C，补数后再评」，不再输出「强烈推荐」。

**HHI 是品牌级口径**（0~10000）。按商品级份额算 HHI 是常见错误，会把集中度严重低估。

### 二、全成本净利测算

利润空间维度用**净利率**而非毛利率：

```
净利率 = (售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它) ÷ 售价
```

判定红线：

| 红线 | 阈值 |
|---|---|
| 净利率 | > 25% 才考虑；体量小（100~200 单）需 > 30% |
| 物流占售价（头程+FBA） | 10%~15% 为理想带；> 20% 提示放弃 |
| 采购价占售价 | ≤ 25% |
| $15~20 售价段 | 采购价 ≤ ¥30 且 FBA < $4.5 |

估算参数（汇率、头程 ¥/kg、佣金、广告、退货、其它）全部在报告里标注「估算值」；采购价、件重、起批量、材质、代发来自详情页真实文本，标注「实测值」。

### 三、包装规格对齐（最容易出错的一环）

1688 的入口价几乎都是**单件价**，Amazon 售价对应的是**一个可售单位**。插件的处理：

1. 从 1688 详情页取**多件装档**（例：`4个装¥1 / 8个装¥2.2 / 16个装¥4.5 / 20个装¥5.5`）
2. 从 Amazon 前台搜索页标题**实测包装数**（每细分约 48 条结果取中位）
3. 按目标包装数选整包数，算出「一个可售单位的真实采购成本」

三种特殊档位都单独处理：规格写成「1件/20个」的（脚垫，¥0.35 是整件价）、按面积计价的（篷布，¥5.5/9 平方）、物流包装当售卖规格的（拉手，200个/盒）。

推导过程写入 `tables/pack_alignment.csv`。

### 四、数据来源与频率

| 数据 | 来源 | 频率 |
|---|---|---|
| 类目大盘、分布、Top 商品 | 卖家精灵 | 每次运行 |
| 采购价、阶梯价、件重、材质 | 1688 详情页 | 每次采价 |
| Amazon 可售单位包装数 | Amazon 前台搜索页 | 每次对齐 |

---

## 数据源

### 卖家精灵：两条链路

| provider | 取数方式 | 消耗 | 何时用 |
|---|---|---|---|
| `sellersprite` | 卖家精灵官方 MCP | 9~11 次调用/次（额度） | 账号已开通 MCP 服务权限 |
| `sellersprite-web` | 你 Chrome 里已登录的卖家精灵**网页版** | 网页端查询次数 | MCP 报 `TOOL_NOT_ALLOWED` / `secret_unauthorized` 时 |

`research_category_select` 传 `provider` 切换。

网页链路读取**你自己的登录态**，不绕过任何鉴权、不过验证码、不破解限制。它能取到「选市场 / 类目报告 / 查竞品」三页数据，但没有 `market_*` 分布工具——价格带、评论数、上架时间分布由 **Top N 父体样本推导**，报告会显式标注口径。

> 两条链路的分布口径不同（一个是类目全量，一个是样本推导），**两次 run 的分数不可并列排名**。

### 1688

`research_unit_cost` 按子市场关键词搜索货源，进入详情页逐项验证：阶梯价、起批量、材质、SKU 变体、件重、包装尺寸、供应商、一件代发标识。

**搜索页有频控**（连跑约 5 个关键词会撞滑块验证码），插件命中即抛 `CAPTCHA` 并停手；详情页基本不拦。

---

## 安装

```bash
# 从 GitHub 克隆
git clone https://github.com/qinshige/dsh-amazon-research.git
cd dsh-amazon-research

# 装进 profile
dsh plugin --profile desktop add "$(pwd)"
dsh --profile desktop --dump-config | grep -A3 amazon-research

# 重启 DeepSeek Harness（Host 半必须重启；Client 半刷新页面即可）
```

---

## 配置

1. 左侧栏「选品研究」→ 设置页，填写卖家精灵 SellerSprite Secret Key
   （写入 `ctx.credentials`，不回显、不进日志）
2. 也可用环境变量 `SELLERSPRITE_SECRET_KEY` 或 `$DSH_HOME/amazon-research/secrets.json`（0600）
3. 默认站点、样本上限、输出目录在设置页修改，存 `$DSH_HOME/amazon-research/config.json`

输出目录不能设在宿主 profile 或应用包内部（设置页会拒绝）——那种路径报告写出来你也找不到。

---

## 产物

```
<输出目录>/<YYYYMMDD>_<slug>_<站点>/
  manifest.json              # 运行元数据、调用次数、警告、评分
  market.json                # 归一化市场数据（含原始行）
  scores.json                # 五维评分明细
  report.md                  # 中文选品报告（七章 + 采购测算章）
  dashboard.html             # 内联 CSS 看板
  tables/sub_markets.csv     # 细分市场
  tables/top_products.csv    # Top 商品明细
  tables/sourcing_1688.csv   # 1688 采价明细
  tables/profit_by_submarket.csv   # 全成本拆解与净利率
  tables/pack_alignment.csv  # 包装规格对齐推导
```

输出目录优先级：工具显式 `outDir` > 设置页 `outputRoot` > 宿主工作区下的 `选品研究/` > `$DSH_HOME/amazon-research/runs`。

每次运行会登记到 `$DSH_HOME/amazon-research/run-index.json`，因此**即使产物落在别处，侧栏面板也能列出**。

---

## 开发

```bash
npm test                # 90 条单测，全部离线不联网
node --check index.js
node --check client.js
```

```
index.js            # 插件入口（tools / skills / systemPrompt / routes）
host/               # 宿主半：MCP 客户端、数据源、归一化、评分、报告、采价、成本模型
host/web/           # 网页登录态链路（Chrome 驱动 + 页面抽取片段）
host/sourcing/      # 1688 采价 + 全成本模型
skills/             # 内嵌技能（SKILL.md + references）
client.js           # 侧栏面板（Client 半）
scripts/            # 开发期示例脚本（路径全部走环境变量）
test/               # node:test 单测与 fixtures
CONTRACTS.md        # 内部接口契约
CONTRACTS-2.md      # 采价与利润重算的接口契约
```

开发期示例脚本用于「不重复打数据源、只重算利润维度」：

```bash
DSR_PACKS_OUT=.cache/amazon-packs.json node scripts/fetch-amazon-packs.mjs
DSR_SKUS_OUT=.cache/offer-skus.json  node scripts/fetch-offer-skus.mjs
DSR_PACKS_IN=.cache/amazon-packs.json DSR_PROFIT_OUT=.cache/profit-input.json \
  node scripts/align-profit-input.mjs
DSR_CACHE_MARKET=<上一轮 market.json> DSR_PROFIT_INPUT=.cache/profit-input.json \
  DSR_OUTPUT_ROOT=<输出目录> node scripts/reprice.mjs
```

---

## 已知限制

- 当前只做**品类选品**；ASIN 体检 / 词库 / 差评分析 / Listing builder 在后续版本
- 只接入了卖家精灵（自备 key）；Sorftime 适配代码保留但未验收
- 利润维度未接 1688 采购成本时按价格带估算，报告会显式标注「仅供初筛」
- 网页登录态链路依赖 macOS + Google Chrome + AppleScript，其他平台需自行实现 `host/web/chrome.js`
- 网页链路没有 `market_*` 分布工具，分布由 Top N 父体样本推导（已标注口径）
- 包装规格对齐依赖 Amazon 前台搜索页标题实测；样本不足的细分（如 Tarps 仅 1 条）已标注置信度低
- 1688 搜索页频控约 5 个关键词；命中验证码即停手报错，不绕过

---

## 数据纪律

本插件遵循三条硬规则：

1. **所有数字必须来自工具返回**，缺失写「未取到」并说明，不用常识补齐
2. **每次结论附数据来源与抓取时间**，估算值与实测值分开标注
3. **不用经验值代替缺失数据**——缺就降级结论，而不是猜一个

---

## License

MIT © qsg
