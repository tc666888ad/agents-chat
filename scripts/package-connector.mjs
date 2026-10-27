/** 固定文件白名单：下载包仅含运行代码，绝不打包配置、工作区、依赖或数据库。 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve('dist/connector-package');
const files = ['connector/cli.js', 'connector/client.js', 'roundtable/local-agent.js', 'roundtable/project-path.js', 'roundtable/errors.js'];
for (const file of files) {
  const target = resolve(root, file); mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve('dist/src', file), target);
}
writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'agents-chat-connector', private: true, type: 'module', engines: { node: '>=22' } }, null, 2) + '\n');
writeFileSync(resolve(root, 'README.txt'), `成员电脑连接器（Node.js >=22，无需 npm install）

1. 网页侧栏「配对电脑」生成一次性配对码。
2. 在此文件夹终端运行：node connector/cli.js pair --server http://服务器:3010
   在终端提示中输入配对码。Token 自动保存到 ~/.agents-chat-connector.json，权限 600。
3. 登记授权项目：node connector/cli.js add-workspace "/项目绝对路径" --name "项目名称"
4. 查看项目和本机执行器：node connector/cli.js list
5. 启动：node connector/cli.js run
6. 网页刷新，选择电脑/项目并保存；Agent 选择 Codex CLI 或 DSH。

项目路径和 CLI 凭据只在本机；服务端已有 URL/Key 不下发，模型名可由网页指定。
CLI 使用本机既有配置或环境变量。执行器不在默认安装位置时设置 RT_CODEX_BIN/RT_DSH_BIN。
全程只读，仍会把分析结果发回网页；只登记你允许共享分析结果的项目。
Ctrl+C 停止；修改项目须先停止连接器，修改后重新运行。
同一配置只能运行一个进程。若异常退出留下 .lock，确认原连接器已退出后删除该锁文件。
更换服务器时用 RT_CONNECTOR_CONFIG 指定另一份配置；不要覆盖或转发原有凭据。
`);
mkdirSync(resolve('dist/downloads'), { recursive: true });
execFileSync('tar', ['-czf', resolve('dist/downloads/agents-chat-connector.tar.gz'), '-C', root, 'package.json', 'README.txt', ...files]);
console.log('连接器下载包已生成（5 个运行模块，无配置和依赖）');
