#!/usr/bin/env node
// 记忆系统的外挂入口：给 B站刷站 / QQ桥接 这类外部插件用。
//
// 用法（stdout 就是可以直接塞进提示词的东西；没触发就什么都不输出，方便管道拼接）：
//   node memory-cli.mjs context --domain bili --text "<视频标题 + 你想说的点>"
//   node memory-cli.mjs search "楼中楼" --mode tag
//   node memory-cli.mjs read m_xxxx
//   node memory-cli.mjs write --title "偏好：xxx" --content "..." --tags "B站,偏好"
//   node memory-cli.mjs stats
//
// 触发规则在 ~/.dsh/fish-memory/triggers.json（首次运行会自动写一份默认的）：
//   { rules: [ { id, keywords: [...], tags: [...] } ], maxReadsPerCall, maxChars, sessionId }
// 语义：**关键词命中才搜索**；命中后先按标签检索、再看标题，命中的记忆会被"回忆"一次（strength+1）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';
import { defaultStoreDir } from '../lib/index.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flags = {};
for (let i = 1; i < argv.length; i += 1) {
  const token = argv[i];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    flags[key] = true;
  } else {
    flags[key] = next;
    i += 1;
  }
}

const storeDir = flags.dir ?? process.env.FISH_MEMORY_DIR ?? defaultStoreDir();
const store = new MemoryStore(storeDir).load();

const TRIGGER_FILE = path.join(storeDir, 'triggers.json');
const DEFAULT_TRIGGERS = {
  version: 1,
  maxReadsPerCall: 2,
  maxChars: 1400,
  sessionId: 'external-plugin',
  rules: [
    {
      id: 'bili',
      label: 'B站刷站/私信/评论',
      keywords: ['B站', 'bilibili', '刷站', '刷B站', '私信', '评论', '楼中楼', '同类', '@我', '投币', '弹幕', '视频', '报告单', '关注'],
      tags: ['B站', '偏好'],
    },
    {
      id: 'qq',
      label: 'QQ桥接/群聊/人设',
      keywords: ['QQ', '群聊', '群里', '私聊', '人设', '称呼', '爹地', '爸爸', '管理员', '回复格式', '表情包', '权限', '唤醒', '拍一拍', '斗图'],
      tags: ['QQ', '设定', '偏好', '表情包'],
    },
    {
      id: 'fish',
      label: '记忆系统本身',
      keywords: ['记忆', 'memory', '标签', '检索', '收录'],
      tags: ['记忆系统'],
    },
  ],
};

function loadTriggers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TRIGGER_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.rules)) return { ...DEFAULT_TRIGGERS, ...parsed };
  } catch {}
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(TRIGGER_FILE, JSON.stringify(DEFAULT_TRIGGERS, null, 1), 'utf8');
  } catch {}
  return DEFAULT_TRIGGERS;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function matchRules(text, triggers, domain) {
  const lower = String(text ?? '').toLowerCase();
  const matched = [];
  for (const rule of triggers.rules) {
    if (domain && rule.id !== domain) continue;
    const hits = (rule.keywords ?? []).filter((keyword) => lower.includes(String(keyword).toLowerCase()));
    if (hits.length > 0) matched.push({ rule, hits });
  }
  return matched;
}

function collectHits(matched, triggers, limit) {
  const seen = new Map();
  for (const { rule, hits } of matched) {
    for (const tag of rule.tags ?? []) {
      for (const hit of store.search(tag, { mode: 'tag', limit }).tagHits) {
        if (!seen.has(hit.id)) seen.set(hit.id, { ...hit, via: 'tag#' + tag });
      }
    }
    for (const keyword of hits) {
      for (const hit of store.search(keyword, { limit }).titleHits) {
        if (!seen.has(hit.id)) seen.set(hit.id, { ...hit, via: '标题' });
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || b.strength - a.strength).slice(0, limit);
}

function cmdContext() {
  const triggers = loadTriggers();
  const text = String(flags.text ?? '') || readStdin();
  const matched = matchRules(text, triggers, flags.domain);
  if (matched.length === 0) return; // 没触发：什么都不输出（调用方直接拼空串即可）
  const limit = Number(flags.limit) > 0 ? Number(flags.limit) : Number(triggers.maxReadsPerCall) || 2;
  const hits = collectHits(matched, triggers, limit);
  if (hits.length === 0) return;
  const lines = [];
  lines.push('## 记忆提示（关键词触发：' + matched.map((m) => (m.rule.label ?? m.rule.id) + '(' + m.hits.join('/') + ')').join('、') + '）');
  lines.push('以下是使用者定过的长期约定，回复/评论前先照着来（正文来自记忆系统，读一次即强化一次）：');
  let budget = Number(triggers.maxChars) || 1400;
  for (const hit of hits) {
    let content = '';
    try {
      content = store.read(hit.id, { sessionId: String(triggers.sessionId ?? 'external-plugin') }).memory.content;
    } catch {
      continue;
    }
    const block = '- [' + hit.layer + '] ' + hit.title + '（' + hit.via + '）\n  ' + String(content).replace(/\n+/g, ' ').trim();
    if (block.length > budget) {
      lines.push(block.slice(0, Math.max(0, budget)) + '…');
      break;
    }
    lines.push(block);
    budget -= block.length;
    if (budget <= 0) break;
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function cmdSearch() {
  const query = String(flags.query ?? argv[1] ?? '');
  const result = store.search(query, { mode: flags.mode, layer: flags.layer, limit: flags.limit });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 1) + '\n');
    return;
  }
  process.stdout.write('标签命中 ' + result.tagHits.length + ' 条，标题命中 ' + result.titleHits.length + ' 条\n');
  for (const hit of result.tagHits) process.stdout.write('  [标签:' + hit.match + '] ' + hit.id + '  ' + hit.title + '  (#' + hit.tag + ')\n');
  for (const hit of result.titleHits) process.stdout.write('  [标题:' + hit.match + '] ' + hit.id + '  ' + hit.title + '\n');
  if (result.allTags.length > 0) process.stdout.write('  相关标签: ' + result.allTags.map((t) => '#' + t.tag + '(' + t.count + ')').join(' ') + '\n');
}

function cmdRead() {
  const id = String(flags.id ?? argv[1] ?? '');
  const r = store.read(id, { sessionId: String(flags.session ?? 'external-plugin') });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, memory: r.memory, counted: r.counted }, null, 1) + '\n');
    return;
  }
  process.stdout.write('# ' + r.memory.title + '  [' + r.memory.id + ' · ' + r.memory.layer + ' · 分 ' + r.memory.strength + ']\n' + r.memory.content + '\n');
}

function cmdWrite() {
  const title = String(flags.title ?? '');
  const content = String(flags.content ?? '');
  const tags = String(flags.tags ?? '').split(/[,\s]+/).filter(Boolean);
  const memory = store.create({ title, content, tags, origin: 'manual' });
  process.stdout.write('已记住: ' + memory.title + ' (' + memory.id + ')\n');
}

function cmdStats() {
  const stats = store.statsView();
  process.stdout.write(JSON.stringify({ ok: true, stats, tags: store.listTags().slice(0, 20) }, null, 1) + '\n');
}

switch (cmd) {
  case 'context':
    cmdContext();
    break;
  case 'search':
    cmdSearch();
    break;
  case 'read':
    cmdRead();
    break;
  case 'write':
    cmdWrite();
    break;
  case 'stats':
    cmdStats();
    break;
  default:
    process.stdout.write('用法: memory-cli.mjs <context|search|read|write|stats> [--text ...] [--domain bili|qq] [--id ...] [--title ...] [--content ...] [--tags a,b] [--json]\n');
}
