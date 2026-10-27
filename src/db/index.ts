import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoomStatus } from '../domain/room.js';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS credentials (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  room_code  TEXT NOT NULL,
  role       TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  code          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  prd           TEXT NOT NULL DEFAULT '',
  op_scope      TEXT NOT NULL DEFAULT '',
  designer_seat TEXT NOT NULL DEFAULT 'A',
  status        TEXT NOT NULL DEFAULT 'designing',
  next_seq      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  member_id      TEXT PRIMARY KEY,
  room_code      TEXT NOT NULL,
  role           TEXT NOT NULL,
  credential_id  TEXT NOT NULL UNIQUE,
  read_cursor    INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  room_code  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  from_role  TEXT,
  from_user  TEXT,
  body       TEXT NOT NULL,
  reply_to   INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (room_code, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_code, seq);

CREATE TABLE IF NOT EXISTS plans (
  room_code   TEXT NOT NULL,
  version     INTEGER NOT NULL,
  doc_json    TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  author_role TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (room_code, version)
);

CREATE TABLE IF NOT EXISTS confirmations (
  id           TEXT PRIMARY KEY,
  room_code    TEXT NOT NULL,
  side         TEXT NOT NULL,
  name         TEXT NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('ok', 'issue')),
  note         TEXT NOT NULL DEFAULT '',
  plan_version INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_confirmations_room ON confirmations(room_code, created_at);
`;

export interface RoomRow {
  code: string;
  title: string;
  prd: string;
  op_scope: string;
  designer_seat: 'A' | 'B';
  status: RoomStatus;
  next_seq: number;
  created_at: string;
}

export interface MessageRow {
  id: string;
  room_code: string;
  seq: number;
  type: 'chat' | 'human' | 'proposal' | 'system';
  from_role: string | null;
  from_user: string | null;
  body: string;
  reply_to: number | null;
  created_at: string;
}

export interface MemberRow {
  member_id: string;
  room_code: string;
  role: string;
  credential_id: string;
  read_cursor: number;
  last_active_at: string;
}

export interface PlanRow {
  room_code: string;
  version: number;
  doc_json: string;
  summary: string;
  author_role: string;
  author_name: string;
  created_at: string;
}

export interface ConfirmationRow {
  id: string;
  room_code: string;
  side: 'frontend' | 'backend';
  name: string;
  verdict: 'ok' | 'issue';
  note: string;
  plan_version: number;
  created_at: string;
}

export interface CredentialRow {
  id: string;
  token_hash: string;
  room_code: string;
  role: string;
  name: string;
  created_at: string;
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

const depth = new WeakMap<DatabaseSync, number>();

/**
 * 显式事务。所有"分配 seq + 插入"都必须走这里。
 * 可重入：内层用 SAVEPOINT，外层 BEGIN IMMEDIATE。
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  const sp = `sp_${d}`;
  if (d === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${sp}`);
  depth.set(db, d + 1);
  try {
    const result = fn();
    if (d === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${sp}`);
    return result;
  } catch (err) {
    try {
      if (d === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    depth.set(db, d);
  }
}

export const now = (): string => new Date().toISOString();
