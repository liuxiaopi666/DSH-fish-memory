#!/usr/bin/env node
// 把"一次性任务"从记忆库清出去：只保留长期有用的（偏好/规则/设定/配置/结论/位置/目标）。
// 只动 origin='session' 的会话录入；种子与人工写的记忆不动。
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { defaultStoreDir } from '../lib/index.js';
import { isDurable } from '../lib/ingest.js';

const store = new MemoryStore(process.argv[2] ?? defaultStoreDir()).load();
const dropped = [];
for (const m of [...store.memories]) {
  if (m.origin !== 'session') continue;
  if (isDurable(m.content)) continue;
  dropped.push(m.title);
  store.forget(m.id, { hard: true });
}
console.log('清掉一次性任务 ' + dropped.length + ' 条，剩 ' + store.memories.length + ' 条');
for (const title of dropped.slice(0, 20)) console.log('  - ' + title);
