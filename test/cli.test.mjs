// 外挂入口验收：memory-cli context 必须"关键词命中才吐东西"，且命中时先标签后标题
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'memory-cli.mjs');

function runCli(args, dir) {
  return execFileSync(process.execPath, [CLI, ...args, '--dir', dir], { encoding: 'utf8', timeout: 20000 });
}

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-memory-cli-'));
  const store = new MemoryStore(dir).load();
  store.create({ title: '偏好：B站私信一律开新会话', content: '下次收到B站的私信后开一个新会话，不要占用使用过的会话', tags: ['B站', '偏好'] });
  store.create({ title: '设定：群管理员称呼用「你」', content: '回答时默认用第二人称「你」，不要用敬语', tags: ['QQ', '设定'] });
  store.create({ title: '机制：读正文＝一次回忆强化', content: '默认只有标题可见', tags: ['记忆系统'] });
  return dir;
}

test('没命中关键词时什么都不输出（零 token 影响）', () => {
  const dir = seed();
  const out = runCli(['context', '--domain', 'qq', '--text', '今天天气不错，帮我算个 3+5'], dir);
  assert.equal(out.trim(), '');
});

test('命中关键词时先标签后标题，并带出正文', () => {
  const dir = seed();
  const out = runCli(['context', '--domain', 'qq', '--text', '群里有人问：私聊里该怎么称呼管理员？'], dir);
  assert.ok(out.includes('记忆提示'), '要有记忆提示块');
  assert.ok(out.includes('管理员') || out.includes('称呼'), '要命中 QQ 设定类记忆');
  assert.ok(out.includes('正文来自记忆系统'), '要有来源说明');
});

test('domain 过滤：bili 域不吃 QQ 的记忆', () => {
  const dir = seed();
  const out = runCli(['context', '--domain', 'bili', '--text', '群里有人问该怎么称呼管理员'], dir);
  assert.equal(out.trim(), '', 'bili 域不该被 QQ 关键词触发');
  const out2 = runCli(['context', '--domain', 'bili', '--text', '这条 B站 视频要不要在楼中楼回'], dir);
  assert.ok(out2.includes('B站'), 'bili 域应命中 B站 记忆');
});

test('search / read / write 三个子命令可用', () => {
  const dir = seed();
  const search = runCli(['search', 'B站', '--mode', 'tag'], dir);
  assert.ok(search.includes('标签命中 1 条'), '标签检索要能命中：' + search.slice(0, 80));
  const store = new MemoryStore(dir).load();
  const id = store.memories.find((m) => m.title.includes('B站私信')).id;
  const read = runCli(['read', id, '--json'], dir);
  const parsed = JSON.parse(read);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.memory.content.includes('新会话'));
  const write = runCli(['write', '--title', '偏好：写到一半要保存', '--content', '正文内容', '--tags', '偏好'], dir);
  assert.ok(write.includes('已记住'));
  const after = new MemoryStore(dir).load();
  assert.ok(after.memories.some((m) => m.title === '偏好：写到一半要保存'));
});
