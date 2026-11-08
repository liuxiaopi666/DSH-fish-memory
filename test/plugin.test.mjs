// 装配验收：用假 ctx 跑 apply()，确认工具/路由/定时器/提示注入都真的注册到了
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as plugin from '../lib/index.js';

function fakeCtx() {
  const tools = [];
  const routes = [];
  const effects = [];
  const promptSections = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn, label) {
      effects.push(label);
      const dispose = typeof fn === 'function' ? fn() : undefined;
      return dispose;
    },
    tools: { register(def) { if (!def || !def.name) throw new Error('bad tool'); tools.push(def); return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    systemPrompt: {
      // 真实 API：context(...) 动态、section(...) 静态
      context(entry) {
        promptSections.push({ kind: 'context', ...entry });
        return () => {};
      },
      section(entry) {
        promptSections.push({ kind: 'section', ...entry });
        return () => {};
      },
    },
  };
  return { ctx, tools, routes, effects, promptSections };
}

test('apply() 注册 18 个记忆工具 + 仪表盘路由 + 衰减定时器 + hot 标题注入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-plugin-'));
  const { ctx, tools, routes, effects, promptSections } = fakeCtx();
  const store = plugin.apply(ctx, { storeDir: dir, basePath: '/fish-memory' });

  assert.equal(plugin.name, 'fish-memory');
  assert.deepEqual(plugin.inject, ['tools', 'webServer', 'systemPrompt']);

  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'memory_config', 'memory_decay', 'memory_forget', 'memory_index', 'memory_ingest',
    'memory_list', 'memory_live_append', 'memory_live_read', 'memory_move', 'memory_read',
    'memory_retitle', 'memory_revive', 'memory_search', 'memory_stats', 'memory_tags',
    'memory_timeline', 'memory_update', 'memory_write',
  ]);
  for (const t of tools) {
    assert.ok(t.description.length > 10, t.name + ' 缺 description');
    assert.equal(typeof t.execute, 'function', t.name + ' 缺 execute');
    assert.equal(typeof t.output.render, 'function', t.name + ' 缺 render');
  }

  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/fish-memory');
  assert.equal(typeof routes[0].handler, 'function');
  assert.ok(effects.length >= 2, '工具与定时器都应挂到 ctx.effect');
  // 两个动态上下文：跨端事件流（live）+ hot 标题
  assert.equal(promptSections.length, 2);
  const hotSection = promptSections.find((s) => s.name === 'fish-memory:hot');
  assert.ok(hotSection, '必须有 fish-memory:hot 小节');
  assert.equal(hotSection.kind, 'context');
  assert.equal(typeof hotSection.text, 'function', 'context.text 必须是函数，才能每步重新取 hot 标题');
  // 空库时注入内容为空串（不往提示里塞空标题）
  assert.equal(hotSection.text(), '');

  // 工具真的能读写同一个 store
  store.create({ title: '注入测试', content: '正文' });
  const index = tools.find((t) => t.name === 'memory_index');
  return index.execute({}).then((view) => {
    assert.equal(view.layers.recall.length, 1);
    const write = tools.find((t) => t.name === 'memory_write');
    return write.execute({ title: '第二条', content: '内容', tags: ['t'] });
  }).then((r) => {
    assert.equal(r.memory.title, '第二条');
    const stats = tools.find((t) => t.name === 'memory_stats');
    return stats.execute({});
  }).then((s) => {
    assert.equal(s.stats.total, 2);
    // 有记忆之后，动态上下文必须带上 hot 标题（这是"第 1 层默认可见"的落点）
    const target = store.memories.find((m) => m.title === '注入测试');
    store.move(target.id, 'hot');
    assert.ok(hotSection.text().includes('注入测试'), '注入内容应包含 hot 标题');
  });
});

test('通过插件路由发出的请求，走的是同一份磁盘数据', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-route-'));
  const { ctx, routes } = fakeCtx();
  plugin.apply(ctx, { storeDir: dir, basePath: '/fish-memory' });
  const handler = routes[0].handler;

  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(body) { this.body = body; return this; },
  };
  const req = { method: 'GET', url: '/fish-memory/api/state' };
  handler(req, res);
  const parsed = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stats.total, 0);

  const htmlRes = { writeHead(s, h) { this.status = s; this.headers = h; return this; }, end(b) { this.body = b; }, status: 0, headers: {}, body: '' };
  handler({ method: 'GET', url: '/fish-memory/' }, htmlRes);
  assert.equal(htmlRes.status, 200);
  assert.ok(htmlRes.body.includes("window.__FM_BASE__ = '/fish-memory'"));
});
