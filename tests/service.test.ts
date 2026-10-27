import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db/index.js';
import { RoomHub } from '../src/infra/hub.js';
import { ServiceError, RoomService } from '../src/service/room-service.js';

const DOC = {
  openapi: '3.0.3',
  info: { title: '用户中心', version: '0.1' },
  paths: {
    '/api/users': {
      get: { summary: '用户列表', responses: { '200': { description: 'ok' } } },
    },
  },
};

const DOC2 = {
  openapi: '3.0.3',
  info: { title: '用户中心', version: '0.1' },
  paths: {
    '/api/users': {
      get: {
        summary: '用户列表（游标分页）',
        parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

function setup(title = '测试房间') {
  const svc = new RoomService(openDb(':memory:'), new RoomHub());
  const { room, tokens } = svc.createRoom({ title, prd: '# 需求\n用户列表。', designer_seat: 'A' });
  const byRole = (role: string) => tokens.find((t) => t.role === role)!;
  const cred = (role: string) => svc.authenticate(byRole(role).token)!;
  return { svc, room, tokens, byRole, cred };
}

function expectServiceError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ServiceError, `应为 ServiceError，实际 ${String(err)}`);
    assert.equal((err as ServiceError).code, code);
    return;
  }
  assert.fail(`预期抛出 ${code}，实际没有抛错`);
}

test('建房发三张票：设计方、复核方、后端（人）', () => {
  const { svc, tokens } = setup();
  assert.equal(tokens.length, 3);
  assert.equal(tokens.filter((t) => t.seat).length, 2);
  assert.ok(tokens.find((t) => t.role === 'designer')!.seat === 'A');
  assert.ok(tokens.find((t) => t.role === 'reviewer')!.seat === 'B');
  assert.equal(tokens.find((t) => t.role === 'backend')!.seat, undefined);
  const me = svc.whoami(tokens[0]!.token)!;
  assert.equal(me.role, 'designer');
  assert.equal(me.label, '设计方');
});

test('设计方提交第一版方案：房间进入"待人确认"，复核方收到一条提案消息', () => {
  const { svc, room, cred } = setup();
  const out = svc.submitPlan(cred('designer'), { openapi: DOC, summary: '第一版' });
  assert.equal(out.version, 1);
  assert.equal(out.summary, '第一版');
  assert.equal(out.diff_summary, '初版');
  const snap = svc.snapshot(room.code, 0);
  assert.equal(snap.room.status, 'reviewing');
  assert.equal(snap.messages.filter((m) => m.type === 'proposal').length, 1);
});

test('第二版产生相对第一版的差异，历史保留两版', () => {
  const { svc, cred } = setup();
  svc.submitPlan(cred('designer'), { openapi: DOC });
  const second = svc.submitPlan(cred('designer'), { openapi: DOC2 });
  assert.equal(second.version, 2);
  assert.ok(second.changed > 0);
  assert.match(second.diff_summary, /\+|~/);
  const plan = svc.getPlan(cred('designer'), { history: true });
  assert.equal(plan.history.length, 2);
  assert.equal(plan.plan!.version, 2);
});

test('复核方 @ 设计方 → 设计方有 reply_human 待办；回复后清空', async () => {
  const { svc, cred } = setup();
  svc.submitPlan(cred('designer'), { openapi: DOC });
  svc.sendMessage(cred('reviewer'), { text: '@设计方 分页到底用 page 还是 cursor？' });

  const inbox = await svc.getMessages(cred('designer'), {});
  assert.equal(inbox.my_todos.length, 1);
  assert.equal(inbox.my_todos[0]!.kind, 'reply_human');
  const ask = inbox.messages.find((m) => m.type === 'chat' && m.body.includes('cursor'))!;
  assert.ok(ask);

  svc.sendMessage(cred('designer'), { text: '用 cursor，后端保证稳定。', reply_to: ask.seq });
  const after = await svc.getMessages(cred('designer'), {});
  assert.equal(after.my_todos.length, 0);
});

test('get_messages 的长等待会被新消息唤醒', async () => {
  const { svc, cred } = setup();
  await svc.getMessages(cred('reviewer'), {}); // 先读到系统消息，游标推进
  const started = Date.now();
  const waiting = svc.getMessages(cred('reviewer'), { wait_seconds: 3 });
  setTimeout(() => {
    svc.sendMessage(cred('designer'), { text: '第一版方案提交了，你看下' });
  }, 120);
  const out = await waiting;
  assert.ok(Date.now() - started < 2500, '应该在超时前被唤醒');
  assert.ok(out.messages.some((m) => m.body.includes('第一版')));
});

test('两边人都确认后才可以开发；只确认一边时仍是待人确认', () => {
  const { svc, room, cred } = setup();
  svc.submitPlan(cred('designer'), { openapi: DOC });
  const invite = svc.invite(cred('backend'), { side: 'frontend', name: '小王' });
  const frontend = svc.authenticate(invite.token)!;

  svc.confirm(frontend, { verdict: 'ok' });
  assert.equal(svc.snapshot(room.code, 0).room.status, 'reviewing');

  const both = svc.confirm(cred('backend'), { verdict: 'ok' });
  assert.equal(both.status, 'ready');
  const snap = svc.snapshot(room.code, 0);
  assert.ok(snap.confirmations.every((c) => c.status === 'ok'));
});

test('提交新方案后，旧的确认作废，房间回到待人确认', () => {
  const { svc, room, cred } = setup();
  svc.submitPlan(cred('designer'), { openapi: DOC });
  const invite = svc.invite(cred('backend'), { side: 'frontend' });
  const frontend = svc.authenticate(invite.token)!;
  svc.confirm(frontend, { verdict: 'ok' });
  svc.confirm(cred('backend'), { verdict: 'ok' });
  assert.equal(svc.snapshot(room.code, 0).room.status, 'ready');

  svc.submitPlan(cred('designer'), { openapi: DOC2 });
  const snap = svc.snapshot(room.code, 0);
  assert.equal(snap.room.status, 'reviewing');
  assert.ok(snap.confirmations.every((c) => c.status === 'stale'));
});

test('有意见时房间保持待人确认，并记下意见', () => {
  const { svc, room, cred } = setup();
  svc.submitPlan(cred('designer'), { openapi: DOC });
  const invite = svc.invite(cred('backend'), { side: 'frontend' });
  const frontend = svc.authenticate(invite.token)!;
  const out = svc.confirm(frontend, { verdict: 'issue', note: '注销用户没处理' });
  assert.equal(out.status, 'reviewing');
  const snap = svc.snapshot(room.code, 0);
  const mine = snap.confirmations.find((c) => c.side === 'frontend')!;
  assert.equal(mine.status, 'issue');
  assert.match(mine.note ?? '', /注销/);
});

test('权限：复核方不能提交方案，agent 不能点确认', () => {
  const { svc, cred } = setup();
  expectServiceError(() => svc.submitPlan(cred('reviewer'), { openapi: DOC }), 'FORBIDDEN');
  expectServiceError(() => svc.confirm(cred('designer'), { verdict: 'ok' }), 'FORBIDDEN');
});

test('校验：坏 OpenAPI、不存在的版本都按错误码拒绝', () => {
  const { svc, cred } = setup();
  expectServiceError(
    () => svc.submitPlan(cred('designer'), { openapi: { openapi: '2.0', paths: {} } }),
    'VALIDATION_FAILED',
  );
  expectServiceError(() => svc.getPlan(cred('designer'), { version: 9 }), 'NOT_FOUND');
  expectServiceError(() => svc.authenticate('nr_wrong'), 'FORBIDDEN');
});
