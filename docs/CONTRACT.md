# dsh-fish-memory · 接口契约（Lead 已定稿，不可擅改）

插件根目录：`<repo>`（安装后位于 `~/.dsh/plugins/dsh-fish-memory`）

## 0. 设计依据
来源：本插件作者的分层记忆设计笔记（不随仓库分发）。落地要点（**采纳**）：分层可见性、回忆即强化、周期衰减、标题先行全文按需、记忆索引工具。
**不采纳**：不可逆销毁、硬性分层丢信息 → 改为连续 strength 分数 + cold 冷存可复活 + 墓碑审计日志。

## 1. 层级（4 层，只降不删）
| layer | 语义 | 默认阈值 |
|---|---|---|
| hot | 工作记忆，默认可见（标题） | strength >= 3 |
| recall | 按需检索（**新记忆默认落这里**） | strength >= 1.5 |
| archive | 只留标题 | strength >= 0.5 |
| cold | 冷存，需显式 revive 才回 hot | strength < 0.5 |

默认 `createStrength = 2`（新建即 recall）、`recallBoost = 1`（读一次 3 分升 hot）、`reviveStrength = 3`、
`decayFactor = 0.98`：一天不读就从 hot 掉回 recall，符合方案里"不背就会忘"的手感。

hot 层还有**硬 token 预算**（默认 1200）：hot 里按 strength 降序累加标题 token，超出预算的沉到 recall。
token 估算：`estimateTokens(text) = Math.ceil(text.length / 2)`。

## 2. 分数与衰减
- 新建记忆 `strength = 1`（config.createStrength）。
- 回忆（read）`strength += config.recallBoost`（默认 1），`clicks += 1`，`lastReadAt = now`，层刷新为 `hot`。
- 去重：同 `sessionId` 且距 `lastCountedAt` < `dedupeWindowMinutes`（默认 30）的重复 read **只返回内容、不计数**（返回 `counted:false`）。
- 一轮衰减（decay round）：每条 `strength *= config.decayFactor`（默认 0.98），然后按阈值重算层；每次层级变化写入 `history` 与 audit。
- 自动衰减间隔 `decayIntervalHours`（默认 24）。

## 3. 存储位置（宿主插件都写这里）
`~/.dsh/fish-memory/`：
- `store.json` 记忆 + config
- `tombstones.json` 硬删除记忆的墓碑（可复活，内容保留）
- `audit.jsonl` 审计日志，一行一个 JSON 事件
- `state.json` 运行时状态（lastDecayAt 等）

## 4. HTTP API（前缀 `BASE` = `/fish-memory`，宿主直出；standalone 时 BASE = ''）
返回值统一 `{ ok: true, ... }` 或 `{ ok: false, error: string }`。

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `BASE/` | — | 仪表盘 HTML（text/html；服务器把 HTML 里的字面量 `__BASE__` 替换成 BASE 值） |
| GET | `BASE/api/state` | — | `{ ok, config, stats, memories, tombstones? }` |
| GET | `BASE/api/index?sort=` | `sort=strength(默认)｜time｜old｜updated｜clicks｜title` | `{ ok, sort, layers: { hot:[{id,title,tokens,createdAt,updatedAt}], recall:[...], archive:[...], cold:[...] }, tokens:{titleTokens, fullTokens, savedTokens} }`（这是"AI 默认可见"的形态；layers 内按 sort 排序） |
| GET/POST | `BASE/api/timeline` | `{ order?:'new'｜'old', layer?, limit?, includeDeleted? }` | `{ ok, order, layer, total, items:[{id,title,layer,strength,clicks,tags,createdAt,updatedAt,deleted}] }`（跨层按录入时间排；includeDeleted=true 时墓碑按删除时间并入，layer="tombstone"） |
| GET | `BASE/api/audit?limit=80` | — | `{ ok, events:[{at,type,id,title,detail}] }` |
| GET | `BASE/api/tombstones` | — | `{ ok, tombstones:[...] }` |
| POST | `BASE/api/read` | `{ id, sessionId? }` | `{ ok, memory, counted:boolean }`（= 强化） |
| POST | `BASE/api/create` | `{ title, content, tags?, layer? }` | `{ ok, memory }` |
| POST | `BASE/api/update` | `{ id, title?, content?, tags? }` | `{ ok, memory }` |
| POST | `BASE/api/move` | `{ id, layer }` | `{ ok, memory }`（人工升降层，记 audit） |
| POST | `BASE/api/forget` | `{ id, hard?:boolean }` | `{ ok, memory?, tombstone? }`（hard=false 沉一层，hard=true 进墓碑） |
| POST | `BASE/api/revive` | `{ id }` | `{ ok, memory }`（墓碑 id 也可）
| POST | `BASE/api/config` | `{ patch:{...} }` | `{ ok, config }` |
| POST | `BASE/api/decay` | `{}` | `{ ok, transitions:[{id,title,from,to}], at }` |
| POST | `BASE/api/reset` | `{ confirm:"RESET" }` | `{ ok }`（危险操作，仪表盘要二次确认） |

### 4.1 memory 对象
`{ id, title, content, tags:[], layer, strength, clicks, createdAt, updatedAt, lastReadAt, history:[{at,from,to,reason}], contentTokens }`
id 形如 `m_<base36 时间戳>_<4位随机>`。
新建记忆一律写入 `createdAt`/`updatedAt`（ISO）；老库缺字段时在加载时从 `history` 首条 / `updatedAt` / id 里的 base36 时间戳补齐，保证排序与显示不出现空值。

### 4.2 stats 对象（仪表盘头部用）
`{ total, byLayer:{hot,recall,archive,cold}, totalClicks, avgStrength, lastDecayAt, nextDecayAt, dedupeSaved, tokens:{titleTokens, fullTokens, savedTokens, savedPct} }`
`savedPct = savedTokens/fullTokens`（fullTokens 是全部正文 token 和，titleTokens 是全员标题 token 和）。

## 5. 交付物分工（Lead 已定，勿越界写别人的文件）
- Lead：`lib/store.js`（纯引擎）、`lib/index.js`（cordis 插件：工具注册 + HTTP 路由 + 定时衰减 + 提示注入）、`lib/standalone.mjs`、`test/*`、`package.json`、`cordis.patch.yml`、`scripts/install.mjs`、`README.md`
- 你（dashboard-dev）：**只写** `lib/dashboard.html`（单文件，无 CDN、无构建、无外部依赖，纯 HTML+CSS+JS）

## 6. dashboard.html 硬要求
1. `<script>window.__FM_BASE__ = '__BASE__';</script>` 必须原样出现（服务器会替换 `__BASE__`；standalone 时替换成空串）。所有请求走 `fetch(window.__FM_BASE__ + '/api/...')`。
2. 中文界面，深浅色自适应（`prefers-color-scheme`），不引外部字体/图标/CDN。
3. 顶部：标题 + 统计（总数、各层数量、总点击、节省 token 百分比、上次/下次衰减）。
4. 主体：四个层通道（hot/recall/archive/cold）竖排或横排卡片区，每张卡显示：标题、标签、层、strength 进度条、点击次数、"距上次回忆 x 天"、正文前 120 字折叠。卡片操作按钮：回忆(读全文并强化)、编辑、换层、下沉、复活、硬删除(二次确认)。
5. 记忆索引视图：一键"AI 现在能看到什么"→ 调 `/api/index`，展示标题清单与 token 成本，说明**只有标题默认可见**。
6. 控制面板：`decayFactor`、`decayIntervalHours`、四个阈值（hot/recall/archive 最低 strength）、`hotBudgetTokens`、`dedupeWindowMinutes`、`recallBoost`、`createStrength`、`reviveStrength`；改完"保存"→ `/api/config`。另有"立即跑一轮衰减"按钮→ `/api/decay`，把 transitions 用列表展示。
7. 审计日志面板：最近 80 条，带时间与类型色块。
8. 新建记忆表单（标题/正文/标签）。
9. 搜索框：前端过滤（标题/标签/正文）。
10. 所有失败要显示错误 toast，不要静默。
11. 只写这一个文件，不要动其他文件；不要写目录外的文件。写完在你回复里给出行数与自查结论。

## 7. 已验证的 DSH 事实（别浪费时间再查）
- cordis service：`webServer`（`ctx.webServer.register({ kind:'exact'|'prefix', path, handler:(req,res)=>{} })` 返回 disposer）
- 工具：`ctx.tools.register(plainObject)`，形状 `{name, description, parameters:{...}, output:{schema, render}, execute(args, exec), presentCall?}`
