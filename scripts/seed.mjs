#!/usr/bin/env node
// 往记忆库里放几条"系统自身的记忆"，让新装的控制台不是空的（可重复执行，自动去重）。
import { MemoryStore } from '../lib/store.js';
import { defaultStoreDir } from '../lib/index.js';

const store = new MemoryStore(process.argv[2] ?? defaultStoreDir()).load();
const entries = [
  {
    title: '记忆系统落地形态：四层 + 连续分数',
    content: '本机装的是 dsh-fish-memory 插件，实现《记忆系统方案.md》。四层：hot(>=3) → recall(>=1.5) → archive(>=0.5) → cold(<0.5)。新记忆 createStrength=2 落在 recall，读一次 +1 升 hot，每轮衰减 strength *= decayFactor(0.98)。',
    tags: ['记忆系统', '架构'],
  },
  {
    title: '三条不照抄原方案的地方',
    content: '① 不做不可逆销毁：cold 是最冷层，真要删只进墓碑（tombstones.json），随时 revive 复活；② 同会话 30 分钟内的重复读只返回内容不计分，避免礼貌性回看虚增次数；③ hot 层有硬 token 预算（默认 1200），超预算的低分记忆强制沉到 recall，否则分层会退化成 LRU。',
    tags: ['记忆系统', '取舍'],
  },
  {
    title: '回忆即强化：读正文才算一次点击',
    content: '默认只有标题可见（hot 层标题已注入系统提示）。要正文调 memory_read(id)：这次工具调用本身就是点击，clicks +1、strength +1，并刷新回 hot。花 token 取全文的行为天然带意图，是免费的相关性反馈。',
    tags: ['记忆系统', '机制'],
  },
  {
    title: '记忆系统的入口与控制台',
    content: '插件目录 ~/.dsh/plugins/dsh-fish-memory；数据在 ~/.dsh/fish-memory（store.json / tombstones.json / audit.jsonl / plugin.log）。DSH 起来后访问 http://127.0.0.1:<端口>/fish-memory 看可视化控制台；不装也能看：node ~/.dsh/plugins/dsh-fish-memory/lib/standalone.mjs 后打开 127.0.0.1:8788。',
    tags: ['记忆系统', '运维'],
  },
  {
    title: '记忆工具清单（12 个）',
    content: 'memory_index（全库索引）、memory_list（按层看标题）、memory_read（取正文 = 强化）、memory_search（搜标题/标签）、memory_write、memory_update、memory_move、memory_forget、memory_revive、memory_stats、memory_decay、memory_config。',
    tags: ['记忆系统', '工具'],
  },
  {
    title: '衰减与遗忘的手感',
    content: '一天不读：hot 的记忆 strength 从 3 掉到 2.94 回 recall；再几天 → archive（只剩标题）；继续掉到 0.5 以下进 cold，等于"想不起来的旧事"。想恢复就 memory_revive，或从墓碑复活。',
    tags: ['记忆系统', '衰减'],
  },
];

let created = 0;
for (const entry of entries) {
  if (store.memories.some((m) => m.title === entry.title)) continue;
  store.create({ ...entry, origin: 'seed' });
  created += 1;
}
console.log('新增 ' + created + ' 条；当前共 ' + store.memories.length + ' 条记忆，' + store.tombstones.length + ' 条墓碑');
