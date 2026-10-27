import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addWorkspace, loadConfig, saveConfig, executeTask, acquireLock } from '../src/connector/client.js';
import type { ConnectorTask } from '../src/roundtable/connector.js';

function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'connector-client-')); const config = join(dir, 'config.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const value = { server: 'http://127.0.0.1:3010', token: 'rtd_local-secret', workspaces: [] as { id: string; name: string; path: string }[] };
  saveConfig(config, value); return { dir, config, value };
}
test('本机配置权限 600、项目校验和持久化、独占锁防止重复运行', t => {
  const { dir, config, value } = setup(t);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  const next = addWorkspace(value, dir, '授权项目'); saveConfig(config, next);
  assert.equal(loadConfig(config).workspaces[0]!.name, '授权项目');
  assert.throws(() => addWorkspace(value, '/', '系统'));
  const release = acquireLock(config); assert.throws(() => acquireLock(config)); release();
  const release2 = acquireLock(config); release2();
  chmodSync(config, 0o644); assert.throws(() => loadConfig(config));
  assert.match(readFileSync(config, 'utf8'), /rtd_local-secret/);
});
const task: ConnectorTask = { attempt_id: 'attempt', room_code: 'RT-TEST', seq: 2, workspace_id: 'ws', kind: 'codex', prompt: '只读分析', lease_ms: 60000, timeout_ms: 5000 };
test('本机执行只使用授权路径及自身配置；完成与进度回传', async t => {
  const { dir, value } = setup(t); const cfg = addWorkspace(value, dir, '业务'); task.workspace_id = cfg.workspaces[0]!.id;
  const calls: any[] = [];
  await executeTask(cfg, { ...task }, async (path, data) => { calls.push({ path, data }); return { cancel: false }; }, new AbortController().signal,
    async req => { assert.equal(req.cwd, cfg.workspaces[0]!.path); assert.equal(req.apiKey, undefined); assert.equal(req.baseUrl, undefined); req.onText('中间结果'); return '最终结果'; }, 5);
  assert.ok(calls.some(c => c.path.endsWith('/progress')));
  assert.equal(calls.find(c => c.path.endsWith('/complete')).data.body, '最终结果');
});
test('服务器取消和断网时立即终止本机执行，退出后确认失败', async t => {
  const { dir, value } = setup(t); const cfg = addWorkspace(value, dir, '业务'); const current = { ...task, workspace_id: cfg.workspaces[0]!.id };
  for (const offline of [false, true]) {
    let aborted = false; let beat = 0; const paths: string[] = [];
    await executeTask(cfg, current, async path => {
      paths.push(path); if (path.endsWith('/progress') && ++beat > 1) { if (offline) throw Error('断线'); return { cancel: true }; }
      return { cancel: false };
    }, new AbortController().signal, req => new Promise((_resolve, reject) => {
      req.signal.addEventListener('abort', () => { aborted = true; reject(Error('已停止')); }, { once: true });
    }), 5);
    assert.equal(aborted, true); assert.ok(paths.some(p => p.endsWith('/fail'))); assert.ok(!paths.some(p => p.endsWith('/complete')));
  }
});
test('工作区符号链接被替换后拒绝执行，不允许服务端传入任意路径', async t => {
  const { dir, value } = setup(t); const link = join(dir, 'link'); symlinkSync(dir, link);
  const cfg = addWorkspace(value, link, '授权'); const workspace = cfg.workspaces[0]!;
  // 配置保留规范化后的真实路径；恶意任务中的 path 不参与执行。
  const bad = { ...task, workspace_id: 'not-authorized', path: '/' };
  let spawned = false; const calls: string[] = [];
  await executeTask(cfg, bad, async path => { calls.push(path); return {}; }, new AbortController().signal, async () => { spawned = true; return '错误'; });
  assert.equal(spawned, false); assert.ok(calls.some(p => p.endsWith('/fail'))); assert.equal(workspace.path, dir.replace(/^\/var\//, '/private/var/'));
});


test('连接器在截断前过滤自身 token，包括进度、正文及最终结果', async t => {
  const { dir, value } = setup(t); const cfg = addWorkspace(value, dir, '业务');
  const calls: any[] = []; const secret = cfg.token;
  await executeTask(cfg, { ...task, workspace_id: cfg.workspaces[0]!.id }, async (path, data) => {
    calls.push({ path, data }); return { cancel: false };
  }, new AbortController().signal, async req => {
    req.onProgress('x'.repeat(195) + secret);
    req.onText('正文 ' + secret);
    await new Promise(resolve => setTimeout(resolve, 20));
    return 'x'.repeat(159995) + secret;
  }, 5);
  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('rtd_l'));
  assert.ok(calls.some(c => c.path.endsWith('/progress') && c.data.body?.includes('[REDACTED]')));
});

test('流式 token 尚未输出完整时不提前发送其前缀，补齐后脱敏', async t => {
  const { dir, value } = setup(t); const cfg = addWorkspace(value, dir, '业务');
  const calls: any[] = []; const partial = cfg.token.slice(0, -1);
  await executeTask(cfg, { ...task, workspace_id: cfg.workspaces[0]!.id }, async (path, data) => {
    calls.push({ path, data }); return { cancel: false };
  }, new AbortController().signal, async req => {
    req.onText('正文 ' + partial); req.onProgress('诊断 ' + partial);
    await new Promise(resolve => setTimeout(resolve, 20));
    req.onText('正文 ' + cfg.token);
    await new Promise(resolve => setTimeout(resolve, 20));
    return '最终 ' + cfg.token;
  }, 5);
  assert.ok(!JSON.stringify(calls).includes(partial));
  assert.ok(calls.some(c => c.data.body === '正文 [REDACTED]'));
  assert.equal(calls.find(c => c.path.endsWith('/complete')).data.body, '最终 [REDACTED]');
});
