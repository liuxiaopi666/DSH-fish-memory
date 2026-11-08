// dsh-fish-memory · DSH 宿主插件
//
// 三件事：
//   1. 记忆工具（memory_index / read / write ...）：标题先行、正文按需，一次 read 就是一次点击强化；
//   2. 可视化控制台（/fish-memory）：同一套 HTTP API 供仪表盘调节；
//   3. 周期衰减 + hot 层标题注入系统提示（hot 层默认可见 = 方案里的"第 1 层"）。
//
// 面板与工具共用同一个 MemoryStore 实例，磁盘是唯一真相（store.json / audit.jsonl / tombstones.json）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore, LAYERS, SORT_MODES, estimateTokens, memoryCreatedAt, sortMemories } from './store.js';
import { ingestSessions, defaultSessionsRoot } from './ingest.js';
import { appendLiveEvent, readEvents, readLiveBlock, liveFilePath, syncBiliMemory } from './live.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const name = 'fish-memory';
// systemPrompt 必须在 inject 里，否则 cordis 拒绝读 ctx.systemPrompt（日志会报
// "cannot get property \"systemPrompt\" without inject"），hot 层标题就注入不了。
export const inject = ['tools', 'webServer', 'systemPrompt'];

export function defaultStoreDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'fish-memory');
}

function diag(message) {
  try {
    const file = process.env.FISH_MEMORY_DIAG || path.join(defaultStoreDir(), 'plugin.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, '[' + new Date().toISOString() + '] ' + message + '\n', 'utf8');
  } catch {}
}

// ---------------------------------------------------------------- HTTP 层

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 仪表盘公共 API：宿主路由与 standalone 服务器共用同一份实现。 */
export function createApi(store, options = {}) {
  const base = options.base ?? '';
  const dashboardFile = options.dashboardFile ?? path.join(HERE, 'dashboard.html');

  function dashboardHtml() {
    let html = fs.readFileSync(dashboardFile, 'utf8');
    // 契约：HTML 里出现字面量 __BASE__，服务器替换成实际前缀
    html = html.split('__BASE__').join(base);
    return html;
  }

  function state() {
    return {
      ok: true,
      config: store.config,
      stats: store.statsView(),
      lastDecayAt: store.lastDecayAt,
      layers: LAYERS,
      memories: store.memories.map((m) => ({
        ...m,
        contentTokens: estimateTokens(m.content),
        // 按当前分数与自己的锚点外推：这条预计什么时候掉到下一层
        dropAt: store.projectedDecay(m.id),
      })),
      tombstones: store.tombstones,
    };
  }

  function index(body = {}) {
    const view = store.indexView({ sort: body.sort });
    return { ok: true, sort: view.sort, layers: view.layers, tokens: view.tokens, note: view.note };
  }

  function handle(method, action, body) {
    if (action === '' || action === 'index.html') return { html: dashboardHtml() };
    if (method === 'GET' && action === 'api/state') return state();
    if (method === 'GET' && action === 'api/index') return index(body);
    if (action === 'api/timeline') {
      return {
        ok: true,
        ...store.timeline({
          order: body.order,
          layer: body.layer,
          limit: Number(body.limit) > 0 ? Number(body.limit) : undefined,
          includeDeleted: body.includeDeleted === true || body.includeDeleted === 'true',
        }),
      };
    }
    if (method === 'GET' && action === 'api/tags') return { ok: true, tags: store.listTags() };
    if (method === 'POST' && action === 'api/search') {
      return { ok: true, ...store.search(body.query ?? '', { mode: body.mode, layer: body.layer, limit: body.limit }) };
    }
    if (method === 'GET' && action === 'api/audit') return { ok: true, events: store.auditTail(Number(body.limit) || 80) };
    if (method === 'GET' && action === 'api/tombstones') return { ok: true, tombstones: store.tombstones };
    if (action === 'api/live') {
      const file = liveFilePath(store.dir);
      if (method === 'GET') return { ok: true, events: readEvents(file, { hours: body.hours, max: body.limit, src: body.src }) };
      return { ok: true, event: appendLiveEvent(file, body) };
    }
    if (method === 'GET' && action === 'api/ping') {
      // 浏览器半的装载探针：客户端是否被装载、插槽服务有没有拿到、注册有没有抛
      diag('client ping: ' + JSON.stringify(body));
      return { ok: true, at: new Date().toISOString() };
    }
    if (method === 'POST' && action === 'api/read') {
      const r = store.read(String(body.id ?? ''), { sessionId: body.sessionId ?? 'dashboard' });
      return { ok: true, memory: r.memory, counted: r.counted };
    }
    if (method === 'POST' && action === 'api/create') {
      return { ok: true, memory: store.create({ title: body.title, content: body.content, tags: body.tags, layer: body.layer }) };
    }
    if (method === 'POST' && action === 'api/update') {
      return { ok: true, memory: store.update({ id: body.id, title: body.title, content: body.content, tags: body.tags }) };
    }
    if (method === 'POST' && action === 'api/move') return { ok: true, memory: store.move(String(body.id ?? ''), String(body.layer ?? '')) };
    if (method === 'POST' && action === 'api/forget') return { ok: true, ...store.forget(String(body.id ?? ''), { hard: body.hard === true }) };
    if (method === 'POST' && action === 'api/revive') return { ok: true, memory: store.revive(String(body.id ?? '')) };
    if (method === 'POST' && action === 'api/config') return { ok: true, ...store.setConfig(body.patch ?? {}) };
    if (method === 'POST' && action === 'api/decay') return { ok: true, ...store.decayRound() };
    if (method === 'POST' && action === 'api/retitle') {
      const items = Array.isArray(body.items) ? body.items : [];
      const failed = [];
      let changed = 0;
      for (const item of items) {
        try {
          store.update({ id: String(item.id ?? ''), title: String(item.title ?? '') });
          changed += 1;
        } catch (error) {
          failed.push(String(item && item.id) + ': ' + error.message);
        }
      }
      return { ok: true, changed, failed };
    }
    if (method === 'POST' && action === 'api/ingest') {
      const result = ingestSessions(store, { rebuild: body.rebuild === true, sinceDays: Number(body.days) > 0 ? Number(body.days) : 0 });
      return { ok: true, scanned: result.scanned, createdCount: result.createdCount, skipped: result.skipped, sessionsRoot: result.sessionsRoot };
    }
    if (method === 'POST' && action === 'api/reset') {
      if (body.confirm !== 'RESET') throw new Error('reset 需要 confirm:"RESET"');
      store.reset();
      return { ok: true };
    }
    const error = new Error('未知接口: ' + method + ' ' + action);
    error.status = 404;
    throw error;
  }

  /** node:http 风格的处理器；subPath 是 base 之后剩下的部分。 */
  function route(subPath, req, res) {
    const method = req.method === 'GET' || req.method === 'HEAD' ? 'GET' : 'POST';
    const url = new URL(req.url ?? '/', 'http://x');
    const raw = subPath ?? url.pathname;
    const sub = raw.replace(/^\/+/, '');
    const done = (value) => {
      if (value && typeof value.html === 'string') sendHtml(res, 200, value.html);
      else sendJson(res, 200, value);
    };
    if (method === 'GET') {
      try {
        done(handle('GET', sub, Object.fromEntries(url.searchParams)));
      } catch (error) {
        sendJson(res, error.status ?? 500, { ok: false, error: error.message });
      }
      return;
    }
    readBody(req)
      .then((body) => done(handle('POST', sub, body)))
      .catch((error) => sendJson(res, 400, { ok: false, error: error.message }));
  }

  return { route, handle, dashboardHtml, state, index };
}

// ---------------------------------------------------------------- 工具层

const NOTE = '分层记忆系统（hot > recall > archive > cold）：默认只有标题可见，读正文才计一次回忆强化。';

function fmtDate(value, withTime = false) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '时间未知';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const base = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  return withTime ? base + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : base;
}

function shortDate(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function titleLine(m) {
  return '[' + m.layer + '] ' + m.id + ' · ' + m.title + '（分 ' + m.strength + '，读 ' + (m.clicks ?? 0) + ' 次，录入 ' + fmtDate(memoryCreatedAt(m)) + '）';
}

function plainOutput(toText) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: toText(value) }],
  };
}

// 把 DSH 插件 DSL（{ 属性名: { type, required, description } }）转成标准 JSON Schema。
// 上游 OpenAI 兼容端点要求 tools[].function.parameters 必须是 { type:"object", properties:{...}, required:[...] }，
// 直接透传 DSL 会被拒绝（codearts 报 "Invalid Argument"，fluxgate 报 502 upstream_error）。
export function toJsonSchemaParameters(parameters) {
  const props = parameters && typeof parameters === 'object' ? parameters : {};
  if (props.type === 'object') return props;
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(props)) {
    if (!value || typeof value !== 'object') continue;
    const { required: isRequired, ...rest } = value;
    const prop = { ...rest };
    if (prop.items && typeof prop.items === 'object') {
      const { required: _unusedItemsRequired, ...itemRest } = prop.items;
      prop.items = itemRest;
    }
    properties[key] = prop;
    if (isRequired) required.push(key);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

export function toolDefinitions(store) {
  return [
    {
      name: 'memory_index',
      description: NOTE + ' 记忆索引：一眼预览整个记忆系统里每条记忆的层级、标题、分数与录入日期，不必逐层翻找。只返回标题，不返回正文。',
      parameters: {
        sort: { type: 'string', required: false, description: 'strength（默认，按分数）| time（新→旧）| old（旧→新）| updated（最近改动）| clicks | title' },
      },
      output: plainOutput((v) => {
        const lines = [];
        for (const layer of LAYERS) {
          const rows = v.layers[layer] ?? [];
          lines.push('## ' + layer + ' (' + rows.length + ')');
          if (rows.length === 0) lines.push('  (空)');
          for (const r of rows) {
            const tags = r.tags && r.tags.length > 0 ? '  #' + r.tags.join(' #') : '';
            lines.push('  ' + r.id + ' · ' + r.title + tags + ' · 分 ' + r.strength + ' · 读 ' + r.clicks + ' 次 · 录入 ' + fmtDate(r.createdAt));
          }
        }
        lines.push('');
        lines.push('排序：' + (v.sort ?? 'strength') + '（想看最近记了什么就用 sort=time，或直接 memory_timeline）。');
        lines.push('标题共约 ' + v.tokens.titleTokens + ' tokens；若全文全量注入需约 ' + v.tokens.fullTokens + ' tokens（当前省 ' + v.tokens.savedTokens + '）。');
        lines.push(v.note);
        return lines.join('\n');
      }),
      execute: (args) => Promise.resolve(store.indexView({ sort: args.sort })),
      presentCall: () => ({ card: 'generic', title: '记忆索引', kind: 'other' }),
    },
    {
      name: 'memory_list',
      description: NOTE + ' 列出某一层（hot / recall / archive / cold，默认 hot）的记忆标题，用于快速浏览，不含正文。',
      parameters: {
        layer: { type: 'string', required: false, description: 'hot | recall | archive | cold，默认 hot' },
        limit: { type: 'integer', required: false, description: '最多返回几条，默认 40' },
        sort: { type: 'string', required: false, description: 'strength（默认，按分数）| time（新→旧）| old（旧→新）| updated（最近改动）| clicks | title' },
      },
      output: plainOutput((v) => (v.items.length === 0 ? '（' + v.layer + ' 层是空的）' : '排序：' + v.sort + '\n' + v.items.map(titleLine).join('\n'))),
      execute: (args) => {
        const layer = LAYERS.includes(args.layer) ? args.layer : 'hot';
        const limit = Number(args.limit) > 0 ? Number(args.limit) : 40;
        const sort = SORT_MODES.includes(args.sort) ? args.sort : 'strength';
        const items = sortMemories(store.memories.filter((m) => m.layer === layer), sort).slice(0, limit);
        return Promise.resolve({ layer, sort, items });
      },
      presentCall: (args) => ({ card: 'generic', title: '浏览记忆 ' + (args.layer ?? 'hot'), kind: 'other' }),
    },
    {
      name: 'memory_timeline',
      description: '按录入时间看记忆（跨全四层）：默认新 → 旧，每条带时间戳。想知道"最近记了什么/新的是哪条"就用它；order=old 反着看。',
      parameters: {
        order: { type: 'string', required: false, description: 'new（默认，新的在前）| old（旧的在前）' },
        layer: { type: 'string', required: false, description: '限定层级，可选' },
        limit: { type: 'integer', required: false, description: '最多几条，默认 50' },
        includeDeleted: { type: 'boolean', required: false, description: '是否把墓碑也按删除时间并进来' },
      },
      output: plainOutput((v) => {
        if (v.items.length === 0) return '（没有记忆可按时间排）';
        const lines = v.items.map((r, i) => (i + 1) + '. ' + fmtDate(r.createdAt, true) + '  [' + r.layer + '] ' + r.id + ' · ' + r.title + (r.deleted ? '（已删除）' : ''));
        lines.push('');
        lines.push('共 ' + v.total + ' 条，按录入时间' + (v.order === 'old' ? '旧→新' : '新→旧') + '排。取正文用 memory_read(id)。');
        return lines.join('\n');
      }),
      execute: (args) => Promise.resolve(store.timeline({ order: args.order, layer: args.layer, limit: args.limit, includeDeleted: args.includeDeleted === true })),
      presentCall: () => ({ card: 'generic', title: '按时间看记忆', kind: 'other' }),
    },
    {
      name: 'memory_read',
      description: NOTE + ' 读取记忆正文（一次调用 = 一次回忆：点击次数 +1，并把该记忆刷新回 hot 层）。可一次读多条。',
      parameters: {
        id: { type: 'string', required: false, description: '记忆 id（单条）' },
        ids: { type: 'array', required: false, description: '记忆 id 列表（多条）', items: { type: 'string', required: true } },
      },
      output: plainOutput((v) => v.items.map((it) => '### ' + it.title + '  [' + it.id + ' · ' + it.layer + ' · 分 ' + it.strength + ']\n' + it.content).join('\n\n')),
      execute: (args, exec) => {
        const ids = Array.isArray(args.ids) && args.ids.length > 0 ? args.ids.map(String) : [String(args.id ?? '')].filter(Boolean);
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? 'agent';
        const items = ids.map((id) => {
          const r = store.read(id, { sessionId });
          return {
            id: r.memory.id,
            title: r.memory.title,
            content: r.memory.content,
            layer: r.memory.layer,
            strength: r.memory.strength,
            counted: r.counted,
          };
        });
        return Promise.resolve({ items, counted: items.filter((i) => i.counted).length });
      },
      presentCall: (args) => ({ card: 'generic', title: '回忆记忆', kind: 'other', rawInput: args.id ?? args.ids }),
    },
    {
      name: 'memory_search',
      description: NOTE + ' 检索记忆：**先匹配标签、再匹配标题**（标签是稀疏索引，意图更准、成本更低），不读正文、不计分；拿到 id 再用 memory_read 取全文。mode=tag/title 可只看其中一类。',
      parameters: {
        query: { type: 'string', required: true, description: '关键词' },
        mode: { type: 'string', required: false, description: 'auto（默认，标签优先）| tag | title' },
        layer: { type: 'string', required: false, description: '限定层级，可选' },
        limit: { type: 'integer', required: false, description: '每类最多几条，默认 20' },
      },
      output: plainOutput((v) => {
        const lines = [];
        lines.push('## 标签命中 (' + v.tagHits.length + ') —— 先看这里');
        if (v.tagHits.length === 0) lines.push('  (无)');
        for (const h of v.tagHits) lines.push('  ' + h.id + ' · #' + h.tag + ' [' + h.match + '] · ' + h.title + ' · 分 ' + h.strength + ' · 录入 ' + fmtDate(h.createdAt));
        lines.push('## 标题命中 (' + v.titleHits.length + ')');
        if (v.titleHits.length === 0) lines.push('  (无)');
        for (const h of v.titleHits) lines.push('  ' + h.id + ' · ' + h.title + ' [' + h.match + '] · 分 ' + h.strength + ' · 录入 ' + fmtDate(h.createdAt));
        if (v.allTags && v.allTags.length > 0) lines.push('相关标签（换个词再搜）：' + v.allTags.map((t) => '#' + t.tag + '(' + t.count + ')').join(' '));
        lines.push('取正文用 memory_read(id)，那次调用同时算一次回忆强化。');
        return lines.join('\n');
      }),
      execute: (args) => Promise.resolve(store.search(args.query ?? '', { mode: args.mode, layer: args.layer, limit: args.limit })),
      presentCall: (args) => ({ card: 'generic', title: '检索记忆「' + (args.query ?? '') + '」', kind: 'other' }),
    },
    {
      name: 'memory_tags',
      description: '记忆系统的标签词表：每个标签有多少条、分布在哪些层。检索前先看它，比逐个翻标题便宜得多。',
      parameters: { limit: { type: 'integer', required: false, description: '最多几个标签，默认 60' } },
      output: plainOutput((v) => (v.tags.length === 0 ? '标签表是空的（还没有记忆带标签）。' : v.tags.map((t) => '#' + t.tag + ' ×' + t.count + '  [hot ' + t.byLayer.hot + ' / recall ' + t.byLayer.recall + ' / archive ' + t.byLayer.archive + ' / cold ' + t.byLayer.cold + ']').join('\n'))),
      execute: (args) => {
        const limit = Number(args.limit) > 0 ? Number(args.limit) : 60;
        return Promise.resolve({ tags: store.listTags().slice(0, limit) });
      },
      presentCall: () => ({ card: 'generic', title: '记忆标签词表', kind: 'other' }),
    },
    {
      name: 'memory_ingest',
      description: '把 DSH 的历史会话（~/.dsh/sessions 里的 session.v4.jsonl.zstd）录进记忆库：每个会话取第一条真正的用户发言（+ 明显不同的最后一条），按内容哈希去重，重复执行不会重复录。只读会话、不写会话。',
      parameters: {
        days: { type: 'integer', required: false, description: '只看最近 N 天的会话，默认 0=全部' },
        dryRun: { type: 'boolean', required: false, description: 'true=只统计不落盘' },
      },
      output: plainOutput((v) => '扫描会话 ' + v.scanned + ' 个，候选 ' + v.planned + ' 条，' + (v.dryRun ? '（dry-run）' : '新增 ' + v.createdCount + ' 条') + '；跳过：已录过 ' + v.skipped.alreadyIngested + ' / 没有真人发言 ' + v.skipped.noTurns + ' / 子代理会话 ' + (v.skipped.subagentSessions ?? 0) + ' / 重复 ' + v.skipped.duplicate),
      execute: (args) => {
        const result = ingestSessions(store, {
          dryRun: args.dryRun === true,
          sinceDays: Number(args.days) > 0 ? Number(args.days) : 0,
        });
        return Promise.resolve(result);
      },
      presentCall: () => ({ card: 'generic', title: '录入历史会话记忆', kind: 'other' }),
    },
    {
      name: 'memory_write',
      description: NOTE + ' 新建一条记忆。标题要短（标题会进入默认可见的索引），正文写全。默认落在 recall 层，被读到才升到 hot。',
      parameters: {
        title: { type: 'string', required: true, description: '短标题（默认可见的那一行）' },
        content: { type: 'string', required: true, description: '正文全文' },
        tags: { type: 'array', required: false, description: '标签', items: { type: 'string', required: true } },
        layer: { type: 'string', required: false, description: '指定初始层，可选' },
      },
      output: plainOutput((v) => '已记住：' + v.memory.title + '（id ' + v.memory.id + '，层 ' + v.memory.layer + '，录入 ' + fmtDate(v.memory.createdAt, true) + '）'),
      execute: (args) => Promise.resolve({ memory: store.create({ title: args.title, content: args.content, tags: args.tags, layer: args.layer }) }),
      presentCall: (args) => ({ card: 'generic', title: '记住：' + (args.title ?? ''), kind: 'other' }),
    },
    {
      name: 'memory_update',
      description: NOTE + ' 改写一条已有记忆的标题 / 正文 / 标签（不影响分数与点击次数）。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id' },
        title: { type: 'string', required: false, description: '新标题' },
        content: { type: 'string', required: false, description: '新正文' },
        tags: { type: 'array', required: false, description: '新标签', items: { type: 'string', required: true } },
      },
      output: plainOutput((v) => '已更新：' + v.memory.title + '（' + v.memory.id + '）'),
      execute: (args) => Promise.resolve({ memory: store.update({ id: args.id, title: args.title, content: args.content, tags: args.tags }) }),
      presentCall: () => ({ card: 'generic', title: '更新记忆', kind: 'other' }),
    },
    {
      name: 'memory_move',
      description: NOTE + ' 人工把一条记忆放到指定层（纠正自动分层用）。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id' },
        layer: { type: 'string', required: true, description: 'hot | recall | archive | cold' },
      },
      output: plainOutput((v) => '已移到 ' + v.memory.layer + '：' + v.memory.title),
      execute: (args) => Promise.resolve({ memory: store.move(String(args.id ?? ''), String(args.layer ?? '')) }),
      presentCall: () => ({ card: 'generic', title: '调整记忆层级', kind: 'other' }),
    },
    {
      name: 'memory_retitle',
      description: '批量改标题（只改标题，不动正文/分数/点击）：标题要短、一眼能看出这条记忆是干什么的，格式建议「类别：核心」如「偏好：回复只用中文」「需求：磁力下载程序」「问题：B站私信唤醒不生效」。',
      parameters: {
        items: {
          type: 'array',
          required: true,
          description: '要改的标题列表',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '记忆 id' },
              title: { type: 'string', description: '新标题（建议 <= 26 字）' },
            },
          },
        },
      },
      output: plainOutput((v) => '改了 ' + v.changed + ' 条标题' + (v.failed.length > 0 ? '，失败 ' + v.failed.length + ' 条：' + v.failed.join(' / ') : '')),
      execute: (args) => {
        const items = Array.isArray(args.items) ? args.items : [];
        const failed = [];
        let changed = 0;
        for (const item of items) {
          try {
            store.update({ id: String(item.id ?? ''), title: String(item.title ?? '') });
            changed += 1;
          } catch (error) {
            failed.push((item && item.id) + ': ' + error.message);
          }
        }
        return Promise.resolve({ changed, failed });
      },
      presentCall: () => ({ card: 'generic', title: '批量修改记忆标题', kind: 'other' }),
    },
    {
      name: 'memory_forget',
      description: NOTE + ' 让一条记忆下沉一层（hard=false，默认，永不销毁）或进墓碑（hard=true，内容仍保留、可 memory_revive 复活）。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id' },
        hard: { type: 'boolean', required: false, description: 'true = 进墓碑（仍可复活）' },
      },
      output: plainOutput((v) => (v.tombstone ? '已进墓碑（可复活）：' + v.tombstone.title : '已下沉：' + v.memory.title + ' 到 ' + v.memory.layer)),
      execute: (args) => Promise.resolve(store.forget(String(args.id ?? ''), { hard: args.hard === true })),
      presentCall: () => ({ card: 'generic', title: '遗忘记忆', kind: 'other' }),
    },
    {
      name: 'memory_revive',
      description: NOTE + ' 把深层或墓碑里的记忆拉回 hot 层并加分（回忆可逆转遗忘）。',
      parameters: { id: { type: 'string', required: true, description: '记忆 id 或墓碑 id' } },
      output: plainOutput((v) => '已复活到 hot：' + v.memory.title + '（分 ' + v.memory.strength + '）'),
      execute: (args) => Promise.resolve({ memory: store.revive(String(args.id ?? '')) }),
      presentCall: () => ({ card: 'generic', title: '复活记忆', kind: 'other' }),
    },
    {
      name: 'memory_stats',
      description: '记忆系统状态：各层数量、总点击、平均分数、上次/下次衰减时间、标题先行省下的 token。',
      parameters: {},
      output: plainOutput((v) => {
        const s = v.stats;
        return [
          '共 ' + s.total + ' 条：hot ' + s.byLayer.hot + ' / recall ' + s.byLayer.recall + ' / archive ' + s.byLayer.archive + ' / cold ' + s.byLayer.cold,
          '总点击 ' + s.totalClicks + '，平均分 ' + s.avgStrength + '，墓碑 ' + s.tombstones + ' 条',
          '上次衰减 ' + (s.lastDecayAt ?? '还没跑过') + '，下次 ' + (s.nextDecayAt ?? '-'),
          '标题 ' + s.tokens.titleTokens + ' tokens vs 全文 ' + s.tokens.fullTokens + ' tokens，省下 ' + Math.round(s.tokens.savedPct * 100) + '%',
          '参数 decayFactor=' + v.config.decayFactor + '，间隔 ' + v.config.decayIntervalHours + 'h，hot 预算 ' + v.config.hotBudgetTokens + ' tokens',
        ].join('\n');
      }),
      execute: () => Promise.resolve({ stats: store.statsView(), config: store.config }),
      presentCall: () => ({ card: 'generic', title: '记忆系统状态', kind: 'other' }),
    },
    {
      name: 'memory_decay',
      description: '立刻跑一轮衰减（分数乘以 decayFactor 并按阈值重排层级），返回层级变化。平时由插件定时自动跑，这个工具用于演示或对齐。',
      parameters: {},
      output: plainOutput((v) => (v.transitions.length === 0 ? '跑完一轮衰减：没有记忆跨层。' : '跑完一轮衰减：\n' + v.transitions.map((t) => t.title + ' ' + t.from + ' 到 ' + t.to + ' (' + t.reason + ')').join('\n'))),
      execute: () => Promise.resolve(store.decayRound()),
      presentCall: () => ({ card: 'generic', title: '跑一轮记忆衰减', kind: 'other' }),
    },
    {
      name: 'memory_config',
      description: '查看或调整记忆系统参数（不带 patch 只读）：decayFactor / decayIntervalHours / thresholds.hot,recall,archive / hotBudgetTokens / dedupeWindowMinutes / recallBoost / createStrength / reviveStrength / autoDecay。',
      parameters: { patch: { type: 'object', required: false, description: '要改的字段，例如 {"decayFactor":0.97}' } },
      output: plainOutput((v) => '当前参数：' + JSON.stringify(v.config)),
      execute: (args) => {
        const patch = args.patch && typeof args.patch === 'object' ? args.patch : null;
        if (patch) store.setConfig(patch);
        return Promise.resolve({ config: store.config, stats: store.statsView() });
      },
      presentCall: () => ({ card: 'generic', title: '记忆系统参数', kind: 'other' }),
    },
    {
      name: 'memory_live_append',
      description: '往跨端事件流写一条「刚发生的事」，QQ / B站 / 网页三个场合共用同一份流；别的场合下一轮就能看到。只写摘要（不超过 200 字），不要贴全文或隐私。',
      parameters: {
        src: { type: 'string', required: true, description: '来源：qq | bili | web' },
        text: { type: 'string', required: true, description: '一句话摘要' },
        who: { type: 'string', required: false, description: '谁说的/谁做的，如 爹地 / 本鱼 / 群里的人' },
        kind: { type: 'string', required: false, description: 'msg（对话）| round（值班轮）| note（备注），默认 msg' },
        ref: { type: 'string', required: false, description: '可选引用（BV号 / 会话键 / 消息 id）' },
      },
      output: plainOutput((v) => '已写入跨端事件流：' + v.event.at + ' · ' + v.event.src + ' · ' + v.event.text),
      execute: (args) => Promise.resolve({ event: appendLiveEvent(liveFilePath(store.dir), args) }),
      presentCall: () => ({ card: 'generic', title: '写跨端事件', kind: 'other' }),
    },
    {
      name: 'memory_live_read',
      description: '读跨端事件流（QQ / B站 / 网页最近发生的事），默认最近 12 小时、最多 10 条。',
      parameters: {
        hours: { type: 'integer', required: false, description: '时间窗（小时），默认 12' },
        limit: { type: 'integer', required: false, description: '最多几条，默认 10' },
        src: { type: 'string', required: false, description: '只看某个来源：qq | bili | web' },
      },
      output: plainOutput((v) => (v.events.length === 0 ? '（最近没有跨端事件）' : v.events.map((e) => '- ' + e.at + ' · ' + e.src + (e.who ? '·' + e.who : '') + '：' + e.text).join('\n'))),
      execute: (args) => Promise.resolve({ events: readEvents(liveFilePath(store.dir), { hours: args.hours, max: args.limit, src: args.src }) }),
      presentCall: () => ({ card: 'generic', title: '跨端事件流', kind: 'other' }),
    },
  ];
}

// ---------------------------------------------------------------- 系统提示注入

/** hot 层标题注入 = "AI 默认能看到的第一层"。API 形状随 DSH 版本变，全部 try/catch 兜底。 */
export function injectPrompt(ctx, store) {
  // 跨端实时块：QQ / B站 / 网页共用 live.jsonl，每步现读、不做关键词门禁。
  try {
    const liveFile = liveFilePath(store.dir);
    const disposeLive = ctx.systemPrompt.context({
      name: 'fish-memory:live',
      order: 61,
      text: () => readLiveBlock(liveFile, {}),
    });
    if (typeof disposeLive === 'function' && typeof ctx.effect === 'function') ctx.effect(() => disposeLive, 'fish-memory live section');
    diag('live prompt injection ok');
  } catch (error) {
    diag('live prompt injection failed: ' + error.message);
  }
  const build = () => {
    const hot = store.memories.filter((m) => m.layer === 'hot').sort((a, b) => b.strength - a.strength);
    if (hot.length === 0) return '';
    const lines = hot.map((m) => '- ' + m.id + ' · ' + shortDate(memoryCreatedAt(m)) + ' · ' + m.title + '（分 ' + m.strength + '，读 ' + (m.clicks ?? 0) + ' 次）');
    return [
      '# 记忆系统（hot 层，默认可见）',
      '下面是当前分数最高的几点记忆，只给标题；每条第二列是录入日期（月-日）。需要正文时调用 memory_read(id)，这次调用本身会强化它；',
      '要看全四层的位置用 memory_index，要找某条用 memory_search，按时间看新记了什么用 memory_timeline。',
      lines.join('\n'),
    ].join('\n');
  };
  // 正确 API（DSH 0.2.x，见 dsh-system-prompt 的 SystemPrompt 服务）：
  //   ctx.systemPrompt.context({ name, order, text })  —— 动态上下文，text 可以是函数，每一步重新求值
  //   ctx.systemPrompt.section({ name, order, text })  —— 静态小节，注册时求值一次
  // 之前试的 sections.register / sections.add 在这个版本都不存在，所以注入一直失败。
  const attempts = [
    () => ctx.systemPrompt.context({ name: 'fish-memory:hot', order: 60, text: () => build() }),
    () => ctx.systemPrompt.section({ name: 'fish-memory:hot', order: 60, text: build() }),
    () => ctx.systemPrompt.context({ name: 'fish-memory-hot', order: 60, text: () => build() }),
  ];
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const result = attempts[i]();
      if (typeof result === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => result, 'fish-memory prompt section');
      }
      diag('prompt injection ok (attempt ' + i + ')');
      return true;
    } catch (error) {
      diag('prompt injection attempt ' + i + ' failed: ' + error.message);
    }
  }
  diag('prompt injection unavailable; hot titles remain reachable via memory_index / memory_list');
  return false;
}

// ---------------------------------------------------------------- 装配

export function apply(ctx, config = {}) {
  const storeDir = config.storeDir || defaultStoreDir();
  const store = new MemoryStore(storeDir, { logger: ctx.logger }).load();
  const base = config.basePath || '/fish-memory';
  diag('apply start: dir=' + storeDir + ' base=' + base);

  let registered = 0;
  for (const rawDef of toolDefinitions(store)) {
    // 注册前统一把参数声明提升为合法 JSON Schema，否则上游会以 400/502 拒绝整个请求
    const def = { ...rawDef, parameters: toJsonSchemaParameters(rawDef.parameters) };
    try {
      const dispose = ctx.tools.register(def);
      registered += 1;
      if (typeof ctx.effect === 'function' && typeof dispose === 'function') {
        ctx.effect(() => dispose, 'fish-memory tool ' + def.name);
      }
    } catch (error) {
      diag('tool ' + def.name + ' registration failed: ' + error.message);
    }
  }
  diag('registered tools: ' + registered);

  const api = createApi(store, { base });
  try {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const sub = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
        api.route(sub, req, res);
      },
    });
    if (typeof ctx.effect === 'function' && typeof dispose === 'function') ctx.effect(() => dispose, 'fish-memory routes');
    diag('routes registered at ' + base);
  } catch (error) {
    diag('route registration failed: ' + error.message);
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const timer = setInterval(() => {
          try {
            if (!store.config.autoDecay) return;
            // 每条记忆按自己的时长结算，所以扫得勤不会多扣；
            // 只有当"至少一条"距自己的锚点过了 10 分钟，才真正跑一轮。
            const tickMinutes = Number(store.config.decayTickMinutes) > 0 ? Number(store.config.decayTickMinutes) : 60;
            const idleMs = Math.min(10 * 60 * 1000, tickMinutes * 60 * 1000);
            const now = Date.now();
            const due = store.memories.some((m) => now - (Date.parse(m.decayAnchorAt ?? m.lastReadAt ?? m.createdAt ?? 0) || now) >= idleMs);
            if (!due) return;
            const result = store.decayRound();
            diag('auto decay ran: ' + result.transitions.length + ' transitions');
          } catch (error) {
            diag('auto decay failed: ' + error.message);
          }
        }, 5 * 60 * 1000);
        if (typeof timer.unref === 'function') timer.unref();
        return () => clearInterval(timer);
      }, 'fish-memory decay timer');
    }
  } catch (error) {
    diag('decay timer failed: ' + error.message);
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        let lastRun = 0;
        const timer = setInterval(() => {
          try {
            const minutes = Number(store.config.autoIngestMinutes);
            if (!(minutes > 0)) return;
            if (Date.now() - lastRun < minutes * 60 * 1000) return;
            lastRun = Date.now();
            const result = ingestSessions(store, {});
            if (result.createdCount > 0) diag('auto ingest: +' + result.createdCount + ' memories (scanned ' + result.scanned + ')');
          } catch (error) {
            diag('auto ingest failed: ' + error.message);
          }
        }, 60 * 1000);
        if (typeof timer.unref === 'function') timer.unref();
        return () => clearInterval(timer);
      }, 'fish-memory ingest timer');
    }
  } catch (error) {
    diag('ingest timer failed: ' + error.message);
  }

  // B站值班写的 memory.jsonl 汇入共享库（tags: B站/跨端）：只读新行 + hash 去重。
  try {
    if (typeof ctx.effect === 'function') {
      const biliMemoryFile = path.join(path.dirname(storeDir), 'bili-duty', 'memory.jsonl');
      const biliTailState = path.join(storeDir, 'bili-tail.json');
      ctx.effect(() => {
        let lastRun = 0;
        const timer = setInterval(() => {
          try {
            if (Date.now() - lastRun < 60 * 1000) return;
            lastRun = Date.now();
            const r = syncBiliMemory(store, { memoryFile: biliMemoryFile, stateFile: biliTailState });
            if (r.created > 0) diag('bili tail: +' + r.created + ' memories');
          } catch (error) { diag('bili tail failed: ' + error.message); }
        }, 60 * 1000);
        if (typeof timer.unref === 'function') timer.unref();
        return () => clearInterval(timer);
      }, 'fish-memory bili tailer');
    }
  } catch (error) { diag('bili tailer setup failed: ' + error.message); }

  diag('sessions root = ' + defaultSessionsRoot());
  injectPrompt(ctx, store);
  diag('apply done');

  return store;
}

export { MemoryStore };
