// 接口验收：真起一个 http 服务，走契约里的每个端点（含仪表盘 HTML 的 __BASE__ 替换）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { MemoryStore } from '../lib/store.js';
import { createApi } from '../lib/index.js';

async function boot(base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-http-'));
  const store = new MemoryStore(dir).load();
  const api = createApi(store, { base });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const sub = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    api.route(sub === '/' ? '' : sub, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = 'http://127.0.0.1:' + port + base;
  return { store, server, origin, close: () => new Promise((r) => server.close(r)) };
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  return { status: res.status, body: await res.json() };
}
const post = (url, body) => getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('仪表盘 HTML 由路由吐出，并且 __BASE__ 被替换成实际前缀', async () => {
  const app = await boot('/fish-memory');
  try {
    const res = await fetch(app.origin + '/');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.ok(html.includes("window.__FM_BASE__ = '/fish-memory'"), 'BASE 必须被替换');
    assert.ok(!html.includes('__BASE__'), '不能残留占位符');
    assert.ok(html.length > 20000, '仪表盘应当是完整单文件');
  } finally {
    await app.close();
  }
});

test('完整 CRUD + 回忆强化 + 衰减 + 参数 的 HTTP 闭环', async () => {
  const app = await boot('/fish-memory');
  try {
    const created = await post(app.origin + '/api/create', { title: '爹地的口味', content: '喜欢干练直接，不喜欢客套。', tags: ['user'] });
    assert.equal(created.body.ok, true);
    const id = created.body.memory.id;
    assert.equal(created.body.memory.layer, 'recall');

    const read = await post(app.origin + '/api/read', { id, sessionId: 'test' });
    assert.equal(read.body.memory.clicks, 1);
    assert.equal(read.body.memory.layer, 'hot');
    assert.equal(read.body.counted, true);

    const dedup = await post(app.origin + '/api/read', { id, sessionId: 'test' });
    assert.equal(dedup.body.counted, false);

    const state = await getJson(app.origin + '/api/state');
    assert.equal(state.body.stats.total, 1);
    assert.ok(state.body.stats.tokens.savedTokens > 0);

    const index = await getJson(app.origin + '/api/index');
    assert.equal(index.body.layers.hot.length, 1);
    assert.equal(index.body.layers.hot[0].content, undefined, '索引不下发正文');
    assert.ok(index.body.layers.hot[0].createdAt, '索引每行必须带录入时间');
    assert.equal(index.body.sort, 'strength');

    const byTime = await getJson(app.origin + '/api/index?sort=time');
    assert.equal(byTime.body.sort, 'time');
    assert.ok(byTime.body.layers.hot[0].createdAt);

    const timeline = await getJson(app.origin + '/api/timeline');
    assert.equal(timeline.body.ok, true);
    assert.equal(timeline.body.items[0].id, id);
    assert.ok(timeline.body.items[0].createdAt, '时间线必须带 createdAt');

    const moved = await post(app.origin + '/api/move', { id, layer: 'cold' });
    assert.equal(moved.body.memory.layer, 'cold');

    const revived = await post(app.origin + '/api/revive', { id });
    assert.equal(revived.body.memory.layer, 'hot');

    const sunk = await post(app.origin + '/api/forget', { id, hard: false });
    assert.equal(sunk.body.memory.layer, 'recall');

    const tomb = await post(app.origin + '/api/forget', { id, hard: true });
    assert.equal(tomb.body.tombstone.title, '爹地的口味');
    const tombs = await getJson(app.origin + '/api/tombstones');
    assert.equal(tombs.body.tombstones.length, 1);

    const back = await post(app.origin + '/api/revive', { id });
    assert.equal(back.body.memory.layer, 'hot');

    const decay = await post(app.origin + '/api/decay', {});
    assert.ok(Array.isArray(decay.body.transitions));

    const cfg = await post(app.origin + '/api/config', { patch: { decayFactor: 0.9, thresholds: { hot: 6 } } });
    assert.equal(cfg.body.config.decayFactor, 0.9);
    assert.equal(cfg.body.config.thresholds.hot, 6);

    const tags = await getJson(app.origin + '/api/tags');
    assert.equal(tags.body.ok, true);
    assert.deepEqual(tags.body.tags.map((t) => t.tag), ['user']);

    const search = await post(app.origin + '/api/search', { query: 'user', mode: 'auto' });
    assert.equal(search.body.ok, true);
    assert.ok(search.body.tagHits.length >= 1, '标签命中应排在前面');
    assert.equal(search.body.tagHits[0].id, id);

    const full = await getJson(app.origin + '/api/index');
    const allIndexed = Object.values(full.body.layers).flat();
    assert.ok(allIndexed.some((m) => Array.isArray(m.tags) && m.tags.includes('user')), '索引要带 tags（检索时先看标签）');

    const audit = await getJson(app.origin + '/api/audit?limit=10');
    assert.ok(audit.body.events.length >= 5);

    const bad = await post(app.origin + '/api/reset', {});
    assert.equal(bad.body.ok, false);
    const ok = await post(app.origin + '/api/reset', { confirm: 'RESET' });
    assert.equal(ok.body.ok, true);
    const after = await getJson(app.origin + '/api/state');
    assert.equal(after.body.stats.total, 0);
  } finally {
    await app.close();
  }
});

test('未知接口 404，坏请求体 400，错误信息不吞', async () => {
  const app = await boot('/fish-memory');
  try {
    const miss = await getJson(app.origin + '/api/nope');
    assert.equal(miss.status, 404);
    assert.equal(miss.body.ok, false);
    const res = await fetch(app.origin + '/api/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    const empty = await post(app.origin + '/api/create', { title: 'x', content: '' });
    assert.equal(empty.body.ok, false);
  } finally {
    await app.close();
  }
});
