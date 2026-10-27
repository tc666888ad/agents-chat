# 接口协商室 技术方案与开发计划

日期：2026-10-23
依据：`2026-10-22-api-negotiation-room-design.md`（v4）、`2026-10-22-api-negotiation-room-protocol.md`（v3.2）、`2026-10-22-api-negotiation-room-review-round4.md`
定位：产品设计已收敛，本文只回答"怎么implement"，不再讨论产品取舍。

## 1. 判断

协议已经细到"照着写"的程度：16 个错误码、7 条待办规则、2 套状态机、一串"拒绝清单"。所以技术方案的价值不在再做抽象设计，而在**把协议精确映射成四个东西**：一张状态迁移表、一组纯函数、一份表结构、一个统一的广播扇出。

三条原则：

1. **协议即规格**：每个错误码、每条待办规则都要在代码里有唯一落点，并被 `protocol §13` 的对照表覆盖。禁止"顺手实现"表外的行为。
2. **纯函数优先**：状态迁移、待办推导、hint 查表、conventions 对比、diff 全部写成无副作用的纯函数，输入是房间快照，输出是状态 + 副作用描述。副作用（写消息、广播、webhook）由编排层统一执行。这是 P0-4 那类"状态和确认不一致"问题唯一能靠测试拦住的做法。
3. **只做 MVP0**：单进程、单 SQLite、无队列中间件、无 ORM、无微服务。容量已知（同时在线房间数十个），别为不存在的规模付代价。

## 2. 技术选型

| 层 | 选型 | 理由 | 不选什么 |
|---|---|---|---|
| 运行时 | Node 26 + TypeScript 5.x（strict）+ pnpm，ESM | 本机已装 Node 26 / pnpm 12；MCP 官方 SDK 的 TS 生态最完整 | 不用 Bun（MCP SDK 兼容性未知）、不用 Deno |
| HTTP | Fastify 5 | 内置 schema 校验、日志、`reply.raw` 可直接写 SSE；插件生态够用但不需要 | 不引 Nest（为重 MVP0 引入 DI 和装饰器） |
| MCP | `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`，**无状态模式**（`sessionIdGenerator: undefined`） | 接力模式每轮可能全新会话，无状态最贴合；会话状态全在 SQLite | 不用 stdio（要跨机器）、不用 SSE 旧传输（已被 Streamable HTTP 取代） |
| 存储 | SQLite（`better-sqlite3`，同步 API）+ WAL | 同步 API 天然串行，正好满足"单一写队列"；单文件挂 volume 即可备份 | 不上 Postgres（试点期无并发写压力）、不引 Prisma/Drizzle（迁移成本 > 收益） |
| 校验 | `zod`（工具参数）+ `@stoplight/spectral-core` + `spectral:oas` 规则集 + ajv（OpenAPI 3.1 meta） | Spectral 是协议里点名的校验器；zod 的错误可直接映射 `VALIDATION_FAILED` | 不用 swagger-parser 全家桶（它自带一套与 spectral 重叠的校验） |
| 契约 diff | 自研 JSON Pointer diff（约 150 行） | 只需要 pointer 级别的增删改，开源库普遍冗余 | 不引 `json-diff`（输出格式不合适） |
| breaking change | `oasdiff` 二进制，仅重开房间时调用 | 协议点名；低频调用，子进程足够 | 不引 npm 包装（版本漂移） |
| 前端 | Vite + React 19 + 手写 CSS（不引 UI 库） | 只有 3 个页面、5 种控件，组件库反而拖慢 | 不用 Next.js/SSR（不需要 SEO）、不用 shadcn（引入 tailwind 全套构建链） |
| 测试 | vitest + `fast-check`（属性测试）+ MCP SDK Client 做端到端 | 状态机和游标最适合属性测试 | 不做 Playwright（网页冒烟用脚本 + 手测） |
| 部署 | 多阶段 Dockerfile（node:22-slim + oasdiff 二进制） | 单镜像，本机/局域网/服务器同一份 | 不上 K8s |

## 3. 代码结构

```
src/
  domain/                    # 纯函数，无 IO，全部可单测
    room-state.ts            # 状态迁移表 + applyEvent(room, event) -> {room, effects}
    todos.ts                 # deriveTodos(state, viewerRole) -> Todo[]
    hint.ts                  # nextHint(todos, flags, status) -> string
    approve.ts               # approveChecks(state, version) -> error | ok
    conventions.ts           # compare(frontend, backend) -> Diff[]（含待核实）
    contract-diff.ts         # diffDocs(a, b) -> {added[], removed[], changed[]}
    issue-state.ts           # issue 状态机（4 态 + 权限矩阵）
    validate.ts              # OpenAPI 3.1 浅校验 + 大小限制
  db/
    schema.sql, migrate.ts, seed.ts
    repos/{rooms,messages,versions,issues,understandings,approvals,syncs,idempotency}.ts
  service/                   # 唯一服务层：MCP 与 HTTP 共用
    room-service.ts          # join/getMessages/takeover/游标
    issue-service.ts         # raise/reply/setStatus/decision
    contract-service.ts      # propose/getContract/approve/freeze
    understanding-service.ts # submit/compare/waiver
    auth-service.ts          # 凭据解析、权限判定
  mcp/
    server.ts                # 10 个工具注册，zod schema
    adapt.ts                 # 参数/返回/错误码的适配（统一 JSON 返回体）
  http/
    routes.ts                # protocol §12 的 15 个端点
    sse.ts                   # /events，事件 id = seq
    webhook.ts               # 出站推送（独立小队列）
  web/                       # Vite React：房间列表、房间页、冻结页
  infra/
    clock.ts, logger.ts(pino), channel.ts(挂起请求扇出), id.ts
tests/
  domain/*.test.ts           # 纯函数 + fast-check
  e2e/*.test.ts              # MCP Client 全流程
  conformance/*.test.ts      # protocol §13 对照表逐行
```

关键的边界：`mcp/` 和 `http/` **只做参数解析、鉴权、错误码映射**，任何业务判断（状态、权限、校验）都必须在 `service/` 里，这样"网页不得旁路"是结构性保证，不靠自觉。

## 4. 数据模型

```sql
users(id PK, name, is_admin, created_at)
credentials(id PK, user_id, kind /*agent|web*/, token_hash, created_at)

rooms(code TEXT PK, title, prd, team_conventions, op_scope,
      status /*created|understanding|negotiating|pending_freeze|frozen|abandoned|archived*/,
      next_seq INTEGER NOT NULL DEFAULT 1,   -- seq 分配器，与插入同事务
      reopen_reason, last_return_reason, created_at)

room_members(member_id PK, room_code, role, credential_id,
             read_cursor INTEGER DEFAULT 0, last_active_at, taken_over_at)

messages(id PK, room_code, seq, type, subtype, role, user_name, credential_type,
         client_json, ref_json, mention_json, reply_to, body, created_at,
         UNIQUE(room_code, seq))

understandings(room_code, role, revision, summary, conventions_json, questions_json,
               created_at, PK(room_code, role, revision))

contract_versions(room_code, version, doc_json, sha256, summary, base_version,
                  author_role, author_user, author_type, addresses_json, created_at,
                  PK(room_code, version))

issues(id PK, room_code, scope /*contract|conventions|general*/, version, pointer,
       severity, status /*open|needs_human|decided|closed*/, proposer_role, proposer_type,
       reply_count, last_speaker, decided_json, waiver_reason, waived_at_revisions, created_at)

issue_events(room_code, issue_id, kind, seq, meta_json)   -- 最后发言方、回复计数、waiver 溯源

approvals(room_code, role, version, member_id, created_at, PK(room_code, role))
contract_syncs(member_id, ref, synced_at, PK(member_id, ref))
idempotency_keys(member_id, tool, client_request_id, request_hash, response_json, created_at,
                 PK(member_id, tool, client_request_id))
webhook_targets(id PK, room_code NULL, url, kind)
```

不变量（直接写成测试）：

- `messages.seq` 在房间内连续无空洞；`rooms.next_seq` 的自增与插入在同一事务。
- 一个房间每个角色最多一个 `room_members` 行。
- `approvals[role]` 只存一行，值非空当且仅当该方对 `latest_version` 有效确认（P0-4 的判定式）。
- `contract_versions.sha256` 对规范化 JSON（键排序、无空白）计算。
- 同一 `(member, tool, client_request_id)` 只产生一次副作用。

## 5. 核心机制

### 5.1 状态迁移与副作用（P0-4 的落点）

```ts
type RoomEvent =
  | { t: 'join' }
  | { t: 'skip_understanding' }
  | { t: 'propose'; version: number }
  | { t: 'approve'; role: Role; version: number }
  | { t: 'decision_requires_revision'; issueId: string }
  | { t: 'human_return' } | { t: 'human_reopen' }
  | { t: 'freeze'; version: number } | { t: 'abandon' } | { t: 'archive' };
```

- 迁移表：`from → event → to` 一个 Record，不在代码里散落 if。
- `applyEvent` 返回 `{ room, effects }`，effects 只有五种：`systemMessage`、`clearApprovals`、`resetIssueToOpen`、`broadcast`、`webhook`。
- **确认失效写在迁移表里**，这是 P0-4 的修法落点：`propose`、`human_return`、`human_reopen`、`decision_requires_revision` 四个事件都产出 `clearApprovals`；`decision_requires_revision` 在 `pending_freeze` 时额外产出 `→ negotiating`。
- 冻结是独立入口，走 `approveChecks` + 额外两条（双方确认该版本、无待落实裁决），不信任调用方。

### 5.2 待办与提示

`deriveTodos(snapshot, viewer)` 是**纯函数**，输入一次性查出的房间快照（版本号、approvals、issues、成员游标、flags、contract_syncs），输出最多 7 条。三条属性测试：

1. 同一快照同一视角，输出逐字节相同（协议 §5.1 的承诺）。
2. 任意快照下 `todos.length ≤ 7`，`target` 恒为数组。
3. `hint(todos, …)` 与 `todos[0]` 的 kind 一一对应（协议 §5.2 的表可逐行断言）。

### 5.3 seq、挂起请求与广播

- 所有写操作在一个 `db.transaction()` 内：分配 seq → 插入消息/更新状态 → 提交。
- 提交后调用一次 `channel.fanout(room, messages)`：唤醒该房间所有挂起的 `get_messages`（在线模式）、所有 SSE 连接、webhook 队列。**三者共用同一份消息列表**，避免各自查询导致顺序不一致。
- `takeover` 事务内先唤醒旧成员的挂起请求（返回 `system/member_takeover`），再把成员行改绑，最后标记旧会话失效。
- 挂起请求用 `Map<memberId, waiter>`，`wait_seconds` 上限 30，超时返回空列表 + 当前 `my_todos`（让 agent 知道该收尾了）。

### 5.4 契约流水线

`propose_contract`：解析 JSON → 大小检查（1MB）→ OpenAPI 3.1 结构校验 → Spectral 规则 → 相对 `base_version` 的 pointer diff → 20 pointer 阈值（`NOTE_REQUIRED`）→ 落库 + 版本号 + 广播。

`approve_contract` 按 protocol §3.2 五条**顺序**执行，短路返回第一个错误。`freeze` 复用同一份 `approveChecks` 再加两条（P0-4）。

`get_contract(scope)`：先取整份文档，再按 path 裁剪并保留被引用的 `components`，另返回 `other_operations[]`。裁剪逻辑写纯函数，diff 和校验共用同一份文档表示。

### 5.5 幂等

`client_request_id` 与请求参数的 canonical hash 一起存。命中同 hash → 返回首次响应并标 `replayed`；hash 不同 → `IDEMPOTENCY_CONFLICT`。24 小时清理用定时任务，不做软删。

### 5.6 conventions 与 waiver

对比是纯函数：只比双方都非 null 的键，规范化后比较；输出三类：`diff`、`unverified`、`none`。差异与 issue 的同步放在 understanding 提交事务里（建/关 issue）。waiver 不是独立表，记在 issue 的关闭记录上，判定"是否仍有效"= 双方当前修订号对应值是否与 waiver 时一致。

## 6. MCP 接入的三个坑（第一天就要验）

1. **无状态 transport**：`StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`，每个请求独立建 transport。要确认 Codex / Claude Code 的配置能传 `Authorization` 头（各自配置项写法不同，先各跑通一次 `tools/list`）。
2. **错误返回的形态**：协议要求所有返回带 `room_status`/`error`，所以工具**不能**用 MCP 的 `isError: true`（客户端会当工具崩溃），一律返回 `content: [{type:'text', text: JSON.stringify(payload)}]`。
3. **工具 schema**：zod → JSON Schema 自动生成，但 `openapi`（整份契约）参数要标 `additionalProperties: true` 且不做深度校验（否则 1MB 文档会撑爆 schema 校验），深度校验在 service 里做。

## 7. 网页

三个页面：房间列表（状态 + 待办方 + 排序）、房间页（时间线 + 消息输入 + issue 列表 + 契约 diff + 理解对比）、冻结页（版本 + diff + waiver + 待核实 + 冻结按钮）。SSE 一条连接，事件 id 即 seq，断线用 `Last-Event-ID` 补发。所有写操作走 §12 端点，页面不缓存状态机判断（按钮置灰也以服务端返回为准）。

## 8. 里程碑

| 阶段 | 天 | 内容 | 验收锚点 |
|---|---|---|---|
| M0 地基 | 2 | pnpm/TS/Fastify/vitest、schema + migrate + seed、事务与 seq、错误码映射、MCP 空壳 + 2 个工具、两个客户端连上 `/mcp` | `curl /healthz`；`protocol §13` 前 5 行红灯（测试先写） |
| M1 协议闭环 | 4 | 10 个工具、状态迁移 + effects、待办/hint/approve/freeze、契约校验 + diff、issue 四态、理解与 conventions、幂等 | 用 CLI 脚本（人侧用 HTTP 模拟）跑通"建房→理解→v1→issue→确认→冻结"；§13 对照表全绿 |
| M2 人机通道 | 3 | §12 全部端点、三个页面、SSE、webhook | 阶段 A 第 2 条（含`DECISION_PENDING`、幂等两条、网页同码） |
| M3 韧性 | 2 | 断线重放、takeover、多会话、挂起请求、错误注入 | 阶段 A 第 3 条（随机断线 ≥3 次） |
| M4 部署 | 1.5 | Docker、局域网、Codex/Claude Code 配置样例、接入说明页 | 阶段 B 第 4 条（两台机器） |
| M5 实跑 | 与 Spike A 并行 | 阶段 A 第 1 条 | 记录耗时与触发次数基线 |

单人约 12 个工作日；两人并行（服务端 + 网页）约 7 天。**M0 结束前不碰网页**，因为协议风险全在服务端。

## 9. 测试策略

- 对照表驱动：`protocol §13` 每行一个 test 文件，测试名直接用断言原文，跑测试等于跑验收。
- 属性测试：状态迁移（任意事件序列都不会进入非法状态）、待办（快照→输出确定）、幂等（任意重复请求只产生一次副作用）、diff（`diff(a,b)` 的反向恢复）。
- 端到端：MCP SDK Client 走真实 HTTP，覆盖两个角色、两个会话、一次 takeover。
- 不写 UI 单测，网页只在 M2 末尾做一次脚本冒烟。

## 10. 风险与前置验证

| 风险 | 影响 | 处理 |
|---|---|---|
| 客户端不支持无状态 Streamable HTTP 或传不了自定义头 | 整个 MCP 通道不可用，是最高风险 | M0 第一天用 Codex + Claude Code 各跑一次 `tools/list`，跑不通就先换传输层方案 |
| Spectral 规则集对 OpenAPI 3.1 的兼容 | 合法契约被误判 `VALIDATION_FAILED` | M1 只用 `spectral:oas` 的推荐子集，每条规则写一条"应通过"的用例 |
| 长轮询挂起请求与写事务争用 | 在线模式抖动 | 挂起请求不持有事务；只有在写事务提交后才 fanout |
| 契约 20 ops 下全文提交的 token 成本 | 成本与"整份重写丢内容" | M1 末尾用真实契约测一次，决定 `patch` 是否提前进 MVP0 |
| sha256 规范化口径不一致 | 冻结校验对不上 | 规范化算法只做键排序，写成单元测试固化 |
| 提示注入（agent 有仓库写权限） | 安全事故 | 服务端无法强制，只能在 bootstrap 里显著下发 4.3 规则 + 接入前置条件，属产品边界 |

## 11. 不做什么

不引 ORM、不引 Redis/队列、不做 SSR、不拆微服务、不做插件体系、不做多租户、不在 MVP0 做契约编辑器、不在 MVP0 做跨房间对比。每一项都能在试点后加，现在加只会拖慢第一次真实闭环。

## 12. 第一天要做的五件事

1. 把 v4 修成 v5（P0-4 三处 + P1-9 三个端点），因为状态迁移表直接从它来。
2. `pnpm init` + tsconfig strict + vitest + Fastify 骨架 + `/healthz`。
3. `schema.sql` + migrate + seed（一个房间、两个凭据、两个成员）。
4. `/mcp` 空壳返回 `tools/list`，用 Codex 和 Claude Code 各连一次（验证 §6 的第 1 坑）。
5. 写 §13 对照表前 6 行的失败测试，让 M0 的验收从第一天就可见。

---

一句话：这份方案没有新架构，只有一个纪律——**协议里每一行规则都必须有唯一代码落点和一条测试**。真正会翻车的地方是 MCP 客户端兼容性（M0 就验）和确认有效性（P0-4，状态迁移表里写死）。
