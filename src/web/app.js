// 接口协商室 · 前端（原生 JS，无构建）

const ROLE_LABEL = { designer: '设计方', reviewer: '复核方', frontend: '前端', backend: '后端' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
};

async function api(url, options = {}) {
  const token = options.token ?? '';
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data?.error?.message ?? `请求失败（${res.status}）`);
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

// ---------- 入场券 ----------

const TOKEN_PREFIX = 'nr_token_';

function takeUrlToken() {
  const url = new URL(location.href);
  const token = url.searchParams.get('token');
  if (!token) return null;
  url.searchParams.delete('token');
  history.replaceState(null, '', url.pathname + (url.search || ''));
  return token;
}

function saveToken(code, token) {
  try {
    localStorage.setItem(`${TOKEN_PREFIX}${code}`, token);
  } catch {
    /* 忽略隐私模式 */
  }
}

function loadToken(code) {
  try {
    return localStorage.getItem(`${TOKEN_PREFIX}${code}`) ?? '';
  } catch {
    return '';
  }
}

// ================= 首页 =================

function initHome() {
  const form = $('#create-form');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '正在建房…';
    try {
      const out = await api('/api/rooms', {
        method: 'POST',
        body: {
          title: data.get('title'),
          op_scope: data.get('op_scope') ?? '',
          prd: data.get('prd') ?? '',
          designer_seat: data.get('designer_seat') ?? 'A',
        },
      });
      showCreated(out);
      refreshRooms();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '建房，生成三张入场券';
    }
  });

  refreshRooms();
  setInterval(refreshRooms, 5000);
}

function showCreated(out) {
  const { room, tokens } = out;
  const agents = tokens.filter((t) => t.seat);
  const backend = tokens.find((t) => t.role === 'backend');
  if (backend) saveToken(room.code, backend.token);

  $('#created-code').textContent = `${room.code} · ${room.title}`;
  $('#created-tip').textContent =
    '建好后：把两张 agent 票分别配给 DeepSeek 和 Codex，让它们各自「进房间」。方案稳定后点「把前端同事拉进来」，把链接发给他。';
  $('#created-tokens').innerHTML = [
    ...agents.map(
      (t) => `
      <div class="token-row">
        <div class="token-head">
          <span class="member role-${t.role}">${ROLE_LABEL[t.role] ?? t.role}</span>
          <span class="muted">入场券 ${t.seat}</span>
        </div>
        <code class="token">${esc(t.token)}</code>
      </div>`,
    ),
    backend
      ? `<div class="token-row">
          <div class="token-head"><span class="member role-backend">后端（你）</span><span class="muted">你的审阅链接，可转发</span></div>
          <code class="token">${esc(backend.token)}</code>
        </div>`
      : '',
  ].join('');

  const enter = $('#enter-room');
  enter.href = `/room/${room.code}`;
  if (backend) {
    enter.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        saveToken(room.code, backend.token);
        location.href = `/room/${room.code}`;
      },
      { once: true },
    );
  }

  $('#copy-tokens').onclick = () => {
    const text = agents.map((t) => `${ROLE_LABEL[t.role] ?? t.role}（${t.seat}）：${t.token}`).join('\n');
    copyText(text);
  };

  const host = location.host;
  $('#created-cmd').textContent = agents
    .map(
      (t) =>
        `# ${ROLE_LABEL[t.role] ?? t.role}（入场券 ${t.seat}）\nexport NEG_TOKEN=${t.token}\ncodex mcp add room-${room.code.toLowerCase()}-${t.seat.toLowerCase()} --url http://${host}/mcp --bearer-token-env-var NEG_TOKEN`,
    )
    .join('\n\n');

  $('#created').hidden = false;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    alert('复制失败，请手动选中：' + text);
    return false;
  }
}

async function refreshRooms() {
  const list = $('#room-list');
  if (!list) return;
  try {
    const { rooms } = await api('/api/rooms');
    $('#room-count').textContent = `${rooms.length} 个`;
    if (!rooms.length) {
      list.innerHTML = '<p class="empty">还没有房间，上面建一个。</p>';
      return;
    }
    list.innerHTML = rooms
      .map(
        (r) => `
      <a class="room-item" href="/room/${encodeURIComponent(r.code)}">
        <div class="room-main">
          <div class="room-name">${esc(r.title)}</div>
          <div class="room-sub">
            <span class="mono">${esc(r.code)}</span>
            <span class="status ${r.status}">${esc(r.status_label)}</span>
            <span>${r.plan_count} 次提交</span>
          </div>
        </div>
        <div class="room-last">
          <div>${r.last_speaker ? esc(r.last_speaker) : '还没有发言'}</div>
          <div class="muted">${fmtTime(r.last_at)}</div>
        </div>
      </a>`,
      )
      .join('');
  } catch {
    list.innerHTML = '<p class="empty">房间列表加载失败，稍后自动重试。</p>';
  }
}

// ================= 房间页 =================

function initRoom(code) {
  const urlToken = takeUrlToken();
  if (urlToken) saveToken(code, urlToken);
  const state = {
    code,
    token: urlToken || loadToken(code),
    me: null,
    lastSeq: 0,
    rendered: new Set(),
    planVersion: null,
    selected: null,
    history: [],
    confirmations: [],
    room: null,
    loading: null,
  };

  const $messages = $('#messages');
  const $diff = $('#plan-diff');
  const $tree = $('#plan-tree');
  const $history = $('#plan-history');
  const $meta = $('#plan-meta');
  const $confirmSides = $('#confirm-sides');
  const $confirmActions = $('#confirm-actions');

  const canWrite = () => Boolean(state.me);
  const isHuman = () => Boolean(state.me && (state.me.role === 'frontend' || state.me.role === 'backend'));

  $('#composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#composer-input');
    const text = input.value.trim();
    if (!text) return;
    if (!canWrite()) {
      alert('你现在是只读状态，需要房间发给你一张入场券。');
      return;
    }
    try {
      await api(`/api/rooms/${encodeURIComponent(code)}/messages`, {
        method: 'POST',
        token: state.token,
        body: { text },
      });
      input.value = '';
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });

  $('#composer-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#send-btn').click();
    }
  });

  $$('[data-mention]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const input = $('#composer-input');
      const mention = btn.dataset.mention;
      const start = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, start)}${mention} ${input.value.slice(start)}`;
      input.focus();
      input.selectionStart = input.selectionEnd = start + mention.length + 1;
    }),
  );

  async function loadMe() {
    if (!state.token) return;
    try {
      const out = await api(`/api/rooms/${encodeURIComponent(code)}/whoami`, { token: state.token });
      state.me = out.me;
    } catch {
      state.me = null;
    }
    updateComposer();
  }

  function updateComposer() {
    const who = $('#as-who');
    const hint = $('#as-hint');
    const input = $('#composer-input');
    const sendBtn = $('#send-btn');
    if (state.me) {
      const name = state.me.name && state.me.name !== state.me.label ? ` · ${state.me.name}` : '';
      who.textContent = `以「${state.me.label}${name}」身份发言`;
      who.className = `as-who role-${state.me.role}`;
      hint.textContent = '';
      input.disabled = false;
      sendBtn.disabled = false;
    } else {
      who.textContent = '只读';
      hint.textContent = '向房间主人要一张入场券（链接里带 token），就能发言和确认。';
      input.disabled = true;
      sendBtn.disabled = true;
    }
  }

  async function refresh() {
    const { room, members, plan, history, confirmations, messages } = await api(
      `/api/rooms/${encodeURIComponent(code)}/snapshot?after_seq=${state.lastSeq}`,
    );
    state.room = room;
    state.history = history;
    state.confirmations = confirmations;

    document.title = `${room.title} · 接口协商室`;
    $('#room-title').textContent = room.title;
    $('#room-code').textContent = room.code;
    const statusEl = $('#room-status');
    statusEl.textContent = room.status_label;
    statusEl.className = `status ${room.status}`;

    $('#members').innerHTML = members
      .map((m) => {
        const label = ROLE_LABEL[m.role] ?? m.role;
        const name = m.name && m.name !== label ? ` · ${esc(m.name)}` : '';
        return `<span class="member role-${m.role}">${esc(label)}${name}</span>`;
      })
      .join('');

    const prd = $('#prd');
    prd.innerHTML = room.prd
      ? `<pre class="prd-text">${esc(room.prd)}</pre>${room.op_scope ? `<p class="muted">范围：${esc(room.op_scope)}</p>` : ''}`
      : `<p class="muted">没有填需求文档${room.op_scope ? `；范围：${esc(room.op_scope)}` : ''}。</p>`;

    appendMessages(messages);
    renderHistory(history);
    renderConfirm();
    renderPlanMeta(plan);
  }

  function appendMessages(messages) {
    if (!messages?.length) return;
    const nearBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 180;
    for (const m of messages) {
      if (state.rendered.has(m.seq)) continue;
      state.rendered.add(m.seq);
      state.lastSeq = Math.max(state.lastSeq, m.seq);
      const wrap = document.createElement('div');
      const kind = m.type === 'human' ? 'human' : m.type === 'proposal' ? 'proposal' : m.type === 'system' ? 'system' : '';
      wrap.className = `msg ${kind}`;
      const reply = m.reply_to ? `<span class="reply-anchor">↳ #${m.reply_to}</span>` : '';
      wrap.innerHTML = `
        <div class="msg-head">
          <span class="who">${esc(m.speaker)}</span>
          <span class="seq">#${m.seq}</span>
          <span class="time">${fmtTime(m.time)}</span>
        </div>
        <div class="bubble">${esc(m.body)}${reply}</div>`;
      $messages.appendChild(wrap);
    }
    if (nearBottom) $messages.scrollTop = $messages.scrollHeight;
  }

  function renderPlanMeta(plan) {
    if (!plan) {
      $meta.textContent = '还没有方案';
      $tree.innerHTML = '<p class="empty">还没有方案。设计方提交后出现在这里。</p>';
      $diff.innerHTML = '';
      return;
    }
    if (state.selected === null) state.selected = plan.version;
    $meta.innerHTML = `${esc(plan.author_label)} · ${fmtTime(plan.created_at)} · 改了 ${plan.changed} 处${
      plan.summary ? ` · ${esc(plan.summary)}` : ''
    }`;
    if (state.planVersion !== state.selected) loadPlan(state.selected);
  }

  async function loadPlan(version) {
    if (!version) return;
    state.loading = version;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(code)}/plan?version=${version}`);
      if (state.loading !== version) return;
      state.planVersion = version;
      renderTree(data.plan);
      renderDiff(data.diff);
      if (data.plan) {
        $meta.innerHTML = `${esc(data.plan.author_label)} · ${fmtTime(data.plan.created_at)} · 改了 ${data.plan.changed} 处${
          data.plan.summary ? ` · ${esc(data.plan.summary)}` : ''
        }`;
      }
      renderHistory(state.history);
    } catch {
      /* 下一轮再试 */
    } finally {
      if (state.loading === version) state.loading = null;
    }
  }

  function renderTree(plan) {
    if (!plan) {
      $tree.innerHTML = '<p class="empty">还没有方案。</p>';
      return;
    }
    const doc = plan.doc ?? {};
    const info = doc.info ?? {};
    const paths = doc.paths ?? {};
    const ops = [];
    for (const [path, item] of Object.entries(paths)) {
      if (!item || typeof item !== 'object') continue;
      for (const method of Object.keys(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
        ops.push({ path, method, op: item[method] ?? {} });
      }
    }
    const tree = ops
      .map(({ path, method, op }) => {
        const params = Array.isArray(op.parameters) ? op.parameters : [];
        const paramText = params
          .map((p) => `${p.in === 'path' ? '路径' : p.in === 'query' ? 'query' : p.in === 'header' ? 'header' : '参数'}: ${p.name ?? ''}`)
          .join('，');
        return `
        <div class="op">
          <span class="method m-${method}">${method.toUpperCase()}</span>
          <span class="path mono">${esc(path)}</span>
          <div class="op-summary">${esc(op.summary ?? '')}</div>
          ${paramText ? `<div class="op-params">${esc(paramText)}</div>` : ''}
        </div>`;
      })
      .join('');
    $tree.innerHTML = `
      <div class="plan-title">
        <strong>${esc(info.title ?? '接口方案')}</strong>
        <span class="badge mono">OpenAPI ${esc(info.version ?? doc.openapi ?? '')}</span>
        <span class="muted">${ops.length} 个接口</span>
      </div>
      ${tree || '<p class="empty">这份方案里还没有接口。</p>'}`;
  }

  function renderDiff(entries) {
    if (!entries?.length) {
      $diff.innerHTML = '<p class="empty">这一版是第一版，或者没有改动。</p>';
      $('#diff-meta').textContent = '';
      return;
    }
    $('#diff-meta').textContent = `共 ${entries.length} 处`;
    $diff.innerHTML = entries
      .map((e) => {
        const symbol = e.op === '+' ? '新增' : e.op === '-' ? '删除' : '修改';
        const label = e.label.length > 120 ? `${e.label.slice(0, 120)}…` : e.label;
        return `<div class="diff-line diff-${e.op}"><span class="diff-op">${symbol}</span><span class="diff-pointer mono">${esc(e.pointer)}</span><span class="diff-label">${esc(label)}</span></div>`;
      })
      .join('');
  }

  function renderHistory(history) {
    if (!history?.length) {
      $history.innerHTML = '';
      return;
    }
    $history.innerHTML = `
      <div class="history-head"><span>历史</span><span class="muted">共 ${history.length} 次提交</span></div>
      <div class="history-list">
        ${history
          .map(
            (h) => `
          <button class="history-item ${h.version === state.selected ? 'active' : ''}" data-version="${h.version}">
            <span>${fmtTime(h.created_at)}</span>
            <span class="muted">${esc(h.author_label)} · ${h.changed === 0 ? '初版' : `改 ${h.changed} 处`}</span>
          </button>`,
          )
          .join('')}
      </div>`;
    $$('[data-version]', $history).forEach((btn) =>
      btn.addEventListener('click', () => {
        state.selected = Number(btn.dataset.version);
        loadPlan(state.selected);
        renderHistory(state.history);
      }),
    );
  }

  function renderConfirm() {
    const sides = state.confirmations ?? [];
    $confirmSides.innerHTML = sides
      .map((c) => {
        const text =
          c.status === 'ok'
            ? `已确认${c.at ? ' · ' + fmtTime(c.at) : ''}`
            : c.status === 'issue'
              ? '有意见'
              : c.status === 'stale'
                ? '上次确认的是旧方案'
                : '还没看';
        return `<div class="confirm-chip ${c.status}">
          <span class="member role-${c.side}">${esc(c.label)}</span>
          <span class="confirm-text">${esc(text)}</span>
          ${c.note ? `<span class="muted note">「${esc(c.note)}」</span>` : ''}
        </div>`;
      })
      .join('');

    const actions = [];
    const hasPlan = (state.history?.length ?? 0) > 0;
    if (isHuman() && hasPlan) {
      const mine = sides.find((c) => c.side === state.me.role);
      const canOk = state.room.status !== 'closed' && mine?.status !== 'ok';
      actions.push(`<button type="button" class="primary" id="btn-ok" ${canOk ? '' : 'disabled'}>这版可以开发</button>`);
      actions.push(
        `<button type="button" class="ghost" id="btn-issue" ${state.room.status === 'closed' ? 'disabled' : ''}>有意见…</button>`,
      );
    }
    if (isHuman()) {
      const other = state.me.role === 'frontend' ? 'backend' : 'frontend';
      actions.push(`<button type="button" class="ghost" id="btn-invite">把${other === 'frontend' ? '前端' : '后端'}同事拉进来</button>`);
      if (state.room?.status !== 'closed') actions.push(`<button type="button" class="ghost danger" id="btn-close">关闭房间</button>`);
    }
    if (!isHuman()) {
      actions.push('<span class="muted">确认这一步由人来做：前端、后端各点一次。</span>');
    }
    $confirmActions.innerHTML = actions.join('');

    const okBtn = $('#btn-ok');
    if (okBtn)
      okBtn.onclick = async () => {
        try {
          await api(`/api/rooms/${encodeURIComponent(code)}/confirm`, {
            method: 'POST',
            token: state.token,
            body: { verdict: 'ok' },
          });
          await refresh();
        } catch (err) {
          alert(err.message);
        }
      };

    const issueBtn = $('#btn-issue');
    if (issueBtn)
      issueBtn.onclick = async () => {
        const note = prompt('有哪里不对？一句话说明，agent 会照着改：');
        if (!note) return;
        try {
          await api(`/api/rooms/${encodeURIComponent(code)}/confirm`, {
            method: 'POST',
            token: state.token,
            body: { verdict: 'issue', note },
          });
          await refresh();
        } catch (err) {
          alert(err.message);
        }
      };

    const inviteBtn = $('#btn-invite');
    if (inviteBtn)
      inviteBtn.onclick = async () => {
        const other = state.me.role === 'frontend' ? 'backend' : 'frontend';
        const name = prompt(`把${other === 'frontend' ? '前端' : '后端'}同事的名字填上（可留空）：`, '');
        if (name === null) return;
        try {
          const out = await api(`/api/rooms/${encodeURIComponent(code)}/invite`, {
            method: 'POST',
            token: state.token,
            body: { side: other, name: name || undefined },
          });
          const url = `${location.origin}${out.link}`;
          await copyText(url);
          alert(`链接已复制，发给对方：\n${url}`);
          await refresh();
        } catch (err) {
          alert(err.message);
        }
      };

    const closeBtn = $('#btn-close');
    if (closeBtn)
      closeBtn.onclick = async () => {
        if (!confirm('关闭后这个房间就不能再发言了，确定？')) return;
        try {
          await api(`/api/rooms/${encodeURIComponent(code)}/close`, { method: 'POST', token: state.token });
          await refresh();
        } catch (err) {
          alert(err.message);
        }
      };
  }

  (async () => {
    await loadMe();
    try {
      await refresh();
    } catch (err) {
      $messages.innerHTML = `<p class="empty">房间加载失败：${esc(err.message)}</p>`;
      return;
    }
    setInterval(() => {
      refresh().catch(() => {});
    }, 2500);
  })();
}

// ---------- 启动 ----------

if (location.pathname === '/legacy') initHome();
else {
  const m = location.pathname.match(/^\/room\/([A-Za-z0-9-]{3,32})$/);
  if (m) initRoom(m[1]);
}
