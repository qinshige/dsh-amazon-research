# 浏览器与取数手册

## A0. 取数优先级（不要越级）

1. **插件工具**：research_category_select（类目大盘与分布）、research_unit_cost（1688 采价）、research_product_select（体检与报告）。
2. **卖家精灵网页登录态**：用户 Chrome 已登录 www.sellersprite.com 时可用（provider=sellersprite-web），不耗 MCP 额度。
3. **用户手动导出 CSV**：卖家精灵 / H10 / 浏览器另存 → 直接喂给 research_product_select（action=screen）。
4. **浏览器 MCP**：只有本会话出现 mcp__playwright__* 这类工具时才存在；不要臆造 browser_navigate。
5. **web_fetch / web_search**：只用于静态页、政策页、专利/合规页。亚马逊榜单/搜索/详情页重度 JS，web_fetch 大概率取不到，不要硬凑。
6. **人工兜底**：登录墙、验证码、机器人校验 → 请用户手动完成，不绕过、不硬刷。

任何情况下，没真实取到的字段留空并标「未取到」。

## A1. 站内 URL 模式

域名随站点：US=amazon.com、UK=amazon.co.uk、DE=amazon.de、FR=amazon.fr、IT=amazon.it、ES=amazon.es、
CA=amazon.ca、JP=amazon.co.jp、MX=amazon.com.mx、AU=amazon.com.au、IN=amazon.in、AE=amazon.ae、BR=amazon.com.br。
`amazon.sa` 只用于沙特找品（`research_saudi_discovery`），不作为 Amazon 选品站点：沙特销售平台固定 Trendyol.sa。

榜单路径（node 取 nodeIdPath 末段）：

    https://www.amazon.com/gp/bestsellers/<node>
    https://www.amazon.com/gp/new-releases/<node>
    https://www.amazon.com/gp/movers-and-shakers/<node>
    https://www.amazon.com/gp/most-wished-for/<node>
    https://www.amazon.com/gp/gift-ideas/<node>
    https://www.amazon.com/deals
    https://www.amazon.com/s?k=<keyword>

直接调 research_product_select（action=plan）可以一次拿到这些链接。

## A2. 每个页面抓什么

| 页面 | 必抓字段 |
| --- | --- |
| 榜单页 | ASIN、标题、品牌、售价、评分、评论数、BSR/榜单排名、卖家类型 |
| 新品榜 | 上架时间（或首次出现时间）、排名变化、评论数、售价 |
| 飙升榜 | 24h 排名变化幅度、当前排名、价格、评论数 |
| 搜索页 | ASIN、标题、价格、评分、评论数、是否广告位、Coupon |
| 详情页 | 变体数、尺寸重量、FBA 费、卖家、上架时间、差评关键词 |
| 店铺页 | 卖家类型、在售类目、其他 ASIN、反馈数 |

## A3. 反爬与登录

- 出现验证码 / 限流 / 拒绝访问：立即停止，提示用户人工处理，不换 IP、不绕验证。
- 同一页不要高频刷新；批量抓取放慢节奏，单次 30–60 个候选为宜。
- 未登录时榜单只显示部分内容：以用户手动导出或卖家精灵为准。

## A4. 从榜单到采集表

1. 先定叶子类目（nodeIdPath），再打开对应榜单。
2. 每个入口取 10–20 个 ASIN，去重后合并。
3. 按 assets/selection-table-template.csv 填字段；拿不到的留空。
4. 调 research_product_select（action=screen）出体检报告。
5. 对一档/二档候选调 research_unit_cost 采 1688 真实采购价。

## A5. 1688 采价

用 research_unit_cost。注意：
- 每个关键词 1 次搜索页；每个进详情页验证的 offer 再加 1 次页面请求。
- 采购价只取详情页阶梯价；搜索页卡片价要标注「未验证」。
- 多件装要换算到 Amazon 的可售单位（包装数对齐），否则采购成本会低估 10–100 倍。
