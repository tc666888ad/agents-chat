/**
 * 生成一个带内容的演示房间（写进 data/negotiation.db）。
 * 用法：pnpm admin 或直接 tsx scripts/seed-demo.ts
 */
import { mkdirSync } from 'node:fs';
import { openDb } from '../src/db/index.js';
import { RoomHub } from '../src/infra/hub.js';
import { RoomService } from '../src/service/room-service.js';

const path = process.env.DB_PATH || 'data/negotiation.db';
mkdirSync('data', { recursive: true });
const svc = new RoomService(openDb(path), new RoomHub());

const prd = `# 用户中心接口

1. 用户列表：分页（10 万+ 用户）、支持按手机号搜索。
2. 用户详情：GET /api/users/{id}。
3. 禁用/启用用户：运营要能操作。
4. 注销用户：数据保留，默认列表不再展示。`;

const { room, tokens } = svc.createRoom({
  title: '用户中心接口 v1',
  prd,
  op_scope: '用户列表 / 用户详情 / 禁用启用',
  designer_seat: 'A',
});

const designer = svc.authenticate(tokens.find((t) => t.role === 'designer')!.token)!;
const reviewer = svc.authenticate(tokens.find((t) => t.role === 'reviewer')!.token)!;
const backend = svc.authenticate(tokens.find((t) => t.role === 'backend')!.token)!;

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

svc.submitPlan(designer, { openapi: v1, summary: '第一版：page/size 分页，先跑通主流程' });
svc.sendMessage(reviewer, {
  text: '@设计方 三个问题：1）10 万+ 用户用 page/size 会翻页漂移，能不能换 cursor？2）禁用接口没有定义；3）注销用户默认列表要不要出现？',
});
svc.submitPlan(designer, {
  openapi: v2,
  summary: '改游标分页，补禁用接口，列表默认过滤注销用户',
});
const invite = svc.invite(backend, { side: 'frontend', name: '小王' });
const frontend = svc.authenticate(invite.token)!;
svc.postHumanMessage(frontend, { text: '@设计方 游标分页前端没问题，但 total 怎么拿？页面上要显示总数。' });
svc.sendMessage(designer, { text: 'total 在同一个响应里（data.total），和 next_cursor 一起返回，一次请求就够。' });
svc.confirm(frontend, { verdict: 'ok' });

const snap = svc.snapshot(room.code, 0);
console.log(`房间 ${snap.room.code}：${snap.room.title}（${snap.room.status_label}）`);
for (const t of tokens) console.log(`${t.role}（${t.seat ?? '人'}）：${t.token}`);
console.log(`前端审阅链接：${invite.link}`);
