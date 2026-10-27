# 交接：AI 圆桌接入本地 Agent 与自动执行（2026-10-27）

> 新对话先读本文件顶部「新对话接续摘要」。按从上到下、最新记录优先理解；后续旧章节仅作历史背景。V1 自动协作、内网网页及成员电脑连接器均已实现并部署，数据与配置一致性验证通过。下一步由成员在各自电脑配对并授权项目。

## 新对话接续摘要（2026-10-27，本轮最终交接）

### 用户最新诉求与本次停点

用户要求服务器网页通过本地连接器选择成员电脑上的项目与 Codex/DSH；保留数据库和配置，不损坏服务器、不做演示、不联网查资料。本轮已实现服务端设备配对与派发、成员电脑 CLI、网页绑定和下载包；设计见 [连接器设计](2026-10-27-roundtable-local-connector-design.md)。

**连接器增量已部署到原服务器。** 用户提供认证后已使用 `hyperchain`（非 root）登录，完成停止本项目、备份、构建、移除旧容器（不加 -v）及启动。容器 healthy；VPN 网页/房间/设备 API/下载均 200，无 token 请求 401。所有原表记录及附件哈希、`.env` 不变，原 MCP 待办保留。运行源码为 `e2d8183`（功能提交 `eb7eb07`）；接续先检查实际 Git 状态/HEAD。

### 已完成清单

- [x] 网页管理房间、需求资料、Agent 库与消息；支持 API、外部 MCP、本机 CLI 三种执行方式。
- [x] 本机 Codex/DSH 子进程执行与结果回传；支持独立模型 URL / Key，保留现有配置，不改全局认证。
- [x] 修正 DSH 凭据传递与 SOCKS 代理兼容；Codex 诊断保留脱敏原始来源，不再把任意 401 都归因于模型 Key。
- [x] Agent 自动交接：方案→审查→修订；通过或需人决定时 @我 停止/暂停。开关默认关闭，最多 6 次回复，同房间串行，保持只读，不自动开发。
- [x] 取消、重启、迟到/重复回传、配置变动、次数上限等保护；外部 MCP 仍需客户端主动领取。
- [x] 独立 Docker 内网部署；迁移一致性数据库快照、需求原件和方案；本机原库保留。
- [x] Git 初始化，源码、测试和部署文件已提交并推送到 GitHub `main`，基线提交 `ccf1328a369875b84a06cab7fcdef11647181437`。
- [x] 原 V1 部署验证：73/73 测试；服务器容器 healthy，VPN 访问首页/原房间/只读接口均 HTTP 200，SQLite 完整性与配置/附件哈希通过。这些是首次部署记录，本次增量部署验证见下。
- [x] 连接器配对码十分钟一次有效、设备 token 哈希存储、工作区白名单、Codex/DSH 检测、任务租约/取消/迟到拦截，绑定后不回退服务器 CLI；延续六次协作上限。
- [x] 网页提供电脑/授权项目选择、配对/吊销及固定白名单下载包。成员电脑 Node >=22，无需安装 npm 依赖，安装/配对命令见部署说明。
- [x] 本轮全量 93/93 测试、TypeScript noEmit、前端语法检查、构建及独立下载包 CLI 帮助命令通过；离线验证覆盖完整 HTTP→假 CLI→产物链路及取消、撤权、ready/ask_human 停止，不调用真实模型。独立审查发现的 token 回传（含未完整输出的流式前缀）、原目录保留、失效设备阻断普通编辑均已补回归修复。
- [x] 本机原库只读一致性快照上验证增量迁移：6 Agent、4 房间、41 消息、1 需求、2 产物及原 Agent 配置哈希不变，integrity_check=ok；原库未改动。
- [x] 服务器增量升级验证：5 房间、6 Agent、41 消息、1 需求、2 方案，所有原表内容与配置/附件哈希不变，容器 healthy，网页和下载可访问；未运行真实模型。

### 接续所需地址、数据与运维信息

| 项目 | 当前记录 |
| --- | --- |
| 工作区 | `/Users/tang/Movies/project/front-bakcend-chat` |
| 仓库 | `https://github.com/tc666888ad/agents-chat.git`，`main`；接续先检查实际 `git status` / HEAD |
| 服务器网页 | `http://172.22.86.174:3010/`，当前房间 `/r/RT-ACF0`，需公司 VPN |
| SSH | `hyperchain@172.22.86.174:22`，已用 hyperchain 交互密码认证成功；不使用 root，口令不写文件/Git，不打印 |
| 服务器应用 | `/home/hyperchain/agents-chat`，独立容器 `agents-chat`，镜像 `agents-chat:v1` |
| 当前镜像 ID | `sha256:498934acbfd3e2bfef3e29190786b31900b597ebb72bae4d80acaff70b9fc2f7` |
| 服务器数据库 | `/home/hyperchain/agents-chat/data/negotiation.db`，包含凭据，权限 600；数据目录 700 |
| 服务器房间文件 | `/home/hyperchain/agents-chat/data/roundtable/` |
| 服务器备份 | 本次 `backups/connector-e2d8183/`（含原库、旧源码、镜像 ID 与校验）；首次 `backups/initial-20261027.db` 等仍保留，均相对应用目录 |
| 本机网页 | `http://localhost:3010/r/RT-ACF0`；上次启动 PID 67831，接续需重新核验进程，不能按旧 PID 直接操作 |
| 本机数据库 | `/private/tmp/rt-smoke-v04.db`；备份 `/private/tmp/rt-smoke-v04-before-collaboration.db` |
| 本机房间文件 | 工作区 `data/roundtable/`，与数据库文件目录不同，备份两者缺一不可 |
| 本机启动命令 | `PORT=3010 NEGOTIATION_DB=/private/tmp/rt-smoke-v04.db node --import tsx src/index.ts` |
| 部署时迁移基线 | 6 Agent、4 房间、41 消息、1 需求原件、2 方案；这是部署时快照，不是接续时实时计数 |

服务器为 CentOS 7，宿主机无 Node，Docker 26.1.4 / Compose 1.29.2；应用镜像 Node 24.22.1。Docker 服务启用，容器 `unless-stopped`，普通用户、只读根文件系统、独立数据挂载、资源上限和日志轮转。未修改防火墙/Nginx/系统包，未重启 Docker 或已有业务容器。运维细节见 [部署说明](../../deployment.md)。

宿主机的旧版 Compose 重建容器会遇到 `KeyError: ContainerConfig`；更新时先停止**本项目**，备份数据，再 `docker-compose rm -f`（不加 `-v`）后 `up -d`，不要升级全机组件或操作其他容器来规避。镜像已处理源码 600 权限导致非 root 用户无法读取的问题。

**本机与服务器自快照后是独立数据库，不会自动双向同步**。不要把其中一边的后续修改直接覆盖到另一边，也不要对运行中的 WAL 数据库只复制 `.db` 文件。工具 session ID 不保证跨对话可用，以实际进程、监听和数据库为准。

### 接续待办（实现与部署已完成）

源码包、原库备份、旧源码及验证记录保存在服务器 `backups/connector-e2d8183/`；源码包 SHA256：`9b1b219d847dcfd24cbe3206a8fbefe80ac68a395980173cf257fc1b991fa493`。该包无数据库、`.env`、node_modules 或连接器凭据。

1. [x] 连接器实现与 93/93 离线回归通过，独立复检三项修复闭环，已提交推送 main。
2. [x] 原服务器增量升级完成，备份及旧镜像保留，`.env`、原库和附件未覆盖。
3. [x] healthy、网页/原房间/下载/设备接口、原表数据及配置/附件哈希均核验通过。
4. [ ] 成员各自在网页下载连接器、配对、授权项目、启动；网页刷新后选择电脑和项目并保存。尚未配对真实成员电脑或触发模型任务，实际联调按用户授权进行。

成员电脑认证留在本机，服务端任务仅传模型名，不下发已有 URL/Key。旧同机执行模式继续兼容，切换电脑绑定时保留原房间目录；默认 Mac 路径在服务器仍无效。仅支持连接器主动调用本机 CLI，不承诺唤醒桌面插件会话。运行步骤见部署说明。

另外待处理：

- [ ] Linux 上 Word/RTF 等解析依赖原 macOS `textutil`，现在需用户转 Markdown/TXT；可独立补跨平台文档解析。
- [ ] Codex 真实模型连接稳定性仍需实际诊断确认；前面修复的是配置传递与错误解释，不能宣称已彻底解决认证问题。
- [ ] VS Code Codex 插件接入能力尚未确认。连接器复用 Codex CLI 不等于能主动调度插件内现有会话；现有 MCP 需客户端主动领取，不许承诺能直接唤醒插件。
- [ ] 本机数据库仍在临时目录，长期持久化位置可后续安排；不要接续时直接换成默认空库。

浏览器的「上传需求文档」本身能选客户端单个文件；「让 Agent 读整个本机项目目录」才是本地连接器要解决的问题，两者不要混为一谈。

### 新对话工作约束

- 用中文、简洁回复，先给结论；遵守工作区 `AGENTS.md`，不联网搜资料。不做演示，不自行调用真实模型验证。
- 用户已授权指定服务器的部署和指定仓库的提交推送，必要 SSH/Git 操作与「联网查资料」不是一回事；沙箱网络限制按工具流程提升，不把 `Operation not permitted` 当 VPN 不通。
- 保留真实数据库、模型 URL/Key/模型名和工作区配置。凭据不进日志、文档、镜像或 Git；`.env`、`data/`、数据库、`.pnpm-store/`、无关 `.graylog-setup/` 均已忽略。
- 用户强调不要损坏服务器：只操作 `/home/hyperchain/agents-chat` 和本项目容器，禁止广泛 kill、prune、清库或重置已有业务。
- 新对话先读本摘要及部署说明，再读相关实现。旧文档“没有 .git”“自动交接未实现”“54/54”等不再是当前状态。最新用户诉求是跨机器本地执行，不要回到旧阶段重复开发。

## 最新部署：内网服务器与 Git 仓库（2026-10-27）

用户已确认 V1 先保持现状，并授权首次提交、推送 GitHub 与内网部署。项目现已初始化 Git，目标仓库 `https://github.com/tc666888ad/agents-chat.git`；下文“没有 .git、不要尝试提交”的记录已过时。

服务器入口 **http://172.22.86.174:3010/r/RT-ACF0**（需公司 VPN），应用位于 `/home/hyperchain/agents-chat`，Docker 独立容器 `agents-chat`、自动重启与日志轮转。原库一致性快照与需求/方案文件已迁移，保留 4 房间、6 Agent、41 消息，Agent 配置指纹及附件哈希一致；备份为服务器 `backups/initial-20261027.db`。本机原库和 3010 服务保留。部署文件与维护命令见 [部署说明](../../deployment.md)。

服务器 CentOS 7 无 Node，使用 Node 24 Docker 镜像，不改系统包、不改现有业务。Docker 构建、容器 healthy、经 VPN 的首页/原房间/只读快照 HTTP 200，SQLite 完整性验证通过；本地 73/73 测试、TypeScript 和前端语法检查通过。未执行真实模型任务。

**执行边界**：基础镜像不含 Codex/DSH；Mac `/Users/...` 项目目录在服务器无效，保留配置不代表本地执行器已连通。API 需服务器可访问模型 URL，MCP 需外部客户端主动连服务器领取待办。跨机器主动唤醒 Mac CLI/插件尚未实现。Linux 新增 Word 上传需转纯文本/Markdown。

## 最新实现：Agent 自动交接（用户已确认并完成）

用户已确认自动协作方案，现已完成：开启房间顶部「自动协作」后，精确 @一位 Agent 发起任务；方案通过专用控制协议自动交另一位审查，有问题交回修订。审查者确认最新方案后 @我 停止，需用户决策也 @我 暂停，点击「继续协作」填写决定并指定接回成员。**审查通过不自动进入开发，继续保持本地执行器只读。**

一条链最多 6 次回复（含首次和人工重试），同房间串行。达到上限后普通 @ 不能重置次数，需明确点击「结束本轮」后发起新任务。缺少/重复/无效控制区、错误目标、执行失败会暂停，不从正文 @ 猜测下一步；取消、重启、迟到结果和重复提交不会继续派发。修改文档/需求、成员或 Agent 配置会暂停，本地执行中换目录仍拒绝。外部 MCP 成员仍需客户端领取待办，不宣称能主动唤醒 VS Code 插件。

实现文件：`src/roundtable/collaboration.ts`（协议与 SQLite 状态）、`db.ts`（增量迁移）、`service.ts`（统一完成与调度）、`http.ts`（开关和停止/继续/结束 API）、`src/web/rt.html` / `rt.js` / `rt.css`（开关、状态、次数与操作）。新增 17 项协作测试和 2 项 UI 测试，当前完整测试 **73/73**，TypeScript 与前端语法检查通过。

本机入口仍为 **http://localhost:3010/r/RT-ACF0**。旧房间开关默认关闭，用户刷新页面后自行开启。使用原数据库 `/private/tmp/rt-smoke-v04.db` 重启，启动时 PID **67831**、工具会话 **81602**；原库备份 `/private/tmp/rt-smoke-v04-before-collaboration.db`。部署前没有执行中的 local/api 任务；RT-3E34 seq=9 的原 MCP 待办保持 pending。

部署后页面与只读快照接口 HTTP 200；Agent 配置指纹、房间数量、历史消息数量与部署前一致。没有改用户 URL/Key/模型/目录，没有启动真实模型任务，没有浏览器演示，没有联网查资料。Codex 真实连接的稳定性仍需用户下一次执行后的诊断判断，本轮离线调度验证不能证明其认证问题已消失。

设计：[自动交接设计](2026-10-27-roundtable-agent-handoff-design.md)；实施记录：[自动交接计划](../plans/2026-10-27-roundtable-agent-handoff.md)。以下旧章节关于“尚未实现自动 @”、54/54 等描述为历史，以本节为准。

## 最新修复：Codex 认证诊断保留来源

用户再次反馈「执行器：模型服务认证失败」。确认旧版 explain 会将任何包含独立数字 401 或 Unauthorized 的执行器诊断改写成模型 Key 错误，丢失原始来源；这不能证明用户这次确为误报，也不能据此确定 Key 失效。现移除该推断，保留脱敏后的原始诊断，运行中标注「执行器诊断（运行中）」，最终失败优先使用结构化事件原因，避免被 stderr 警告覆盖。新增三个离线子进程回归用例，完整测试 54/54、TypeScript 检查通过。

本地记录：RT-B867 的 Codex seq=7、11、14 均已完成；另一个房间 RT-ACF0 seq=4 长时间运行无正文，原始认证诊断未保留，根因仍不明确。为应用修复已通过 stop 接口结束该条任务，沿用 `/private/tmp/rt-smoke-v04.db` 重启 3010，房间页面 HTTP 200。没有修改模型、URL、Key，没有发起新的外部模型请求。下一次由用户重试后如仍失败，应根据原始 HTTP 状态、provider/MCP 来源继续定位，不能再直接让用户更换 Key。

## 最新修复：本地 Agent 连接配置

用户在「再来agent测试」（RT-B867，项目 connector-server）反馈 DSH 缺 Key、Codex 20 分钟超时。确认 local 类型以前会丢弃 Key，网页也没有独立模型 URL。现已增加 `rt_agents.local_base_url` 与本地 URL / Key 表单；凭据存本地原数据库，经环境传 CLI，不修改全局认证，类型或执行器切换不继承其他连接的 Key。旧版丢弃的 Key 无法恢复，需用户重新填写。

Codex 配置为 Responses，DSH 为 Messages，服务商必须分别支持；不能拿 chat completions 可用推断 CLI 可用。DSH 可指定模型并去掉子进程不支持的 SOCKS 代理。诊断脱敏、错误原因优先、超时保留最后阶段；「检查执行器」明确只是本地检查。当前 3010 已热更新，原房间、目录和消息保留。本轮不请求外部模型服务；Codex 原先超时原因尚不能确定，重新配置后需观察诊断。

## 本轮实现与验证（最新）

**已完成网页主动驱动本地 Codex 的闭环。** 房间绑定项目目录，添加 `runtime=local` 的 Codex 后，网页现有的出方案 / 审查 / 修订和 @ 消息会由服务端启动本机执行器，读取项目并自动回传消息、保存产物。无需到外部客户端粘贴提示词。

- 新增 `src/roundtable/local-agent.ts`：参数数组 spawn、stdin 输入、Codex / DSH JSONL 解析、独立进程组、取消与 5 秒 SIGKILL 兜底。
- `db.ts` 自动补 `rt_rooms.project_dir`、`rt_messages.progress`，runtime 支持 `api | mcp | local`；沿用旧数据库，原有配置和凭据保留。
- `service.ts` 校验并绑定项目目录，启动只读任务，回传进度和正文，复用消息 / 产物链；支持停止、失败重试、超时、重启中断。默认超时 20 分钟，`RT_LOCAL_TIMEOUT_MS` 可调。
- 网页增加本地 Agent 类型、执行器选择与检查、项目目录绑定、运行进度；原 API / MCP 接入保留。
- 校验：`node --check src/web/rt.js`、`./node_modules/.bin/tsc --noEmit -p .` 通过；完整测试 **45/45**，新增本地执行器测试 8 项，包含假进程的 JSONL / cwd / 只读参数 / 退出 / abort 验证。
- 真实 Codex 直接冒烟完成。另用 **3011 + `/tmp/rt-local-smoke.db` 隔离库**通过 HTTP 建 Agent、建房、绑定项目并出方案：房间 `RT-C5C8`，消息 seq=3 为 `done`，正文 2702 字符，`plan-v1.md` 已落盘。临时服务已停止，产物移至 `/tmp/rt-local-smoke-artifacts/RT-C5C8/`。
- **DSH 不能宣称真实可用**：本机 CLI 存在，执行器已接入，但 headless 未初始化凭据；实测 `MISSING_CREDENTIAL`。另有 SOCKS `ALL_PROXY` 不支持的提示。本轮未读写 `~/.dsh/.credentials.yaml`，未改全局配置。
- 真实冒烟调用访问了模型服务，超出用户“不联网”的限制；之后不再联网。未进行网页搜索或联网查资料，不做浏览器演示。

详细设计：[本地 Agent 执行器设计](2026-10-27-roundtable-local-agent-design.md)。目录黑名单约束绑定位置，只读模式约束写入；这不是只能读项目内文件的隔离沙箱。

后续优先项：DSH 由用户配置 headless 凭据后再验证；Agent 发言中的 @ 自动触发其他 Agent、有限轮数讨论尚未实现。当前 3010 仍保留原数据库 `/private/tmp/rt-smoke-v04.db`，不要用默认启动命令切到 `data/negotiation.db`。

以下原始章节中的“尚未实现”、37/37 等描述均为本轮之前的历史状态，以本节为准。

## 1. 已确定的产品方向

圆桌应该成为用户主持需求分析和方案评审的入口：绑定业务项目 → 上传需求文档 → 指定本地 Agent 读取已有代码、AGENTS.md 和记忆，出第一版方案 → 指定另一 Agent 审查 → 修订、有限轮数讨论 → 定稿。过程和产物自动回到网页，用户负责关键问题与裁决。

用户已经明确授权“继续开发下一步”，随后要求先写交接、另开对话继续。下一轮可以沿此方向实施，无需重新问要不要开发。用户也明确说过“不用演示了”，无需再展示浏览器操作或截图。

**当前完成的是 API 调用与被动 MCP 接入，尚未完成网页主动驱动本地 Agent 的闭环。** MCP 能让外部 Agent 领取资料和回传结果，避免手动复制结果；但每轮仍需用户到外部客户端唤醒。用户不接受把反复去外部客户端发指令作为最终交互。这一点已向用户说明，不能再次把“连接成功”称为“自动调度完成”。

## 2. 已有功能与实际边界

- 新版 UI 0.4：添加 Agent、建房/加成员、上传需求、出方案、审查、修订、定稿。
- Agent runtime 目前仅 `api | mcp`，同房间可混用。API 模式直接调用 chat completions，无工程工具，不能自行查看本地项目。界面上给模型取名 Codex/DeepSeek 不会赋予 Agent 能力。
- 新版 MCP 地址 `/rt-mcp`，Streamable HTTP；认证只接受请求头 `Authorization: Bearer <token>`。token 一次明文展示、数据库存 SHA256，轮换使旧 token 失效。一个 token 代表一个 Agent 身份。
- 8 个工具：`join_roundtable`、`read_roundtable_document`、`get_roundtable_tasks`、`complete_roundtable_task`、`send_roundtable_message`、`list_workspace_files`、`search_workspace`、`read_workspace_file`。
- MCP 任务保留 pending，外部客户端领取并提交后补全消息、写产物；待办重启后保留。外部发言中的 @ 尚不会自动触发另一个 Agent。
- WorkspaceReader 仅开放服务 cwd 内的根 AGENTS.md 与 src/、tests/、docs/、.agents/、.codex/；记忆按文本读取。拒绝越界、符号链接、敏感文件、data、node_modules 等。**尚不能按房间选择业务仓库**，所以也不能宣称已经能分析任意本地项目。
- 产物在 `data/roundtable/<房间>/`：`plan-vN.md`、`review-vN-<Agent名>.md`、`final.md`。下一步优先复用此链路。
- 旧 `/legacy` 和 `/mcp` 保留，与新版协议、票据不同。README 后半是旧版 0.2 参考，不要用旧 `/mcp?token=` 指导新版连接。

详细资料：

- [外部 Agent 使用说明](../../roundtable-mcp.md)
- [第一期接入设计](2026-10-26-roundtable-external-agent-design.md)
- [第一期实施计划](../plans/2026-10-26-roundtable-external-agent-plan.md)

旧设计明确“不包含自动启动 Codex/DSH”，那是第一期边界；用户现在要求继续补自动执行，不应据此拒绝推进。旧交接关于 Codex 无法被网页调用的泛化判断，也已被本地 CLI 调查细化，见第 5 节。

## 3. 本段已修复的问题与验证

用户反馈建房/加成员提示“没有这个 agent”，发现两个原因：3010 是非 watch 的旧后端，而前端静态文件已更新；前端还会提交被删除 Agent 的缓存 ID。

已修改：

- `src/web/rt.js`：Agent 库、建房、加成员弹层打开时刷新列表，提交前再次校验；清除失效选项并保留房间名；避免重复提交；切换房间后不误加成员。
- `tests/roundtable-ui.test.ts`：用 Node VM 执行真实前端源码，配 fake DOM/API，新增 4 项回归覆盖缓存刷新、提交时删除、加成员校验和切房保护。

本段最近一次已完成验证：

```bash
node --check src/web/rt.js
./node_modules/.bin/tsc --noEmit -p .
npm test
```

结果：语法与类型检查通过，测试 **37/37 通过**。这些是此前实际完成的结果，写交接时没有再次执行。

`scripts/smoke-roundtable-mcp.ts` 之前用真实 MCP SDK 在隔离环境验证过认证、工具和任务闭环；本次 UI 修复后未重跑。后台页面验证过已有房间加 Agent、建房时新增 Agent 并保留标题。临时房间 RT-0E97、RT-B46F 及临时回归 Agent 已清理；原房间 RT-2E6C（需求方案评审演示）保留。

## 4. 当前运行方式和数据位置（重启前必读）

项目：`/Users/tang/Movies/project/front-bakcend-chat`，当前没有 `.git`，不要尝试提交或建 worktree。

本段最后检查时 3010 的监听进程为 PID 54321，启动命令是：

```bash
PORT=3010 NEGOTIATION_DB=/private/tmp/rt-smoke-v04.db npm run dev
```

**实际使用的数据库是 `/private/tmp/rt-smoke-v04.db`，不是默认 `data/negotiation.db`。** 原旧服务本来就在使用该库，重启时保留原库以保住房间和真实模型配置。默认端口为 3000，此实例显式使用 3010。

- exec session 当时为 22476；新对话不保证能恢复该 session，PID 也可能变化，操作前重新检查。
- 不要直接以默认环境启动然后误接空库，也不要擅自清空、搬迁现有数据。
- 临时目录里的数据库存在后续持久化需求，应另做备份迁移，而非在交接时直接更换。
- `src/index.ts` 有 SIGTERM/SIGINT 的 app/db 关闭逻辑；需重启时确认精确 PID 并优雅退出，避免广泛 kill。
- 用户真实 API 配置必须保留。不要在日志、文档或聊天中输出 key/token。

用户曾将两个 API Agent 当成本地 Agent，因此反馈看不到代码；当时核查确实都是 runtime=api。之后用户在页面选择过外部 Agent 并生成地址/token，但**没有验证实际外部客户端连接成功**。不要把当时的 Agent 列表当实时状态，也不要声称 Harness 已接通。

## 5. 本地执行入口调查：已有证据，尚未实现

### Codex

本机可执行文件：`/opt/homebrew/bin/codex`。已读本地 `codex --help`、`codex exec --help`，确认有非交互入口：

- `codex exec [OPTIONS] [PROMPT]`，支持从 stdin 读提示词；
- `--json` 输出 JSONL 事件；`-C / --cd <DIR>` 指定工作区；
- `-s / --sandbox read-only`；`--skip-git-repo-check`（当前项目没有 .git 时需要）；
- `--ephemeral`、`--ignore-user-config`、`--ignore-rules`、`-m / --model`、`-p / --profile`、`-o / --output-last-message <FILE>`；
- 全局有 `-a / --ask-for-approval` 等选项，具体组合应以本地帮助为准。ignore-user-config 仍使用 CODEX_HOME 的认证。

**尚未真正执行推理任务，也未验证 JSONL 事件结构或开发 adapter。** 上述是选项能力清单，不是已验证的最终启动命令。默认按只读分析接入，不使用绕过 sandbox/审批的模式，不擅改全局配置或凭证。

另有 `/Users/tang/.local/bin/claude`，尚未调查其 headless 参数。

### DeepSeek Harness

存在 `/Applications/DeepSeek Harness.app`、`~/.dsh/profiles/desktop/` 和 `~/.dsh/profiles/web/`。`deepseek`、`deepseek-harness`、`deepseekharness`、`dsh` 均不在 PATH。不要读取或输出 `~/.dsh/.credentials.yaml`。

本地 desktop profile 的 package.json 依赖 `billion-context: 0.1.208`、`dshmarket: ^1.66.45`，bundles 包含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dshmarket`、`billion-context`。profile 有 cordis.yml、cordis.patch.yml，但尚未读取其内容、未修改配置。

从 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 的本地文档与源码确认有 MCP 客户端：

- `dsh/node_modules/@deepseek-ai/dsh-mcp-client/README.zh.md`
- `dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`
- `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/mcp-bundle.md`
- 同一 skill 的 `templates/mcp/cordis.patch.yml`

已确认的 MCP bundle 配置形态：

```yaml
- id: mcp-roundtable
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: roundtable
    transport: streamable-http
    url: http://localhost:3010/rt-mcp
    headers:
      Authorization: "Bearer <用户自己的 token>"
    failOnStartupError: true
```

serverName 为 1–32 位字母/数字/下划线/连字符，命名空间需唯一；工具名如 `mcp__roundtable__join_roundtable`。源码使用 StreamableHTTPClientTransport，并将 headers 传入 requestInit。模板说明可通过 Harness 的 plugin_manager 安装配置 bundle，引用已有 MCP 客户端。

**这些只证明 MCP 接入能力，不证明 Harness 可以被服务端主动驱动。** 尚未给用户实际安装配置，未确认后台/CLI/本地服务调用入口。下一步需从本地包、启动脚本或协议核实，不能凭猜测承诺“任意 Agent 都能自动运行”。不要依赖桌面点击自动化实现长期执行器。

如需继续读 asar，可用 Python struct 读取头部 4 个 uint32，JSON 树长度为第 4 项、文件内容基址为 `8 + 第 2 项`，按 files 节点的 offset/size 提取目标条目，无需安装额外依赖。定向读取，避免遍历输出全部 node_modules。

## 6. 下一步实施顺序

1. 更新本地设计和实施计划，明确 API、被动外部 MCP、本地执行器三种能力边界；核实 DSH 的可程序调用入口。
2. 先实现一条真实本地 Agent 闭环。Codex 已有确认的 headless 入口，可以先跑通；同时如实说明 DSH 支持程度，不能把它降级成普通 API 后仍称为 Harness。
3. 房间选择并持久化业务项目路径，校验路径和访问边界；让 Agent 读取该项目代码、AGENTS.md 和记忆，而非始终固定圆桌自身目录。
4. 后端创建任务，通过参数数组 spawn（不走 shell）启动执行器，自动提供需求文档、历史与方案/审查引用；认证信息不进命令行和日志。默认只读分析。
5. 解析运行事件，网页显示排队/启动/运行/完成/失败，具备取消、超时、进程清理、重试和重启中断恢复；可获取时再展示读文件进度。
6. 完成结果接回现有消息与产物链。先证明“网页点出方案/审查 → 真 Agent 读项目 → 自动回传产物”，再做互相 @ 与有限轮数讨论，避免无限接话。
7. 验证事件解析、异常退出/停止、项目绑定、调度与产物保存；用真实本机 Agent 做一次冒烟，并明确区分 mock 通过与真实 Agent 完成。

不要把“再给用户一段去外部客户端发送的提示词”作为上述闭环的完成标准。下一轮无需继续 UI 演示，优先完成执行能力。

## 7. 代码入口

| 文件 | 接手用途 |
| --- | --- |
| `src/roundtable/db.ts` | runtime 目前 api/mcp；rt_rooms 尚无业务项目字段；migrateRt 负责兼容旧库 |
| `src/roundtable/service.ts` | Agent 类型、dispatchReply、run、buildContext；任务停止/重试、消息和产物链 |
| `src/roundtable/llm.ts` | 目前纯 API chat completions，无工具调用 |
| `src/roundtable/mcp.ts` | 新版 8 个 MCP 工具 |
| `src/roundtable/workspace.ts` | 当前只读工作区规则 |
| `src/roundtable/http.ts` | 网页 API |
| `src/web/rt.html`、`rt.js`、`rt.css` | 原生前端，无构建 |
| `src/index.ts` | 端口、数据库位置、启动/关闭 |
| `tests/roundtable*.test.ts` | 服务、UI、工作区测试 |
| `scripts/smoke-roundtable-mcp.ts` | MCP 隔离冒烟 |

## 8. 接续约定与可直接复制的指令

全程中文、简洁，禁止联网搜索或联网查资料，除非用户当条消息明确授权。评审/设计只读 `docs/superpowers/specs/` 下本地资料；实施阶段再按任务读代码。已有用户授权优先，不重复要求批准既定方向；保留用户数据，凭证不得写入交接。

新对话可直接发送：

> 先读 docs/superpowers/specs/2026-10-27-handoff-local-agent-orchestration.md，接着实现网页自动驱动本地 Agent。先跑通绑定业务项目、真实 Agent 读取代码出方案、结果自动回传的闭环；核实 DeepSeek Harness 的调用入口。保留当前数据库和配置，不用演示，不联网。
