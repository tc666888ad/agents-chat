import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { now, tx } from '../db/index.js';
import { RtError } from './errors.js';
import { isExecKind, localTimeoutMs, type ExecKind } from './local-agent.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const uid = () => randomBytes(24).toString('base64url');
export const CONNECTOR_LEASE_MS = 60_000;
const ONLINE_MS = 90_000;
interface DeviceRow { id: string; name: string; executors: string; last_seen_at: string | null; revoked_at: string | null }
export interface ConnectorTaskRow {
  id: string; room_code: string; seq: number; device_id: string; workspace_id: string;
  state: string; attempt_id: string | null; lease_expires_at: number; queue_expires_at: number; deadline_at: number;
}
export interface ConnectorTask {
  attempt_id: string; room_code: string; seq: number; workspace_id: string;
  kind: ExecKind; model?: string; prompt: string; lease_ms: number; timeout_ms: number;
}
export interface DeviceView {
  id: string; name: string; online: boolean; last_seen_at: string | null; executors: ExecKind[];
  workspaces: { id: string; name: string }[];
}
interface Hooks {
  valid: (task: ConnectorTaskRow) => boolean;
  payload: (task: ConnectorTaskRow) => Pick<ConnectorTask, 'kind' | 'model' | 'prompt'>;
  progress: (task: ConnectorTaskRow, body: string | undefined, progress: string | undefined) => void;
  complete: (task: ConnectorTaskRow, text: string) => void;
  fail: (task: ConnectorTaskRow, reason: string) => void;
  changed: (device: string) => void;
}
const invalid = (message: string): never => { throw new RtError('VALIDATION_FAILED', message); };
const cleanId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) return invalid('工作区标识不正确');
  return value;
};

export class ConnectorStore {
  constructor(private db: DatabaseSync, private hooks: Hooks) {
    db.exec("UPDATE rt_connector_tasks SET state='error' WHERE state IN ('queued','running')");
    // 重启后设备必须重新 hello，不能沿用上次的在线状态。
    db.exec('UPDATE rt_devices SET last_seen_at=NULL');
  }
  createPairing(): { code: string; expires_at: string } {
    const code = uid(); const expires = Date.now() + 600_000;
    this.db.prepare('DELETE FROM rt_pairings WHERE expires_at < ? OR used_at IS NOT NULL').run(Date.now());
    this.db.prepare('INSERT INTO rt_pairings(code_hash,expires_at) VALUES (?,?)').run(hash(code), expires);
    return { code, expires_at: new Date(expires).toISOString() };
  }
  pair(code: string, name: string): { device_id: string; token: string } {
    if (typeof code !== 'string' || typeof name !== 'string' || !name.trim() || name.length > 80) return invalid('填写配对码和电脑名称（最多 80 字）');
    const device_id = `dev_${uid()}`; const token = `rtd_${uid()}`;
    tx(this.db, () => {
      const used = this.db.prepare('UPDATE rt_pairings SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>?').run(now(), hash(code.trim()), Date.now());
      if (!used.changes) invalid('配对码无效、已使用或已过期');
      this.db.prepare('INSERT INTO rt_devices(id,name,token_hash,created_at) VALUES (?,?,?,?)').run(device_id, name.trim(), hash(token), now());
    });
    return { device_id, token };
  }
  authenticate(token: string): string {
    const d = typeof token === 'string' && this.db.prepare('SELECT id FROM rt_devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(token)) as { id: string } | undefined;
    if (!d) throw new RtError('UNAUTHORIZED', '连接器认证失效，请重新配对');
    return d.id;
  }
  private device(device: string): DeviceRow {
    const d = this.db.prepare('SELECT * FROM rt_devices WHERE id=? AND revoked_at IS NULL').get(device) as DeviceRow | undefined;
    if (!d) throw new RtError('UNAUTHORIZED', '连接器已吊销，请重新配对');
    return d;
  }
  private touch(device: string): void { this.device(device); this.db.prepare('UPDATE rt_devices SET last_seen_at=? WHERE id=?').run(now(), device); }
  list(): DeviceView[] {
    const rows = this.db.prepare('SELECT * FROM rt_devices WHERE revoked_at IS NULL ORDER BY created_at').all() as unknown as DeviceRow[];
    return rows.map(d => ({ id: d.id, name: d.name, online: Boolean(d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < ONLINE_MS),
      last_seen_at: d.last_seen_at, executors: JSON.parse(d.executors), workspaces: this.workspaces(d.id) }));
  }
  private workspaces(device: string): { id: string; name: string }[] {
    return this.db.prepare('SELECT workspace_id AS id,name FROM rt_device_workspaces WHERE device_id=? ORDER BY name').all(device) as unknown as { id: string; name: string }[];
  }
  workspace(device: string, workspace: string): { id: string; name: string } {
    this.device(device);
    const w = this.workspaces(device).find(w => w.id === workspace);
    if (!w) throw new RtError('INVALID_STATE', '项目未被这台电脑授权，先在连接器添加项目');
    return w;
  }
  ready(device: string, workspace: string, kind: string): void {
    this.workspace(device, workspace);
    const d = this.list().find(d => d.id === device)!;
    if (!d.online) throw new RtError('INVALID_STATE', '成员电脑离线，请在该电脑启动连接器');
    if (!d.executors.includes(kind as ExecKind)) throw new RtError('INVALID_STATE', `这台电脑未找到 ${kind} 执行器`);
  }
  hello(device: string, input: { executors?: unknown; workspaces?: unknown }): { lease_ms: number } {
    this.device(device);
    if (!Array.isArray(input.executors) || input.executors.some(k => typeof k !== 'string' || !isExecKind(k))) return invalid('执行器列表不正确');
    if (!Array.isArray(input.workspaces) || input.workspaces.length > 100) return invalid('项目列表不正确（最多 100 个）');
    const spaces = input.workspaces.map(w => {
      if (!w || typeof w !== 'object' || typeof w.name !== 'string' || !w.name.trim() || w.name.length > 100) return invalid('项目显示名称不正确');
      return { id: cleanId(w.id), name: w.name.trim() };
    });
    if (new Set(spaces.map(w => w.id)).size !== spaces.length) return invalid('项目标识重复');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM rt_device_workspaces WHERE device_id=?').run(device);
      for (const w of spaces) this.db.prepare('INSERT INTO rt_device_workspaces VALUES (?,?,?)').run(device, w.id, w.name);
      this.db.prepare('UPDATE rt_devices SET executors=?,last_seen_at=? WHERE id=?').run(JSON.stringify([...new Set(input.executors as string[])]), now(), device);
    });
    for (const task of this.active(device)) {
      if (!spaces.some(w => w.id === task.workspace_id) || !this.hooks.valid(task)) this.expire(task, '项目授权或任务已变更');
      else {
        const kind = this.hooks.payload(task).kind;
        if (!(input.executors as string[]).includes(kind)) this.expire(task, '成员电脑执行器已不可用');
      }
    }
    this.hooks.changed(device);
    return { lease_ms: CONNECTOR_LEASE_MS };
  }
  enqueue(room: string, seq: number, device: string, workspace: string): void {
    this.db.prepare(`INSERT INTO rt_connector_tasks(id,room_code,seq,device_id,workspace_id,state,queue_expires_at,deadline_at)
      VALUES (?,?,?,?,?,'queued',?,?)`).run(uid(), room, seq, device, workspace, Date.now() + ONLINE_MS, Date.now() + localTimeoutMs());
  }
  private active(device?: string): ConnectorTaskRow[] {
    return this.db.prepare("SELECT * FROM rt_connector_tasks WHERE state IN ('queued','running')" + (device ? ' AND device_id=?' : '')).all(...(device ? [device] : [])) as unknown as ConnectorTaskRow[];
  }
  private expire(task: ConnectorTaskRow, reason: string): void {
    this.db.prepare("UPDATE rt_connector_tasks SET state='error' WHERE id=?").run(task.id);
    this.hooks.fail(task, reason);
  }
  sweep(): void {
    const time = Date.now();
    for (const task of this.active()) {
      if (!this.hooks.valid(task)) { this.cancel(task.room_code, task.seq); continue; }
      if (time >= task.deadline_at || (task.state === 'queued' ? time >= task.queue_expires_at : time >= task.lease_expires_at)) this.expire(task, '连接器离线或执行超时，请检查成员电脑后重试');
    }
  }
  claim(device: string): ConnectorTask | null {
    this.touch(device); this.sweep();
    return tx(this.db, () => {
    // 被取消但尚未确认停止的进程也占用租约，防止同时执行。
    if (this.db.prepare("SELECT 1 FROM rt_connector_tasks WHERE device_id=? AND lease_expires_at>? AND state IN ('running','cancelled')").get(device, Date.now())) return null;
    const task = this.db.prepare("SELECT * FROM rt_connector_tasks WHERE device_id=? AND state='queued' ORDER BY rowid LIMIT 1").get(device) as ConnectorTaskRow | undefined;
    if (!task) return null;
    this.ready(device, task.workspace_id, this.hooks.payload(task).kind);
    const payload = this.hooks.payload(task); const attempt = uid(); const remaining = task.deadline_at - Date.now();
    this.db.prepare("UPDATE rt_connector_tasks SET state='running',attempt_id=?,lease_expires_at=? WHERE id=? AND state='queued'").run(attempt, Date.now() + Math.min(CONNECTOR_LEASE_MS, remaining), task.id);
    return { ...payload, attempt_id: attempt, room_code: task.room_code, seq: task.seq, workspace_id: task.workspace_id,
      lease_ms: Math.min(CONNECTOR_LEASE_MS, remaining), timeout_ms: remaining };
    });
  }
  async waitClaim(device: string, seconds = 0, signal?: AbortSignal): Promise<ConnectorTask | null> {
    const deadline = Date.now() + Math.min(25, Math.max(0, Number(seconds) || 0)) * 1000;
    do {
      if (signal?.aborted) return null;
      const task = this.claim(device); if (task || Date.now() >= deadline) return task;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(500, deadline - Date.now())); signal?.addEventListener('abort', done, { once: true });
      });
    } while (Date.now() <= deadline);
    return null;
  }
  private attempt(device: string, attempt: string): ConnectorTaskRow {
    this.device(device); this.sweep();
    const task = this.db.prepare('SELECT * FROM rt_connector_tasks WHERE attempt_id=? AND device_id=?').get(attempt, device) as ConnectorTaskRow | undefined;
    if (!task || task.state !== 'running' || task.lease_expires_at <= Date.now() || !this.hooks.valid(task)) throw new RtError('INVALID_STATE', '任务已停止、过期或已完成');
    return task;
  }
  progress(device: string, attempt: string, input: { body?: unknown; progress?: unknown }): { cancel: boolean; lease_ms?: number } {
    this.device(device); this.sweep();
    const row = this.db.prepare('SELECT * FROM rt_connector_tasks WHERE attempt_id=? AND device_id=?').get(attempt, device) as ConnectorTaskRow | undefined;
    if (row?.state === 'cancelled' || row?.state === 'error') return { cancel: true };
    const task = this.attempt(device, attempt);
    if ((input.body !== undefined && typeof input.body !== 'string') || (input.progress !== undefined && typeof input.progress !== 'string')) return invalid('进度格式不正确');
    const lease = Math.min(CONNECTOR_LEASE_MS, task.deadline_at - Date.now());
    this.db.prepare('UPDATE rt_connector_tasks SET lease_expires_at=? WHERE id=?').run(Date.now() + lease, task.id);
    this.touch(device); this.hooks.progress(task, (input.body as string | undefined)?.slice(0, 160_000), (input.progress as string | undefined)?.slice(0, 200));
    return { cancel: false, lease_ms: lease };
  }
  complete(device: string, attempt: string, text: string): void {
    const task = this.attempt(device, attempt);
    if (typeof text !== 'string' || !text.trim() || text.length > 160_000) return invalid('结果不能为空且最多 160000 字');
    // 完成回调可能派发下一步。先释放当前租约；失败时保持失败状态，不能重复推进。
    this.db.prepare("UPDATE rt_connector_tasks SET state='done',lease_expires_at=0 WHERE id=?").run(task.id);
    try { this.hooks.complete(task, text); }
    catch (err) { this.expire(task, '保存连接器结果失败，请重试'); throw err; }
  }
  fail(device: string, attempt: string, reason: string): void {
    this.device(device);
    const row = this.db.prepare("SELECT * FROM rt_connector_tasks WHERE attempt_id=? AND device_id=? AND state='cancelled'").get(attempt, device) as ConnectorTaskRow | undefined;
    // 客户端只有在子进程完全退出后才确认取消，释放占用。
    if (row) { this.db.prepare('UPDATE rt_connector_tasks SET lease_expires_at=0 WHERE id=?').run(row.id); return; }
    const task = this.attempt(device, attempt);
    this.expire(task, String(reason || '连接器执行失败').slice(0, 300));
    this.db.prepare('UPDATE rt_connector_tasks SET lease_expires_at=0 WHERE id=?').run(task.id);
  }
  cancel(room: string, seq?: number): void {
    this.db.prepare("UPDATE rt_connector_tasks SET state='cancelled' WHERE room_code=? AND state IN ('queued','running')" + (seq === undefined ? '' : ' AND seq=?')).run(room, ...(seq === undefined ? [] : [seq]));
  }
  revoke(device: string): void {
    this.device(device);
    this.db.prepare('UPDATE rt_devices SET revoked_at=?,last_seen_at=NULL WHERE id=?').run(now(), device);
    for (const task of this.active(device)) this.expire(task, '成员电脑已被吊销');
    this.hooks.changed(device);
  }
}
