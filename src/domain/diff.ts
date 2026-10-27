/** JSON Pointer 结构化 diff：只输出"哪个位置变了"，不做全文对比。 */

export type DiffOp = '+' | '-' | '~';

export interface DiffEntry {
  op: DiffOp;
  pointer: string;
  /** 人类可读的一行说明，用于网页展示 */
  label: string;
}

export function escapePointer(seg: string | number): string {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function toPointer(path: Array<string | number>): string {
  return path.length === 0 ? '' : '/' + path.map(escapePointer).join('/');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

/**
 * 比较两份 JSON 文档。
 * - 对象：按 key 求并集；新增/删除各出一条，共同 key 递归
 * - 数组：按下标比较，多出的下标各出一条
 * - 标量：不相等出一条 `~`
 */
export function diffDocs(a: unknown, b: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(a, b, [], out);
  return out;
}

/** 把 ['paths','/u','get','parameters',0,'name'] 压成 'parameters[0].name'，方便人一眼定位。 */
function tailLabel(path: Array<string | number>): string {
  const parts: string[] = [];
  for (const seg of path) {
    if (typeof seg === 'number') {
      if (parts.length) parts[parts.length - 1] += `[${seg}]`;
      else parts.push(`[${seg}]`);
    } else {
      parts.push(seg);
    }
  }
  return parts.slice(-2).join('.') || '(根)';
}

function walk(a: unknown, b: unknown, path: Array<string | number>, out: DiffEntry[]): void {
  if (Object.is(a, b)) return;

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const inA = Object.prototype.hasOwnProperty.call(a, k);
      const inB = Object.prototype.hasOwnProperty.call(b, k);
      const p = [...path, k];
      if (inA && !inB) {
        out.push({ op: '-', pointer: toPointer(p), label: `${k} 被删除（原值 ${short(a[k])}）` });
      } else if (!inA && inB) {
        out.push({ op: '+', pointer: toPointer(p), label: `${k} 新增：${short(b[k])}` });
      } else {
        walk(a[k], b[k], p, out);
      }
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      const p = [...path, i];
      if (i >= a.length) {
        out.push({ op: '+', pointer: toPointer(p), label: `新增第 ${i + 1} 项：${short(b[i])}` });
      } else if (i >= b.length) {
        out.push({ op: '-', pointer: toPointer(p), label: `删除第 ${i + 1} 项（原值 ${short(a[i])}）` });
      } else {
        walk(a[i], b[i], p, out);
      }
    }
    return;
  }

  out.push({
    op: '~',
    pointer: toPointer(path),
    label: `${tailLabel(path)} 由 ${short(a)} 改为 ${short(b)}`,
  });
}

/** 用在网页和返回体里的紧凑摘要，例如 "+3 ~2 -1" */
export function diffSummary(entries: DiffEntry[]): string {
  const add = entries.filter((e) => e.op === '+').length;
  const del = entries.filter((e) => e.op === '-').length;
  const chg = entries.filter((e) => e.op === '~').length;
  if (!entries.length) return '与上一版相同';
  const parts: string[] = [];
  if (add) parts.push(`+${add}`);
  if (chg) parts.push(`~${chg}`);
  if (del) parts.push(`-${del}`);
  return parts.join(' ');
}
