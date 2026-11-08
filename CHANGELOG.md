# Changelog

## 1.0.0

首个公开版本。

- 四层分层记忆（hot / recall / archive / cold），层级由连续 strength 派生
- 回忆即强化：一次 `memory_read` = 一次点击；同会话窗口内去重
- 按条计时的指数衰减，跨层下沉并记录 transition
- hot 层硬 token 预算，超预算时低分记忆强制下沉
- 遗忘是下沉不是销毁，硬删除进墓碑，可 `memory_revive`
- 标题先行的 context 注入：系统提示里只有 hot 层标题
- 内嵌可视化控制台（单文件 HTML，零外部依赖）
- 18 个模型侧工具 + `/fish-memory` HTTP API
- `scripts/memory-cli.mjs`：给任意外部程序用的命令行外挂，命中关键词才输出
- 会话录入的三道收录闸（重要性 / 长期价值 / 标题标签规范）
- 默认空库，仓库不含任何记忆数据
