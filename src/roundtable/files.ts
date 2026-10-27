/** 房间文件：上传的需求文档 + 方案/审查产物，都放在 <数据目录>/<房间号>/ 下。 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const PLAIN = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.sql', '.xml', '.log', '.proto']);
/** macOS 自带 textutil 能转成纯文本的格式 */
const RICH = new Set(['.docx', '.doc', '.rtf', '.html', '.htm', '.odt']);
export const ACCEPT = [...PLAIN, ...RICH];

export class FileError extends Error {}

/** 去掉路径和非法字符，保留中文。 */
export function safeName(name: string): string {
  const base = String(name ?? '').split(/[/\\]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!clean) return 'file';
  if (clean.length <= 120) return clean;
  const ext = extname(clean).slice(0, 12);
  return clean.slice(0, 120 - ext.length) + ext;
}

export class RoomFiles {
  constructor(readonly root: string) {}

  dir(code: string): string {
    if (!/^[A-Za-z0-9-]{3,32}$/.test(code)) throw new FileError('房间号不对');
    return join(this.root, code);
  }

  /** 房间内相对路径 → 绝对路径，防止 ../ 越界。 */
  resolve(code: string, rel: string): string {
    const dir = resolve(this.dir(code));
    const abs = resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + sep)) throw new FileError('路径不对');
    return abs;
  }

  /** 保存上传原件，同名自动加 (2)(3)。返回房间内相对路径。 */
  saveDoc(code: string, name: string, data: Buffer): string {
    const docs = join(this.dir(code), 'docs');
    mkdirSync(docs, { recursive: true });
    const clean = safeName(name);
    const ext = extname(clean);
    const stem = clean.slice(0, clean.length - ext.length);
    let file = clean;
    for (let i = 2; existsSync(join(docs, file)); i++) file = `${stem}(${i})${ext}`;
    writeFileSync(join(docs, file), data);
    return `docs/${file}`;
  }

  write(code: string, rel: string, text: string): string {
    const abs = this.resolve(code, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
    return abs;
  }

  read(code: string, rel: string): Buffer {
    return readFileSync(this.resolve(code, rel));
  }

  exists(code: string, rel: string): boolean {
    return existsSync(this.resolve(code, rel));
  }

  remove(code: string, rel: string): void {
    const abs = this.resolve(code, rel);
    if (existsSync(abs)) unlinkSync(abs);
  }

  relativeToCwd(abs: string): string {
    return relative(process.cwd(), abs);
  }
}

function textutil(abs: string): Promise<string> {
  return new Promise((ok, fail) => {
    execFile('/usr/bin/textutil', ['-convert', 'txt', '-stdout', abs], { timeout: 20_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) fail(err);
      else ok(stdout);
    });
  });
}

/** 从文件里取出纯文本。abs 是已经落盘的原件。 */
export async function extractText(abs: string, data: Buffer): Promise<string> {
  const ext = extname(abs).toLowerCase();
  if (ext === '.pdf') throw new FileError('PDF 暂时解析不了：请另存为 .docx / .md，或直接把文字粘到“补充说明”里');
  if (PLAIN.has(ext)) return data.toString('utf8').replace(/^\uFEFF/, '');
  if (RICH.has(ext)) {
    if (!existsSync('/usr/bin/textutil')) throw new FileError(`这台机器解析不了 ${ext}，请转成 .md 或 .txt`);
    try {
      return await textutil(abs);
    } catch {
      throw new FileError(`${ext} 文件解析失败，可能已损坏或加密`);
    }
  }
  throw new FileError(`不支持 ${ext || '无后缀'} 文件，支持：${ACCEPT.join(' ')}`);
}
