import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { RtError } from './errors.js';

/** 不允许绑定为项目目录的位置（本身或其下级） */
function forbiddenDirs(): { exact: string[]; tree: string[] } {
  const home = homedir();
  return {
    exact: ['/', home, '/Users', '/Applications', '/Volumes', '/private/tmp', '/tmp', '/var', '/private/var'],
    tree: ['/System', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/Library', '/dev', '/cores', resolve(home, '.ssh'), resolve(home, '.dsh'), resolve(home, '.codex'), resolve(home, '.aws'), resolve(home, '.gnupg'), resolve(home, '.config'), resolve(home, 'Library')],
  };
}

/** 校验并规范化项目目录；'' 表示解绑。 */
export function checkProjectDir(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  if (!isAbsolute(raw)) throw new RtError('VALIDATION_FAILED', '项目目录要写绝对路径');
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    throw new RtError('VALIDATION_FAILED', '项目目录不存在');
  }
  if (!statSync(real).isDirectory()) throw new RtError('VALIDATION_FAILED', '项目目录不是文件夹');
  const { exact, tree } = forbiddenDirs();
  const norm = (d: string) => {
    try { return realpathSync(d); } catch { return d; }
  };
  if (exact.map(norm).includes(real)) throw new RtError('VALIDATION_FAILED', '不能把整个系统目录或主目录当项目目录，选具体的项目文件夹');
  for (const t of tree.map(norm)) {
    if (real === t || real.startsWith(t + sep)) throw new RtError('VALIDATION_FAILED', '这个位置不允许给 Agent 读取');
  }
  return real;
}
