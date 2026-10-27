import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDb } from '../src/db/index.js';
import { RoomFiles } from '../src/roundtable/files.js';
import { demoCaller } from '../src/roundtable/llm.js';
import { parseCodexEvent, parseDshEvent, spawnLocalAgent, type LocalRunner, type LocalRunRequest } from '../src/roundtable/local-agent.js';
import { RoundtableService, checkProjectDir } from '../src/roundtable/service.js';

const tmp = mkdtempSync(join(tmpdir(), 'rt-local-test-'));
const project = mkdtempSync(join(tmp, 'project-'));
writeFileSync(join(project, 'AGENTS.md'), '# 记忆');

/** 假执行器：按环境变量 FAKE_MODE 输出 Codex / DSH 格式的 JSONL。 */
const fakeBin = join(tmp, 'fake-agent.mjs');
writeFileSync(
  fakeBin,
  `#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs';
const mode = process.env.FAKE_MODE || 'dsh-ok';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (mode === 'inspect') {
    const args = process.argv.slice(2);
    let model;
    if (args.includes('--patch')) {
      const patch = JSON.parse(readFileSync(args[args.indexOf('--patch') + 1], 'utf8'));
      model = patch.find(x => x.id === 'agent-default-model')?.config.model;
    }
    out({type: 'final', text: JSON.stringify({args, model,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      hasKey: (process.env.RT_LOCAL_API_KEY || process.env.DEEPSEEK_API_KEY) === 'secret-local-key',
      leakedInArgs: args.some(x => x.includes('secret-local-key'))})});
    // Codex uses item events as a fallback when no -o file exists.
    out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({args,
      hasKey: process.env.RT_LOCAL_API_KEY === 'secret-local-key',leakedInArgs:args.some(x=>x.includes('secret-local-key'))})}});
    process.exit(0);
  }
  if (mode === 'credential-error') {
    process.stderr.write('dsh: ALL_PROXY unsupported\\n');
    process.stderr.write('dsh: MISSING_CREDENTIAL secret-local-key no API key\\n');
    process.exit(1);
  }
  if (mode === 'diagnostic-401' || mode === 'auth-retry-ok' || mode === 'auth-fail') {
    const diagnostic = mode === 'diagnostic-401'
      ? 'WARN tool output: src/example.ts:401: Unauthorized enum member'
      : 'WARN mcp_client: HTTP 401 Unauthorized from workspace-tools; Bearer secret-local-key';
    process.stderr.write(diagnostic + '\\n');
    if (mode === 'auth-retry-ok') {
      out({type:'item.completed',item:{type:'agent_message',text:'完成'}});
      process.exit(0);
    }
    if (mode === 'auth-fail') out({type:'turn.failed',error:{message:'unexpected status 401 Unauthorized: provider says account expired; Bearer secret-local-key'}});
    process.exit(1);
  }
  if (mode === 'dsh-ok') {
    out({ type: 'session', id: 's1' });
    out({ type: 'tool_call', tool: 'read_file', input: { path: 'AGENTS.md' } });
    out({ type: 'text', text: '## 结论\\n' });
    out({ type: 'text', text: 'cwd=' + process.cwd() + ' mode=' + process.env.DSH_PERMISSION_MODE + ' len=' + input.length });
    out({ type: 'final', text: '## 结论\\ncwd=' + process.cwd() + ' mode=' + process.env.DSH_PERMISSION_MODE + ' len=' + input.length });
    process.exit(0);
  }
  if (mode === 'codex-ok') {
    const args = process.argv.slice(2);
    const o = args[args.indexOf('-o') + 1];
    out({ type: 'thread.started', thread_id: 't' });
    out({ type: 'item.started', item: { type: 'command_execution', command: 'cat AGENTS.md' } });
    out({ type: 'item.completed', item: { type: 'agent_message', text: '事件里的答案' } });
    writeFileSync(o, '# 文件里的答案\\nargs=' + args.filter((a) => a.startsWith('-')).join(','));
    process.exit(0);
  }
  if (mode === 'fail') {
    out({ type: 'error', message: '凭据缺失' });
    process.stderr.write('boom\\n');
    process.exit(3);
  }
  if (mode === 'hang') {
    out({ type: 'session', id: 's1' });
    setInterval(() => {}, 1000);
  }
});
`,
);
chmodSync(fakeBin, 0o755);
process.env.RT_CODEX_BIN = fakeBin;
process.env.RT_DSH_BIN = fakeBin;

test.after(() => rmSync(tmp, { recursive: true, force: true }));

function setup(runner: LocalRunner) {
  const db = openDb(':memory:');
  const svc = new RoundtableService(db, { real: demoCaller(1), demo: demoCaller(1) }, new RoomFiles(mkdtempSync(join(tmp, 'files-'))), runner);
  const agent = svc.createAgent({ name: 'Codex', runtime: 'local', base_url: 'codex' });
  const room = svc.createRoom({ title: '本地', prd: '做一个登录', agent_ids: [agent.id] });
  return { db, svc, agent, code: room.room.code };
}

async function settle(svc: RoundtableService, code: string) {
  for (let i = 0; i < 300; i++) {
    const s = svc.snapshot(code);
    if (s.messages.every((m) => m.status === 'done' || m.status === 'error')) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('一直没结束');
}

test('本地 Agent：未绑定目录拒绝；绑定后出方案，进度可见，结果回传并落成产物', async () => {
  let seen: LocalRunRequest | undefined;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { svc, agent, code } = setup(async (req) => {
    seen = req;
    req.onProgress('read_file：AGENTS.md');
    await gate;
    return '## 需求理解\n登录 src/a.ts:1';
  });
  assert.equal(agent.runtime, 'local');
  assert.equal(agent.exec_kind, 'codex');
  assert.equal(agent.available, true);
  assert.equal(agent.model, 'default');
  assert.throws(() => svc.startFlow(code, { action: 'plan', agent_id: agent.id }), /绑定项目目录/);
  assert.throws(() => svc.postMessage(code, '@Codex 看看'), /绑定项目目录/);

  const snap = svc.updateRoom(code, { project_dir: project });
  assert.equal(snap.room.project_dir, realpathSync(project));
  assert.ok(snap.messages.some((m) => m.kind === 'system' && m.body.includes('绑定了项目目录')));

  svc.startFlow(code, { action: 'plan', agent_id: agent.id });
  await new Promise((r) => setTimeout(r, 20));
  const running = svc.snapshot(code).messages.at(-1)!;
  assert.equal(running.status, 'pending');
  assert.match(running.progress, /AGENTS\.md/);
  assert.throws(() => svc.updateRoom(code, { project_dir: '' }), /还在跑/);
  assert.equal(seen!.cwd, realpathSync(project));
  assert.equal(seen!.kind, 'codex');
  assert.equal(seen!.model, undefined);
  assert.match(seen!.prompt, /只读/);
  assert.match(seen!.prompt, /AGENTS\.md/);
  assert.match(seen!.prompt, /做一个登录/);
  assert.match(seen!.prompt, /出方案/);

  release();
  const done = await settle(svc, code);
  const reply = done.messages.at(-1)!;
  assert.equal(reply.status, 'done');
  assert.equal(reply.progress, '');
  assert.match(reply.body, /src\/a\.ts:1/);
  assert.equal(done.artifacts.length, 1);
  assert.match(readFileSync(done.artifacts[0]!.path, 'utf8'), /src\/a\.ts:1/);
});

test('本地 Agent：失败保留原因，可重试；停止会中止执行器', async () => {
  let mode: 'fail' | 'hang' | 'ok' = 'fail';
  let aborted = false;
  const { svc, agent, code } = setup((req) => {
    if (mode === 'fail') return Promise.reject(new Error('凭据缺失'));
    if (mode === 'ok') return Promise.resolve('好了');
    return new Promise((_, reject) => req.signal.addEventListener('abort', () => { aborted = true; reject(req.signal.reason); }));
  });
  svc.updateRoom(code, { project_dir: project });
  svc.postMessage(code, '@Codex 看看');
  let s = await settle(svc, code);
  const seq = s.messages.at(-1)!.seq;
  assert.equal(s.messages.at(-1)!.status, 'error');
  assert.equal(s.messages.at(-1)!.error, '凭据缺失');

  mode = 'hang';
  svc.retry(code, seq);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(svc.snapshot(code).members.find((m) => m.id === agent.id)!.busy);
  svc.stop(code, seq);
  s = await settle(svc, code);
  assert.ok(aborted);
  assert.equal(s.messages.at(-1)!.error, '已停止');

  mode = 'ok';
  svc.retry(code, seq);
  s = await settle(svc, code);
  assert.equal(s.messages.at(-1)!.body, '好了');
});

test('本地 Agent 配置：只接受 codex / dsh，模型名受限，独立保存本地凭据且响应不回传 key', () => {
  const { svc, agent } = setup(async () => 'x');
  assert.throws(() => svc.createAgent({ name: 'X', runtime: 'local', base_url: 'bash' }), /codex 或 dsh/);
  assert.throws(() => svc.createAgent({ name: 'Y', runtime: 'local', base_url: 'dsh', model: 'a; rm -rf' }), /模型名/);
  const d = svc.createAgent({ name: 'DSH', runtime: 'local', base_url: 'dsh', api_key: 'sk-should-drop', model: 'deepseek-v4' });
  assert.equal(d.exec_label, 'DeepSeek Harness');
  assert.equal(d.has_key, true);
  assert.ok(!JSON.stringify(d).includes('sk-should-drop'));
  // API agent 切到 local 不沿用旧 API 地址
  const api = svc.createAgent({ name: 'Api', base_url: 'https://example.com', model: 'm', api_key: 'sk' });
  const moved = svc.updateAgent(api.id, { runtime: 'local' });
  assert.equal(moved.base_url, 'codex');
  assert.equal(moved.has_key, false);
  assert.equal(svc.updateAgent(agent.id, { base_url: 'dsh' }).exec_kind, 'dsh');
});

test('项目目录校验：拒绝相对路径、根目录、主目录、敏感目录和不存在的路径', () => {
  assert.equal(checkProjectDir(''), '');
  assert.equal(checkProjectDir(project), realpathSync(project));
  for (const bad of ['src', '/', homedir(), join(homedir(), '.ssh'), '/etc', '/usr/bin', join(tmp, 'nope'), fakeBin]) {
    assert.throws(() => checkProjectDir(bad), Error, bad);
  }
});

test('服务重启：本地 Agent 的未完成回复标记中断；旧库自动补列', () => {
  const dir = mkdtempSync(join(tmp, 'db-'));
  const file = join(dir, 'a.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE rt_rooms (code TEXT PRIMARY KEY, title TEXT NOT NULL, prd TEXT NOT NULL DEFAULT '', next_seq INTEGER NOT NULL DEFAULT 1, rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE rt_messages (id TEXT PRIMARY KEY, room_code TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, agent_id TEXT, author TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', reply_to INTEGER, targets TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(room_code, seq));`);
  old.close();
  const db1 = openDb(file);
  const svc1 = new RoundtableService(db1, { real: demoCaller(1), demo: demoCaller(1) }, new RoomFiles(join(dir, 'files')), () => new Promise(() => {}));
  const a = svc1.createAgent({ name: 'Codex', runtime: 'local', base_url: 'codex' });
  const room = svc1.createRoom({ title: 'r', agent_ids: [a.id] });
  svc1.updateRoom(room.room.code, { project_dir: project });
  svc1.postMessage(room.room.code, '@Codex 看看');
  db1.close();
  const db2 = openDb(file);
  const svc2 = new RoundtableService(db2, { real: demoCaller(1), demo: demoCaller(1) }, new RoomFiles(join(dir, 'files')), async () => 'x');
  const s = svc2.snapshot(room.room.code);
  assert.equal(s.room.project_dir, realpathSync(project));
  assert.equal(s.messages.at(-1)!.status, 'error');
  assert.equal(s.messages.at(-1)!.error, '服务重启，回复中断');
  db2.close();
});

test('事件解析：Codex 新旧格式与 DSH', () => {
  assert.equal(parseCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'A' } }).text, 'A');
  assert.match(parseCodexEvent({ type: 'item.started', item: { type: 'command_execution', command: 'rg foo' } }).progress!, /rg foo/);
  assert.equal(parseCodexEvent({ type: 'turn.failed', error: { message: '额度不足' } }).error, '额度不足');
  assert.equal(parseCodexEvent({ id: '1', msg: { type: 'task_complete', last_agent_message: 'B' } }).final, 'B');
  assert.deepEqual(parseCodexEvent('x'), {});
  assert.match(parseDshEvent({ type: 'tool_call', tool: 'read_file', input: { path: 'src/a.ts' } }).progress!, /read_file：src\/a\.ts/);
  assert.equal(parseDshEvent({ type: 'text', text: 'hi' }).text, 'hi');
  assert.equal(parseDshEvent({ type: 'final', text: 'F' }).final, 'F');
  assert.equal(parseDshEvent({ type: 'error', message: 'E' }).error, 'E');
  assert.equal(parseDshEvent({ type: 'status', phase: 'turn_end', reason: { kind: 'error' } }).progress, '结束：error');
  assert.equal(parseDshEvent({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }).progress, undefined);
});

function run(kind: 'codex' | 'dsh', mode: string, signal = new AbortController().signal) {
  process.env.FAKE_MODE = mode;
  const progress: string[] = [];
  const texts: string[] = [];
  const p = spawnLocalAgent({ kind, cwd: realpathSync(project), prompt: '任务正文', signal, onProgress: (t) => progress.push(t), onText: (t) => texts.push(t) });
  return { p, progress, texts };
}

test('真实子进程：DSH 流式解析 + 只读模式 + cwd；Codex 读 -o 文件并带只读参数', async () => {
  const d = run('dsh', 'dsh-ok');
  const out = await d.p;
  assert.match(out, /^## 结论/);
  assert.ok(out.includes(`cwd=${realpathSync(project)}`));
  assert.match(out, /mode=read-only len=\d+/);
  assert.ok(d.progress.some((p) => p.includes('AGENTS.md')));
  assert.ok(d.texts.length >= 2);

  const c = run('codex', 'codex-ok');
  const cout = await c.p;
  assert.match(cout, /^# 文件里的答案/);
  assert.match(cout, /-s/);
  assert.ok(c.progress.some((p) => p.includes('cat AGENTS.md')));
});

test('真实子进程：非零退出给出原因；abort 结束进程', async () => {
  await assert.rejects(run('dsh', 'fail').p, /凭据缺失/);
  const ac = new AbortController();
  const h = run('dsh', 'hang', ac.signal);
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  ac.abort(new Error('已停止'));
  await assert.rejects(h.p, /已停止/);
  assert.ok(Date.now() - started < 4000);
  assert.ok(existsSync(fakeBin));
});


test('本地连接配置持久化并交给执行器；空 key 保留，切换执行器不继承凭据', async () => {
  let seen: LocalRunRequest | undefined;
  const { svc, agent, code } = setup(async (req) => { seen = req; return 'ok'; });
  const updated = svc.updateAgent(agent.id, { local_base_url: 'https://example.invalid/v1/', api_key: 'secret-local-key', model: 'model-1' });
  assert.equal(updated.local_base_url, 'https://example.invalid/v1');
  assert.equal(updated.has_key, true);
  assert.ok(!JSON.stringify(updated).includes('secret-local-key'));
  svc.updateAgent(agent.id, { api_key: '' });
  svc.updateRoom(code, { project_dir: project });
  svc.postMessage(code, '@Codex 看看');
  await settle(svc, code);
  assert.equal(seen!.baseUrl, 'https://example.invalid/v1');
  assert.equal(seen!.apiKey, 'secret-local-key');
  assert.equal(seen!.model, 'model-1');
  const switched = svc.updateAgent(agent.id, { base_url: 'dsh' });
  assert.equal(switched.has_key, false);
  assert.equal(switched.local_base_url, '');
  assert.throws(() => svc.updateAgent(agent.id, { local_base_url: 'https://name:pass@example.invalid' }), /地址/);
  assert.throws(() => svc.updateAgent(agent.id, { local_base_url: 'file:///tmp' }), /地址/);
});

test('子进程连接配置：凭据只走环境，Codex provider 和 DSH Messages 地址/模型传入且不改全局文件', async () => {
  process.env.FAKE_MODE = 'inspect';
  for (const kind of ['codex', 'dsh'] as const) {
    const out = await spawnLocalAgent({ kind, cwd: project, prompt: 'x', signal: new AbortController().signal,
      baseUrl: 'https://example.invalid/v1', apiKey: 'secret-local-key', model: 'model-1',
      onProgress() {}, onText() {} });
    const result = JSON.parse(out);
    assert.equal(result.hasKey, true);
    assert.equal(result.leakedInArgs, false);
    if (kind === 'codex') {
      assert.match(result.args.join(' '), /model_provider="roundtable"/);
      assert.match(result.args.join(' '), /base_url="https:\/\/example.invalid\/v1"/);
      assert.match(result.args.join(' '), /wire_api="responses"/);
    } else {
      assert.equal(result.baseUrl, 'https://example.invalid/v1');
      assert.equal(result.model, 'model-1');
    }
  }
});

test('执行器错误去掉密钥；缺凭据错误优先于代理提示', async () => {
  process.env.FAKE_MODE = 'credential-error';
  await assert.rejects(spawnLocalAgent({kind: 'dsh', cwd: project, prompt:'x',
    signal:new AbortController().signal, apiKey:'secret-local-key', onProgress(){},onText(){} }),
    (err: Error) => !err.message.includes('secret-local-key') && /凭据|API Key/.test(err.message) && !err.message.startsWith('dsh: ALL_PROXY'));
});

test('本地配置检查明确缺少 DSH 凭据，配置存在也不声称模型连接成功', async () => {
  const { svc, agent } = setup(async () => 'x');
  const oldKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await assert.rejects(svc.testAgent({name:'DSH',runtime:'local',base_url:'dsh'}), /headless API Key/);
    const result = await svc.testAgent({id:agent.id,runtime:'local',base_url:'codex'});
    assert.match(result.reply, /尚未请求模型服务/);
    const dsh = await svc.testAgent({name:'DSH',runtime:'local',base_url:'dsh',api_key:'test-key'});
    assert.match(dsh.reply, /本 Agent 保存的连接配置/);
  } finally {
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
  }
});

test('本地任务超时保留执行器最后报告的诊断阶段', async () => {
  const before = process.env.RT_LOCAL_TIMEOUT_MS;
  process.env.RT_LOCAL_TIMEOUT_MS = '30';
  try {
    const { svc, agent, code } = setup((req) => new Promise((_, reject) => {
      req.onProgress('执行器：连接失败，正在重试');
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once:true });
    }));
    svc.updateRoom(code, { project_dir:project });
    svc.postMessage(code, '@Codex 看看');
    const snap = await settle(svc, code);
    assert.match(snap.messages.at(-1)!.error, /超过.*最后阶段：执行器：连接失败/);
  } finally {
    if (before === undefined) delete process.env.RT_LOCAL_TIMEOUT_MS;
    else process.env.RT_LOCAL_TIMEOUT_MS = before;
  }
});


test('Codex 诊断：日志中的 401 或工具认证错误保留来源，不冒充模型 Key 错误', async () => {
  const c = run('codex', 'diagnostic-401');
  await assert.rejects(c.p, /src\/example\.ts:401: Unauthorized enum member/);
  assert.ok(c.progress.some(p => p.includes('src/example.ts:401')));
  assert.ok(c.progress.every(p => !p.includes('模型服务认证失败')));
});

test('Codex 诊断：工具认证警告不使成功任务失败，原始来源可见且凭据脱敏', async () => {
  process.env.FAKE_MODE = 'auth-retry-ok';
  const progress: string[] = [];
  const out = await spawnLocalAgent({kind:'codex', cwd:project, prompt:'x', apiKey:'secret-local-key',
    signal:new AbortController().signal, onProgress:p => progress.push(p), onText:() => {}});
  assert.equal(out, '完成');
  assert.ok(progress.some(p => p.includes('mcp_client: HTTP 401 Unauthorized from workspace-tools')));
  assert.ok(progress.every(p => !p.includes('secret-local-key') && !p.includes('模型服务认证失败')));
});

test('Codex 诊断：最终失败保留结构化事件原因，不被 stderr 警告覆盖', async () => {
  process.env.FAKE_MODE = 'auth-fail';
  const p = spawnLocalAgent({kind:'codex', cwd:project, prompt:'x', apiKey:'secret-local-key',
    signal:new AbortController().signal, onProgress:() => {}, onText:() => {}});
  await assert.rejects(p, (e: Error) => {
    assert.match(e.message, /unexpected status 401 Unauthorized.*account expired/);
    assert.ok(!e.message.includes('secret-local-key'));
    return true;
  });
});
