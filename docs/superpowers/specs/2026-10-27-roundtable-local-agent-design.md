# 圆桌本地 Agent 执行器设计（2026-10-27）

目标：网页上点「出方案 / 审查 / 修订」后，服务端直接在房间绑定的业务项目里启动本机 Agent，只读分析代码，结果自动变成消息和产物，用户不用再去外部客户端发指令。

## 1. 三种接入方式

| runtime | 谁触发 | 能否看本地项目 | 适用 |
| --- | --- | --- | --- |
| `api` | 服务端调 chat completions | 不能，只看房间上下文 | 纯文字讨论 |
| `mcp` | 外部客户端自己领任务 | 只能看圆桌服务 cwd 的白名单目录 | 已有外部 Agent，人愿意去那边唤醒 |
| `local` | 服务端 spawn 本机 CLI | 能，cwd 为房间绑定目录，只读 | 方案/审查需要读代码（本期重点） |

`local` 的执行器种类存在 `rt_agents.base_url`（`codex` / `dsh`），`model` 为 `default` 时不传，其他值 Codex 通过 `-m` 传入，DSH 通过临时模型 overlay 传入。`local_base_url` 保存独立模型地址，`api_key` 保存本 Agent 的 Key；对外只返回有无 Key，不返回明文。

## 2. 数据

- `rt_agents.local_base_url`：本地执行器独立模型地址；旧库自动补列。
- `rt_rooms.project_dir`：房间绑定的业务项目绝对路径；空表示未绑定。
- `rt_messages.progress`：本地 Agent 运行阶段（启动 / 读取某文件 / 执行某命令 / 整理结果），完成后清空。
- 旧库启动时自动补列，不改已有数据。

## 3. 调度

1. `startFlow` / `postMessage` / `retry` 先 `assertLocalReady`：房间没绑目录或执行器不存在就直接报错，不生成空回复。
2. `dispatchReply` 遇到 `local` 走 `runLocal`：把 `buildContext` 的结果拼成纯文本任务（只读要求、先读 AGENTS.md/.agents/.codex、引用文件和行号、只输出 Markdown），通过 stdin 交给执行器。
3. 运行中每 300ms 节流写一次 progress 和 body，并推 SSE；完成写 `done` 并复用原产物链（`plan-vN.md` / `review-vN-*.md`）；失败写 `error`，保留已有输出，可重试。
4. 停止 = abort：SIGTERM 整个进程组，5 秒后 SIGKILL 兜底（含孙进程）。服务关闭先杀全部本地子进程；重启时把 `api/local` 的未完成回复标为中断。
5. 绑定目录在本地 Agent 运行中不可修改；修改后写一条系统消息。

## 4. 安全边界

- 只读：Codex 用 `codex exec --json -s read-only --ephemeral -C <dir> -o <tmp>`；DSH 用 `dsh --profile headless --json` 并设 `DSH_PERMISSION_MODE=read-only`（headless 无审批者，升权请求失败关闭）。
- 只读模式约束写入操作；目录黑名单只约束可绑定目录，不是文件读取的隔离沙箱，不能保证 Agent 只能读取项目内文件。
- 参数数组 `spawn(..., { shell: false, detached: true })`，prompt 走 stdin，不进命令行和日志；连接参数留空时沿用本机 CLI 配置；独立 Key 仅通过本次子进程环境传入（Codex 为 `RT_LOCAL_API_KEY`、DSH 为 `DEEPSEEK_API_KEY`），不写全局认证文件。运行诊断及最终输出会过滤传入的 Key。
- 目录校验（`checkProjectDir`）：必须是绝对路径、realpath 后存在且是目录；拒绝 `/`、HOME、`/Users`、`/Applications`、`/Volumes`、`/tmp`、`/var` 本身；拒绝 `/System`、`/usr`、`/bin`、`/sbin`、`/etc`、`/Library`、`/dev`、`~/Library`、`~/.ssh`、`.dsh`、`.codex`、`.aws`、`.gnupg`、`.config` 及其子目录。
- 超时：默认 20 分钟，`RT_LOCAL_TIMEOUT_MS` 可调；输出上限 `MAX_LOCAL_TEXT`，超出截断。
- 执行器路径：默认查 `/opt/homebrew/bin/codex` 等常见位置和 DSH app 内置 CLI，可用 `RT_CODEX_BIN` / `RT_DSH_BIN` 指定。

## 5. DeepSeek Harness 现状

- 可程序调用入口：app 内置 `Contents/Resources/runtime/cli/bin/dsh`，`--profile headless --json` 输出 JSONL（session / status / thinking / text / tool_call / tool_result / final / error）。
- headless 不复用桌面 GUI 登录态。现已支持直接在圆桌本地 Agent 表单保存 API Key，并以 `DEEPSEEK_API_KEY` 注入子进程；也可使用 CLI 原有环境或在 `~/.dsh/profiles/headless/cordis.patch.yml` 启用 credentials / authorization / deepseek-account 插件。本机目前没有 headless profile。
- 实测：`MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`，真实执行器直接调用在 0.6 秒内失败；服务会把执行器错误写入消息，网页展示该原因。另有提示 `ALL_PROXY` 为 SOCKS 代理时 dsh 不支持，需改 http(s) 代理。
- 结论：DSH 执行器代码已就绪并通过假进程测试，但真实可用要用户自行初始化凭据；本项目不读取 DSH 桌面凭据存储；用户需在本地 Agent 的独立配置中填写 Key。

## 6. 未做

- Agent 回复里的 @ 自动触发另一个 Agent、有限轮讨论。
- 写代码（目前只读分析）。
- 并发上限与排队（同一 Agent 已有“还在回复中”的互斥）。

## 7. 验证记录

- TypeScript 类型检查、前端语法检查通过；完整测试 45/45（其中本地执行器新增 8 项）。
- 真实 Codex 直接执行：读取 `package.json`，返回 scripts 列表，约 28 秒完成。
- HTTP 闭环：临时服务 3011，独立数据库 `/tmp/rt-local-smoke.db`，房间 `RT-C5C8`；通过与网页相同的 HTTP 接口创建本地 Agent、建房、绑定项目和出方案。真实进程读取项目后，消息 seq=3 为 `done`、正文 2702 字符，产物 `plan-v1.md` 已落盘。未做浏览器演示。
- 冒烟产物收尾移到 `/tmp/rt-local-smoke-artifacts/RT-C5C8/`，临时服务已停止；3010 的原数据库和配置保留，仅有新增字段迁移。
- 真实调用验证访问过模型服务，超出了用户“不联网”的限制；之后停止联网操作，未做网页搜索或联网查资料。

## 8. 本地连接配置缺失修复

用户房间 RT-B867 的 DSH 缺凭据，Codex 20 分钟超时。根因之一：旧版 local 配置丢弃 Key，且没有独立 URL 字段，填写普通 API 表单无法配置 CLI。已补充独立 URL / Key / 模型字段；旧版丢弃的 Key 无法恢复，需用户重新填写，不挪用其他 Agent 的凭据。

- Codex：临时 `-c` 覆盖 provider，使用 Responses 协议及独立环境 Key；配置存在时降低连接重试次数和流空闲超时，不改变全局 config.toml。
- DSH：`DEEPSEEK_BASE_URL` 对应 Messages 根地址（需服务商支持，通常为其提供的 `/anthropic`）；只给 DSH 子进程移除不支持的 SOCKS 代理值，HTTP(S) 代理保留。模型 overlay 不含凭据，进程退出清理。
- 「检查执行器」会检查 DSH 是否有 Key，并明确“尚未请求模型服务”，不把可执行文件存在等同于连通。
- stderr 中连接和重试诊断回传为进度，超时保留最后阶段；凭据错误优先显示，诊断和回复过滤已知 Key。
- 本轮仅离线测试参数、环境、持久化及 UI 提交，不请求外部模型；Codex 先前超时的具体网络 / provider 原因仍需重新配置后从实际诊断确认。
