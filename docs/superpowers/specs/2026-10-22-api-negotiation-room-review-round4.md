# 接口协商室 第四轮评审（核对 design v4 / protocol v3.2）

日期：2026-10-23
评审对象：`2026-10-22-api-negotiation-room-design.md`（v4，497 行）、`2026-10-22-api-negotiation-room-protocol.md`（v3.2，369 行）
范围：按设计文档第 5 行的约定，只核对第三轮 P0/P1 的修改，不做全文评审。

## 结论

第三轮的 3 个 P0、5 个 P1、12 个 P2 **逐条核对通过**，修改干净，没有为了闭合意见引入新的自相矛盾；附录 C 里自己找出的 4 处（三处"不限版本、不限 scope"口径不一、issue 状态机"对方回复"笔误、system issue 关闭必填理由、编号冲突）都是真问题，其中"对方回复即升级"那条是第三轮我漏掉的。

但**还有 1 个 P0 必须修**：第三轮的 P0-1 只堵了正面，`approvals` 的失效条件仍然只有"提交新版本"一条，于是退回、重开、需修改裁决之后旧的确认还在，冻结或重新进入待冻结可以绕过它。另有 1 个 P1：协议新增的 §12 缺建房和 issue 关闭/重开三个端点，阶段 A 第 1 条现在走不到。

修完这两处就可以开工，不必再评审。

## 一、逐条核对

| 评审项 | v4 落地位置 | 核对 |
|---|---|---|
| P0-1 裁决不阻塞确认 | protocol §3.2 第 3 条（`:84`）、§5.1 第 4 条（`:124`）、§7 例外（`:229`）、`DECISION_PENDING`（`:297`） | 通过。"已落实"的定义（裁决之后有版本在 `addresses` 里列出该 issue）比第三轮建议的口径更简单，且不依赖版本提交时间，更好 |
| P0-2 跳过后无 `propose_v1` | design §5（`:156`、`:168`）、protocol §5.1（`:125`、`:130`）、`INVALID_STATE`（`:307`） | 通过。方案 A 把状态机里"跳过即迁移"那条删掉后，`INVALID_STATE` 的原措辞也自动成立了 |
| P0-3 conventions 假阻塞 / waiver | protocol §8.2（`:273-279`）、设计 §4 第 3 步（`:98`）、冻结页（`:290`） | 通过。只比双方都非 `null` 的键、`null` 转"待核实"、waiver 绑定双方修订号并在值变时失效，闭环完整 |
| P1-4 `base_version` / v1 误触 `NOTE_REQUIRED` | protocol §3（`:64`）、§3.2 第 5 条（`:86`）、`STALE_BASE_VERSION`（`:294`） | 通过。`null` / `0` / 最新三个取值与错误码一一对应 |
| P1-5 全文提交 | design §12 前提（`:332`）、protocol §3（`:64`）、design §6.3（`:235`） | 通过。20 个 operation 作为前提 + 软提示 + 先取全文的硬要求，`patch` 正确标为 MVP1（协议头 `:5` 的 MVP1 标注现在真的有对应条目了） |
| P1-6 网页接口 | protocol §12（`:322-342`） | 通过（但有缺口，见 P1-9）。"共用同一服务层、不得旁路"写成了硬约束，正是需要的那句 |
| P1-7 表结构 | design §10（`:300-303`） | 通过。`contract_syncs` 建实表，waiver 挂在 issue 关闭记录上（`waiver_reason`、`waived_at_revisions`），约定差异改为派生 + 缓存，省一张表是对的 |
| P1-8 `my_todos` 粒度 / #2 | protocol §5.1（`:117`、`:122`）、`reply_to`（`:62`、`:67`、`:170`、`:179`） | 通过。"每 kind 最多一条 + `target` 数组"把 7 条规则的输出形状定死了，可断言；`reply_to` 是判定"人的 @ 是否已回复"的正确依据 |
| P2 十二条 | 见附录 C（`:477-488`） | 11 条采纳、1 条不采纳（多房间 webhook 合并），不采纳的理由（试点期房间少）成立 |

三处新增的一致性修正（`:494` 的"不限版本、不限 scope"统一）值得单独说一句：这条规则在 v3 里三个地方写法不同，实现时最可能按最宽松的那处写，然后在验收时对不上。现在统一了，且 §13 对照表把它变成了一行断言。

## 二、P0-4 确认（`approvals`）的失效条件不完整，冻结仍可被绕过

- 位置：protocol §4（`:96` "提交新版本后两方都置 `null`"）、§12 冻结端点（`:335` 只校验版本号）、design §5（`:166` "提交新版本后，之前所有确认自动失效"）、design §4 第 7 步（`:103`）。
- 问题：`approvals` 是"某方确认过的版本号"，但**唯一会把它清空的事件是"提交新版本"**。其余三种会让旧确认失效的事件都没有清：人退回（`pending_freeze → negotiating`）、人重开（`frozen → negotiating`）、人在 `pending_freeze` 下 `requires_revision` 裁决。三个逃生口：
  1. **退回无效**：退回后房间回 `negotiating`，但 `approvals` 仍是 `{frontend: v4, backend: v4}`，`latest_version` 也是 4，"双方确认最新版本"立刻重新成立 → 房间自动又进 `pending_freeze`，退回等于没发生。
  2. **重开跳过确认**：`frozen` 重开回 `negotiating`，如果冻结的版本号就是最新版本，双方旧确认仍在 → 直接回 `pending_freeze`，没有任何一方重新看过契约。
  3. **裁决被冻结绕过**：人（或另一个人）在 `pending_freeze` 对某个 issue 下 `requires_revision: true` 的裁决。房间状态不回落，`approvals` 不清空，而 `:335` 的冻结只校验"版本是最新版本" → 可以冻结一个"人自己刚要求修改"的版本。P0-1 新增的 `DECISION_PENDING` 只在 `approve_contract` 里检查，冻结路径上没有。
- 为什么是 P0：P0-1 的修复把"确认"和"冻结"之间那段缝补上了，但缝的另一头（确认有效期）没定义；而且第 3 条逃生口正好是"人自己刚裁决"，看起来最像正常操作，测试也最不容易覆盖。
- 修法（三处一起改，缺一条都能绕过）：
  1. 把 `approvals` 的失效条件写成四条事件：提交新版本、人退回、人重开、`requires_revision` 的裁决。统一判定式："某方确认有效 ⟺ `approvals[role] == latest_version`"。
  2. `requires_revision` 裁决若发生在 `pending_freeze`，房间回 `negotiating` 并广播 `room_status_changed`；若发生在其他状态则不变（`negotiating` 已经是目标状态）。
  3. 冻结端点除版本号外再校验两条：双方 `approvals` 都等于该版本、无待落实裁决（`DECISION_PENDING`）。前者建议用 `INVALID_STATE`，后者直接用 `DECISION_PENDING`，这样 §13 对照表只需加一行。

## 三、P1-9 §12 缺建房端点，以及人关闭 / 重开 issue 的端点

- 位置：design §4 第 1 步（`:93` "负责人在网页创建房间…可选导入已有 Swagger 作为 v0 基线"）、design §7 权限（`:261`）、protocol §7 权限表（`:234`、`:238` 人可关闭 / 重新打开）、protocol §12（`:326-340`）。
- 缺口：
  1. **没有建房端点**。`POST /api/rooms` 不存在，但阶段 A 第 1 条从"建房"开始；也没有导入 v0 Swagger 的入口，而 protocol `:64` 的 `base_version: 0` 依赖它。
  2. **没有人关闭 issue 的端点**。§7 表允许人关闭（system issue 还要必填理由、conventions issue 记 waiver），§12 只有 `decision`。
  3. **没有人重新打开 issue 的端点**。§7 允许人把 `closed` 和 `decided` 的 issue 重开，且必填原因。
- 影响：这三项都是文档承诺过的能力，没有端点就等于网页上点不到；实现阶段会被临时发明出来，然后和 MCP 路径的校验漂移——正是 §12 硬约束想防的事。
- 补法：`POST /api/rooms`（标题、PRD、团队约定文本、范围说明、可选 v0 Swagger）、`POST /api/rooms/:code/issues/:id/close`（必填 `text`）、`POST /api/rooms/:code/issues/:id/reopen`（必填原因）；并明确导入 v0 会生成 `version: 0` 的版本记录、`get_contract(version: 0)` 可取。

## 四、P2（十二条，实现期处理即可）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1 | protocol `:84` | "已落实"只认后端自报的 `addresses`，空报即可解阻塞（`DECISION_PENDING` 消失） | 加触及性检查：issue 有 `pointer` 时，要求本版 diff 的 pointer 集合包含该 pointer 或其前缀。只查"碰没碰"，不判对错，和 `:207`"由人在冻结页核对"不冲突 |
| 2 | protocol §13（`:346-369`） | 对照表覆盖 14 个错误码，缺 `ROLE_TAKEN`、`ROLE_REQUIRED` | 补两行，表才配得上"共 16 个错误码" |
| 3 | protocol `:68` / `:306` | 关闭 system issue 缺 `text` 返回 `FORBIDDEN` | 这是缺参数，不是越权，应返回 `VALIDATION_FAILED`；`FORBIDDEN` 留给"agent 重开 decided issue"这类 |
| 4 | design `:321` | 范围里仍写"issue（open / closed / needs_human 三种状态）" | v3.2 是四态（含 `decided`），改成四态 |
| 5 | protocol `:96` | `flags` 枚举里没有 `version_limit`，但 §6 `:209` 有这个 subtype、4.2 说"到上限标记需人裁决" | 要么加 `version_limit` flag，要么写明映射到 `awaiting_human` |
| 6 | design §6.2（`:215-227`） | 提示表与 protocol §5.2 不一致：多一行"前端，有未审查的新版本"，且 `m_{id}` 与 `seq {seq}` 两种写法 | design 已声明以 protocol 为准，建议把这张表标成"示例，正式措辞见 protocol §5.2"，删掉多余那行 |
| 7 | protocol §12 | 没有历史消息端点（左侧时间线要翻页，SSE 只负责增量） | 加 `GET /api/rooms/:code/messages?before_seq=&limit=` |
| 8 | protocol `:26` | 旧成员挂起请求"立即返回"，但没说返回的是正常结构还是错误结构 | 建议正常返回 + 带 `system/member_takeover` 消息 + `next_hint` 提示重新入场，旧成员不必先撞一次 `ROLE_TAKEN` |
| 9 | protocol `:211` | 裁决被落实时发 `issue_status_changed`，但 issue 状态没变（仍是 `decided`） | 新增 subtype `decision_fulfilled`，别复用状态变化事件 |
| 10 | protocol `:88` | 幂等返回排在校验之后：已确认的版本在别人提了新 blocking issue 后重试，会返回 `BLOCKING_ISSUES_OPEN` 而不是幂等成功 | 把"本方已确认同一版本"提到第 1 条之后（版本仍最新时直接返回当前状态） |
| 11 | protocol `:64`、design `:474` | 病句"operation 超过 20 个时返回中带软提示"；附录 C 说"11 个端点 + SSE"，§12 实际 12 个 + SSE | 各改一处 |
| 12 | protocol `:96`、`:168` | `understanding_skipped` 在提交 v1 后是否清除未说明，按现状会永久留在 `flags` 里 | 提交 v1 时清掉，或写明"保留作为审计记录" |

## 五、下一步

1. 修 P0-4（`approvals` 四条失效事件 + 裁决回落状态 + 冻结双校验）和 P1-9（三个端点）。两处都不改接口形状，半天内可完成。
2. 修完把 §13 对照表加三行（`ROLE_TAKEN`、`ROLE_REQUIRED`、冻结时未双确认/待落实裁决），然后按表写状态机单测骨架；P0-4 的三个逃生口各写一条用例——它们是这轮唯一需要新写的测试。
3. Spike A 与单测骨架并行，做完再进实现。不再开第五轮。

一句话：v4 的修改质量比第三轮的评审意见更细（附录 C 自纠的四条我认可），剩下的问题只有一类——**"确认"的有效期没有跟着状态迁移一起定义**。这是个实现时最容易按直觉写错、验收时最容易漏测的点，值得单独一条用例。
