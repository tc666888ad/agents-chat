import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { acquireLock, addWorkspace, loadConfig, requester, runConnector, saveConfig, serverUrl, helloPayload } from './client.js';
import { killAllLocalAgents } from '../roundtable/local-agent.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const option = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const path = resolve(process.env.RT_CONNECTOR_CONFIG || resolve(homedir(), '.agents-chat-connector.json'));
  if (command === 'pair') {
    if (existsSync(path)) throw Error('已有连接器配置；保留现有配置。需配对另一台服务器时用 RT_CONNECTOR_CONFIG 指定新文件');
    const server = serverUrl(option('--server') || 'http://172.22.86.174:3010');
    const name = option('--name') || hostname();
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let code: string;
    try { code = (await input.question('输入网页上的一次性配对码：')).trim(); } finally { input.close(); }
    const paired = await requester({ server, token: '' })('/pair', { code, name });
    // 独占锁也保护 pair，避免两个终端覆盖彼此的设备身份。
    const release = acquireLock(path);
    try {
      if (existsSync(path)) throw Error('另一进程已保存配置，未覆盖');
      saveConfig(path, { server, token: paired.token, workspaces: [] });
    } finally { release(); }
    console.log('电脑配对完成。请用 add-workspace 登记项目，再运行 run。');
  } else if (command === 'add-workspace') {
    const release = acquireLock(path);
    try {
      const directory = args[0]; if (!directory || directory.startsWith('--')) throw Error('用法：add-workspace /项目绝对路径 --name 项目名称');
      const config = addWorkspace(loadConfig(path), directory, option('--name') || basename(directory));
      saveConfig(path, config);
      console.log('项目已登记。运行 run 后网页即可选择；更改项目需先停止连接器。');
    } finally { release(); }
  } else if (command === 'list') {
    const config = loadConfig(path);
    console.log(`服务器：${config.server}`);
    for (const w of config.workspaces) console.log(`${w.name}\t${w.id}\t${w.path}`);
    console.log(`本机执行器：${helloPayload(config).executors.join('、') || '未找到（可用 RT_CODEX_BIN / RT_DSH_BIN 指定）'}`);
  } else if (command === 'run') {
    const config = loadConfig(path); const release = acquireLock(path); const abort = new AbortController();
    const stop = () => { abort.abort(); killAllLocalAgents(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { console.log('连接器运行中，只执行网页下发到已授权项目的只读任务。Ctrl+C 停止。'); await runConnector(config, abort.signal); }
    finally { stop(); process.off('SIGINT', stop); process.off('SIGTERM', stop); release(); }
  } else {
    console.log('本地连接器（Node >=22）\n  pair --server http://服务器:3010 --name 电脑名称\n  add-workspace /项目绝对路径 --name 项目名称\n  list\n  run\n配置：~/.agents-chat-connector.json（RT_CONNECTOR_CONFIG 可覆盖），权限 600。');
    if (command && command !== '--help') process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err instanceof Error ? err.message : '连接器执行失败'); process.exitCode = 1; });
}
