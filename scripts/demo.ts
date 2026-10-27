/**
 * 演示：两个 agent 先对齐接口方案，人再确认。
 * 纯内存库，不启服务：pnpm demo
 */
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { RoomHub } from '../src/infra/hub.js';
import { RoomService } from '../src/service/room-service.js';

const svc = new RoomService(openDb(':memory:'), new RoomHub());

const prd = `# 用户中心接口

1. 用户列表：分页、筛选、支持按手机号搜。
2. 用户详情：GET /api/users/{id}。
3. 禁用/启用用户：运营要能操作，状态只允许"正常/禁用"两种。
4. 注销用户：数据保留，但默认列表不再展示。
`;

const { room, tokens } = svc.createRoom({
  title: '用户中心接口',
  prd,
  op_scope: '用户列表 / 用户详情 / 禁用启用',
  designer_seat: 'A',
});
const designer = svc.authenticate(tokens.find((t) => t.role === 'designer')!.token);
const reviewer = svc.authenticate(tokens.find((t) => t.role === 'reviewer')!.token);
const backend = svc.authenticate(tokens.find((t) => t.role === 'backend')!.token);

console.log(`房间 ${room.code}：${room.title}\n`);

const v1 = {
  openapi: '3.0.3',
  info: { title: '用户中心', version: '0.3' },
  paths: {
    '/api/users': {
      get: {
        summary: '用户列表',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'size', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: '用户数组' } },
      },
    },
    '/api/users/{id}': {
      get: {
        summary: '用户详情',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '用户详情' } },
      },
    },
  },
};
const r1 = svc.submitPlan(designer, { openapi: v1, summary: '第一版：page/size 分页' });
console.log(`设计方提交第 1 版（${r1.diff_summary}）`);

svc.sendMessage(reviewer, {
  text: '@设计方 1) 分页用 page 还是 cursor？用户量大会翻不动；2) 禁用接口在哪？3) 注销用户默认列表要不要出现？',
});
console.log('复核方：提了三个问题');

const v2 = {
  openapi: '3.0.3',
  info: { title: '用户中心', version: '0.3' },
  paths: {
    '/api/users': {
      get: {
        summary: '用户列表（游标分页 + 总数）',
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'include_cancelled', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: '用户数组 + total + next_cursor' } },
      },
    },
    '/api/users/{id}': {
      get: {
        summary: '用户详情',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '用户详情' } },
      },
    },
    '/api/users/{id}/disable': {
      post: {
        summary: '禁用/启用用户',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: '已切换' } },
      },
    },
  },
};
const r2 = svc.submitPlan(designer, { openapi: v2, summary: '改 cursor 分页，补禁用接口和注销过滤' });
console.log(`设计方提交第 2 版（${r2.diff_summary}）`);

const invite = svc.invite(backend, { side: 'frontend', name: '小王' });
const frontend = svc.authenticate(invite.token);
svc.postHumanMessage(frontend, { text: '@设计方 游标分页前端没问题，但 total 怎么拿？' });
svc.sendMessage(designer, { text: 'total 在同一个响应的 data.total 里，和 next_cursor 一起返回。' });
console.log('前端被拉进来：问了一句，设计方回答');

const c1 = svc.confirm(frontend, { verdict: 'ok' });
console.log(`前端确认（状态：${c1.status_label}）`);
svc.postHumanMessage(backend, { text: '后端也确认，注销的软删除细节按「默认过滤」做。' });
const c2 = svc.confirm(backend, { verdict: 'ok' });
console.log(`后端确认（状态：${c2.status_label}）`);

const snap = svc.snapshot(room.code, 0);
console.log('\n—— 时间线 ——');
for (const m of snap.messages) {
  console.log(`#${m.seq} ${m.speaker}：${m.body}${m.reply_to ? `（回复 #${m.reply_to}）` : ''}`);
}
console.log(
  `\n确认：${snap.confirmations.map((c) => `${c.label}=${c.status}`).join('，')}；房间状态：${snap.room.status_label}`,
);
assert.equal(snap.room.status, 'ready');
assert.equal(snap.history.length, 2);
assert.ok(snap.confirmations.every((c) => c.status === 'ok'));
console.log('\n✓ 全流程通过：两个 agent 对方案 → 人确认 → 可以开发');
