import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { checkProjectDir } from '../roundtable/project-path.js';
import { spawnLocalAgent, resolveBin, EXEC_KINDS, type LocalRunner } from '../roundtable/local-agent.js';
import type { ConnectorTask } from '../roundtable/connector.js';

export interface ConnectorConfig {
  server: string; token: string; workspaces: { id: string; name: string; path: string }[];
}
export function serverUrl(input: string): string {
  const u = new URL(input);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('服务器地址应为 http(s)://主机:端口，不能包含认证信息或路径');
  return u.origin;
}
export function loadConfig(path: string): ConnectorConfig {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw Error('连接器配置必须是权限 600 的普通文件');
  const c = JSON.parse(readFileSync(path, 'utf8')) as ConnectorConfig;
  c.server = serverUrl(c.server);
  if (typeof c.token !== 'string' || !/^rtd_[A-Za-z0-9_-]+$/.test(c.token) || !Array.isArray(c.workspaces) || c.workspaces.length > 100 || c.workspaces.some(w => !w || typeof w.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(w.id) || typeof w.name !== 'string' || !w.name.trim() || w.name.length > 100 || typeof w.path !== 'string')) throw Error('连接器配置格式不正确');
  if (new Set(c.workspaces.map(w => w.id)).size !== c.workspaces.length) throw Error('连接器配置中项目标识重复');
  return c;
}
export function saveConfig(path: string, config: ConnectorConfig): void {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch { /* 已重命名 */ } }
}
export function addWorkspace(c: ConnectorConfig, path: string, name: string): ConnectorConfig {
  const real = checkProjectDir(path);
  if (!real || !name.trim() || name.length > 100) throw Error('填写具体项目目录及显示名称（最多 100 字）');
  const previous = c.workspaces.find(w => w.path === real);
  const entry = { id: previous?.id ?? `ws_${randomBytes(12).toString('hex')}`, name: name.trim(), path: real };
  const workspaces = [...c.workspaces.filter(w => w.id !== entry.id), entry];
  if (workspaces.length > 100) throw Error('最多登记 100 个项目');
  return { ...c, workspaces };
}
export function acquireLock(configPath: string): () => void {
  const path = `${configPath}.lock`;
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (err: any) {
    if (err.code === 'EEXIST') throw Error(`此配置已有连接器在运行；若上次异常退出，请确认没有运行中的连接器后删除锁文件 ${path}`);
    throw err;
  }
  writeFileSync(fd, String(process.pid));
  return () => { closeSync(fd); unlinkSync(path); };
}
export class ConnectorHttpError extends Error { constructor(readonly status: number) { super(`服务器请求失败（HTTP ${status}）`); } }
export type ConnectorRequest = (path: string, data?: unknown, signal?: AbortSignal) => Promise<any>;
export function requester(config: Pick<ConnectorConfig, 'server' | 'token'>): ConnectorRequest {
  const origin = serverUrl(config.server);
  return async (path, data = {}, signal) => {
    const timeout = AbortSignal.timeout(path.startsWith('/claim') ? 30_000 : 10_000);
    const response = await fetch(`${origin}/api/rt/connector${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify(data), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    // 错误不输出响应体、认证头、提示词或远端任意文本。
    if (!response.ok) throw new ConnectorHttpError(response.status);
    const result = await response.json() as any;
    if (!result.ok) throw Error('服务器拒绝连接器请求');
    return result;
  };
}
function authorizedPath(config: ConnectorConfig, workspace: string): string {
  const w = config.workspaces.find(w => w.id === workspace);
  if (!w) throw Error('项目未在本机授权');
  const path = checkProjectDir(w.path);
  if (!path || path !== w.path || realpathSync(w.path) !== w.path) throw Error('授权项目目录已变化，请重新登记');
  return path;
}
export function helloPayload(config: ConnectorConfig) {
  return { executors: EXEC_KINDS.filter(k => resolveBin(k)), workspaces: config.workspaces.flatMap(w => {
    try { authorizedPath(config, w.id); return [{ id: w.id, name: w.name }]; } catch { return []; }
  }) };
}

/** 完全退出进程后才上报结束；失去任意一次心跳即停止，不在断线后继续执行。 */
export async function executeTask(config: ConnectorConfig, task: ConnectorTask, request: ConnectorRequest, stop: AbortSignal,
  runner: LocalRunner = spawnLocalAgent, heartbeatMs = 3000): Promise<void> {
  const abort = new AbortController();
  const onStop = () => abort.abort(Error('连接器已停止'));
  stop.addEventListener('abort', onStop, { once: true });
  if (stop.aborted) onStop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: Promise<void> | undefined;
  const finishHeartbeats = new AbortController();
  let body: string | undefined; let progress: string | undefined;
  const base = `/attempts/${encodeURIComponent(task.attempt_id)}`;
  const redact = (text: string, streaming = false) => {
    const safe = text.split(config.token).join('[REDACTED]');
    // 正文是累计快照：末尾可能只是尚未输出完整的 token，先留在本机。
    // 后续快照会重新判定；不能等 token 完整后才撤回已发送的前缀。
    if (streaming) {
      for (let n = Math.min(config.token.length - 1, safe.length); n > 0; n--) {
        if (safe.endsWith(config.token.slice(0, n))) return safe.slice(0, -n);
      }
    }
    return safe;
  };
  const pulse = async () => {
    const sentBody = body, sentProgress = progress;
    const response = await request(`${base}/progress`, { body: sentBody, progress: sentProgress }, abort.signal);
    if (body === sentBody) body = undefined;
    if (progress === sentProgress) progress = undefined;
    if (response.cancel) throw Error('服务器已取消任务');
  };
  try {
    const cwd = authorizedPath(config, task.workspace_id);
    if (!EXEC_KINDS.includes(task.kind) || !Number.isFinite(task.timeout_ms) || task.timeout_ms <= 0 || !Number.isFinite(task.lease_ms) || task.lease_ms <= 0) throw Error('任务参数不正确');
    if (abort.signal.aborted) throw abort.signal.reason;
    await pulse();
    timer = setTimeout(() => abort.abort(Error('本机任务执行超时')), Math.min(task.timeout_ms, 24 * 60 * 60_000));
    heartbeat = (async () => {
      while (!finishHeartbeats.signal.aborted && !abort.signal.aborted) {
        try { await delay(Math.min(heartbeatMs, task.lease_ms / 3), undefined, { signal: finishHeartbeats.signal }); }
        catch { break; }
        if (finishHeartbeats.signal.aborted) break;
        try { await pulse(); } catch { abort.abort(Error('连接器失去心跳或任务已取消')); break; }
      }
    })();
    const text = await runner({ kind: task.kind, cwd, prompt: task.prompt, model: task.model, signal: abort.signal,
      onProgress: text => { progress = redact(text, true).slice(0, 200); }, onText: text => { body = redact(text, true).slice(0, 160_000); } });
    finishHeartbeats.abort(); await heartbeat;
    if (abort.signal.aborted) throw abort.signal.reason;
    await request(`${base}/complete`, { body: redact(text).slice(0, 160_000) }, abort.signal);
  } catch {
    // 包括取消、进程失败、无授权项目、断网。此时 runner 已退出或从未启动。
    abort.abort(); finishHeartbeats.abort(); await heartbeat;
    try { await request(`${base}/fail`, { error: '本机执行失败或已停止，请检查连接器及 CLI 配置' }); } catch { /* 服务器租约负责收尾 */ }
  } finally {
    if (timer) clearTimeout(timer);
    finishHeartbeats.abort(); stop.removeEventListener('abort', onStop);
  }
}

export async function runConnector(config: ConnectorConfig, stop: AbortSignal): Promise<void> {
  const request = requester(config);
  let nextHello = 0;
  while (!stop.aborted) {
    try {
      if (Date.now() >= nextHello) { await request('/hello', helloPayload(config), stop); nextHello = Date.now() + 15_000; }
      const { task } = await request('/claim?wait=20', {}, stop);
      if (task) { await executeTask(config, task, request, stop); nextHello = 0; }
    } catch (err) {
      if (stop.aborted) break;
      if (err instanceof ConnectorHttpError && err.status === 401) throw Error('设备已吊销或认证失效，请重新配对');
      console.error('连接器暂时无法连接服务器，5 秒后重试');
      nextHello = 0;
      try { await delay(5000, undefined, { signal: stop }); } catch { break; }
    }
  }
}
