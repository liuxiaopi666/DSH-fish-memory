import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLiveEvent, readEvents, readLiveBlock, syncBiliMemory, liveFilePath } from '../lib/live.js';
import { MemoryStore } from '../lib/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fish-live-'));

test('append + read 时间窗与条数上限', () => {
  const dir = tmp();
  const file = path.join(dir, 'live.jsonl');
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  appendLiveEvent(file, { at: old, src: 'qq', text: '两天前的事' });
  for (let i = 0; i < 5; i += 1) appendLiveEvent(file, { src: 'bili', text: '第 ' + i + ' 条' });
  const recent = readEvents(file, { hours: 12, max: 3 });
  assert.equal(recent.length, 3);
  assert.equal(recent[0].text, '第 4 条');
  assert.ok(recent.every((e) => e.src === 'bili'));
  assert.equal(readEvents(file, { hours: 72, max: 10 }).length, 6);
});

test('text 截断到 200 且压空白', () => {
  const dir = tmp();
  const file = path.join(dir, 'live.jsonl');
  const ev = appendLiveEvent(file, { src: 'qq', text: 'a'.repeat(500) + '\n\n第二行' });
  assert.equal(ev.text.length, 200);
  assert.ok(!ev.text.includes('\n'));
});

test('readLiveBlock 有字数上限，空流返回空串', () => {
  const dir = tmp();
  const file = path.join(dir, 'live.jsonl');
  assert.equal(readLiveBlock(file, {}), '');
  for (let i = 0; i < 10; i += 1) appendLiveEvent(file, { src: 'qq', who: '爹地', text: '很长的内容'.repeat(8) + i });
  const block = readLiveBlock(file, { maxChars: 300 });
  assert.ok(block.startsWith('【跨端最近'));
  const body = block.split('\n').slice(1).join('\n');
  assert.ok(body.length <= 300, 'body=' + body.length);
});

test('坏行不影响解析', () => {
  const dir = tmp();
  const file = path.join(dir, 'live.jsonl');
  appendLiveEvent(file, { src: 'qq', text: '好行' });
  fs.appendFileSync(file, '这不是 JSON\n', 'utf8');
  appendLiveEvent(file, { src: 'bili', text: '又一条好行' });
  const events = readEvents(file, { hours: 12, max: 10 });
  assert.equal(events.length, 2);
});

test('syncBiliMemory：建记忆、去重、按偏移续读', () => {
  const dir = tmp();
  const memoryFile = path.join(dir, 'memory.jsonl');
  const stateFile = path.join(dir, 'tail.json');
  const store = new MemoryStore(path.join(dir, 'store')).load();
  fs.writeFileSync(memoryFile, JSON.stringify({ t: 'B站第一条', why: '因为值得', bv: 'BV1xx' }) + '\n', 'utf8');
  const first = syncBiliMemory(store, { memoryFile, stateFile });
  assert.equal(first.created, 1);
  const second = syncBiliMemory(store, { memoryFile, stateFile });
  assert.equal(second.created, 0, '同一行不该重复建');
  fs.appendFileSync(memoryFile, JSON.stringify({ t: 'B站第二条', why: '又来一条' }) + '\n', 'utf8');
  const third = syncBiliMemory(store, { memoryFile, stateFile });
  assert.equal(third.created, 1);
  const reloaded = new MemoryStore(path.join(dir, 'store')).load();
  assert.equal(reloaded.memories.length, 2);
  assert.ok(reloaded.memories.every((m) => m.tags.includes('跨端')));
});

test('liveFilePath 拼在 storeDir 下', () => {
  assert.equal(liveFilePath('C:/x/y'), path.join('C:/x/y', 'live.jsonl'));
});
