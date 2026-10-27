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
- 本地 Agent 的 CLI 和项目目录必须位于 Web 服务的运行环境。本 Docker 基础镜像不包含 Codex/DSH；从 Mac 迁移的 `/Users/...` 路径在服务器无效。
- 本次保留原 Agent 配置，不迁移 Mac 全局认证、不自动安装 CLI、不调用真实模型测试。需要本地执行器时，在自定义镜像中安装 Linux CLI，并按需挂载受限的项目目录；不能挂载 Docker socket、宿主机根目录或整个 home。
- 服务器网页不能直接唤醒 Mac 上的 Codex/VS Code 插件；跨机器自动执行需要后续实现本地桥接。

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
