# AI 圆桌外部 Agent 接入设计

日期：2026-10-26
状态：第一期已实现，验证记录见使用文档

## 背景

新版圆桌目前通过 `RoundtableService` 直接调用 OpenAI 兼容 API。该模式可以把需求文档和聊天记录放进提示词，但模型不能自动查看项目源码、`AGENTS.md`、`.agents`、`.codex` 等工程上下文，也不能主动使用 Codex/DSH 已有的工具能力。

项目中已有旧版 MCP 服务，但它绑定旧的 `RoomService`，没有接到新版圆桌。需要让新版圆桌支持两种 Agent：

- API Agent：由服务端直接调用模型 API，保持现有行为；
- MCP Agent：由 Codex、DSH 或其他 MCP 客户端主动连接房间，自己使用工程工具完成任务，再把结果发回圆桌。

## 目标

第一期完成以下闭环：

1. 已有 API Agent 不受影响；
2. Agent 可标记为 MCP 类型，并生成连接凭证；
3. MCP Agent 通过 `/rt-mcp` 连接新版圆桌；
4. Agent 可以进入指定房间，获取需求文档、补充说明、历史消息和待办；
5. 用户发起“出方案/审查/修订”后，MCP Agent 可以等待并领取任务；
6. MCP Agent 可以读取项目内的需求、源码和记忆文件；
7. MCP Agent 将结果回传后，网页实时显示并继续生成方案产物；
8. 页面显示 MCP Agent 是否已连接及连接说明。

## 不包含

- 后端自动启动 Codex 或 DSH 进程；
- 允许 Agent 默认修改源码；
- 自动让一个 Agent 触发另一个 Agent；
- 把整个仓库一次性复制到模型上下文；
- 暴露 API key、`.env` 或任意房间外文件。

## 方案

扩展现有 Agent 表，加入 `runtime` 字段：`api` 或 `mcp`。API Agent 仍走原来的 `LlmCaller`。MCP Agent 不进入 `run()` 的 API 调用分支，而是保留一条 `pending` 消息作为任务。MCP Agent 领取任务后用工具提交结果，服务端将该消息补全为 `done`，并按原有逻辑保存方案、审查和最终产物。

MCP 认证采用一次生成、只展示一次的 Bearer token。数据库只保存 token 的 SHA-256 哈希。token 绑定 Agent 身份，不绑定单一房间；进入房间时再校验该 Agent 是房间成员。用户可以在页面复制连接 URL 和 token。

新版 MCP 服务提供以下工具：

- `join_roundtable`：进入房间，返回房间上下文、文档、历史消息和下一步规则；
- `get_roundtable_tasks`：读取自己的待办，支持最多 30 秒等待；
- `read_roundtable_document`：按文档 ID 读取完整上传文本；
- `complete_roundtable_task`：完成指定待办并保存消息及产物；
- `send_roundtable_message`：发送普通讨论，不自动触发其他 Agent；
- `list_workspace_files`：列出项目工作区中的可读文件；
- `search_workspace`：在允许的工作区文件中搜索文本；
- `read_workspace_file`：读取一个允许的工作区文件。

工作区根目录为服务进程当前项目目录。文件访问默认只读，排除 `.git`、`node_modules`、`data`、`.env` 和密钥文件。允许 Agent 按需读取 `AGENTS.md`、`.agents/`、`.codex/`、`src/`、`tests/`、`docs/` 等目录。

## 数据变更

`rt_agents` 增加：

- `runtime TEXT NOT NULL DEFAULT 'api'`；
- `token_hash TEXT NOT NULL DEFAULT ''`；
- `token_hint TEXT NOT NULL DEFAULT ''`；
- `last_seen_at TEXT`。

对旧数据库通过 `ALTER TABLE` 补列。MCP Agent 创建或重新生成 token 时只返回明文 token，不写入数据库。

## 状态与交互

页面的 Agent 表单增加运行方式选择：

- API 模型：显示 API 地址、模型和 API Key；
- 外部 Agent：显示连接 URL、Bearer token、复制按钮和连接状态。

MCP Agent 在房间成员列表显示“等待连接”或“近期连接”。用户仍可从“出方案/找人审查/按意见修订”选择它。外部 Agent 未连接时，任务会保持等待状态并显示提示。

## 验收标准

- 旧的 roundtable 测试和 TypeScript 检查继续通过；
- 使用 MCP SDK Client 可以用外部 Agent token 进入一个新版房间；
- MCP 客户端可以读到上传文档和 `AGENTS.md`；
- 发起一个方案任务后，MCP 客户端能读到任务并提交结果；
- 提交结果后网页快照中的消息变为 `done`，方案文件出现在房间产物目录；
- 无效 token、非成员进入、越界文件、敏感文件读取都会被拒绝。
