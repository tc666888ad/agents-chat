// AI 圆桌 · 前端（原生 JS，无构建）

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PALETTE = ['#3f5477', '#2f6b4f', '#8a5b26', '#6f4a8a', '#9a3b3b', '#2d6f7a', '#7a6a2d'];
const colorOf = (name) => {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
const avatar = (name, cls = '') =>
  `<span class="avatar ${cls}" style="--c:${colorOf(name)}">${esc([...String(name)][0]?.toUpperCase() ?? '?')}</span>`;

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }));
  if (!json.ok) throw new Error(json.error?.message ?? '请求失败');
  return json;
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    toast(copied ? '已复制' : '复制失败，请选中文字手动复制', copied ? '' : 'bad');
  }
}

/** 本地 Agent 的简要说明：执行器 · 模型 · 是否可用 */
function localLine(a) {
  const model = a.model && a.model !== 'default' ? ` · ${esc(a.model)}` : '';
  return `本地 ${esc(a.exec_label || a.base_url)}${model}${a.available === false ? ' · <span class="warn">本机没找到执行器</span>' : ''}`;
}

function mcpUrl(agent) {
  return new URL(agent?.connect_url || '/rt-mcp', location.origin).href;
}

// 极简 markdown：代码块、行内代码、粗体、列表、换行
function md(text) {
  const parts = String(text).split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^[\w-]*\n/, '');
        return `<pre class="code"><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
      }
      return esc(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|\n)#{1,4} ([^\n]+)/g, '$1<b>$2</b>')
        .replace(/(^|\n)[-*] /g, '$1• ')
        .replace(/\n/g, '<br>');
    })
    .join('');
}

// ---------- 状态 ----------

const state = {
  rooms: [],
  agents: [],
  code: null,
  snap: null, // { room, members, messages, max_agents }
  es: null,
  sideOpen: localStorage.getItem('rt_side') !== '0',
};

// ---------- @ 解析（与服务端一致） ----------

const ALL_WORDS = ['所有人', '全部', '大家', 'all', 'everyone'];
function resolveTargets(text, agents) {
  const lower = text.toLowerCase();
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
  const hit = new Set();
  let all = false;
  for (let i = lower.indexOf('@'); i >= 0; i = lower.indexOf('@', i + 1)) {
    const rest = lower.slice(i + 1);
    if (ALL_WORDS.some((w) => rest.startsWith(w))) {
      all = true;
      continue;
    }
    const a = sorted.find((x) => rest.startsWith(x.name.toLowerCase()));
    if (a) hit.add(a.id);
  }
  if (all || hit.size === 0) return { all: true, targets: agents };
  return { all: false, targets: agents.filter((a) => hit.has(a.id)) };
}

// ---------- 房间列表 ----------

async function loadRooms() {
  state.rooms = (await api('/api/rt/rooms')).rooms;
  renderRooms();
}

function renderRooms() {
  const list = $('#room-list');
  if (!state.rooms.length) {
    list.innerHTML = '<p class="muted small pad">还没有房间</p>';
    return;
  }
  list.innerHTML = state.rooms
    .map((r) => {
      const last = r.last ? `${esc(r.last.author)}：${esc(r.last.body.replace(/\s+/g, ' '))}` : '还没有消息';
      return `<a class="room-item ${r.code === state.code ? 'active' : ''}" href="/r/${esc(r.code)}" data-code="${esc(r.code)}">
        <div class="ri-top"><span class="ri-title">${esc(r.title)}</span><span class="ri-time">${r.last ? fmtTime(r.last.time) : ''}</span></div>
        <div class="ri-last">${last}</div>
        <div class="ri-members">${r.members.map((m) => avatar(m.name, 'xs')).join('') || '<span class="muted small">没有 agent</span>'}</div>
      </a>`;
    })
    .join('');
}

$('#room-list').addEventListener('click', (e) => {
  const a = e.target.closest('.room-item');
  if (!a) return;
  e.preventDefault();
  openRoom(a.dataset.code);
});

// ---------- agent 库 ----------

async function loadAgents() {
  state.agents = (await api('/api/rt/agents')).agents;
}

const PRESETS = [
  { key: 'deepseek', label: 'DeepSeek', name: 'DeepSeek', base_url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { key: 'openai', label: 'OpenAI 兼容', name: '', base_url: 'https://', model: '' },
  { key: 'demo', label: '演示（不花钱）', name: '演示助手', base_url: 'demo', model: 'demo' },
];

/** 新建 / 编辑 agent。返回保存后的 agent 或 null。 */
function agentForm(existing = null) {
  return new Promise((resolve) => {
    const isEdit = Boolean(existing);
    const initial = { ...(existing ?? PRESETS[0]), runtime: existing?.runtime ?? 'api' };
    const html = `
      <div class="modal-head"><h2>${isEdit ? `编辑 ${esc(existing.name)}` : '添加 agent'}</h2><button class="x" data-close>×</button></div>
      <form class="modal-body form" id="agent-form">
        ${
          isEdit
            ? ''
            : `<div class="presets">${PRESETS.map(
                (p, i) => `<button type="button" class="preset ${i === 0 ? 'on' : ''}" data-preset="${p.key}">${esc(p.label)}</button>`,
              ).join('')}</div>`
        }
        <label class="field"><span>名字 <em>群聊里显示，@ 它用这个</em></span>
          <input name="name" required maxlength="24" value="${esc(initial.name)}" placeholder="例：DeepSeek、产品经理" /></label>
        <div class="runtime-tabs">
          <button type="button" class="preset ${initial.runtime === 'api' ? 'on' : ''}" data-runtime="api">API 模型</button>
          <button type="button" class="preset ${initial.runtime === 'local' ? 'on' : ''}" data-runtime="local">本地 Agent</button>
          <button type="button" class="preset ${initial.runtime === 'mcp' ? 'on' : ''}" data-runtime="mcp">外部 Agent（MCP）</button>
        </div>
        <div id="local-fields" class="mcp-help" ${initial.runtime !== 'local' ? 'hidden' : ''}>
          <b>由圆桌直接启动本机 Agent</b><p class="muted small">点「出方案 / 审查」或 @ 它时，服务在房间绑定的项目目录里以只读模式启动执行器，读项目记忆和代码，结果自动回到群里并落成产物。</p>
          <div class="row-2">
            <label class="field"><span>执行器</span>
              <select name="exec_kind">
                <option value="codex" ${existing?.exec_kind !== 'dsh' ? 'selected' : ''}>Codex CLI</option>
                <option value="dsh" ${existing?.exec_kind === 'dsh' ? 'selected' : ''}>DeepSeek Harness</option>
              </select></label>
            <label class="field"><span>模型 <em>可选，留空用执行器默认</em></span>
              <input name="local_model" value="${esc(existing?.runtime === 'local' && existing.model !== 'default' ? existing.model : '')}" placeholder="默认" /></label>
          </div>
          <label class="field"><span>本地 Agent 模型地址 <em>可选，仅覆盖此 Agent</em></span>
            <input name="local_base_url" value="${esc(existing?.local_base_url || '')}" placeholder="留空使用 CLI 自身配置" /></label>
          <label class="field"><span>本地 Agent API Key ${isEdit && existing.runtime === 'local' && existing.has_key ? '<em>已保存，留空不改</em>' : '<em>仅保存在本机，运行时通过环境传入</em>'}</span>
            <input name="local_api_key" type="password" autocomplete="new-password" placeholder="留空使用 CLI 自身认证" /></label>
          <p id="local-connection-help" class="muted small"></p>
        </div>
        <div id="api-fields" ${initial.runtime !== 'api' ? 'hidden' : ''}>
          <div class="row-2">
            <label class="field"><span>API 地址</span>
              <input name="base_url" required value="${esc(initial.base_url)}" placeholder="https://api.deepseek.com" /></label>
            <label class="field"><span>模型</span>
              <input name="model" value="${esc(initial.model)}" placeholder="deepseek-chat" /></label>
          </div>
          <label class="field key-field"><span>API Key ${isEdit && existing.has_key ? `<em>已保存 ${esc(existing.key_hint)}，留空不改</em>` : '<em>只存在本机</em>'}</span>
            <input name="api_key" type="password" autocomplete="off" placeholder="${isEdit && existing.has_key ? '••••••（不改就留空）' : 'sk-…'}" /></label>
        </div>
        <div id="mcp-fields" class="mcp-help" ${initial.runtime !== 'mcp' ? 'hidden' : ''}>
          <b>由外部 Agent 主动连接</b><p class="muted small">把连接地址和 Bearer token 配置到支持 Streamable HTTP 的 MCP 客户端。请在外部 Agent 中主动要求它处理房间任务；连接本身不会启动执行。工作区只读，范围为圆桌服务所在项目。</p>
          ${isEdit ? `<label class="field"><span>连接地址</span><div class="copy-line"><input readonly value="${esc(mcpUrl(existing))}"/><button type="button" class="btn ghost sm" id="copy-mcp-url">复制</button></div></label>
            <p class="muted small">${existing.token_hint ? `已保存 token：${esc(existing.token_hint)}…，明文不再展示。` : '保存后生成 token。'}</p>
            ${existing.runtime === 'mcp' ? '<button type="button" class="btn ghost sm" id="regenerate-token">重新生成 token（旧 token 立即失效）</button>' : ''}` : '<p class="muted small">保存后将显示一次性 token，请复制保存。</p>'}
        </div>
        <details class="persona" ${initial.persona ? 'open' : ''}>
          <summary>角色设定（可选）</summary>
          <textarea name="persona" rows="3" placeholder="例：你是资深后端，关注接口一致性和边界情况，说话直接。">${esc(initial.persona ?? '')}</textarea>
        </details>
        <div class="test-line" id="test-line"></div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" id="test-btn">测试连接</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">${isEdit ? '保存' : '保存并使用'}</button>
        </div>
      </form>`;
    const modal = openModal(html, () => resolve(null));
    const form = $('#agent-form', modal);
    const nameInput = form.querySelector('[name=name]');
    let runtime = initial.runtime;
    const syncLocalConnection = () => {
      $('#local-connection-help', modal).textContent = form.exec_kind.value === 'dsh'
        ? 'DSH headless 不继承桌面登录态，需要此处的 Key 或服务环境中的 DEEPSEEK_API_KEY。自定义地址必须支持 Messages 接口（通常为服务商提供的 /anthropic 根地址）；模型留空使用 Harness 默认。'
        : 'Codex 使用 Responses 接口，地址通常以 /v1 结尾，请确认服务商支持。地址和 Key 都留空时使用 CLI 自身配置和登录态；只填 Key 时使用 OpenAI 官方端点。自定义服务请同时填写其模型名。';
    };
    form.exec_kind.addEventListener('change', syncLocalConnection);
    syncLocalConnection();
    const syncRuntime = () => {
      const mcp = runtime === 'mcp';
      $('#api-fields', modal).hidden = runtime !== 'api';
      $('#mcp-fields', modal).hidden = !mcp;
      $('#local-fields', modal).hidden = runtime !== 'local';
      form.base_url.required = runtime === 'api';
      form.querySelectorAll('[data-runtime]').forEach((b) => b.classList.toggle('on', b.dataset.runtime === runtime));
      $('#test-btn', modal).hidden = mcp;
      $('#test-btn', modal).textContent = runtime === 'local' ? '检查执行器' : '测试连接';
    };
    const syncDemo = () => {
      const demo = form.base_url.value.trim().toLowerCase() === 'demo';
      form.querySelector('.key-field').classList.toggle('dim', demo);
    };
    modal.querySelectorAll('[data-runtime]').forEach((b) => b.addEventListener('click', () => { runtime = b.dataset.runtime; syncRuntime(); }));
    syncRuntime();
    syncDemo();
    form.base_url.addEventListener('input', syncDemo);
    modal.querySelectorAll('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        const p = PRESETS.find((x) => x.key === b.dataset.preset);
        modal.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('on', x === b));
        let name = p.name;
        if (name && state.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
          let i = 2;
          while (state.agents.some((a) => a.name.toLowerCase() === `${name}${i}`.toLowerCase())) i++;
          name = `${name}${i}`;
        }
        nameInput.value = name;
        form.base_url.value = p.base_url;
        form.model.value = p.model;
        runtime = 'api';
        syncRuntime();
        syncDemo();
        (name ? form.api_key : nameInput).focus();
      }),
    );
    const values = () => ({
      name: nameInput.value,
      api_key: runtime === 'local' ? form.local_api_key.value : runtime === 'api' ? form.api_key.value : '',
      local_base_url: runtime === 'local' ? form.local_base_url.value : '',
      persona: form.persona.value,
      runtime,
      base_url: runtime === 'mcp' ? 'mcp' : runtime === 'local' ? form.exec_kind.value : form.base_url.value,
      model: runtime === 'mcp' ? 'external' : runtime === 'local' ? form.local_model.value : form.model.value,
    });
    $('#test-btn', modal).addEventListener('click', async () => {
      const line = $('#test-line', modal);
      line.className = 'test-line wait';
      line.textContent = runtime === 'local' ? '正在检查本地执行器和配置…' : '正在发一句“你好”…';
      try {
        const res = await fetch('/api/rt/agents/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...values(), id: existing?.id }),
        });
        const out = await res.json();
        if (!out.ok) throw new Error(out.error?.message ?? '失败');
        line.className = 'test-line ok';
        line.textContent = runtime === 'local' ? `✓ ${out.reply}` : `✓ 通了（${(out.ms / 1000).toFixed(1)}s）：${out.reply}`;
      } catch (err) {
        line.className = 'test-line bad';
        line.textContent = `✗ ${err.message}`;
      }
    });
    $('#copy-mcp-url', modal)?.addEventListener('click', () => copyText(mcpUrl(existing)));
    $('#regenerate-token', modal)?.addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        const out = await api(`/api/rt/agents/${existing.id}/token`, { method: 'POST' });
        await loadAgents().catch(() => toast('凭证已生成，Agent 列表刷新失败，请稍后刷新页面', 'bad'));
        closeModal(modal);
        showMcpToken(out.agent, out.token);
        resolve(out.agent);
      } catch (err) { toast(err.message, 'bad'); }
      finally { button.disabled = false; }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = e.submitter;
      button.disabled = true;
      try {
        let out = isEdit
          ? await api(`/api/rt/agents/${existing.id}`, { method: 'PUT', body: values() })
          : await api('/api/rt/agents', { method: 'POST', body: values() });
        if (isEdit && out.agent.runtime === 'mcp' && !out.agent.token_hint) {
          out = await api(`/api/rt/agents/${existing.id}/token`, { method: 'POST' });
        }
        await loadAgents().catch(() => toast('已保存，Agent 列表刷新失败，请稍后刷新页面', 'bad'));
        closeModal(modal);
        if (out.token) showMcpToken(out.agent, out.token);
        resolve(out.agent);
      } catch (err) {
        const line = $('#test-line', modal);
        line.className = 'test-line bad';
        line.textContent = err.message;
      } finally { button.disabled = false; }
    });
    setTimeout(() => (isEdit || runtime !== 'api' ? nameInput : form.api_key).focus(), 30);
  });
}

function showMcpToken(agent, token) {
  const url = mcpUrl(agent);
  const html = `<div class="modal-head"><h2>外部 Agent 连接信息</h2><button class="x" data-close>×</button></div>
    <div class="modal-body form"><p class="muted small">token 只显示这一次，请立即复制保存。之后可在编辑 Agent 时重新生成。</p>
      <label class="field"><span>连接地址</span><div class="copy-line"><input readonly value="${esc(url)}"/><button type="button" class="btn ghost sm" data-copy-value="${esc(url)}">复制</button></div></label>
      <label class="field"><span>Bearer token</span><div class="copy-line"><input readonly value="${esc(token)}"/><button type="button" class="btn ghost sm" data-copy-value="${esc(token)}">复制</button></div></label>
      <pre class="code">Authorization: Bearer ${esc(token)}</pre>
      <div class="modal-foot"><span class="spacer"></span><button class="btn primary" data-close>我已保存</button></div>
    </div>`;
  const modal = openModal(html);
  modal.addEventListener('click', (e) => { const b = e.target.closest('[data-copy-value]'); if (b) copyText(b.dataset.copyValue); });
}

async function libraryModal() {
  try { await loadAgents(); } catch (err) { return toast(err.message, 'bad'); }
  const render = () => `
    <div class="modal-head"><h2>agent 库</h2><button class="x" data-close>×</button></div>
    <div class="modal-body">
      <p class="muted small">保存过的 agent 可以在任何房间里复用。</p>
      <div class="lib-list">
        ${
          state.agents.length
            ? state.agents
                .map(
                  (a) => `<div class="lib-item">
              ${avatar(a.name)}
              <div class="lib-main"><b>${esc(a.name)}</b><span class="muted small">${a.runtime === 'mcp' ? `MCP · ${a.connected ? '近期连接' : '等待连接'}` : a.runtime === 'local' ? localLine(a) : a.demo ? '演示模式' : `${esc(a.model)} · ${esc(a.base_url.replace(/^https?:\/\//, ''))}`}${a.runtime === 'api' && !a.demo && !a.has_key ? ' · <span class="warn">没填 key</span>' : ''}</span></div>
              <span class="muted small">在 ${a.room_count} 个房间</span>
              ${a.runtime === 'mcp' ? `<button class="btn ghost sm" data-token="${a.id}">新 token</button>` : ''}<button class="btn ghost sm" data-edit="${a.id}">编辑</button>
              <button class="btn ghost sm danger" data-del="${a.id}">删除</button>
            </div>`,
                )
                .join('')
            : '<p class="muted">还没有 agent。</p>'
        }
      </div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn primary" data-new>＋ 添加 agent</button></div>
    </div>`;
  const modal = openModal(render());
  const rerender = () => {
    modal.querySelector('.modal-inner').innerHTML = render();
  };
  modal.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.token) {
      t.disabled = true;
      try {
        const out = await api(`/api/rt/agents/${t.dataset.token}/token`, { method: 'POST' });
        await loadAgents().catch(() => toast('凭证已生成，Agent 列表刷新失败，请稍后刷新页面', 'bad'));
        showMcpToken(out.agent, out.token);
        rerender();
        refreshRoom();
      } catch (err) { toast(err.message, 'bad'); }
      finally { t.disabled = false; }
    } else if (t.dataset.edit) {
      await agentForm(state.agents.find((a) => a.id === t.dataset.edit));
      rerender();
      refreshRoom();
    } else if (t.dataset.del) {
      const a = state.agents.find((x) => x.id === t.dataset.del);
      if (!window.confirm(`删除 ${a.name}？它会从所有房间里移出（聊天记录保留）。`)) return;
      await api(`/api/rt/agents/${a.id}`, { method: 'DELETE' });
      await loadAgents();
      rerender();
      refreshRoom();
      loadRooms();
    } else if (t.hasAttribute('data-new')) {
      await agentForm();
      rerender();
    }
  });
}

$('#open-library').addEventListener('click', libraryModal);

// ---------- 弹窗 ----------

function openModal(html, onCancel) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-inner">${html}</div>`;
  document.body.append(wrap);
  $('#overlay').hidden = false;
  wrap._cancel = onCancel;
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      closeModal(wrap);
      onCancel?.();
    }
  });
  return wrap;
}

function closeModal(wrap) {
  wrap.remove();
  if (!document.querySelector('.modal')) $('#overlay').hidden = true;
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modals = document.querySelectorAll('.modal');
  const top = modals[modals.length - 1];
  if (top) {
    closeModal(top);
    top._cancel?.();
  } else hidePopover();
});

// ---------- 新建房间 ----------

async function newRoomModal() {
  try { await loadAgents(); } catch (err) { return toast(err.message, 'bad'); }
  const chosen = new Set(state.agents.slice(0, 2).map((a) => a.id));
  const n = state.rooms.length + 1;
  const render = () => `
    <div class="modal-head"><h2>新建房间</h2><button class="x" data-close>×</button></div>
    <form class="modal-body form" id="room-form">
      <label class="field"><span>房间名</span>
        <input name="title" maxlength="100" placeholder="例：用户中心接口讨论" value="${esc($('#room-form')?.title.value ?? '')}" /></label>
      <div class="field"><span>谁参加 <em>最多 4 个，之后也能加</em></span>
        <div class="pick-list">
          ${state.agents
            .map(
              (a) => `<button type="button" class="pick ${chosen.has(a.id) ? 'on' : ''}" data-pick="${a.id}">
                ${avatar(a.name, 'sm')}<span>${esc(a.name)}</span>${a.demo ? '<em>演示</em>' : ''}<i class="check">✓</i></button>`,
            )
            .join('')}
          <button type="button" class="pick add" data-add>＋ 新 agent</button>
        </div>
      </div>
      <div class="modal-foot"><span class="spacer"></span>
        <button type="button" class="btn ghost" data-close>取消</button>
        <button type="submit" class="btn primary">开始聊</button></div>
    </form>`;
  const modal = openModal(render());
  const rerender = () => {
    const title = modal.querySelector('[name=title]').value;
    modal.querySelector('.modal-inner').innerHTML = render();
    modal.querySelector('[name=title]').value = title;
  };
  modal.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.pick) {
      if (chosen.has(t.dataset.pick)) chosen.delete(t.dataset.pick);
      else if (chosen.size >= 4) return toast('一个房间最多 4 个 agent');
      else chosen.add(t.dataset.pick);
      rerender();
    } else if (t.hasAttribute('data-add')) {
      const a = await agentForm();
      if (a && chosen.size < 4) chosen.add(a.id);
      rerender();
    }
  });
  let submitting = false;
  modal.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    const button = modal.querySelector('[type=submit]');
    button.disabled = true;
    const title = modal.querySelector('[name=title]').value.trim() || `房间 ${n}`;
    try {
      await loadAgents();
      const available = new Set(state.agents.map((a) => a.id));
      const missing = [...chosen].filter((id) => !available.has(id));
      if (missing.length) {
        missing.forEach((id) => chosen.delete(id));
        rerender();
        return toast('所选 Agent 已删除，请重新选择后创建房间', 'bad');
      }
      const out = await api('/api/rt/rooms', { method: 'POST', body: { title, agent_ids: [...chosen] } });
      closeModal(modal);
      await loadRooms();
      openRoom(out.room.code);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      submitting = false;
      button.disabled = false;
    }
  });
  setTimeout(() => modal.querySelector('[name=title]').focus(), 30);
}

$('#new-room').addEventListener('click', newRoomModal);
$('#welcome-new').addEventListener('click', newRoomModal);

// ---------- 房间 ----------

async function openRoom(code, { push = true } = {}) {
  if (push && location.pathname !== `/r/${code}`) history.pushState({}, '', `/r/${code}`);
  state.code = code;
  state.es?.close();
  try {
    state.snap = await api(`/api/rt/rooms/${encodeURIComponent(code)}`);
  } catch (err) {
    toast(err.message, 'bad');
    state.code = null;
    showWelcome();
    return;
  }
  $('#welcome').hidden = true;
  $('#room').hidden = false;
  $('#side').hidden = !state.sideOpen;
  $('#room-title').value = state.snap.room.title;
  $('#prd').value = state.snap.room.prd;
  $('#prd-state').textContent = '';
  $('#project-dir').value = state.snap.room.project_dir || '';
  $('#project-state').textContent = state.snap.room.project_dir ? '已绑定' : '未绑定';
  renderRooms();
  renderMembers();
  renderDocuments();
  renderCollaboration();
  renderArtifacts();
  renderMessages(true);
  connect(code);
  $('#input').focus();
}

function showWelcome() {
  $('#welcome').hidden = false;
  $('#room').hidden = true;
  $('#side').hidden = true;
  renderRooms();
}

async function refreshRoom() {
  if (!state.code) return;
  const snap = await api(`/api/rt/rooms/${encodeURIComponent(state.code)}`).catch(() => null);
  if (!snap || snap.room.code !== state.code) return;
  state.snap = snap;
  if (document.activeElement !== $('#room-title')) $('#room-title').value = snap.room.title;
  if (document.activeElement !== $('#prd')) $('#prd').value = snap.room.prd;
  if (document.activeElement !== $('#project-dir')) {
    $('#project-dir').value = snap.room.project_dir || '';
    $('#project-state').textContent = snap.room.project_dir ? '已绑定' : '未绑定';
  }
  renderMembers();
  renderDocuments();
  renderCollaboration();
  renderArtifacts();
  renderMessages();
}

function connect(code) {
  const es = new EventSource(`/api/rt/rooms/${encodeURIComponent(code)}/events`);
  state.es = es;
  let first = true;
  es.onopen = () => {
    // 断线重连后补一次全量
    if (!first) refreshRoom();
    first = false;
  };
  es.onmessage = (ev) => {
    if (state.code !== code) return;
    const e = JSON.parse(ev.data);
    if (e.type === 'message') upsertMessage(e.message);
    else if (e.type === 'members') refreshMembers();
    else if (e.type === 'room') refreshRoom();
  };
}

let membersTimer = null;
function refreshMembers() {
  clearTimeout(membersTimer);
  membersTimer = setTimeout(async () => {
    if (!state.code) return;
    const snap = await api(`/api/rt/rooms/${encodeURIComponent(state.code)}`).catch(() => null);
    if (!snap || snap.room.code !== state.code) return;
    state.snap.members = snap.members;
    renderMembers();
    loadRooms();
  }, 80);
}

setInterval(() => {
  if (!document.hidden && state.snap?.members.some((m) => m.runtime === 'mcp')) refreshMembers();
}, 30000);

// ---------- 需求文档与产物 ----------

function fileSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fileUrl(file) {
  return `/api/rt/rooms/${encodeURIComponent(state.code)}/files/${file.split('/').map(encodeURIComponent).join('/')}`;
}
function renderDocuments() {
  if (!state.snap) return;
  const docs = state.snap.docs ?? [];
  $('#doc-count').textContent = docs.length ? `${docs.length}` : '';
  $('#doc-list').innerHTML = docs.length
    ? docs.map((d) => `<div class="doc-item">
        <span class="file-icon">文</span><div class="doc-main"><b title="${esc(d.name)}">${esc(d.name)}</b><span class="muted small">${fileSize(d.size)} · ${d.chars.toLocaleString()} 字</span></div>
        <a class="icon-btn" href="${fileUrl(d.file)}" title="下载原文件">↓</a><button class="icon-btn" data-doc-remove="${d.id}" title="移除">×</button>
      </div>`).join('')
    : '<span class="muted small">还没有上传文档</span>';
}
function renderArtifacts() {
  if (!state.snap) return;
  const arts = state.snap.artifacts ?? [];
  $('#artifact-list').innerHTML = arts.length
    ? arts.map((a) => `<a class="artifact-item" href="${fileUrl(a.file)}" title="${esc(a.path)}"><span class="file-icon ${a.kind}">${a.kind === 'final' ? '定' : a.kind === 'review' ? '审' : '案'}</span><span class="artifact-main"><b>${a.kind === 'final' ? '最终方案' : a.kind === 'review' ? `审查 v${a.version}` : `方案 v${a.version}`}</b><span class="muted small">${esc(a.author)} · ${a.chars.toLocaleString()} 字</span></span><span class="muted">↓</span></a>`).join('')
    : '<span class="muted small">还没有方案文件</span>';
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}
$('#doc-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    try {
      toast(`正在读取 ${file.name}…`);
      const content_base64 = await readFileBase64(file);
      const out = await api(`/api/rt/rooms/${state.code}/docs`, { method: 'POST', body: { name: file.name, content_base64 } });
      state.snap.docs.push(out.doc);
      renderDocuments();
      toast(`已上传 ${file.name}`);
    } catch (err) { toast(err.message, 'bad'); }
  }
});
$('#doc-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-doc-remove]');
  if (!b) return;
  try {
    await api(`/api/rt/rooms/${state.code}/docs/${b.dataset.docRemove}`, { method: 'DELETE' });
    state.snap.docs = state.snap.docs.filter((d) => d.id !== b.dataset.docRemove);
    renderDocuments();
  } catch (err) { toast(err.message, 'bad'); }
});

// ---------- 自动协作 ----------
function renderCollaboration() {
  if (!state.snap) return;
  const c = state.snap.collaboration;
  const enabled = Boolean(state.snap.room.auto_collaborate);
  $('#auto-collaborate').checked = enabled;
  $('#collaboration-bar').hidden = !enabled && !c;
  const labels = { running: '协作运行中', waiting_human: '等待你决定', ready: '审查通过，等待你确认开发', finished: '任务已完成', limit: '已达回复上限', failed: '协作失败，等待处理', stopped: '协作已停止' };
  $('#collaboration-status').textContent = c ? `${labels[c.status] || c.status} · ${c.reply_count}/${c.max_replies} 次回复` : '自动协作已开启';
  $('#collaboration-note').textContent = c?.note || '精确 @一位 Agent 开始：出方案后交给另一位审查，有问题交回修订。';
  $('#collaboration-hint').textContent = (state.snap.members.some(m => m.runtime === 'mcp') ? '外部 Agent 仍需在客户端领取待办，网页不能主动唤醒 IDE。' : '本地 Agent 和 API Agent 会自动执行交接。') + ' 审查通过或需要你决定时 @我 暂停，最多 6 次回复。';
  $('#collaboration-stop').hidden = c?.status !== 'running';
  $('#collaboration-finish').hidden = !c || !['waiting_human', 'failed', 'stopped', 'limit'].includes(c.status);
  $('#collaboration-resume').hidden = !c || !['waiting_human', 'failed', 'stopped'].includes(c.status) || c.reply_count >= c.max_replies;
  $('#collaboration-resume').disabled = !enabled;
}

function applyCollaborationSnapshot(code, snap) {
  if (state.code !== code || snap.room.code !== code) return;
  state.snap = snap;
  renderCollaboration(); renderMembers(); renderMessages();
}

$('#auto-collaborate').addEventListener('change', async () => {
  const code = state.code;
  if (!code) return;
  const toggle = $('#auto-collaborate'); toggle.disabled = true;
  try {
    const snap = await api(`/api/rt/rooms/${encodeURIComponent(code)}`, { method: 'PATCH', body: { auto_collaborate: toggle.checked } });
    applyCollaborationSnapshot(code, snap);
  } catch (err) { if (state.code === code) renderCollaboration(); toast(err.message, 'bad'); }
  finally { toggle.disabled = false; }
});

$('#collaboration-stop').addEventListener('click', async () => {
  const code = state.code; if (!code) return;
  try { applyCollaborationSnapshot(code, await api(`/api/rt/rooms/${encodeURIComponent(code)}/collaboration/stop`, { method: 'POST' })); }
  catch (err) { toast(err.message, 'bad'); }
});

$('#collaboration-finish').addEventListener('click', async () => {
  const code = state.code; if (!code) return;
  try { applyCollaborationSnapshot(code, await api(`/api/rt/rooms/${encodeURIComponent(code)}/collaboration/finish`, { method: 'POST' })); }
  catch (err) { toast(err.message, 'bad'); }
});

function resumeCollaborationModal() {
  const code = state.code, chain = state.snap?.collaboration;
  if (!code || !chain) return;
  const modal = openModal(`<div class="modal-head"><h2>继续协作</h2><button class="x" data-close>×</button></div>
    <form class="modal-body form" id="collaboration-form">
    <p class="muted small">${esc(chain.note || '请填写你的决定或修正要求')}。剩余 ${Math.max(0, chain.max_replies - chain.reply_count)} 次回复，继续不会重置额度。</p>
    <label class="field"><span>你的决定 / 补充要求</span><textarea name="text" required maxlength="8000" rows="4"></textarea></label>
    <label class="field"><span>交给谁继续</span><select name="agent_id">${state.snap.members.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label>
    <div class="modal-foot"><span class="spacer"></span><button type="button" class="btn ghost" data-close>取消</button><button type="submit" class="btn primary">继续协作</button></div></form>`);
  const form = $('#collaboration-form', modal);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (state.code !== code || state.snap?.collaboration?.id !== chain.id) { closeModal(modal); return; }
    const text = $('[name=text]', modal).value.trim();
    if (!text) return toast('请填写你的决定', 'bad');
    const btn = e.submitter; btn.disabled = true;
    try {
      const snap = await api(`/api/rt/rooms/${encodeURIComponent(code)}/collaboration/resume`, { method: 'POST', body: { text, agent_id: $('[name=agent_id]', modal).value, collaboration_id: chain.id } });
      closeModal(modal); applyCollaborationSnapshot(code, snap);
    } catch (err) { toast(err.message, 'bad'); }
    finally { btn.disabled = false; }
  });
}
$('#collaboration-resume').addEventListener('click', resumeCollaborationModal);

function flowModal(action, refSeq = null) {
  const labels = { plan: '出方案', review: '选择审查模型', revise: '按审查意见修订' };
  const candidates = state.snap.members.filter((m) => action !== 'review' || m.id !== state.snap.messages.find((x) => x.seq === refSeq)?.agent_id);
  if (!candidates.length) return toast('房间里没有可用的另一个 agent', 'bad');
  const modal = openModal(`<div class="modal-head"><h2>${labels[action]}</h2><button class="x" data-close>×</button></div>
    <form class="modal-body form" id="flow-form"><p class="muted small">${action === 'plan' ? '它会读取已上传的需求文档和补充说明。' : action === 'review' ? '审查模型会读取需求文档和选中的方案。' : '模型会读取上一版方案和审查意见，输出完整新版。'}</p>
    <label class="field"><span>选择 agent</span><select name="agent_id">${candidates.map((m) => `<option value="${m.id}">${esc(m.name)}${m.runtime === 'mcp' ? ` · 外部 Agent · ${m.connected ? '近期连接' : '等待连接'}` : m.runtime === 'local' ? ` · 本地 ${esc(m.exec_label || m.base_url)}` : m.demo ? '（演示）' : ` · ${esc(m.model)}`}</option>`).join('')}</select></label>
    <p class="muted small">本地 Agent 会在房间绑定的项目目录里只读运行，读完代码后结果自动回到群里${state.snap.room.project_dir ? `（当前：${esc(state.snap.room.project_dir)}）` : '，<span class="warn">请先在右侧绑定项目目录</span>'}。外部 Agent 需要到其客户端要求它处理待办。</p>
    <div class="modal-foot"><span class="spacer"></span><button type="button" class="btn ghost" data-close>取消</button><button class="btn primary" type="submit">开始${action === 'review' ? '审查' : action === 'revise' ? '修订' : '生成'}</button></div></form>`);
  $('#flow-form', modal).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true; btn.textContent = '处理中…';
    try {
      const out = await api(`/api/rt/rooms/${state.code}/flow`, { method: 'POST', body: { action, agent_id: $('#flow-form [name=agent_id]').value, ref_seq: refSeq } });
      closeModal(modal); upsertMessage(out.message); out.replies.forEach(upsertMessage); scrollBottom();
    } catch (err) { btn.disabled = false; btn.textContent = '重试'; toast(err.message, 'bad'); }
  });
}
$('#flow-plan').addEventListener('click', () => flowModal('plan'));

// ---------- 成员 ----------

function renderMembers() {
  const { members, max_agents } = state.snap;
  $('#head-members').innerHTML =
    members
      .map(
        (m) => `<span class="hm ${m.busy ? 'busy' : ''}" title="${esc(m.name)}${m.busy ? (m.runtime === 'mcp' ? ' · 等待外部处理' : m.runtime === 'local' ? ' · 本地运行中' : ' · 回复中') : ''}">${avatar(m.name, 'sm')}</span>`,
      )
      .join('') +
    (members.length < max_agents ? `<button class="hm add" id="head-add" title="添加 agent">＋</button>` : '');
  $('#head-add')?.addEventListener('click', (e) => addMemberPopover(e.currentTarget));
  $('#member-count').textContent = `${members.length}/${max_agents}`;
  $('#add-member').disabled = members.length >= max_agents;
  $('#member-list').innerHTML = members.length
    ? members
        .map(
          (m) => `<div class="member">
        ${avatar(m.name)}
        <div class="m-main"><b>${esc(m.name)}</b>
          <span class="muted small">${m.runtime === 'mcp' ? `MCP · ${m.busy ? '等待外部处理' : m.connected ? '近期连接' : '等待连接'}` : m.busy ? `<span class="typing-dot"></span>${m.runtime === 'local' ? '本地运行中' : '回复中'}` : m.runtime === 'local' ? localLine(m) : m.demo ? '演示模式' : esc(m.model)}${m.runtime === 'api' && !m.demo && !m.has_key ? ' · <span class="warn">没填 key</span>' : ''}</span></div>
        <button class="icon-btn" data-member-menu="${m.id}" title="更多">⋯</button>
      </div>`,
        )
        .join('')
    : '<p class="muted small">还没有 agent，点「添加」拉一个进来。</p>';
  renderTargets();
}

$('#add-member').addEventListener('click', (e) => addMemberPopover(e.currentTarget));

$('#member-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-member-menu]');
  if (!b) return;
  const m = state.snap.members.find((x) => x.id === b.dataset.memberMenu);
  showPopover(
    b,
    `<button class="pop-item" data-act="at">@ ${esc(m.name)}</button>
     <button class="pop-item" data-act="edit">编辑设置</button>
     <button class="pop-item danger" data-act="remove">移出房间</button>`,
    async (act) => {
      if (act === 'at') insertMention(m.name);
      if (act === 'edit') {
        await agentForm(state.agents.find((a) => a.id === m.id) ?? m);
        refreshRoom();
      }
      if (act === 'remove') {
        await api(`/api/rt/rooms/${state.code}/members/${m.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'bad'));
      }
    },
  );
});

async function addMemberPopover(anchor) {
  const code = state.code;
  if (!code || !state.snap) return;
  try { await loadAgents(); } catch (err) { return toast(err.message, 'bad'); }
  if (state.code !== code) return;
  const inRoom = new Set(state.snap.members.map((m) => m.id));
  const candidates = state.agents.filter((a) => !inRoom.has(a.id));
  showPopover(
    anchor,
    `${candidates
      .map((a) => `<button class="pop-item" data-act="add:${a.id}">${avatar(a.name, 'xs')} ${esc(a.name)}${a.demo ? ' <em>演示</em>' : ''}</button>`)
      .join('')}
     ${candidates.length ? '<div class="pop-sep"></div>' : ''}
     <button class="pop-item accent" data-act="new">＋ 新建 agent…</button>`,
    async (act) => {
      if (state.code !== code) return;
      let agentId = act.startsWith('add:') ? act.slice(4) : null;
      if (act === 'new') {
        const a = await agentForm();
        agentId = a?.id ?? null;
      }
      if (!agentId) return;
      try {
        await loadAgents();
        if (state.code !== code) return;
        if (!state.agents.some((a) => a.id === agentId)) {
          return toast('所选 Agent 已删除，请重新选择', 'bad');
        }
        const snap = await api(`/api/rt/rooms/${code}/members`, { method: 'POST', body: { agent_id: agentId } });
        if (state.code === code) { state.snap = snap; renderMembers(); }
        await loadRooms();
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  );
}

// ---------- 浮层菜单 ----------

function showPopover(anchor, html, onPick) {
  const pop = $('#popover');
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  pop.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    hidePopover();
    onPick(b.dataset.act);
  };
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
}
function outside(e) {
  if (!e.target.closest('#popover')) hidePopover();
}
function hidePopover() {
  $('#popover').hidden = true;
  document.removeEventListener('mousedown', outside);
}

// ---------- 消息 ----------

function nearBottom() {
  const el = $('#messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function scrollBottom() {
  const el = $('#messages');
  el.scrollTop = el.scrollHeight;
}

function messageHtml(m) {
  if (m.kind === 'system') return `<div class="msg system${m.body.includes('@我') ? ' attention' : ''}" data-seq="${m.seq}"><span>${esc(m.body)} · ${fmtTime(m.time)}</span></div>`;
  if (m.kind === 'human') {
    const to =
      m.targets.length && state.snap.members.length > 1 && m.targets.length < state.snap.members.length
        ? `<div class="to">只问 ${m.targets.map(esc).join('、')}</div>`
        : '';
    return `<div class="msg human" data-seq="${m.seq}">
      <div class="bubble">${md(m.body)}</div>${to}<div class="meta">${fmtTime(m.time)}</div></div>`;
  }
  const working = m.status === 'pending' || m.status === 'streaming';
  let body;
  const runtime = state.snap.members.find((a) => a.id === m.agent_id)?.runtime;
  const progress = working && m.progress ? `<div class="progress muted small">⏵ ${esc(m.progress)}</div>` : '';
  if (m.status === 'pending' && !m.body) body = runtime === 'mcp'
    ? '<span class="muted small">等待外部 Agent 处理，请在客户端中要求它获取本房间待办。</span>'
    : `<span class="thinking"><i></i><i></i><i></i></span><span class="muted small">${runtime === 'local' ? esc(m.progress || '本地 Agent 启动中') : '思考中'}</span>`;
  else body = md(m.body) + (m.status === 'streaming' || (working && m.body) ? '<span class="caret"></span>' : '') + progress;
  const err =
    m.status === 'error'
      ? `<div class="err">⚠ ${esc(m.error)} ${m.collaboration_id ? '请使用上方继续协作' : `<button class="link" data-retry="${m.seq}">重试</button>`}</div>`
      : '';
  const actions = working
    ? `<button class="link muted" data-stop="${m.seq}">停止</button>`
    : m.status === 'done'
      ? `<button class="link muted" data-copy="${m.seq}">复制</button>${m.collaboration_id ? '' : `<button class="link muted" data-retry="${m.seq}">重新回答</button>`}${m.stage === 'plan' ? `<button class="link" data-flow="review" data-ref="${m.seq}">找人审查</button><button class="link" data-finalize="${m.seq}">定稿</button>` : m.stage === 'review' ? `<button class="link" data-flow="revise" data-ref="${m.seq}">按意见修订</button>` : ''}`
      : '';
  return `<div class="msg agent ${m.status}" data-seq="${m.seq}">
    ${avatar(m.author)}
    <div class="col">
      <div class="who"><b style="color:${colorOf(m.author)}">${esc(m.author)}</b><span class="meta">${fmtTime(m.time)}</span><span class="acts">${actions}</span></div>
      ${m.body || m.status === 'pending' ? `<div class="bubble">${body}</div>` : ''}${err}
    </div></div>`;
}

function renderMessages(forceBottom = false) {
  const el = $('#messages');
  const stick = forceBottom || nearBottom();
  const msgs = state.snap.messages;
  if (!msgs.length) {
    el.innerHTML = emptyHtml();
  } else {
    el.innerHTML = msgs.map(messageHtml).join('');
  }
  if (stick) scrollBottom();
}

function emptyHtml() {
  const members = state.snap.members;
  if (!members.length) {
    return `<div class="empty-room"><p>房间里还没有 agent</p><button class="btn primary" id="empty-add">＋ 添加 agent</button></div>`;
  }
  const names = members.map((m) => m.name);
  const sample = names.length > 1 ? `@${names[0]} ` : '';
  return `<div class="empty-room">
    <div class="er-avatars">${members.map((m) => avatar(m.name)).join('')}</div>
    <p>${names.map(esc).join('、')} 已就位</p>
    <p class="muted small">发消息或 @ 点名会创建待办；API 模型和本地 Agent 自动回答（本地 Agent 需先绑定项目目录），外部 Agent 需在其客户端处理</p>
    <div class="suggest">
      <button class="chip" data-fill="大家好，先各自介绍一下你擅长什么？">大家好，先各自介绍一下</button>
      ${sample ? `<button class="chip" data-fill="${esc(sample)}这个需求你怎么看？">${esc(sample)}这个需求你怎么看？</button>` : ''}
    </div></div>`;
}

$('#messages').addEventListener('click', async (e) => {
  if (e.target.closest('#empty-add')) return addMemberPopover(e.target.closest('#empty-add'));
  const fill = e.target.closest('[data-fill]');
  if (fill) {
    $('#input').value = fill.dataset.fill;
    autoGrow();
    renderTargets();
    $('#input').focus();
    return;
  }
  const retry = e.target.closest('[data-retry]');
  if (retry) {
    await api(`/api/rt/rooms/${state.code}/messages/${retry.dataset.retry}/retry`, { method: 'POST' }).catch((err) =>
      toast(err.message, 'bad'),
    );
    return;
  }
  const stop = e.target.closest('[data-stop]');
  if (stop) {
    await api(`/api/rt/rooms/${state.code}/messages/${stop.dataset.stop}/stop`, { method: 'POST' }).catch(() => {});
    return;
  }
  const flow = e.target.closest('[data-flow]');
  if (flow) return flowModal(flow.dataset.flow, Number(flow.dataset.ref));
  const finalize = e.target.closest('[data-finalize]');
  if (finalize) {
    if (!window.confirm('把这版方案写成 final.md？')) return;
    await api(`/api/rt/rooms/${state.code}/messages/${finalize.dataset.finalize}/finalize`, { method: 'POST' }).then(() => refreshRoom()).catch((err) => toast(err.message, 'bad'));
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const m = state.snap.messages.find((x) => x.seq === Number(copy.dataset.copy));
    await copyText(m.body);
  }
});

function upsertMessage(m) {
  const msgs = state.snap.messages;
  const i = msgs.findIndex((x) => x.seq === m.seq);
  const stick = nearBottom();
  if (i >= 0) msgs[i] = m;
  else {
    msgs.push(m);
    msgs.sort((a, b) => a.seq - b.seq);
  }
  const el = $('#messages');
  const node = el.querySelector(`[data-seq="${m.seq}"]`);
  if (node) node.outerHTML = messageHtml(m);
  else if (msgs.length === 1) el.innerHTML = messageHtml(m);
  else el.insertAdjacentHTML('beforeend', messageHtml(m));
  if (stick) scrollBottom();
}

// ---------- 输入框 ----------

const $input = $('#input');

function autoGrow() {
  $input.style.height = 'auto';
  $input.style.height = `${Math.min(200, $input.scrollHeight)}px`;
}

function renderTargets() {
  if (!state.snap) return;
  const members = state.snap.members;
  const el = $('#targets');
  if (!members.length) {
    el.innerHTML = '<span class="muted small">房间里还没有 agent，发了也没人回</span>';
    return;
  }
  const { all, targets } = resolveTargets($input.value, members);
  const ids = new Set(targets.map((t) => t.id));
  el.innerHTML =
    `<span class="t-label">${all ? (members.length > 1 ? '大家都会回答' : '回答：') : '只有这些会回答'}</span>` +
    members
      .map(
        (m) =>
          `<button type="button" class="t-chip ${ids.has(m.id) ? 'on' : ''} ${all ? 'soft' : ''}" data-at="${esc(m.name)}" title="${all ? `只问 ${esc(m.name)}` : ids.has(m.id) ? `取消 @${esc(m.name)}` : `也问 ${esc(m.name)}`}">${avatar(m.name, 'xs')}${esc(m.name)}</button>`,
      )
      .join('');
}

$('#targets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-at]');
  if (!b) return;
  const name = b.dataset.at;
  const re = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s?`, 'gi');
  if (re.test($input.value)) $input.value = $input.value.replace(re, '');
  else $input.value = `@${name} ${$input.value.replace(/^\s+/, '')}`;
  autoGrow();
  renderTargets();
  $input.focus();
});

function insertMention(name) {
  $input.value = `@${name} ${$input.value}`;
  autoGrow();
  renderTargets();
  $input.focus();
}

// @ 弹出补全
const pop = { open: false, items: [], index: 0, start: -1 };

function mentionQuery() {
  const pos = $input.selectionStart;
  const before = $input.value.slice(0, pos);
  const m = /@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: pos - m[0].length, q: m[1].toLowerCase() };
}

function updateMentionPop() {
  const box = $('#mention-pop');
  const mq = state.snap ? mentionQuery() : null;
  if (!mq) {
    box.hidden = true;
    pop.open = false;
    return;
  }
  const options = [...state.snap.members.map((m) => m.name), ...(state.snap.members.length > 1 ? ['所有人'] : [])];
  pop.items = options.filter((n) => n.toLowerCase().includes(mq.q));
  if (!pop.items.length) {
    box.hidden = true;
    pop.open = false;
    return;
  }
  pop.start = mq.start;
  pop.index = Math.min(pop.index, pop.items.length - 1);
  pop.open = true;
  box.hidden = false;
  box.innerHTML = pop.items
    .map(
      (n, i) =>
        `<button type="button" class="mp-item ${i === pop.index ? 'on' : ''}" data-i="${i}">${n === '所有人' ? '<span class="avatar sm all">全</span>' : avatar(n, 'sm')}${esc(n)}</button>`,
    )
    .join('');
}

function pickMention(i) {
  const name = pop.items[i];
  const end = $input.selectionStart;
  $input.value = `${$input.value.slice(0, pop.start)}@${name} ${$input.value.slice(end)}`;
  const caret = pop.start + name.length + 2;
  $input.setSelectionRange(caret, caret);
  pop.index = 0;
  updateMentionPop();
  renderTargets();
  $input.focus();
}

$('#mention-pop').addEventListener('mousedown', (e) => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  e.preventDefault();
  pickMention(Number(b.dataset.i));
});

$input.addEventListener('input', () => {
  autoGrow();
  renderTargets();
  updateMentionPop();
});
$input.addEventListener('click', updateMentionPop);
$input.addEventListener('blur', () => setTimeout(() => ($('#mention-pop').hidden = true), 100));

$input.addEventListener('keydown', (e) => {
  if (pop.open && !$('#mention-pop').hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pop.index = (pop.index + (e.key === 'ArrowDown' ? 1 : -1) + pop.items.length) % pop.items.length;
      updateMentionPop();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickMention(pop.index);
      return;
    }
    if (e.key === 'Escape') {
      $('#mention-pop').hidden = true;
      pop.open = false;
      e.stopPropagation();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $input.value.trim();
  if (!text || !state.code) return;
  if (!state.snap.members.length) {
    toast('先添加一个 agent');
    return;
  }
  $input.value = '';
  autoGrow();
  renderTargets();
  try {
    const out = await api(`/api/rt/rooms/${state.code}/messages`, { method: 'POST', body: { text } });
    upsertMessage(out.message);
    out.replies.forEach(upsertMessage);
    scrollBottom();
  } catch (err) {
    $input.value = text;
    autoGrow();
    renderTargets();
    toast(err.message, 'bad');
  }
});

// ---------- 房间名、资料、删除、侧栏 ----------

$('#room-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});
$('#room-title').addEventListener('change', async (e) => {
  await api(`/api/rt/rooms/${state.code}`, { method: 'PATCH', body: { title: e.target.value } }).catch((err) =>
    toast(err.message, 'bad'),
  );
  loadRooms();
});

let prdTimer = null;
$('#prd').addEventListener('input', () => {
  $('#prd-state').textContent = '未保存';
  clearTimeout(prdTimer);
  prdTimer = setTimeout(async () => {
    await api(`/api/rt/rooms/${state.code}`, { method: 'PATCH', body: { prd: $('#prd').value } })
      .then(() => ($('#prd-state').textContent = '已保存'))
      .catch(() => ($('#prd-state').textContent = '保存失败'));
  }, 600);
});

async function saveProjectDir() {
  const value = $('#project-dir').value.trim();
  $('#project-state').textContent = '保存中…';
  try {
    const snap = await api(`/api/rt/rooms/${state.code}`, { method: 'PATCH', body: { project_dir: value } });
    state.snap.room = snap.room;
    $('#project-dir').value = snap.room.project_dir || '';
    $('#project-state').textContent = snap.room.project_dir ? '已绑定' : '未绑定';
  } catch (err) {
    $('#project-state').textContent = '保存失败';
    toast(err.message, 'bad');
  }
}
$('#project-save').addEventListener('click', saveProjectDir);
$('#project-dir').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveProjectDir(); }
});

$('#delete-room').addEventListener('click', async () => {
  if (!window.confirm(`删除「${state.snap.room.title}」和全部聊天记录？`)) return;
  await api(`/api/rt/rooms/${state.code}`, { method: 'DELETE' });
  state.es?.close();
  state.code = null;
  history.pushState({}, '', '/');
  await loadRooms();
  showWelcome();
});

$('#toggle-side').addEventListener('click', () => {
  state.sideOpen = !state.sideOpen;
  localStorage.setItem('rt_side', state.sideOpen ? '1' : '0');
  $('#side').hidden = !state.sideOpen;
});

window.addEventListener('popstate', () => {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9-]+)$/);
  if (m) openRoom(m[1], { push: false });
  else {
    state.code = null;
    state.es?.close();
    showWelcome();
  }
});

// ---------- 启动 ----------

(async () => {
  await Promise.all([loadRooms(), loadAgents()]);
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9-]+)$/);
  if (m) openRoom(m[1], { push: false });
  else if (state.rooms.length) openRoom(state.rooms[0].code);
  else showWelcome();
})();
