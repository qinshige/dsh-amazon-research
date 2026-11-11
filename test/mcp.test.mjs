import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, pickResponse, unwrapToolResult, McpHttpClient } from '../host/mcp/client.js';

test('parseSse 支持多行 data 与空行分隔', () => {
  const text = 'event: message\ndata: {"a":1}\n\ndata: {"b":2}\n\n';
  assert.deepEqual(parseSse(text), ['{"a":1}', '{"b":2}']);
});

test('pickResponse 从 SSE 中按 id 取结果', () => {
  const text = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  const hit = pickResponse(text, 1);
  assert.equal(hit.result.ok, true);
});

test('pickResponse 支持纯 JSON 响应', () => {
  const text = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { ok: 'yes' } });
  assert.equal(pickResponse(text, 3).result.ok, 'yes');
});

test('unwrapToolResult 解析 content[0].text 里的 JSON 字符串', () => {
  const result = { content: [{ type: 'text', text: '{"code":200,"data":{"items":[1,2]}}' }] };
  const value = unwrapToolResult(result);
  assert.equal(value.code, 200);
  assert.deepEqual(value.data.items, [1, 2]);
});

test('unwrapToolResult 无 JSON 时返回原文本', () => {
  const value = unwrapToolResult({ content: [{ type: 'text', text: 'plain text' }] });
  assert.equal(value, 'plain text');
});

test('McpHttpClient 用 SSE 初始化并调用工具', async () => {
  const calls = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    if (body.method === 'initialize') {
      return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } }) + '\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"code":200,"data":[{"label":"1"}]}' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new McpHttpClient({ url: 'https://example.invalid/mcp', headers: { 'secret-key': 'x' }, fetchImpl: fakeFetch });
  const value = await client.callTool('market_price_distribution', { request: { marketplace: 'US' } });
  assert.equal(value.code, 200);
  assert.deepEqual(value.data, [{ label: '1' }]);
  assert.deepEqual(calls, ['initialize', 'tools/call']);
});

test('McpHttpClient 把 HTTP 错误转换为可读异常', async () => {
  const fakeFetch = async () => new Response('secret_unauthorized', { status: 401 });
  const client = new McpHttpClient({ url: 'https://example.invalid/mcp', fetchImpl: fakeFetch, retries: 0 });
  await assert.rejects(() => client.callTool('x', {}), /MCP HTTP 401/);
});
