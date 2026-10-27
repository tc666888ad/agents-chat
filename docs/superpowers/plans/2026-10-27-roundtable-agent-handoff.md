# 圆桌 Agent 自动交接 Implementation Plan

> **For agentic workers:** 使用 executing-plans 逐项执行；用户已于 2026-10-27 确认设计，本会话继续实施。

**Goal:** 单次用户任务串联方案、审查、修订，@我 时暂停，最多六次回复。

**Architecture:** 新增 collaboration.ts，负责严格控制区解析、SQLite 协作状态、交接验证和持久化；service.ts 统一集成 local/api/MCP 的成功、失败、停止和重试。网页提供开关、状态和继续/停止入口。

**Tech Stack:** TypeScript、node:sqlite、Fastify、原生 JS、node:test。

## Global Constraints

- 不联网、不演示、不启动真实模型测试；只跑注入执行器和 localhost 检查。
- 原数据库、房间和 Agent 配置保留，旧房间开关默认关闭。
- 保持只读，审查通过不代表用户批准开发。
- 同房间单协作链串行，最多六次回复；引用/代码/流式输出不触发交接。
- 本目录无 Git 仓库，不创建提交或工作树。

### Task 1: 协议与数据

Files: src/roundtable/collaboration.ts（新建）、src/roundtable/db.ts、tests/roundtable-collaboration.test.ts（新建）。
- [x] 写 parseControl 测试：仅尾部专用控制块有效；重复、嵌套引用、JSON 非法均拒绝；正文无控制区不猜测。
- [x] 跑失败测试后实现解析器，控制协议包含协作 ID、步骤 seq，阻止复制历史控制区。
- [x] 增量增加 rt_collaborations、rt_collaboration_steps、房间 auto_collaborate；旧库迁移可重复。

### Task 2: 服务调度

Files: src/roundtable/collaboration.ts、src/roundtable/service.ts、tests/roundtable-collaboration.test.ts。
- [x] 注入假 LLM/local runner 验证方案→审查→修订→ready、ask_human、六次限额；先失败再实现。
- [x] 采用 Store 持久化与服务层协调：start/context/finishReply/settle/pause/resume/retry；以 current_seq、执行 token 与 processed 防重和迟到结果。
- [x] postMessage 精确单人 @ 且开关开启时创建协作；startFlow 同样可进入协作。广播保持原行为。
- [x] 下游 stage/ref_seq/version 复用产物链，ready 校验最新方案及审查角色。
- [x] API/local 完成时先去控制区、保存正文与产物，释放运行槽后再推进；MCP 提交同协议。

### Task 3: 中断与人介入

Files: 同 Task 2，以及 src/roundtable/http.ts。
- [x] 验证错误、取消、重启、移出成员、重复事件、旧步骤重试均不能误派发。
- [x] 增加协作停止和继续 API；继续需非空用户决定和目标成员，沿用同一协作 ID，总额度不自动重置。
- [x] 等待用户、上限、失败、通过状态写入系统 @我 消息；更换目录或成员配置暂停。

### Task 4: 网页

Files: src/web/rt.html、src/web/rt.js、src/web/rt.css、tests/roundtable-ui.test.ts。
- [x] 增加「自动协作」开关、状态栏、计数、外部待办说明、停止/继续按钮。
- [x] 继续弹层收集用户决定和目标成员，防切房间误提交；@我 消息突出显示。
- [x] UI VM 测试验证开关提交、继续/停止路径和房间切换保护。

### Task 5: 验证与交付

Files: docs/superpowers/specs/2026-10-27-handoff-local-agent-orchestration.md、设计文档。
- [x] node --check src/web/rt.js；tsc --noEmit -p .；npm test。
- [x] 对照已确认设计复检；修正缺漏后只复跑相关检查。
- [x] 确认无运行中用户任务后，沿用 /private/tmp/rt-smoke-v04.db 重启 3010，localhost HTTP 验证，不调用模型。
- [x] 更新交接与验收结果，告知用户开关和 @我 暂停行为。

## 验收记录

- 2026-10-27：`node --check src/web/rt.js`、`tsc --noEmit -p .`、`npm test` 均通过，73/73（54 项原测试 + 17 项协作测试 + 2 项 UI 测试）。
- 覆盖 local/api/MCP 完成路径、长轮询身份时序、四步版本链、ready/ask_human、限额、停止、重启、迟到、重试、重复完成、引用与非法控制区、配置/成员/文档变动、HTTP、UI 切房保护。
- 为落实“不能靠另一个 @ 自动重置额度”，补充「结束本轮」显式操作；上限后先结束，才允许新任务。首次启动与重试发布 room 事件，立即同步状态与次数。
- 原库备份：`/private/tmp/rt-smoke-v04-before-collaboration.db`。继续使用 `/private/tmp/rt-smoke-v04.db`，3010 服务 PID 67831（本轮启动时），执行会话 81602。
- RT-ACF0 页面和只读快照接口 HTTP 200；Agent 配置、房间数、消息数比对一致，RT-3E34 seq=9 的普通 MCP 待办保留。未触发任何真实模型任务。
