/**
 * dsh-amazon-research —— Client 半（手写 JS，无构建步骤）。
 *
 * 装载契约（与 dsh-knowledge-base / dsh-pixmart 一致）：
 *   - 产物是 window.__ModuleLoader__.load({ id: 'dsh-amazon-research', factory })；
 *   - factory(require) 只收到 require，没有 host.call；与宿主通信只能走本插件自己的
 *     HTTP 路由 /amazon-research/api/*（由宿主半注册，见 CONTRACTS.md 第 4 节）。
 *
 * 三个落点：
 *   ① sidebar.panellist → 左侧栏「选品研究」入口（id 与主面板 key 一一对应）；
 *   ② main（keyed, key = 'amazon-research'）→ 运行列表 / 运行详情（评分条 + 报告 + 产物）；
 *   ③ settings.section → 「亚马逊选品研究」：Sellersprite Secret Key（只显示「已配置」，不回显）
 *      与默认站点 / 默认样本上限 / 输出目录。
 *
 * 硬约束（照知识库插件）：
 *   - 只用 require('react') + React.createElement（无 JSX），不 require 任何 @deepseek-ai 包；
 *   - 不 iframe、不动 document.body；样式全部是内联 style + 宿主 CSS 变量（--dsw-alias-* / --dsw-radius-*）；
 *   - 所有插槽注册都包在 ctx.effect 里；单个插槽失败只让该功能缺失，不冒泡；
 *   - 所有 fetch 都走 request()：8 秒超时 + 结构化错误 + JSON 容错；
 *   - 文案走 ctx.locale.register / bind（zh + en）。
 *
 * 消费的接口（只读契约，不实现）：
 *   GET    /amazon-research/api/overview              → { pluginVersion, defaultMarketplace, outputRoot, providers[], runs[] }
 *   GET    /amazon-research/api/runs/:runId           → { runId, manifest, scores, reportMd, artifacts[] }
 *   POST   /amazon-research/api/settings              { marketplace, defaultLimit, outputRoot } → { ok: true }
 *   POST   /amazon-research/api/credentials           { provider: 'sellersprite', key } → { ok: true }
 *   DELETE /amazon-research/api/credentials           { provider: 'sellersprite' } → { ok: true }
 */
window.__ModuleLoader__.load({
  id: 'dsh-amazon-research',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const PLUGIN = 'dsh-amazon-research';
    const PANEL_KEY = 'amazon-research';
    const SETTINGS_ID = 'amazon-research';
    const NS = 'dsh-amazon-research';
    const TIMEOUT_MS = 8000;

    /** 相对挂载点解析基址（支持路径前缀部署），与 dsh-knowledge-base 同一写法。 */
    const API_BASE = (() => {
      try {
        return new URL('amazon-research/api/', document.baseURI);
      } catch (error) {
        return null;
      }
    })();

    /** 契约站点：US / UK / DE / FR / IT / ES / CA / JP。 */
    const MARKETPLACES = [
      { value: 'US', label: '美国' },
      { value: 'UK', label: '英国' },
      { value: 'DE', label: '德国' },
      { value: 'FR', label: '法国' },
      { value: 'IT', label: '意大利' },
      { value: 'ES', label: '西班牙' },
      { value: 'CA', label: '加拿大' },
      { value: 'JP', label: '日本' }
    ];

    /** 评分口径（CONTRACTS.md 第 2 节）：92 分上限，按 92 归一化到 0~100。 */
    const SCORE_MAX = 92;

    /** 宿主主题 token：只用知识库 / PixMart 客户端实际用过的变量名。 */
    const T = {
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)',
      bgLayer3: 'var(--dsw-alias-bg-layer-3)',
      borderL1: 'var(--dsw-alias-border-l1)',
      borderL2: 'var(--dsw-alias-border-l2)',
      borderL4: 'var(--dsw-alias-border-l4)',
      label: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary)',
      primaryFill: 'var(--dsw-alias-button-primary-fill)',
      primaryForeground: 'var(--dsw-alias-label-primary-foreground)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      interactive: 'var(--dsw-alias-interactive-bg-hover)',
      radiusXs: 'var(--dsw-radius-xs)',
      radiusSm: 'var(--dsw-radius-sm)',
      radiusMd: 'var(--dsw-radius-md)',
      radiusLg: 'var(--dsw-radius-lg)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    };

    const LOCALE_TAGS = ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-Hant', 'en', 'en-US'];

    // ─────────────────────────────────────────────────────────── 文案（locale）

    const ZH = {
      'panel.entryLabel': '选品研究',
      'panel.title': '亚马逊选品研究',
      'panel.subtitle': 'Sellersprite 品类市场取数 · 五维评分 · 选品报告',
      'panel.refresh': '刷新',
      'panel.refreshAria': '刷新运行记录',
      'panel.loading': '正在读取运行记录…',
      'panel.errorTitle': '运行记录加载失败',
      'panel.retry': '重试',
      'panel.version': 'v{version}',
      'panel.count': '{n} 次运行',
      'panel.staleHint': '当前显示的是上一次成功读取的数据。',

      'status.provider': '数据源',
      'status.configured': '已配置',
      'status.notConfigured': '未配置',
      'status.failed': '连接失败',
      'status.unknown': '状态未知',
      'status.marketplace': '默认站点',
      'status.output': '输出目录',

      'runs.title': '运行记录',
      'runs.emptyTitle': '还没有运行记录',
      'runs.emptyBody': '在任意对话里让 Agent 跑一次品类研究（工具 research_category_select），运行记录会出现在这里。',
      'runs.emptyHint': '每次运行都会生成 report.md / scores.json / tables / dashboard.html。',
      'runs.total': '{total} / {max} 分',
      'runs.createdAt': '时间 {time}',
      'runs.site': '站点 {site}',

      'provider.bannerTitle': '还没有配置 Sellersprite Secret Key',
      'provider.bannerBody': '打开「设置 → 亚马逊选品研究」，粘贴 Secret Key 并保存；保存成功后这里会显示「已配置」。',
      'provider.failedTitle': 'Sellersprite 连接失败',
      'provider.failedBody': '{message}',
      'provider.failedGeneric': '宿主无法列出该数据源的工具。请确认 Secret Key 是否有效、网络是否可用；保存密钥后点「重新检测」。',
      'provider.recheck': '重新检测',
      'provider.webTitle': 'MCP 未授权，可改用网页登录态',
      'provider.webBody': '卖家精灵 MCP 未开通（{message}）。可改用 provider=sellersprite-web：直接读取你在 Chrome 里已登录的卖家精灵网页版，不消耗 MCP 额度，但会占用网页端查询次数。',
      'provider.webOk': '网页登录态可用',
      'provider.webBad': '网页登录态不可用：{message}',

      'detail.back': '返回列表',
      'detail.refresh': '刷新详情',
      'detail.loading': '正在读取运行详情…',
      'detail.errorTitle': '运行详情加载失败',
      'detail.report': '选品报告',
      'detail.noReport': '没有报告正文（report.md 缺失）。',
      'detail.score': '五维评分',
      'detail.noScore': '这次运行没有评分数据（scores.json 缺失）。',
      'detail.total': '总分 {total} / {max}',
      'detail.normalized': '归一化 {value} / 100',
      'detail.artifacts': '产物文件',
      'detail.noArtifacts': '没有登记产物文件。',
      'detail.artifactsHint': '产物已写入运行目录；点击文件名可在新标签页打开（markdown / csv 为原文）。',
      'detail.openFile': '打开 {name}',
      'detail.params': '运行参数与用量',
      'detail.noParams': '没有运行参数记录。',
      'detail.warnings': '数据提示',
      'detail.dir': '运行目录：{dir}',
      'detail.provider': '数据源 {provider}',
      'detail.meta': '生成于 {time}',
      'detail.fetchedAt': '取数时间 {time}',
      'detail.unknown': '—',

      'settings.label': '亚马逊选品研究',
      'settings.title': '亚马逊选品研究',
      'settings.subtitle': '配置 Sellersprite 数据源与运行默认值；密钥只保存在本机，保存后不回显。',
      'settings.keySection': 'Sellersprite 数据源',
      'settings.keyLabel': 'Sellersprite Secret Key',
      'settings.keyPlaceholder': '粘贴 Sellersprite Secret Key',
      'settings.keyPlaceholderSet': '已配置。如需更换，粘贴新的 Key',
      'settings.keyConfigured': '已配置',
      'settings.keyNotConfigured': '未配置',
      'settings.keySave': '保存密钥',
      'settings.keySaving': '保存中…',
      'settings.keySaved': '已保存，密钥不回显。',
      'settings.keyRequired': '请先粘贴 Sellersprite Secret Key。',
      'settings.keyFailed': '保存密钥失败',
      'settings.keyClear': '清除密钥',
      'settings.keyClearConfirm': '确认清除',
      'settings.keyCancel': '取消',
      'settings.keyCleared': '已清除本机保存的密钥。',
      'settings.keyClearFailed': '清除密钥失败',
      'settings.keyHint': 'Key 在 Sellersprite 控制台的 API 管理页生成；写入宿主凭证库后，页面只显示「已配置」。',
      'settings.configuredNote': '密钥已保存在本机，页面不回显。',
      'settings.defaultsSection': '运行默认值',
      'settings.marketplaceLabel': '默认站点',
      'settings.marketplaceDesc': '取数使用的亚马逊站点。',
      'settings.limitLabel': '默认样本上限',
      'settings.limitDesc': '单次取数的样本条数上限（10–100）；留空沿用插件默认。',
      'settings.limitInvalid': '样本上限需要是 10–100 的整数。',
      'settings.outputLabel': '输出目录',
      'settings.outputDesc': '运行产物的根目录；留空沿用插件默认。',
      'settings.outputPlaceholder': '留空使用插件默认目录',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.saved': '设置已保存。',
      'settings.saveFailed': '保存设置失败',
      'settings.loading': '正在读取当前配置…',
      'settings.loadFailed': '无法读取当前配置（宿主接口不可用），保存可能失败。',
      'settings.reload': '重新读取',

      'error.generic': '操作失败',
      'error.timeout': '请求超时（8 秒），请确认插件已加载后重试。',
      'error.network': '无法连接宿主接口：{message}',

      'unit.bytes.b': '{n} B',
      'unit.bytes.kb': '{n} KB',
      'unit.bytes.mb': '{n} MB'
    };

    const EN = {
      'panel.entryLabel': 'Product Research',
      'panel.title': 'Amazon Product Research',
      'panel.subtitle': 'Sellersprite category data · five-dimension scoring · research report',
      'panel.refresh': 'Refresh',
      'panel.refreshAria': 'Refresh run list',
      'panel.loading': 'Loading runs…',
      'panel.errorTitle': 'Failed to load runs',
      'panel.retry': 'Retry',
      'panel.version': 'v{version}',
      'panel.count': '{n} runs',
      'panel.staleHint': 'Showing the last successfully loaded data.',

      'status.provider': 'Provider',
      'status.configured': 'configured',
      'status.notConfigured': 'not configured',
      'status.failed': 'connection failed',
      'status.unknown': 'unknown',
      'status.marketplace': 'Marketplace',
      'status.output': 'Output root',

      'runs.title': 'Runs',
      'runs.emptyTitle': 'No runs yet',
      'runs.emptyBody': 'Ask the agent to run a category research (tool research_category_select) in any conversation; runs show up here.',
      'runs.emptyHint': 'Each run writes report.md / scores.json / tables / dashboard.html.',
      'runs.total': '{total} / {max} pts',
      'runs.createdAt': 'at {time}',
      'runs.site': 'site {site}',

      'provider.bannerTitle': 'Sellersprite Secret Key is not configured',
      'provider.bannerBody': 'Open Settings → Amazon Product Research, paste the Secret Key and save; this banner disappears once it is configured.',
      'provider.failedTitle': 'Sellersprite connection failed',
      'provider.failedBody': '{message}',
      'provider.failedGeneric': 'The host cannot list tools for this provider. Check that the Secret Key is valid and the network is reachable; save the key and re-check.',
      'provider.recheck': 'Re-check',
      'provider.webTitle': 'MCP not authorized — use the web session instead',
      'provider.webBody': 'SellerSprite MCP is not enabled ({message}). Use provider=sellersprite-web instead: it reads the SellerSprite pages you are already logged into in Chrome, without spending MCP credits (it does consume web query quota).',
      'provider.webOk': 'Web session available',
      'provider.webBad': 'Web session unavailable: {message}',

      'detail.back': 'Back to list',
      'detail.refresh': 'Refresh',
      'detail.loading': 'Loading run detail…',
      'detail.errorTitle': 'Failed to load run detail',
      'detail.report': 'Research report',
      'detail.noReport': 'No report body (report.md is missing).',
      'detail.score': 'Score',
      'detail.noScore': 'No score data for this run (scores.json is missing).',
      'detail.total': 'Total {total} / {max}',
      'detail.normalized': 'Normalized {value} / 100',
      'detail.artifacts': 'Artifacts',
      'detail.noArtifacts': 'No artifacts recorded.',
      'detail.artifactsHint': 'Artifacts are written to the run directory; click a file name to open it in a new tab (markdown / csv as raw text).',
      'detail.openFile': 'Open {name}',
      'detail.params': 'Run params and usage',
      'detail.noParams': 'No run params recorded.',
      'detail.warnings': 'Data notes',
      'detail.dir': 'Run directory: {dir}',
      'detail.provider': 'provider {provider}',
      'detail.meta': 'created {time}',
      'detail.fetchedAt': 'fetched {time}',
      'detail.unknown': '—',

      'settings.label': 'Amazon Product Research',
      'settings.title': 'Amazon Product Research',
      'settings.subtitle': 'Configure the Sellersprite provider and run defaults. The key is stored locally and never echoed back.',
      'settings.keySection': 'Sellersprite provider',
      'settings.keyLabel': 'Sellersprite Secret Key',
      'settings.keyPlaceholder': 'Paste the Sellersprite Secret Key',
      'settings.keyPlaceholderSet': 'Configured. Paste a new key to replace it',
      'settings.keyConfigured': 'Configured',
      'settings.keyNotConfigured': 'Not configured',
      'settings.keySave': 'Save key',
      'settings.keySaving': 'Saving…',
      'settings.keySaved': 'Saved. The key is not echoed back.',
      'settings.keyRequired': 'Paste the Sellersprite Secret Key first.',
      'settings.keyFailed': 'Failed to save the key',
      'settings.keyClear': 'Clear key',
      'settings.keyClearConfirm': 'Confirm clear',
      'settings.keyCancel': 'Cancel',
      'settings.keyCleared': 'The locally stored key was cleared.',
      'settings.keyClearFailed': 'Failed to clear the key',
      'settings.keyHint': 'Create the key in the Sellersprite console (API page). It is written to the host credential store; this page only shows Configured.',
      'settings.configuredNote': 'The key is stored locally and never echoed back.',
      'settings.defaultsSection': 'Run defaults',
      'settings.marketplaceLabel': 'Default marketplace',
      'settings.marketplaceDesc': 'Amazon marketplace used for data fetching.',
      'settings.limitLabel': 'Default sample limit',
      'settings.limitDesc': 'Max sample rows per fetch (10-100); leave empty to use the plugin default.',
      'settings.limitInvalid': 'The sample limit must be an integer between 10 and 100.',
      'settings.outputLabel': 'Output root',
      'settings.outputDesc': 'Root directory for run artifacts; leave empty to use the plugin default.',
      'settings.outputPlaceholder': 'Leave empty for the plugin default',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.saved': 'Settings saved.',
      'settings.saveFailed': 'Failed to save settings',
      'settings.loading': 'Loading current settings…',
      'settings.loadFailed': 'Cannot read the current settings (host API unavailable); saving may fail.',
      'settings.reload': 'Reload',

      'error.generic': 'Operation failed',
      'error.timeout': 'Request timed out after 8 seconds. Check that the plugin is loaded and retry.',
      'error.network': 'Cannot reach the host API: {message}',

      'unit.bytes.b': '{n} B',
      'unit.bytes.kb': '{n} KB',
      'unit.bytes.mb': '{n} MB'
    };

    // ─────────────────────────────────────────────────────────── i18n

    /** apply() 里被 createI18n(ctx) 替换；渲染组件的闭包读这个绑定。 */
    let i18n = {
      t: (key) => key,
      useLocaleTick: () => {}
    };

    function t(key, vars) {
      return i18n.t(key, vars);
    }

    function useLocaleTick() {
      i18n.useLocaleTick();
    }

    function createI18n(ctx) {
      const translate = (() => {
        try {
          const bound = ctx.locale.bind(NS);
          return typeof bound === 'function' ? bound : (key) => key;
        } catch (error) {
          return (key) => key;
        }
      })();

      function tr(key, vars) {
        let raw;
        try {
          raw = translate(key);
        } catch (error) {
          raw = key;
        }
        if (raw === undefined || raw === null || raw === '') raw = key;
        if (!vars) return String(raw);
        return String(raw).replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
      }

      function tick() {
        const [, setRevision] = React.useState(0);
        React.useEffect(() => {
          if (!ctx.locale || typeof ctx.locale.subscribe !== 'function') return undefined;
          let unsubscribe = null;
          try {
            unsubscribe = ctx.locale.subscribe(() => setRevision((value) => value + 1));
          } catch (error) {
            return undefined;
          }
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
          };
        }, []);
      }

      return { t: tr, useLocaleTick: tick };
    }

    // ─────────────────────────────────────────────────────────── HTTP

    function isObject(value) {
      return typeof value === 'object' && value !== null && Array.isArray(value) === false;
    }

    function isString(value) {
      return typeof value === 'string';
    }

    function messageOf(error) {
      if (error === undefined || error === null) return 'unknown error';
      if (isString(error.message) && error.message !== '') return error.message;
      return String(error);
    }

    function errorMessage(error) {
      if (error === undefined || error === null) return t('error.generic');
      const message = messageOf(error);
      const hint = error && isString(error.hint) && error.hint !== '' ? error.hint : '';
      return hint === '' ? message : message + '（' + hint + '）';
    }

    function unwrap(data) {
      if (isObject(data) && data.ok === true && isObject(data.data)) return data.data;
      return data;
    }

    function readFailure(response, data) {
      const failed = (isObject(data) && data.ok === false) || response.ok !== true;
      if (!failed) return null;
      const detail = isObject(data) && isObject(data.error) ? data.error : null;
      const message = detail !== null && isString(detail.message) && detail.message !== '' ? detail.message : 'HTTP ' + response.status;
      const error = new Error(message);
      if (detail !== null && isString(detail.code)) error.code = detail.code;
      if (detail !== null && isString(detail.hint)) error.hint = detail.hint;
      return error;
    }

    /**
     * 唯一的请求出口：8 秒超时（AbortController）、非 JSON 响应容错、
     * 宿主统一错误信封 {ok:false,error:{code,message,hint}} 与 {ok:true,data:{...}} 两种包装都兼容。
     */
    async function request(path, options) {
      if (API_BASE === null) throw new Error('接口基址解析失败（document.baseURI 不可用）');
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => {
        try {
          controller.abort();
        } catch (error) {
          /* 已经结束的请求再 abort 也没关系 */
        }
      }, TIMEOUT_MS);
      try {
        let response;
        try {
          response = await fetch(new URL(path, API_BASE), {
            ...(options || {}),
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller === null ? undefined : controller.signal
          });
        } catch (error) {
          if (controller !== null && controller.signal.aborted) throw new Error(t('error.timeout'));
          throw new Error(t('error.network', { message: messageOf(error) }));
        }
        let raw = '';
        try {
          raw = await response.text();
        } catch (error) {
          if (controller !== null && controller.signal.aborted) throw new Error(t('error.timeout'));
          throw new Error(t('error.network', { message: messageOf(error) }));
        }
        let data = null;
        if (raw !== '') {
          try {
            data = JSON.parse(raw);
          } catch (error) {
            data = null;
          }
        }
        const failure = readFailure(response, data);
        if (failure !== null) throw failure;
        return unwrap(data);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    function postJson(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    }

    function deleteJson(path, body) {
      return request(path, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    }

    /** 宿主允许按运行读取的文件白名单（host/routes.js 的 FILE_WHITELIST）。 */
    const ARTIFACT_FILE = /^(report\.md|dashboard\.html|scores\.json|market\.json|manifest\.json|tables\/[\p{L}\p{N}._-]+\.csv)$/u;

    function artifactHref(runId, name) {
      if (API_BASE === null) return '';
      if (isString(runId) === false || runId === '') return '';
      if (isString(name) === false || ARTIFACT_FILE.test(name) === false) return '';
      try {
        return new URL('runs/' + encodeURIComponent(runId) + '/file?name=' + encodeURIComponent(name), API_BASE).href;
      } catch (error) {
        return '';
      }
    }

    // ─────────────────────────────────────────────────────────── 格式化 / 小工具

    function toNumber(value, fallback) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (isString(value) && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return fallback;
    }

    function formatNumber(value) {
      const number = toNumber(value, 0);
      if (Math.abs(number - Math.round(number)) < 0.05) return String(Math.round(number));
      return (Math.round(number * 10) / 10).toFixed(1);
    }

    function formatTime(value) {
      if (value === undefined || value === null || value === '') return '—';
      const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
      if (Number.isNaN(date.getTime())) return String(value);
      const pad = (number) => (number < 10 ? '0' + number : String(number));
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function formatBytes(bytes) {
      const value = toNumber(bytes, -1);
      if (value < 0) return '—';
      if (value < 1024) return t('unit.bytes.b', { n: value });
      if (value < 1024 * 1024) return t('unit.bytes.kb', { n: (value / 1024).toFixed(1) });
      return t('unit.bytes.mb', { n: (value / 1024 / 1024).toFixed(1) });
    }

    function formatValue(value) {
      if (value === undefined || value === null) return '—';
      if (isString(value)) return value.length > 300 ? value.slice(0, 300) + '…' : value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      try {
        const text = JSON.stringify(value);
        return text.length > 300 ? text.slice(0, 300) + '…' : text;
      } catch (error) {
        return String(value);
      }
    }

    /** 取第一个非空字符串（宿主字段命名可能略有出入时的容错）。 */
    function pickString() {
      for (let index = 0; index < arguments.length; index += 1) {
        const value = arguments[index];
        if (isString(value) && value !== '') return value;
      }
      return '';
    }

    /** 从候选值里取第一个可用的正数（用于 defaultLimit 预填）。 */
    function pickLimit() {
      for (let index = 0; index < arguments.length; index += 1) {
        const value = arguments[index];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(Math.round(value));
        if (isString(value) && value.trim() !== '') return value.trim();
      }
      return '';
    }

    function marketplaceLabel(value) {
      const code = isString(value) ? value.toUpperCase() : '';
      for (let index = 0; index < MARKETPLACES.length; index += 1) {
        if (MARKETPLACES[index].value === code) return MARKETPLACES[index].label + ' (' + MARKETPLACES[index].value + ')';
      }
      return code === '' ? '—' : code;
    }

    function findProvider(overview) {
      if (!isObject(overview)) return null;
      const providers = Array.isArray(overview.providers) ? overview.providers : [];
      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index];
        if (!isObject(provider)) continue;
        if (provider.id === 'sellersprite') return provider;
        if (isString(provider.label) && /sellersprite/i.test(provider.label) && !/网页|web/i.test(provider.label)) return provider;
      }
      return null;
    }

    /** 网页登录态 provider（sellersprite-web）状态。 */
    function findWebProvider(overview) {
      if (!isObject(overview)) return null;
      const providers = Array.isArray(overview.providers) ? overview.providers : [];
      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index];
        if (!isObject(provider)) continue;
        if (provider.id === 'sellersprite-web') return provider;
      }
      return null;
    }

    function clampPct(value) {
      const number = toNumber(value, 0);
      return Math.max(0, Math.min(100, number));
    }

    /** 评级 / 进度色：只用 success / warn / error 三档状态 token。 */
    function toneForPercent(percent) {
      if (percent >= 60) return T.success;
      if (percent >= 40) return T.warn;
      return T.error;
    }

    function gradeTone(grade) {
      const key = isString(grade) ? grade.trim() : '';
      if (key === '优秀' || key === '良好') return T.success;
      if (key === '一般') return T.warn;
      if (key === '较差') return T.error;
      if (/^(excellent|great|good|a\+?|b\+?)$/i.test(key)) return T.success;
      if (/^(fair|average|c\+?)$/i.test(key)) return T.warn;
      if (/^(poor|weak|d)$/i.test(key)) return T.error;
      return T.labelSecondary;
    }

    // ─────────────────────────────────────────────────────────── 图标（内联 SVG）

    function svgIcon(size, children) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: '0 0 auto' }
        },
        ...children
      );
    }

    function iconSize(props) {
      return props && Number(props.size) > 0 ? Number(props.size) : 16;
    }

    function IconTarget(props) {
      return svgIcon(iconSize(props), [
        h('circle', { key: 'lens', cx: 10.5, cy: 10.5, r: 6 }),
        h('path', { key: 'handle', d: 'm15.4 15.4 4.6 4.6' }),
        h('path', { key: 'bar1', d: 'M8.1 12.3V10.7' }),
        h('path', { key: 'bar2', d: 'M10.5 12.3V8.7' }),
        h('path', { key: 'bar3', d: 'M12.9 12.3V10.1' })
      ]);
    }

    function IconRefresh(props) {
      return svgIcon(iconSize(props), [
        h('path', { key: 'a', d: 'M4.5 9.5A7.5 7.5 0 0 1 17.8 6L20 8.2' }),
        h('path', { key: 'b', d: 'M20 3.8v4.4h-4.4' }),
        h('path', { key: 'c', d: 'M19.5 14.5A7.5 7.5 0 0 1 6.2 18L4 15.8' }),
        h('path', { key: 'd', d: 'M4 20.2v-4.4h4.4' })
      ]);
    }

    function IconBack(props) {
      return svgIcon(iconSize(props), [h('path', { key: 'a', d: 'M15 5.5 8.5 12l6.5 6.5' })]);
    }

    function IconChevron(props) {
      return svgIcon(iconSize(props), [h('path', { key: 'a', d: 'm9.5 5.5 6.5 6.5-6.5 6.5' })]);
    }

    function IconFile(props) {
      return svgIcon(iconSize(props), [
        h('path', { key: 'a', d: 'M13.5 3H7.2A2.2 2.2 0 0 0 5 5.2v13.6A2.2 2.2 0 0 0 7.2 21h9.6a2.2 2.2 0 0 0 2.2-2.2V8.5L13.5 3Z' }),
        h('path', { key: 'b', d: 'M13.5 3v5.5H19' })
      ]);
    }

    function IconAlert(props) {
      return svgIcon(iconSize(props), [
        h('path', { key: 'a', d: 'M12 4 3.6 19.2h16.8L12 4Z' }),
        h('path', { key: 'b', d: 'M12 9.6v4.2' }),
        h('path', { key: 'c', d: 'M12 17.1h.01' })
      ]);
    }

    function IconKey(props) {
      return svgIcon(iconSize(props), [
        h('circle', { key: 'a', cx: 8.2, cy: 12, r: 3.4 }),
        h('path', { key: 'b', d: 'M11.6 12H20.5' }),
        h('path', { key: 'c', d: 'M17.4 12v2.7' }),
        h('path', { key: 'd', d: 'M20 12v2.2' })
      ]);
    }

    function IconList(props) {
      return svgIcon(iconSize(props), [
        h('path', { key: 'a', d: 'M8.5 6.5h11' }),
        h('path', { key: 'b', d: 'M8.5 12h11' }),
        h('path', { key: 'c', d: 'M8.5 17.5h11' }),
        h('path', { key: 'd', d: 'M4.5 6.5h.01' }),
        h('path', { key: 'e', d: 'M4.5 12h.01' }),
        h('path', { key: 'f', d: 'M4.5 17.5h.01' })
      ]);
    }

    function IconBook(props) {
      return svgIcon(iconSize(props), [
        h('path', { key: 'a', d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H11v18H6.5A2.5 2.5 0 0 0 4 23.5v-18Z' }),
        h('path', { key: 'b', d: 'M20 5.5A2.5 2.5 0 0 0 17.5 3H13v18h4.5a2.5 2.5 0 0 1 2.5 2.5v-18Z' })
      ]);
    }

    function IconSliders(props) {
      return svgIcon(iconSize(props), [
        h('path', { key: 'a', d: 'M4 7.5h16' }),
        h('path', { key: 'b', d: 'M4 16.5h16' }),
        h('circle', { key: 'c', cx: 9, cy: 7.5, r: 2 }),
        h('circle', { key: 'd', cx: 15.5, cy: 16.5, r: 2 })
      ]);
    }

    function IconSpinner(props) {
      return svgIcon(iconSize(props), [
        h('circle', { key: 'a', cx: 12, cy: 12, r: 8.2, strokeDasharray: '3.2 4.4' })
      ]);
    }

    // ─────────────────────────────────────────────────────────── 视觉原子（内联 style）

    const S = {
      panel: {
        boxSizing: 'border-box',
        height: '100%',
        minHeight: 0,
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 18,
        background: T.bgLayer1,
        color: T.label,
        fontSize: 13,
        lineHeight: 1.55
      },
      settingsRoot: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 18,
        maxWidth: 760,
        color: T.label,
        fontSize: 13,
        lineHeight: 1.55
      },
      scroll: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 14
      },
      title: { margin: 0, fontSize: 18, lineHeight: 1.35, fontWeight: 600 },
      subtitle: { margin: 0, fontSize: 12, lineHeight: 1.6, color: T.labelSecondary },
      cardTitle: { margin: 0, fontSize: 13.5, lineHeight: 1.5, fontWeight: 600 },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minWidth: 0,
        padding: '12px 14px',
        border: '0.5px solid ' + T.borderL1,
        borderRadius: T.radiusLg,
        background: T.bgLayer2
      },
      muted: { margin: 0, fontSize: 12, lineHeight: 1.6, color: T.labelSecondary },
      tiny: { margin: 0, fontSize: 11, lineHeight: 1.6, color: T.labelTertiary },
      mono: { fontFamily: T.mono, fontSize: 11.5, lineHeight: 1.6 },
      row: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' },
      column: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      input: {
        boxSizing: 'border-box',
        minWidth: 0,
        border: '0.5px solid ' + T.borderL4,
        borderRadius: T.radiusSm,
        background: T.bgLayer1,
        color: T.label,
        fontSize: 12.5,
        lineHeight: 1.5,
        fontFamily: 'inherit',
        padding: '6px 10px'
      },
      listReset: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }
    };

    const FOCUS_STYLE = { outline: '2px solid ' + T.primaryFill, outlineOffset: '1px', borderColor: 'transparent' };

    const BUTTON_TONES = {
      default: { border: '0.5px solid ' + T.borderL1, background: 'transparent', color: T.label },
      primary: { border: '0.5px solid transparent', background: T.primaryFill, color: T.primaryForeground },
      ghost: { border: '0.5px solid transparent', background: 'transparent', color: T.labelSecondary },
      danger: { border: '0.5px solid ' + T.borderL1, background: 'transparent', color: T.error }
    };

    const BUTTON_HOT = {
      default: { background: T.interactive },
      primary: { opacity: 0.9 },
      ghost: { background: T.interactive, color: T.label },
      danger: { background: T.interactive }
    };

    function Button(props) {
      const [hot, setHot] = React.useState(false);
      const tone = isString(props.tone) && BUTTON_TONES[props.tone] !== undefined ? props.tone : 'default';
      const disabled = props.disabled === true;
      const base = BUTTON_TONES[tone];
      const children = [];
      if (props.icon !== undefined && props.icon !== null) {
        children.push(h('span', { key: 'icon', style: { display: 'inline-flex', flex: '0 0 auto' } }, props.icon));
      }
      if (props.children !== undefined && props.children !== null) {
        children.push(h('span', { key: 'label' }, props.children));
      }
      return h(
        'button',
        {
          type: 'button',
          id: props.id,
          disabled: disabled,
          onClick: props.onClick,
          onMouseEnter: () => setHot(true),
          onMouseLeave: () => setHot(false),
          onFocus: () => setHot(true),
          onBlur: () => setHot(false),
          'aria-label': props.ariaLabel,
          'data-amz-action': props.action,
          style: {
            appearance: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            boxSizing: 'border-box',
            border: base.border,
            borderRadius: T.radiusSm,
            background: base.background,
            color: base.color,
            fontSize: 12,
            lineHeight: 1.5,
            fontWeight: 500,
            fontFamily: 'inherit',
            padding: '5px 11px',
            whiteSpace: 'nowrap',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            ...(hot && disabled === false ? BUTTON_HOT[tone] : null),
            ...(props.style || {})
          }
        },
        ...children
      );
    }

    function Card(props) {
      return h('section', { style: { ...S.card, ...(props.style || {}) } }, props.children);
    }

    function Badge(props) {
      const tone = props.tone === undefined ? T.labelSecondary : props.tone;
      return h(
        'span',
        {
          title: props.title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            flex: '0 0 auto',
            fontSize: 10.5,
            lineHeight: 1.7,
            color: tone,
            border: '0.5px solid ' + T.borderL1,
            borderRadius: 999,
            padding: '0 7px',
            whiteSpace: 'nowrap'
          }
        },
        props.dot === true
          ? h('span', { key: 'dot', style: { display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: props.tone === undefined ? T.idle : tone } })
          : null,
        props.children
      );
    }

    function SectionHead(props) {
      return h(
        'div',
        { style: { ...S.row, justifyContent: 'space-between', gap: 8 } },
        h(
          'div',
          { style: { ...S.row, gap: 7 } },
          props.icon === undefined ? null : h('span', { style: { display: 'inline-flex', color: T.labelSecondary, flex: '0 0 auto' } }, props.icon),
          h('h2', { style: S.cardTitle }, props.title)
        ),
        props.extra === undefined ? null : props.extra
      );
    }

    function Field(props) {
      const controlId = isString(props.controlId) ? props.controlId : undefined;
      const children = React.Children.toArray(props.children === undefined || props.children === null ? [] : props.children);
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: 0,
            flexWrap: 'wrap',
            padding: '10px 0',
            borderBottom: '0.5px solid ' + T.borderL2
          }
        },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 240px', minWidth: 0 } },
          h('label', { htmlFor: controlId, style: { fontSize: 13, lineHeight: 1.5, color: T.label } }, props.label),
          props.description === undefined || props.description === null ? null : h('span', { style: S.tiny }, props.description)
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', flexWrap: 'wrap', minWidth: 0 } }, ...children)
      );
    }

    function Input(props) {
      const [focused, setFocused] = React.useState(false);
      return h('input', {
        id: props.id,
        type: props.type === undefined ? 'text' : props.type,
        value: props.value === undefined || props.value === null ? '' : props.value,
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        min: props.min,
        max: props.max,
        step: props.step,
        inputMode: props.inputMode,
        autoComplete: props.autoComplete === undefined ? 'off' : props.autoComplete,
        spellCheck: false,
        onChange: props.onChange,
        onKeyDown: props.onKeyDown,
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        style: { ...S.input, flex: '0 0 auto', ...(focused ? FOCUS_STYLE : null), ...(props.style || {}) }
      });
    }

    function Select(props) {
      const [focused, setFocused] = React.useState(false);
      const options = Array.isArray(props.options) ? props.options : [];
      return h(
        'select',
        {
          id: props.id,
          value: props.value,
          disabled: props.disabled === true,
          onChange: props.onChange,
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          style: { ...S.input, cursor: 'pointer', minWidth: 150, ...(focused ? FOCUS_STYLE : null), ...(props.style || {}) }
        },
        ...options.map((option) => h('option', { key: option.value, value: option.value }, option.label + ' (' + option.value + ')'))
      );
    }

    function Msg(props) {
      if (!isObject(props.message)) return null;
      const ok = props.message.ok === true;
      const text = props.message.text === undefined || props.message.text === null ? '' : String(props.message.text);
      return h(
        'span',
        {
          role: ok ? 'status' : 'alert',
          style: { fontSize: 12, lineHeight: 1.6, color: ok ? T.success : T.error, wordBreak: 'break-word', minWidth: 0 }
        },
        text
      );
    }

    function Loading(props) {
      return h(
        'div',
        {
          role: 'status',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '28px 10px', fontSize: 12, color: T.labelSecondary }
        },
        h('span', { style: { display: 'inline-flex', color: T.labelTertiary } }, h(IconSpinner, { size: 14 })),
        h('span', null, props.text === undefined ? '' : props.text)
      );
    }

    function Empty(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 7,
            padding: '26px 16px',
            border: '1px dashed ' + T.borderL1,
            borderRadius: T.radiusLg
          }
        },
        props.icon === undefined ? null : h('span', { style: { display: 'inline-flex', color: T.labelSecondary, opacity: 0.85 } }, props.icon),
        h('div', { style: { fontSize: 13.5, fontWeight: 600 } }, props.title),
        props.body === undefined ? null : h('p', { style: { margin: 0, maxWidth: 560, fontSize: 12, lineHeight: 1.7, color: T.labelSecondary } }, props.body),
        props.hint === undefined ? null : h('p', { style: { ...S.tiny, maxWidth: 560 } }, props.hint)
      );
    }

    function ErrorBox(props) {
      return h(
        Card,
        null,
        h(
          'div',
          { style: { ...S.row, gap: 7, color: T.error } },
          h(IconAlert, { size: 15 }),
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, props.title)
        ),
        h('p', { style: { ...S.muted, wordBreak: 'break-word' }, role: 'alert' }, props.message),
        props.hint === undefined ? null : h('p', { style: S.tiny }, props.hint),
        props.onRetry === undefined
          ? null
          : h('div', { style: { ...S.row } }, h(Button, { onClick: props.onRetry, icon: h(IconRefresh, { size: 13 }) }, props.retryLabel === undefined ? t('panel.retry') : props.retryLabel))
      );
    }

    // ─────────────────────────────────────────────────────────── 轻量 Markdown（不引第三方库）

    /** 反引号字符（源码里不写三连反引号，避免与本仓库的模板字符串冲突）。 */
    const BACKTICK = String.fromCharCode(96);
    const FENCE = BACKTICK + BACKTICK + BACKTICK;

    /** 行内 **粗体** / 代码片段：只做这两种，全部走 createElement，绝不 innerHTML。 */
    const INLINE_TOKEN = /(\*\*[^*]+\*\*|\u0060[^\u0060]+\u0060)/g;

    function isFenceLine(line) {
      return isString(line) && line.trim().slice(0, 3) === FENCE;
    }

    function renderInline(text, keyPrefix) {
      const source = isString(text) ? text : String(text === undefined || text === null ? '' : text);
      const nodes = [];
      let lastIndex = 0;
      let index = 0;
      INLINE_TOKEN.lastIndex = 0;
      let match = INLINE_TOKEN.exec(source);
      while (match !== null) {
        if (match.index > lastIndex) nodes.push(source.slice(lastIndex, match.index));
        const token = match[0];
        if (token.slice(0, 2) === '**') {
          nodes.push(h('strong', { key: keyPrefix + '-b' + index }, token.slice(2, token.length - 2)));
        } else {
          nodes.push(h('code', {
            key: keyPrefix + '-c' + index,
            style: { fontFamily: T.mono, fontSize: '0.92em', background: T.bgLayer3, borderRadius: 3, padding: '0 4px' }
          }, token.slice(1, token.length - 1)));
        }
        lastIndex = match.index + token.length;
        index += 1;
        match = INLINE_TOKEN.exec(source);
      }
      if (lastIndex < source.length) nodes.push(source.slice(lastIndex));
      return nodes;
    }

    function isTableSeparator(line) {
      if (!isString(line)) return false;
      const trimmed = line.trim();
      if (trimmed.indexOf('-') < 0) return false;
      return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(trimmed);
    }

    function splitTableRow(line) {
      const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      const cells = [];
      let current = '';
      let index = 0;
      while (index < trimmed.length) {
        const char = trimmed[index];
        if (char === '\\' && trimmed[index + 1] === '|') {
          current += '|';
          index += 2;
        } else if (char === '|') {
          cells.push(current.trim());
          current = '';
          index += 1;
        } else {
          current += char;
          index += 1;
        }
      }
      cells.push(current.trim());
      return cells;
    }

    function isListLine(line) {
      return isString(line) && /^\s*([-*+]|\d+[.)])\s+/.test(line);
    }

    function parseListLine(line) {
      const match = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (match === null) return { ordered: false, depth: 0, text: line };
      const indent = match[1].replace(/\t/g, '  ').length;
      return { ordered: /^\d/.test(match[2]), depth: Math.min(3, Math.floor(indent / 2)), text: match[4] };
    }

    function isBlockStart(line, nextLine) {
      if (!isString(line)) return false;
      if (/^\s*$/.test(line)) return true;
      if (isFenceLine(line)) return true;
      if (/^\s*(#{1,6}\s|>)/.test(line)) return true;
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) return true;
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return true;
      if (/^\s*\|/.test(line) && isTableSeparator(nextLine)) return true;
      return false;
    }

    function renderTable(header, rows, tableKey) {
      return h(
        'div',
        { key: tableKey, style: { overflowX: 'auto', margin: '8px 0' } },
        h(
          'table',
          { style: { borderCollapse: 'collapse', width: '100%', fontSize: 11.5, lineHeight: 1.6 } },
          h('thead', null, h('tr', null, ...header.map((cell, cellIndex) => h('th', {
            key: 'th' + cellIndex,
            style: {
              textAlign: 'left',
              padding: '5px 8px',
              borderBottom: '0.5px solid ' + T.borderL2,
              color: T.labelSecondary,
              fontWeight: 600,
              whiteSpace: 'nowrap'
            }
          }, ...renderInline(cell, 'th' + cellIndex))))),
          h('tbody', null, ...rows.map((row, rowIndex) => h(
            'tr',
            { key: 'tr' + rowIndex },
            ...header.map((cell, cellIndex) => h('td', {
              key: 'td' + cellIndex,
              style: { padding: '5px 8px', borderBottom: '0.5px solid ' + T.borderL1, verticalAlign: 'top' }
            }, ...renderInline(row[cellIndex] === undefined ? '' : row[cellIndex], 'td' + rowIndex + '-' + cellIndex)))
          )))
        )
      );
    }

    /** report.md → React 节点。支持标题 / 列表 / 表格 / 引用 / 代码块 / 分隔线；其它按段落处理。 */
    function renderMarkdown(text) {
      const lines = (isString(text) ? text : '').split(/\r?\n/);
      const blocks = [];
      let keySeq = 0;
      let index = 0;
      const nextKey = (prefix) => {
        keySeq += 1;
        return prefix + keySeq;
      };
      while (index < lines.length) {
        const line = lines[index];

        if (/^\s*$/.test(line)) {
          index += 1;
        } else if (isFenceLine(line)) {
          const code = [];
          index += 1;
          while (index < lines.length && isFenceLine(lines[index]) === false) {
            code.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push(h('pre', {
            key: nextKey('code'),
            style: {
              margin: '6px 0',
              padding: '10px 12px',
              background: T.bgLayer3,
              borderRadius: T.radiusSm,
              overflowX: 'auto',
              fontFamily: T.mono,
              fontSize: 11.5,
              lineHeight: 1.65
            }
          }, h('code', null, code.join('\n'))));
        } else {
          const heading = /^(#{1,6})\s+(.*)$/.exec(line);
          if (heading !== null) {
            const level = heading[1].length;
            const fontSize = level === 1 ? 18 : level === 2 ? 15.5 : level === 3 ? 14 : 13;
            blocks.push(h(level <= 3 ? 'h' + level : 'h4', {
              key: nextKey('heading'),
              style: {
                margin: level <= 2 ? '14px 0 6px' : '10px 0 4px',
                fontSize: fontSize,
                lineHeight: 1.45,
                fontWeight: 600,
                ...(level <= 2 ? { paddingBottom: 4, borderBottom: '0.5px solid ' + T.borderL2 } : null)
              }
            }, ...renderInline(heading[2], 'heading')));
            index += 1;
          } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            blocks.push(h('hr', { key: nextKey('hr'), style: { border: 'none', borderTop: '0.5px solid ' + T.borderL2, margin: '12px 0' } }));
            index += 1;
          } else if (/^\s*\|/.test(line) && isTableSeparator(lines[index + 1])) {
            const header = splitTableRow(line);
            index += 2;
            const rows = [];
            while (index < lines.length && /^\s*\|/.test(lines[index])) {
              rows.push(splitTableRow(lines[index]));
              index += 1;
            }
            blocks.push(renderTable(header, rows, nextKey('table')));
          } else if (/^\s*>\s?/.test(line)) {
            const quote = [];
            while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
              quote.push(lines[index].replace(/^\s*>\s?/, ''));
              index += 1;
            }
            blocks.push(h('blockquote', {
              key: nextKey('quote'),
              style: {
                margin: '6px 0',
                padding: '2px 0 2px 10px',
                borderLeft: '3px solid ' + T.borderL2,
                color: T.labelSecondary,
                fontSize: 12.5,
                lineHeight: 1.7
              }
            }, ...renderInline(quote.join('\n'), 'quote')));
          } else if (isListLine(line)) {
            const items = [];
            while (index < lines.length && isListLine(lines[index])) {
              items.push(parseListLine(lines[index]));
              index += 1;
            }
            const ordered = items[0].ordered === true;
            blocks.push(h(
              ordered ? 'ol' : 'ul',
              {
                key: nextKey('list'),
                style: { margin: '6px 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 3 }
              },
              ...items.map((item, itemIndex) => h('li', {
                key: 'li' + itemIndex,
                style: { lineHeight: 1.7, marginLeft: Math.max(0, item.depth - items[0].depth) * 14 }
              }, ...renderInline(item.text, 'li' + itemIndex)))
            ));
          } else {
            const paragraph = [line];
            index += 1;
            while (index < lines.length && isBlockStart(lines[index], lines[index + 1]) === false) {
              paragraph.push(lines[index]);
              index += 1;
            }
            blocks.push(h('p', {
              key: nextKey('p'),
              style: { margin: '6px 0', lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
            }, ...renderInline(paragraph.join('\n'), 'p')));
          }
        }
      }
      return blocks;
    }

    function Markdown(props) {
      const blocks = React.useMemo(() => renderMarkdown(props.text), [props.text]);
      if (blocks.length === 0) return null;
      return h('div', { style: { minWidth: 0, fontSize: 13, lineHeight: 1.75, color: T.label } }, ...blocks);
    }

    // ─────────────────────────────────────────────────────────── 评分

    function ScoreBar(props) {
      const percent = clampPct(props.percent);
      const tone = toneForPercent(percent);
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between', minWidth: 0 } },
          h('span', { style: { fontSize: 12.5, color: T.label, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.label),
          h('span', { style: { fontSize: 11.5, color: T.labelSecondary, whiteSpace: 'nowrap', flex: '0 0 auto' } }, props.valueText)
        ),
        h(
          'div',
          {
            role: 'img',
            'aria-label': props.ariaLabel,
            style: { height: 6, borderRadius: 999, background: T.bgLayer3, overflow: 'hidden', minWidth: 0 }
          },
          h('div', { style: { width: percent + '%', height: '100%', background: tone, borderRadius: 999 } })
        ),
        props.detail === undefined || props.detail === null || props.detail === '' ? null : h('span', { style: { ...S.tiny, wordBreak: 'break-word' } }, props.detail)
      );
    }

    function ScoreCard(props) {
      const score = isObject(props.score) ? props.score : null;
      if (score === null) {
        return h(
          Card,
          null,
          h(SectionHead, { title: t('detail.score'), icon: h(IconSliders, { size: 14 }) }),
          h('p', { style: S.muted }, t('detail.noScore'))
        );
      }
      const dimensions = Array.isArray(score.dimensions) ? score.dimensions : [];
      const max = toNumber(score.max, SCORE_MAX);
      const total = toNumber(score.total, 0);
      const normalized = clampPct(toNumber(score.normalized, max > 0 ? (total / max) * 100 : 0));
      const grade = isString(score.grade) ? score.grade : '';
      const notes = Array.isArray(score.notes) ? score.notes : [];
      return h(
        Card,
        null,
        h(SectionHead, {
          title: t('detail.score'),
          icon: h(IconSliders, { size: 14 }),
          extra: grade === '' ? null : h(Badge, { tone: gradeTone(grade) }, grade)
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 30, lineHeight: 1.05, fontWeight: 600, color: T.label } }, formatNumber(normalized)),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 3 } },
            h('span', { style: S.muted }, t('detail.normalized', { value: formatNumber(normalized) })),
            h('span', { style: S.tiny }, t('detail.total', { total: formatNumber(total), max: formatNumber(max) }))
          )
        ),
        h(
          'div',
          { style: { height: 8, borderRadius: 999, background: T.bgLayer3, overflow: 'hidden' } },
          h('div', { style: { width: normalized + '%', height: '100%', background: toneForPercent(normalized), borderRadius: 999 } })
        ),
        dimensions.length === 0
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              ...dimensions.map((dimension, index) => {
                const item = isObject(dimension) ? dimension : {};
                const dimensionMax = toNumber(item.max, 0);
                const dimensionScore = toNumber(item.score, 0);
                const dimensionPct = clampPct(toNumber(item.normalized, dimensionMax > 0 ? (dimensionScore / dimensionMax) * 100 : 0));
                const label = pickString(item.label, item.key, 'dimension ' + (index + 1));
                return h(ScoreBar, {
                  key: 'dim' + index,
                  label: label,
                  percent: dimensionPct,
                  valueText: formatNumber(dimensionScore) + ' / ' + formatNumber(dimensionMax),
                  detail: isString(item.detail) ? item.detail : '',
                  ariaLabel: label + ' ' + formatNumber(dimensionPct) + ' / 100'
                });
              })
            ),
        notes.length === 0
          ? null
          : h(
              'ul',
              { style: { ...S.listReset, gap: 3 } },
              ...notes.map((note, index) => h('li', {
                key: 'note' + index,
                style: { fontSize: 11.5, lineHeight: 1.65, color: T.labelSecondary, wordBreak: 'break-word' }
              }, '· ' + formatValue(note)))
            )
      );
    }

    // ─────────────────────────────────────────────────────────── 运行列表

    function runRowKey(run, index) {
      if (isObject(run) && isString(run.runId) && run.runId !== '') return run.runId;
      return 'run' + index;
    }

    function RunRow(props) {
      const [hot, setHot] = React.useState(false);
      const run = isObject(props.run) ? props.run : {};
      const runId = isString(run.runId) ? run.runId : '';
      const total = toNumber(run.total, null);
      const max = toNumber(run.max, SCORE_MAX);
      const grade = isString(run.grade) ? run.grade : '';
      const title = pickString(run.title, run.label, runId, '—');
      const createdAt = run.createdAt === undefined || run.createdAt === null ? run.fetchedAt : run.createdAt;
      const site = pickString(run.site, run.marketplace);
      const disabled = runId === '';
      return h(
        'li',
        { style: { listStyle: 'none', minWidth: 0 } },
        h(
          'button',
          {
            type: 'button',
            'data-amz-action': 'open-run',
            'data-run-id': runId,
            disabled: disabled,
            onClick: () => {
              if (disabled === false) props.onOpen(runId);
            },
            onMouseEnter: () => setHot(true),
            onMouseLeave: () => setHot(false),
            onFocus: () => setHot(true),
            onBlur: () => setHot(false),
            style: {
              appearance: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              boxSizing: 'border-box',
              padding: '9px 8px',
              border: '0.5px solid transparent',
              borderRadius: T.radiusMd,
              background: hot && disabled === false ? T.interactive : 'transparent',
              color: T.label,
              fontFamily: 'inherit',
              textAlign: 'left',
              cursor: disabled ? 'default' : 'pointer',
              minWidth: 0
            }
          },
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 } },
            h('span', {
              style: { fontSize: 13, fontWeight: 600, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            }, title),
            h(
              'span',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, lineHeight: 1.6, color: T.labelTertiary } },
              h('span', null, t('runs.createdAt', { time: formatTime(createdAt) })),
              site === '' ? null : h('span', null, t('runs.site', { site: site }))
            )
          ),
          total === null
            ? null
            : h('span', { style: { ...S.mono, color: T.labelSecondary, flex: '0 0 auto' } }, t('runs.total', { total: formatNumber(total), max: formatNumber(max) })),
          grade === '' ? null : h(Badge, { tone: gradeTone(grade) }, grade),
          h('span', { style: { display: 'inline-flex', color: T.labelTertiary, flex: '0 0 auto' } }, h(IconChevron, { size: 14 }))
        )
      );
    }

    function RunList(props) {
      const runs = Array.isArray(props.runs) ? props.runs : [];
      return h(
        Card,
        null,
        h(SectionHead, {
          title: t('runs.title'),
          icon: h(IconList, { size: 14 }),
          extra: h(Badge, null, t('panel.count', { n: runs.length }))
        }),
        runs.length === 0
          ? h(Empty, {
              icon: h(IconTarget, { size: 24 }),
              title: t('runs.emptyTitle'),
              body: t('runs.emptyBody'),
              hint: t('runs.emptyHint')
            })
          : h('ul', { style: S.listReset }, ...runs.map((run, index) => h(RunRow, {
              key: runRowKey(run, index),
              run: run,
              onOpen: props.onOpen
            })))
      );
    }

    // ─────────────────────────────────────────────────────────── 详情卡片

    function ReportCard(props) {
      const text = isString(props.reportMd) ? props.reportMd : '';
      return h(
        Card,
        null,
        h(SectionHead, { title: t('detail.report'), icon: h(IconBook, { size: 14 }) }),
        text === '' ? h('p', { style: S.muted }, t('detail.noReport')) : h(Markdown, { text: text })
      );
    }

    function renderArtifact(artifact, index, runId) {
      const item = isObject(artifact) ? artifact : {};
      const name = pickString(item.name, item.path, '—');
      const filePath = isString(item.path) ? item.path : '';
      const href = artifactHref(runId, name);
      const nameStyle = {
        fontSize: 12,
        color: T.label,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '0 1 auto'
      };
      const nameNode = href === ''
        ? h('span', { key: 'name', style: nameStyle }, name)
        : h('a', {
            key: 'name',
            href: href,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: t('detail.openFile', { name: name }),
            style: {
              ...nameStyle,
              textDecoration: 'underline',
              textDecorationColor: T.borderL2,
              textUnderlineOffset: 2
            }
          }, name);
      return h(
        'li',
        {
          key: 'artifact' + index,
          style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, padding: '4px 0' }
        },
        h('span', { style: { display: 'inline-flex', color: T.labelTertiary, flex: '0 0 auto', alignSelf: 'center' } }, h(IconFile, { size: 12 })),
        nameNode,
        filePath === '' || filePath === name
          ? h('span', { style: { flex: '1 1 auto' } })
          : h('span', {
              title: filePath,
              style: {
                fontSize: 10.5,
                color: T.labelTertiary,
                fontFamily: T.mono,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: '1 1 auto',
                minWidth: 0
              }
            }, filePath),
        h('span', { style: { ...S.tiny, flex: '0 0 auto' } }, formatBytes(item.bytes))
      );
    }

    function ArtifactsCard(props) {
      const artifacts = Array.isArray(props.artifacts) ? props.artifacts : [];
      return h(
        Card,
        null,
        h(SectionHead, {
          title: t('detail.artifacts'),
          icon: h(IconFile, { size: 14 }),
          extra: artifacts.length === 0 ? null : h(Badge, null, String(artifacts.length))
        }),
        artifacts.length === 0
          ? h('p', { style: S.muted }, t('detail.noArtifacts'))
          : h('ul', { style: S.listReset }, ...artifacts.map((artifact, index) => renderArtifact(artifact, index, props.runId))),
        artifacts.length === 0 ? null : h('p', { style: S.tiny }, t('detail.artifactsHint'))
      );
    }

    function KeyValueCard(props) {
      const data = isObject(props.data) ? props.data : null;
      const extra = isObject(props.extra) ? props.extra : null;
      const rows = [];
      if (data !== null) {
        for (const name of Object.keys(data)) rows.push([name, data[name]]);
      }
      if (extra !== null) {
        for (const name of Object.keys(extra)) rows.push(['usage.' + name, extra[name]]);
      }
      return h(
        Card,
        null,
        h(SectionHead, { title: props.title, icon: h(IconSliders, { size: 14 }) }),
        rows.length === 0
          ? h('p', { style: S.muted }, t('detail.noParams'))
          : h(
              'ul',
              { style: S.listReset },
              ...rows.map((row, index) => h(
                'li',
                { key: 'kv' + index, style: { display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0, padding: '2px 0' } },
                h('span', {
                  style: {
                    fontSize: 11.5,
                    color: T.labelSecondary,
                    flex: '0 1 auto',
                    maxWidth: '42%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }
                }, row[0]),
                h('span', {
                  style: { fontSize: 11.5, color: T.label, fontFamily: T.mono, wordBreak: 'break-word', minWidth: 0, flex: '1 1 auto' }
                }, formatValue(row[1]))
              ))
            )
      );
    }

    function WarningsCard(props) {
      const warnings = Array.isArray(props.warnings) ? props.warnings : [];
      return h(
        Card,
        null,
        h(SectionHead, { title: t('detail.warnings'), icon: h(IconAlert, { size: 14 }) }),
        h(
          'ul',
          { style: { ...S.listReset, gap: 3 } },
          ...warnings.map((warning, index) => h('li', {
            key: 'warning' + index,
            style: { fontSize: 11.5, lineHeight: 1.65, color: T.labelSecondary, wordBreak: 'break-word' }
          }, '· ' + formatValue(warning)))
        )
      );
    }

    function ProviderNotice(props) {
      const provider = isObject(props.provider) ? props.provider : null;
      const web = isObject(props.webProvider) ? props.webProvider : null;
      if (provider === null) return null;
      const failed = provider.configured === true && provider.ok === false;
      const webUsable = web !== null && web.ok === true;
      if (failed === false && provider.configured === true) {
        // MCP 正常 → 只在网页 provider 不可用时提示（网页是备用通道）
        if (web === null || webUsable) return null;
        const webError = isString(web.lastError) && web.lastError !== '' ? web.lastError : '';
        return h(
          Card,
          { style: { borderColor: T.borderL2 } },
          h(
            'div',
            { style: { ...S.row, gap: 7, color: T.warn } },
            h(IconAlert, { size: 15 }),
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, t('provider.webBad', { message: webError }))
          ),
          h('div', { style: { ...S.row } }, h(Button, { onClick: props.onRefresh, icon: h(IconRefresh, { size: 13 }) }, t('provider.recheck')))
        );
      }
      const lastError = isString(provider.lastError) && provider.lastError !== '' ? provider.lastError : '';
      const failedText = lastError === '' ? t('provider.failedGeneric') : t('provider.failedBody', { message: lastError });
      // MCP 未授权且网页通道可用 → 给出可执行替代方案
      if (failed && webUsable) {
        return h(
          Card,
          { style: { borderColor: T.borderL2 } },
          h(
            'div',
            { style: { ...S.row, gap: 7, color: T.warn } },
            h(IconAlert, { size: 15 }),
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, t('provider.webTitle'))
          ),
          h('p', { style: S.muted }, t('provider.webBody', { message: lastError })),
          h('div', { style: { ...S.row } }, h(Button, { onClick: props.onRefresh, icon: h(IconRefresh, { size: 13 }) }, t('provider.recheck')))
        );
      }
      return h(
        Card,
        { style: { borderColor: T.borderL2 } },
        h(
          'div',
          { style: { ...S.row, gap: 7, color: failed ? T.error : T.warn } },
          h(IconAlert, { size: 15 }),
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, failed ? t('provider.failedTitle') : t('provider.bannerTitle'))
        ),
        h('p', { style: S.muted }, failed ? failedText : t('provider.bannerBody')),
        h('div', { style: { ...S.row } }, h(Button, { onClick: props.onRefresh, icon: h(IconRefresh, { size: 13 }) }, t('provider.recheck')))
      );
    }

    function StatusBar(props) {
      const overview = isObject(props.overview) ? props.overview : {};
      const provider = isObject(props.provider) ? props.provider : null;
      let providerTone = T.idle;
      let providerLabel = t('status.unknown');
      if (provider !== null) {
        if (provider.configured === true && provider.ok === false) {
          providerTone = T.error;
          providerLabel = t('status.failed');
        } else if (provider.configured === true) {
          providerTone = T.success;
          providerLabel = t('status.configured');
        } else {
          providerTone = T.warn;
          providerLabel = t('status.notConfigured');
        }
      }
      const providerName = provider === null ? 'Sellersprite' : pickString(provider.label, 'Sellersprite');
      const marketplace = isString(overview.defaultMarketplace) ? overview.defaultMarketplace : '';
      const outputRoot = isString(overview.outputRoot) ? overview.outputRoot : '';
      return h(
        'div',
        {
          style: {
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '8px 12px',
            border: '0.5px solid ' + T.borderL1,
            borderRadius: T.radiusMd,
            background: T.bgLayer2,
            minWidth: 0
          }
        },
        h(Badge, { tone: providerTone, dot: true }, providerName + ' · ' + providerLabel),
        marketplace === '' ? null : h(Badge, null, t('status.marketplace') + '：' + marketplaceLabel(marketplace)),
        outputRoot === ''
          ? null
          : h('span', {
              title: outputRoot,
              style: { ...S.tiny, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '46%' }
            }, t('status.output') + '：' + outputRoot)
      );
    }

    // ─────────────────────────────────────────────────────────── 运行详情

    function RunDetail(props) {
      useLocaleTick();
      const runId = isString(props.runId) ? props.runId : '';
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
      const [revision, setRevision] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        if (runId === '') {
          setState({ phase: 'error', data: null, error: new Error('missing runId') });
          return () => {
            alive = false;
          };
        }
        setState({ phase: 'loading', data: null, error: null });
        request('runs/' + encodeURIComponent(runId))
          .then((data) => {
            if (alive) setState({ phase: 'ready', data: data, error: null });
          })
          .catch((error) => {
            if (alive) setState({ phase: 'error', data: null, error: error });
          });
        return () => {
          alive = false;
        };
      }, [runId, revision]);

      const backButton = h(Button, {
        tone: 'ghost',
        action: 'back',
        onClick: props.onBack,
        icon: h(IconBack, { size: 14 })
      }, t('detail.back'));
      const refreshButton = h(Button, {
        icon: h(IconRefresh, { size: 14 }),
        disabled: state.phase === 'loading',
        onClick: () => setRevision((value) => value + 1)
      }, t('detail.refresh'));

      if (state.phase === 'loading') {
        return h(React.Fragment, null,
          h('div', { style: { ...S.row, gap: 8 } }, backButton, refreshButton),
          h(Loading, { text: t('detail.loading') })
        );
      }
      if (state.phase === 'error') {
        return h(React.Fragment, null,
          h('div', { style: { ...S.row, gap: 8 } }, backButton, refreshButton),
          h(ErrorBox, {
            title: t('detail.errorTitle'),
            message: errorMessage(state.error),
            onRetry: () => setRevision((value) => value + 1),
            retryLabel: t('panel.retry')
          })
        );
      }

      const detail = isObject(state.data) ? state.data : {};
      const manifest = isObject(detail.manifest) ? detail.manifest : {};
      const scores = isObject(detail.scores) ? detail.scores : isObject(manifest.score) ? manifest.score : null;
      const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts : [];
      const reportMd = isString(detail.reportMd) ? detail.reportMd : isString(detail.report) ? detail.report : '';
      const title = pickString(manifest.title, detail.title, runId);
      const site = pickString(manifest.site, detail.site);
      const providerName = pickString(manifest.provider, detail.provider);
      const createdAt = manifest.createdAt === undefined || manifest.createdAt === null ? detail.createdAt : manifest.createdAt;
      const fetchedAt = manifest.fetchedAt === undefined || manifest.fetchedAt === null ? detail.fetchedAt : manifest.fetchedAt;
      const dir = pickString(manifest.dir, detail.dir);
      const warnings = Array.isArray(manifest.warnings) ? manifest.warnings : Array.isArray(detail.warnings) ? detail.warnings : [];
      const params = isObject(manifest.params) ? manifest.params : isObject(detail.params) ? detail.params : null;
      const usage = isObject(manifest.usage) ? manifest.usage : null;

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: { ...S.row, gap: 8 } },
          backButton,
          refreshButton,
          h('span', { style: { flex: '1 1 auto' } }),
          dir === ''
            ? null
            : h('span', {
                title: dir,
                style: { ...S.tiny, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }
              }, t('detail.dir', { dir: dir }))
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } },
          h('h2', { style: { margin: 0, fontSize: 16, lineHeight: 1.4, fontWeight: 600, wordBreak: 'break-word' } }, title),
          h(
            'div',
            { style: { ...S.row, gap: 10 } },
            site === '' ? null : h(Badge, null, t('runs.site', { site: site })),
            createdAt === undefined || createdAt === null ? null : h('span', { style: S.tiny }, t('detail.meta', { time: formatTime(createdAt) })),
            providerName === '' ? null : h('span', { style: S.tiny }, t('detail.provider', { provider: providerName })),
            fetchedAt === undefined || fetchedAt === null ? null : h('span', { style: S.tiny }, t('detail.fetchedAt', { time: formatTime(fetchedAt) }))
          )
        ),
        h(ScoreCard, { score: scores }),
        h(ReportCard, { reportMd: reportMd }),
        h(ArtifactsCard, { artifacts: artifacts, runId: pickString(detail.runId, runId) }),
        params === null && usage === null ? null : h(KeyValueCard, { title: t('detail.params'), data: params, extra: usage }),
        warnings.length === 0 ? null : h(WarningsCard, { warnings: warnings })
      );
    }

    // ─────────────────────────────────────────────────────────── 主面板

    function Panel() {
      useLocaleTick();
      const [overview, setOverview] = React.useState({ phase: 'loading', data: null, error: null });
      const [selected, setSelected] = React.useState(null);
      const [revision, setRevision] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        setOverview((previous) => ({
          phase: previous.data === null ? 'loading' : 'refreshing',
          data: previous.data,
          error: null
        }));
        request('overview')
          .then((data) => {
            if (alive) setOverview({ phase: 'ready', data: data, error: null });
          })
          .catch((error) => {
            if (alive) setOverview((previous) => ({ phase: 'error', data: previous.data, error: error }));
          });
        return () => {
          alive = false;
        };
      }, [revision]);

      const data = isObject(overview.data) ? overview.data : {};
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const provider = findProvider(data);
      const refreshing = overview.phase === 'refreshing';
      const staleError = overview.phase === 'error' ? overview.error : null;
      const pluginVersion = pickString(data.version, data.pluginVersion);

      function refresh() {
        setRevision((value) => value + 1);
      }

      const header = h(
        'header',
        { style: { flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 240px', minWidth: 0 } },
          h(
            'div',
            { style: { ...S.row, gap: 9 } },
            h('span', { style: { display: 'inline-flex', color: T.labelSecondary } }, h(IconTarget, { size: 18 })),
            h('h1', { style: S.title }, t('panel.title')),
            pluginVersion === '' ? null : h('span', { style: S.tiny }, t('panel.version', { version: pluginVersion }))
          ),
          h('p', { style: S.subtitle }, t('panel.subtitle'))
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', paddingTop: 2 } },
          h(Button, {
            action: 'refresh',
            ariaLabel: t('panel.refreshAria'),
            disabled: refreshing,
            onClick: refresh,
            icon: h(IconRefresh, { size: 14 })
          }, t('panel.refresh'))
        )
      );

      let content = null;
      if (overview.phase === 'loading') {
        content = h(Loading, { text: t('panel.loading') });
      } else if (overview.phase === 'error' && overview.data === null) {
        content = h(ErrorBox, {
          title: t('panel.errorTitle'),
          message: errorMessage(overview.error),
          onRetry: refresh,
          retryLabel: t('panel.retry')
        });
      } else if (selected !== null) {
        content = h(RunDetail, {
          runId: selected,
          onBack: () => setSelected(null)
        });
      } else {
        content = h(
          React.Fragment,
          null,
          staleError === null
            ? null
            : h(ErrorBox, {
                title: t('panel.errorTitle'),
                message: errorMessage(staleError),
                hint: t('panel.staleHint'),
                onRetry: refresh,
                retryLabel: t('panel.retry')
              }),
          h(ProviderNotice, { provider: provider, webProvider: findWebProvider(overview), onRefresh: refresh }),
          h(RunList, {
            runs: runs,
            onOpen: (runId) => {
              if (isString(runId) && runId !== '') setSelected(runId);
            }
          })
        );
      }

      return h(
        'div',
        { style: S.panel, 'data-amz-root': 'panel', 'data-plugin': PLUGIN },
        header,
        h(StatusBar, { overview: data, provider: provider }),
        h('div', { style: S.scroll }, content)
      );
    }

    // ─────────────────────────────────────────────────────────── 设置页

    function SettingsPage() {
      useLocaleTick();
      const [state, setState] = React.useState({
        phase: 'loading',
        marketplace: 'US',
        defaultLimit: '',
        outputRoot: '',
        configured: false,
        providerFailed: false,
        providerError: '',
        key: '',
        busy: '',
        keyMessage: null,
        defaultsMessage: null,
        loadWarning: '',
        clearArmed: false
      });
      const [revision, setRevision] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          let overview = null;
          let loadWarning = '';
          try {
            overview = await request('overview');
          } catch (error) {
            loadWarning = errorMessage(error);
          }
          if (alive === false) return;
          // 默认值来自 GET /overview 的 config 段（POST /settings 只写不读）。
          const config = isObject(overview) && isObject(overview.config) ? overview.config : {};
          const provider = findProvider(overview);
          const configured = provider !== null && provider.configured === true;
          setState((previous) => ({
            ...previous,
            phase: 'ready',
            marketplace: pickString(config.marketplace, isObject(overview) ? overview.defaultMarketplace : '') || 'US',
            defaultLimit: pickLimit(config.defaultLimit),
            outputRoot: pickString(config.outputRoot, isObject(overview) ? overview.outputRoot : ''),
            configured: configured,
            providerFailed: configured && provider.ok === false,
            providerError: provider !== null && isString(provider.lastError) ? provider.lastError : '',
            loadWarning: loadWarning
          }));
        })();
        return () => {
          alive = false;
        };
      }, [revision]);

      function patch(partial) {
        setState((previous) => ({ ...previous, ...partial }));
      }

      async function saveKey() {
        const key = state.key.trim();
        if (key === '') {
          patch({ keyMessage: { ok: false, text: t('settings.keyRequired') } });
          return;
        }
        patch({ busy: 'key', keyMessage: null });
        try {
          await postJson('credentials', { provider: 'sellersprite', key: key });
          patch({
            busy: '',
            key: '',
            configured: true,
            providerFailed: false,
            providerError: '',
            keyMessage: { ok: true, text: t('settings.keySaved') }
          });
          setRevision((value) => value + 1);
        } catch (error) {
          patch({
            busy: '',
            keyMessage: { ok: false, text: t('settings.keyFailed') + '：' + errorMessage(error) }
          });
        }
      }

      async function clearKey() {
        patch({ busy: 'clear' });
        try {
          await deleteJson('credentials', { provider: 'sellersprite' });
          patch({
            busy: '',
            configured: false,
            providerFailed: false,
            providerError: '',
            clearArmed: false,
            keyMessage: { ok: true, text: t('settings.keyCleared') }
          });
          setRevision((value) => value + 1);
        } catch (error) {
          patch({
            busy: '',
            clearArmed: false,
            keyMessage: { ok: false, text: t('settings.keyClearFailed') + '：' + errorMessage(error) }
          });
        }
      }

      async function saveDefaults() {
        const rawLimit = state.defaultLimit === undefined || state.defaultLimit === null ? '' : String(state.defaultLimit).trim();
        const body = {
          marketplace: state.marketplace,
          outputRoot: state.outputRoot === undefined || state.outputRoot === null ? '' : String(state.outputRoot).trim()
        };
        if (rawLimit !== '') {
          const parsed = Number(rawLimit);
          if (Number.isFinite(parsed) === false || parsed < 10 || parsed > 100 || Math.floor(parsed) !== parsed) {
            patch({ defaultsMessage: { ok: false, text: t('settings.limitInvalid') } });
            return;
          }
          body.defaultLimit = parsed;
        }
        patch({ busy: 'defaults', defaultsMessage: null });
        try {
          await postJson('settings', body);
          patch({ busy: '', defaultsMessage: { ok: true, text: t('settings.saved') } });
          setRevision((value) => value + 1);
        } catch (error) {
          patch({
            busy: '',
            defaultsMessage: { ok: false, text: t('settings.saveFailed') + '：' + errorMessage(error) }
          });
        }
      }

      if (state.phase === 'loading') {
        return h(
          'div',
          { style: S.settingsRoot, 'data-amz-root': 'settings', 'data-plugin': PLUGIN },
          h(Loading, { text: t('settings.loading') })
        );
      }

      const busy = state.busy !== '';
      const configuredTone = state.providerFailed ? T.error : state.configured ? T.success : T.warn;
      const configuredLabel = state.providerFailed
        ? t('status.failed')
        : state.configured
          ? t('settings.keyConfigured')
          : t('settings.keyNotConfigured');

      const keyCard = h(
        Card,
        null,
        h(SectionHead, {
          title: t('settings.keySection'),
          icon: h(IconKey, { size: 14 }),
          extra: h(Badge, { tone: configuredTone, dot: true }, configuredLabel)
        }),
        h(
          Field,
          { label: t('settings.keyLabel'), description: t('settings.keyHint'), controlId: 'amz-key' },
          h(Input, {
            id: 'amz-key',
            type: 'password',
            value: state.key,
            placeholder: state.configured ? t('settings.keyPlaceholderSet') : t('settings.keyPlaceholder'),
            disabled: busy,
            onChange: (event) => patch({ key: event.target.value, keyMessage: null }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveKey();
              }
            },
            style: { flex: '1 1 200px', maxWidth: 340 }
          }),
          h(Button, {
            tone: 'primary',
            action: 'save-key',
            disabled: busy,
            onClick: () => {
              void saveKey();
            },
            icon: h(IconKey, { size: 13 })
          }, state.busy === 'key' ? t('settings.keySaving') : t('settings.keySave'))
        ),
        state.providerFailed && state.providerError !== ''
          ? h('p', { style: { ...S.tiny, color: T.error, wordBreak: 'break-word' } }, t('provider.failedBody', { message: state.providerError }))
          : null,
        state.configured
          ? h(
              'div',
              { style: { ...S.row, gap: 8 } },
              h('span', { style: S.tiny }, t('settings.configuredNote')),
              h('span', { style: { flex: '1 1 auto' } }),
              state.clearArmed
                ? h(
                    React.Fragment,
                    null,
                    h(Button, {
                      tone: 'danger',
                      disabled: busy,
                      onClick: () => {
                        void clearKey();
                      }
                    }, t('settings.keyClearConfirm')),
                    h(Button, { tone: 'ghost', disabled: busy, onClick: () => patch({ clearArmed: false }) }, t('settings.keyCancel'))
                  )
                : h(Button, {
                    tone: 'ghost',
                    action: 'clear-key',
                    disabled: busy,
                    onClick: () => patch({ clearArmed: true })
                  }, t('settings.keyClear'))
            )
          : null,
        h(Msg, { message: state.keyMessage })
      );

      const defaultsCard = h(
        Card,
        null,
        h(SectionHead, { title: t('settings.defaultsSection'), icon: h(IconSliders, { size: 14 }) }),
        h(
          Field,
          { label: t('settings.marketplaceLabel'), description: t('settings.marketplaceDesc'), controlId: 'amz-marketplace' },
          h(Select, {
            id: 'amz-marketplace',
            value: state.marketplace,
            disabled: busy,
            options: MARKETPLACES,
            onChange: (event) => patch({ marketplace: event.target.value, defaultsMessage: null })
          })
        ),
        h(
          Field,
          { label: t('settings.limitLabel'), description: t('settings.limitDesc'), controlId: 'amz-limit' },
          h(Input, {
            id: 'amz-limit',
            type: 'number',
            min: '10',
            max: '100',
            step: '1',
            inputMode: 'numeric',
            value: state.defaultLimit,
            placeholder: '50',
            disabled: busy,
            onChange: (event) => patch({ defaultLimit: event.target.value, defaultsMessage: null }),
            style: { width: 130 }
          })
        ),
        h(
          Field,
          { label: t('settings.outputLabel'), description: t('settings.outputDesc'), controlId: 'amz-output' },
          h(Input, {
            id: 'amz-output',
            type: 'text',
            value: state.outputRoot,
            placeholder: t('settings.outputPlaceholder'),
            disabled: busy,
            onChange: (event) => patch({ outputRoot: event.target.value, defaultsMessage: null }),
            style: { flex: '1 1 220px', maxWidth: 340 }
          })
        ),
        h(
          'div',
          { style: { ...S.row, justifyContent: 'flex-end', gap: 10 } },
          h(Msg, { message: state.defaultsMessage }),
          h(Button, {
            tone: 'primary',
            action: 'save-settings',
            disabled: busy,
            onClick: () => {
              void saveDefaults();
            }
          }, state.busy === 'defaults' ? t('settings.saving') : t('settings.save'))
        )
      );

      return h(
        'div',
        { style: S.settingsRoot, 'data-amz-root': 'settings', 'data-plugin': PLUGIN },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
          h('h1', { style: S.title }, t('settings.title')),
          h('p', { style: S.subtitle }, t('settings.subtitle'))
        ),
        state.loadWarning === ''
          ? null
          : h(
              Card,
              { style: { borderColor: T.borderL2 } },
              h(
                'div',
                { style: { ...S.row, gap: 7, color: T.warn } },
                h(IconAlert, { size: 15 }),
                h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, t('settings.loadFailed'))
              ),
              h('p', { style: { ...S.muted, wordBreak: 'break-word' }, role: 'alert' }, state.loadWarning),
              h(
                'div',
                { style: { ...S.row } },
                h(Button, {
                  onClick: () => setRevision((value) => value + 1),
                  icon: h(IconRefresh, { size: 13 })
                }, t('settings.reload'))
              )
            ),
        keyCard,
        defaultsCard
      );
    }

    // ─────────────────────────────────────────────────────────── 侧栏图标

    function PanelIcon(props) {
      const size = props !== undefined && props !== null && Number(props.size) > 0 ? Number(props.size) : 18;
      const active = props !== undefined && props !== null && props.active === true;
      return h(
        'span',
        {
          'aria-hidden': 'true',
          'data-plugin': PLUGIN,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: active ? T.label : T.labelSecondary,
            borderRadius: T.radiusXs
          }
        },
        h(IconTarget, { size: size })
      );
    }

    // ─────────────────────────────────────────────────────────── 注册

    function warn(where, error) {
      try {
        console.warn('[' + PLUGIN + '] ' + where + ' 失败：' + messageOf(error));
      } catch (error) {
        /* 控制台不可用也无所谓 */
      }
    }

    /**
     * 每个插槽独立注册、独立 try/catch：宿主版本旧、插槽不存在或注册签名变化时，
     * 只让该功能缺失，绝不冒泡到设置面板 / 侧栏。
     */
    function registerSlot(ctx, slotName, params, Component, effectLabel) {
      ctx.effect(() => {
        let dispose = null;
        try {
          dispose = ctx.slots.inject(slotName, () => {
            try {
              return ctx.slots.register(params, Component);
            } catch (error) {
              warn('register ' + slotName, error);
              return undefined;
            }
          });
        } catch (error) {
          warn('inject ' + slotName, error);
          return undefined;
        }
        return () => {
          if (typeof dispose === 'function') {
            try {
              dispose();
            } catch (error) {
              warn('dispose ' + slotName, error);
            }
          }
        };
      }, effectLabel);
    }

    function localeLabel(ctx, key, fallback) {
      try {
        const bound = ctx.locale.bind(NS);
        if (typeof bound === 'function') {
          const value = bound(key);
          if (isString(value) && value !== '') return value;
        }
      } catch (error) {
        /* 回落硬编码文案 */
      }
      return fallback;
    }

    function apply(ctx) {
      i18n = createI18n(ctx);

      // ① 文案：中英字典都注册（失败只影响文案，不影响功能）。
      ctx.effect(() => {
        const disposers = [];
        for (const tag of LOCALE_TAGS) {
          const dict = /^en/i.test(tag) ? EN : ZH;
          try {
            disposers.push(ctx.locale.register(NS, tag, dict));
          } catch (error) {
            if (/already|duplicate|occupied/i.test(messageOf(error)) === false) warn('locale ' + tag, error);
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (error) {
              /* 幂等 disposer */
            }
          }
        };
      }, PLUGIN + ': locale');

      // ② 侧栏入口（id 与主面板 key 一一对应）。
      registerSlot(
        ctx,
        'sidebar.panellist',
        {
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: 40,
          label: () => localeLabel(ctx, 'panel.entryLabel', '选品研究')
        },
        PanelIcon,
        PLUGIN + ': sidebar panel icon'
      );

      // ③ 中央主面板。
      registerSlot(ctx, 'main', { name: 'main', key: PANEL_KEY }, Panel, PLUGIN + ': main panel');

      // ④ 设置页。
      registerSlot(
        ctx,
        'settings.section',
        {
          name: 'settings.section',
          id: SETTINGS_ID,
          order: 60,
          label: () => localeLabel(ctx, 'settings.label', '亚马逊选品研究')
        },
        SettingsPage,
        PLUGIN + ': settings section'
      );
    }

    // 样式全部内联（hover / focus 由组件内 state 驱动），不向 document 注入 <style>。

    return { name: PLUGIN, inject: ['slots', 'locale'], apply };
  }
});
