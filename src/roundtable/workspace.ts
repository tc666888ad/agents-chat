import { constants, lstatSync, promises as fs, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { RtError } from './service.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 500;
const MAX_ENTRIES = 5000;
const ALLOWED_ROOTS = new Set(['AGENTS.md', '.agents', '.codex', 'src', 'tests', 'docs']);
const EXCLUDED = new Set(['.git', 'node_modules', 'data', '.next', 'dist']);

function cleanPath(input = ''): string {
  const value = input.replaceAll('\\', '/');
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\0')) throw new RtError('VALIDATION_FAILED', '请使用工作区相对路径');
  if (!value || value === '.') return '';
  if (value.split('/').some((part) => part === '..' || part === '.')) throw new RtError('VALIDATION_FAILED', '工作区路径不合法');
  return value.replace(/\/+$/, '');
}

function allowed(path: string): boolean {
  const parts = path.split('/');
  return ALLOWED_ROOTS.has(parts[0]!) && parts.every((part) => {
    const lower = part.toLowerCase();
    return !EXCLUDED.has(lower) && !/^\.env(?:[.-]|$)/.test(lower) && !/\.(key|pem|p12|pfx|keystore)$/.test(lower)
      && !/^(auth|credentials|secrets?|tokens?)([._-]|$)/.test(lower);
  });
}

// 记忆目录只开放文档，避免把客户端配置、认证缓存当作项目记忆暴露。
function memoryDocument(path: string): boolean {
  return !/^\.(agents|codex)\//.test(path) || /\.(md|markdown|txt)$/i.test(path);
}

export class WorkspaceReader {
  readonly root: string;
  constructor(root = process.cwd()) { this.root = realpathSync(root); }

  private path(input = ''): string {
    const clean = cleanPath(input);
    if (clean && !allowed(clean)) throw new RtError('VALIDATION_FAILED', '只能读取项目代码和记忆文件，不能读取敏感路径');
    const abs = resolve(this.root, clean);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new RtError('VALIDATION_FAILED', '工作区路径越界');
    // 检查全部父目录，避免通过目录别名绕过路径规则。
    let parent = this.root;
    for (const part of clean.split('/').filter(Boolean)) {
      parent = resolve(parent, part);
      let stat;
      try { stat = lstatSync(parent); } catch { throw new RtError('NOT_FOUND', '工作区里没有这个路径'); }
      if (stat.isSymbolicLink()) throw new RtError('VALIDATION_FAILED', '不允许读取符号链接');
    }
    return abs;
  }

  async list(input = ''): Promise<string[]> {
    const clean = cleanPath(input);
    const out: string[] = [];
    let visited = 0;
    const walk = async (path: string, depth: number): Promise<void> => {
      if (out.length >= MAX_FILES || visited++ >= MAX_ENTRIES || depth > 32) return;
      const abs = this.path(path);
      const stat = lstatSync(abs);
      if (stat.isFile()) {
        if (memoryDocument(path)) out.push(path);
      } else if (stat.isDirectory()) {
        const dir = await fs.opendir(abs);
        for await (const entry of dir) {
          if (out.length >= MAX_FILES || visited >= MAX_ENTRIES) break;
          const child = path ? `${path}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink() || !allowed(child)) { visited++; continue; }
          await walk(child, depth + 1);
        }
      }
    };
    await walk(clean, 0);
    return out.sort();
  }

  async read(input: string): Promise<{ path: string; text: string; bytes: number }> {
    const clean = cleanPath(input);
    if (!memoryDocument(clean)) throw new RtError('VALIDATION_FAILED', '记忆目录只允许读取文档');
    const abs = this.path(clean);
    const file = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new RtError('VALIDATION_FAILED', '只能读取文本文件');
      if (stat.size > MAX_FILE_BYTES) throw new RtError('VALIDATION_FAILED', '文件超过 512KB，请拆分后读取');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new RtError('VALIDATION_FAILED', '文件超过 512KB');
      const data = buffer.subarray(0, bytesRead);
      if (data.includes(0)) throw new RtError('VALIDATION_FAILED', '只允许读取文本文件');
      return { path: relative(this.root, abs).replaceAll(sep, '/'), text: new TextDecoder('utf-8', { fatal: true }).decode(data), bytes: bytesRead };
    } finally { await file.close(); }
  }

  async search(query: string, path = '', limit = 50): Promise<{ path: string; line: number; text: string }[]> {
    const q = query.trim().toLowerCase();
    if (!q || q.length > 200) throw new RtError('VALIDATION_FAILED', '搜索词长度应为 1–200 字');
    const out: { path: string; line: number; text: string }[] = [];
    const max = Math.min(Math.max(limit, 1), 100);
    for (const file of await this.list(path)) {
      if (out.length >= max) break;
      let item;
      try { item = await this.read(file); } catch { continue; }
      for (const [i, line] of item.text.split(/\r?\n/).entries()) {
        if (line.toLowerCase().includes(q)) out.push({ path: item.path, line: i + 1, text: line.slice(0, 1000) });
        if (out.length >= max) break;
      }
    }
    return out;
  }
}
