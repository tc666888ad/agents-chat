import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/db/index.js';
import { RoundtableService } from '../src/roundtable/service.js';
import { RoomFiles } from '../src/roundtable/files.js';

function setup() {
  const db = openDb(':memory:');
  const files = new RoomFiles(mkdtempSync(join(tmpdir(), 'rt-collab-')));
  const svc = new RoundtableService(db, undefined, files);
  const a = svc.createAgent({ name: 'Codex', runtime: 'mcp' });
  const b = svc.createAgent({ name: 'DeepSeek', runtime: 'mcp' });
  const code = svc.createRoom({ title: '协作', prd: '需要方案', agent_ids: [a.id, b.id] }).room.code;
  return { svc, db, files, a, b, code };
}
function snapshot(svc: RoundtableService, code: string): any { return svc.snapshot(code); }
function enable(svc: RoundtableService, code: string) { svc.updateRoom(code, { auto_collaborate: true } as any); }
async function complete(svc: RoundtableService, code: string, agent: string, action: string, target?: string, extra = {}) {
  const [task] = await svc.getExternalTasks(agent, code);
  assert.ok(task);
  const marker = task.context[0]!.content.match(/当前控制身份：(\{[^\n]+\})/);
  assert.ok(marker, '任务必须带当前协作身份');
  const identity = JSON.parse(marker[1]!);
  return svc.completeExternalTask(agent, code, task.seq, `## 结果\n正文 @某人 不单独触发\n\n\`\`\`roundtable-control\n${JSON.stringify({ ...identity, action, target_id: target, task: '审查并指出问题', reason: '下一步', ...extra })}\n\`\`\``);
}

test('旧房间默认关闭，开启后单点名建立协作并将身份注入待办', async () => {
  const { svc, code, a } = setup();
  assert.equal(snapshot(svc, code).room.auto_collaborate, false);
  enable(svc, code);
  svc.postMessage(code, '@Codex 出方案');
  assert.equal(snapshot(svc, code).collaboration.status, 'running');
  assert.equal(snapshot(svc, code).collaboration.reply_count, 1);
  const [task] = await svc.getExternalTasks(a.id, code);
  assert.equal(task!.stage, 'plan');
  assert.match(task!.prompt, /当前控制身份/);
});

test('方案、审查、修订串行自动交接，最新版本通过后 @我 停止', async () => {
  const { svc, code, a, b } = setup(); enable(svc, code);
  svc.postMessage(code, '@Codex 出方案');
  const plan = await complete(svc, code, a.id, 'handoff', b.id);
  assert.doesNotMatch(plan.message.body, /roundtable-control/);
  const [review] = await svc.getExternalTasks(b.id, code);
  assert.equal(review!.ref_seq, plan.message.seq);
  await complete(svc, code, b.id, 'handoff', a.id);
  const [revision] = await svc.getExternalTasks(a.id, code);
  assert.equal(revision!.stage, 'plan'); assert.equal(revision!.version, 2);
  const revised = await complete(svc, code, a.id, 'handoff', b.id);
  await complete(svc, code, b.id, 'ready', undefined, { plan_seq: revised.message.seq });
  const s = snapshot(svc, code);
  assert.equal(s.collaboration.status, 'ready'); assert.equal(s.collaboration.reply_count, 4);
  assert.match(s.messages.at(-1).body, /@我.*确认.*开发/);
  assert.equal(s.artifacts.length, 4);
  assert.equal((await svc.getExternalTasks(a.id, code)).length, 0);
  assert.throws(() => svc.retry(code, plan.message.seq), /协作/);
});

test('ask_human 暂停，明确继续沿用原链和额度', async () => {
  const { svc, code, a, b } = setup(); enable(svc, code); svc.postMessage(code, '@Codex 出方案');
  await complete(svc, code, a.id, 'ask_human');
  const before = snapshot(svc, code).collaboration;
  assert.equal(before.status, 'waiting_human');
  assert.throws(() => (svc as any).resumeCollaboration(code, { text: '', agent_id: b.id }), /决定/);
  (svc as any).resumeCollaboration(code, { text: '采用方案一', agent_id: a.id });
  const after = snapshot(svc, code).collaboration;
  assert.equal(after.id, before.id); assert.equal(after.reply_count, 2);
  assert.match((await svc.getExternalTasks(a.id, code))[0]!.prompt, /采用方案一/);
});

test('最多六次，不能自交接、自审通过或复制旧控制身份', async () => {
  const { svc, code, a, b } = setup(); enable(svc, code); svc.postMessage(code, '@Codex 出方案');
  for (let i = 0; i < 6; i++) await complete(svc, code, i % 2 ? b.id : a.id, 'handoff', i % 2 ? a.id : b.id);
  assert.equal(snapshot(svc, code).collaboration.status, 'limit');
  assert.equal(snapshot(svc, code).messages.filter((m: any) => m.kind === 'agent').length, 6);
  assert.throws(() => (svc as any).resumeCollaboration(code, { text: '继续', agent_id: a.id }), /上限/);
  const t = setup(); enable(t.svc, t.code); t.svc.postMessage(t.code, '@Codex 出方案');
  await complete(t.svc, t.code, t.a.id, 'ready', undefined, { plan_seq: 2 });
  assert.equal(snapshot(t.svc, t.code).collaboration.status, 'failed');
});

test('停止和重启不自动执行；旧 MCP 提交不能恢复已停止的链', async () => {
  const { svc, db, files, code, a } = setup(); enable(svc, code); svc.postMessage(code, '@Codex 出方案');
  const [task] = await svc.getExternalTasks(a.id, code);
  (svc as any).stopCollaboration(code);
  assert.equal(snapshot(svc, code).collaboration.status, 'stopped');
  assert.throws(() => svc.completeExternalTask(a.id, code, task!.seq, '迟到结果'), /完成|失败/);
  (svc as any).resumeCollaboration(code, { text: '继续原任务', agent_id: a.id });
  const restarted = new RoundtableService(db, undefined, files);
  assert.equal(snapshot(restarted, code).collaboration.status, 'stopped');
  assert.equal((await restarted.getExternalTasks(a.id, code)).length, 0);
});

test('控制区仅接受尾部独立区块，拒绝引用、嵌套、重复及旧身份', async () => {
  const { parseControl } = await import('../src/roundtable/collaboration.js');
  const identity = { collaboration_id: 'c1', seq: 2, token: 'nonce' };
  const block = '```roundtable-control\n' + JSON.stringify({ ...identity, action: 'finish', reason: '完成' }) + '\n```';
  const valid = parseControl('正文\n' + block, identity);
  assert.equal(valid.control?.action, 'finish'); assert.equal(valid.body, '正文');
  for (const text of [block + '\n尾注', block + '\n' + block, '> ' + block.replaceAll('\n', '\n> '), '```md\n' + block + '\n```', '正文\n```roundtable-control\n{bad}\n```', '普通正文 @DeepSeek']) {
    assert.equal(parseControl(text, identity).control, null);
  }
  assert.equal(parseControl('正文\n' + block, { ...identity, seq: 3 }).control, null);
});

test('MCP 长轮询得到的第一条交接待办已有完整控制身份', async () => {
  const { svc, code, a, b } = setup(); enable(svc, code);
  const first = svc.getExternalTasks(a.id, code, 1);
  svc.postMessage(code, '@Codex 出方案');
  assert.match((await first)[0]!.context[0]!.content, /当前控制身份/);
  const second = svc.getExternalTasks(b.id, code, 1);
  await complete(svc, code, a.id, 'handoff', b.id);
  assert.match((await second)[0]!.context[0]!.content, /当前控制身份/);
  assert.match((await second)[0]!.prompt, /审查并指出问题/);
});

test('缺少控制、非法目标和历史控制均暂停；广播保持原行为', async () => {
  for (const mode of ['missing','self','old']) {
    const { svc, code, a } = setup(); enable(svc, code); svc.postMessage(code, '@Codex 出方案');
    if (mode === 'missing') {
      const [t] = await svc.getExternalTasks(a.id, code);
      svc.completeExternalTask(a.id, code, t!.seq, '正文 @DeepSeek 请看\n> ```roundtable-control\n> {}\n> ```');
    } else await complete(svc, code, a.id, 'handoff', a.id, mode === 'old' ? { seq: 999 } : {});
    assert.equal(snapshot(svc, code).collaboration.status, 'failed');
    assert.equal(snapshot(svc, code).messages.filter((m: any) => m.kind === 'agent').length, 1);
  }
  const { svc, code, a, b } = setup(); enable(svc, code);
  svc.postMessage(code, '大家一起看');
  assert.equal(snapshot(svc, code).collaboration, null);
  for (const agent of [a, b]) {
    const [t] = await svc.getExternalTasks(agent.id, code); svc.completeExternalTask(agent.id, code, t!.seq, '@对方 正文');
  }
  assert.equal(snapshot(svc, code).messages.length, 3);
});

function response(prompt: string, action: string, target?: string, plan_seq?: number) {
  const marker = prompt.match(/当前控制身份：(\{[^\n]+\})/); assert.ok(marker);
  return `完成\n\n\`\`\`roundtable-control\n${JSON.stringify({ ...JSON.parse(marker[1]!), action, target_id: target, task: '检查边界条件', reason: '原因', plan_seq })}\n\`\`\``;
}
async function settled(svc: RoundtableService, code: string) {
  for (let i = 0; i < 100; i++) {
    if (snapshot(svc, code).collaboration?.status !== 'running') return snapshot(svc, code);
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('协作未结束');
}

test('API 执行释放运行槽后自动交接，流式协议不进入页面', async () => {
  const db = openDb(':memory:'); let target = ''; let calls = 0; const streamed: string[] = [];
  const caller = async (req: any) => {
    calls++;
    const prompt = req.messages[0].content;
    const text = response(prompt, calls === 1 ? 'handoff' : 'ready', calls === 1 ? target : undefined,
      calls === 2 ? svc.snapshot(code).messages.find(m => m.stage === 'plan')!.seq : undefined);
    req.onText(text); return text;
  };
  const svc = new RoundtableService(db, { real: caller, demo: caller }, new RoomFiles(mkdtempSync(join(tmpdir(), 'rt-api-co-'))));
  const a = svc.createAgent({ name: 'A', base_url: 'http://offline.invalid', model: 'm' });
  const b = svc.createAgent({ name: 'B', base_url: 'http://offline.invalid', model: 'm' }); target = b.id;
  const code = svc.createRoom({ agent_ids: [a.id, b.id] }).room.code;
  enable(svc, code);
  svc.subscribe(code, e => { if (e.type === 'message') streamed.push(e.message.body); });
  svc.postMessage(code, '@A 出方案');
  const s = await settled(svc, code);
  assert.equal(calls, 2); assert.equal(s.collaboration.status, 'ready');
  assert.ok(streamed.every(text => !text.includes('roundtable-control')));
});

test('忽略取消的 API 迟到结果不得写产物或派发，重试旧步骤不得重入', async () => {
  let resolve!: (text: string) => void; let prompt = '';
  const caller = async (req: any) => { prompt = req.messages[0].content; return await new Promise<string>(r => { resolve = r; }); };
  const db = openDb(':memory:'); const svc = new RoundtableService(db, { real: caller, demo: caller }, new RoomFiles(mkdtempSync(join(tmpdir(), 'rt-late-co-'))));
  const a = svc.createAgent({ name: 'A', base_url: 'http://offline.invalid', model: 'm' });
  const b = svc.createAgent({ name: 'B', runtime: 'mcp' });
  const code = svc.createRoom({ agent_ids: [a.id,b.id] }).room.code; enable(svc, code);
  const seq = svc.postMessage(code, '@A 方案').replies[0]!.seq;
  svc.stopCollaboration(code);
  assert.throws(() => svc.retry(code, seq), /退出/);
  resolve(response(prompt, 'handoff', b.id)); await new Promise(r => setTimeout(r, 10));
  assert.equal(svc.snapshot(code).messages.find(m => m.seq === seq)!.status, 'error');
  assert.equal(svc.snapshot(code).artifacts.length, 0);
  assert.equal((await svc.getExternalTasks(b.id, code)).length, 0);
  assert.equal(snapshot(svc, code).collaboration.status, 'stopped');
});

test('本地执行器也能自动交接，提示词保留只读规则和确切版本', async () => {
  const oldBin = process.env.RT_CODEX_BIN; process.env.RT_CODEX_BIN = process.execPath;
  try {
    const db = openDb(':memory:'); const prompts: string[] = []; let target = '';
    const svc = new RoundtableService(db, undefined, new RoomFiles(mkdtempSync(join(tmpdir(), 'rt-local-co-'))), async req => {
      prompts.push(req.prompt);
      assert.match(req.prompt, /只读/); assert.match(req.prompt, /不联网/);
      const body = response(req.prompt, prompts.length === 1 ? 'handoff' : 'ready', prompts.length === 1 ? target : undefined,
        prompts.length === 2 ? svc.snapshot(code).messages.find(m => m.stage === 'plan')!.seq : undefined);
      req.onProgress('读取代码'); req.onText(body); return body;
    });
    const a = svc.createAgent({ name: 'Codex', runtime: 'local', base_url: 'codex' });
    const b = svc.createAgent({ name: 'Reviewer', runtime: 'local', base_url: 'codex' }); target = b.id;
    const code = svc.createRoom({ agent_ids: [a.id,b.id] }).room.code;
    svc.updateRoom(code, { project_dir: mkdtempSync(join(tmpdir(), 'rt-project-co-')), auto_collaborate: true });
    svc.postMessage(code, '@Codex 出方案');
    const s = await settled(svc, code);
    assert.equal(s.collaboration.status, 'ready'); assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /最新完整方案：seq=\d+, v1/);
    assert.match(prompts[1]!, /检查边界条件/);
  } finally { if (oldBin === undefined) delete process.env.RT_CODEX_BIN; else process.env.RT_CODEX_BIN = oldBin; }
});

test('执行失败不推进，重试保留额度；配置或成员变动撤回待办', async () => {
  let fail = true;
  const caller = async (req: any) => { if (fail) throw new Error('离线执行器失败'); return response(req.messages[0].content, 'ask_human'); };
  const svc = new RoundtableService(openDb(':memory:'), { real: caller, demo: caller }, new RoomFiles(mkdtempSync(join(tmpdir(), 'rt-error-co-'))));
  const a = svc.createAgent({ name: 'A', base_url: 'http://offline.invalid', model: 'm' });
  const code = svc.createRoom({ agent_ids: [a.id] }).room.code; enable(svc, code);
  const seq = svc.postMessage(code, '@A 出方案').replies[0]!.seq;
  assert.equal((await settled(svc, code)).collaboration.status, 'failed');
  fail = false; svc.retry(code, seq);
  const s = await settled(svc, code);
  assert.equal(s.collaboration.status, 'waiting_human'); assert.equal(s.collaboration.reply_count, 2);
  const t = setup(); enable(t.svc, t.code); t.svc.postMessage(t.code, '@Codex 任务');
  assert.throws(() => t.svc.postMessage(t.code, '@DeepSeek 另一个任务'), /协作/);
  t.svc.updateAgent(t.b.id, { persona: '新的规则' });
  assert.equal(snapshot(t.svc, t.code).collaboration.status, 'stopped');
  assert.equal((await t.svc.getExternalTasks(t.a.id, t.code)).length, 0);
  t.svc.resumeCollaboration(t.code, { text: '按新规则继续', agent_id: t.a.id });
  t.svc.removeMember(t.code, t.b.id);
  assert.equal(snapshot(t.svc, t.code).collaboration.status, 'stopped');
});

test('同一完成事件不能重复派发，审查不能通过旧版本', async () => {
  const { svc, code, a, b } = setup(); enable(svc, code); svc.postMessage(code, '@Codex 方案');
  const old = await complete(svc, code, a.id, 'handoff', b.id);
  assert.throws(() => svc.completeExternalTask(a.id, code, old.message.seq, '重复提交'), /完成|失败/);
  await complete(svc, code, b.id, 'handoff', a.id);
  await complete(svc, code, a.id, 'handoff', b.id);
  await complete(svc, code, b.id, 'ready', undefined, { plan_seq: old.message.seq });
  assert.equal(snapshot(svc, code).collaboration.status, 'failed');
  assert.match(snapshot(svc, code).collaboration.note, /最新方案/);
});

test('HTTP 支持开关、停止和继续，拒绝过期协作 ID', async () => {
  const Fastify = (await import('fastify')).default;
  const { registerRoundtableApi } = await import('../src/roundtable/http.js');
  const { svc, code, a } = setup(); const app = Fastify(); registerRoundtableApi(app, svc);
  try {
    let r = await app.inject({ method: 'PATCH', url: `/api/rt/rooms/${code}`, payload: { auto_collaborate: true } });
    assert.equal(r.statusCode, 200); assert.equal(r.json().room.auto_collaborate, true);
    svc.postMessage(code, '@Codex 任务');
    r = await app.inject({ method: 'POST', url: `/api/rt/rooms/${code}/collaboration/stop` });
    assert.equal(r.json().collaboration.status, 'stopped');
    r = await app.inject({ method: 'POST', url: `/api/rt/rooms/${code}/collaboration/resume`, payload: { text: '继续', agent_id: a.id, collaboration_id: 'old' } });
    assert.equal(r.json().ok, false);
    r = await app.inject({ method: 'POST', url: `/api/rt/rooms/${code}/collaboration/resume`, payload: { text: '采用一', agent_id: a.id, collaboration_id: snapshot(svc, code).collaboration.id } });
    assert.equal(r.json().collaboration.status, 'running'); assert.equal(r.json().collaboration.reply_count, 2);
  } finally { await app.close(); }
});

test('首次启动发布房间状态事件，上限后不能靠换一个 @ 重置额度', async () => {
  const { svc, code, a, b } = setup(); enable(svc, code);
  const statuses: string[] = [];
  svc.subscribe(code, e => { if (e.type === 'room') statuses.push(svc.snapshot(code).collaboration!.status); });
  svc.postMessage(code, '@Codex 方案');
  assert.ok(statuses.includes('running'));
  for (let i = 0; i < 6; i++) await complete(svc, code, i % 2 ? b.id : a.id, 'handoff', i % 2 ? a.id : b.id);
  assert.throws(() => svc.postMessage(code, '@DeepSeek 再来'), /结束本轮/);
  (svc as any).finishCollaboration(code);
  svc.postMessage(code, '@DeepSeek 一个新的任务');
  assert.equal(snapshot(svc, code).collaboration.reply_count, 1);
});

test('更新需求文档会暂停当前协作并撤回外部待办', async () => {
  const { svc, code, a } = setup(); enable(svc, code); svc.postMessage(code, '@Codex 方案');
  await svc.addDoc(code, '需求.md', Buffer.from('新的需求'));
  assert.equal(snapshot(svc, code).collaboration.status, 'stopped');
  assert.equal((await svc.getExternalTasks(a.id, code)).length, 0);
});

test('手动停止保留已经生成的正文，控制区不写入停止后的消息', async () => {
  const caller = async (req: any) => {
    req.onText('已经生成的正文\n```roundtable-control\n');
    return await new Promise<string>((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }));
  };
  const svc = new RoundtableService(openDb(':memory:'), { real: caller, demo: caller }, new RoomFiles(mkdtempSync(join(tmpdir(), 'rt-stop-body-'))));
  const a = svc.createAgent({ name: 'A', base_url: 'http://offline.invalid', model: 'm' });
  const code = svc.createRoom({ agent_ids: [a.id] }).room.code; enable(svc, code);
  const seq = svc.postMessage(code, '@A 方案').replies[0]!.seq;
  svc.stopCollaboration(code);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(svc.snapshot(code).messages.find(m => m.seq === seq)!.body, '已经生成的正文');
});
