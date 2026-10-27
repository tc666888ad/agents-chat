# AI 圆桌外部 Agent 接入实现计划

## 目标

在不改变 API Agent 行为的前提下，为新版 `RoundtableService` 增加 MCP Agent 运行时，支持房间任务、工作区只读工具和页面连接配置。

## 任务 1：扩展 Agent 与数据库模型

修改 `src/roundtable/db.ts`：给 `rt_agents` 增加 `runtime`、`token_hash`、`token_hint`、`last_seen_at`，并在 `migrateRt()` 中给旧库补列。扩展 `AgentRow`、`AgentView`、`AgentInput`，运行时只允许 `api|mcp`，默认 `api`。

修改 `src/roundtable/service.ts`：新增安全随机 token 生成、SHA-256 哈希、token 校验和重新生成方法；MCP Agent 创建时返回一次性 token，更新 Agent 时保留 token，增加 `regenerateAgentToken()`。AgentView 增加 runtime、connected、token_hint、connect_url 字段，但不返回 token_hash。

验收：旧 Agent 能正常读取；创建 API Agent 行为不变；创建 MCP Agent 得到 token；无效 runtime 被拒绝。

## 任务 2：接通 MCP Agent 任务模型

修改 `src/roundtable/service.ts`：在 `postMessage()` 和 `startFlow()` 中按 Agent runtime 分流。API Agent 继续调用 `run()`；MCP Agent 保留 pending 回复，不调用 LLM。新增 `authenticateExternalAgent()`、`joinExternalRoom()`、`externalTasks()`、`completeExternalTask()`、`externalSendMessage()` 和连接状态维护。

外部 Agent 完成任务时复用现有 `patch()` 与 `saveArtifact()`，确保方案、审查和修订产物与 API Agent 一致。`externalTasks()` 支持通过房间事件最多等待 30 秒。

验收：API Agent 的普通消息和 flow 行为不变；MCP Agent 不会被本地 LLM 调用；外部提交后消息变为 done，产物正确生成。

## 任务 3：实现新版 Roundtable MCP 服务

新增 `src/roundtable/mcp.ts`，使用 MCP SDK 创建无状态 Streamable HTTP server。通过 Bearer token 认证 Agent，并注册：

- `join_roundtable`
- `get_roundtable_tasks`
- `read_roundtable_document`
- `complete_roundtable_task`
- `send_roundtable_message`
- `list_workspace_files`
- `search_workspace`
- `read_workspace_file`

工作区文件工具只允许服务工作目录内的文本文件，排除 `.git`、`node_modules`、`data`、`.env`、密钥文件和符号链接逃逸。`search_workspace` 使用 Node 文件遍历并限制文件数、单文件大小和返回条数。

修改 `src/index.ts` 挂载 `/rt-mcp` 和 `/rt-mcp/`，与旧 `/mcp` 并存。

验收：MCP SDK Client 能初始化、调用 join/document/tasks/complete/send；越界路径和敏感文件请求失败。

## 任务 4：扩展 HTTP API 与网页

修改 `src/roundtable/http.ts`：支持 `runtime` 字段；增加 `POST /api/rt/agents/:id/token` 重新生成外部 Agent token；创建 MCP Agent 时返回一次性 token。

修改 `src/web/rt.js`、`src/web/rt.html`、`src/web/rt.css`：Agent 表单增加“API 模型 / 外部 Agent”切换；外部 Agent 显示连接 URL、token、复制按钮；成员列表显示连接状态；API Agent 的现有表单和 flow 选择保持可用。

验收：页面可以创建 MCP Agent、复制连接信息、放入房间；API Agent 页面回归通过。

## 任务 5：补测试与验证

扩展 `tests/roundtable.test.ts` 覆盖：MCP Agent 创建、token 认证、进入房间、工作区读取、任务等待和提交、产物生成、敏感文件拒绝。使用 MCP SDK Client 或直接调用服务层验证。

运行：

```bash
./node_modules/.bin/tsc --noEmit -p .
node --import tsx --test tests/roundtable.test.ts
npm test
```

## 实施顺序

按任务 1 → 2 → 3 → 4 → 5 顺序执行。每个任务完成后先做类型检查或对应测试，再继续下一任务。
