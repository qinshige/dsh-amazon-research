/**
 * dsh-amazon-research —— 亚马逊选品研究（DeepSeek Harness 插件）。
 *
 * 能力：
 *   1. 8 个模型工具：research_provider_status / research_category_select /
 *      research_product_select（四途径 + 九策略 + 十维 + 差异化）/ research_unit_cost / research_runs /
 *      research_page（文本快照 + 编号点击 + 导航/截图，AppleScript 或 CDP 驱动）/ mcp_call / research_saudi_source；
 *   2. 3 个内嵌技能：amazon-category-selection / amazon-product-selection / trendyol-saudi-product-selection；
 *   3. 侧栏「选品研究」面板 + 设置页的 HTTP API（host/routes.js）；
 *   4. 数据落盘：$DSH_HOME/amazon-research/（密钥、配置、缓存、运行目录）。
 *
 * 约定（与 dsh-knowledge-base 一致）：
 *   - apply() 同步；可选服务（skills/systemPrompt/webServer）必须经 ctx.inject 惰性挂载；
 *   - 工具注册在 ctx.effect 上，卸载即注销。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readConfig, resolveDataDir, resolveOutputRoot, outputRootCandidates as outputRootCandidatesFor } from './host/paths.js';
import { Secrets } from './host/credentials.js';
import { Providers } from './host/providers.js';
import { createTools } from './host/tools.js';
import { registerRoutes } from './host/routes.js';
import { resetBrowserCache } from './host/web/chrome.js';

export const name = 'dsh-amazon-research';
export const version = '0.8.0';

/** 工具是硬依赖；缺了它插件没有意义。 */
export const inject = ['tools'];

const SKILLS_DIR = fileURLToPath(new URL('./skills/', import.meta.url));
/** 随包技能的 rank（dsh-skill-filesystem 的 bundled 档位）。 */
const BUNDLED_SKILL_RANK = 600;

/** 反引号常量：系统提示里的工具名用反引号包起来（避免模板字符串转义噪音）。 */
const bt = String.fromCharCode(96);

const GUIDANCE_TEXT = [
  '## 多平台选品研究（插件 dsh-amazon-research）',
  '先确认市场与平台：美国站保留原 Amazon US 选品功能；仅沙特站限制为 Trendyol.sa（SA/SAR），不使用 Amazon.sa、Temu、AliExpress 替代沙特需求。美国与沙特模型不可混用。调用工具明确传 platform 与 marketplace，避免沿用上次市场。',
  '### Amazon 美国及原有非沙特站点',
  '先加载 amazon-category-selection（类目）或 amazon-product-selection（单品）技能。research_provider_status 确认 Sellersprite 配置；密钥未配置时到「选品研究→设置」填写 Secret Key。',
  'research_category_select(platform=amazon, marketplace=US, category或nodeIdPath, limit, 可选unitCost)保留原类目研究；调用前说明预计9–11次数据服务额度。原92分制：normalized=total/92*100，评级≥80优秀/≥60良好/≥40一般/<40较差；同时报告score/max及归一化值。',
  'research_product_select(platform=amazon, marketplace=US, action=plan)保留四途径、九策略、十维及差异化；screen使用候选ASIN原模板、profile和targetMonthlyUnits，不使用沙特candidates模板。原collect与research_unit_cost供应链/FBA测算仅用于Amazon，不套用沙特公式。',
  'Amazon成本使用用户指定costProfile/freightMode/freightPerKgCNY；缺失真实报价写未取到，汇率记录来源日期。原默认广告10%、退货5%、佣金6%、其他0为用户假设而非官方费率。',
  'research_runs读取产物；research_page操作已登录页面，不绕过验证码；mcp_call仅用于Amazon尚未封装的数据能力，优先高层工具。所有商品数字来自实际数据，记录来源时间，不编造ASIN、销量或排名。',
  '### Trendyol.sa 沙特严格选品（以下规则仅适用于沙特）',
  '先加载 trendyol-saudi-product-selection 技能，再 research_product_select(action=plan) 读取完整输入模板。用户提供的工作流 v1 为执行依据；不得静默修改核心规则。',
  '先 research_provider_status(provider=trendyol-web)。research_category_select 只建立需求池，调用前说明 pages+detailTopN 页面请求上限；国家/币种必须核验，验证码/限流立即停止。旧92分代理不得用于定品。',
  '严格顺序：需求池→需求门槛→BB/LD路线→商品身份→合规→物流→1688寻源核价→贡献利润→退货损失→质量→100分评分→样品→小批量测试→扩货/终止→标准输出。未知暂停，不跳步。',
  '需求四项至少两项；BB同一目录身份必须一致，类似或改良转LD独立页面，不借用评分和Buybox。合规未知先暂停，不算利润。',
  '沙特候选使用research_saudi_source：plan取selection模板→collect查1688→人工同款/SKU/数量核价与计费重证据→prepare回填→research_product_select screen。collect前说明最多1搜索页+detailLimit详情页，占网页查询次数；遇验证/登录/限流停止。缺报价/费用证据暂停，不用最低卡片价或净重；类似款先明确LD。国内运费/包装按每销售单位独立披露，未扣于固定公式，不称完整净利润；旧候选重跑也需补寻源。仅准备测算，不下单。',
  '固定工作流口径：含税售价/1.15 - 售价*(10%+8%+4%) - ((采购人民币+计费重kg*68)/1.8+10+5)。利润≤0淘汰；利润率<10%淘汰或谈价，10–15%有条件，≥15%优先测试。',
  '标准件预估退回15 SAR；仓库等未知不填0；退货损失>40 SAR或>售价60%高风险。预期退货成本单列，不与4%售后准备重复扣减。',
  '仅通过门槛后BB人工有证据评分30/30/15/15/10，总分100；70以上样品，60–69观察，60以下淘汰；LD单列不排名。',
  'research_product_select(action=screen,candidates=[按plan模板填数据])生成最终对标品.md、淘汰候选.md、利润测算.xlsx、evidence索引。证据索引不代表截图已采集；缺失来源/日期/费用必须如实标记。',
  '样品2–3件，首批20–30件；1000展示、50–100有效点击、20–30单为内部测试观察阈值，每7–14天竞品快照。未真实满足扩货条件不得推荐扩货。',
  '读页面用 research_page：先 snapshot 拿编号控件（ref 如 e12，跨快照稳定），再 click/type 传 ref；长页面用 delta=true。navigate/back/forward/reload 做导航，screenshot 只在 CDP 驱动下可用。',
  '浏览器驱动默认 auto：Chrome 开了 --remote-debugging-port 就走 CDP（真实输入、可截图），否则 macOS 回落 AppleScript（需「允许 Apple Events 执行 JavaScript」）；Windows/Linux 只支持 CDP，未开调试端口会直接提示启动命令（插件不会自行启动浏览器）。action=backend 可查看当前驱动与端口，不绕过验证码/登录/付费墙。',
  '1688/Alibaba只用于供应链，Google/TikTok/Instagram仅解释需求，其他国家Trendyol只辅助。不得凭记忆补商品数字或伪造证据。',
].join('\n');

/** 去掉 YAML frontmatter，模型只需要正文（name/description 由技能目录提供）。 */
function stripFrontmatter(raw) {
  if (!raw.startsWith('---')) return raw;
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(raw);
  return match ? raw.slice(match[0].length).replace(/^\r?\n/u, '') : raw;
}

/** 解析 SKILL.md 的 frontmatter（只取 name/description）。 */
function parseFrontmatter(raw) {
  const meta = {};
  if (!raw.startsWith('---')) return meta;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return meta;
  const head = raw.slice(3, end);
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    meta[match[1]] = value;
  }
  return meta;
}

/** 扫描 skills/ 目录，构造技能候选（每个技能一个目录 + SKILL.md）。 */
async function discoverSkills() {
  let entries = [];
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !['amazon-category-selection', 'amazon-product-selection', 'trendyol-saudi-product-selection'].includes(entry.name)) continue;
    const dir = join(SKILLS_DIR, entry.name);
    const file = join(dir, 'SKILL.md');
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      const raw = await readFile(file, 'utf8');
      const meta = parseFrontmatter(raw);
      const skillName = meta.name || entry.name;
      const description = meta.description || 'Amazon 品类选品研究：市场大盘、五维评分、选品报告。';
      skills.push({
        name: skillName,
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'dsh-amazon-research',
        source: 'bundled',
        resourceBase: { kind: 'directory', path: dir },
        rank: BUNDLED_SKILL_RANK,
        locator: file,
        body: stripFrontmatter(raw),
      });
    } catch {
      /* 单个技能读取失败不影响其它技能 */
    }
  }
  return skills;
}

let skillCache = null;
const skillProvider = {
  name: 'dsh-amazon-research',
  async list() {
    if (!skillCache) skillCache = await discoverSkills();
    return skillCache.map(({ body, ...candidate }) => candidate);
  },
  async get(candidate) {
    const hit = skillCache?.find((skill) => skill.name === candidate.name);
    if (hit) {
      const { body, locator, ...rest } = hit;
      return { ...rest, content: body };
    }
    const raw = await readFile(candidate.locator, 'utf8');
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: 'dsh-amazon-research',
      source: 'bundled',
      resourceBase: candidate.resourceBase,
      content: stripFrontmatter(raw),
    };
  },
};

/**
 * @param {any} ctx - 宿主 Cordis 上下文
 * @param {{ dataDir?: string }} [config] - cordis.patch.yml 中本行的 config
 */
export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config?.dataDir);
  const secrets = new Secrets(ctx, dataDir);
  const providers = new Providers({ secrets });
  const deps = { ctx, dataDir, secrets, providers, version };

  // ① 工具
  ctx.effect(() => {
    const disposers = createTools(deps).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 已注销 */
        }
      }
      // 关闭 CDP WebSocket，避免插件重载后旧连接和 pending 请求继续存活。
      resetBrowserCache({ closeConnections: true });
    };
  }, 'dsh-amazon-research: tools');

  // ② 可选能力：技能目录、系统提示、面板 HTTP 路由
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (host) => {
      try {
        const skills = host.skills || host.get?.('skills');
        if (skills && typeof skills.registerProvider === 'function') skills.registerProvider(() => skillProvider);
      } catch (error) {
        console.warn('[dsh-amazon-research] 技能注册失败：' + String(error?.message ?? error));
      }
    });

    ctx.inject(['systemPrompt'], (host) => {
      try {
        const service = host.get?.('systemPrompt');
        if (service && typeof service.section === 'function') {
          service.section({ name: 'dsh-amazon-research', order: 3060, text: GUIDANCE_TEXT });
        }
      } catch {
        /* 说明缺失只影响可发现性 */
      }
    });

    ctx.inject(['webServer'], (host) => {
      try {
        const dispose = registerRoutes(host, deps);
        if (typeof dispose === 'function') host.effect(() => dispose, 'dsh-amazon-research: routes');
      } catch (error) {
        console.warn('[dsh-amazon-research] 面板路由注册失败：' + String(error?.message ?? error));
      }
    });
  }

  // ③ 预热读配置 + 自愈：把历史运行的绝对路径补登记到运行登记表，
  //    这样即使宿主 cwd 不是工作区、产物写在别处，面板也能列出来。
  void (async () => {
    try {
      const cfg = await readConfig(dataDir);
      resolveOutputRoot(cfg);
      const { backfillRunIndex } = await import('./host/runs.js');
      await backfillRunIndex(dataDir, outputRootCandidatesFor(cfg));
    } catch {
      /* 自愈失败不影响主流程 */
    }
  })();
}

export { Secrets, Providers };
