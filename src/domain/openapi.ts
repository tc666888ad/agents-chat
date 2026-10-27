/** OpenAPI 3.x 的轻校验与接口清单抽取。v0.1 只挡"根本不像契约"的文档。 */

export interface OperationSummary {
  path: string;
  method: string;
  summary: string;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;

export type ValidateResult =
  | { ok: true; ops: OperationSummary[] }
  | { ok: false; message: string };

export function validateOpenApi(doc: unknown): ValidateResult {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, message: '契约必须是一个 JSON 对象' };
  }
  const d = doc as Record<string, unknown>;
  if (typeof d.openapi !== 'string') {
    return { ok: false, message: '缺少 openapi 字段（例如 "3.1.0"）' };
  }
  if (!/^3\./.test(d.openapi)) {
    return { ok: false, message: `只支持 OpenAPI 3.x，收到 ${d.openapi}` };
  }
  if (typeof d.paths !== 'object' || d.paths === null || Array.isArray(d.paths)) {
    return { ok: false, message: '缺少 paths 对象' };
  }
  const paths = d.paths as Record<string, unknown>;
  const ops: OperationSummary[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/')) return { ok: false, message: `path 必须以 / 开头：${path}` };
    if (typeof item !== 'object' || item === null) {
      return { ok: false, message: `path 的定义必须是对象：${path}` };
    }
    for (const [key, op] of Object.entries(item as Record<string, unknown>)) {
      const method = key.toLowerCase();
      if (!(METHODS as readonly string[]).includes(method)) continue;
      if (typeof op !== 'object' || op === null) {
        return { ok: false, message: `${method.toUpperCase()} ${path} 必须是对象` };
      }
      const o = op as Record<string, unknown>;
      const responses = o.responses;
      if (typeof responses !== 'object' || responses === null || Array.isArray(responses)) {
        return { ok: false, message: `${method.toUpperCase()} ${path} 缺少 responses` };
      }
      ops.push({
        path,
        method: method.toUpperCase(),
        summary: typeof o.summary === 'string' ? o.summary : '',
      });
    }
  }
  if (ops.length === 0) return { ok: false, message: '契约里没有任何 operation' };
  return { ok: true, ops };
}

/** 归一化：只保留我们关心的结构，避免把无关字段写进 diff 噪音 */
export function canonicalize(doc: unknown): unknown {
  return doc;
}
