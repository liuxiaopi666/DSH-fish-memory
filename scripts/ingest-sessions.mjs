#!/usr/bin/env node
// 把历史会话录进记忆库（可重复执行，按内容哈希去重）。
//   node scripts/ingest-sessions.mjs [--dry] [--days N] [--max N] [storeDir]
import { MemoryStore } from '../lib/store.js';
import { defaultStoreDir } from '../lib/index.js';
import { ingestSessions } from '../lib/ingest.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const storeDir = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--'))) ?? defaultStoreDir();

const store = new MemoryStore(storeDir).load();
const before = store.memories.length;
const result = ingestSessions(store, {
  dryRun,
  rebuild: args.includes('--rebuild'),
  sinceDays: Number(value('--days') ?? 0),
  maxSessions: Number(value('--max') ?? 0),
});

console.log('会话日志根目录: ' + result.sessionsRoot);
console.log((dryRun ? '（dry-run，不落盘）' : '') + '扫描会话 ' + result.scanned + ' 个，候选记忆 ' + result.planned + ' 条，新增 ' + (dryRun ? 0 : result.createdCount) + ' 条');
console.log('跳过：已录过 ' + result.skipped.alreadyIngested + ' · 没有真人发言 ' + result.skipped.noTurns + ' · 子代理会话 ' + (result.skipped.subagentSessions ?? 0) + ' · 内容重复 ' + result.skipped.duplicate + ' · 读不了 ' + result.skipped.unreadable + (result.skipped.rebuilt ? ' · 重建前清除 ' + result.skipped.rebuilt : ''));
for (const m of result.created.slice(0, 12)) console.log('  + [' + m.layer + '] ' + m.title + '  (' + m.tokens + ' tokens)');
if (result.created.length > 12) console.log('  … 其余 ' + (result.created.length - 12) + ' 条见控制台 / memory_index');
console.log('记忆总数：' + before + ' → ' + store.memories.length);
