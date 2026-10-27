/** OpenAI 兼容的 chat/completions 流式调用 + 不花钱的演示模式。 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  /** 每收到一段文本回调一次，参数是累计全文 */
  onText: (full: string) => void;
}

export type LlmCaller = (req: LlmRequest) => Promise<string>;

export const DEMO_BASE_URL = 'demo';

export function isDemo(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase() === DEMO_BASE_URL;
}

export function completionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

export const openAiCompatible: LlmCaller = async (req) => {
  const res = await fetch(completionsUrl(req.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: req.model, messages: req.messages, stream: true }),
    signal: req.signal,
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status}${text ? `：${text}` : ''}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream') || !res.body) {
    // 服务端不支持流式：按普通 JSON 读
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const full = json.choices?.[0]?.message?.content ?? '';
    req.onText(full);
    return full;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const piece = chunk.choices?.[0]?.delta?.content ?? '';
        if (piece) {
          full += piece;
          req.onText(full);
        }
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  }
  return full;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    });
  });

/** 演示模式：不调用任何模型，模拟“思考 → 逐字输出”。 */
export function demoCaller(stepMs = 35): LlmCaller {
  return async (req) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const name = /你是「(.+?)」/.exec(system)?.[1] ?? '演示 agent';
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // 连续的 user 消息会被合并，取主持人（[我]）最后一段
    const segments = lastUser.split(/\n\n(?=\[[^\]]*\]: )/);
    const mine = [...segments].reverse().find((s) => s.startsWith('[我]: ')) ?? segments.at(-1) ?? '';
    const question = mine.replace(/^\[[^\]]*\]:\s*/, '').replace(/@\S+\s*/g, '').trim().slice(0, 60);
    const isPlan = system.includes('【任务：出方案】') || system.includes('【任务：修订方案】');
    const isReview = system.includes('【任务：审查方案】');
    let reply;
    if (isReview) {
      reply = `## 结论\n\n改完再做：演示审查需要补齐验收标准和异常流程。\n\n## 必须改\n\n1. **需求与接口映射不完整**：建议为每条核心需求补充接口、权限和错误码。\n2. **缺少失败路径**：补充超时、重试、重复提交和数据回滚。\n\n## 建议改\n\n- 增加监控指标、日志字段和灰度开关。\n- 给关键流程补一组端到端验收用例。\n\n> ${name}（演示模式）`;
    } else if (isPlan) {
      reply = `## 需求理解\n\n这版先把需求拆成可验收的模块，覆盖主流程、权限和异常处理。\n\n## 总体设计\n\n采用清晰的分层结构：接口层负责校验，服务层负责业务编排，数据层负责持久化。\n\n## 接口与数据\n\n- 提供创建、查询、更新接口，统一返回 \`{ ok, data, error }\`。\n- 关键记录保留状态、创建时间和更新时间，便于重试与审计。\n\n## 关键流程\n\n1. 校验需求和权限；\n2. 写入主记录并记录操作日志；\n3. 异步处理耗时任务，失败可重试；\n4. 返回可追踪的结果。\n\n## 风险与待确认\n\n- 需要确认并发冲突时的处理策略；\n- 需要补充数据保留周期和权限边界。\n\n## 任务拆分\n\n- 接口与数据模型；\n- 核心服务逻辑；\n- 前端交互；\n- 测试、监控和上线检查。\n\n> ${name}（演示模式，未调用真实模型）`;
    } else {
      reply =
        `（演示回复，未调用真实模型）我是 ${name}。\n` +
        `你说的是：「${question || '……'}」。\n` +
        `接入真实模型后，这里会是 ${name} 的回答；可以在成员设置里把 API 地址从 demo 换成真实地址。`;
    }
    await sleep(stepMs * 12, req.signal);
    let full = '';
    for (const ch of reply) {
      full += ch;
      req.onText(full);
      await sleep(stepMs, req.signal);
    }
    return full;
  };
}
