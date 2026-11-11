/**
 * dsh-amazon-research —— 亚马逊选品研究（DeepSeek Harness 插件）。
 *
 * 能力：
 *   1. 4 个模型工具：research_provider_status / research_category_select / research_runs / mcp_call；
 *   2. 1 个内嵌技能：amazon-category-selection（随包提供，装完即可被发现）；
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

export const name = 'dsh-amazon-research';
export const version = '0.1.2';

/** 工具是硬依赖；缺了它插件没有意义。 */
export const inject = ['tools'];

const SKILLS_DIR = fileURLToPath(new URL('./skills/', import.meta.url));
/** 随包技能的 rank（dsh-skill-filesystem 的 bundled 档位）。 */
const BUNDLED_SKILL_RANK = 600;

/** 反引号常量：系统提示里的工具名用反引号包起来（避免模板字符串转义噪音）。 */
const bt = String.fromCharCode(96);

const GUIDANCE_TEXT = [
  '## 亚马逊选品研究（插件 dsh-amazon-research）',
  '',
  '用户要做 Amazon 品类选品/市场调研时，用本插件的数据链路，不要凭记忆编造类目数据：',
  '1. 先 ' + bt + 'research_provider_status' + bt + ' 确认卖家精灵（Sellersprite）密钥是否配置、默认站点是什么；未配置就引导用户打开左侧栏「选品研究」→ 设置页填写 Secret Key。',
  '2. 再 ' + bt + 'research_category_select' + bt + ' 跑品类选品（参数：category 或 nodeIdPath、marketplace、limit、可选 unitCost）。调用前先告诉用户预计消耗 9~11 次数据服务额度。',
  '3. 工具只返回摘要与产物路径；需要细节用 ' + bt + 'research_runs' + bt + '（action=get）读报告，不要把整表塞回对话。',
  '4. 评分口径固定为上游 92 分制：normalized = total/92*100，评级 ≥80 优秀 / ≥60 良好 / ≥40 一般 / <40 较差。报告里要同时写清 score/max 与归一化值。',
  '5. 数据纪律：所有数字必须来自工具返回；缺失字段写「未取到」并说明；每次结论附数据来源与抓取时间；禁止用常识补齐 ASIN、销量、价格、排名。',
  '6. ' + bt + 'mcp_call' + bt + ' 只是逃生口（关键词/评论/单品详情等尚未封装的能力），优先用高层工具。',
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
    if (!entry.isDirectory()) continue;
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
