import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ServiceError, type RoomService } from '../service/room-service.js';
import type { CredentialRow } from '../db/index.js';

export function errorStatus(err: ServiceError): number {
  switch (err.code) {
    case 'VALIDATION_FAILED':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'INVALID_STATE':
      return 409;
  }
}

export function errorBody(err: ServiceError): unknown {
  return { ok: false, error: { code: err.code, message: err.message } };
}

function asReply(reply: FastifyReply, err: ServiceError): FastifyReply {
  return reply.code(errorStatus(err)).send(errorBody(err));
}

function tokenFrom(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const query = (req.query as { token?: string } | undefined)?.token;
  return typeof query === 'string' ? query : '';
}

/** 取当前请求的入场券，并校验它属于这个房间。 */
function credential(svc: RoomService, req: FastifyRequest, code: string): CredentialRow {
  const cred = svc.authenticate(tokenFrom(req));
  if (cred.room_code !== code) throw new ServiceError('FORBIDDEN', '这张入场券不属于这个房间');
  return cred;
}

export function registerApi(app: FastifyInstance, svc: RoomService): void {
  app.get('/api/rooms', () => ({ ok: true, rooms: svc.listRooms() }));

  app.post('/api/rooms', (req, reply) => {
    const body = (req.body ?? {}) as {
      code?: string;
      title?: string;
      prd?: string;
      op_scope?: string;
      designer_seat?: 'A' | 'B';
    };
    try {
      const { room, tokens } = svc.createRoom({
        title: body.title ?? '',
        prd: body.prd,
        op_scope: body.op_scope,
        designer_seat: body.designer_seat,
      });
      return { ok: true, room, tokens, room_url: `/room/${room.code}` };
    } catch (err) {
      if (err instanceof ServiceError) return asReply(reply, err);
      throw err;
    }
  });

  app.get<{ Params: { code: string } }>('/api/rooms/:code/snapshot', (req, reply) => {
    const after = Number((req.query as { after_seq?: string }).after_seq ?? 0);
    try {
      return {
        ok: true,
        ...svc.snapshot(req.params.code, Number.isFinite(after) ? after : 0),
        now: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof ServiceError) return asReply(reply, err);
      throw err;
    }
  });

  app.get<{ Params: { code: string } }>('/api/rooms/:code/whoami', (req, reply) => {
    try {
      const me = svc.whoami(tokenFrom(req));
      if (!me) return { ok: true, me: null };
      if (me.room_code !== req.params.code) {
        return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '这张入场券不属于这个房间' } });
      }
      return { ok: true, me: { role: me.role, label: me.label, name: me.name } };
    } catch (err) {
      if (err instanceof ServiceError) return asReply(reply, err);
      throw err;
    }
  });

  app.get<{ Params: { code: string } }>('/api/rooms/:code/plan', (req, reply) => {
    const version = Number((req.query as { version?: string }).version);
    try {
      return { ok: true, ...svc.planView(req.params.code, Number.isInteger(version) && version > 0 ? version : null) };
    } catch (err) {
      if (err instanceof ServiceError) return asReply(reply, err);
      throw err;
    }
  });

  app.post<{ Params: { code: string } }>('/api/rooms/:code/messages', (req, reply) => {
    const body = (req.body ?? {}) as { text?: string; reply_to?: number };
    try {
      const cred = credential(svc, req, req.params.code);
      const message = svc.postHumanMessage(cred, { text: body.text ?? '', reply_to: body.reply_to ?? null });
      return { ok: true, message };
    } catch (err) {
      if (err instanceof ServiceError) return asReply(reply, err);
      throw err;
    }
  });

  app.post<{ Params: { code: string } }>('/api/rooms/:code/invite', (req, reply) => {
    const body = (req.body ?? {}) as { side?: 'frontend' | 'backend'; name?: string };
    try {
      const cred = credential(svc, req, req.params.code);
      const out = svc.invite(cred, { side: body.side, name: body.name });
      return { ok: true, ...out, url: out.link };
    } catch (err) {
      if (err instanceof ServiceError) return asReply(reply, err);
      throw err;
    }
  });

  app.post<{ Params: { code: string } }>('/api/rooms/:code/confirm', (req, reply) => {
    const body = (req.body ?? {}) as { verdict?: 'ok' | 'issue'; note?: string };
    try {
      const cred = credential(svc, req, req.params.code);
      return { ok: true, ...svc.confirm(cred, { verdict: body.verdict, note: body.note }) };
    } catch (err) {
      if (err instanceof ServiceError) return asReply(reply, err);
      throw err;
    }
  });

  app.post<{ Params: { code: string } }>('/api/rooms/:code/close', (req, reply) => {
    try {
      const cred = credential(svc, req, req.params.code);
      svc.closeRoom(cred);
      return { ok: true, status: 'closed', status_label: '已关闭' };
    } catch (err) {
      if (err instanceof ServiceError) return asReply(reply, err);
      throw err;
    }
  });
}
