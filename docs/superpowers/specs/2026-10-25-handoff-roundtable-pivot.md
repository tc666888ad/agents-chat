# 交接：接口协商室（2026-10-25 晚，方向调整中）

> 此文为历史记录，方向与实现已推进。最新状态及下一步请先读 [2026-10-27 交接](2026-10-27-handoff-local-agent-orchestration.md)。

> 这份文档写给“下一个接手的人或 agent”。它记录代码现状、刚刚发生的一次方向性讨论、以及未决的选择。读完就能接着干。更早的背景在设计文档里（见文末）。

## 1. 一句话背景

我们在做一个工具：**让两个 AI 在同一间房里对齐接口设计，人只做裁决**。
当前代码 0.2 已经能跑（两个 agent 拿 MCP 门票进房、提交"接口方案"、自动算字段级差异、人点确认）。
今晚用户提出要改方向：**砍掉命令行配置，把场景收敛成一个功能项——管理员建房、直接把 agent 加进来、群聊（发消息都回、@ 谁谁回）**。

## 2. 现在代码里有什么（0.2，可运行）

- 技术栈：Node 26 + TypeScript + Fastify 5 + 内置 `node:sqlite` + `@modelcontextprotocol/sdk`；网页是原生 HTML/JS，无构建。
- 启动：`pnpm dev`（或 `PORT=3000 LOG_LEVEL=warn ./node_modules/.bin/tsx src/index.ts`），库文件 `data/negotiation.db`。
- 关键文件：
  - `src/domain/room.ts`：角色/状态/待办/提示词规则
  - `src/domain/diff.ts`：JSON Pointer 差异
  - `src/domain/openapi.ts`：OpenAPI 校验
  - `src/service/room-service.ts`：唯一服务层（建房、入房、发消息、提交接口方案、确认、快照）
  - `src/mcp/server.ts`：5 个工具 `join_room / get_messages / send_message / submit_plan / get_plan`
  - `src/http/api.ts` + `src/http/static.ts`：REST + 网页托管
  - `src/web/`：首页（建房/房间列表）与房间页（对话 + 接口方案面板 + 确认面板）
  - `src/admin/cli.ts`、`scripts/demo.ts`、`scripts/seed-demo.ts`、`tests/`
- 现有流程：建房时选“谁做设计” → 设计方/复核方两个 agent 对话 → 拉前端进来 → 前端、后端各点一次「这版可以开发」。
- 状态：`tsc --noEmit` 通过，17 个测试全过；截图在 `docs/assets/`（`mvp-room.png`、`mvp-home.png`）。

## 3. 今晚发生了什么（重点）

用户原话（大意，按顺序）：

1. "有点麻烦了操作，我们尽量减少命令行的配置和操作。现在我们先把场景单一化，我们把需求一个一个拆解，以一个功能项为目标开发，不要全部开始做了。"
2. 第一个功能项：**管理员（就是我）创建房间 → 把自己本地的 agent 加进来**（想要"检索或添加本地 agent"的能力，也提了"能不能让对方输入 api"）→ **我发消息他们两个都回复，单独 @ 某个 agent 就只有它回复**。
3. 我给出的分析：
   - "检索本地 agent"走不通——Codex / DSH 没有让网页直接调用的接口；能拉进来的只有两种：服务端替你调模型 API（托管型），或它自己反连我们（门票 + MCP，就是现在这套）。
   - 建议改造成「AI 圆桌」：托管型 agent（填名称 + API 地址 + key + 模型，保存后可复用），管理员消息广播 / @ 精准回复；agent 之间不互相触发，避免无限接话。
   - 砍掉设计方/复核方、接口方案面板、确认流程，等圆桌跑通再一层层加回来。
4. 用户的疑问（原话）："填了api 你是准备直接调用api的接口去进行调用吗 这里会不会有功能不如codexagent这样的情况 这只是我的疑问点 并不是否认。"
5. 我的回答：直调 API 确实弱于 Codex——缺的是工具与工程上下文（读写仓库、跑测试、校验 OpenAPI、上下文压缩），不是模型本身。建议分工：
   - **托管型 agent**：零配置，负责出主意、挑逻辑漏洞、写草案；后续给它加服务端小工具（读 PRD、校验 OpenAPI、算版本差异）补短板。
   - **接入型 agent**（Codex/DSH 拿门票）：能读仓库、能跑验证，负责拍板。
   - 节奏：功能项 1 托管群聊 → 功能项 2 给托管 agent 加工具 → 功能项 3 接入型回归、同屋共存 → 再谈接口方案/确认/冻结。
6. 用户最后的决定（原话）："算了 先把这一段聊天记录到记忆文件 我后面再想想 你要保证你可以接上对话 别的agent也能看懂继续对话。"

**结论：方向尚未拍板。** 不要直接开始大改；先确认下面第 5 节的四个问题，或按第 6 节的功能项 1 做最小实现。

## 4. 已确认的技术事实（别再重新试错）

- DSH 实际运行的是 **desktop profile**：进程 cwd 是 `~/.dsh/profiles/desktop`。MCP 配置写在两个地方（都已加，防再次踩坑）：
  - `~/.dsh/profiles/desktop/cordis.patch.yml`
  - `~/.dsh/profiles/web/cordis.patch.yml`
  - 条目 `id: mcp-negotiation`，`serverName: negotiation`，`transport: streamable-http`，`url: http://192.168.1.230:3000/mcp`，`headers.Authorization: Bearer <票>`。
  - DSH 自带 `@deepseek-ai/dsh-mcp-client`（在 app 包内，profile 里不需要安装）；工具名形如 `mcp__negotiation__join_room`。
  - **重启 DSH 才能加载新配置；且重启会杀掉 3000 端口的 node 服务**（它是 DSH 的后台 job），需要手动重启。
- Codex 已配置：`~/.codex/config.toml` 有 `[mcp_servers.negotiation]`，URL 带 `?token=`（服务端支持 query 传票）。`codex mcp add` 只写配置，**要启动会话才会真正连接**。
- 局域网地址 `http://192.168.1.230:3000`；网页 `http://localhost:3000`。
- 现有房间与票（本地开发用）：
  - `ROOM-5D69`「试用：用户中心接口」：设计方 `nrt_mZ0FYxyi26DeB1vBU2LLwagQuxlTjcQ8`、复核方 `nrt_4V426lEXgjerTzbi9ZXwcjX3QS-pcNAf`、后端 `nrt_CS8mcSGYENKiE1dhXViIzUoA-rI2_0a6`
  - `ROOM-F444`「用户中心接口 v1」：种子房（7 条消息、2 次提交、前端已确认）
- DSH 的模型供应商配置在 `cordis.patch.yml` 的 `llm-pi-ai` 段（如 `hyperchain-fde`，baseURL `https://api.gaoxin.net.cn/v1`，key 走环境变量 `HYPERCHAIN_FDE_API_KEY`）。做托管 agent 时可直接复用，也可让用户填 DeepSeek 官方 key。

## 5. 未决问题（等用户拍板）

1. API key 是否接受**明文存本地 sqlite**（MVP 过渡，上服务器前必须改）？
2. 默认模型是否用 `deepseek-chat` + `https://api.deepseek.com`（表单可改）？
3. 每个房间最多几个 agent（我建议先 4 个）？
4. 是否接受“托管型先做、接入型第二步”的分工节奏？

## 6. 如果继续做：功能项 1（圆桌群聊 + 托管 agent）

最小闭环：**建房 → 加 agent（填 API）→ 群聊广播 / @ 指定回复**。零命令行。

改动清单（约半天量级）：

- **DB**：新增 `agents(room_code, name, base_url, model, api_key, created_at)`；消息表加 `agent_id`（或复用 `from_role='agent:'+id`）。
- **模型调用**：`src/llm/client.ts`，OpenAI 兼容 `POST {base_url}/chat/completions`，超时 60s，失败落一条系统消息（不阻塞其他 agent）。
- **编排**：`POST /api/rooms/:code/messages` 里解析 `@名字`——有 @ 只调被点名者，没有则并行调全部；agent 消息**不触发** agent；每次只带最近 30 条 + PRD。
- **页面**：建房表单加“添加 agent”区块（名称、API 地址、key、模型；保存到本地列表可复用）；房间页右侧换成“成员列表 + 添加/移除”，隐藏接口方案与确认面板。
- **砍掉/隐藏**：设计方/复核方角色、`submit_plan/get_plan` 的页面入口、确认面板。服务端代码可保留。
- **保留**：MCP 门票接入（将来功能项 3 用）。

## 7. 给接手 agent 的提醒

- 用户要**减少命令行**：任何“去终端跑一条”的方案都要先问。
- 用户偏好：**中文、先给结论、少铺垫**；不确定时给默认值让他点头，而不是抛开放问题。
- 设计文档在 `docs/superpowers/specs/`：`2026-10-22-api-negotiation-room-design.md`（v4 全量）、`2026-10-23-api-negotiation-room-min-design.md`（0.2，含 v3 变更段）。**当前方向是 0.3 圆桌，别被 v4 的完整性带偏**。
- 验证：`pnpm test`（17 个）、`pnpm demo`（内存跑全流程）、curl 快照：
  `curl -s http://localhost:3000/api/rooms/ROOM-5D69/snapshot`
