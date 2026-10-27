import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type CollaborationStatus = 'running' | 'waiting_human' | 'ready' | 'finished' | 'limit' | 'failed' | 'stopped';
export interface Collaboration {
  id: string; room_code: string; original_task: string; current_seq: number;
  reply_count: number; max_replies: number; status: CollaborationStatus; note: string;
  latest_plan_seq: number | null; writer_id: string | null;
}
export interface ControlIdentity { collaboration_id: string; seq: number; token: string }
export interface Control extends ControlIdentity {
  action: 'handoff' | 'ask_human' | 'ready' | 'finish';
  target_id?: string; task?: string; reason: string; plan_seq?: number;
}
const nonce = () => randomBytes(12).toString('hex');

/** 只解析 Markdown 顶层、唯一、位于末尾的专用代码块。正文中的 @ 不参与调度。 */
export function parseControl(text: string, identity: ControlIdentity): { body: string; control: Control | null; error: string } {
  const fail = (body = text.trim()) => ({ body, control: null, error: '缺少或无效的交接指令，请明确下一步后继续协作' });
  const lines = text.trimEnd().split('\n');
  let fence = ''; let width = 0; let start = -1; let end = -1; let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^ {0,3}```roundtable-control\s*$/.test(line)) count++;
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    if (!fence) {
      fence = m[1]![0]!; width = m[1]!.length;
      if (m[1] === '```' && m[2]!.trim() === 'roundtable-control') start = i;
    } else if (m[1]![0] === fence && m[1]!.length >= width && !m[2]!.trim()) {
      if (start >= 0 && end < 0) end = i;
      fence = '';
    }
  }
  if (start < 0 || end !== lines.length - 1 || count !== 1 || fence) return fail();
  const body = lines.slice(0, start).join('\n').trim();
  try {
    const c = JSON.parse(lines.slice(start + 1, end).join('\n')) as Control;
    if (!c || typeof c !== 'object' || Array.isArray(c) || !body) return fail(body);
    if (c.collaboration_id !== identity.collaboration_id || c.seq !== identity.seq || c.token !== identity.token) return fail(body);
    if (!['handoff', 'ask_human', 'ready', 'finish'].includes(c.action)) return fail(body);
    if (typeof c.reason !== 'string' || !c.reason.trim() || c.reason.length > 4000) return fail(body);
    if (c.action === 'handoff' && (typeof c.target_id !== 'string' || typeof c.task !== 'string' || !c.task.trim() || c.task.length > 8000)) return fail(body);
    if (c.action === 'ready' && !Number.isSafeInteger(c.plan_seq)) return fail(body);
    return { body, control: c, error: '' };
  } catch { return fail(body); }
}

/** 流式只展示正文；完整成功结果再进行协议验证。 */
export function visibleBody(text: string): string {
  const i = text.search(/(?:^|\n) {0,3}```roundtable-control/);
  return i < 0 ? text : text.slice(0, i).trimEnd();
}

export class CollaborationStore {
  constructor(private db: DatabaseSync) {}
  get(code: string): Collaboration | null {
    return (this.db.prepare('SELECT * FROM rt_collaborations WHERE room_code=?').get(code) as unknown as Collaboration) ?? null;
  }
  step(code: string, seq: number): { collaboration_id: string; token: string; processed: number } | undefined {
    return this.db.prepare('SELECT * FROM rt_collaboration_steps WHERE room_code=? AND seq=?').get(code, seq) as any;
  }
  identity(code: string, seq: number): ControlIdentity | null {
    const c = this.get(code), s = this.step(code, seq);
    return c?.status === 'running' && c.current_seq === seq && s?.collaboration_id === c.id && !s.processed
      ? { collaboration_id: c.id, seq, token: s.token } : null;
  }
  start(code: string, original: string, seq: number, writer: string | null, planSeq: number | null): void {
    this.db.prepare(`INSERT INTO rt_collaborations (id,room_code,original_task,current_seq,reply_count,max_replies,status,note,latest_plan_seq,writer_id)
      VALUES (?,?,?,?,1,6,'running','',?,?) ON CONFLICT(room_code) DO UPDATE SET id=excluded.id,original_task=excluded.original_task,current_seq=excluded.current_seq,reply_count=1,status='running',note='',latest_plan_seq=excluded.latest_plan_seq,writer_id=excluded.writer_id`)
      .run('co_' + nonce(), code, original, seq, planSeq, writer);
    this.addStep(code, seq);
  }
  addStep(code: string, seq: number): void {
    this.db.prepare('INSERT INTO rt_collaboration_steps (room_code,seq,collaboration_id,token,processed) VALUES (?,?,?,?,0)')
      .run(code, seq, this.get(code)!.id, nonce());
  }
  advance(code: string, seq: number, note = ''): void {
    this.db.prepare("UPDATE rt_collaborations SET current_seq=?,reply_count=reply_count+1,status='running',note=? WHERE room_code=?").run(seq, note, code);
    this.addStep(code, seq);
  }
  status(code: string, status: CollaborationStatus, note: string): void {
    this.db.prepare('UPDATE rt_collaborations SET status=?,note=? WHERE room_code=?').run(status, note, code);
  }
  processed(code: string, seq: number): void {
    this.db.prepare('UPDATE rt_collaboration_steps SET processed=1 WHERE room_code=? AND seq=?').run(code, seq);
  }
  plan(code: string, seq: number, writer: string): void {
    this.db.prepare('UPDATE rt_collaborations SET latest_plan_seq=?,writer_id=? WHERE room_code=?').run(seq, writer, code);
  }
  retry(code: string, seq: number): void {
    this.db.prepare("UPDATE rt_collaborations SET status='running',reply_count=reply_count+1,note='' WHERE room_code=?").run(code);
    this.db.prepare('UPDATE rt_collaboration_steps SET token=?,processed=0 WHERE room_code=? AND seq=?').run(nonce(), code, seq);
  }
}
