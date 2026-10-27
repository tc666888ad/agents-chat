/**
 * 本地 Agent 执行器：由圆桌服务直接启动本机的 Codex CLI / DeepSeek Harness（headless），
 * 在绑定的项目目录里只读分析，结果自动回传。
 *
 * 约束：参数数组 spawn（不走 shell）；任务走 stdin；认证不进命令行和日志；
 * 独立进程组，停止/超时/服务退出时整组结束。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ExecKind = 'codex' | 'dsh';
export const EXEC_KINDS: readonly ExecKind[] = ['codex', 'dsh'];
export const EXEC_LABEL: Record<ExecKind, string> = { codex: 'Codex CLI', dsh: 'DeepSeek Harness' };

export const isExecKind = (v: string): v is ExecKind => (EXEC_KINDS as readonly string[]).includes(v);

const DEFAULT_BIN: Record<ExecKind, string[]> = {
  codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
  dsh: ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'],
};
const ENV_BIN: Record<ExecKind, string> = { codex: 'RT_CODEX_BIN', dsh: 'RT_DSH_BIN' };

/** 找执行器路径：环境变量覆盖 → 默认安装位置。找不到返回 null。 */
export function resolveBin(kind: ExecKind, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[ENV_BIN[kind]]?.trim();
  for (const p of override ? [override] : DEFAULT_BIN[kind]) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

export interface LocalRunRequest {
  kind: ExecKind;
  /** 可选，覆盖本次子进程的模型连接，不改全局 CLI 配置。 */
  baseUrl?: string;
  apiKey?: string;
  /** 项目目录（已校验的绝对路径） */
  cwd: string;
  prompt: string;
  /** 可选：透传给执行器的模型名（仅 Codex 支持 -m） */
  model?: string;
  signal: AbortSignal;
  /** 运行阶段，例如「读取 src/a.ts」 */
  onProgress: (text: string) => void;
  /** 中间文本（累计），用于网页实时显示 */
  onText: (full: string) => void;
}

export type LocalRunner = (req: LocalRunRequest) => Promise<string>;

const MAX_STDERR = 4000;
const KILL_GRACE_MS = 5000;
const children = new Set<ChildProcess>();

/** force：主进程已退出也照样向整组发信号（清理残留的孙进程）。 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals, force = false): void {
  if (!child.pid || (!force && (child.exitCode !== null || child.signalCode !== null))) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* 已退出 */ }
  }
}

/** 服务退出时调用：结束所有本地 Agent 进程组。 */
export function killAllLocalAgents(): void {
  for (const c of children) killGroup(c, 'SIGTERM');
  const left = [...children];
  if (left.length) setTimeout(() => left.forEach((c) => killGroup(c, 'SIGKILL')), 1000).unref();
}

const short = (s: unknown, n = 120): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 从工具入参里挑一个能看懂的摘要（路径/命令/搜索词）。 */
function toolBrief(input: unknown): string {
  if (!input || typeof input !== 'object') return short(input, 80);
  const o = input as Record<string, unknown>;
  for (const k of ['path', 'file_path', 'file', 'filePath', 'pattern', 'query', 'command', 'cmd', 'url']) {
    const v = o[k];
    if (typeof v === 'string' && v) return short(v, 100);
    if (Array.isArray(v) && v.length) return short(v.join(' '), 100);
  }
  return '';
}

export interface ParsedEvent {
  progress?: string;
  /** 新增文本片段（追加） */
  text?: string;
  /** 最终答案（覆盖） */
  final?: string;
  error?: string;
}

/** Codex `exec --json` 事件（宽松解析，兼容新旧两种格式）。 */
export function parseCodexEvent(e: any): ParsedEvent {
  if (!e || typeof e !== 'object') return {};
  const type: string = e.type ?? e.msg?.type ?? '';
  if (type === 'thread.started' || type === 'session_configured') return { progress: 'Codex 已启动' };
  if (type === 'turn.started' || type === 'task_started') return { progress: '开始分析' };
  if (type === 'turn.failed') return { error: short(e.error?.message ?? '运行失败', 300) };
  if (type === 'error') return { error: short(e.message ?? e.msg?.message ?? '运行失败', 300) };
  if (type.startsWith('item.')) {
    const item = e.item ?? {};
    const done = type === 'item.completed';
    switch (item.type) {
      case 'agent_message':
        return done && item.text ? { text: String(item.text), progress: '整理结果' } : {};
      case 'reasoning':
        return { progress: '思考中' };
      case 'command_execution':
        return done ? {} : { progress: `执行：${short(item.command, 100)}` };
      case 'mcp_tool_call':
        return done ? {} : { progress: `调用工具：${short(item.tool ?? item.name, 60)}` };
      case 'web_search':
        return { progress: '搜索' };
      case 'file_change':
        return { progress: '尝试修改文件（只读模式会拒绝）' };
      case 'todo_list':
        return { progress: '制定步骤' };
      case 'error':
        return { progress: `出错：${short(item.message, 100)}` };
      default:
        return {};
    }
  }
  // 旧格式 {id, msg:{type,...}}
  const msg = e.msg;
  if (msg) {
    if (type === 'agent_message' && msg.message) return { text: String(msg.message), progress: '整理结果' };
    if (type === 'agent_reasoning') return { progress: '思考中' };
    if (type === 'exec_command_begin') return { progress: `执行：${short(Array.isArray(msg.command) ? msg.command.join(' ') : msg.command, 100)}` };
    if (type === 'task_complete' && msg.last_agent_message) return { final: String(msg.last_agent_message) };
  }
  return {};
}

/** DeepSeek Harness `--profile headless --json` 事件。 */
/** turn_end 的 reason 可能是字符串，也可能是 { kind / type / code / message } 对象。 */
function reasonText(r: unknown): string {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r === 'object') {
    const o = r as Record<string, unknown>;
    for (const k of ['kind', 'type', 'code', 'message']) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
    try { return JSON.stringify(r); } catch { return ''; }
  }
  return String(r);
}

export function parseDshEvent(e: any): ParsedEvent {
  if (!e || typeof e !== 'object') return {};
  switch (e.type) {
    case 'session':
      return { progress: 'Harness 已启动' };
    case 'status':
      if (e.phase === 'turn_start') return { progress: '开始分析' };
      if (e.phase === 'turn_end') {
        const r = reasonText(e.reason);
        if (r && r !== 'completed' && r !== 'stop') return { progress: `结束：${short(r, 40)}` };
      }
      return {};
    case 'thinking':
      return { progress: '思考中' };
    case 'text':
      return e.text ? { text: String(e.text) } : {};
    case 'tool_call': {
      const brief = toolBrief(e.input);
      return { progress: `${short(e.tool, 40)}${brief ? `：${brief}` : ''}` };
    }
    case 'tool_result':
      return e.status === 'error' ? { progress: '工具调用失败，继续' } : {};
    case 'final':
      return { final: String(e.text ?? '') };
    case 'error':
      return { error: short(reasonText(e.message ?? e.error) || '运行失败', 300) };
    default:
      return {};
  }
}

interface Plan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  outFile?: string;
  cleanup: () => void;
  parse: (e: any) => ParsedEvent;
}

function plan(req: LocalRunRequest, bin: string): Plan {
  // 继承 CLI 环境；房间 Agent 的独立凭据仅覆盖本次子进程，不写全局配置。
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (req.kind === 'codex') {
    const dir = mkdtempSync(join(tmpdir(), 'rt-codex-'));
    const outFile = join(dir, 'last.md');
    const args = ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-C', req.cwd, '-o', outFile];
    if (req.apiKey) env.RT_LOCAL_API_KEY = req.apiKey;
    if (req.baseUrl || req.apiKey) {
      const config: Record<string, string | boolean | number> = {
        model_provider: 'roundtable',
        'model_providers.roundtable.name': 'Roundtable',
        'model_providers.roundtable.base_url': req.baseUrl || 'https://api.openai.com/v1',
        'model_providers.roundtable.wire_api': 'responses',
        'model_providers.roundtable.requires_openai_auth': false,
        'model_providers.roundtable.request_max_retries': 2,
        'model_providers.roundtable.stream_max_retries': 2,
        'model_providers.roundtable.stream_idle_timeout_ms': 60_000,
      };
      if (req.apiKey) config['model_providers.roundtable.env_key'] = 'RT_LOCAL_API_KEY';
      for (const [k, v] of Object.entries(config)) args.push('-c', `${k}=${JSON.stringify(v)}`);
    }
    if (req.model?.trim()) args.push('-m', req.model.trim());
    args.push('-');
    return { bin, args, env, outFile, cleanup: () => rmSync(dir, { recursive: true, force: true }), parse: parseCodexEvent };
  }
  // DSH：工作区取进程 cwd；read-only 下 headless 没有审批者，升权请求会失败关闭
  env.DSH_PERMISSION_MODE = 'read-only';
  if (req.apiKey) env.DEEPSEEK_API_KEY = req.apiKey;
  if (req.baseUrl) env.DEEPSEEK_BASE_URL = req.baseUrl;
  // Harness 会忽略 SOCKS 代理，显式去掉不支持的值；HTTP(S) 代理保留。
  for (const key of ['ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    if (/^socks/i.test(env[key] || '')) delete env[key];
  }
  const args = ['--profile', 'headless'];
  let cleanup = () => {};
  if (req.model?.trim()) {
    const dir = mkdtempSync(join(tmpdir(), 'rt-dsh-'));
    const patch = join(dir, 'model.json');
    // JSON 也是合法 YAML；临时 overlay 仅包含模型，不含凭据。
    writeFileSync(patch, JSON.stringify([{ id: 'agent-default-model', config: { provider: 'deepseek-official', model: req.model.trim() } }]), { mode: 0o600 });
    args.push('--patch', patch);
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  }
  args.push('--json');
  return { bin, args, env, cleanup, parse: parseDshEvent };
}

export function localTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RT_LOCAL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60_000;
}

/** 默认执行器：启动子进程，解析 JSONL，返回最终 Markdown。 */
export const spawnLocalAgent: LocalRunner = (req) =>
  new Promise<string>((resolve, reject) => {
    if (req.signal.aborted) return reject(req.signal.reason ?? new Error('已停止'));
    const bin = resolveBin(req.kind);
    if (!bin) return reject(new Error(`没找到 ${EXEC_LABEL[req.kind]} 可执行文件，可用 ${ENV_BIN[req.kind]} 指定路径`));
    const p = plan(req, bin);
    const secrets = [req.apiKey, ...Object.entries(p.env).filter(([k]) => /API_KEY|TOKEN|SECRET|PASSWORD/i.test(k)).map(([, v]) => v)].filter((x): x is string => Boolean(x));
    const redact = (value: string) => {
      for (const secret of secrets) value = value.split(secret).join('[已隐藏]');
      return value.replace(/(Bearer\s+)\S+/gi, '$1[已隐藏]');
    };
    const explain = (value: string) => {
      if (/MISSING_CREDENTIAL/i.test(value)) return 'DSH headless 缺少 API Key：请编辑本地 Agent，填写其 API Key；桌面登录态不会自动继承。';
      // 401 / Unauthorized 也可能来自 MCP、工具输出或重试。保留来源，不推断模型 Key 失效。
      return redact(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(p.bin, p.args, { cwd: req.cwd, env: p.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      p.cleanup();
      return reject(err instanceof Error ? err : new Error(String(err)));
    }
    children.add(child);
    req.onProgress(`启动 ${EXEC_LABEL[req.kind]}`);

    let text = '';
    let final: string | null = null;
    let error = '';
    let diagnostic = '';
    let stderr = '';
    let buf = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const handleLine = (line: string) => {
      const t = line.trim();
      if (!t || t[0] !== '{') return;
      let e: unknown;
      try { e = JSON.parse(t); } catch { return; }
      const ev = p.parse(e);
      if (ev.progress) req.onProgress(redact(ev.progress));
      if (ev.error) error = ev.error;
      if (ev.final !== undefined) final = ev.final;
      if (ev.text) {
        text = req.kind === 'codex' ? ev.text : text + ev.text;
        req.onText(redact(text));
      }
    };

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr!.setEncoding('utf8');
    let stderrLine = '';
    const reportDiagnostic = (line: string) => {
      if (/error|warn|reconnect|retry|failed|\b40[13]\b|429|MISSING_CREDENTIAL/i.test(line)) {
        diagnostic = short(explain(line), 300);
        req.onProgress(`执行器诊断（运行中）：${diagnostic}`);
      }
    };
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
      stderrLine += chunk;
      let i: number;
      while ((i = stderrLine.indexOf('\n')) >= 0) {
        reportDiagnostic(stderrLine.slice(0, i));
        stderrLine = stderrLine.slice(i + 1);
      }
      if (stderrLine.length > MAX_STDERR) stderrLine = stderrLine.slice(-MAX_STDERR);
    });

    const onAbort = () => {
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL', true), KILL_GRACE_MS);
      killTimer.unref();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (err: Error | null, out?: string) => {
      if (settled) return;
      settled = true;
      req.signal.removeEventListener('abort', onAbort);
      // 停止后保留 SIGKILL 兜底计时器，确保整组（含孙进程）被清掉
      if (killTimer && !req.signal.aborted) clearTimeout(killTimer);
      children.delete(child);
      p.cleanup();
      if (err) reject(err);
      else resolve(out!);
    };

    child.on('error', (err) => finish(new Error(`启动失败：${err.message}`)));
    child.on('close', (code, signal) => {
      if (buf) handleLine(buf);
      if (stderrLine) reportDiagnostic(stderrLine);
      if (req.signal.aborted) return finish(req.signal.reason instanceof Error ? req.signal.reason : new Error('已停止'));
      let out = final ?? '';
      if (p.outFile) {
        try { out = readFileSync(p.outFile, 'utf8'); } catch { /* 没写出来就用事件里的 */ }
      }
      out = (out || text).trim();
      if (code === 0 && out) return finish(null, redact(out));
      const tail = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/reasoning:/.test(l)).slice(-3).join(' ');
      const why = error || diagnostic || short(tail, 300) || (code === 0 ? 'Agent 没有输出结果' : `退出码 ${code ?? signal}`);
      finish(new Error(short(explain(why), 300)));
    });

    child.stdin!.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ });
    child.stdin!.end(req.prompt);
  });
