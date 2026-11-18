import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name, inject, version } from '../index.js';

/** 最小 Cordis 上下文桩：只实现插件用到的能力 */
function fakeCtx() {
  const registered = [];
  const health = [];
  const sections = [];
  const providers = [];
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {
          const index = registered.indexOf(tool);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
    effect(fn) {
      return fn();
    },
    inject(_deps, cb) {
      cb(ctx);
    },
    get(service) {
      if (service === 'systemPrompt') {
        return {
          section(section) {
            sections.push(section);
          },
        };
      }
      if (service === 'skills') {
        return {
          registerProvider(factory) {
            providers.push(factory());
            return () => {};
          },
        };
      }
      if (service === 'webServer') return null;
      return null;
    },
  };
  return { ctx, registered, sections, providers, health };
}

test('插件导出契约正确', () => {
  assert.equal(name, 'dsh-amazon-research');
  assert.ok(inject.includes('tools'));
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('apply 注册工具、系统提示与技能提供者', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsr-plugin-'));
  try {
    const { ctx, registered, sections, providers } = fakeCtx();
    apply(ctx, { dataDir });
    const names = registered.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['mcp_call', 'research_category_select', 'research_page', 'research_product_select', 'research_provider_status', 'research_runs', 'research_saudi_discovery', 'research_saudi_source', 'research_unit_cost']);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'dsh-amazon-research');
    assert.equal(providers.length, 1);
    const skills = await providers[0].list();
    assert.ok(Array.isArray(skills));
    const namesList = skills.map((skill) => skill.name);
    assert.deepEqual(namesList.sort(), ['amazon-category-selection', 'amazon-product-selection', 'trendyol-saudi-product-selection']);
    assert.match(sections[0].text, /美国站保留原 Amazon US/);
    const loaded = await providers[0].get(skills.find(s => s.name === 'trendyol-saudi-product-selection'));
    assert.match(loaded.content, /Trendyol\.sa/);
    assert.match(sections[0].text, /100分/);
    assert.equal(loaded.content.startsWith('---'), false, '应剥离 frontmatter');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
