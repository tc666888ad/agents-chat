import type { FastifyInstance, FastifyReply } from 'fastify';
import { RtError, type RoundtableService } from './service.js';

const STATUS: Record<RtError['code'], number> = { VALIDATION_FAILED: 400, NOT_FOUND: 404, INVALID_STATE: 409 };

async function handle<T>(reply: FastifyReply, fn: () => T | Promise<T>): Promise<unknown> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    if (err instanceof RtError) {
      return reply.code(STATUS[err.code]).send({ ok: false, error: { code: err.code, message: err.message } });
    }
    throw err;
  }
}

type P = { Params: { code: string; id: string; seq: string }; Body: Record<string, unknown> };

export function registerRoundtableApi(app: FastifyInstance, rt: RoundtableService): void {
  // agent 库（跨房间复用）
  app.get('/api/rt/agents', (_req, reply) => handle(reply, () => ({ agents: rt.listAgents() })));
  app.post<P>('/api/rt/agents', (req, reply) => handle(reply, () => rt.createAgentWithToken(req.body ?? {})));
  app.post<P>('/api/rt/agents/:id/token', (req, reply) => handle(reply, () => rt.regenerateAgentToken(req.params.id)));
  app.put<P>('/api/rt/agents/:id', (req, reply) =>
    handle(reply, () => ({ agent: rt.updateAgent(req.params.id, req.body ?? {}) })),
  );
  app.delete<P>('/api/rt/agents/:id', (req, reply) => handle(reply, () => (rt.deleteAgent(req.params.id), {})));
  app.post<P>('/api/rt/agents/test', async (req, reply) => {
    try {
      return { ok: true, ...(await rt.testAgent(req.body ?? {})) };
    } catch (err) {
      if (err instanceof RtError) return handle(reply, () => Promise.reject(err));
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: 'CALL_FAILED', message } };
    }
  });

  // 房间
  app.get('/api/rt/rooms', (_req, reply) => handle(reply, () => ({ rooms: rt.listRooms() })));
  app.post<P>('/api/rt/rooms', (req, reply) =>
    handle(reply, () => rt.createRoom(req.body as { title?: string; prd?: string; agent_ids?: string[] })),
  );
  app.get<P>('/api/rt/rooms/:code', (req, reply) => handle(reply, () => rt.snapshot(req.params.code)));
  app.patch<P>('/api/rt/rooms/:code', (req, reply) =>
    handle(reply, () => rt.updateRoom(req.params.code, req.body as { title?: string; prd?: string; project_dir?: string; auto_collaborate?: boolean })),
  );
  app.post<P>('/api/rt/rooms/:code/collaboration/finish', (req, reply) => handle(reply, () => rt.finishCollaboration(req.params.code)));
  app.post<P>('/api/rt/rooms/:code/collaboration/stop', (req, reply) => handle(reply, () => rt.stopCollaboration(req.params.code)));
  app.post<P>('/api/rt/rooms/:code/collaboration/resume', (req, reply) => handle(reply, () => rt.resumeCollaboration(req.params.code, { text: String(req.body?.text ?? ''), agent_id: String(req.body?.agent_id ?? ''), collaboration_id: req.body?.collaboration_id === undefined ? undefined : String(req.body.collaboration_id) })));
  app.delete<P>('/api/rt/rooms/:code', (req, reply) => handle(reply, () => (rt.deleteRoom(req.params.code), {})));
  app.post<P>('/api/rt/rooms/:code/docs', async (req, reply) =>
    handle(reply, async () => {
      const name = String(req.body?.name ?? '');
      const encoded = String(req.body?.content_base64 ?? '');
      if (!encoded) throw new RtError('VALIDATION_FAILED', '没有收到文件内容');
      let data: Buffer;
      try { data = Buffer.from(encoded, 'base64'); } catch { throw new RtError('VALIDATION_FAILED', '文件编码不对'); }
      return rt.addDoc(req.params.code, name, data);
    }),
  );
  app.delete<P>('/api/rt/rooms/:code/docs/:id', (req, reply) =>
    handle(reply, () => (rt.removeDoc(req.params.code, req.params.id), {})),
  );
  app.post<P>('/api/rt/rooms/:code/flow', (req, reply) =>
    handle(reply, () => rt.startFlow(req.params.code, {
      action: String(req.body?.action ?? ''),
      agent_id: String(req.body?.agent_id ?? ''),
      ref_seq: req.body?.ref_seq === undefined ? undefined : Number(req.body.ref_seq),
    })),
  );
  app.post<P>('/api/rt/rooms/:code/messages/:seq/finalize', (req, reply) =>
    handle(reply, () => rt.finalize(req.params.code, Number(req.params.seq))),
  );
  app.post<P>('/api/rt/rooms/:code/members', (req, reply) =>
    handle(reply, () => rt.addMember(req.params.code, String(req.body?.agent_id ?? ''))),
  );
  app.delete<P>('/api/rt/rooms/:code/members/:id', (req, reply) =>
    handle(reply, () => rt.removeMember(req.params.code, req.params.id)),
  );
  app.post<P>('/api/rt/rooms/:code/messages', (req, reply) =>
    handle(reply, () => rt.postMessage(req.params.code, String(req.body?.text ?? ''))),
  );
  app.post<P>('/api/rt/rooms/:code/messages/:seq/retry', (req, reply) =>
    handle(reply, () => ({ message: rt.retry(req.params.code, Number(req.params.seq)) })),
  );
  app.post<P>('/api/rt/rooms/:code/messages/:seq/stop', (req, reply) =>
    handle(reply, () => (rt.stop(req.params.code, Number(req.params.seq)), {})),
  );

  app.get<{ Params: { code: string; '*': string } }>('/api/rt/rooms/:code/files/*', (req, reply) => {
    try {
      const file = rt.readFile(req.params.code, req.params['*']);
      const type = file.name.endsWith('.md') || file.name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream';
      return reply.type(type).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`).send(file.data);
    } catch (err) {
      if (err instanceof RtError) return reply.code(404).send({ ok: false, error: { code: err.code, message: err.message } });
      throw err;
    }
  });

  // 实时推送：消息新增/流式更新/成员变化
  app.get<P>('/api/rt/rooms/:code/events', (req, reply) => {
    try {
      rt.snapshot(req.params.code);
    } catch (err) {
      if (err instanceof RtError) return reply.code(404).send({ ok: false, error: { code: err.code, message: err.message } });
      throw err;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const off = rt.subscribe(req.params.code, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
}
