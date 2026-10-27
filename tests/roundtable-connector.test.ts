import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { openDb } from '../src/db/index.js';
import { RoundtableService } from '../src/roundtable/service.js';
import { RoomFiles } from '../src/roundtable/files.js';
import { registerRoundtableApi } from '../src/roundtable/http.js';

function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-connector-'));
  const db = openDb(':memory:'); const files = new RoomFiles(dir);
  const svc = new RoundtableService(db, { real: async () => { throw Error('禁止真实模型'); }, demo: async () => { throw Error('禁止演示'); } }, files,
    async () => { throw Error('禁止在服务器启动 CLI'); });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const a = svc.createAgent({ name: 'Codex', runtime: 'local', base_url: 'codex', model: 'saved-model', api_key: 'server-secret', local_base_url: 'https://example.invalid/v1' });
  const b = svc.createAgent({ name: 'DSH', runtime: 'local', base_url: 'dsh' });
  const code = svc.createRoom({ prd: '分析项目', agent_ids: [a.id, b.id] }).room.code;
  const pairing = svc.connectors.createPairing();
  const paired = svc.connectors.pair(pairing.code, '成员电脑');
  const device = svc.connectors.authenticate(paired.token);
  svc.connectors.hello(device, { executors: ['codex', 'dsh'], workspaces: [{ id: 'ws-one', name: '业务项目' }] });
  svc.updateRoom(code, { device_id: device, workspace_id: 'ws-one' });
  return { svc, db, files, a, b, code, device, paired };
}

test('配对码一次有效且过期不可用，token 只存哈希，设备不暴露路径或凭据', (t) => {
  const { svc, db, paired } = setup(t);
  const p = svc.connectors.createPairing();
  svc.connectors.pair(p.code, '第二台');
  assert.throws(() => svc.connectors.pair(p.code, '重放'));
  const expired = svc.connectors.createPairing();
  db.prepare('UPDATE rt_pairings SET expires_at=0').run();
  assert.throws(() => svc.connectors.pair(expired.code, '过期'));
  assert.throws(() => svc.connectors.authenticate('bad'));
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM rt_devices').all()), new RegExp(paired.token));
  assert.doesNotMatch(JSON.stringify(svc.connectors.list()), /token_hash|server-secret|\/Users\//);
});

test('服务器以设备工作区派发并接收进度，重复领取与完成均不能重复执行', (t) => {
  const { svc, code, device, a } = setup(t);
  assert.equal(svc.snapshot(code).members.find(m => m.id === a.id)!.available, true);
  svc.postMessage(code, '@Codex 读取代码');
  const task = svc.connectors.claim(device)!;
  assert.equal(task.kind, 'codex'); assert.equal(task.workspace_id, 'ws-one'); assert.equal(task.model, 'saved-model');
  assert.match(task.prompt, /业务项目/);
  assert.doesNotMatch(JSON.stringify(task), /server-secret|example.invalid|\/Users\//);
  assert.equal(svc.connectors.claim(device), null);
  assert.equal(svc.connectors.progress(device, task.attempt_id, { body: '正在分析', progress: '读取代码' }).cancel, false);
  assert.equal(svc.snapshot(code).messages.find(m => m.seq === task.seq)!.body, '正在分析');
  svc.connectors.complete(device, task.attempt_id, '分析完成');
  assert.equal(svc.snapshot(code).messages.find(m => m.seq === task.seq)!.status, 'done');
  assert.throws(() => svc.connectors.complete(device, task.attempt_id, '重复'));
});

test('停止、重试和跨设备回传均受 attempt 身份保护', (t) => {
  const { svc, code, device } = setup(t);
  svc.postMessage(code, '@Codex 读代码'); const old = svc.connectors.claim(device)!;
  const other = svc.connectors.pair(svc.connectors.createPairing().code, '另一台');
  assert.throws(() => svc.connectors.complete(svc.connectors.authenticate(other.token), old.attempt_id, '串号'));
  svc.stop(code, old.seq);
  assert.equal(svc.connectors.progress(device, old.attempt_id, {}).cancel, true);
  assert.throws(() => svc.connectors.complete(device, old.attempt_id, '迟到'));
  svc.retry(code, old.seq);
  assert.equal(svc.connectors.claim(device), null, '旧进程退出确认之前不派发下一步');
  svc.connectors.fail(device, old.attempt_id, '已停止并退出');
  const next = svc.connectors.claim(device)!;
  assert.notEqual(next.attempt_id, old.attempt_id);
  assert.throws(() => svc.connectors.complete(device, old.attempt_id, '覆盖重试'));
  svc.connectors.complete(device, next.attempt_id, '新结果');
  assert.equal(svc.snapshot(code).messages.find(m => m.seq === old.seq)!.body, '新结果');
});

test('租约超时、服务重启、撤销设备都会封住旧结果并保留原 Agent 配置', (t) => {
  const { svc, db, files, code, device, paired, a } = setup(t);
  const original = db.prepare('SELECT * FROM rt_agents WHERE id=?').get(a.id);
  svc.postMessage(code, '@Codex 读代码'); const task = svc.connectors.claim(device)!;
  db.prepare('UPDATE rt_connector_tasks SET lease_expires_at=1 WHERE attempt_id=?').run(task.attempt_id);
  svc.connectors.sweep();
  assert.equal(svc.snapshot(code).messages.find(m => m.seq === task.seq)!.status, 'error');
  assert.throws(() => svc.connectors.complete(device, task.attempt_id, '迟到'));
  svc.retry(code, task.seq); const task2 = svc.connectors.claim(device)!;
  const restarted = new RoundtableService(db, undefined, files);
  assert.throws(() => restarted.connectors.complete(device, task2.attempt_id, '重启前结果'));
  restarted.connectors.revoke(device);
  assert.throws(() => restarted.connectors.authenticate(paired.token));
  assert.deepEqual(db.prepare('SELECT * FROM rt_agents WHERE id=?').get(a.id), original);
});

test('工作区必须由设备上报，运行中禁止切换，离线或缺少执行器拒绝派发', (t) => {
  const { svc, db, code, device } = setup(t);
  assert.throws(() => svc.updateRoom(code, { device_id: device, workspace_id: 'forged' }));
  svc.postMessage(code, '@Codex 开始'); const task = svc.connectors.claim(device)!;
  assert.throws(() => svc.updateRoom(code, { device_id: '', workspace_id: '' }));
  svc.connectors.fail(device, task.attempt_id, '执行失败');
  svc.connectors.hello(device, { executors: ['dsh'], workspaces: [{ id: 'ws-one', name: '业务项目' }] });
  assert.throws(() => svc.postMessage(code, '@Codex 无执行器'));
  db.prepare("UPDATE rt_devices SET last_seen_at='2000-01-01T00:00:00Z'").run();
  assert.throws(() => svc.postMessage(code, '@DSH 离线'));
});

function control(task: any, action: string, extra = {}) {
  const identity = JSON.parse(task.prompt.match(/当前控制身份：(\{[^\n]+\})/)[1]);
  return `## 结果\n代码分析\n\n\`\`\`roundtable-control\n${JSON.stringify({ ...identity, action, reason: '继续审查', task: '审查代码', ...extra })}\n\`\`\``;
}

test('连接器复用协作控制：交接串行、控制区不外泄、六次上限', (t) => {
  const { svc, code, device, a, b } = setup(t);
  svc.updateRoom(code, { auto_collaborate: true }); svc.postMessage(code, '@Codex 出方案');
  for (let n = 0; n < 6; n++) {
    const task = svc.connectors.claim(device)!; assert.ok(task);
    assert.equal(svc.connectors.claim(device), null);
    svc.connectors.progress(device, task.attempt_id, { body: control(task, 'handoff', { target_id: n % 2 ? a.id : b.id }) });
    assert.doesNotMatch(svc.snapshot(code).messages.find(m => m.seq === task.seq)!.body, /roundtable-control/);
    svc.connectors.complete(device, task.attempt_id, control(task, 'handoff', { target_id: n % 2 ? a.id : b.id }));
  }
  assert.equal(svc.snapshot(code).collaboration!.status, 'limit');
  assert.equal(svc.snapshot(code).collaboration!.reply_count, 6);
  assert.equal(svc.connectors.claim(device), null);
});

test('HTTP 设备接口要求 Bearer，配对和正常回传可用且错误不泄露凭据', async (t) => {
  const { svc, paired } = setup(t); const app = Fastify(); registerRoundtableApi(app, svc); t.after(() => app.close());
  const denied = await app.inject({ method: 'POST', url: '/api/rt/connector/hello', payload: {} });
  assert.equal(denied.statusCode, 401);
  const hello = await app.inject({ method: 'POST', url: '/api/rt/connector/hello', headers: { authorization: `Bearer ${paired.token}` },
    payload: { executors: ['codex'], workspaces: [{ id: 'ws-one', name: '业务项目' }] } });
  assert.equal(hello.statusCode, 200);
  const listed = await app.inject('/api/rt/devices');
  assert.equal(listed.statusCode, 200); assert.doesNotMatch(listed.body, new RegExp(paired.token));
});

test('完整离线链路：HTTP 领取 → 假 Codex 子进程只读参数 → HTTP 回传产物', async t => {
  const { svc, code, paired, db } = setup(t);
  const { chmodSync, writeFileSync } = await import('node:fs');
  const { addWorkspace, executeTask } = await import('../src/connector/client.js');
  const dir = mkdtempSync(join(tmpdir(), 'connector-e2e-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeBin = join(dir, 'fake-codex.mjs');
  writeFileSync(fakeBin, `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);let input='';process.stdin.setEncoding('utf8');process.stdin.on('data', c=>input+=c);process.stdin.on('end',()=>{
 if(!args.includes('read-only') || !args.includes('--ephemeral') || !input.includes('只读')) process.exit(2);
 writeFileSync(args[args.indexOf('-o')+1],'## 离线分析结果\\n已读取授权项目（假进程）');
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'离线分析结果'}}));
});`);
  chmodSync(fakeBin, 0o700);
  const before = process.env.RT_CODEX_BIN; process.env.RT_CODEX_BIN = fakeBin;
  t.after(() => { if (before === undefined) delete process.env.RT_CODEX_BIN; else process.env.RT_CODEX_BIN = before; });
  const cfg = addWorkspace({ server: 'http://localhost', token: paired.token, workspaces: [] }, dir, '真实授权项目');
  const app = Fastify(); registerRoundtableApi(app, svc); t.after(() => app.close());
  const request = async (path: string, body: unknown = {}) => {
    const res = await app.inject({ method: 'POST', url: `/api/rt/connector${path}`, headers: { authorization: `Bearer ${paired.token}` }, payload: body as any });
    assert.equal(res.statusCode, 200, res.body); return res.json();
  };
  await request('/hello', { executors: ['codex'], workspaces: cfg.workspaces.map(({ id, name }) => ({ id, name })) });
  svc.updateRoom(code, { device_id: svc.connectors.authenticate(paired.token), workspace_id: cfg.workspaces[0]!.id });
  const saved = db.prepare('SELECT base_url,model,api_key,local_base_url FROM rt_agents ORDER BY id').all();
  svc.startFlow(code, { action: 'plan', agent_id: svc.snapshot(code).members.find(a => a.base_url === 'codex')!.id });
  const { task } = await request('/claim');
  await executeTask(cfg, task, request, new AbortController().signal);
  const result = svc.snapshot(code);
  assert.equal(result.messages.find(m => m.seq === task.seq)!.status, 'done');
  assert.match(result.messages.find(m => m.seq === task.seq)!.body, /离线分析结果/);
  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(db.prepare('SELECT base_url,model,api_key,local_base_url FROM rt_agents ORDER BY id').all(), saved);
});

test('吊销正在执行的设备、删除房间、移出成员、修改配置都撤回任务', t => {
  const { svc, code, device, paired, a } = setup(t);
  svc.postMessage(code, '@Codex 测试'); const first = svc.connectors.claim(device)!;
  svc.updateAgent(a.id, { persona: '新角色' });
  assert.equal(svc.connectors.progress(device, first.attempt_id, {}).cancel, true);
  svc.connectors.fail(device, first.attempt_id, '退出');
  svc.retry(code, first.seq); const second = svc.connectors.claim(device)!;
  svc.removeMember(code, a.id);
  assert.equal(svc.connectors.progress(device, second.attempt_id, {}).cancel, true);
  svc.connectors.fail(device, second.attempt_id, '退出');
  svc.addMember(code, a.id); svc.postMessage(code, '@Codex 测试'); const third = svc.connectors.claim(device)!;
  svc.deleteRoom(code);
  assert.equal(svc.connectors.progress(device, third.attempt_id, {}).cancel, true);
  svc.connectors.fail(device, third.attempt_id, '退出');
  const next = svc.createRoom({ agent_ids: [a.id] }).room.code;
  svc.updateRoom(next, { device_id: device, workspace_id: 'ws-one' }); svc.postMessage(next, '@Codex 测试');
  const last = svc.connectors.claim(device)!; svc.connectors.revoke(device);
  assert.throws(() => svc.connectors.authenticate(paired.token));
  assert.throws(() => svc.connectors.complete(device, last.attempt_id, '撤销后结果'));
  assert.equal(svc.snapshot(next).messages.find(m => m.seq === last.seq)!.status, 'error');
});

test('连接器协作审查通过后 ready 停止，ask_human 等待确认', t => {
  const { svc, code, device, b } = setup(t);
  svc.updateRoom(code, { auto_collaborate: true }); svc.postMessage(code, '@Codex 出方案');
  const plan = svc.connectors.claim(device)!;
  svc.connectors.complete(device, plan.attempt_id, control(plan, 'handoff', { target_id: b.id }));
  const review = svc.connectors.claim(device)!;
  svc.connectors.complete(device, review.attempt_id, control(review, 'ready', { plan_seq: plan.seq }));
  assert.equal(svc.snapshot(code).collaboration!.status, 'ready');
  assert.equal(svc.connectors.claim(device), null);
  svc.postMessage(code, '@Codex 下一个问题'); const next = svc.connectors.claim(device)!;
  svc.connectors.complete(device, next.attempt_id, control(next, 'ask_human'));
  assert.equal(svc.snapshot(code).collaboration!.status, 'waiting_human');
  assert.equal(svc.connectors.claim(device), null);
});

test('排队超时和撤销工作区会终止待办；无效进度不能续租或污染消息', t => {
  const { svc, code, db, device } = setup(t);
  svc.postMessage(code, '@Codex 等待');
  db.prepare("UPDATE rt_connector_tasks SET queue_expires_at=0 WHERE state='queued'").run();
  svc.connectors.sweep(); assert.equal(svc.connectors.claim(device), null);
  const reply = svc.snapshot(code).messages.find(m => m.kind === 'agent')!;
  assert.equal(reply.status, 'error'); svc.retry(code, reply.seq);
  const task = svc.connectors.claim(device)!;
  assert.throws(() => svc.connectors.progress(device, task.attempt_id, { body: {} }));
  svc.connectors.hello(device, { executors: ['codex'], workspaces: [] });
  assert.equal(svc.connectors.progress(device, task.attempt_id, {}).cancel, true);
  assert.equal(svc.snapshot(code).messages.find(m => m.seq === task.seq)!.status, 'error');
  assert.throws(() => svc.connectors.complete(device, task.attempt_id, '无授权结果'));
});


test('绑定成员电脑保留原同机目录，切回时可以恢复', t => {
  const { svc, code, device } = setup(t);
  const dir = mkdtempSync(join(tmpdir(), 'connector-previous-dir-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = svc.updateRoom(code, { device_id: '', workspace_id: '', project_dir: dir }).room.project_dir;
  assert.ok(original);
  assert.equal(svc.updateRoom(code, { device_id: device, workspace_id: 'ws-one' }).room.project_dir, original);
  assert.equal(svc.updateRoom(code, { device_id: '', workspace_id: '' }).room.project_dir, original);
});

test('电脑或项目授权失效不阻断普通房间编辑，派发仍拒绝', t => {
  for (const revoked of [false, true]) {
    const { svc, code, device } = setup(t);
    if (revoked) svc.connectors.revoke(device);
    else svc.connectors.hello(device, { executors: ['codex'], workspaces: [] });
    const snap = svc.updateRoom(code, { title: '新标题', prd: '补充说明', auto_collaborate: false });
    assert.equal(snap.room.title, '新标题');
    assert.equal(snap.room.prd, '补充说明');
    assert.throws(() => svc.postMessage(code, '@Codex 分析项目'));
    assert.throws(() => svc.updateRoom(code, { device_id: device, workspace_id: 'ws-one' }));
  }
});
