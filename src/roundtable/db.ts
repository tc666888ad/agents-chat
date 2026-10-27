export const RT_SCHEMA = `
CREATE TABLE IF NOT EXISTS rt_collaborations (
  id TEXT NOT NULL, room_code TEXT PRIMARY KEY, original_task TEXT NOT NULL,
  current_seq INTEGER NOT NULL, reply_count INTEGER NOT NULL DEFAULT 1,
  max_replies INTEGER NOT NULL DEFAULT 6, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  latest_plan_seq INTEGER, writer_id TEXT
);
CREATE TABLE IF NOT EXISTS rt_collaboration_steps (
  room_code TEXT NOT NULL, seq INTEGER NOT NULL, collaboration_id TEXT NOT NULL,
  token TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(room_code,seq)
);

CREATE TABLE IF NOT EXISTS rt_agents (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  model      TEXT NOT NULL,
  api_key    TEXT NOT NULL DEFAULT '',
  persona    TEXT NOT NULL DEFAULT '',
  runtime    TEXT NOT NULL DEFAULT 'api',
  token_hash TEXT NOT NULL DEFAULT '',
  token_hint TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rt_rooms (
  code       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  prd        TEXT NOT NULL DEFAULT '',
  next_seq   INTEGER NOT NULL DEFAULT 1,
  rev        INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rt_room_agents (
  room_code TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (room_code, agent_id)
);

CREATE TABLE IF NOT EXISTS rt_messages (
  id         TEXT PRIMARY KEY,
  room_code  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  agent_id   TEXT,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'streaming', 'done', 'error')),
  error      TEXT NOT NULL DEFAULT '',
  reply_to   INTEGER,
  targets    TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (room_code, seq)
);
CREATE INDEX IF NOT EXISTS idx_rt_messages_room_seq ON rt_messages(room_code, seq);

CREATE TABLE IF NOT EXISTS rt_docs (
  id         TEXT PRIMARY KEY,
  room_code  TEXT NOT NULL,
  name       TEXT NOT NULL,
  ext        TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  chars      INTEGER NOT NULL DEFAULT 0,
  text       TEXT NOT NULL DEFAULT '',
  file_name  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rt_docs_room ON rt_docs(room_code, created_at);

CREATE TABLE IF NOT EXISTS rt_artifacts (
  id         TEXT PRIMARY KEY,
  room_code  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('plan', 'review', 'final')),
  version    INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  author     TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  chars      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (room_code, file_name)
);
`;

/** 建表 + 给旧库补列（CREATE TABLE IF NOT EXISTS 不会改已有的表）。 */
export function migrateRt(db: { exec(sql: string): void; prepare(sql: string): { all(): unknown[] } }): void {
  db.exec(RT_SCHEMA);
  const agentCols = (db.prepare('PRAGMA table_info(rt_agents)').all() as { name: string }[]).map((c) => c.name);
  if (!agentCols.includes('runtime')) db.exec("ALTER TABLE rt_agents ADD COLUMN runtime TEXT NOT NULL DEFAULT 'api'");
  if (!agentCols.includes('token_hash')) db.exec("ALTER TABLE rt_agents ADD COLUMN token_hash TEXT NOT NULL DEFAULT ''");
  if (!agentCols.includes('token_hint')) db.exec("ALTER TABLE rt_agents ADD COLUMN token_hint TEXT NOT NULL DEFAULT ''");
  if (!agentCols.includes('last_seen_at')) db.exec('ALTER TABLE rt_agents ADD COLUMN last_seen_at TEXT');
  if (!agentCols.includes('local_base_url')) db.exec("ALTER TABLE rt_agents ADD COLUMN local_base_url TEXT NOT NULL DEFAULT ''");
  const cols = (db.prepare('PRAGMA table_info(rt_messages)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('stage')) db.exec("ALTER TABLE rt_messages ADD COLUMN stage TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('version')) db.exec('ALTER TABLE rt_messages ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('ref_seq')) db.exec('ALTER TABLE rt_messages ADD COLUMN ref_seq INTEGER');
  if (!cols.includes('progress')) db.exec("ALTER TABLE rt_messages ADD COLUMN progress TEXT NOT NULL DEFAULT ''");
  const roomCols = (db.prepare('PRAGMA table_info(rt_rooms)').all() as { name: string }[]).map((c) => c.name);
  if (!roomCols.includes('auto_collaborate')) db.exec('ALTER TABLE rt_rooms ADD COLUMN auto_collaborate INTEGER NOT NULL DEFAULT 0');
  if (!roomCols.includes('project_dir')) db.exec("ALTER TABLE rt_rooms ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''");
}

export type Stage = '' | 'plan' | 'review';

export interface AgentRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  local_base_url: string;
  persona: string;
  /** api：直连模型；mcp：外部客户端主动连接；local：服务端启动本机 Agent（base_url 存执行器 codex|dsh） */
  runtime: 'api' | 'mcp' | 'local';
  token_hash: string;
  token_hint: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RtRoomRow {
  auto_collaborate: number;
  code: string;
  title: string;
  prd: string;
  /** 绑定的业务项目目录（绝对路径，已 realpath）；'' 表示未绑定 */
  project_dir: string;
  next_seq: number;
  rev: number;
  created_at: string;
  updated_at: string;
}

export interface RtMessageRow {
  id: string;
  room_code: string;
  seq: number;
  kind: 'human' | 'agent' | 'system';
  agent_id: string | null;
  author: string;
  body: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
  error: string;
  reply_to: number | null;
  targets: string;
  /** '' 普通对话；plan 方案；review 审查 */
  stage: Stage;
  version: number;
  /** 审查 → 被审的方案 seq；修订方案 → 上一版方案 seq */
  ref_seq: number | null;
  /** 本地 Agent 运行阶段（排队/启动/读文件…），完成后保留最后一条 */
  progress: string;
  created_at: string;
  updated_at: string;
}

export interface RtDocRow {
  id: string;
  room_code: string;
  name: string;
  ext: string;
  size: number;
  chars: number;
  text: string;
  file_name: string;
  created_at: string;
}

export interface RtArtifactRow {
  id: string;
  room_code: string;
  kind: 'plan' | 'review' | 'final';
  version: number;
  seq: number;
  author: string;
  file_name: string;
  chars: number;
  created_at: string;
  updated_at: string;
}
