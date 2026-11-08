# dsh-fish-memory

一个给 [DSH](https://github.com/deepseek-ai) 用的**分层记忆插件**：hot / recall / archive / cold 四层，回忆即强化，周期衰减，墓碑复活，标题先行，外加一个内嵌的可视化控制台。

零依赖、单插件、数据全在本地磁盘。**开箱是空库**：仓库不含任何记忆数据，装完第一次打开就是 0 条。

> 分层记忆的思路参考了公开的分层记忆方案笔记（作者自己的设计记录，不随仓库分发）。实现上采纳了「分层可见性、回忆即强化、周期衰减、标题先行全文按需、记忆索引」，推翻了「不可逆销毁」和「硬性分层丢信息」两条。

## 1. 它到底做什么

| 要点 | 落点 |
| --- | --- |
| 层级 = 可见性梯度 | 四层 hot / recall / archive / cold；只有 hot 层的**标题**进系统提示，正文必须显式取 |
| 回忆即强化 | `memory_read(id)` 一次调用 = 一次点击：clicks+1、strength+1、刷新回 hot |
| 周期衰减 | 默认每 24h 一轮：strength *= 0.98，按阈值重排层级；也可 `memory_decay` 手动跑 |
| 遗忘是下沉不是销毁 | cold 是最冷层；硬删除只进墓碑（tombstones.json），随时 `memory_revive` |
| 落地形态：分层 context | 系统提示里只放 hot 层标题，正文按需 `memory_read` |
| 索引工具 | `memory_index` 一次看全四层所有标题与分数 |

设计上刻意避开的四个坑：

1. **不可逆销毁 → 墓碑**：硬删除写墓碑（正文保留），可复活；`audit.jsonl` 记全量流水。
2. **次数被污染 → 会话内去重**：同 sessionId、`dedupeWindowMinutes`（默认 30）内的重复读只返回内容，不计分。
3. **分层退化成 LRU → hot 硬预算**：hot 标题 token 超过 `hotBudgetTokens`（默认 1200）时，低分记忆强制沉到 recall。
4. **优先级刷新太粗暴 → 连续分数**：层级由连续的 strength 派生，不是「点一次就顶到第一层」的硬开关。

## 2. 分数与层级

- 新记忆 `createStrength = 2` → 落 **recall**
- 读一次 `+1` → `3` → **hot**（>=3）
- 不读：每天 ×0.98 → `2.94` 回 recall（>=1.5）→ 几天后 archive（>=0.5）→ 最终 cold（<0.5）
- token 估算 `ceil(字符数 / 2)`，偏保守（宁可高估省下来的量）

阈值、衰减因子、间隔、hot 预算、去重窗口、boost 全部能在控制台里调，也可以 `memory_config` 改。

衰减是**按每条自己的时长**结算的：每条记忆有自己的锚点 `decayAnchorAt`，录入时设一次，每次计分的回忆重新计时（背一次 = 重新开始忘）。所以老条目掉得快、刚录入的几乎不掉；`decayTickMinutes`（默认 60）只是「多久扫一次账」，扫得勤不会多扣。

## 3. 装上

需要 Node.js >= 20。

```bash
git clone https://github.com/liuxiaopi666/dsh-fish-memory.git
cd dsh-fish-memory
node scripts/install.mjs desktop
```

`install.mjs` 做三件事，幂等、可回滚：往 profile 的 `package.json` 里加 `link:<本仓库路径>` 依赖、把包名追加进 `dsh.profile.bundles`（改动前备份成 `package.json.bak-fish-memory-<时间戳>`）、建 `node_modules` 链接并 `mkdir ~/.dsh/fish-memory`。

装完重启 DSH，访问 `http://127.0.0.1:<DSH端口>/fish-memory`。

不想装进 DSH 也能单独跑控制台（读同一份数据）：

```bash
node lib/standalone.mjs        # 默认 8788
node lib/standalone.mjs 9000   # 换端口
# 可选的第二个参数指定数据目录，便于试用时隔离
node lib/standalone.mjs 8788 ./tmp-store
```

卸载：`node scripts/uninstall.mjs desktop`

## 4. 工具（模型侧，共 18 个）

`memory_index` `memory_list` `memory_timeline` `memory_read` `memory_search` `memory_tags`
`memory_write` `memory_update` `memory_move` `memory_retitle`
`memory_forget` `memory_revive` `memory_stats` `memory_decay` `memory_config`
`memory_ingest` `memory_live_append` `memory_live_read`

共同约定：**默认只有标题可见**。每个工具的描述里都重复这条，避免模型把索引当全文用。

`memory_ingest` 把 DSH 的历史会话录进记忆库（每条取第一条真正的用户发言，按内容哈希去重，重复执行不会重复录）。`memory_live_append` / `memory_live_read` 是一条跨端小事件流，给「同一份记忆在几个场合共用」的场景用，只写一句话摘要。

## 5. HTTP API（控制台与外部共用）

前缀 `/fish-memory`（standalone 模式下是根路径）：

- `GET /api/state` `GET /api/index?sort=` `GET /api/audit?limit=80` `GET /api/tombstones` `GET /api/timeline`
- `POST /api/read|create|update|move|forget|revive|config|decay|reset|retitle`

统一返回 `{ ok: true, ... }` / `{ ok: false, error }`。未知接口 404，坏请求体 400。

## 6. 内嵌到界面（浏览器半）

`lib/client.js` 走 DSH 的客户端插件协议（`window.__ModuleLoader__.load({ id, factory })`，导出 `apply(ctx)`），注册：

- `ctx.slots.inject("sidebar.panellist", …)` → 左侧栏一行「记忆」（`order: 5`）；
- `ctx.slots.inject("main", …)` → `{ name: "main", key: "fish-memory" }`，点开在主工作区显示正文（key 必须等于那行的 id）；
- 正文是宿主半的 `/fish-memory` 页面（iframe，同源同数据），浏览器半只做壳；
- 宿主没有 slots 服务时两处注册都包 try/catch，不抛异常。

改完 `lib/client.js` 刷新页面即可；有客户端清单缓存就重启一次桌面端。

## 7. 可选：命令行外挂到任意外部程序

`scripts/memory-cli.mjs` 让别的程序（自动化脚本、另一个 agent、定时任务）共用同一份记忆库：

```bash
node scripts/memory-cli.mjs context --domain bili --text "<这一轮要处理的文本>"  # 命中关键词才输出，否则空串
node scripts/memory-cli.mjs search "部署" --mode tag
node scripts/memory-cli.mjs read m_xxxx       # 取正文（读一次 = 强化一次）
node scripts/memory-cli.mjs write --title "偏好：报告要短" --content "..." --tags "偏好,格式"
```

- 触发规则在 `~/.dsh/fish-memory/triggers.json`（首次运行自动生成），按域分组，每组一组关键词 + 一个标签集合；命中后先按标签检索、再按关键词查标题，最多注入 `maxReadsPerCall` 条、总长 `maxChars`。
- **命中才花钱**：没命中关键词时 CLI 什么都不输出，调用方拼空串，对 prompt 零影响。
- 接法：在你的程序里拼 prompt 前跑一次 `context`，把输出接上即可；失败一律当空串处理，别阻塞主流程。

## 8. 收录门槛

会话录入不是「有内容就收」，要过三道闸：

1. **重要性**（`importanceScore`）：寒暄/确认（继续、好的、谢谢…）、纯链接、裸工具名、报错粘贴、长度 < 12 一律 0 分；带诉求、路径/仓库、偏好声明、项目名词才加分，阈值 3 分。
2. **长期价值**（`isDurable`）：`长期项 ×2 − 一次性项 ≥ 2` 才留。
   - 留：偏好与规矩、身份设定、配置与凭证、结论/原理/机制、项目位置与运维、长期目标
   - 丢：一次性动作请求（帮我做个…、查一下有没有…、升级到最新版、删掉多余的…）、修完即忘的故障报告
3. **标题与标签**：标题 `类别：核心`（机制/架构/取舍/运维/设定/偏好/需求/问题/配置/目标），≤ 26 字，剥离 @、路径、链接、口头填充词；标签只给主题词（最多 3 个），不打日期、路径、工作区。

存量库可以用 `scripts/prune-ephemeral.mjs` 按同一把尺子清理（只动 `origin=session` 的会话记忆，种子与人工写的记忆不碰）。改标题用 `memory_retitle` 或 `POST /api/retitle`。

## 9. 数据在哪、怎么清空

全部在 `~/.dsh/fish-memory/`：

```
store.json        记忆本体
tombstones.json   墓碑（硬删除的正文留在这里，可复活）
audit.jsonl       全量审计流水
live.jsonl        跨端事件流
state.json        计数器等运行状态
triggers.json     CLI 触发规则（首次运行自动生成）
plugin.log        插件日志
```

**清空 = 删掉这个目录**，下次启动自动重建空库。想备份就整目录拷走。

`scripts/seed.mjs` 是一个**手动**的演示脚本，会写入 6 条示例记忆给你看效果，**默认不执行**，装完不会自动跑。

## 10. 验收

```bash
npm test
```

等价于显式列出 7 个测试文件：

```bash
node --test test/store.test.mjs test/http.test.mjs test/plugin.test.mjs \
           test/client.test.mjs test/live.test.mjs test/cli.test.mjs test/ingest.test.mjs
```

**注意**：`node --test test/` 这种目录形式在 Node 24 上会把目录当成一个用例，报一条莫名的 `test failed`，请用上面的显式文件列表（`npm test` 已经是这个写法）。

覆盖：分层与阈值、回忆强化、会话去重、衰减跨层与按条计时、hot 预算强制下沉、墓碑复活、持久化、多进程写不覆盖、参数护栏、索引不含正文、检索先标签后标题、HTTP 全端点闭环、`__BASE__` 替换、装配后 18 工具 + 路由 + 注入、客户端插件协议形状。

## 11. 已知限制

- 系统提示注入的 API 形状随 DSH 版本变动，插件按 5 种候选形状依次尝试并写 `plugin.log`；全失败时降级为「靠 `memory_index` 取标题」，不影响其他能力。
- token 估算是字符数近似，不是真 tokenizer，用于比较「标题 vs 全文」的量级，不用于精确计费。
- 没有语义检索（embedding）。当前是「分层 + 关键词」，够用，也确实比向量库省事。

## 12. License

MIT。见 [LICENSE](./LICENSE)。
