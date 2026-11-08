// 引擎验收：分层、回忆强化、去重、衰减、hot 预算、墓碑复活、持久化、参数护栏
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, normalizeConfig, estimateTokens } from '../lib/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-test-'));
  return new MemoryStore(dir).load();
}

test('create 落在 recall 层，read 后升到 hot 且分数、点击都 +1', () => {
  const store = tmpStore();
  const m = store.create({ title: '爹地的偏好', content: '喜欢简洁、直接的回答，讨厌长篇大论。' });
  assert.equal(m.layer, 'recall');
  const r1 = store.read(m.id, { sessionId: 's1' });
  assert.equal(r1.counted, true);
  assert.equal(r1.memory.layer, 'hot');
  assert.equal(r1.memory.clicks, 1);
  assert.equal(r1.memory.strength, 3); // createStrength 2 + recallBoost 1
});

test('同会话窗口内重复读取只返回内容、不计数（批评②）', () => {
  const store = tmpStore();
  const m = store.create({ title: '重复读测试', content: '内容内容内容' });
  store.read(m.id, { sessionId: 's1' });
  const r2 = store.read(m.id, { sessionId: 's1' });
  assert.equal(r2.counted, false);
  assert.equal(r2.memory.clicks, 1);
  // 换会话则照常计数
  const r3 = store.read(m.id, { sessionId: 's2' });
  assert.equal(r3.counted, true);
  assert.equal(r3.memory.clicks, 2);
});

test('衰减按每条自己的时长结算：刚录入的几乎不掉分', () => {
  const store = tmpStore();
  store.setConfig({ decayFactor: 0.5, decayIntervalHours: 24 });
  const m = store.create({ title: '刚记下的', content: 'x' });
  const before = store.find(m.id).strength;
  store.decayRound(Date.now() + 30 * 60 * 1000); // 过了 30 分钟
  const after = store.find(m.id).strength;
  assert.ok(after < before, '该掉一点点');
  assert.ok(after > before * 0.98, '半小时只该扣半小时的量（不该整刀 0.5）：' + after);
  // 半小时 = 1/48 单位 ⇒ 0.5^(1/48) ≈ 0.9857
  assert.ok(Math.abs(after / before - Math.pow(0.5, 1 / 48)) < 0.01, '要按指数比例：' + after / before);
});

test('不同录入时间的记忆各自衰减（不是统一结算）', () => {
  const store = tmpStore();
  store.setConfig({ decayFactor: 0.5, decayIntervalHours: 24 });
  const oldOne = store.create({ title: '一天前记的', content: 'old' });
  const base = Date.now();
  // 把老记忆的锚点挪到 24 小时前，再放一条新的
  store.find(oldOne.id).decayAnchorAt = new Date(base - 24 * 3600 * 1000).toISOString();
  const fresh = store.create({ title: '刚记的', content: 'fresh' });
  const freshBefore = store.find(fresh.id).strength;
  store.decayRound(base);
  assert.equal(store.find(oldOne.id).strength, 1, '满 24h 的应掉一半（2 → 1）');
  assert.equal(store.find(fresh.id).strength, freshBefore, '刚录入的这轮不该掉');
});

test('读一次＝衰减重新计时（背一次就重新开始忘）', () => {
  const store = tmpStore();
  store.setConfig({ decayFactor: 0.5, decayIntervalHours: 24 });
  const m = store.create({ title: '背过一遍', content: 'y' });
  store.find(m.id).decayAnchorAt = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  store.read(m.id, { sessionId: 's' });       // 回忆 → 锚点重置为现在
  const afterRead = store.find(m.id).strength;
  store.decayRound(Date.now() + 60 * 1000);   // 读完之后只过了 1 分钟
  assert.ok(store.find(m.id).strength > afterRead * 0.999, '刚背过不该被扣旧账');
});

test('衰减会跨层下沉并记录 transition（按满时长）', () => {
  const store = tmpStore();
  store.setConfig({ decayFactor: 0.5, decayIntervalHours: 24 });
  const m = store.create({ title: '会忘的事', content: '短视频里的那个梗' });
  store.read(m.id, { sessionId: 'x' });
  assert.equal(store.find(m.id).layer, 'hot');
  const day = 24 * 3600 * 1000;
  const round1 = store.decayRound(Date.now() + day);
  assert.ok(round1.transitions.some((t) => t.id === m.id && t.to === 'recall'), 'hot 应下沉 recall');
  const round2 = store.decayRound(Date.now() + 2 * day);
  assert.ok(round2.transitions.some((t) => t.id === m.id), '再满一天应继续下沉');
});

test('hot 层硬 token 预算：超预算的低分记忆强制沉到 recall（批评③）', () => {
  const store = tmpStore();
  store.setConfig({ hotBudgetTokens: 10, thresholds: { hot: 0.1, recall: 0.05, archive: 0.01 } });
  const big = 'x'.repeat(60); // 标题约 30 tokens，单条就超预算
  const a = store.create({ title: big, content: '正文 A' });
  const b = store.create({ title: '短标题', content: '正文 B' });
  store.read(a.id, { sessionId: 's' });
  store.read(b.id, { sessionId: 's' });
  const hot = store.memories.filter((m) => m.layer === 'hot');
  assert.ok(hot.length <= 1, 'hot 层不能超预算留两条');
});

test('遗忘是下沉不是销毁；hard 只进墓碑且可复活（批评①）', () => {
  const store = tmpStore();
  const m = store.create({ title: '旧事', content: '很久以前的事' });
  store.move(m.id, 'hot');
  const soft = store.forget(m.id);
  assert.equal(soft.memory.layer, 'recall');
  assert.equal(store.memories.length, 1);
  const hard = store.forget(m.id, { hard: true });
  assert.equal(hard.memory, null);
  assert.equal(store.memories.length, 0);
  assert.equal(store.tombstones.length, 1);
  const revived = store.revive(m.id);
  assert.equal(revived.layer, 'hot');
  assert.equal(store.memories.length, 1);
  assert.equal(store.tombstones.length, 0);
  assert.equal(revived.content, '很久以前的事');
});

test('索引视图只给标题，并算出省下的 token', () => {
  const store = tmpStore();
  store.create({ title: '短标题', content: 'y'.repeat(400) });
  const view = store.indexView();
  assert.ok(view.layers.recall.length === 1);
  assert.equal(view.layers.recall[0].title, '短标题');
  assert.equal(view.layers.recall[0].content, undefined, '索引不得携带正文');
  assert.ok(view.tokens.savedTokens > 150);
  assert.equal(estimateTokens('四个字'), 2);
});

test('持久化：重开 store 后记忆、墓碑、参数都还在', () => {
  const store = tmpStore();
  const m = store.create({ title: '持久化', content: '写入磁盘' });
  store.read(m.id, { sessionId: 's' });
  store.setConfig({ decayFactor: 0.9 });
  store.forget(m.id, { hard: true });
  const again = new MemoryStore(store.dir).load();
  assert.equal(again.memories.length, 0);
  assert.equal(again.tombstones.length, 1);
  assert.equal(again.tombstones[0].title, '持久化');
  assert.equal(again.config.decayFactor, 0.9);
});

test('参数护栏：decayFactor 必须落在 (0,1]，阈值不许倒挂', () => {
  const c = normalizeConfig({ decayFactor: 3, thresholds: { hot: 1, recall: 9, archive: 4 } });
  assert.equal(c.decayFactor, 0.98);
  assert.ok(c.thresholds.hot > c.thresholds.recall);
  assert.ok(c.thresholds.recall >= c.thresholds.archive);
  assert.equal(normalizeConfig({ decayFactor: 0 }).decayFactor, 0.98);
  assert.equal(normalizeConfig({ decayFactor: 0.7 }).decayFactor, 0.7);
});

test('标签词表：按条数降序，带分层分布', () => {
  const store = tmpStore();
  store.create({ title: 'A', content: 'aa', tags: ['记忆系统', '插件'] });
  store.create({ title: 'B', content: 'bb', tags: ['记忆系统'] });
  const tags = store.listTags();
  assert.equal(tags[0].tag, '记忆系统');
  assert.equal(tags[0].count, 2);
  assert.equal(tags[0].byLayer.recall, 2);
  assert.equal(tags[1].tag, '插件');
});

test('检索：先标签后标题，标签命中并带 match 类型与分数', () => {
  const store = tmpStore();
  const a = store.create({ title: '完全无关的标题', content: 'x', tags: ['记忆系统'] });
  const b = store.create({ title: '记忆系统怎么写', content: 'y', tags: ['其他'] });
  const r = store.search('记忆系统');
  assert.equal(r.tagHits.length, 1, '标签命中 1 条');
  assert.equal(r.tagHits[0].id, a.id);
  assert.equal(r.tagHits[0].match, 'exact');
  assert.equal(r.tagHits[0].score, 3);
  assert.equal(r.titleHits.length, 1, '标题命中 1 条');
  assert.equal(r.titleHits[0].id, b.id);
  // mode 限定：只看标签 / 只看标题
  assert.equal(store.search('记忆系统', { mode: 'tag' }).titleHits.length, 0);
  assert.equal(store.search('记忆系统', { mode: 'title' }).tagHits.length, 0);
  // 前缀与子串命中也要能搜到，并给出相关标签候选
  store.create({ title: '前缀测试', content: 'z', tags: ['记忆'] });
  assert.equal(store.search('记忆', { mode: 'tag' }).tagHits.length, 2);
  assert.ok(store.search('记忆').allTags.some((t) => t.tag === '记忆系统'));
  // 层过滤
  store.read(a.id, { sessionId: 's' });
  assert.equal(store.search('记忆系统', { layer: 'hot' }).tagHits.length, 1);
  assert.equal(store.search('记忆系统', { layer: 'cold' }).tagHits.length, 0);
});

test('多进程安全：别的进程写过之后，本进程写不会覆盖它', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-concurrent-'));
  const a = new MemoryStore(dir).load();
  a.create({ title: 'A 写的', content: 'aaa' });

  // b 是"另一个进程"：独立实例，同一目录
  const b = new MemoryStore(dir).load();
  b.create({ title: 'B 写的', content: 'bbb，而且更长一点' });
  assert.equal(new MemoryStore(dir).load().memories.length, 2);

  // a 此时内存里只有 1 条；它再写一条时不能把 b 的那条抹掉
  a.create({ title: 'A 再写', content: 'ccc' });
  const after = new MemoryStore(dir).load();
  const titles = after.memories.map((m) => m.title);
  assert.equal(titles.length, 3, '三条都要在');
  for (const want of ['A 写的', 'A 再写', 'B 写的']) assert.ok(titles.includes(want), want + ' 不能丢');
});

test('读取也会先对齐磁盘（不会拿旧副本判断）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-refresh-'));
  const a = new MemoryStore(dir).load();
  const m = a.create({ title: '目标', content: '内容' });

  const b = new MemoryStore(dir).load();
  b.read(m.id, { sessionId: 'other' });
  b.decayRound();

  // a 的副本还是旧分数；read 前会 ensureFresh，strength 应基于磁盘上的新值累加
  a.read(m.id, { sessionId: 'mine' });
  const disk = new MemoryStore(dir).load().find(m.id);
  assert.equal(disk.clicks, 2, '两次来自不同进程的回忆都要记上');
});

test('审计日志与统计', () => {
  const store = tmpStore();
  const m = store.create({ title: '审计', content: 'z' });
  store.read(m.id, { sessionId: 's' });
  store.forget(m.id, { hard: true });
  const tail = store.auditTail(20);
  const types = tail.map((e) => e.type);
  assert.ok(types.includes('create'));
  assert.ok(types.includes('recall'));
  assert.ok(types.includes('tombstone'));
  const s = store.statsView();
  assert.equal(s.total, 0);
  assert.equal(s.tombstones, 1);
});

test('时间戳与按时间排序：新建带 createdAt，timeline / sort=time 都按录入时间', () => {
  const store = tmpStore();
  const a = store.create({ title: '早', content: 'x' });
  const b = store.create({ title: '晚', content: 'y' });
  assert.ok(a.createdAt, '新建记忆必须带 createdAt');
  assert.ok(a.updatedAt, '新建记忆必须带 updatedAt');
  // 同毫秒会撞车，这里显式拉开时间再比排序
  a.createdAt = '2020-01-01T00:00:00.000Z';
  b.createdAt = '2021-01-01T00:00:00.000Z';
  const newer = store.timeline({ order: 'new' });
  assert.equal(newer.items[0].id, b.id);
  assert.equal(newer.items[1].id, a.id);
  const older = store.timeline({ order: 'old' });
  assert.equal(older.items[0].id, a.id);
  const view = store.indexView({ sort: 'time' });
  assert.equal(view.sort, 'time');
  assert.equal(view.layers.recall[0].id, b.id);
  assert.ok(view.layers.recall[0].createdAt);
});
