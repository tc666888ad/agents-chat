import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

const here = fileURLToPath(new URL('.', import.meta.url));
/** src/http → 项目根 */
const ROOT = resolve(here, '..', '..');
const WEB_DIR = join(ROOT, 'src', 'web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendFile(reply: FastifyReply, absPath: string): FastifyReply {
  const type = TYPES[extname(absPath)] ?? 'application/octet-stream';
  reply.raw.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  return reply.send(createReadStream(absPath));
}

export function registerWeb(app: FastifyInstance): void {
  app.get('/downloads/agents-chat-connector.tar.gz', (_req, reply) => {
    const compiled = resolve(ROOT, 'downloads', 'agents-chat-connector.tar.gz');
    const archive = existsSync(compiled) ? compiled : resolve(ROOT, 'dist', 'downloads', 'agents-chat-connector.tar.gz');
    if (!existsSync(archive)) return reply.code(404).send('连接器下载包尚未构建，请运行 npm run build');
    reply.header('content-disposition', 'attachment; filename="agents-chat-connector.tar.gz"');
    return sendFile(reply, archive);
  });
  // 0.3 圆桌（默认）
  app.get('/', (_req, reply) => sendFile(reply, join(WEB_DIR, 'rt.html')));
  app.get<{ Params: { code: string } }>('/r/:code', (req, reply) => {
    if (!/^[A-Za-z0-9-]{3,32}$/.test(req.params.code)) return reply.code(404).send('not found');
    return sendFile(reply, join(WEB_DIR, 'rt.html'));
  });

  // 0.2 协商室（保留）
  app.get('/legacy', (_req, reply) => sendFile(reply, join(WEB_DIR, 'index.html')));

  app.get<{ Params: { code: string } }>('/room/:code', (req, reply) => {
    if (!/^[A-Za-z0-9-]{3,32}$/.test(req.params.code)) return reply.code(404).send('not found');
    return sendFile(reply, join(WEB_DIR, 'room.html'));
  });

  app.get<{ Params: { file: string } }>('/assets/:file', (req, reply) => {
    const file = normalize(req.params.file).replace(/^(\.\.[/\\])+/, '');
    const abs = join(WEB_DIR, file);
    if (!abs.startsWith(WEB_DIR) || !existsSync(abs)) return reply.code(404).send('not found');
    return sendFile(reply, abs);
  });
}
