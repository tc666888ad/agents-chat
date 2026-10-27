# 新版 AI 圆桌：外部 Agent 接入

新版房间支持 API 模型和外部 MCP Agent 混用。API 模型由圆桌服务调用；外部 Agent 由其客户端运行，通过圆桌提供的工具获取需求、读取项目上下文，再回传方案或审查意见。

## 页面操作

1. 在「添加 agent」中选择「外部 Agent（MCP）」，填写名称和可选角色设定。
2. 保存时复制连接 URL 和一次性 Bearer token。服务仅保存 token 哈希，忘记明文后可以在编辑页或 Agent 库重新生成；旧 token 立即失效。
3. 将该 Agent 加入房间，上传需求文档或填写补充说明。
4. 点「出方案」，选择该 Agent。页面将显示「等待外部 Agent 处理」。
5. 在外部客户端发出下文示例指令，Agent 获取任务并提交后，网页显示完整结果及方案文件。
6. 点方案下的「找人审查」，选择另一个 Agent；随后可「按意见修订」，最后由用户点「定稿」。

API Agent 可编辑切换为 MCP；有未完成任务时，需要先停止任务再切换接入方式。

## 客户端连接

在支持 **Streamable HTTP** 和自定义认证头的 MCP 客户端中新增服务：

| 配置项 | 值 |
| --- | --- |
| 传输 | Streamable HTTP |
| URL | 页面显示的连接地址，例如 `http://localhost:3010/rt-mcp` |
| HTTP 请求头 | `Authorization: Bearer <一次性 token>` |

地址应以页面显示值为准。服务端可通过 `RT_MCP_URL` 指定对客户端展示的地址；该变量不更改监听地址或端口。客户端在其他机器时，localhost 需要换成可访问圆桌服务的地址。

新版 `/rt-mcp` 仅接受 Authorization 请求头中的 token。旧版 `/mcp` 的房间票和新版 Agent token 分开使用。Codex、DSH 等是否能直接使用此入口，取决于本机客户端是否支持上述传输和认证方式；本次已用 MCP SDK 客户端完成联调，尚未修改用户客户端配置。

配置完成后，在外部 Agent 中输入（替换房间号）：

> 通过圆桌 MCP 加入房间 RT-XXXX，获取分配给你的待办。先读项目 AGENTS.md 和相关记忆文件，再按需搜索、阅读已有代码，基于需求文档完成方案或审查。上下文有文档截断时读取完整文档。结论引用代码路径和行号，完成后调用 complete_roundtable_task 提交全文。仅使用圆桌的只读工作区工具，不修改代码。没有待办时结束本轮。

连接本身不会启动 Agent，也不会让它在后台永久轮询。用户在网页创建新任务后，需要在对应客户端要求 Agent 处理；明确要求等待时，可用最多 30 秒的长等待。

## 工具

| 工具 | 主要参数与用途 |
| --- | --- |
| `join_roundtable` | `room_code`，验证成员身份并获取房间快照与自己的待办 |
| `read_roundtable_document` | `room_code, doc_id`，获取上传文档的完整提取文本；文档 ID 来自房间快照 |
| `get_roundtable_tasks` | `room_code, wait_seconds?`，获取自己的 pending 任务和上下文；等待范围 0–30 秒 |
| `complete_roundtable_task` | `room_code, seq, body`，提交任务全文，完成消息并保存方案/审查产物 |
| `send_roundtable_message` | `room_code, text`，普通讨论，不完成任务，也不自动触发其他 Agent |
| `list_workspace_files` | `path?, limit?`，列出允许的项目文件，最多 500 个 |
| `search_workspace` | `query, path?, limit?`，搜索文本，最多 100 条，带文件路径和行号 |
| `read_workspace_file` | `path`，读取一个工作区相对路径的 UTF-8 文本文件，最大 512KB |

普通网页发言中的 @ 仍用于选择回答者；Agent 回传消息中的 @ 本期不会自动派发新任务。非成员房间、其他 Agent 的任务、取消或已完成的任务均不能提交。服务重启会保留 MCP 待办；移出成员会取消其未完成任务。

## 工作区与产物

第一期工作区固定为**启动圆桌服务时的项目目录**，允许读取根目录 `AGENTS.md` 以及 `src/`、`tests/`、`docs/`、`.agents/`、`.codex/`。记忆目录只开放 Markdown 和文本文件；不读取用户主目录下的全局记忆。排除 `.git`、`node_modules`、`data`、`.env`、认证/密钥文件及符号链接；工具没有写代码的能力。外部客户端自身已有工具的权限仍由客户端控制。

当前尚未提供“按房间选择另一个业务仓库”的配置。要分析其他业务项目，后续需要增加项目绑定及允许读取的目录设置。

需求原件与产物保存到 `data/roundtable/<房间号>/`，网页右侧「产物」可下载：

- `docs/`：上传需求原件；全文提取结果存入数据库，Agent 通过文档工具读取。
- `plan-v1.md`、`plan-v2.md`：初版和后续修订方案。
- `review-vN-<Agent名称>.md`：对方案版本 N 的审查。
- `final.md`：用户指定的最终方案。

页面「近期连接」仅表示最近 90 秒内有 MCP 通信，不代表 Agent 当前正在执行；页面每 30 秒刷新状态。外部任务提交后才变为完成。

## 验证记录

2026-10-27：TypeScript 类型检查、前端 JS 语法检查通过；全量自动测试 33/33 通过。覆盖旧 API 行为、旧库迁移、token 轮换、成员权限、长等待、停止/重试、重启恢复、文档全文、方案→审查→修订→定稿、文件写入失败后的重试及工作区读取限制。

真实 HTTP 联调使用临时监听端口、内存数据库和临时产物目录，验证 SDK 初始化、8 个工具发现、进入房间、读取需求及 AGENTS.md、领取任务、提交并生成文件。复验命令：

```bash
node --import tsx scripts/smoke-roundtable-mcp.ts
```

未自动启动真实 Codex/DSH 会话，未调用付费模型，未进行浏览器演示或视觉验收。
