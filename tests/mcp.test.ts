import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../src/db/index.js';
import { RoomHub } from '../src/infra/hub.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { RoomService } from '../src/service/room-service.js';

const DOC = {
  openapi: '3.0.3',
  info: { title: '用户中心', version: '0.1' },
  paths: {
    '/api/users': {
      get: { summary: '用户列表', responses: { '200': { description: 'ok' } } },
    },
  },
};

function textOf(result: unknown): any {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const first = r.content?.[0];
  assert.equal(first?.type, 'text');
  return JSON.parse(first!.text ?? '{}');
}

async function connectAs(tokens: { role: string; token: string }[], role: string) {
  const db = openDb(':memory:');
  const svc = new RoomService(db, new RoomHub());
  const { room } = svc.createRoom({ title: 'MCP 测试' });

  // 用测试房间自己的票，才能对上 svc 的数据库
  const fresh = svc.createRoom({ title: 'MCP 测试 2' });
  const target = fresh.tokens.find((t) => t.role === role)!;
  const server = buildMcpServer(svc, svc.authenticate(target.token)!);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(clientSide);
  return { svc, client, room: fresh.room, tokens: fresh.tokens };
}

test('MCP：工具全在，schema 由 zod 转成 JSON Schema', async () => {
  const { client } = await connectAs([], 'designer');
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['get_messages', 'get_plan', 'join_room', 'send_message', 'submit_plan'],
  );
  const submit = tools.find((t) => t.name === 'submit_plan')!;
  assert.ok(submit.inputSchema.properties?.openapi);
});

test('MCP：join → submit_plan → 对方看到方案并发问', async () => {
  const db = openDb(':memory:');
  const svc = new RoomService(db, new RoomHub());
  const { room, tokens } = svc.createRoom({ title: '全链路' });
  const designerToken = tokens.find((t) => t.role === 'designer')!.token;
  const reviewerToken = tokens.find((t) => t.role === 'reviewer')!.token;

  const designerServer = buildMcpServer(svc, svc.authenticate(designerToken)!);
  const reviewerServer = buildMcpServer(svc, svc.authenticate(reviewerToken)!);
  const [dA, dB] = InMemoryTransport.createLinkedPair();
  const [rA, rB] = InMemoryTransport.createLinkedPair();
  await designerServer.connect(dA);
  await reviewerServer.connect(rA);
  const designer = new Client({ name: 'designer', version: '0' });
  const reviewer = new Client({ name: 'reviewer', version: '0' });
  await designer.connect(dB);
  await reviewer.connect(rB);

  const boot = textOf(await designer.callTool({ name: 'join_room', arguments: {} }));
  assert.equal(boot.ok, true);
  assert.equal(boot.room.code, room.code);
  assert.equal(boot.you.role, 'designer');
  assert.equal(boot.you.label, '设计方');

  const submitted = textOf(
    await designer.callTool({ name: 'submit_plan', arguments: { openapi: DOC, summary: '第一版' } }),
  );
  assert.equal(submitted.ok, true);
  assert.equal(submitted.version, 1);

  const reviewerBoot = textOf(await reviewer.callTool({ name: 'join_room', arguments: {} }));
  assert.equal(reviewerBoot.plan.version, 1);

  const sent = textOf(
    await reviewer.callTool({ name: 'send_message', arguments: { text: '@设计方 分页用什么？' } }),
  );
  assert.equal(sent.ok, true);

  const inbox = textOf(await designer.callTool({ name: 'get_messages', arguments: {} }));
  assert.equal(inbox.my_todos.length, 1);
  assert.match(inbox.next_hint, /待办|回复/);

  const askSeq = inbox.messages.find((m: any) => m.body.includes('分页'))!.seq;
  textOf(await designer.callTool({ name: 'send_message', arguments: { text: '用 cursor。', reply_to: askSeq } }));
  const after = textOf(await designer.callTool({ name: 'get_messages', arguments: {} }));
  assert.equal(after.my_todos.length, 0);

  const plan = textOf(await reviewer.callTool({ name: 'get_plan', arguments: { history: true } }));
  assert.equal(plan.plan.doc.paths['/api/users'].get.summary, '用户列表');
  assert.equal(plan.history.length, 1);
});

test('MCP：错误用 isError + 错误码返回，不会把 agent 卡死', async () => {
  const { client } = await connectAs([], 'designer');
  const bad = await client.callTool({
    name: 'submit_plan',
    arguments: { openapi: { openapi: '2.0', paths: {} } },
  });
  assert.equal(bad.isError, true);
  assert.equal(textOf(bad).error.code, 'VALIDATION_FAILED');

  const missing = await client.callTool({ name: 'get_plan', arguments: { version: 9 } });
  assert.equal(missing.isError, true);
  assert.equal(textOf(missing).error.code, 'NOT_FOUND');
});
