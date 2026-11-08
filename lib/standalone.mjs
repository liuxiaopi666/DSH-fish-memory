#!/usr/bin/env node
// 独立控制台：不装进 DSH 也能用同一个仪表盘 + 同一套 API 看真实记忆库。
//   node lib/standalone.mjs [port] [storeDir]
//   默认 http://127.0.0.1:8788/   storeDir=~/.dsh/fish-memory
import http from 'node:http';
import path from 'node:path';
import { MemoryStore } from './store.js';
import { createApi, defaultStoreDir } from './index.js';

const port = Number(process.argv[2] ?? process.env.FISH_MEMORY_PORT ?? 8788);
const storeDir = process.argv[3] ?? process.env.FISH_MEMORY_DIR ?? defaultStoreDir();

const store = new MemoryStore(storeDir).load();
const api = createApi(store, { base: '' });

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const sub = url.pathname === '/' ? '' : url.pathname;
  api.route(sub, req, res);
});

server.listen(port, '127.0.0.1', () => {
  console.log('dsh-fish-memory 控制台: http://127.0.0.1:' + port + '/');
  console.log('记忆库存放在: ' + path.resolve(storeDir));
  console.log('共 ' + store.memories.length + ' 条记忆；按 Ctrl+C 退出');
});
