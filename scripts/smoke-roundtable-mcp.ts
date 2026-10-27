/** Local HTTP integration check. Uses an in-memory DB and temporary artifacts. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../src/db/index.js';
import { RoomFiles } from '../src/roundtable/files.js';
import { registerRoundtableMcp } from '../src/roundtable/mcp.js';
import { RoundtableService } from '../src/roundtable/service.js';

const root = mkdtempSync(join(tmpdir(), 'rt-http-smoke-'));
const db = openDb(':memory:');
const svc = new RoundtableService(db, undefined, new RoomFiles(root));
const app = Fastify();
const client = new Client({ name: 'roundtable-smoke', version: '1' });
try {
  const created = svc.createAgentWithToken({ name: 'HTTP-Inspector', runtime: 'mcp' });
  const code = svc.createRoom({ agent_ids: [created.agent.id] }).room.code;
  const doc = await svc.addDoc(code, '需求.md', Buffer.from('读取已有代码后出方案'));
  const reply = svc.startFlow(code, { action: 'plan', agent_id: created.agent.id }).replies[0];
  registerRoundtableMcp(app, svc);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/rt-mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${created.token}` } },
  }));
  assert.equal((await client.listTools()).tools.length, 8);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(Array.isArray(result.content));
    return JSON.parse(result.content[0].text);
  };
  const joined = await call('join_roundtable', { room_code: code });
  assert.equal(joined.room.room.code, code);
  assert.match((await call('read_roundtable_document', { room_code: code, doc_id: doc.doc.id })).document.text, /已有代码/);
  assert.match((await call('read_workspace_file', { path: 'AGENTS.md' })).file.text, /搜索规则/);
  assert.equal((await call('get_roundtable_tasks', { room_code: code })).tasks[0].seq, reply.seq);
  await call('complete_roundtable_task', { room_code: code, seq: reply.seq, body: '# HTTP 方案\n已读取项目上下文。' });
  assert.equal(svc.snapshot(code).messages.find((m) => m.seq === reply.seq)?.status, 'done');
  assert.match(readFileSync(join(root, code, 'plan-v1.md'), 'utf8'), /HTTP 方案/);
  console.log('HTTP MCP: initialize → 8 tools → join → document/workspace → task → artifact passed');
} finally {
  await client.close();
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
