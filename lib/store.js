// dsh-fish-memory · 存储引擎（纯逻辑，零依赖，插件 / standalone / 测试共用）
//
// 设计来自《记忆系统方案.md》：
//   - 分层可见性（标题默认可见，正文按需取）→ indexView()
//   - 回忆即强化（读正文 = 一次点击）→ read()
//   - 周期衰减（每轮乘一个 <1 的因子，再按分数重排层级）→ decayRound()
//   - 补上方案自带的批评：① 不销毁 → cold 冷存 + 墓碑可复活；② 会话内去重不虚增次数；
//     ③ hot 层有硬 token 预算，超了强制下沉（否则分层退化成 LRU）。
import fs from 'node:fs';
import path from 'node:path';

export const LAYERS = ['hot', 'recall', 'archive', 'cold'];

export function estimateTokens(text) {
  const s = String(text ?? '');
  if (s.length === 0) return 0;
  // 中文为主：两个字符约 1 token，偏保守（宁可高估省下来的 token）
  return Math.ceil(s.length / 2);
}

export function defaultConfig() {
  return {
    decayFactor: 0.98,
    decayIntervalHours: 24,
    decayTickMinutes: 60,
    thresholds: { hot: 3, recall: 1.5, archive: 0.5 },
    hotBudgetTokens: 1200,
    dedupeWindowMinutes: 30,
    recallBoost: 1,
    createStrength: 2,
    reviveStrength: 3,
    autoDecay: true,
    // 默认关闭自动回忆：开着的话，人工清理掉的记忆会被自动 ingest 复活（30 分钟一轮）。
    // 想启用就在设置/控制台把 autoIngestMinutes 改成 >0 的分钟数。
    autoIngestMinutes: 0,
  };
}

const round4 = (n) => Math.round(n * 10000) / 10000;
const nowIso = () => new Date().toISOString();

/** 归一成一个可排序的 ISO 时间字符串；解析不了返回 null。 */
export function memoryTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 录入时间：createdAt → history 首条 → updatedAt → id 里的 base36 时间戳。
 * 老库缺字段也不怕：id 形如 m_<base36 毫秒>_<随机>，本身就能反推录入时刻。
 */
export function memoryCreatedAt(memory) {
  if (!memory) return null;
  const direct = memoryTime(memory.createdAt);
  if (direct) return direct;
  const first = Array.isArray(memory.history) && memory.history.length > 0 ? memoryTime(memory.history[0] && memory.history[0].at) : null;
  if (first) return first;
  const updated = memoryTime(memory.updatedAt);
  if (updated) return updated;
  const m = /^m_([0-9a-z]+)_/.exec(String(memory.id ?? ''));
  if (m) {
    const ms = parseInt(m[1], 36);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  return null;
}

/** 最后改动时间：updatedAt → lastReadAt → 录入时间。 */
export function memoryUpdatedAt(memory) {
  if (!memory) return null;
  return memoryTime(memory.updatedAt) ?? memoryTime(memory.lastReadAt) ?? memoryCreatedAt(memory);
}

export const SORT_MODES = ['strength', 'time', 'old', 'updated', 'clicks', 'title'];

/** 统一排序：strength（默认）| time 新→旧 | old 旧→新 | updated | clicks | title。 */
export function sortMemories(list, sort = 'strength') {
  const items = Array.isArray(list) ? list.slice() : [];
  const mode = SORT_MODES.includes(sort) ? sort : 'strength';
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const timeOf = (m) => Date.parse(memoryCreatedAt(m) ?? '') || 0;
  const updatedOf = (m) => Date.parse(memoryUpdatedAt(m) ?? '') || 0;
  const byTitle = (a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-Hans-CN');
  items.sort((a, b) => {
    switch (mode) {
      case 'time': return timeOf(b) - timeOf(a) || byTitle(a, b);
      case 'old': return timeOf(a) - timeOf(b) || byTitle(a, b);
      case 'updated': return updatedOf(b) - updatedOf(a) || byTitle(a, b);
      case 'clicks': return num(b.clicks) - num(a.clicks) || byTitle(a, b);
      case 'title': return byTitle(a, b);
      default: return num(b.strength) - num(a.strength) || byTitle(a, b);
    }
  });
  return items;
}

function newId(at = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return 'm_' + at.toString(36) + '_' + rand;
}

/** 记录层级变化（衰减路径上与实例方法同义，单独抽出来避免 this 绑定问题）。 */
function recordLayerSafe(store, memory, to, reason) {
  return store.recordLayer(memory, to, reason);
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function normalizeConfig(raw) {
  const base = defaultConfig();
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  merged.thresholds = {
    ...base.thresholds,
    ...(raw && raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {}),
  };
  const df = Number(merged.decayFactor);
  merged.decayFactor = Number.isFinite(df) && df > 0 && df <= 1 ? df : base.decayFactor;
  for (const key of ['decayIntervalHours', 'decayTickMinutes', 'hotBudgetTokens', 'dedupeWindowMinutes', 'recallBoost', 'createStrength', 'reviveStrength', 'autoIngestMinutes']) {
    const v = Number(merged[key]);
    merged[key] = Number.isFinite(v) && v >= 0 ? v : base[key];
  }
  const t = merged.thresholds;
  const ht = Number(t.hot);
  const rt = Number(t.recall);
  const at = Number(t.archive);
  const hotT = Number.isFinite(ht) && ht > 0 ? ht : base.thresholds.hot;
  const recT = Number.isFinite(rt) && rt >= 0 && rt < hotT ? rt : Math.min(base.thresholds.recall, hotT / 2);
  const arcT = Number.isFinite(at) && at >= 0 && at < recT ? at : 0;
  merged.thresholds = { hot: hotT, recall: recT, archive: arcT };
  merged.autoDecay = merged.autoDecay !== false;
  return merged;
}

export class MemoryStore {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.logger = options.logger ?? null;
    this.config = defaultConfig();
    this.memories = [];
    this.tombstones = [];
    this.stats = { dedupeSaved: 0, decayRounds: 0, boosts: 0 };
    this.lastDecayAt = null;
    this.revision = 0;
    this.stampMs = 0;
  }

  get storeFile() { return path.join(this.dir, 'store.json'); }
  get tombstoneFile() { return path.join(this.dir, 'tombstones.json'); }
  get auditFile() { return path.join(this.dir, 'audit.jsonl'); }
  get stateFile() { return path.join(this.dir, 'state.json'); }

  /** store.json 的当前 mtime（毫秒）；文件不存在返回 0。 */
  diskStamp() {
    try {
      return fs.statSync(this.storeFile).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 写之前先确认磁盘没被别的进程改过（插件进程 / standalone / 控制台脚本会同时写同一个库）。
   * 有变化就整体重载，避免"内存里的旧副本把别人写的记忆覆盖掉"。
   */
  ensureFresh() {
    if (this.diskStamp() === 0) return false;
    let head;
    try {
      head = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
    } catch {
      return false;
    }
    const revision = Number(head.revision) || 0;
    if (revision !== (Number(this.revision) || 0)) {
      this.load();
      return true;
    }
    return false;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const data = readJson(this.storeFile, null);
    if (data && Array.isArray(data.memories)) {
      this.revision = Number(data.revision) || 0;
      this.config = normalizeConfig(data.config);
      this.memories = data.memories.map((m) => {
        const row = {
          tags: [],
          history: [],
          clicks: 0,
          strength: 1,
          ...m,
          tags: Array.isArray(m.tags) ? m.tags : [],
          history: Array.isArray(m.history) ? m.history : [],
        };
        // 时间戳统一在这里补齐：createdAt 保证"一眼看出哪条是新的"，updatedAt 保证能按最近改动排。
        row.createdAt = memoryCreatedAt(row);
        row.updatedAt = memoryUpdatedAt(row);
        // 老库没有锚点时，用"上次读过 → 录入时间"补齐，保证每条都能按自己的时长衰减
        row.decayAnchorAt = row.decayAnchorAt ?? row.lastReadAt ?? row.createdAt ?? nowIso();
        return row;
      });
      this.stats = { ...this.stats, ...(data.stats ?? {}) };
    } else {
      this.config = defaultConfig();
      this.memories = [];
      this.save();
    }
    const tombs = readJson(this.tombstoneFile, null);
    this.tombstones = tombs && Array.isArray(tombs.items) ? tombs.items : [];
    const state = readJson(this.stateFile, null);
    if (state && typeof state.lastDecayAt === 'string') this.lastDecayAt = state.lastDecayAt;
    this.stampMs = this.diskStamp();
    return this;
  }

  save() {
    this.revision = (Number(this.revision) || 0) + 1;
    atomicWrite(this.storeFile, JSON.stringify({
      version: 1,
      revision: this.revision,
      updatedAt: nowIso(),
      config: this.config,
      stats: this.stats,
      memories: this.memories,
    }, null, 1));
    atomicWrite(this.tombstoneFile, JSON.stringify({ version: 1, items: this.tombstones }, null, 1));
    atomicWrite(this.stateFile, JSON.stringify({ lastDecayAt: this.lastDecayAt }, null, 1));
    this.stampMs = this.diskStamp();
  }

  audit(event) {
    const row = { at: nowIso(), ...event };
    try {
      fs.appendFileSync(this.auditFile, JSON.stringify(row) + '\n', 'utf8');
    } catch (error) {
      if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(error);
    }
    return row;
  }

  auditTail(limit = 80) {
    let lines = [];
    try {
      lines = fs.readFileSync(this.auditFile, 'utf8').split('\n');
    } catch {
      return [];
    }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }

  layerFor(strength) {
    const t = this.config.thresholds;
    if (strength >= t.hot) return 'hot';
    if (strength >= t.recall) return 'recall';
    if (strength >= t.archive) return 'archive';
    return 'cold';
  }

  find(id) {
    return this.memories.find((m) => m.id === id) ?? null;
  }

  recordLayer(memory, to, reason) {
    const from = memory.layer;
    if (from === to) return false;
    memory.layer = to;
    memory.updatedAt = nowIso();
    memory.history = [...(memory.history ?? []), { at: nowIso(), from, to, reason }].slice(-40);
    return true;
  }

  // hot 层硬 token 预算：超预算的低分记忆强制沉到 recall（批评③的落点）
  enforceHotBudget() {
    const budget = this.config.hotBudgetTokens;
    if (!(budget > 0)) return [];
    const hot = this.memories.filter((m) => m.layer === 'hot').sort((a, b) => b.strength - a.strength);
    let used = 0;
    const sunk = [];
    for (const m of hot) {
      const tokens = estimateTokens(m.title);
      if (used + tokens <= budget) {
        used += tokens;
        continue;
      }
      if (this.recordLayer(m, 'recall', 'hot-budget')) {
        sunk.push({ id: m.id, title: m.title, from: 'hot', to: 'recall', reason: 'hot-budget' });
        this.audit({ type: 'sink', id: m.id, title: m.title, detail: 'hot token 预算超限，强制下沉 recall' });
      }
    }
    return sunk;
  }

  create({ title, content, tags = [], layer, origin } = {}) {
    this.ensureFresh();
    const t = String(title ?? '').trim();
    const c = String(content ?? '').trim();
    if (!t) throw new Error('title 不能为空');
    if (!c) throw new Error('content 不能为空');
    const at = nowIso();
    const toLayer = LAYERS.includes(layer) ? layer : this.layerFor(this.config.createStrength);
    const memory = {
      id: newId(),
      title: t.slice(0, 200),
      content: c,
      tags: (Array.isArray(tags) ? tags : String(tags ?? '').split(/[,\s]+/))
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 12),
      layer: toLayer,
      origin: origin === 'session' || origin === 'seed' ? origin : 'manual',
      strength: this.config.createStrength,
      clicks: 0,
      createdAt: at,
      updatedAt: at,
      decayAnchorAt: at,
      lastReadAt: null,
      lastCountedAt: null,
      lastCountSession: null,
      history: [{ at, from: null, to: toLayer, reason: 'create' }],
    };
    this.memories.unshift(memory);
    this.enforceHotBudget();
    this.save();
    this.audit({ type: 'create', id: memory.id, title: memory.title, detail: 'layer=' + memory.layer });
    return memory;
  }

  update({ id, title, content, tags } = {}) {
    this.ensureFresh();
    const memory = this.find(id);
    if (!memory) throw new Error('记忆不存在: ' + id);
    if (title !== undefined) {
      const t = String(title).trim();
      if (!t) throw new Error('title 不能为空');
      memory.title = t.slice(0, 200);
    }
    if (content !== undefined) {
      const c = String(content).trim();
      if (!c) throw new Error('content 不能为空');
      memory.content = c;
    }
    if (tags !== undefined) {
      memory.tags = (Array.isArray(tags) ? tags : String(tags ?? '').split(/[,\s]+/))
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 12);
    }
    memory.updatedAt = nowIso();
    this.enforceHotBudget();
    this.save();
    this.audit({ type: 'update', id: memory.id, title: memory.title, detail: '编辑' });
    return memory;
  }

  // 回忆一次：返回全文 + 计一次点击 + 刷新到 hot。同会话窗口内重复读不计分（批评②）。
  read(id, options = {}) {
    this.ensureFresh();
    const sessionId = options.sessionId ?? null;
    const at = options.at ?? Date.now();
    const memory = this.find(id);
    if (!memory) throw new Error('记忆不存在: ' + id);
    const windowMs = this.config.dedupeWindowMinutes * 60 * 1000;
    const sameSession = sessionId != null && memory.lastCountSession === sessionId;
    const within = memory.lastCountedAt != null && at - new Date(memory.lastCountedAt).getTime() < windowMs;
    const counted = !(sameSession && within);
    if (counted) {
      memory.strength = round4(memory.strength + this.config.recallBoost);
      memory.clicks += 1;
      memory.lastReadAt = new Date(at).toISOString();
      memory.lastCountedAt = memory.lastReadAt;
      memory.lastCountSession = sessionId ?? 'direct';
      // 背一次＝衰减重新计时（这条记性从现在开始变） 
      memory.decayAnchorAt = memory.lastReadAt;
      this.stats.boosts = (this.stats.boosts ?? 0) + 1;
      this.recordLayer(memory, 'hot', 'recall');
      memory.updatedAt = nowIso();
      this.audit({
        type: 'recall',
        id: memory.id,
        title: memory.title,
        detail: 'strength=' + memory.strength + ' clicks=' + memory.clicks,
      });
    } else {
      this.stats.dedupeSaved = (this.stats.dedupeSaved ?? 0) + 1;
      this.audit({ type: 'recall-deduped', id: memory.id, title: memory.title, detail: '同会话窗口内重复读取，不计分' });
    }
    this.enforceHotBudget();
    this.save();
    return { memory, counted };
  }

  move(id, layer) {
    this.ensureFresh();
    if (!LAYERS.includes(layer)) throw new Error('非法层: ' + layer);
    const memory = this.find(id);
    if (!memory) throw new Error('记忆不存在: ' + id);
    this.recordLayer(memory, layer, 'manual');
    this.save();
    this.audit({ type: 'move', id: memory.id, title: memory.title, detail: '人工移到 ' + layer });
    return memory;
  }

  // hard=true 只进墓碑（内容保留、可复活）；默认路径是下沉一层，永不销毁。
  forget(id, options = {}) {
    this.ensureFresh();
    const hard = options.hard === true;
    const memory = this.find(id);
    if (!memory) throw new Error('记忆不存在: ' + id);
    if (hard) {
      this.memories = this.memories.filter((m) => m.id !== id);
      const tombstone = {
        id: memory.id,
        title: memory.title,
        content: memory.content,
        tags: memory.tags,
        strength: memory.strength,
        clicks: memory.clicks,
        createdAt: memory.createdAt,
        deletedAt: nowIso(),
        history: memory.history,
      };
      this.tombstones.unshift(tombstone);
      this.save();
      this.audit({ type: 'tombstone', id: memory.id, title: memory.title, detail: '硬删除（墓碑可复活）' });
      return { memory: null, tombstone };
    }
    const index = LAYERS.indexOf(memory.layer);
    const deeper = LAYERS[Math.min(index + 1, LAYERS.length - 1)];
    this.recordLayer(memory, deeper, 'manual-forget');
    this.save();
    this.audit({ type: 'sink', id: memory.id, title: memory.title, detail: '人工下沉 ' + deeper });
    return { memory, tombstone: null };
  }

  // 从深层或墓碑拉回 hot：回忆可逆转遗忘
  revive(id) {
    this.ensureFresh();
    const tombIndex = this.tombstones.findIndex((t) => t.id === id);
    if (tombIndex >= 0) {
      const tomb = this.tombstones[tombIndex];
      this.tombstones.splice(tombIndex, 1);
      const memory = {
        id: tomb.id,
        title: tomb.title,
        content: tomb.content,
        tags: tomb.tags ?? [],
        layer: 'hot',
        strength: Math.max(tomb.strength ?? 0, this.config.reviveStrength),
        clicks: tomb.clicks ?? 0,
        createdAt: tomb.createdAt,
        updatedAt: nowIso(),
        decayAnchorAt: nowIso(),
        lastReadAt: null,
        lastCountedAt: null,
        lastCountSession: null,
        history: [...(tomb.history ?? []), { at: nowIso(), from: 'tombstone', to: 'hot', reason: 'revive' }].slice(-40),
      };
      this.memories.unshift(memory);
      this.enforceHotBudget();
      this.save();
      this.audit({ type: 'revive', id: memory.id, title: memory.title, detail: '墓碑复活' });
      return memory;
    }
    const memory = this.find(id);
    if (!memory) throw new Error('记忆不存在: ' + id);
    memory.strength = Math.max(memory.strength, this.config.reviveStrength);
    memory.decayAnchorAt = nowIso();
    this.recordLayer(memory, 'hot', 'revive');
    this.save();
    this.audit({ type: 'revive', id: memory.id, title: memory.title, detail: '从深层拉回 hot' });
    return memory;
  }

  /**
   * 一轮衰减：**按每条记忆自己的时长结算**，不是所有记忆一起挨一刀。
   * 强度按指数衰减：strength *= decayFactor ^ (该条距上次结算的小时数 / decayIntervalHours)。
   * 也就是说——刚录入 10 分钟的记忆，这轮只扣 10 分钟的量；上周录入又没人读的，才扣满。
   * 锚点 decayAnchorAt：录入时设一次；每次"计分的回忆"重新计时（背一次＝重新开始忘）；
   * 复活（revive）也重新计时。没读的旧条目锚点就是最后一次结算时间。
   */
  decayRound(at = Date.now()) {
    this.ensureFresh();
    const factor = this.config.decayFactor;
    const intervalMs = Math.max(1, this.config.decayIntervalHours) * 3600 * 1000;
    const transitions = [];
    for (const memory of this.memories) {
      const anchorRaw = memory.decayAnchorAt ?? memory.lastReadAt ?? memory.createdAt;
      const anchor = Number.isFinite(Date.parse(anchorRaw)) ? Date.parse(anchorRaw) : at;
      const elapsed = at - anchor;
      if (!(elapsed > 0)) continue;
      const units = elapsed / intervalMs;
      const before = memory.layer;
      memory.strength = round4(memory.strength * Math.pow(factor, units));
      memory.decayAnchorAt = new Date(at).toISOString();
      memory.updatedAt = nowIso();
      const after = this.layerFor(memory.strength);
      if (recordLayerSafe(this, memory, after, 'decay') && before !== after) {
        transitions.push({
          id: memory.id,
          title: memory.title,
          from: before,
          to: after,
          reason: 'decay',
          elapsedHours: Math.round((elapsed / 3600000) * 100) / 100,
        });
      }
    }
    for (const sunk of this.enforceHotBudget()) transitions.push(sunk);
    this.lastDecayAt = new Date(at).toISOString();
    this.stats.decayRounds = (this.stats.decayRounds ?? 0) + 1;
    this.save();
    for (const t of transitions) {
      this.audit({ type: 'decay', id: t.id, title: t.title, detail: t.from + ' → ' + t.to + ' (' + t.reason + ')' });
    }
    return { at: this.lastDecayAt, transitions };
  }

  /**
   * 下一次结算扫描时间。注意：衰减是"每条按自己的时长"扣的，
   * 所以这个时间只代表"插件下次扫一轮"，不代表所有记忆会在那时一起掉分。
   */
  nextDecayAt() {
    const tickMs = (Number(this.config.decayTickMinutes) > 0 ? Number(this.config.decayTickMinutes) : 60) * 60 * 1000;
    const base = this.lastDecayAt ? new Date(this.lastDecayAt).getTime() : Date.now();
    return new Date(base + tickMs).toISOString();
  }

  /** 某条记忆的下一次"掉层预计时间"（按当前分数与锚点外推），给界面用。 */
  projectedDecay(id, at = Date.now()) {
    const memory = this.find(id);
    if (!memory) return null;
    const factor = this.config.decayFactor;
    const intervalMs = Math.max(1, this.config.decayIntervalHours) * 3600 * 1000;
    const anchor = Date.parse(memory.decayAnchorAt ?? memory.lastReadAt ?? memory.createdAt ?? 0) || at;
    const thresholds = this.config.thresholds;
    const currentLayer = memory.layer;
    const nextBounds = { hot: thresholds.hot, recall: thresholds.recall, archive: thresholds.archive };
    const boundary = currentLayer === 'hot' ? nextBounds.hot : currentLayer === 'recall' ? nextBounds.recall : currentLayer === 'archive' ? nextBounds.archive : null;
    if (boundary === null || !(memory.strength > 0)) return null;
    // strength * factor^(t/interval) = boundary ⇒ t = interval * ln(boundary/strength)/ln(factor)
    const ratio = boundary / memory.strength;
    if (!(ratio > 0) || !(factor > 0) || factor === 1) return null;
    const hours = (intervalMs / 3600000) * (Math.log(ratio) / Math.log(factor));
    if (!Number.isFinite(hours)) return null;
    return { at: new Date(anchor + hours * 3600000).toISOString(), hours: Math.round(hours * 100) / 100 };
  }

  /** 标签词表：tag → 条数 / 分层分布。标签检索走的就是它（比逐个扫标题便宜）。 */
  listTags() {
    const table = new Map();
    for (const memory of this.memories) {
      for (const tag of memory.tags ?? []) {
        const key = String(tag);
        const row = table.get(key) ?? { tag: key, count: 0, byLayer: { hot: 0, recall: 0, archive: 0, cold: 0 } };
        row.count += 1;
        row.byLayer[memory.layer] = (row.byLayer[memory.layer] ?? 0) + 1;
        table.set(key, row);
      }
    }
    return [...table.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /**
   * 标签优先检索：先匹配标签（exact > prefix > substring），再匹配标题。
   * 标签是录入时给的稀疏索引，命中成本低、意图更明确，所以排在标题前面。
   */
  search(query, options = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const mode = options.mode === 'tag' || options.mode === 'title' ? options.mode : 'auto';
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 30;
    const layer = LAYERS.includes(options.layer) ? options.layer : null;
    const tagHits = [];
    const titleHits = [];
    const allTags = new Map();
    if (q.length === 0) return { query: q, mode, tagHits, titleHits, allTags: [] };

    const rank = (text) => {
      const t = String(text).toLowerCase();
      if (t === q) return { match: 'exact', score: 3 };
      if (t.startsWith(q)) return { match: 'prefix', score: 2 };
      if (t.includes(q)) return { match: 'substring', score: 1 };
      return null;
    };

    for (const memory of this.memories) {
      if (layer && memory.layer !== layer) continue;
      if (mode !== 'title') {
        let best = null;
        for (const tag of memory.tags ?? []) {
          const hit = rank(tag);
          if (hit === null) continue;
          if (best === null || hit.score > best.score) best = { match: hit.match, score: hit.score, tag: String(tag) };
          if (hit.score === 3) break;
        }
        if (best !== null) {
          tagHits.push({
            id: memory.id,
            title: memory.title,
            tag: best.tag,
            match: best.match,
            score: best.score,
            layer: memory.layer,
            strength: memory.strength,
            clicks: memory.clicks ?? 0,
            createdAt: memoryCreatedAt(memory),
          });
        }
      }
      if (mode !== 'tag') {
        const hit = rank(memory.title);
        if (hit !== null) {
          titleHits.push({
            id: memory.id,
            title: memory.title,
            match: hit.match,
            score: hit.score,
            layer: memory.layer,
            strength: memory.strength,
            clicks: memory.clicks ?? 0,
            createdAt: memoryCreatedAt(memory),
          });
        }
      }
    }
    for (const tag of this.listTags()) {
      if (tag.tag.toLowerCase().includes(q)) allTags.set(tag.tag, tag.count);
    }
    const byScore = (a, b) => b.score - a.score || b.strength - a.strength;
    return {
      query: q,
      mode,
      tagHits: tagHits.sort(byScore).slice(0, limit),
      titleHits: titleHits.sort(byScore).slice(0, limit),
      allTags: [...allTags.entries()].map(([tag, count]) => ({ tag, count })).slice(0, 40),
    };
  }

  // 记忆索引：一眼预览全系统位置与标题（方案 §2.8）。这就是「AI 默认可见」的形态。
  // sort 默认按分数；传 time/old/updated 就能按时间排（每条都带 createdAt/updatedAt）。
  indexView(options = {}) {
    const sort = SORT_MODES.includes(options.sort) ? options.sort : 'strength';
    const layers = {};
    let titleTokens = 0;
    let fullTokens = 0;
    for (const layer of LAYERS) {
      layers[layer] = sortMemories(this.memories.filter((m) => m.layer === layer), sort).map((m) => {
        const tokens = estimateTokens(m.title + ' ' + (m.tags ?? []).join(' '));
        titleTokens += tokens;
        fullTokens += estimateTokens(m.content);
        return {
          id: m.id,
          title: m.title,
          tokens,
          strength: m.strength,
          clicks: m.clicks,
          layer: m.layer,
          tags: m.tags ?? [],
          createdAt: memoryCreatedAt(m),
          updatedAt: memoryUpdatedAt(m),
        };
      });
    }
    return {
      layers,
      sort,
      tokens: { titleTokens, fullTokens, savedTokens: Math.max(0, fullTokens - titleTokens) },
      note: '默认只有标题可见；读正文请调 memory_read（同时计一次回忆强化）。',
    };
  }

  /**
   * 时间线：跨层按录入时间排（默认新→旧）。想看"最近记了什么"就走这里。
   * includeDeleted=true 时把墓碑也按删除时间并进来（layer 记为 tombstone）。
   */
  timeline(options = {}) {
    const order = options.order === 'old' || options.sort === 'old' ? 'old' : 'new';
    const layer = LAYERS.includes(options.layer) ? options.layer : null;
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;
    const rows = [];
    for (const m of this.memories) {
      if (layer && m.layer !== layer) continue;
      rows.push({
        id: m.id,
        title: m.title,
        layer: m.layer,
        strength: m.strength,
        clicks: m.clicks ?? 0,
        tags: m.tags ?? [],
        createdAt: memoryCreatedAt(m),
        updatedAt: memoryUpdatedAt(m),
        deleted: false,
      });
    }
    if (options.includeDeleted === true) {
      for (const t of this.tombstones) {
        rows.push({
          id: t.id,
          title: t.title,
          layer: 'tombstone',
          strength: t.strength ?? 0,
          clicks: t.clicks ?? 0,
          tags: t.tags ?? [],
          createdAt: memoryCreatedAt(t) ?? memoryTime(t.deletedAt),
          updatedAt: memoryTime(t.deletedAt),
          deleted: true,
        });
      }
    }
    const sorted = sortMemories(rows, order === 'old' ? 'old' : 'time');
    return { order, layer, total: rows.length, items: sorted.slice(0, limit) };
  }

  statsView() {
    const byLayer = { hot: 0, recall: 0, archive: 0, cold: 0 };
    let totalClicks = 0;
    let strengthSum = 0;
    let titleTokens = 0;
    let fullTokens = 0;
    for (const m of this.memories) {
      byLayer[m.layer] = (byLayer[m.layer] ?? 0) + 1;
      totalClicks += m.clicks ?? 0;
      strengthSum += m.strength ?? 0;
      titleTokens += estimateTokens(m.title);
      fullTokens += estimateTokens(m.content);
    }
    const total = this.memories.length;
    const savedTokens = Math.max(0, fullTokens - titleTokens);
    return {
      total,
      byLayer,
      totalClicks,
      avgStrength: total === 0 ? 0 : round4(strengthSum / total),
      lastDecayAt: this.lastDecayAt,
      nextDecayAt: this.nextDecayAt(),
      dedupeSaved: this.stats.dedupeSaved ?? 0,
      decayRounds: this.stats.decayRounds ?? 0,
      tombstones: this.tombstones.length,
      tokens: {
        titleTokens,
        fullTokens,
        savedTokens,
        savedPct: fullTokens === 0 ? 0 : round4(savedTokens / fullTokens),
      },
    };
  }

  setConfig(patch = {}) {
    this.ensureFresh();
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = normalizeConfig({
      ...this.config,
      ...p,
      thresholds: { ...this.config.thresholds, ...(p.thresholds && typeof p.thresholds === 'object' ? p.thresholds : {}) },
    });
    const changed = JSON.stringify(next) !== JSON.stringify(this.config);
    this.config = next;
    // 阈值变了要重排层级，否则界面显示与实际分数对不上
    for (const memory of this.memories) this.recordLayer(memory, this.layerFor(memory.strength), 'reconfig');
    const sunk = this.enforceHotBudget();
    this.save();
    if (changed) this.audit({ type: 'config', detail: JSON.stringify(this.config) });
    return { config: this.config, sunk };
  }

  reset() {
    this.ensureFresh();
    this.memories = [];
    this.tombstones = [];
    this.stats = { dedupeSaved: 0, decayRounds: 0, boosts: 0 };
    this.lastDecayAt = null;
    this.config = defaultConfig();
    this.save();
    this.audit({ type: 'reset', detail: '清空全部记忆与墓碑' });
  }

  exportSnapshot() {
    return {
      config: this.config,
      stats: this.statsView(),
      memories: this.memories,
      tombstones: this.tombstones,
      lastDecayAt: this.lastDecayAt,
    };
  }
}

export default MemoryStore;
