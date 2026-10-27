# 接口协商室 第三轮评审（design v3 / protocol v3.1）

日期：2026-10-22
评审对象：`2026-10-22-api-negotiation-room-design.md`（v3，449 行）、`2026-10-22-api-negotiation-room-protocol.md`（v3.1，295 行）

## 结论

**可以通过评审，进入实现，但要先修 3 处规则互相矛盾的地方。** 这三处都长在"服务端强制规则"这条主线上，不是措辞问题：修不好，"双方确认才能冻结、只有人能冻结"这个卖点在具体场景里会漏。

- 第二轮三个 P0（成员与游标、人工裁决闭环、工具数量）实质关闭，且做法比建议的好：bootstrap / resume 分离、`rules_digest` 每轮重申、takeover 用 `expected_member_id` 做 CAS、隐式 ack。N4 / N6 / N7 / N8 也都落实了。
- 本轮新增问题全部是"协议自己和自己打架"：3 个 P0、5 个 P1、12 个 P2。没有新的设计层分歧，也没有需要推翻的选型。
- 建议这一轮之后**停止评审**。剩下的风险不在设计，在实现是否忠实于协议；协议已经细到可以照着写测试，第四轮评审的边际收益低于直接写状态机单测 + Spike A。

## 一、必须修（P0）

### P0-1 `requires_revision` 的裁决不阻塞确认，可能冻结出"没实现人裁决"的契约

- 位置：protocol §3.2 第 2 条（`2026-10-22-api-negotiation-room-protocol.md:81`）、§7（`:209`）、§5.1 第 4 条（`:117`）；design §5（`:165-166`）。
- 冲突：`:81` 只把 `open` 和 `needs_human` 算作阻塞，`:209` 又明确"`decided` 等同于关闭"。于是人裁决"要改成聚合接口"（`requires_revision: true`）之后，issue 变 `decided` → 不阻塞 → 前端对旧版本 `approve` 合法 → 后端不修改也能双确认 → 人看到的是一个没有落实裁决的版本，而且状态机一路放行到 `pending_freeze`。`:117` 的 `revise_per_decision` 只是待办提示，不是强制。
- 为什么是 P0：这是"服务端强制规则"直接失效的一处，而且失效方式是静默的——网页不会报错，只会冻结错版本。验收清单（design §13 阶段 A 第 2 条）也没有这一项，实现完照样能"验收通过"。
- 修法（最小改动）：
  1. §3.2 增加一条（放在第 2 条之后）：存在 `decided` 且 `requires_revision: true`、`decided_by.at` 晚于该版本提交时间、且该 issue 不在本版 `addresses` 中的，拒绝并返回新错误码 `DECISION_PENDING`（附 issue id 列表）。
  2. §10 加 `DECISION_PENDING`；§4 的 `flags` 加 `pending_decision_revision`；design §13 阶段 A 第 2 条拒绝清单加一条。
  3. `next_hint` 在 `approve_or_raise` 之前先给 `revise_per_decision`（`:117` 待办已有，只需要保证 hint 优先级与待办一致）。

### P0-2 人授权跳过理解后，后端拿不到 `propose_v1` 待办，链路卡住

- 位置：design §5 状态机（`design:160` "understanding ──人授权跳过──> negotiating"）与 protocol §5.1 第 5 条（`:118` "房间处于 `understanding`…且还没有 v1 → `propose_v1`"）。
- 冲突：人一授权跳过，房间立刻进 `negotiating`（无任何版本）。此时 `:118` 要求状态是 `understanding` → 不成立；`:119` 第 6 条要求"最新版本" → 不成立；第 1–4 条也不成立 → `my_todos` 为空 → 接力模式下 agent 按 `rules_digest` 第 5 条结束本轮。后端永远不会起草 v1，除非人额外发一句"你去写 v1"，而这正好是产品想省掉的环节。
- 附带：§10 的 `INVALID_STATE` 示例（`:284`）写的是"理解阶段未跳过就提交 v1"，字面意思与状态机"提交 v1 就是 understanding→negotiating 的迁移条件"相反。两处一起改。
- 修法（推荐 A，一次修掉两处）：
  - A. 跳过不改状态，只置 flag。删掉 `design:160` 那条迁移，`understanding_skipped` 作为 room flag + system 消息存在；房间仍是 `understanding`，直到 v1 提交才进 `negotiating`。`:118` 的"或人已授权跳过"就自然成立，`design:167`"人可以在理解阶段直接允许后端起草 v1"也一致。
  - B. 若坚持跳过即迁移，则 `:118` 条件改为"（`understanding`，或 `negotiating` 且房间还没有任何版本）"。
  - 同时把 `:284` 改成"双方未提交理解且人未授权跳过时提交 v1"。

### P0-3 conventions 的"保证存在一条未关闭 issue"与"agent 可以关闭"直接冲突，且 `null` 会批量制造假阻塞

- 位置：protocol §8.1（`:247`）、§8.2（`:254`、`:256`、`:257`）、§7 权限表（`:215`）。
- 冲突一（机制）：`:256` 声明"每个有差异的键，服务端保证存在一条未关闭的 issue"，`:257` 又说"误报的代价是一次 `set_issue_status(closed, text)`"，`:215` 允许提出方 agent 关闭。三条同时成立的话，关掉之后服务端下次修订又要重建 → 关闭是无效操作，`set_issue_status` 在 conventions 上变成假动作。
- 冲突二（误报量）：`:247` 定义 `null` 为"本仓库没有该约定或不涉及"，`254` 却把"一方 `null` 另一方有值"也算差异。8 个固定键里一方没填几个是常态，结果是开局就生成成批 `severity: blocking` 的 system issue，而 `:81` 让 blocking 阻塞 `approve_contract` → 阶段 A 的"一次真实验收"很可能卡在人挨个关 issue 上。
- 修法：
  1. 对比只在双方都非 `null` 的键上做；`null` 视为不涉及，不建 issue。
  2. `null` 对 `有值` 单独产出"待核实"条目（网页并排 + `room_status.flags`），不参与阻断。用户自己的口径"文本对比会有误报，代价可接受"仍然成立，只是不再用 blocking 表达误报。
  3. 关闭 conventions issue 必须带 `text`，记为 **waiver（接受差异）**，落库后服务端不再重建该 key 的 issue，冻结页展示 waiver 列表。`:256` 的不变式改为"有差异且无 waiver 时存在一条未关闭 issue"。

## 二、实现前必须定（P1）

### P1-4 v1 的 `base_version` 没有定义，且 v1 会误触 `NOTE_REQUIRED`

- 位置：protocol §3（`:62`）、§3.2 第 4 条（`:83`）、§10（`:272`）；design §4 第 3 步（`design:98`）、第 1 步的"可选导入 Swagger 作为 v0 基线"（`design:92`）。
- 空缺：第一版没有"最新版本"可比，`base_version` 传什么？（`null`？`0`？导入 v0 时传 `0`？）`STALE_BASE_VERSION` 在 v1 上按什么判定？
- 顺带一个必然踩到的坑：`:83` 用"该版本相对 `base_version` 的 diff 超过 20 个 pointer"判 `NOTE_REQUIRED`。v1 的 diff 是整份文档，必然超过 20 → **每次起草 v1 都被要求填 `note`**，且提示文案无法自洽。
- 修法：`base_version` 允许 `null`（无基线）或 `0`（基于导入的 v0）；v1 免除 `:83` 的检查；`:62` 补一句"`base_version` 为 `null` 时表示初版"。

### P1-5 `propose_contract` 要全文，但 `join_room` 刻意不给全文，主循环价格和风险都不对

- 位置：protocol §2.3（`:42` "不返回契约全文"）、§3（`:62` `openapi` 是整份文档）；design §15（`design:373`）把"上下文消耗"列为待验证。
- 后果：后端每轮改一个字段，都必须先 `get_contract` 拉全文（几十到上百 KB）再整份重发。两个代价：token 成本翻倍；模型整份重写时丢 path/丢 description 是常见失败，而服务端只能 diff 出"你删了三个接口"，agent 未必意识到这是事故。
- 修法（MVP0 折中，不改接口）：
  1. §1 限制与 design §12 范围写明"单房间契约规模上限，建议 ≤20 个 operation"，作为 MVP0 的隐含前提。
  2. 接入说明加一句硬要求：提交前必须 `get_contract` 全文，禁止凭记忆整份重写。
  3. MVP1 路线记一笔：`propose_contract` 加 `patch: [{op, path, value}]`，服务端在 `base_version` 上应用后落库。

### P1-6 网页侧接口完全不在协议里，规则有被实现两遍的风险

- 位置：protocol §1 只定义 `/mcp`；design §8 才顺带提到 `GET /api/rooms/:code/contracts/:ref`（`design:269`）；design §9 要求网页能发言、裁决、退回、冻结、重开、放弃，`design:161` 还有 admin 归档。
- 风险：这些操作全部带状态机校验（版本号匹配、必填原因、只有人能冻结）。如果网页另写一套 REST 逻辑，就和 MCP 路径的规则漂移；而验收阶段 A 第 2 条只验 MCP 路径，网页那条漏了也发现不了。
- 修法：协议加一节"网页侧接口"：只列 10 个左右的端点（登录、房间列表、房间详情、发言、裁决、退回、冻结、重开、放弃、归档、按 ref 取契约），加一句硬约束——**所有校验与 MCP 工具共用同一服务层，网页不得旁路**；并说明网页凭据不对应 `room_members`（人不是 member，没有 `read_cursor`，靠 SSE 的 `seq`/`Last-Event-ID`）。最后这点顺带修掉 P2-11。

### P1-7 表结构缺两块状态，`sync_frozen_contract` 和 waiver 落不了地

- 位置：design §10 表清单（`design:292-293`）、protocol §5.1 第 7 条（`:120`）、§8.2。
- 空缺：
  - `:120` 依赖"本方还没有用 `get_contract(ref)` 获取当前冻结引用"，这是**每成员 × 每冻结引用**的状态，现有表里没有位置（`room_members` 只有 `read_cursor`）。
  - §8.2 的"保证存在一条"、waiver、待核实条目都需要持久化，否则每次都要从 understandings 历史重算，而历史上"已关闭"的事件已经被 messages 盖过去了。
- 修法：加 `contract_syncs(member_id, ref, synced_at)`、`convention_diffs(room, key, state: diff|waiver|unverified, ref)`；或明确写"从 messages + understandings 派生并缓存，缓存表如下"。

### P1-8 `my_todos` 的粒度没定，#2 的判定条件太弱

- 位置：protocol §5.1（`:110`、`:115`、`:119`）、§5.2（`:133`）。
- 问题一（粒度）：`:110` 定每条格式为 `{kind, target, text}`，但 `:133` 的文案是"有 {k} 个 issue 等你处理，第一个是 {issue_id}"——多条 issue 到底是聚合一条还是逐条。这直接决定 agent 循环的处理轮次，也决定 `has_more` 之类的设计。
- 问题二（#2 太弱）：`:115` 用"本方在该消息之后没有任何写操作"判断是否需要回复人。agent 只要 `raise_issue` 或 `send_message` 写点别的，`reply_human` 待办就消失，人被晾着。
- 修法：#3 / #4 明确"聚合为一条，`target` 为 issue_id 数组，`text` 给数量 + 第一个 id"；#2 改为按消息关联判定——`send_message` / `reply_issue` 增加 `reply_to`（seq），#2 条件改为"存在 @本方 且未被 `reply_to` 指向的人工消息"。

## 三、P2（可在实现期处理，建议一并改）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1 | protocol `:284` | `INVALID_STATE` 示例措辞与状态机相反 | 随 P0-2 一起改 |
| 2 | protocol `:290` | webhook 触发条件里没有"有人 @human" | 加一条触发；否则 agent 请示人时人不被通知，N5 只修了一半 |
| 3 | protocol §3.2 | 对同一版本重复 `approve_contract` 行为未定义 | 幂等返回当前状态（`request.replayed` 不适用，明说即可） |
| 4 | protocol §10 | 终态房间（`abandoned`/`archived`）的工具行为未定义 | 读工具正常、写工具 `INVALID_STATE` |
| 5 | protocol `:91` | `approvals: { frontend, backend }` 取值类型未定 | 建议 `{frontend: version \| null, backend: version \| null}` |
| 6 | protocol `:87` | "包括错误返回都包含统一字段"，但房间解析失败时给不出 `room_status` | 加限定"房间可解析时" |
| 7 | protocol §2.3 `:39` | takeover 后只看最近 10 条，旧成员未确认的 backlog 丢失；旧成员挂起的在线请求行为未定义 | takeover 事务里让挂起请求立即返回 `system/member_takeover`；bootstrap 最近消息给 50 条 |
| 8 | protocol §2.1 `:19` + design §3 | `role` 只有 frontend/backend，design 却把人列为第三种角色 | design 改成"human 是凭据类型/旁观者，不是 member role"（由 P1-6 一并说清） |
| 9 | protocol §2.2 `:31` | `cursor=X` 即确认 ≤X，但 `next_cursor` 若被先存后处理，会把"拿到未处理"算作已处理 | 接入说明写死"处理完再存游标"，或明确 `next_cursor` 只用于展示不推进 ack |
| 10 | protocol `:5` | 头部承诺"标注 MVP1 的条目暂不实现"，正文零处 MVP1 标注（已 grep 确认） | 删这句，或真给条目打标 |
| 11 | protocol §3.1 `:73` | 无任何版本时 `scope: contract` 的默认 `version` 行为未定 | 返回 `INVALID_STATE`，要求显式 `scope: general` |
| 12 | protocol §11 `:291` | 1 分钟合并只按"房间 + 接收对象"，同一方多房间连发仍会刷屏 | 可接受；若要压，按"接收人 + 5 分钟"再合并一层 |

## 四、一条建设性建议：加"规则 → 测试"对照表

协议现在有 15 个错误码（加上 P0-1 建议的 `DECISION_PENDING` 是 16 个）、4 个 issue 状态、6 个房间状态、7 条待办规则，全部可以用单元测试断言（`my_todos` 那节已经声明"同一状态下输出完全相同"）。建议在协议末尾加一张表：`规则编号 | 断言 | 对应错误码 | 对应验收条`。理由有两条：

1. P0-1 这种漏洞的根因不是想错了，是**规则没有测试锚点**——验收清单只覆盖了"拒绝非法操作"的正面清单，没覆盖"该拒绝却没拒绝"。有了对照表，`DECISION_PENDING` 一写就有用例。
2. 阶段 A 第 2 条现在是一条长清单，实现者容易挑着做。对照表能让阶段 A 第 2 条那 12 条拒绝变成可数、可勾选的。

顺带建议阶段 A 第 2 条补两条：重复 `client_request_id` 返回首次结果、同 id 不同参数返回 `IDEMPOTENCY_CONFLICT`（现在幂等规则进了 MVP0，但验收清单里没有）。

## 五、下一步

1. 修 P0-1 / P0-2 / P0-3（三处都是改规则表述 + 加一个错误码 + 改两条待办，半天内可完成）。
2. 定 P1-4 / P1-5 的取值和上限（影响接口签名，必须先定）。
3. 写 P1-6 的网页端点清单（哪怕 10 行）。
4. 按第四节加对照表，先写状态机单测骨架，**同时**跑 Spike A。实现和验证并行，不必等 Spike A 结论。
5. 不再开第四轮。若 P0 修完还想再确认一次，只看这三处的 diff。

一句话风险提示：文档已经细到可以照着写，但正因为细，"实现走样"比"设计错误"更可能成为下一个事故来源——P0-1 那种漏洞在评审里只值一段话，在线上是一次错误的冻结。
