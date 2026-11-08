// dsh-fish-memory · 会话录入（历史会话 → 记忆）
//
// 会话日志的物理格式（本机实测，2026-10-30）：
//   ~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
//   文件是**多个独立 zstd frame 拼接**的追加日志：Node 的 zstdDecompressSync 只解第一帧
//   （只有 191 字节的 session 头），必须按魔数 28 B5 2F FD 切开逐帧解压，才能拿到全部事件。
// 取哪些事件：
//   type = 'user/message'，data.content[].text；过滤掉运行时上下文 / system-reminder / 私信接力模板这类
//   "不是人说的话"（它们也是以 user/message 注入的）。
// 录什么：
//   每个会话取**第一条真正的用户发言**（会话的诉求）作为一条记忆；若最后一条发言与之明显不同且足够长，
//   再补一条"后续"。重复内容靠 ingest-index.json 的内容哈希去重，不会反复录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把追加式 zstd 日志完整解开（逐 frame 解，Node 自带的流式解码停在第一帧）。 */
export function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  const offsets = [];
  let i = 0;
  while (true) {
    const j = buf.indexOf(MAGIC, i);
    if (j < 0) break;
    offsets.push(j);
    i = j + 4;
  }
  if (offsets.length === 0) return [];
  let text = '';
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {
      // 单帧损坏不影响整篇
    }
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

/** 事件里的文本部分。 */
export function eventText(event) {
  const content = event && event.data ? event.data.content : undefined;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  if (typeof content === 'string') return content.trim();
  return '';
}

/** 这些开头的 user/message 是框架注入或接力模板，不是使用者本人说的话。 */
const META_PREFIXES = [
  'Current runtime context',
  '<system-reminder>',
  '【B站私信接力】',
  '【评论区',
  'DM relay',
  'Team message from',
  '后台子代理',
  // 子代理的角色提示词：那是"我给分身派活时写的"，不是爹地本人说的话
  '你是',
  '你执行',
  '你负责',
  '你现在',
  'This is an automatically generated',
  '以下是你',
  '【当前时间】',
  '【系统',
  '【环境',
  '这是 B站 私信里',
  '（说话风格按这份人设来',
];

export function isGenuineUserText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.length > 4000) return false; // 超长块基本是框架拼的系统提示
  for (const prefix of META_PREFIXES) {
    if (t.startsWith(prefix)) return false;
  }
  // 形如 "# 角色：..." / "## 你的任务" 的角色卡也是分身提示词
  if (/^#{1,3}\s*(角色|你的任务|任务|Role|Your task)/.test(t)) return false;
  if (t.includes('attachment sha256:') && t.length < 200) return false;
  return true;
}

/** 会话里真正的用户发言（按 seq 顺序）。 */
export function genuineUserTurns(events) {
  return events
    .filter((event) => event && event.type === 'user/message')
    // 本机实测的 source.kind 取值：user（真人/接力）才是人说的话；
    // runtime-context / skill-catalog / dsh-mnemon / model-selection / time-context / user-approval /
    // agent-message / subagent-settled / tool-jobs / repeat-tool-reminder 都是框架或别的插件注入的。
    .filter((event) => {
      const kind = event.data && event.data.source ? event.data.source.kind : undefined;
      return kind === undefined || kind === 'user';
    })
    .map((event) => ({ seq: Number(event.seq) || 0, time: event.time ?? null, text: eventText(event) }))
    .filter((turn) => isGenuineUserText(turn.text))
    .sort((a, b) => a.seq - b.seq);
}

/** 闲聊/确认/道谢这类不值得记的开头。 */
const TRIVIAL_PREFIX = /^(继续|好了|可以了|嗯+|哦+|谢谢|好|ok|OK|收到|不用了|算了吧|我发错了|上面的话不用管|知道了|对的|是的|行|辛苦了|没事)/;

/**
 * 重要性打分：只有"值得记住"的发言才配进记忆库。
 * 闲聊、确认、道谢、一两个字的回复一律 0 分；带明确诉求 / 文件路径 / 偏好声明 / 项目名词的加分。
 */
export function importanceScore(text) {
  const t = String(text ?? '').trim();
  if (t.length < 12) return 0;
  if (TRIVIAL_PREFIX.test(t) && t.length < 30) return 0;
  let score = 0;
  if (/(帮|做|写|改|修|装|安装|查|找|加|删|跑|测|试|优化|设计|实现|给我|看看|搞定|排查|接入|替换|重构|整理|生成)/.test(t)) score += 2;
  if (/(https?:\/\/|github|\.md\b|\.json\b|\.mjs\b|[A-Z]:\\|npm |pnpm |node |终端)/i.test(t)) score += 2;
  // 纯链接、裸工具名、报错粘贴：不是记忆，直接 0 分
  if (/^https?:\/\/\S+$/.test(t)) return 0;
  // 正文里 URL 占比过高（分享链接、直链）也不记
  const urlChars = (t.match(/https?:\/\/\S+/g) ?? []).join('').length;
  if (urlChars > 0 && urlChars / t.length > 0.5) return 0;
  if (/(mcp__|^[a-z_]+__[A-Za-z_]+|tool_call|tool_name)/.test(t) && t.length < 80) return 0;
  if (/^(502|500|404|403):|\{"message":|Upstream service|Traceback|TypeError|ReferenceError/.test(t)) return 0;
  // 连通性/指令测试："只回复 OK 两个字，不要调用任何工具" 这类不是记忆
  if (/(只回复|不要调用任何工具|不要写文件|连通性测试|测试用|probe)/.test(t) && t.length < 60) return 0;
  if (t.length >= 40) score += 2;
  else if (t.length >= 20) score += 1;
  if (/(为什么|怎么|什么|能不能|可不可以|是不是|有没有|如何)/.test(t)) score += 1;
  if (/(我喜欢|我不喜欢|讨厌|记住|以后|别|一定要|默认|每次都|下次|不要再)/.test(t)) score += 2;
  if (/(插件|记忆|B站|bilibili|QQ|情绪|界面|UI|控制台|表格|文档|方案|设置|权限|声音|表情包)/i.test(t)) score += 1;
  return score;
}

export const IMPORTANT_THRESHOLD = 3;

/**
 * 长期价值判定：只留"值得长期记住"的，一次性任务做完就该忘。
 *   留：偏好/规则、身份设定、配置与凭证、结论与原理、项目位置与运维方式
 *   丢：一次性动作请求（帮我做个…、查一下有没有…、升级到最新版、删掉多余的…）
 * 打分 = 长期项 ×2 − 一次性项；< 2 分不收。
 */
const DURABLE_RULES = [
  [/(以后|下次|每次|每次都|不要再|不许|不要|别|一定要|默认|约定|规矩|规则|格式|称呼)/, 3],
  [/(人设|角色卡|身份|管理员|昵称|名字叫|我是|你是|爹地|爸爸)/, 3],
  [/(我喜欢|我不喜欢|讨厌|偏好|习惯)/, 3],
  [/(apiKey|api key|key 是|token|baseURL|base url|协议兼容|端口|凭证|账号是|密码)/i, 3],
  [/(结论|教训|原理|机制|架构|方案|设计思路|为什么|是因为|本质上|总结|取舍)/, 2],
  [/(目录|路径|存放在|数据在|入口|控制台|部署|安装位置|怎么启动|运维)/, 2],
  [/(工具清单|怎么用|用法|调用方式|有哪些工具|记忆系统|标签|检索)/, 2],
  // 纠正型规则（"不是…而是…"、"只收录…"、"只留…"）都是长期约定
  [/(只收录|只留|只记|只保留|只需要|规则是|标准是|要求是|而是|不再是)/, 3],
  // 情绪/语气/人设相关的要求属于长期设定
  [/(情绪|语气|表达方式|说话风格|人设)/, 2],
  // 长期目标（在学什么、打算做什么、备考）也值得留
  [/(想学|正在学|打算|计划|目标|备考|复习|考试)/, 2],
];
// 报错/修复类：如果同时没有长期信号，直接丢——问题修好就该忘
const TRANSIENT_BUG = /(修复|报错|不生效|没跑起来|异常|失败|bug|502|404)/i;

const TASK_RULES = [
  [/(帮我|给我|替我|你来|麻烦你).{0,8}(做|写|改|修|装|删|查|找|加|更新|升级|接入|跑|测|生成|整理)/, 2],
  [/(做个|写个|写一个|做一个|加一个|改一下|修一下|查一下|找一下|找找|更新到|升级到|接入|删掉|去掉|跑一遍|重跑|排查|修复)/, 2],
  [/(下载|安装一个|打包|发布到|部署到)/, 1],
];

export function durabilityScore(text) {
  const t = String(text ?? '');
  let durable = 0;
  let task = 0;
  for (const [re, weight] of DURABLE_RULES) if (re.test(t)) durable += weight;
  for (const [re, weight] of TASK_RULES) if (re.test(t)) task += weight;
  return { durable, task, score: durable * 2 - task };
}

/** 只留长期有用的；一次性任务请求一律不收。 */
export function isDurable(text) {
  const t = String(text ?? '');
  const d = durabilityScore(t);
  if (d.score < 2) return false;
  // 纯故障报告（修完就过时）：除非同时带强长期信号，否则不留
  if (TRANSIENT_BUG.test(t) && d.durable < 4) return false;
  return true;
}

/** 标签规则：只给"能叫得出名字的主题"，不给日期、路径、工作区这种乱七八糟的东西。 */
const TAG_RULES = [
  [/记忆/, '记忆系统'],
  [/插件|plugin/i, '插件'],
  [/B站|bilibili|私信|评论|投币|弹幕/i, 'B站'],
  [/QQ|群聊|机器人|桥接/, 'QQ'],
  [/情绪|情感|心情/, '情绪'],
  [/界面|UI|控制台|仪表盘|前端|可视化/i, '界面'],
  [/表格|xlsx|文档|docx|PPT|幻灯片|Word|Excel/i, '办公文件'],
  [/技能|skill|工具链|工具箱/i, '工具'],
  [/声音|语音|TTS|ASR|音色/i, '语音'],
  [/表情包|斗图|meme|梗图/i, '表情包'],
  [/模型|deepseek|llm|token|上下文/i, '模型'],
  [/权限|安全|白名单|沙箱/, '权限安全'],
  [/安装|部署|升级|更新版本/, '安装部署'],
  [/小说|漫剧|绘图|配图|创作/, '创作'],
  [/网络搜索|检索|搜索/, '检索'],
];

/** 从正文里推 0~3 个主题标签；推不出就不打标签（宁缺毋滥）。 */
export function deriveTags(text) {
  const t = String(text ?? '');
  const tags = [];
  for (const [re, tag] of TAG_RULES) {
    if (re.test(t) && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= 3) break;
  }
  if (tags.length < 3 && /(我喜欢|我不喜欢|讨厌|记住|以后|别|一定要|默认|每次都|下次|不要再)/.test(t) && !tags.includes('偏好')) tags.push('偏好');
  return tags.slice(0, 3);
}

/**
 * 标题生成：让标题一眼能看出"这条记忆是干什么的"。
 * 规则：判类别（偏好/问题/疑问/需求）→ 去掉 @、路径、链接、口头填充词 → 取第一句 → 截断。
 */
export function buildTitle(text, max = 26) {
  let t = String(text ?? '').trim();
  t = t.replace(/^【[^】]{0,20}】\s*/, '');
  t = t.replace(/^@\S+\s*/, '');
  t = t.replace(/[A-Za-z]:\\[^\s，。；]+/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length === 0) return '（无正文）';
  const kind = /(我喜欢|我不喜欢|讨厌|以后|别|一定要|默认|每次都|下次|不要再|记住)/.test(t)
    ? '偏好'
    : /(报错|错误|失败|不生效|没用|坏了|修复|bug|502|404|异常)/i.test(t)
      ? '问题'
      : /(为什么|怎么|什么|如何|能不能|可不可以|是不是|有没有)/.test(t)
        ? '疑问'
        : '需求';
  let core = t
    .replace(/^(你好|嗨|那个|然后|就是|还有|另外|顺便|我想|我想要|我要|我希望|你能不能|你可不可以|能否|可以|麻烦你|麻烦|请|帮我|帮|给我|给我个|你来|你帮我)+/g, '')
    .trim();
  const clause = core.split(/[。！？；\n]/).map((x) => x.trim()).filter((x) => x.length > 0)[0] ?? core;
  core = clause.replace(/^[，、,]+/, '').replace(/[，、,]+$/, '').trim();
  if (core.length === 0) core = t;
  if (core.length > max) {
    // 先试第一分句（"帮我做个磁力下载程序，能下载网友的链接" → "做个磁力下载程序"）
    const head = core.split(/[，、,]/)[0].trim();
    core = head.length >= 6 && head.length <= max ? head : core.slice(0, max) + '…';
  }
  return kind + '：' + core;
}

function shorten(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max) + '…';
}

function contentHash(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '_' + s.length.toString(36);
}

export function defaultSessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

/** 一层层扫出所有会话日志。 */
export function listSessionLogs(sessionsRoot) {
  const found = [];
  if (!fs.existsSync(sessionsRoot)) return found;
  for (const workspace of fs.readdirSync(sessionsRoot)) {
    const wsDir = path.join(sessionsRoot, workspace);
    let entries = [];
    try {
      if (!fs.statSync(wsDir).isDirectory()) continue;
      entries = fs.readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const session of entries) {
      const file = path.join(wsDir, session, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      found.push({ workspace, sessionId: session, file, mtimeMs: stat.mtimeMs, bytes: stat.size });
    }
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * 把历史会话录进记忆库。
 * @param store MemoryStore
 * @param options { sessionsRoot, sinceDays, maxSessions, dryRun, logger }
 */
export function ingestSessions(store, options = {}) {
  const sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot();
  const sinceDays = Number(options.sinceDays) > 0 ? Number(options.sinceDays) : 0;
  const maxSessions = Number(options.maxSessions) > 0 ? Number(options.maxSessions) : Infinity;
  const dryRun = options.dryRun === true;

  try {
    store.ensureFresh();
  } catch {}

  const indexFile = path.join(store.dir, 'ingest-index.json');
  let index = { version: 1, hashes: {}, sessions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (parsed && typeof parsed === 'object') index = { version: 1, hashes: parsed.hashes ?? {}, sessions: parsed.sessions ?? {} };
  } catch {}

  let rebuiltCount = 0;
  if (options.rebuild === true && !dryRun) {
    // 只清"上一轮从会话录进来的"记忆（带 会话诉求/会话后续 标签），种子记忆不动
    // 只清"会话录入"的（origin=session）；种子与人工/工具写的记忆一律保留
    const removed = store.memories.filter((m) => m.origin === 'session' || (Array.isArray(m.tags) && m.tags.some((t) => t === '会话诉求' || t === '会话后续')));
    for (const m of removed) store.forget(m.id, { hard: true });
    index = { version: 1, hashes: {}, sessions: {} };
    rebuiltCount = removed.length;
  }

  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 24 * 3600 * 1000 : 0;
  const logs = listSessionLogs(sessionsRoot)
    .filter((log) => log.mtimeMs >= cutoff)
    .slice(-maxSessions);

  const created = [];
  const skipped = { alreadyIngested: 0, noTurns: 0, duplicate: 0, unreadable: 0, subagentSessions: 0, rebuilt: 0, relinked: 0, lowValue: 0, nearDuplicate: 0, tombstoned: 0 };
  // 近似重复：同一句诉求在不同会话里反复出现，只留一条
  const titleKey = (text) => String(text).replace(/\s+/g, '').slice(0, 24);
  const seenTitles = new Set(store.memories.map((m) => titleKey(m.content)));
  // 已被人工删掉（墓碑）的内容不许再录回来：否则自动 ingest 每 30 分钟就把清理过的记忆全部复活。
  const tombHashes = new Set((Array.isArray(store.tombstones) ? store.tombstones : []).map((t) => contentHash(String(t.content ?? ''))));
  const planned = [];

  for (const log of logs) {
    const recorded = index.sessions[log.sessionId];
    if (recorded !== undefined && recorded.mtimeMs >= log.mtimeMs) {
      // 索引说录过了还不够：那些记忆可能已经被别的进程（插件旧副本 / 控制台）覆盖掉了，
      // 必须确认它们**现在仍在库里**，否则重新录一遍。
      const hashes = Array.isArray(recorded.hashes) ? recorded.hashes : [];
      const inStore = new Set(store.memories.map((m) => contentHash(m.content)));
      if (hashes.length > 0 && hashes.every((h) => inStore.has(h) || tombHashes.has(h))) {
        skipped.alreadyIngested += 1;
        continue;
      }
      skipped.relinked += 1;
    }
    let events = [];
    try {
      events = decodeSessionLog(log.file);
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    // 子代理会话（delegationDepth > 0）里的话是分身干的，不算爹地本人的记忆
    const header = events.find((event) => event && event.type === 'session');
    if (header && Number(header.delegationDepth) > 0) {
      skipped.subagentSessions += 1;
      index.sessions[log.sessionId] = { mtimeMs: log.mtimeMs, turns: 0, hashes: [], subagent: true };
      continue;
    }
    const turns = genuineUserTurns(events);
    if (turns.length === 0) {
      skipped.noTurns += 1;
      index.sessions[log.sessionId] = { mtimeMs: log.mtimeMs, turns: 0, hashes: [] };
      continue;
    }
    // 只有达到重要性阈值的发言才进候选；一整个会话都是闲聊就直接不收
    const important = turns.filter((turn) => importanceScore(turn.text) >= IMPORTANT_THRESHOLD && isDurable(turn.text));
    // 说明：isDurable() 已经把"做完就忘的一次性任务"挡在外面（偏好/规则/设定/配置/结论/位置/目标才留）。
    if (important.length === 0) {
      skipped.lowValue += 1;
      index.sessions[log.sessionId] = { mtimeMs: log.mtimeMs, turns: turns.length, hashes: [], lowValue: true };
      continue;
    }
    const picks = [important[0]];
    const lastImportant = important[important.length - 1];
    if (important.length > 1 && lastImportant.text !== important[0].text) picks.push(lastImportant);
    if (picks.length > 2) picks.length = 2;
    const perSession = [];
    for (const [i, turn] of picks.entries()) {
      const hash = contentHash(turn.text);
      const key = titleKey(turn.text);
      if (seenTitles.has(key)) {
        skipped.nearDuplicate += 1;
        continue;
      }
      if (tombHashes.has(hash)) {
        skipped.tombstoned += 1;
        continue;
      }
      const recordedHash = index.hashes[hash];
      const hashAlive = recordedHash !== undefined && store.memories.some((m) => m.id === recordedHash.id);
      if (hashAlive || store.memories.some((m) => contentHash(m.content) === hash)) {
        skipped.duplicate += 1;
        continue;
      }
      const candidate = {
        title: buildTitle(turn.text),
        content: turn.text.length > 1200 ? turn.text.slice(0, 1200) + '…' : turn.text,
        tags: deriveTags(turn.text),
      };
      planned.push({ candidate, hash, sessionId: log.sessionId, log });
      perSession.push(hash);
      seenTitles.add(key);
    }
    if (!dryRun) index.sessions[log.sessionId] = { mtimeMs: log.mtimeMs, turns: turns.length, hashes: perSession };
  }

  skipped.rebuilt = rebuiltCount;

  if (!dryRun) {
    for (const item of planned) {
      const memory = store.create({ ...item.candidate, origin: 'session' });
      index.hashes[item.hash] = { id: memory.id, at: new Date().toISOString() };
      created.push(memory);
    }
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 1), 'utf8');
    store.save();
  }

  return {
    scanned: logs.length,
    planned: planned.length,
    created: created.map((m) => ({ id: m.id, title: m.title, layer: m.layer, tokens: Math.ceil(String(m.content).length / 2) })),
    createdCount: created.length,
    skipped,
    sessionsRoot,
  };
}

export { contentHash };
