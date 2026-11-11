# 五维评分标准（92 分制）

> 口径已冻结（与 `host/scoring.js` 对齐）：**满分上限 92**，`normalized = total / 92 * 100`。
> 不要按 100 分制解释，也不要把「标准满分」25/20/15 当成实际可得分上限。上游表里写 100 分是名义值，实际最高档之和就是 92。

## 1. 维度总览

| # | key | 维度 | 标准满分* | **实际满分** | 核心指标 | 缺失时档位 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `market_size` | 市场规模 | 20 | **20** | 样本月销额 `totals.revenue` | 10 |
| 2 | `growth_potential` | 增长潜力 | 25 | **22** | 低评论产品销量占比 `lowReviewShare` | 14 |
| 3 | `competition` | 竞争烈度 | 20 | **18** | Top3 品牌销量占比 `top3BrandCrn` | 8 |
| 4 | `entry_barrier` | 进入壁垒 | 20 | **20** | Amazon 自营占比 + 低评论占比 | 6（3+3） |
| 5 | `profit_margin` | 利润空间 | 15 | **12** | 类目均价，或均价与采购成本估算的毛利率 | 4 |
| — | — | **合计** | 100（名义） | **92** | — | 42（全缺） |

* 标准满分来自上游评分表的名义分值；**实际满分**才是各维最高档能达到的分数，也是 `scores.json` 里 `dimensions[].max` 的值。报告里两个口径都要标清楚，避免读者拿 100 减分数。

- 关键字段在 `scores.json` 的 `dimensions[].inputs` 里；所有 `*Crn`/`share`/`ratio`/`grossMargin` 是 **0~1 小数**，只有 `Market.structure.*`（如 `amazonSelfProportion`）是**百分数 0~100**（score 内部 ÷100）。
- 缺数据规则：该维按最低档计分，原因写进 `notes`；**禁止编造输入值**。

## 2. 归一化与评级

```text
normalized = total / 92 × 100
  结果 round 到 1 位小数，并钳制在 0~100
```

| normalized | 评级 | 建议 |
| --- | --- | --- |
| ≥ 80 | **优秀** | 强烈推荐进入（仍需看风险面） |
| ≥ 60 且 < 80 | **良好** | 可以考虑进入，建议按价格带/差异化切入 |
| ≥ 40 且 < 60 | **一般** | 谨慎进入/先小规模验证 |
| < 40 | **较差** | 不建议进入 |

- 边界按「≥」含等号；80 分整 = 优秀，60 分整 = 良好，40 分整 = 一般。
- 评级是 `normalized` 的函数，不是 `total` 的函数；报告不要写「92 分制下 80 分优秀」这种混口径句。
- 换算速查：

| total（/92） | normalized | grade |
| --- | --- | --- |
| 92 | 100.0 | 优秀 |
| 83 | 90.2 | 优秀 |
| 74 | 80.4 | 优秀 |
| 73 | 79.3 | 良好 |
| 55 | 59.8 | 一般 |
| 51 | 55.4 | 一般 |
| 42（全缺兜底） | 45.7 | 一般 |
| 37 | 40.2 | 一般 |
| 36 | 39.1 | 较差 |

## 3. 市场规模（20 分）

**指标**：样本月销额 `Market.totals.revenue`（抽样合计，不是全类目 GMV，也不是固定 Top100；真实样本 N 以 `manifest.params.limit` 为准）。
**来源**：`market_research.totalRevenue` → `totals.revenue`；`inputs.revenueSource` 记录推导方式。

| 条件（严格大于） | 得分 |
| --- | --- |
| revenue > $10,000,000 | 20 |
| revenue > $5,000,000 | 17 |
| revenue > $1,000,000 | 14 |
| 其余（含缺失） | 10 |

- 缺失（`revenue=null`）→ 10，notes 写「市场规模输入缺失，按最低档」。引擎会先尝试用价格带 `revenue` 合计或 `products[].monthlyRevenue` 合计推导（`inputs.revenueSource` 标明来源），全部取不到才按缺失处理。
- `limit` < 100 时，样本销额天然偏小：报告要标「样本口径 Top <limit>，规模档位可能被低估」，不要因此把 20 分当成「类目很大」的绝对证据。
- 币种是站点本币（US=USD）；跨站点比较需先换算，不能直接比。

## 4. 增长潜力（标准 25，实际最高 22）

**指标**：低评论产品销量占比 `lowReviewShare`（0~1）。
**定义**：评分数 < **300** 的产品销量 / 样本总销量。该阈值是 v0.1 冻结值，记录在 `inputs.lowReviewThreshold`；**不要**改用 <100 或 <500 的另一套说法（上游文档存在 100/300 两种历史写法，以本口径为准）。

**取值优先级**（`inputs.lowReviewSource`、`estimated` 会标明）：

1. 显式字段（如 `low_reviews_sales_volume_share` 等厂商字段）；
2. 用 `distributions.ratingsCount` 的销量分桶推导：阈值为 300，跨阈值的桶按均匀分布估算，结果标 `estimated:true`；
3. 用 `products[].reviews` 按 `monthlySales` 加权估算。

| 条件（严格大于） | 得分 | 解读 |
| --- | --- | --- |
| lowReviewShare > 40% | 22 | 新品空间大 |
| lowReviewShare > 20% | 18 | 新品有机会 |
| 其余（含缺失） | 14 | 新品空间有限 |

- 缺失 → 14，notes 写「低评论占比未取到，按最低档」。
- `estimated:true` 时报告标「低评论占比为推导值（估算），非厂商直接口径」。
- 不要把「低评论」理解为「低评分」：这是**评论数量**少，不是星级低。

## 5. 竞争烈度（标准 20，实际最高 18）

**指标**：Top3 品牌销量占比 `concentration.top3BrandCrn`（0~1，销量口径）。
**来源**：`market_research.top3BrandCrn` → `Market.concentration.top3BrandCrn`。

| 条件（严格小于） | 得分 | 解读 |
| --- | --- | --- |
| top3BrandCrn < 30% | 18 | 低度集中，机会大 |
| top3BrandCrn < 50% | 14 | 中度集中 |
| 其余（含缺失） | 8 | 高度集中，竞争激烈 |

- 缺失 → 8，notes 写「Top3 品牌集中度未取到，按最低档」。引擎会先尝试用 `distributions.brand` 或 `products` 按品牌聚合推导（`inputs.source`、`estimated` 会标明），全部取不到才按缺失处理。
- 辅助指标（只用于解读，不加分）：`top3ProductCrn`（商品集中度）、`top3SellerCrn`、`top5BrandCrn`、`top10BrandCrn`。商品集中度高而品牌集中度低 = 单链接强、品牌弱的结构。
- 经验解读：<30% 分散 / 30–50% 中等 / >50% 集中；报告里标「本报告经验阈值」，不要说成行业标准。

## 6. 进入壁垒（20 分）

**指标**：两半相加（每半 3/6/10 分），范围 **6–20**：

### 6.1 Amazon 自营挤压（0–10）

输入 `entry_barrier.inputs.amazonSelfShare`（0~1；由 `Market.structure.amazonSelfProportion`（0~100）÷100 得到）。

| 条件（严格小于） | 得分 | 解读 |
| --- | --- | --- |
| amazonSelfShare < 20% | 10 | 自营挤压小 |
| amazonSelfShare < 40% | 6 | 中等挤压 |
| 其余（含缺失） | 3 | 挤压大 |

### 6.2 新品机会（0–10）

输入 `entry_barrier.inputs.lowReviewShare`（与增长潜力同源）。

| 条件（严格大于） | 得分 | 解读 |
| --- | --- | --- |
| lowReviewShare > 40% | 10 | 新品机会大 |
| lowReviewShare > 20% | 6 | 有机会 |
| 其余（含缺失） | 3 | 机会小 |

### 6.3 组合矩阵（Amazon 得分 + 新品得分）

| Amazon 得分 / 低评论得分 | >40%（10） | >20%（6） | 其余/缺失（3） |
| --- | --- | --- | --- |
| <20%（10） | **20** | 16 | 13 |
| <40%（6） | 16 | 12 | 9 |
| 其余/缺失（3） | 13 | 9 | **6** |

- 缺失任一半 → 该半按最低档 3，合计 6；notes 写清缺的是哪一半。Amazon 自营占比缺失时引擎会先尝试 `distributions.sellerType` 的 Amazon 行或 `products[].sellerSource` 推导（`inputs.amazonSelfSource` 标明），全部取不到才按 3 分。
- `scores.json` 的 `inputs.amazonPoints`、`inputs.newProductPoints` 能直接核对两半得分。
- 注意：进入壁垒里「Amazon 自营占比」与风险面的「降档规则」不是一回事——前者计入评分，后者是结论层的额外保守处理（≥40% 时最多「谨慎试验」）。

## 7. 利润空间（标准 15，实际最高 12）

**两套输入互斥、不叠加**，由 `inputs.basis` 标明：`avg_price`（默认）或 `unit_cost`（传了 `unitCost`）。

### 7.1 模式 A：`basis='avg_price'`（未传 `unitCost`，默认）

**指标**：类目均价 `Market.avgs.price`。

| 条件（严格大于） | 得分 |
| --- | --- |
| avgPrice > $300 | 12 |
| avgPrice > $150 | 10 |
| avgPrice > $50 | 7 |
| 其余（含缺失） | 4 |

- `detail` 末尾固定标「未接入采购成本，仅供初筛」；报告必须保留这句话或同义表达。
- 均价缺失时引擎会先尝试用价格带销额/销量、`products[].price` 或 `totals.revenue/totals.units` 推导（`inputs.avgPriceSource` 标明）；全部取不到才按 4 分。

### 7.2 模式 B：`basis='unit_cost'`（传了 `unitCost`）

```text
grossMargin = (avgPrice - unitCost - extraCostPerUnit) / avgPrice
extraCostPerUnit 缺省 0（当前高层工具未暴露，按 0 处理）
```

| 条件（严格大于） | 得分 |
| --- | --- |
| grossMargin > 60% | 12 |
| grossMargin > 45% | 10 |
| grossMargin > 30% | 7 |
| 其余（含负毛利/缺失） | 4 |

- `inputs.basis='unit_cost'`，`inputs.unitCost`、`inputs.extraCostPerUnit`、`inputs.grossMargin`（0~1）可核对计算。
- `detail` 写明均价、成本、毛利率。
- `unitCost` 单位是 **USD/件（采购 + 头程）**；人民币采购价要先按汇率换算，报告标换算假设。
- 同一类目若想切到成本口径，必须重新跑 run（评分输入变了），不能手工改旧 run 的分数。

## 8. 数据缺失降级规则

| 维度 | 缺失时的档位 | 说明 |
| --- | --- | --- |
| 市场规模 | 10 | 无 revenue |
| 增长潜力 | 14 | 无低评论占比且无法推导 |
| 竞争烈度 | 8 | 无 top3BrandCrn |
| 进入壁垒 | 6 | Amazon 自营/新品机会各自缺 → 3+3 |
| 利润空间 | 4 | 无均价（或成本口径缺均价） |

- 缺失原因必须进 `scores.json.notes`；报告中每个缺失维度都要点名，不能只写「部分数据缺失」。
- 引擎**始终**会算出 `total/normalized/grade`（即使全缺：42/92 → 45.7 → 一般）。这是**机械兜底值**：
  - 缺 **1** 维：可给评级，但要写「该维按最低档，结论偏保守」；
  - 缺 **≥2** 维：`total/grade` 照常输出（**可能偏乐观**，其余维度高时仍可能到优秀，如 74/92 → 80.4），但 `scores.json.dataQuality` = `C`/`D`（`missingDimensions` ≥2）；报告结论区已由数据质量守卫抑制（显示「数据质量 C/D…建议补数后再评，不构成进入建议」）。Agent 按此解读，不给「推荐进入」。缺数判定优先看各维 `inputs.missing===true`；`estimated:true` 只表示推导估算（跨阈值分桶/均价推导等），**不等于缺数**，不要拿它当缺数依据。
- 数据源对「缺失」的返回可能是 null、空数组、全 0 行；判定与写法见 `references/data-rules.md` 第 4 节。
- 不得用行业常识、外部文章、其他类目的数值补进 inputs；不得手改分数。

## 9. 如何读 `scores.json`

结构（当前实现，含数据质量字段；无评分时 `renderScoresJson(null)` 也返回 `dataQuality:null`、`missingDimensions:0`，字段始终存在）：

```json
{
  "total": 79,
  "max": 92,
  "normalized": 85.9,
  "grade": "优秀",
  "dataQuality": "A",
  "missingDimensions": 0,
  "dimensions": [
    {
      "key": "market_size",
      "label": "市场规模",
      "score": 20,
      "max": 20,
      "normalized": 100,
      "detail": "样本月销额 $18.6M，规模档位最高",
      "inputs": { "revenue": 18600000, "revenueSource": "market_research.totalRevenue", "tier": ">10M" }
    }
  ],
  "notes": []
}
```

| 位置 | 含义 |
| --- | --- |
| `dimensions[].key` | 固定：`market_size`/`growth_potential`/`competition`/`entry_barrier`/`profit_margin` |
| `dimensions[].max` | **实际满分**：20/22/18/20/12（报告里另注标准满分 20/25/20/20/15） |
| `dimensions[].normalized` | 该维占实际满分的百分比（0~100），**只用于展示**，不参与总分计算 |
| `dimensions[].detail` | 人话解释 + 口径标注（如「仅供初筛」）；报告直接引用该文案，不要自己写死档位描述 |
| `dimensions[].inputs` | 计分输入，见下表 |
| `notes` | 缺失/推导/降级原因清单 |
| `max` | 恒为 92 |
| `normalized` | `total/92*100`，round 1 位 |
| `dataQuality` | 数据质量等级：A=无维度缺数、B=1 维、C=2 维、D=≥3 维（由 `missingDimensions` 推导；无评分时为 null） |
| `missingDimensions` | 缺数维度个数（判定优先级：`inputs.missing===true`（引擎显式标记）> 旧数据回退 `inputs.estimated===true` > `detail` 含「缺少/数据缺失/按最低档」；`estimated` 只是推导估算，不等于缺数） |

**inputs 速查**：

| 维度 | inputs 键 |
| --- | --- |
| 市场规模 | `revenue`, `revenueSource`, `tier` |
| 增长潜力 | `lowReviewShare`(0~1), `lowReviewThreshold`(300), `lowReviewSource`, `estimated` |
| 竞争烈度 | `top3BrandCrn`(0~1), `source`, `estimated` |
| 进入壁垒 | `amazonSelfShare`(0~1), `amazonSelfSource`, `lowReviewShare`, `lowReviewSource`, `amazonPoints`, `newProductPoints` |
| 利润空间 | `avgPrice`, `avgPriceSource`, `basis`(`unit_cost`/`avg_price`), `unitCost`, `extraCostPerUnit`, `grossMargin`(0~1/null), `tier` |

> 每个维度的 `inputs` 里还有 `missing` 布尔标记（缺数时 `true`，供数据质量守卫计 `missingDimensions`）；`estimated` 是**推导估算**标记，两者不要混用。

## 10. 算例 A：完整数据（未传 unitCost）

```text
输入（market.json）：
  totals.revenue = $18,600,000
  concentration.top3BrandCrn = 0.264
  structure.amazonSelfProportion = 5.2（%）
  低评论销量占比 = 0.382（38.2%，介于 20%~40%）
  avgs.price = $268.0
```

| 维度 | 计算 | 得分 |
| --- | --- | --- |
| 市场规模 | 18.6M > 10M | 20 |
| 增长潜力 | 0.382 > 0.20，未过 0.40 | 18 |
| 竞争烈度 | 0.264 < 0.30 | 18 |
| 进入壁垒 | Amazon 0.052 < 0.20 → 10；低评论 0.382 > 0.20 → 6 | 16 |
| 利润空间 | avg_price 模式：$268 > $50，未过 $150 | 7 |
| **合计** | 20+18+18+16+7 | **79 / 92** |

`normalized = 79 / 92 × 100 = 85.9` → **优秀**。

报告写法示例：

```text
总分 79/92（normalized 85.9，优秀）。规模与竞争格局是主要加分项；
利润维度仅 $268 均价落在 7 分档，且未接入采购成本，利润结论仅供初筛。
```

## 11. 算例 B：多维度缺失（兜底链）

```text
输入：只有 totals.revenue = $4.2M；低评论占比、top3BrandCrn、Amazon 自营、均价均未取到
```

| 维度 | 计算 | 得分 |
| --- | --- | --- |
| 市场规模 | 4.2M > 1M | 14 |
| 增长潜力 | 缺失 → 最低档 | 14 |
| 竞争烈度 | 缺失 → 最低档 | 8 |
| 进入壁垒 | 两半缺失 → 3+3 | 6 |
| 利润空间 | 缺失 → 最低档 | 4 |
| **合计** | 14+14+8+6+4 | **46 / 92** |

`normalized = 46 / 92 × 100 = 50.0` → 引擎输出「一般」；但**缺 4 维**，Skill 层必须写：

```text
数据质量：C（4/5 维度输入缺失，`dataQuality='C'`，`missingDimensions=4`）。报告已标「补数后再评，不构成进入建议」，本次不给推荐；
需补：低评论占比、Top3 品牌集中度、Amazon 自营占比、类目均价，补齐后重跑（约 9~11 次调用）。
```

## 12. 算例 C：传入 unitCost 后利润维变化

同一类目（均价 $86.4），传入 `unitCost = $18.0`（extraCostPerUnit=0）：

```text
grossMargin = (86.4 - 18.0) / 86.4 = 79.17%  > 60%  → 12 分
```

| 维度 | 模式 A（无成本） | 模式 B（unitCost=$18） |
| --- | --- | --- |
| 利润空间 | 7（> $50） | 12（毛利率 79.2%） |
| 总分 | 其他维合计 + 7 | 其他维合计 + 12 |
| normalized | 基准 | 比模式 A 高 5.4 个百分点（5/92×100） |

- 因为评分输入变了，**必须重跑** run 才能在 `scores.json` 里体现；不要在旧报告上手工把 7 改成 12。
- 报告写「按 unitCost $18.0/件估算毛利率 79.2%，利润维 12 分；该测算不含其他费用（佣金/广告/退货），不等于净利」，防止读者误读。

## 13. 常见错误对照

| 错误 | 正确做法 |
| --- | --- |
| 说「满分 100」，或把 92 分制当 100 分制解释 | 满分上限 92；`normalized = total/92×100` |
| 用标准满分 25/20/15 当实际满分算百分比 | 用 `dimensions[].max` 的实际值 22/18/12 |
| 缺数据时用 0 或行业值补 | 按最低档 10/14/8/6/4，notes 说明 |
| 缺 ≥2 维把「优秀/良好」当确定结论 | 读 `scores.json.dataQuality`（C/D）与报告守卫措辞；只给数据不足/谨慎试验 + 补数清单 |
| 手工重算分数或改 inputs | 以 `scores.json` 为准；异常标「待核」反馈维护者 |
| 低评论阈值混用 100/300 | v0.1 冻结 300，读 `inputs.lowReviewThreshold` |
| `estimated:true` 的推导值当厂商直接数据 | 报告标「推导/估算」 |
| 把品牌 CR3 与商品 CR3 混用打分 | 竞争维只认 `top3BrandCrn`；其余只做解读 |
| 在 `avg_price` 模式上又叠加 unitCost 思路 | 两模式互斥，`basis` 只取一个 |
| 报告里 0.264 与 26.4% 混写 | 统一 ×100 写 % |

## 14. 与上游口径的关系（为什么是 92）

- 上游评分表名义 100 分：市场规模 20 + 增长潜力 25 + 竞争烈度 20 + 进入壁垒 20 + 利润空间 15。
- 但各维最高档实际只能拿到 20/22/18/20/12，合计 **92**；v0.1 明确保留 92 分上限并按 92 归一化（用户已拍板），目的是与上游历史结果口径一致、避免虚高。
- 因此：`total` 最大 92，`normalized` 最大 100；评级看 `normalized`。
- 如果未来口径变化（如启用 100 分制），必须同时改 `scores.json.max`、本文件与报告模板，并在报告里注明版本；不要在没有改版本的情况下用两套口径互相比较。

## 15. 校验清单（写完评分表逐条过）

- [ ] `dimensions[].score` 与 `scores.json` 完全一致，5 个 key 齐全。
- [ ] 每维 `max` 用的是 20/22/18/20/12；报告另注标准满分 20/25/20/20/15。
- [ ] `total` = 五维之和；`normalized` = `round(total/92×100, 1)`。
- [ ] 评级按 ≥80/≥60/≥40 判定，边界含等号。
- [ ] 缺失维度按最低档且已在 `notes`/报告点名。
- [ ] 利润维模式（`basis`）明确；`avg_price` 模式有「仅供初筛」，`unit_cost` 模式有毛利率公式与数值。
- [ ] 缺 ≥2 维时已核对 `dataQuality`/`missingDimensions`，报告为「补数后再评，不构成进入建议」，未输出「推荐进入」。
- [ ] 没有 100 分制表述、没有手改分数、没有把推导值当直接数据。
