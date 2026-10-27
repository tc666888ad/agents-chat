import type { FastifyInstance, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RoomService } from '../service/room-service.js';
import { buildMcpServer } from './server.js';

export function tokenFrom(req: FastifyRequest): string {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const q = req.query as Record<string, string> | undefined;
  return q?.token ?? '';
}

/**
 * MCP 的无状态 Streamable HTTP：每个请求一个独立 server + transport。
 * sessionIdGenerator 必须是 undefined —— 否则协议 §5.1 的单实例约束会被破坏。
 */
export function registerMcp(app: FastifyInstance, svc: RoomService): void {
  const handler = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const cred = svc.authenticate(tokenFrom(req));
    if (!cred) {
      return reply.code(401).send({
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: '缺少或无效的 token：用 Authorization: Bearer <token>，或在 URL 上带 ?token=<token>',
        },
      });
    }
    const server = buildMcpServer(svc, cred);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        reply.raw.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String(err) } }));
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  };

  app.all('/mcp', { bodyLimit: 2 * 1024 * 1024 }, handler);
  app.all('/mcp/', { bodyLimit: 2 * 1024 * 1024 }, handler);
}
