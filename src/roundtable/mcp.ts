import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { type AgentRow } from './db.js';
import { RtError, type RoundtableService } from './service.js';
import { WorkspaceReader } from './workspace.js';

const MAX_FILES = 500;
const MAX_RESULTS = 100;

const payload = (value: unknown, isError = false) => ({
  isError,
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const failure = (err: unknown) => {
  if (err instanceof RtError) return payload({ ok: false, error: { code: err.code, message: err.message } }, true);
  return payload({ ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } }, true);
};

export function buildRoundtableMcpServer(rt: RoundtableService, agent: AgentRow): McpServer {
  const workspace = new WorkspaceReader();
  const server = new McpServer(
    { name: `roundtable-${agent.name}`, version: '1.0.0' },
    {
      instructions: [
        `你是「${agent.name}」，通过 MCP 接入 AI 圆桌。`,
        '先调用 join_roundtable，再调用 get_roundtable_tasks。任务会包含需求文档和房间上下文。',
        '需要了解项目现状时，使用 list_workspace_files、search_workspace、read_workspace_file 读取代码和记忆文件。',
        '开始方案或审查前，先读 AGENTS.md 和相关项目记忆，再搜索和阅读与需求有关的已有代码；结论引用文件路径和行号。',
        '上下文中的文档若被截断，用 read_roundtable_document 按 doc_id 读取完整上传文本。',
        '完成任务后必须调用 complete_roundtable_task；普通讨论使用 send_roundtable_message。',
        '没有待办就结束本轮；只有用户明确让你等待时才使用 wait_seconds。连接 MCP 不会自动启动你或保持后台执行。',
        '工作区工具只读，不能修改代码；不要读取敏感文件或项目之外的路径。',
      ].join('\n'),
    },
  );

  server.registerTool('join_roundtable', {
    title: '加入 AI 圆桌房间',
    description: '加入指定房间并返回需求文档、消息、成员和当前待办。',
    inputSchema: { room_code: z.string().min(1).describe('房间号，例如 RT-AB12') },
  }, (args) => {
    try { return payload({ ok: true, ...rt.joinExternalRoom(agent.id, args.room_code) }); } catch (err) { return failure(err); }
  });

  server.registerTool('read_roundtable_document', {
    title: '读取上传需求文档',
    description: '按房间和文档 ID 读取完整的需求文档文本（ID 来自 join_roundtable 的 room.docs）。',
    inputSchema: { room_code: z.string().min(1), doc_id: z.string().min(1) },
  }, (args) => {
    try { return payload({ ok: true, document: rt.externalDocText(agent.id, args.room_code, args.doc_id) }); } catch (err) { return failure(err); }
  });

  server.registerTool('get_roundtable_tasks', {
    title: '获取圆桌待办',
    description: '获取分配给当前 Agent 的方案、审查或修订任务；可等待最多 30 秒。',
    inputSchema: {
      room_code: z.string().min(1),
      wait_seconds: z.number().int().min(0).max(30).optional(),
    },
  }, async (args) => {
    try { return payload({ ok: true, tasks: await rt.getExternalTasks(agent.id, args.room_code, args.wait_seconds ?? 0) }); } catch (err) { return failure(err); }
  });

  server.registerTool('complete_roundtable_task', {
    title: '提交圆桌任务',
    description: '提交完整的方案、审查意见或修订方案，消息会标记完成并保存为房间产物。',
    inputSchema: { room_code: z.string().min(1), seq: z.number().int().positive(), body: z.string().min(1).max(160000) },
  }, (args) => {
    try { return payload({ ok: true, ...rt.completeExternalTask(agent.id, args.room_code, args.seq, args.body) }); } catch (err) { return failure(err); }
  });

  server.registerTool('send_roundtable_message', {
    title: '在圆桌发言',
    description: '发送普通讨论消息，不会自动触发其他 Agent。',
    inputSchema: { room_code: z.string().min(1), text: z.string().min(1).max(8000) },
  }, (args) => {
    try { return payload({ ok: true, ...rt.externalSendMessage(agent.id, args.room_code, args.text) }); } catch (err) { return failure(err); }
  });

  server.registerTool('list_workspace_files', {
    title: '列出工作区文件',
    description: '列出项目代码、文档和记忆目录中的文件。',
    inputSchema: { path: z.string().optional(), limit: z.number().int().min(1).max(MAX_FILES).optional() },
  }, async (args) => {
    try { return payload({ ok: true, files: (await workspace.list(args.path)).slice(0, args.limit ?? MAX_FILES) }); } catch (err) { return failure(err); }
  });

  server.registerTool('search_workspace', {
    title: '搜索工作区',
    description: '在允许读取的项目文件中按文本搜索，返回文件和行号。',
    inputSchema: { query: z.string().min(1).max(200), path: z.string().optional(), limit: z.number().int().min(1).max(MAX_RESULTS).optional() },
  }, async (args) => {
    try { return payload({ ok: true, matches: await workspace.search(args.query, args.path, args.limit ?? 50) }); } catch (err) { return failure(err); }
  });

  server.registerTool('read_workspace_file', {
    title: '读取工作区文件',
    description: '读取项目代码、AGENTS.md、.agents、.codex、docs 等文本文件。',
    inputSchema: { path: z.string().min(1) },
  }, async (args) => {
    try { return payload({ ok: true, file: await workspace.read(args.path) }); } catch (err) { return failure(err); }
  });

  return server;
}

function tokenFrom(req: FastifyRequest): string {
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1]?.trim() ?? '';
}

export function registerRoundtableMcp(app: FastifyInstance, rt: RoundtableService): void {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const agent = rt.authenticateExternalAgent(tokenFrom(req));
    if (!agent) return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: '缺少或无效的 MCP Bearer token' } });
    const server = buildRoundtableMcpServer(rt, agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
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
  app.all('/rt-mcp', { bodyLimit: 2 * 1024 * 1024 }, handler);
  app.all('/rt-mcp/', { bodyLimit: 2 * 1024 * 1024 }, handler);
}
