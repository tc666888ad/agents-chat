import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CredentialRow } from '../db/index.js';
import { ServiceError, type RoomService } from '../service/room-service.js';
import { ROLE_LABEL } from '../domain/room.js';

const text = (payload: unknown, isError = false) => ({
  isError,
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const fail = (err: unknown) => {
  if (err instanceof ServiceError) return text({ ok: false, error: { code: err.code, message: err.message } }, true);
  return text({ ok: false, error: { code: 'INTERNAL', message: (err as Error).message ?? String(err) } }, true);
};

const GUIDE = [
  '你只需要做三件事：1) 看 my_todos（待办都在这里）；2) 用 send_message 说话、用 submit_plan 提交接口方案；3) 没有待办就结束本轮。',
  '别人不会实时等你，说话的时机由人决定，不要自己轮询。',
  '处理完消息后调用一次 get_messages（wait_seconds 省略或 0）再走，避免漏掉刚到的消息。',
].join('\n');

const ROLE_GUIDE: Record<string, string> = {
  designer:
    '你是设计方：先通读 PRD，列出接口，写出第一版接口方案（submit_plan），然后根据复核方的意见迭代。方案要能被前端直接照着写代码：每个接口有路径、方法、参数、成功与失败响应。',
  reviewer:
    '你是复核方：不负责出方案，负责挑问题。逐条对照 PRD 检查设计方的方案（字段缺不缺、错误码全不全、分页/鉴权/时间格式是否一致），有问题用 send_message 说清楚并 @设计方。',
};

/** 每个请求一个独立实例（无状态传输）。 */
export function buildMcpServer(svc: RoomService, cred: CredentialRow): McpServer {
  const role = cred.role;
  const roleLabel = ROLE_LABEL[role] ?? role;
  const roomCode = cred.room_code;
  const server = new McpServer(
    { name: `negotiation-${roomCode}-${role}`, version: '0.2.0' },
    {
      instructions: [
        `你是「${roomCode}」这个接口协商房间里的${roleLabel}。`,
        ROLE_GUIDE[role] ?? '',
        GUIDE,
        '发言用中文，不要客套，先说结论；拿不准的写进消息里问人，不要自己编。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  );

  server.registerTool(
    'join_room',
    {
      title: '进入房间，拿全部上下文',
      description:
        '先调这个。返回房间信息、PRD、当前接口方案、最近发言、我的待办、下一步提示和安全规则。一次 join 足够，不要重复调。',
      inputSchema: {},
    },
    () => {
      try {
        return text({ ok: true, ...svc.join(cred) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_messages',
    {
      title: '读新消息（可短等）',
      description:
        '取游标之后的新消息，并推进你的游标。wait_seconds 省略或 0 立刻返回；只有当人明确让你等对方时才填 1–30。返回 my_todos/next_hint：没有待办就结束本轮。',
      inputSchema: {
        cursor: z.number().int().min(0).optional().describe('上次返回的 next_cursor；省略则用房间里的已读位置'),
        wait_seconds: z.number().int().min(0).max(30).optional().describe('最多等几秒，默认 0'),
        limit: z.number().int().min(1).max(200).optional().describe('最多取几条，默认 50'),
      },
    },
    async (args) => {
      try {
        const out = await svc.getMessages(cred, args);
        return text({ ok: true, ...out });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'send_message',
    {
      title: '在房间里发言',
      description:
        '发一条普通消息。人 @ 你、质问你时必须带 reply_to（对方消息的 seq），否则人的待办不会消掉。',
      inputSchema: {
        text: z.string().min(1).max(8000).describe('消息内容'),
        reply_to: z.number().int().positive().optional().describe('回复哪一条（seq）'),
      },
    },
    (args) => {
      try {
        const out = svc.sendMessage(cred, args);
        return text({ ok: true, message: out.message, next_cursor: out.next_cursor });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'submit_plan',
    {
      title: '提交一版接口方案',
      description:
        '传完整的 OpenAPI 3.x JSON（不是补丁）。返回这次改动的数量与逐条差异（JSON Pointer）和一句摘要。改完再提交一版即可，不需要先问人。',
      inputSchema: {
        openapi: z.unknown().describe('完整的 OpenAPI 3.x 文档对象'),
        summary: z.string().max(1000).optional().describe('这次改了什么，一句话'),
      },
    },
    (args) => {
      try {
        const out = svc.submitPlan(cred, { openapi: args.openapi, summary: args.summary });
        return text({ ...out });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_plan',
    {
      title: '读接口方案和改动',
      description:
        '不带 version 读最新一版。history=true 时返回历次提交的时间与改动数量（没有版本号，只有时间顺序）。',
      inputSchema: {
        version: z.number().int().positive().optional().describe('第几次提交（1 起），省略读最新'),
        history: z.boolean().optional().describe('是否一起返回历次提交'),
      },
    },
    (args) => {
      try {
        const out = svc.getPlan(cred, args);
        return text({ ...out });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
