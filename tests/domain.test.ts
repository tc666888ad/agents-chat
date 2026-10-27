import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveTodos, mentionsRole, nextHint, STATUS_LABEL } from '../src/domain/room.js';

test('发言里的 @ 按角色解析：设计方、复核方、前端、后端、所有人', () => {
  assert.equal(mentionsRole('@设计方 这里用 cursor', 'designer'), true);
  assert.equal(mentionsRole('@reviewer 你看下', 'reviewer'), true);
  assert.equal(mentionsRole('@设计方 你看下', 'reviewer'), false);
  assert.equal(mentionsRole('@前端 确认下', 'frontend'), true);
  assert.equal(mentionsRole('@所有人 注意', 'backend'), true);
  assert.equal(mentionsRole('没有 at 的普通发言', 'designer'), false);
});

test('待办：被 @ 的 agent 有一条 reply_human，回复后消失', () => {
  const pending = [{ seq: 7, from_role: 'reviewer', body: '@设计方 分页到底用哪个？' }];
  const todos = deriveTodos(pending as never, 'designer');
  assert.equal(todos.length, 1);
  assert.equal(todos[0]!.kind, 'reply_human');
  assert.equal(todos[0]!.message_seq, 7);
  assert.equal(deriveTodos(pending as never, 'frontend').length, 0);
});

test('next_hint 跟着房间状态和待办走', () => {
  assert.match(nextHint({ role: 'designer', status: 'designing', hasPlan: false, hasTodos: false, hasNewMessages: false }), /提交/);
  assert.match(nextHint({ role: 'reviewer', status: 'reviewing', hasPlan: true, hasTodos: false, hasNewMessages: false }), /确认|等/);
  assert.match(nextHint({ role: 'reviewer', status: 'designing', hasPlan: false, hasTodos: false, hasNewMessages: false }), /设计方/);
  assert.match(nextHint({ role: 'frontend', status: 'ready', hasPlan: true, hasTodos: false, hasNewMessages: false }), /可以.*开发/);
  assert.match(nextHint({ role: 'backend', status: 'closed', hasPlan: true, hasTodos: false, hasNewMessages: false }), /关闭/);
  const withTodo = nextHint({ role: 'designer', status: 'reviewing', hasPlan: true, hasTodos: true, hasNewMessages: false });
  assert.match(withTodo, /待办/);
});

test('状态文案可直接上网页', () => {
  assert.equal(STATUS_LABEL.designing, '设计中');
  assert.equal(STATUS_LABEL.reviewing, '待人确认');
  assert.equal(STATUS_LABEL.ready, '可以开发');
  assert.equal(STATUS_LABEL.closed, '已关闭');
});
