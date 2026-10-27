import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { openDb } from './db/index.js';
import { RoomHub } from './infra/hub.js';
import { RoomService, ServiceError } from './service/room-service.js';
import { registerMcp } from './mcp/mount.js';
import { errorBody, errorStatus, registerApi } from './http/api.js';
import { registerWeb } from './http/static.js';
import { RoundtableService } from './roundtable/service.js';
import { registerRoundtableApi } from './roundtable/http.js';
import { registerRoundtableMcp } from './roundtable/mcp.js';
import { killAllLocalAgents } from './roundtable/local-agent.js';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.NEGOTIATION_DB ?? resolve(process.cwd(), 'data', 'negotiation.db');

const db = openDb(dbPath);
const svc = new RoomService(db, new RoomHub());
const rt = new RoundtableService(db);
const app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: { level: process.env.LOG_LEVEL ?? 'info' } });

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ServiceError) {
    return reply.code(errorStatus(err)).send(errorBody(err));
  }
  const e = err as Error & { statusCode?: number };
  req.log.error(e);
  const status = e.statusCode ?? 500;
  return reply.code(status).send({
    ok: false,
    error: { code: status === 500 ? 'INTERNAL' : 'VALIDATION_FAILED', message: e.message },
  });
});

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) {
    return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: `没有这个接口：${req.url}` } });
  }
  return reply.code(404).type('text/plain; charset=utf-8').send('not found');
});

registerWeb(app);
registerApi(app, svc);
registerRoundtableApi(app, rt);
registerRoundtableMcp(app, rt);
registerMcp(app, svc);

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

await app.listen({ port, host: '0.0.0.0' });

const ips = lanAddresses();
const lines = [
  '',
  '  AI 圆桌 已启动',
  '',
  `  本机网页   http://localhost:${port}`,
  ...ips.map((ip) => `  局域网网页 http://${ip}:${port}`),
  
  '',
  `  数据库     ${dbPath}`,
  '',
  '  下一步：打开网页 → 新建房间 → 添加 agent → 开聊。旧版协商室在 /legacy。',
  '',
];
console.log(lines.join('\n'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    killAllLocalAgents();
    await app.close();
    db.close();
    process.exit(0);
  });
}
