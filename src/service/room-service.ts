import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  now,
  tx,
  type ConfirmationRow,
  type CredentialRow,
  type MemberRow,
  type MessageRow,
  type PlanRow,
  type RoomRow,
} from '../db/index.js';
import {
  deriveTodos,
  isAgentRole,
  isHumanRole,
  isRole,
  mentionsRole,
  nextHint,
  ROLE_LABEL,
  rulesDigest,
  STATUS_LABEL,
  type HumanRole,
  type Role,
  type RoomStatus,
  type Todo,
} from '../domain/room.js';
import { diffDocs, diffSummary, type DiffEntry } from '../domain/diff.js';
import { validateOpenApi, type OperationSummary } from '../domain/openapi.js';
import type { RoomHub } from '../infra/hub.js';

export type ErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE';

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_MESSAGE_CHARS = 8000;
const MAX_DIFF_ENTRIES = 300;

export interface TokenInfo {
  seat?: 'A' | 'B';
  role: Role;
  name: string;
  token: string;
}

export interface RoomView {
  code: string;
  title: string;
  prd: string;
  op_scope: string;
  status: RoomStatus;
  status_label: string;
  designer_seat: 'A' | 'B';
  created_at: string;
}

export interface PlanMeta {
  version: number;
  summary: string;
  author_role: string;
  author_label: string;
  created_at: string;
  changed: number;
  diff_summary: string;
}

export interface MessageView {
  seq: number;
  type: MessageRow['type'];
  role: string | null;
  speaker: string;
  body: string;
  time: string;
  reply_to: number | null;
}

export interface MemberView {
  role: string;
  label: string;
  name: string;
  last_active_at: string;
}

export interface ConfirmView {
  side: HumanRole;
  label: string;
  status: 'pending' | 'ok' | 'issue' | 'stale';
  name: string | null;
  note: string;
  at: string | null;
}

export interface Bootstrap {
  room: RoomView;
  you: { role: Role; label: string; seat?: 'A' | 'B' };
  plan: PlanMeta | null;
  messages: MessageView[];
  members: MemberView[];
  my_todos: Todo[];
  next_hint: string;
  rules: string;
}

export interface MessagesResult {
  messages: MessageView[];
  next_cursor: number;
  my_todos: Todo[];
  next_hint: string;
  status: RoomStatus;
  status_label: string;
}

export interface Snapshot {
  room: RoomView;
  plan: PlanMeta | null;
  history: PlanMeta[];
  confirmations: ConfirmView[];
  members: MemberView[];
  messages: MessageView[];
  last_seq: number;
}

export interface PlanPayload {
  plan: (PlanMeta & { doc: Record<string, unknown>; ops: OperationSummary[] }) | null;
  diff: DiffEntry[];
  history: { created_at: string; author_label: string; summary: string; changed: number }[];
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return `nrt_${randomBytes(24).toString('base64url')}`;
}

function newRoomCode(): string {
  return `ROOM-${randomBytes(2).toString('hex').toUpperCase()}`;
}

function authorLabel(role: string, name: string): string {
  const label = ROLE_LABEL[role] ?? role;
  if (!name || name === label) return label;
  return `${label} · ${name}`;
}

export function speakerLabel(row: MessageRow): string {
  if (row.type === 'human') return row.from_user || '人';
  if (row.type === 'system') return '系统';
  const role = isRole(row.from_role) ? ROLE_LABEL[row.from_role] : (row.from_role ?? '');
  if (!row.from_user) return role;
  if (row.from_user === role || row.from_user.startsWith(role)) return row.from_user;
  return `${role} · ${row.from_user}`;
}

/**
 * 房间的唯一业务入口。MCP（agent）和 HTTP（网页）都只调这里。
 */
export class RoomService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: RoomHub,
  ) {}

  // ---------- 身份 ----------

  authenticate(token: string): CredentialRow {
    if (!token) throw new ServiceError('FORBIDDEN', '缺少入场券');
    const row = this.db.prepare('SELECT * FROM credentials WHERE token_hash = ?').get(hash(token)) as
      | CredentialRow
      | undefined;
    if (!row) throw new ServiceError('FORBIDDEN', '入场券无效');
    return row;
  }

  whoami(token: string): { role: Role; name: string; room_code: string; label: string } | null {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM credentials WHERE token_hash = ?').get(hash(token)) as
      | CredentialRow
      | undefined;
    if (!row || !isRole(row.role)) return null;
    return { role: row.role, name: row.name, room_code: row.room_code, label: ROLE_LABEL[row.role] };
  }

  private mint(roomCode: string, role: Role, name: string): string {
    const token = newToken();
    const at = now();
    tx(this.db, () => {
      this.db
        .prepare('INSERT INTO credentials (id, token_hash, room_code, role, name, created_at) VALUES (?,?,?,?,?,?)')
        .run(`cred_${randomBytes(6).toString('hex')}`, hash(token), roomCode, role, name, at);
      this.db
        .prepare(
          'INSERT INTO room_members (member_id, room_code, role, credential_id, read_cursor, last_active_at) VALUES (?,?,?,?,0,?)',
        )
        .run(`mem_${randomBytes(6).toString('hex')}`, roomCode, role, hash(token), at);
    });
    return token;
  }

  // ---------- 房间 ----------

  createRoom(input: { title: string; prd?: string; op_scope?: string; designer_seat?: 'A' | 'B' }): {
    room: RoomView;
    tokens: TokenInfo[];
  } {
    const title = (input.title ?? '').trim();
    if (!title) throw new ServiceError('VALIDATION_FAILED', '房间需要一个标题');
    if (title.length > 200) throw new ServiceError('VALIDATION_FAILED', '标题最长 200 字');
    const prd = input.prd ?? '';
    if (prd.length > 60_000) throw new ServiceError('VALIDATION_FAILED', 'PRD 最长 6 万字');
    const designerSeat = input.designer_seat === 'B' ? 'B' : 'A';
    const code = newRoomCode();

    tx(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO rooms (code, title, prd, op_scope, designer_seat, status, next_seq, created_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(code, title, prd, input.op_scope ?? '', designerSeat, 'designing', 1, now());
      this.appendMessage(code, {
        type: 'system',
        fromRole: null,
        fromUser: null,
        body: `房间已创建：${title}。设计方先出方案，复核方逐条核对。`,
        replyTo: null,
      });
    });

    const seatA = designerSeat === 'A' ? 'designer' : 'reviewer';
    const seatB = designerSeat === 'A' ? 'reviewer' : 'designer';
    const tokenA = this.mint(code, seatA as Role, '');
    const tokenB = this.mint(code, seatB as Role, '');
    const backendToken = this.mint(code, 'backend', '后端');

    return {
      room: this.roomView(this.room(code)),
      tokens: [
        { seat: 'A', role: seatA as Role, name: ROLE_LABEL[seatA]!, token: tokenA },
        { seat: 'B', role: seatB as Role, name: ROLE_LABEL[seatB]!, token: tokenB },
        { role: 'backend', name: '后端', token: backendToken },
      ],
    };
  }

  listRooms(): (RoomView & { plan_count: number; last_speaker: string | null; last_at: string | null })[] {
    const rows = this.db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all() as unknown as RoomRow[];
    return rows.map((r) => {
      const planCount = (
        this.db.prepare('SELECT COUNT(*) AS n FROM plans WHERE room_code = ?').get(r.code) as { n: number }
      ).n;
      const last = this.db
        .prepare('SELECT * FROM messages WHERE room_code = ? ORDER BY seq DESC LIMIT 1')
        .get(r.code) as MessageRow | undefined;
      return {
        ...this.roomView(r),
        plan_count: planCount,
        last_speaker: last ? speakerLabel(last) : null,
        last_at: last?.created_at ?? null,
      };
    });
  }

  getRoom(code: string): RoomView {
    return this.roomView(this.room(code));
  }

  private room(code: string): RoomRow {
    const row = this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(code) as RoomRow | undefined;
    if (!row) throw new ServiceError('NOT_FOUND', `没有这个房间：${code}`);
    return row;
  }

  private roomView(row: RoomRow): RoomView {
    return {
      code: row.code,
      title: row.title,
      prd: row.prd,
      op_scope: row.op_scope,
      status: row.status,
      status_label: STATUS_LABEL[row.status] ?? row.status,
      designer_seat: row.designer_seat,
      created_at: row.created_at,
    };
  }

  // ---------- 加入 / 消息 ----------

  join(cred: CredentialRow): Bootstrap {
    const row = this.room(cred.room_code);
    if (!isRole(cred.role)) throw new ServiceError('FORBIDDEN', '入场券角色无效');
    const latest = this.latestPlan(row.code);
    const messages = this.readMessages(row.code, 0, 60);
    this.touch(cred.room_code, cred.role, messages.at(-1)?.seq ?? 0);
    const todos = this.todosFor(row.code, cred.role);
    return {
      room: this.roomView(row),
      you: { role: cred.role, label: ROLE_LABEL[cred.role]!, seat: cred.role === 'designer' ? row.designer_seat : undefined },
      plan: latest ? this.planMeta(latest) : null,
      messages,
      members: this.membersOf(row.code),
      my_todos: todos,
      next_hint: nextHint({
        role: cred.role,
        status: row.status,
        hasPlan: Boolean(latest),
        hasTodos: todos.length > 0,
        hasNewMessages: messages.some((m) => m.type !== 'proposal' && m.type !== 'system'),
      }),
      rules: rulesDigest(),
    };
  }

  async getMessages(
    cred: CredentialRow,
    input: { cursor?: number | null; wait_seconds?: number | null; limit?: number | null },
  ): Promise<MessagesResult> {
    const room = this.room(cred.room_code);
    const cursor = input.cursor ?? this.readCursor(cred.room_code, cred.role);
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new ServiceError('VALIDATION_FAILED', 'cursor 必须是非负整数');
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const waitMs = Math.min(Math.max(input.wait_seconds ?? 0, 0), 30) * 1000;

    const fetchNew = () => this.messagesAfter(cred.room_code, cursor, limit);
    let rows = fetchNew();
    if (rows.length === 0 && waitMs > 0) {
      await this.hub.wait(cred.room_code, waitMs);
      rows = fetchNew();
    }

    const messages = rows.map((r) => this.messageView(r));
    if (rows.length) this.touch(cred.room_code, cred.role, rows[rows.length - 1]!.seq);
    const role: Role = isRole(cred.role) ? cred.role : 'designer';
    const todos = this.todosFor(room.code, role);
    return {
      messages,
      next_cursor: rows.length ? rows[rows.length - 1]!.seq : cursor,
      my_todos: todos,
      next_hint: nextHint({
        role,
        status: room.status,
        hasPlan: Boolean(this.latestPlan(room.code)),
        hasTodos: todos.length > 0,
        hasNewMessages: messages.some((m) => m.type !== 'proposal' && m.type !== 'system'),
      }),
      status: room.status,
      status_label: STATUS_LABEL[room.status] ?? room.status,
    };
  }

  sendMessage(cred: CredentialRow, input: { text: string; reply_to?: number | null }): { message: MessageView; next_cursor: number } {
    if (!isRole(cred.role)) throw new ServiceError('FORBIDDEN', '入场券角色无效');
    const text = (input.text ?? '').trim();
    if (!text) throw new ServiceError('VALIDATION_FAILED', '消息不能为空');
    if (text.length > MAX_MESSAGE_CHARS) throw new ServiceError('VALIDATION_FAILED', `消息最长 ${MAX_MESSAGE_CHARS} 字`);
    const replyTo = this.checkReplyTo(cred.room_code, input.reply_to);
    const hasHuman = isHumanRole(cred.role);
    const message = this.appendMessage(cred.room_code, {
      type: hasHuman ? 'human' : 'chat',
      fromRole: cred.role,
      fromUser: hasHuman ? cred.name || '人' : '',
      body: text,
      replyTo,
    });
    this.touch(cred.room_code, cred.role, message.seq);
    return { message: this.messageView(message), next_cursor: message.seq };
  }

  /** 网页上以「人」的身份发言：必须持人类角色的入场券。 */
  postHumanMessage(cred: CredentialRow, input: { text: string; reply_to?: number | null }): MessageView {
    if (!isHumanRole(cred.role)) {
      throw new ServiceError('FORBIDDEN', '只有持「人」的入场券才能以人身份发言');
    }
    const text = (input.text ?? '').trim();
    if (!text) throw new ServiceError('VALIDATION_FAILED', '消息不能为空');
    if (text.length > MAX_MESSAGE_CHARS) throw new ServiceError('VALIDATION_FAILED', `消息最长 ${MAX_MESSAGE_CHARS} 字`);
    const message = this.appendMessage(cred.room_code, {
      type: 'human',
      fromRole: cred.role,
      fromUser: cred.name || '人',
      body: text,
      replyTo: this.checkReplyTo(cred.room_code, input.reply_to),
    });
    this.touch(cred.room_code, cred.role, message.seq);
    return this.messageView(message);
  }

  // ---------- 接口方案 ----------

  submitPlan(cred: CredentialRow, input: { openapi: unknown; summary?: string }): {
    ok: true;
    version: number;
    summary: string;
    diff_summary: string;
    changed: number;
    diff: DiffEntry[];
    history_count: number;
  } {
    if (cred.role !== 'designer') throw new ServiceError('FORBIDDEN', '只有设计方能提交接口方案');
    const summary = (input.summary ?? '').trim();
    if (summary.length > 1000) throw new ServiceError('VALIDATION_FAILED', '摘要最长 1000 字');

    const { openapi } = input;
    if (!openapi || typeof openapi !== 'object' || Array.isArray(openapi)) {
      throw new ServiceError('VALIDATION_FAILED', 'openapi 必须是对象');
    }
    const docJson = JSON.stringify(openapi);
    if (Buffer.byteLength(docJson, 'utf8') > MAX_PLAN_BYTES) {
      throw new ServiceError('VALIDATION_FAILED', '接口方案最大 1 MB');
    }
    const checked = validateOpenApi(openapi);
    if (!checked.ok) throw new ServiceError('VALIDATION_FAILED', checked.message);

    const room = this.room(cred.room_code);
    const latest = this.latestPlan(room.code);
    const version = (latest?.version ?? 0) + 1;
    const baseDoc = latest ? (JSON.parse(latest.doc_json) as Record<string, unknown>) : {};
    const diff = latest ? diffDocs(baseDoc, openapi as Record<string, unknown>) : [];
    const diffText = latest ? diffSummary(diff) : '初版';

    tx(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO plans (room_code, version, doc_json, summary, author_role, author_name, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(room.code, version, docJson, summary, cred.role, cred.name, now());
      this.appendMessage(room.code, {
        type: 'proposal',
        fromRole: cred.role,
        fromUser: cred.name,
        body: `${summary || '提交了接口方案'}（改动 ${diffText}）`,
        replyTo: null,
      });
      if (room.status === 'designing' || room.status === 'ready') this.updateStatus(room.code, 'reviewing');
    });
    this.hub.notify(room.code);
    return {
      ok: true,
      version,
      summary,
      diff_summary: diffText,
      changed: diff.length,
      diff: diff.slice(0, MAX_DIFF_ENTRIES),
      history_count: version,
    };
  }

  getPlan(cred: CredentialRow, input: { version?: number | null; history?: boolean | null }): {
    ok: true;
    plan: (PlanMeta & { doc: Record<string, unknown>; ops: OperationSummary[] }) | null;
    diff: DiffEntry[];
    history: { created_at: string; author_label: string; summary: string; changed: number }[];
  } {
    const room = this.room(cred.room_code);
    const all = this.allPlans(room.code);
    const latest = all[0] ?? null;
    const wanted = input.version ?? latest?.version ?? null;
    if (!wanted) return { ok: true, plan: null, diff: [], history: [] };
    const plan = all.find((p) => p.version === wanted) ?? null;
    if (!plan) throw new ServiceError('NOT_FOUND', '这版接口方案已经找不到了，用 get_plan 不带版本读最新一版');
    const prev = all.find((p) => p.version < plan.version);
    const doc = JSON.parse(plan.doc_json) as Record<string, unknown>;
    const diff = prev ? diffDocs(JSON.parse(prev.doc_json) as Record<string, unknown>, doc) : [];
    const checked = validateOpenApi(doc);
    return {
      ok: true,
      plan: { ...this.planMeta(plan), doc, ops: checked.ok ? checked.ops : [] },
      diff: diff.slice(0, MAX_DIFF_ENTRIES),
      history: input.history ? all.map((p) => this.historyEntry(p, all)) : [],
    };
  }

  /** 网页用：最新或指定的接口方案 + 相对上一版的改动 + 历史。 */
  planView(code: string, version?: number | null): PlanPayload {
    const all = this.allPlans(code);
    const latest = all[0] ?? null;
    const wanted = version ?? latest?.version ?? null;
    const plan = wanted ? (all.find((p) => p.version === wanted) ?? null) : null;
    if (!plan) return { plan: null, diff: [], history: [] };
    const prev = all.find((p) => p.version < plan.version);
    const doc = JSON.parse(plan.doc_json) as Record<string, unknown>;
    const diff = prev ? diffDocs(JSON.parse(prev.doc_json) as Record<string, unknown>, doc) : [];
    const checked = validateOpenApi(doc);
    return {
      plan: { ...this.planMeta(plan), doc, ops: checked.ok ? checked.ops : [] },
      diff: diff.slice(0, MAX_DIFF_ENTRIES),
      history: all.map((p) => this.historyEntry(p, all)),
    };
  }

  // ---------- 人工确认 / 邀请 ----------

  invite(
    cred: CredentialRow,
    input: { side?: '' | HumanRole; name?: string },
  ): { token: string; role: HumanRole; link: string } {
    if (!isHumanRole(cred.role)) throw new ServiceError('FORBIDDEN', '只有人能发审阅链接');
    const room = this.room(cred.room_code);
    const side: HumanRole =
      input.side === 'backend' ? 'backend' : input.side === 'frontend' ? 'frontend' : (cred.role as HumanRole);
    const name = (input.name ?? ROLE_LABEL[side]).trim() || ROLE_LABEL[side]!;
    const token = this.mint(room.code, side, name);
    if (room.status === 'designing') this.updateStatus(room.code, 'reviewing');
    return { token, role: side, link: `/room/${room.code}?token=${token}` };
  }

  confirm(
    cred: CredentialRow,
    input: { verdict?: 'ok' | 'issue'; note?: string },
  ): { confirmations: ConfirmView[]; status: RoomStatus; status_label: string } {
    if (!isHumanRole(cred.role)) throw new ServiceError('FORBIDDEN', '只有人能确认接口方案');
    const room = this.room(cred.room_code);
    const latest = this.latestPlan(room.code);
    if (!latest) throw new ServiceError('INVALID_STATE', '还没有接口方案可以确认');
    const verdict = input.verdict === 'issue' ? 'issue' : 'ok';
    const note = (input.note ?? '').trim();
    if (verdict === 'issue' && !note) throw new ServiceError('VALIDATION_FAILED', '有意见请写一句话，方便 agent 改');

    const side = cred.role;
    tx(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO confirmations (id, room_code, side, name, verdict, note, plan_version, created_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(`cf_${randomBytes(6).toString('hex')}`, room.code, side, cred.name, verdict, note, latest.version, now());
      this.appendMessage(room.code, {
        type: 'human',
        fromRole: side,
        fromUser: cred.name,
        body: verdict === 'ok' ? '我确认这版方案可以开发。' : `我有意见：${note}`,
        replyTo: null,
      });
    });
    const status = this.recomputeStatus(room.code);
    this.hub.notify(room.code);
    return { confirmations: this.confirmations(room.code), status, status_label: STATUS_LABEL[status] ?? status };
  }

  closeRoom(cred: CredentialRow): void {
    if (!isHumanRole(cred.role)) throw new ServiceError('FORBIDDEN', '只有人能关闭房间');
    const room = this.room(cred.room_code);
    this.updateStatus(room.code, 'closed');
    this.appendMessage(room.code, {
      type: 'system',
      fromRole: null,
      fromUser: null,
      body: '房间已关闭。',
      replyTo: null,
    });
    this.hub.notify(room.code);
  }

  private recomputeStatus(code: string): RoomStatus {
    const room = this.room(code);
    if (room.status === 'closed') return 'closed';
    const latest = this.latestPlan(code);
    if (!latest) return 'designing';
    const fresh = this.confirmations(code).filter((c) => c.status === 'ok' || c.status === 'issue');
    const okSides = new Set(fresh.filter((c) => c.status === 'ok').map((c) => c.side));
    const issues = fresh.filter((c) => c.status === 'issue');
    if (okSides.has('frontend') && okSides.has('backend') && issues.length === 0) {
      this.updateStatus(code, 'ready');
      return 'ready';
    }
    if (room.status === 'designing' && fresh.length === 0) return 'designing';
    this.updateStatus(code, 'reviewing');
    return 'reviewing';
  }

  // ---------- 快照 ----------

  snapshot(code: string, afterSeq: number): Snapshot {
    const room = this.room(code);
    const latest = this.latestPlan(code);
    return {
      room: this.roomView(room),
      plan: latest ? this.planMeta(latest) : null,
      history: this.allPlans(code).map((p) => this.planMeta(p)),
      confirmations: this.confirmations(code),
      members: this.membersOf(code),
      messages: this.readMessages(code, afterSeq, 200),
      last_seq: this.maxSeq(code),
    };
  }

  // ---------- 内部 ----------

  private appendMessage(
    roomCode: string,
    input: { type: MessageRow['type']; fromRole: string | null; fromUser: string | null; body: string; replyTo: number | null },
  ): MessageRow {
    let seq = 0;
    tx(this.db, () => {
      const room = this.db.prepare('SELECT next_seq FROM rooms WHERE code = ?').get(roomCode) as { next_seq: number };
      seq = room.next_seq;
      this.db
        .prepare(
          'INSERT INTO messages (id, room_code, seq, type, from_role, from_user, body, reply_to, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          `msg_${randomBytes(6).toString('hex')}`,
          roomCode,
          seq,
          input.type,
          input.fromRole,
          input.fromUser,
          input.body,
          input.replyTo,
          now(),
        );
      this.db.prepare('UPDATE rooms SET next_seq = next_seq + 1 WHERE code = ?').run(roomCode);
    });
    const row = this.db
      .prepare('SELECT * FROM messages WHERE room_code = ? AND seq = ?')
      .get(roomCode, seq) as unknown as MessageRow;
    this.hub.notify(roomCode);
    return row;
  }

  private messageView(row: MessageRow): MessageView {
    return {
      seq: row.seq,
      type: row.type,
      role: row.from_role,
      speaker: speakerLabel(row),
      body: row.body,
      time: row.created_at,
      reply_to: row.reply_to,
    };
  }

  private readMessages(code: string, after: number, limit: number): MessageView[] {
    return this.messagesAfter(code, after, limit).map((m) => this.messageView(m));
  }

  private messagesAfter(code: string, cursor: number, limit: number): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE room_code = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(code, cursor, limit) as unknown as MessageRow[];
  }

  private maxSeq(code: string): number {
    const row = this.db.prepare('SELECT MAX(seq) AS n FROM messages WHERE room_code = ?').get(code) as { n: number | null };
    return row.n ?? 0;
  }

  private checkReplyTo(roomCode: string, replyTo: number | null | undefined): number | null {
    if (replyTo == null) return null;
    if (!Number.isInteger(replyTo) || replyTo <= 0) throw new ServiceError('VALIDATION_FAILED', 'reply_to 必须是正整数');
    const exists = this.db
      .prepare('SELECT 1 AS x FROM messages WHERE room_code = ? AND seq = ?')
      .get(roomCode, replyTo) as { x: number } | undefined;
    if (!exists) throw new ServiceError('VALIDATION_FAILED', `reply_to 指向的消息不存在：${replyTo}`);
    return replyTo;
  }

  private latestPlan(code: string): PlanRow | null {
    return (this.db.prepare('SELECT * FROM plans WHERE room_code = ? ORDER BY version DESC LIMIT 1').get(code) as
      | PlanRow
      | undefined) ?? null;
  }

  private allPlans(code: string): PlanRow[] {
    return this.db.prepare('SELECT * FROM plans WHERE room_code = ? ORDER BY version DESC').all(code) as unknown as PlanRow[];
  }

  private planMeta(row: PlanRow): PlanMeta {
    const prev = this.db
      .prepare('SELECT * FROM plans WHERE room_code = ? AND version < ? ORDER BY version DESC LIMIT 1')
      .get(row.room_code, row.version) as PlanRow | undefined;
    const diff = prev
      ? diffDocs(JSON.parse(prev.doc_json) as Record<string, unknown>, JSON.parse(row.doc_json) as Record<string, unknown>)
      : [];
    return {
      version: row.version,
      summary: row.summary,
      author_role: row.author_role,
      author_label: authorLabel(row.author_role, row.author_name),
      created_at: row.created_at,
      changed: diff.length,
      diff_summary: prev ? diffSummary(diff) : '初版',
    };
  }

  private historyEntry(
    row: PlanRow,
    all: PlanRow[],
  ): { created_at: string; author_label: string; summary: string; changed: number } {
    const prev = all.find((p) => p.version < row.version);
    const diff = prev
      ? diffDocs(JSON.parse(prev.doc_json) as Record<string, unknown>, JSON.parse(row.doc_json) as Record<string, unknown>)
      : [];
    return {
      created_at: row.created_at,
      author_label: authorLabel(row.author_role, row.author_name),
      summary: row.summary,
      changed: diff.length,
    };
  }

  private confirmations(code: string): ConfirmView[] {
    const latest = this.latestPlan(code);
    const rows = this.db
      .prepare('SELECT * FROM confirmations WHERE room_code = ? ORDER BY created_at ASC')
      .all(code) as unknown as ConfirmationRow[];
    const sides: HumanRole[] = ['frontend', 'backend'];
    return sides.map((side) => {
      const mine = rows.filter((r) => r.side === side);
      const last = mine.at(-1);
      const fresh = last && latest ? last.plan_version === latest.version : false;
      return {
        side,
        label: ROLE_LABEL[side]!,
        status: !last ? 'pending' : fresh ? last.verdict : 'stale',
        name: last?.name ?? null,
        note: last?.note ?? '',
        at: last?.created_at ?? null,
      };
    });
  }

  private membersOf(code: string): MemberView[] {
    const rows = this.db
      .prepare('SELECT * FROM room_members WHERE room_code = ? ORDER BY last_active_at DESC')
      .all(code) as unknown as MemberRow[];
    const nameByRole = new Map<string, string>();
    for (const row of rows) {
      const cred = this.db
        .prepare('SELECT * FROM credentials WHERE token_hash = ?')
        .get(row.credential_id) as CredentialRow | undefined;
      if (cred?.name) nameByRole.set(row.role, cred.name);
    }
    return rows.map((r) => ({
      role: r.role,
      label: ROLE_LABEL[r.role] ?? r.role,
      name: nameByRole.get(r.role) ?? '',
      last_active_at: r.last_active_at,
    }));
  }

  private readCursor(code: string, role: string): number {
    const row = this.db
      .prepare('SELECT read_cursor FROM room_members WHERE room_code = ? AND role = ?')
      .get(code, role) as { read_cursor: number } | undefined;
    return row?.read_cursor ?? 0;
  }

  private touch(code: string, role: string, seq: number): void {
    this.db
      .prepare(
        'UPDATE room_members SET last_active_at = ?, read_cursor = MAX(read_cursor, ?) WHERE room_code = ? AND role = ?',
      )
      .run(now(), seq, code, role);
  }

  private todosFor(code: string, role: Role): Todo[] {
    const pending = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.room_code = ? AND m.type IN ('chat', 'human') AND m.from_role <> ?
           AND NOT EXISTS (
             SELECT 1 FROM messages r
             WHERE r.room_code = m.room_code AND r.reply_to = m.seq AND r.from_role = ?
           )
         ORDER BY m.seq ASC LIMIT 20`,
      )
      .all(code, role, role) as unknown as MessageRow[];
    const mine = pending.filter((m) => mentionsRole(m.body, role));
    return deriveTodos(
      mine.map((m) => ({ seq: m.seq, body: m.body, from_role: m.from_role, created_at: m.created_at })),
      role,
    );
  }

  private updateStatus(code: string, status: RoomStatus): void {
    this.db.prepare('UPDATE rooms SET status = ? WHERE code = ?').run(status, code);
  }
}
