import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openDb } from '../src/db/index.js';
import type { LlmCaller } from '../src/roundtable/llm.js';
import { demoCaller } from '../src/roundtable/llm.js';
import { resolveTargets } from '../src/roundtable/mentions.js';
import { MAX_AGENTS_PER_ROOM, RoundtableService, RtError } from '../src/roundtable/service.js';
import { RoomFiles } from '../src/roundtable/files.js';

const echo: LlmCaller = async (req) => {
  const text = `回复：${req.messages.at(-1)?.content ?? ''}`;
  req.onText(text);
  return text;
};

function setup(real: LlmCaller = echo) {
  const svc = new RoundtableService(openDb(':memory:'), { real, demo: demoCaller(1) });
  const a = svc.createAgent({ name: 'DeepSeek', base_url: 'https://example.com', model: 'm', api_key: 'sk-x' });
  const b = svc.createAgent({ name: 'Deep', base_url: 'demo' });
  const room = svc.createRoom({ title: '测试', agent_ids: [a.id, b.id] });
  return { svc, a, b, code: room.room.code };
}

async function settle(svc: RoundtableService, code: string) {
  for (let i = 0; i < 200; i++) {
    const s = svc.snapshot(code);
    if (s.messages.every((m) => m.status === 'done' || m.status === 'error')) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('回复一直没结束');
}

test('@ 解析：长名字优先，@所有人 = 全部，没 @ = 全部', () => {
  const agents = [
    { id: '1', name: 'Deep' },
    { id: '2', name: 'DeepSeek' },
    { id: '3', name: 'Kimi' },
  ];
  assert.deepEqual(resolveTargets('@DeepSeek 你看看', agents).targets.map((t) => t.id), ['2']);
  assert.deepEqual(resolveTargets('@deep 和 @kimi', agents).targets.map((t) => t.id), ['1', '3']);
  assert.equal(resolveTargets('大家好', agents).all, true);
  assert.equal(resolveTargets('@所有人 看下', agents).targets.length, 3);
  assert.equal(resolveTargets('@不存在 你好', agents).all, true);
});

test('没 @ 全员回答；@ 谁只有谁回答；agent 回复不会再触发别人', async () => {
  const { svc, a, b, code } = setup();
  const r1 = svc.postMessage(code, '大家好');
  assert.deepEqual(r1.replies.map((r) => r.agent_id).sort(), [a.id, b.id].sort());
  await settle(svc, code);

  const r2 = svc.postMessage(code, '@DeepSeek 只问你');
  assert.deepEqual(r2.replies.map((r) => r.agent_id), [a.id]);
  const s = await settle(svc, code);
  // 1 人 + 2 回复 + 1 人 + 1 回复，没有额外的 agent 链式回复
  assert.equal(s.messages.length, 5);
  assert.ok(s.messages.every((m) => m.status === 'done'));
});

test('调用失败标记 error，retry 后能成功', async () => {
  let fail = true;
  const flaky: LlmCaller = async (req) => {
    if (fail) throw new Error('401 key 不对');
    return echo(req);
  };
  const { svc, code } = setup(flaky);
  const { replies } = svc.postMessage(code, '@DeepSeek 你好');
  let s = await settle(svc, code);
  const bad = s.messages.find((m) => m.seq === replies[0]!.seq)!;
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /401/);

  fail = false;
  svc.retry(code, bad.seq);
  s = await settle(svc, code);
  assert.equal(s.messages.find((m) => m.seq === bad.seq)!.status, 'done');
});

test(`每个房间最多 ${MAX_AGENTS_PER_ROOM} 个 agent`, () => {
  const { svc, code } = setup();
  svc.addMember(code, svc.createAgent({ name: 'C', base_url: 'demo' }).id);
  svc.addMember(code, svc.createAgent({ name: 'D', base_url: 'demo' }).id);
  const e = svc.createAgent({ name: 'E', base_url: 'demo' });
  assert.throws(() => svc.addMember(code, e.id), (err) => err instanceof RtError);
  assert.equal(svc.snapshot(code).members.length, MAX_AGENTS_PER_ROOM);
});


test('上传需求文档 → 出方案 → 另一个 agent 审查 → 定稿产物', async () => {
  const root = mkdtempSync(`${tmpdir()}/rt-flow-`);
  try {
    const svc = new RoundtableService(openDb(':memory:'), { real: echo, demo: demoCaller(1) }, new RoomFiles(root));
    const a = svc.createAgent({ name: '方案手', base_url: 'https://example.com', model: 'm' });
    const b = svc.createAgent({ name: '审查手', base_url: 'demo' });
    const room = svc.createRoom({ title: '文档流程', agent_ids: [a.id, b.id] });
    const code = room.room.code;
    const uploaded = await svc.addDoc(code, '需求.md', Buffer.from('# 需求\n做一个可审查的方案流程', 'utf8'));
    assert.equal(uploaded.doc.name, '需求.md');
    assert.equal(svc.snapshot(code).docs.length, 1);

    svc.startFlow(code, { action: 'plan', agent_id: a.id });
    let snap = await settle(svc, code);
    const plan = snap.messages.find((m) => m.stage === 'plan' && m.status === 'done')!;
    assert.ok(plan);
    assert.equal(snap.artifacts.some((x) => x.file === 'plan-v1.md'), true);
    assert.match(readFileSync(`${root}/${code}/plan-v1.md`, 'utf8'), /回复/);

    svc.startFlow(code, { action: 'review', agent_id: b.id, ref_seq: plan.seq });
    snap = await settle(svc, code);
    const review = snap.messages.find((m) => m.stage === 'review' && m.status === 'done')!;
    assert.equal(review.ref_seq, plan.seq);
    assert.equal(snap.artifacts.some((x) => x.kind === 'review'), true);

    const final = svc.finalize(code, plan.seq);
    assert.equal(final.artifact.file, 'final.md');
    assert.match(readFileSync(`${root}/${code}/final.md`, 'utf8'), /方案 v1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP agent 可认证、领取方案任务并提交产物', async () => {
  const root = mkdtempSync(`${tmpdir()}/rt-mcp-`);
  try {
    const svc = new RoundtableService(openDb(':memory:'), { real: echo, demo: demoCaller(1) }, new RoomFiles(root));
    const created = svc.createAgentWithToken({ name: 'Codex', runtime: 'mcp' });
    assert.equal(created.agent.runtime, 'mcp');
    assert.ok(created.token);
    assert.equal(svc.authenticateExternalAgent(created.token!)?.id, created.agent.id);
    const room = svc.createRoom({ title: 'MCP 测试', prd: '读取代码后给出方案', agent_ids: [created.agent.id] });
    const code = room.room.code;
    await svc.addDoc(code, '需求.md', Buffer.from('# 需求\n实现 MCP 接入', 'utf8'));
    const started = svc.startFlow(code, { action: 'plan', agent_id: created.agent.id });
    const tasks = await svc.getExternalTasks(created.agent.id, code);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.seq, started.replies[0]!.seq);
    assert.equal(tasks[0]!.stage, 'plan');
    assert.match(tasks[0]!.context.map((m) => m.content).join('\n'), /需求文档/);
    const completed = svc.completeExternalTask(created.agent.id, code, tasks[0]!.seq, '# 方案\n读取代码并实现');
    assert.equal(completed.message.status, 'done');
    assert.equal(svc.snapshot(code).artifacts[0]!.file, 'plan-v1.md');
    assert.match(readFileSync(`${root}/${code}/plan-v1.md`, 'utf8'), /读取代码并实现/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP agent 不能读取未加入的房间', () => {
  const svc = new RoundtableService(openDb(':memory:'));
  const a = svc.createAgentWithToken({ name: 'Codex', runtime: 'mcp' });
  const room = svc.createRoom({ title: '隔离', prd: 'x' });
  assert.throws(() => svc.joinExternalRoom(a.agent.id, room.room.code), (err) => err instanceof RtError);
});

test('MCP 工具可列出并读取项目记忆文件，拒绝越界路径', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { buildRoundtableMcpServer } = await import('../src/roundtable/mcp.js');
  const svc = new RoundtableService(openDb(':memory:'));
  const created = svc.createAgentWithToken({ name: 'Inspector', runtime: 'mcp' });
  const server = buildRoundtableMcpServer(svc, svc.authenticateExternalAgent(created.token!)!);
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.callTool({ name: 'list_workspace_files', arguments: {} });
  assert.ok(Array.isArray(listed.content));
  assert.equal(listed.content[0].type, 'text');
  const files = JSON.parse(listed.content[0].text).files as string[];
  assert.ok(files.includes('AGENTS.md'));
  const read = await client.callTool({ name: 'read_workspace_file', arguments: { path: 'AGENTS.md' } });
  assert.ok(Array.isArray(read.content));
  assert.equal(read.content[0].type, 'text');
  assert.match(String(read.content[0].text), /搜索规则/);
  const blocked = await client.callTool({ name: 'read_workspace_file', arguments: { path: '../.env' } });
  assert.equal(blocked.isError, true);
  await client.close();
  await server.close();
});

test('HTTP MCP 接受 Bearer token 并拒绝无效或已轮换的 token', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerRoundtableMcp } = await import('../src/roundtable/mcp.js');
  const db = openDb(':memory:');
  const svc = new RoundtableService(db);
  const created = svc.createAgentWithToken({ name: 'HttpMcp', runtime: 'mcp' });
  const app = Fastify();
  registerRoundtableMcp(app, svc);
  try {
    const request = (token: string) => app.inject({
      method: 'POST', url: '/rt-mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    });
    const valid = await request(created.token!);
    assert.equal(valid.statusCode, 200, valid.body);
    assert.equal((await request('invalid')).statusCode, 401);
    const next = svc.regenerateAgentToken(created.agent.id);
    assert.equal((await request(created.token!)).statusCode, 401);
    assert.equal((await request(next.token)).statusCode, 200);
  } finally { await app.close(); db.close(); }
});

test('取消 MCP 待办后不能提交，重试后唤醒等待中的 Agent，重启保留待办', async () => {
  const db = openDb(':memory:');
  const svc = new RoundtableService(db);
  const a = svc.createAgentWithToken({ name: 'Waiter', runtime: 'mcp' });
  const code = svc.createRoom({ agent_ids: [a.agent.id] }).room.code;
  const waiting = svc.getExternalTasks(a.agent.id, code, 1);
  const reply = svc.postMessage(code, '请看现有代码').replies[0]!;
  assert.equal((await waiting)[0]!.seq, reply.seq);
  svc.stop(code, reply.seq);
  assert.equal(svc.snapshot(code).messages.at(-1)!.status, 'error');
  assert.throws(() => svc.completeExternalTask(a.agent.id, code, reply.seq, '过期结果'), RtError);
  const retryWait = svc.getExternalTasks(a.agent.id, code, 1);
  svc.retry(code, reply.seq);
  assert.equal((await retryWait)[0]!.seq, reply.seq);
  const resumed = new RoundtableService(db);
  assert.equal((await resumed.getExternalTasks(a.agent.id, code))[0]!.seq, reply.seq);
  db.close();
});

test('API Agent 切换为 MCP 后能配置 token，忙碌时禁止改类型，切回 API 使 token 失效', () => {
  const db = openDb(':memory:');
  const svc = new RoundtableService(db);
  const a = svc.createAgent({ name: 'Switch', base_url: 'demo' });
  svc.updateAgent(a.id, { runtime: 'mcp' });
  const { token } = svc.regenerateAgentToken(a.id);
  assert.equal(svc.authenticateExternalAgent(token)!.id, a.id);
  const code = svc.createRoom({ agent_ids: [a.id] }).room.code;
  const reply = svc.postMessage(code, '看下').replies[0]!;
  assert.throws(() => svc.updateAgent(a.id, { runtime: 'api', base_url: 'demo' }), RtError);
  svc.stop(code, reply.seq);
  svc.updateAgent(a.id, { runtime: 'api', base_url: 'demo' });
  assert.equal(svc.authenticateExternalAgent(token), null);
  svc.updateAgent(a.id, { runtime: 'mcp' });
  assert.equal(svc.authenticateExternalAgent(token), null);
  assert.ok(!JSON.stringify(svc.listAgents()).includes(token));
  db.close();
});

test('外部 Agent 能读完整上传文档，方案 → 审查 → 修订 → 定稿可串联，禁止代交或重复提交', async () => {
  const root = mkdtempSync(`${tmpdir()}/rt-external-flow-`);
  const db = openDb(':memory:');
  try {
    const svc = new RoundtableService(db, undefined, new RoomFiles(root));
    const a = svc.createAgentWithToken({ name: 'Planner', runtime: 'mcp' }).agent;
    const b = svc.createAgentWithToken({ name: 'Reviewer', runtime: 'mcp' }).agent;
    const code = svc.createRoom({ agent_ids: [a.id, b.id] }).room.code;
    const doc = await svc.addDoc(code, '需求.md', Buffer.from('在现有代码上扩展功能'));
    assert.equal(svc.externalDocText(a.id, code, doc.doc.id).text, '在现有代码上扩展功能');
    const plan = svc.startFlow(code, { action: 'plan', agent_id: a.id }).replies[0]!;
    assert.throws(() => svc.completeExternalTask(b.id, code, plan.seq, '冒名提交'), RtError);
    svc.completeExternalTask(a.id, code, plan.seq, '# 第一版方案');
    assert.throws(() => svc.completeExternalTask(a.id, code, plan.seq, '重复提交'), RtError);
    const review = svc.startFlow(code, { action: 'review', agent_id: b.id, ref_seq: plan.seq }).replies[0]!;
    assert.match((await svc.getExternalTasks(b.id, code))[0]!.context[0]!.content, /第一版方案/);
    svc.completeExternalTask(b.id, code, review.seq, '必须兼容已有 API');
    const revision = svc.startFlow(code, { action: 'revise', agent_id: a.id, ref_seq: review.seq }).replies[0]!;
    assert.match((await svc.getExternalTasks(a.id, code))[0]!.context[0]!.content, /兼容已有 API/);
    svc.completeExternalTask(a.id, code, revision.seq, '# 第二版方案\n兼容已有 API');
    assert.equal(svc.finalize(code, revision.seq).artifact.file, 'final.md');
    assert.match(readFileSync(`${root}/${code}/final.md`, 'utf8'), /第二版方案/);
    assert.equal(svc.snapshot(code).artifacts.length, 4);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('移出 MCP Agent 会取消未完成任务', async () => {
  const db = openDb(':memory:');
  const svc = new RoundtableService(db);
  const agent = svc.createAgentWithToken({ name: 'Leaving', runtime: 'mcp' }).agent;
  const code = svc.createRoom({ prd: '读取项目后出方案', agent_ids: [agent.id] }).room.code;
  const reply = svc.postMessage(code, '看看').replies[0]!;
  svc.removeMember(code, agent.id);
  assert.equal(svc.snapshot(code).messages.find((m) => m.seq === reply.seq)!.status, 'error');
  await assert.rejects(() => svc.getExternalTasks(agent.id, code), RtError);
  db.close();
});

test('旧 Agent 表自动迁移，保留 API 配置并可重复启动', () => {
  const db = openDb(':memory:');
  try {
    db.exec(`CREATE TABLE rt_agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
      model TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO rt_agents VALUES ('legacy', '旧模型', 'https://example.com', 'legacy-model', 'sk-legacy', '', '2026-01-01', '2026-01-01');`);
    const svc = new RoundtableService(db);
    const old = svc.listAgents()[0];
    assert.equal(old.id, 'legacy');
    assert.equal(old.runtime, 'api');
    assert.equal(old.model, 'legacy-model');
    assert.equal(old.has_key, true);
    assert.equal(old.connected, false);
    assert.equal(old.token_hint, '');
    assert.equal(new RoundtableService(db).listAgents().length, 1);
  } finally { db.close(); }
});

test('外部方案写文件失败时保留待办，恢复后可再次提交', () => {
  class FailingFiles extends RoomFiles {
    failing = true;
    override write(code: string, file: string, text: string): string {
      if (this.failing) throw new Error('模拟磁盘写入失败');
      return super.write(code, file, text);
    }
  }
  const root = mkdtempSync(`${tmpdir()}/rt-write-failure-`);
  const db = openDb(':memory:');
  try {
    const files = new FailingFiles(root);
    const svc = new RoundtableService(db, undefined, files);
    const agent = svc.createAgentWithToken({ name: 'Writer', runtime: 'mcp' }).agent;
    const code = svc.createRoom({ prd: '读取项目后出方案', agent_ids: [agent.id] }).room.code;
    const seq = svc.startFlow(code, { action: 'plan', agent_id: agent.id }).replies[0].seq;
    assert.throws(() => svc.completeExternalTask(agent.id, code, seq, '# 方案'), /磁盘写入失败/);
    assert.equal(svc.snapshot(code).messages.find((m) => m.seq === seq)?.status, 'pending');
    assert.equal(svc.snapshot(code).artifacts.length, 0);
    files.failing = false;
    assert.equal(svc.completeExternalTask(agent.id, code, seq, '# 方案').message.status, 'done');
    assert.match(readFileSync(`${root}/${code}/plan-v1.md`, 'utf8'), /# 方案/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
