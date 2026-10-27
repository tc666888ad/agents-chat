import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../src/web/rt.js', import.meta.url), 'utf8').split('// ---------- 启动 ----------')[0];
const oldAgent = { id: 'ag_deleted', name: '已删除助手' };
const liveAgent = { id: 'ag_live', name: '当前助手' };

function page() {
  const handlers: Record<string, (e: any) => Promise<void>> = {};
  const title = { value: '我的需求讨论' };
  const submit = { disabled: false };
  const inner = { innerHTML: '' };
  const notices: string[] = [];
  const calls: { path: string; options: any }[] = [];
  let agents = [liveAgent];
  let popHtml = '';
  let pick: (act: string) => Promise<void>;
  const modal = {
    addEventListener: (type: string, handler: any) => { handlers[type] = handler; },
    querySelector: (selector: string) => selector === '[name=title]' ? title : selector === '.modal-inner' ? inner : submit,
  };
  const context = createContext({
    document: { querySelector: (selector: string) => selector === '#room-form' ? null : { addEventListener() {} }, addEventListener() {} },
    window: { addEventListener() {} }, localStorage: { getItem: () => null }, setInterval() {}, setTimeout() {},
    fakeApi: async (path: string, options: any = {}) => {
      calls.push({ path, options });
      if (path === '/api/rt/agents') return { agents };
      if (path.endsWith('/members')) return { members: [] };
      if (path === '/api/rt/rooms') return { room: { code: 'RT-TEST' } };
      throw new Error(`unexpected request ${path}`);
    },
    fakeOpen: (html: string) => { inner.innerHTML = html; return modal; },
    fakeToast: (text: string) => notices.push(text),
    fakePopover: (_anchor: unknown, html: string, onPick: typeof pick) => { popHtml = html; pick = onPick; },
  });
  runInContext(`${source}\napi = fakeApi; openModal = fakeOpen; toast = fakeToast; showPopover = fakePopover;
    closeModal = () => {}; loadRooms = async () => {}; openRoom = () => {}; renderMembers = () => {};
    globalThis.ui = { state, newRoomModal, addMemberPopover };`, context);
  const ui = context.ui;
  ui.state.agents = [oldAgent];
  ui.state.code = 'RT-TEST';
  ui.state.snap = { members: [] };
  return { ui, title, submit, inner, notices, calls, handlers,
    setAgents: (next: typeof agents) => { agents = next; },
    get popHtml() { return popHtml; },
    pick: (act: string) => pick(act),
  };
}

test('建房时刷新 Agent 列表，不展示已删除的缓存 Agent', async () => {
  const p = page();
  await p.ui.newRoomModal();
  assert.match(p.inner.innerHTML, /ag_live/);
  assert.doesNotMatch(p.inner.innerHTML, /ag_deleted/);
});

test('建房提交时发现 Agent 已删除，保留标题并要求重新选择', async () => {
  const p = page();
  p.ui.state.agents = [liveAgent];
  await p.ui.newRoomModal();
  p.setAgents([]);
  await p.handlers.submit({ preventDefault() {}, submitter: p.submit });
  assert.equal(p.calls.filter(c => c.options.method === 'POST').length, 0);
  assert.equal(p.title.value, '我的需求讨论');
  assert.match(p.notices.join('\n'), /已删除.*重新选择/);
  assert.equal(p.submit.disabled, false);
});

test('加入成员时刷新候选列表，提交前再次检查 Agent 是否存在', async () => {
  const p = page();
  await p.ui.addMemberPopover({});
  assert.match(p.popHtml, /ag_live/);
  assert.doesNotMatch(p.popHtml, /ag_deleted/);
  p.setAgents([]);
  await p.pick('add:ag_live');
  assert.equal(p.calls.filter(c => c.options.method === 'POST').length, 0);
  assert.match(p.notices.join('\n'), /已删除.*重新选择/);
});

test('添加成员菜单打开后切换房间，不会把成员加入另一个房间', async () => {
  const p = page();
  await p.ui.addMemberPopover({});
  p.ui.state.code = 'RT-OTHER';
  await p.pick('add:ag_live');
  assert.equal(p.calls.filter(c => c.options.method === 'POST').length, 0);
});

test('本地 Agent 表单独立提交模型 URL 和 Key，不丢弃凭据或混入 API 类型的地址', async () => {
  let submit: (e: any) => Promise<void> = async () => {};
  const field = (value = '') => ({ value, required: false, addEventListener() {}, focus() {} });
  const form: any = {
    name: field('本地Codex'), exec_kind: field('codex'), local_model: field('model-1'),
    local_base_url: field('https://example.invalid/v1'), local_api_key: field('ui-secret'),
    base_url: field('https://wrong-api.invalid'), model: field('wrong-model'), api_key: field('wrong-api-key'), persona: field(),
    querySelector(selector: string) { return selector === '[name=name]' ? this.name : { classList: { toggle() {} } }; },
    querySelectorAll() { return []; },
    addEventListener(type: string, handler: any) { if (type === 'submit') submit = handler; },
  };
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (selector === '#agent-form') return form;
    if (!nodes.has(selector)) nodes.set(selector, { hidden: false, addEventListener() {} });
    return nodes.get(selector);
  };
  const modal = { querySelector: node, querySelectorAll() { return []; } };
  let payload: any;
  let modalHtml = '';
  const context = createContext({
    document: { querySelector: node, addEventListener() {} }, window: { addEventListener() {} },
    localStorage: { getItem() { return null; } }, location: { origin: 'http://localhost:3010', pathname: '/' },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, URL, console,
  });
  runInContext(source + `\n globalThis.ui={agentForm}; openModal=globalThis.modalOpen; closeModal=()=>{}; api=globalThis.fakeApi;`,
    Object.assign(context, {
      modalOpen(html: string) { modalHtml = html; return modal; },
      async fakeApi(_path: string, options: any) {
        if (options?.method === 'PUT') { payload = options.body; return { agent: { id: 'a', runtime: 'local' } }; }
        return { agents: [] };
      },
    }));
  const pending = (context as any).ui.agentForm({id:'a', name:'本地Codex', runtime:'local', exec_kind:'codex', model:'default', base_url:'codex'});
  await submit({ preventDefault() {}, submitter: { disabled: false } });
  await pending;
  assert.equal(payload.local_base_url, 'https://example.invalid/v1');
  assert.equal(payload.api_key, 'ui-secret');
  assert.equal(payload.base_url, 'codex');
  assert.equal(payload.model, 'model-1');
  assert.match(modalHtml, /name="local_api_key"/);
});

function collaborationPage() {
  const nodes = new Map<string, any>(); const calls: any[] = []; const notices: string[] = [];
  let html = '';
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', checked: false, disabled: false, hidden: false, textContent: '', innerHTML: '', handlers: {} as any,
      addEventListener(type: string, fn: any) { this.handlers[type] = fn; } });
    return nodes.get(selector);
  };
  const context = createContext({ document: { querySelector: node, addEventListener() {} }, window: { addEventListener() {} },
    localStorage: { getItem: () => null }, setInterval() {}, setTimeout() {}, clearTimeout() {},
    fakeApi: async (path: string, options: any) => { calls.push({ path, options }); return context.ui.state.snap; },
    fakeOpen: (value: string) => { html = value; return { querySelector: node }; }, fakeToast: (s: string) => notices.push(s),
  });
  runInContext(source + `\n api=fakeApi;openModal=fakeOpen;toast=fakeToast;closeModal=()=>{};renderMembers=()=>{};renderMessages=()=>{};
    globalThis.ui={state,renderCollaboration,resumeCollaborationModal};`, context);
  const ui = context.ui;
  ui.state.code = 'RT-TEST'; ui.state.snap = { room: { code: 'RT-TEST', auto_collaborate: true }, members: [{ id: 'ag1', name: 'Codex', runtime: 'mcp' }],
    collaboration: { id: 'co1', status: 'waiting_human', reply_count: 2, max_replies: 6, note: '决定采用哪个方案' } };
  return { ui, node, calls, notices, get html() { return html; } };
}

test('自动协作页面显示状态、次数、外部待办提示，开关提交布尔值', async () => {
  const p = collaborationPage(); p.ui.renderCollaboration();
  assert.match(p.node('#collaboration-status').textContent, /等待你决定.*2\/6/);
  assert.match(p.node('#collaboration-hint').textContent, /外部.*客户端.*待办/);
  p.node('#auto-collaborate').checked = false;
  await p.node('#auto-collaborate').handlers.change();
  assert.equal(p.calls[0].path, '/api/rt/rooms/RT-TEST');
  assert.equal(p.calls[0].options.body.auto_collaborate, false);
});

test('停止协作调用当前房间；继续提交决定和目标，切换房间后禁止误提交', async () => {
  const p = collaborationPage();
  p.ui.state.snap.collaboration.status = 'running';
  await p.node('#collaboration-stop').handlers.click();
  assert.equal(p.calls[0].path, '/api/rt/rooms/RT-TEST/collaboration/stop');
  p.ui.state.snap.collaboration.status = 'waiting_human';
  p.ui.resumeCollaborationModal();
  p.node('[name=text]').value = '采用方案一'; p.node('[name=agent_id]').value = 'ag1';
  await p.node('#collaboration-form').handlers.submit({ preventDefault() {}, submitter: { disabled: false } });
  assert.equal(p.calls[1].path, '/api/rt/rooms/RT-TEST/collaboration/resume');
  assert.equal(p.calls[1].options.body.text, '采用方案一');
  assert.equal(p.calls[1].options.body.agent_id, 'ag1');
  p.ui.resumeCollaborationModal(); p.ui.state.code = 'RT-OTHER';
  await p.node('#collaboration-form').handlers.submit({ preventDefault() {}, submitter: { disabled: false } });
  assert.equal(p.calls.length, 2);
});
