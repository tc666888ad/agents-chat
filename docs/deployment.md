# 内网部署（V1）

使用 Docker 隔离 Node.js 与宿主机系统。只操作本项目目录、镜像和容器，不需要升级宿主机 Node、修改现有 Nginx 或重启其他服务。

## 初次部署

依赖 Docker 与 Docker Compose（`docker compose` 或旧版 `docker-compose`）。镜像构建需要访问 npm registry 和 Node 镜像仓库。

```sh
cd /home/hyperchain
mkdir -m 700 agents-chat
# 将项目源代码放到 agents-chat 后继续
cd agents-chat
mkdir -m 700 data backups
cp .env.example .env
# 编辑 .env：BIND_IP 填服务器内网 IP，APP_UID/APP_GID 填 id -u/id -g 的结果
chmod 600 .env
# 如需迁移旧数据，将 SQLite 在线备份得到的完整快照放到 data/negotiation.db
# 不要直接复制正在写入中的 .db，也不要提交数据库或 .env。
docker-compose config --quiet
docker-compose build
docker-compose up -d
docker-compose ps
curl --fail http://127.0.0.1:3010/
```

绑定特定内网 IP 后，curl 应改用该 IP。首次部署使用 `172.22.86.174:3010`，应用目录为 `/home/hyperchain/agents-chat`。默认配置只绑定 `127.0.0.1`，按实际访问需要填写 `.env`。

数据库为 `data/negotiation.db`，包含 API Key，目录权限 700，文件权限 600。数据挂载在镜像之外。容器以普通用户运行、根文件系统只读，限制 CPU/内存/PID，日志自动轮转，服务退出或 Docker 重启后自动拉起。

## 检查与启停

```sh
cd /home/hyperchain/agents-chat
docker-compose ps
docker-compose logs --tail=80
docker-compose stop       # 只停止本项目
docker-compose start
```

不使用 `docker system prune`，不操作其他项目的容器、镜像、卷或端口。

## 备份与升级

先停止本项目再复制 SQLite 文件，避免 WAL 未落盘造成不一致；保留原镜像 ID 和数据库快照以便回退。备份含凭据，留在受限目录，不进 Git。

```sh
cd /home/hyperchain/agents-chat
docker image inspect agents-chat:v1 --format '{{.Id}}'
docker-compose stop
cp -p data/negotiation.db "backups/negotiation-$(date +%Y%m%d-%H%M%S).db"
# 更新本项目源代码后：
docker-compose build
# 此服务器的 Compose v1 与 Docker 26 重建旧容器时存在 ContainerConfig 兼容问题。
# 本项目已停止后，先移除本项目的旧容器；不带 -v，挂载数据保留。
docker-compose rm -f
docker-compose up -d
```

如升级失败，仅停止本项目，恢复升级前数据库及旧镜像后重新启动。不要用新版本已迁移的数据库直接运行旧版本。

## Agent 执行位置

- API Agent 从服务器直接请求其配置的模型 URL；需服务器可以访问该模型地址。
- 外部 MCP Agent 从自己的机器连接 `http://服务器IP:3010/rt-mcp`，使用 Agent 页面生成的 token；需要客户端主动领取待办。
- 本地 Agent 可绑定成员电脑连接器，选择该电脑授权项目；旧同机模式仍要求 CLI 和目录位于 Web 服务运行环境。本 Docker 镜像不包含 Codex/DSH。
- 保留原 Agent 配置，不迁移 Mac 全局认证、不自动安装 CLI、不调用真实模型测试。成员电脑运行方式见下文「成员电脑连接器」。
- 网页通过成员电脑主动运行的连接器调用 CLI；不能直接唤醒 Codex/VS Code 桌面插件。

V1 网页管理接口沿用现有内网访问模式，部署只绑定指定内网地址；不添加公网入口。需要登录、按人隔离等能力时另行实现。

## 2026-10-27 首次部署记录

- 访问：`http://172.22.86.174:3010/`，原房间 `/r/RT-ACF0`。
- 独立目录：`/home/hyperchain/agents-chat`，独立容器 `agents-chat`。
- 初始数据备份：`backups/initial-20261027.db`；同时保留本机原库。
- 迁移 4 个房间、6 个 Agent、41 条消息、1 份需求原件和 2 份方案；Agent 配置哈希、附件 SHA256 一致，SQLite integrity_check 通过。
- 本机 VPN 访问首页、房间、只读快照均 HTTP 200；容器 healthy。
- 现有业务容器保持运行，没有改防火墙、Nginx、系统包或重启 Docker。
- 本地 73/73 测试、TypeScript 与前端语法检查通过。未调用真实模型。
- 镜像使用 Node 24.22.1，修正了源码权限为 600 时普通用户无法读取的问题。Linux 无 macOS textutil，新增 Word/RTF 等上传需先转成 Markdown/纯文本。

## 成员电脑连接器（V1 增量）

当前增量已在本地实现并离线验证，尚未部署到服务器：本轮 SSH 预检因无有效认证失败，原服务器 V1 保持原状。完成下述增量部署后网页才提供配对和下载入口。

服务器网页可以绑定成员电脑上明确授权的项目；实际 Codex/DSH 子进程由成员电脑启动，服务器 Docker 中无需安装 CLI 或挂载电脑目录。同机 `project_dir` 模式继续兼容。绑定设备后不会回退到服务器执行器。

网页右侧「项目目录」→「配对电脑」，下载连接器压缩包，解压后在成员电脑终端执行（Node.js 22 或以上，无需 npm install）：

```sh
node connector/cli.js pair --server http://172.22.86.174:3010 --name 我的电脑
# 按终端提示输入网页上的一次性配对码，十分钟有效，只能使用一次。
node connector/cli.js add-workspace "/Users/你/project/业务项目" --name 业务项目
node connector/cli.js list
node connector/cli.js run
```

保持终端运行。网页点「刷新」，选择电脑和授权项目，「保存绑定」，再为本地 Agent 选择 Codex CLI / DeepSeek Harness。源码工作区也可用 `npm run connector -- ...` 执行同样的命令；`npm run build` 会生成 `dist/downloads/agents-chat-connector.tar.gz`，网页下载链接使用此文件。

配置默认保存到 `~/.agents-chat-connector.json`（权限 600），包含设备 token 及项目绝对路径；可用 `RT_CONNECTOR_CONFIG` 指定其他文件。服务器只接收项目标识/显示名和执行器列表。不要分享配置文件或将其打进镜像/Git。配对到另一服务器时使用另一配置文件，CLI 不覆盖已有配置。

连接器使用**成员电脑自己的 CLI 配置或环境变量**：Codex 先在本机配置认证；DSH headless 需在本机提供 `DEEPSEEK_API_KEY`，也可通过 `DEEPSEEK_BASE_URL` 指定地址。执行器路径可用 `RT_CODEX_BIN` / `RT_DSH_BIN` 指定。网页保留原 URL、Key、模型名；连接器任务仅透传模型名，**不下发服务器已保存的 URL/Key**。网页 URL/Key 仍供旧同机执行模式使用。没有迁移全局认证或自动调用模型验证。

`Ctrl+C` 停止连接器。修改授权项目需先停止，重新运行 `add-workspace` 后再启动；同一配置通过独占锁限制为单进程。异常退出若留下 `.lock` 文件，先确认原连接器及其子进程已退出，再删除该锁文件。网页「吊销电脑」会使 token 立即失效；取消任务和断线会使本机进程停止。心跳每三秒一次，任务租约六十秒，排队九十秒未领取则失败，最大执行时间沿用 `RT_LOCAL_TIMEOUT_MS`（默认二十分钟）。失败后不会自动重跑。

自动协作继续最多六次回复；仅分析/方案/审查，通过后仍需人决定，不自动进入开发。网页设备管理沿用 V1 的内网访问权限，尚未实现登录或按成员隔离；只用于现有受信任内网。

下载包采用固定文件白名单生成，仅含五个运行模块、README 和 package.json，不含配置、凭据、项目代码、数据库或 node_modules。
