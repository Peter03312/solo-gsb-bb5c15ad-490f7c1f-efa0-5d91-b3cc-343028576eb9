'use strict';
/* 只读巡检页：展示已发布的巡检版快照，无任何编辑/删除入口。 */

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const RISK_COLORS = {
  '低风险': { fill: 'rgba(22,163,74,.15)', stroke: '#16a34a' },
  '中风险': { fill: 'rgba(217,119,6,.17)', stroke: '#d97706' },
  '高风险': { fill: 'rgba(220,38,38,.18)', stroke: '#dc2626' },
};

const query = new URLSearchParams(location.search);
const planId = query.get('plan');
const wantSeq = query.get('seq'); // null / 'latest' / 数字

const state = {
  planId,
  currentSeq: null,
  latestSeq: null,
  pub: null,
  transform: { scale: 1, tx: 0, ty: 0 },
  drag: null,
  // 巡检轮次
  rounds: [],            // 当前冻结版的轮次摘要
  activeRound: null,     // 打开中的轮次详情（逐区填写/只读查看）
  dirty: new Set(),      // 有未保存输入的区域编号（冲突/轮询时绝不覆盖）
  busy: false,           // 保存/完成请求进行中（暂停轮询）
  pollTimer: null,
};

const RESULT_COLORS = {
  '正常': { fill: 'rgba(22,163,74,.22)', stroke: '#15803d' },
  '隐患': { fill: 'rgba(220,38,38,.28)', stroke: '#b91c1c' },
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pointsStr(verts) { return verts.map((p) => `${p.x},${p.y}`).join(' '); }
function centroid(verts) {
  let x = 0, y = 0;
  for (const p of verts) { x += p.x; y += p.y; }
  return { x: x / verts.length, y: y / verts.length };
}

async function apiGet(url) {
  const res = await fetch(url);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 无响应体 */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败：HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

function showEmpty(message, isError) {
  $('inspEmpty').classList.remove('hidden');
  $('inspEmpty').querySelector('h2').textContent = isError ? '巡检版无法显示' : '暂无巡检版';
  $('inspEmptyText').textContent = message;
}

/* ------------------------------ 加载与渲染 ------------------------------ */

async function init() {
  if (!planId || !/^\d+$/.test(String(planId))) {
    $('inspTitle').textContent = '参数错误';
    showEmpty('链接缺少有效的图纸 id（需要 ?plan=<图纸ID>，可选 &seq=<发布序号>）。', true);
    return;
  }

  // 先取发布列表：用于版本下拉与「暂无巡检版」的明确提示
  let list;
  try {
    list = await apiGet(`/api/plans/${planId}/publications`);
  } catch (err) {
    $('inspTitle').textContent = '加载失败';
    showEmpty(err.message, true);
    return;
  }

  buildSwitcher(list);

  if (!list.count) {
    $('inspTitle').textContent = list.plan_name || '图纸';
    showEmpty(`图纸「${list.plan_name}」还没有发布过巡检版。`, false);
    return;
  }

  let seq;
  if (wantSeq && wantSeq !== 'latest') {
    seq = Number(wantSeq);
    if (!Number.isInteger(seq) || seq < 1) {
      showEmpty(`发布序号无效：${esc(wantSeq)}（应为正整数或留空查看最新版）。`, true);
      return;
    }
  } else {
    seq = list.latest_seq;
  }

  try {
    await loadPublication(seq);
  } catch (err) {
    if (err.code === 'NO_PUBLICATION') {
      showEmpty(err.message, false);
    } else {
      showEmpty(err.message, true);
    }
    return;
  }

  // 深链：?round=<轮次id> 直接打开指定轮次（可为其他发布版的历史轮次）
  const wantRound = query.get('round');
  if (wantRound && /^\d+$/.test(wantRound)) {
    openRound(Number(wantRound)).catch((err) => toast2(err.message, true));
  }
}

function buildSwitcher(list) {
  const sel = $('inspSeqSelect');
  sel.innerHTML = '';
  state.latestSeq = list.latest_seq;
  for (const p of list.publications) {
    const opt = document.createElement('option');
    opt.value = p.seq;
    opt.textContent = `第 ${p.seq} 号 · 图纸 v${p.plan_version} · ${p.region_count} 区 · ${p.published_at}`;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    const s = Number(sel.value);
    if (state.dirty.size &&
        !confirm('当前轮次有未保存的填写内容，切换巡检版不会自动保存，确定切换吗？')) {
      sel.value = String(state.currentSeq);
      return;
    }
    stopPolling();
    state.activeRound = null;
    state.dirty = new Set();
    setBanner('');
    const url = new URL(location.href);
    url.searchParams.set('seq', s);
    url.searchParams.delete('round');
    history.replaceState(null, '', url);
    loadPublication(s).catch((err) => showEmpty(err.message, err.code !== 'NO_PUBLICATION'));
  });
  $('inspLatestLink').href = `/inspector.html?plan=${planId}`;
  $('inspSwitchHint').textContent = list.count
    ? `共发布 ${list.count} 个巡检版，默认打开最新版（第 ${list.latest_seq} 号）。`
    : '';
}

async function loadPublication(seq) {
  const data = await apiGet(`/api/plans/${planId}/publications/${seq}`);
  const pub = data.publication;
  state.pub = pub;
  state.currentSeq = pub.seq;
  $('inspEmpty').classList.add('hidden');
  $('inspSeqSelect').value = String(pub.seq);

  $('inspTitle').textContent = pub.plan_name;
  const isLatest = pub.seq === state.latestSeq;
  $('inspBadges').innerHTML = `
    <span class="badge">巡检版 #${pub.seq}${isLatest ? '（最新）' : '（历史版）'}</span>
    <span class="badge">所见图纸版本 v${pub.plan_version}</span>
    <span class="badge">${pub.width} × ${pub.height} px</span>
    <span class="badge">${pub.region_count} 个区域</span>`;
  $('inspApiLink').href = `/api/plans/${planId}/publications/${pub.seq}`;
  $('inspSeqStatus').textContent =
    `第 ${pub.seq} 号巡检版 · 发布于 ${pub.published_at}${isLatest ? ' · 最新版' : ''}`;
  $('inspCount').textContent = `（${pub.regions.length}）`;

  renderImage(pub);
  renderRegions(pub);
  renderRegionList(pub);
  fitView();
  await loadRounds();
}

function renderImage(pub) {
  const img = $('inspImage');
  const url = `/api/plans/${planId}/publications/${pub.seq}/image`;
  img.setAttribute('href', url);
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
  img.setAttribute('width', pub.width);
  img.setAttribute('height', pub.height);
  $('inspBg').setAttribute('width', pub.width);
  $('inspBg').setAttribute('height', pub.height);
}

function renderRegions(pub) {
  const layer = $('inspRegionLayer');
  layer.innerHTML = '';
  // 打开轮次时，按逐区结论覆盖填色（正常=绿，隐患=红，未填=冻结原色）
  const byCode = state.activeRound
    ? new Map(state.activeRound.regions.map((r) => [r.code, r]))
    : null;
  for (const r of pub.regions) {
    const base = RISK_COLORS[r.risk_level] || { fill: 'rgba(107,114,128,.15)', stroke: '#6b7280' };
    let c = base;
    let suffix = '';
    if (byCode) {
      const rec = byCode.get(r.code);
      if (rec && rec.result) {
        c = RESULT_COLORS[rec.result] || c;
        suffix = ` · ${rec.result}`;
      }
    }
    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', pointsStr(r.vertices));
    poly.setAttribute('fill', c.fill);
    poly.setAttribute('stroke', c.stroke);
    poly.setAttribute('class', 'polygon-region inspector-poly');
    layer.appendChild(poly);

    const ctr = centroid(r.vertices);
    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('x', ctr.x);
    label.setAttribute('y', ctr.y);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('class', 'poly-label');
    label.textContent = `${r.code} · ${r.risk_level}${suffix}`;
    layer.appendChild(label);
  }
}

function renderRegionList(pub) {
  const ul = $('inspRegionList');
  ul.innerHTML = '';
  if (!pub.regions.length) {
    const li = document.createElement('li');
    li.classList.add('muted');
    li.textContent = '发布时该图纸没有任何区域';
    ul.appendChild(li);
    return;
  }
  for (const r of pub.regions) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="risk-dot ${esc(r.risk_level)}"></span>
      <span class="r-code">${esc(r.code)}</span>
      <span class="muted">${esc(r.risk_level)}</span>`;
    ul.appendChild(li);
  }
}

/* ------------------------------- 视口交互 ------------------------------- */

const svg = $('inspSvg');

function applyTransform() {
  const t = state.transform;
  $('inspViewport').setAttribute('transform',
    `translate(${t.tx} ${t.ty}) scale(${t.scale})`);
  $('inspZoomLevel').textContent = `缩放 ${Math.round(t.scale * 100)}%`;
}

function fitView() {
  const pub = state.pub;
  if (!pub) return;
  const rect = svg.getBoundingClientRect();
  const pad = 40;
  const s = Math.min(
    (rect.width - pad * 2) / pub.width,
    (rect.height - pad * 2) / pub.height
  );
  state.transform.scale = Math.min(8, Math.max(0.05, s));
  state.transform.tx = (rect.width - pub.width * state.transform.scale) / 2;
  state.transform.ty = (rect.height - pub.height * state.transform.scale) / 2;
  applyTransform();
}

svg.addEventListener('wheel', (e) => {
  if (!state.pub) return;
  e.preventDefault();
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const t = state.transform;
  const ns = Math.min(20, Math.max(0.05, t.scale * Math.exp(-e.deltaY * 0.0015)));
  const f = ns / t.scale;
  t.tx = mx - (mx - t.tx) * f;
  t.ty = my - (my - t.ty) * f;
  t.scale = ns;
  applyTransform();
}, { passive: false });

svg.addEventListener('mousedown', (e) => {
  if (!state.pub || e.button !== 0) return;
  state.drag = { x: e.clientX, y: e.clientY };
  svg.classList.add('panning');
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  const d = state.drag;
  if (!d) return;
  state.transform.tx += e.clientX - d.x;
  state.transform.ty += e.clientY - d.y;
  d.x = e.clientX;
  d.y = e.clientY;
  applyTransform();
});
window.addEventListener('mouseup', () => {
  state.drag = null;
  svg.classList.remove('panning');
});
svg.addEventListener('dblclick', fitView);
window.addEventListener('resize', () => state.pub && applyTransform());

/* ====================== 巡检轮次：发起 / 逐区填写 / 完成 / 历史 ====================== */

function toast2(message, isError, ms = 3800) {
  let box = $('inspToasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'inspToasts';
    box.className = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${isError ? 'err' : 'ok'}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms);
  setTimeout(() => el.remove(), ms + 400);
}

function setBanner(html, isError, actionsHtml) {
  const b = $('roundBanner');
  if (!html) { b.classList.add('hidden'); b.innerHTML = ''; return; }
  b.classList.remove('hidden');
  b.classList.toggle('banner-error', !!isError);
  b.innerHTML = html + (actionsHtml ? `<div class="banner-actions">${actionsHtml}</div>` : '');
}

const statusText = (s) => (s === 'completed'
  ? '已完成（只读）' : '进行中');

/* ------------------------------- 轮次列表 ------------------------------- */

async function loadRounds() {
  if (!state.pub) return;
  let data;
  try {
    data = await apiGet(`/api/plans/${planId}/publications/${state.pub.seq}/rounds`);
  } catch (err) {
    $('roundsHint').textContent = '轮次列表加载失败：' + err.message;
    return;
  }
  state.rounds = data.rounds || [];
  renderRoundsList();

  const startBtn = $('btnStartRound');
  if (state.pub.region_count < 1) {
    startBtn.disabled = true;
    startBtn.title = '该巡检版冻结时没有任何区域，空区域巡检版不可发起巡检';
    $('roundsHint').textContent = '该巡检版冻结时没有任何区域，不可发起巡检。';
  } else {
    startBtn.disabled = false;
    startBtn.title = '';
  }

  // 若打开的轮次属于当前版，同步其摘要状态
  if (state.activeRound) {
    const sum = state.rounds.find((r) => r.id === state.activeRound.id);
    if (sum && sum.status === 'completed' && state.activeRound.status !== 'completed') {
      // 他人刚完成：拉取最新只读详情
      refreshActiveRound();
    }
  }
}

function renderRoundsList() {
  const ul = $('roundList');
  const empty = $('roundEmpty');
  ul.innerHTML = '';
  $('roundsCount').textContent = state.rounds.length ? `（${state.rounds.length} 轮）` : '';
  empty.classList.toggle('hidden', state.rounds.length > 0);
  empty.textContent = '本版还没有巡检轮次，点击「发起一轮巡检」开始。';
  for (const r of state.rounds) {
    const li = document.createElement('li');
    const active = state.activeRound && state.activeRound.id === r.id;
    if (active) li.classList.add('active');
    const pct = r.region_count ? Math.round(r.filled_count / r.region_count * 100) : 0;
    li.innerHTML = `
      <span class="round-seq">第 ${r.seq} 轮</span>
      <span class="round-info">
        <span class="round-state ${r.status}">${statusText(r.status)}</span>
        <span class="muted">${r.filled_count}/${r.region_count} 区 · 隐患 ${r.hazard_count}</span>
        <span class="progress"><span class="progress-bar" style="width:${pct}%"></span></span>
        <span class="pub-meta">${esc(r.started_at || '')}${r.completed_at ? ' · 完成 ' + esc(r.completed_at) : ''}</span>
      </span>
      <span class="pub-actions"></span>`;
    const actions = li.querySelector('.pub-actions');
    const openBtn = document.createElement('button');
    openBtn.className = 'btn';
    openBtn.textContent = r.status === 'completed' ? '查看结果' : (active ? '填写中' : '继续填写');
    openBtn.disabled = !!active;
    openBtn.onclick = () => openRound(r.id);
    actions.appendChild(openBtn);
    ul.appendChild(li);
  }
}

/* ------------------------------- 发起轮次 ------------------------------- */

$('btnStartRound').addEventListener('click', async () => {
  if (!state.pub || state.pub.region_count < 1) return;
  if (state.dirty.size &&
      !confirm('当前轮次有未保存内容，发起新一轮不会自动保存，确定吗？')) return;
  const btn = $('btnStartRound');
  btn.disabled = true;
  try {
    const data = await apiSend('POST',
      `/api/plans/${planId}/publications/${state.pub.seq}/rounds`);
    toast2(data.message || '已发起新一轮巡检');
    await loadRounds();
    await openRound(data.round.id);
  } catch (err) {
    toast2(err.message, true, 6000);
  } finally {
    btn.disabled = state.pub && state.pub.region_count < 1;
  }
});

$('btnExitRound').addEventListener('click', () => exitRound(true));

$('btnAllRounds').addEventListener('click', async () => {
  let data;
  try {
    data = await apiGet(`/api/plans/${planId}/rounds`);
  } catch (err) { toast2(err.message, true); return; }
  if (!data.count) { toast2('该图纸所有巡检版都还没有巡检轮次'); return; }
  const lines = data.rounds.map((r) =>
    `第 ${r.publication_seq} 号巡检版 · 第 ${r.seq} 轮 · ${statusText(r.status)} · ` +
    `${r.filled_count}/${r.region_count} 区 · 隐患 ${r.hazard_count}`);
  const picked = window.prompt(
    `该图纸共 ${data.count} 个轮次（最新在前）：\n\n${lines.join('\n')}\n\n` +
    `输入要打开的轮次 ID（左侧 # 数字即轮次 ID）：`);
  if (picked && /^\d+$/.test(picked.trim())) {
    openRound(Number(picked.trim())).catch((err) => toast2(err.message, true, 6000));
  }
});

async function apiSend(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 无响应体 */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败：HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.error;
    err.data = data;
    throw err;
  }
  return data;
}

/* ----------------------------- 打开 / 退出轮次 ----------------------------- */

async function openRound(roundId) {
  let data;
  try {
    data = await apiGet(`/api/rounds/${roundId}`);
  } catch (err) {
    toast2(err.message, true, 6000);
    throw err;
  }
  const round = data.round;
  // 轮次属于其他发布版时，切到该冻结版（冻结区域与结果才能对齐渲染）
  if (!state.pub || state.pub.id !== round.publication_id) {
    if (state.dirty.size &&
        !confirm('当前轮次有未保存内容，切换巡检版不会自动保存，确定吗？')) return;
    try {
      await loadPublication(round.publication_seq);
    } catch (err) { toast2(err.message, true, 6000); return; }
    $('inspSeqSelect').value = String(round.publication_seq);
    const url = new URL(location.href);
    url.searchParams.set('seq', round.publication_seq);
    url.searchParams.set('round', round.id);
    history.replaceState(null, '', url);
    // loadRounds 由 loadPublication 触发，确保轮次列表已是该版
  } else {
    const url = new URL(location.href);
    url.searchParams.set('round', round.id);
    history.replaceState(null, '', url);
  }
  state.activeRound = round;
  state.dirty = new Set();
  setBanner('');
  renderRoundWorkspace();
  renderRegions(state.pub);
  renderRoundsList();
  startPolling();
}

function exitRound(updateUrl) {
  stopPolling();
  state.activeRound = null;
  state.dirty = new Set();
  setBanner('');
  $('roundWorkspace').classList.add('hidden');
  if (state.pub) renderRegions(state.pub);
  renderRoundsList();
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.delete('round');
    history.replaceState(null, '', url);
  }
}

/* ----------------------------- 轮次填写工作区 ----------------------------- */

function renderRoundWorkspace() {
  const round = state.activeRound;
  if (!round) return;
  const ws = $('roundWorkspace');
  ws.classList.remove('hidden');
  const closed = round.status === 'completed';
  $('roundWsTitle').innerHTML =
    `<strong>第 ${round.seq} 轮巡检</strong>` +
    `<span class="round-state ${round.status}">${statusText(round.status)}</span>`;
  $('roundWsBadges').innerHTML = `
    <span class="badge">巡检版 #${round.publication_seq}</span>
    <span class="badge">轮次版本 r${round.version}</span>
    <span class="badge">进度 ${round.filled_count}/${round.region_count}</span>
    <span class="badge">隐患 ${round.hazard_count}</span>`;
  $('roundWsStatus').textContent = closed
    ? `本轮已于 ${round.completed_at || ''} 完成，结果与冻结区域均为只读。`
    : '每区选择结论后点「保存本区」；保存携带当前轮次版本，他人先修改会收到冲突且不覆盖你的输入。';
  $('btnCompleteRound').disabled = closed;
  $('btnCompleteRound').textContent = closed
    ? '本轮已完成（只读）'
    : `✓ 完成本轮巡检（${round.filled_count}/${round.region_count}）`;
  renderEntryList();
  ws.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderEntryList() {
  const round = state.activeRound;
  const ul = $('roundEntryList');
  ul.innerHTML = '';
  const closed = round.status === 'completed';
  for (const r of round.regions) {
    // 未保存的本地输入优先于服务端值：轮询/他人更新触发重渲染时绝不覆盖用户正在填写的内容
    const isDirty = state.dirty.has(r.code);
    const picked = isDirty && r.__pick !== undefined ? r.__pick : r.result;
    const noteVal = isDirty && r.__note !== undefined ? r.__note : (r.note || '');
    const li = document.createElement('li');
    li.dataset.code = r.code;
    li.innerHTML = `
      <div class="entry-head">
        <span class="risk-dot ${esc(r.risk_level)}"></span>
        <span class="r-code">${esc(r.code)}</span>
        <span class="muted">${esc(r.risk_level)}</span>
        <span class="entry-state" data-role="state"></span>
      </div>
      <div class="entry-controls" data-role="controls"></div>`;
    const controls = li.querySelector('[data-role=controls]');
    const stateEl = li.querySelector('[data-role=state]');

    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const val of ['正常', '隐患']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (picked === val ? ' on result-' + val : '');
      b.textContent = val;
      b.disabled = closed;
      b.onclick = () => {
        r.__pick = val;
        markDirty(r.code);
        paintEntry(li, r, val);
      };
      seg.appendChild(b);
    }
    controls.appendChild(seg);

    const note = document.createElement('textarea');
    note.className = 'entry-note';
    note.rows = 2;
    note.maxLength = 2000;
    note.placeholder = picked === '隐患' ? '隐患描述（必填）' : '备注（可选）';
    note.value = noteVal;
    note.disabled = closed;
    note.oninput = () => {
      r.__note = note.value;
      markDirty(r.code);
      paintEntry(li, r, r.__pick !== undefined ? r.__pick : r.result, note);
    };
    controls.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm primary';
    saveBtn.textContent = '保存本区';
    saveBtn.disabled = closed;
    saveBtn.onclick = () => saveEntry(r.code, li);
    const savedAt = document.createElement('span');
    savedAt.className = 'muted entry-saved';
    savedAt.textContent = r.updated_at ? `已保存 ${r.updated_at}` : '未保存';
    actions.append(saveBtn, savedAt);
    controls.appendChild(actions);

    ul.appendChild(li);
    paintEntry(li, r, picked, note, stateEl);
  }
}

function paintEntry(li, r, picked, noteEl, stateEl) {
  const note = noteEl || li.querySelector('.entry-note');
  const st = stateEl || li.querySelector('[data-role=state]');
  const cur = picked || r.result;
  li.classList.toggle('is-hazard', cur === '隐患');
  li.classList.toggle('is-ok', cur === '正常');
  li.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('on', b.textContent === cur);
    b.classList.toggle('result-正常', b.textContent === '正常' && b.textContent === cur);
    b.classList.toggle('result-隐患', b.textContent === '隐患' && b.textContent === cur);
  });
  if (state.dirty.has(r.code)) {
    st.textContent = '● 未保存';
    st.className = 'entry-state unsaved';
  } else if (r.result) {
    st.textContent = `✓ ${r.result}`;
    st.className = 'entry-state saved result-' + r.result;
  } else {
    st.textContent = '待填写';
    st.className = 'entry-state muted2';
  }
}

function markDirty(code) {
  state.dirty.add(code);
  renderRoundsList();
  const btn = $('btnCompleteRound');
  if (!btn.disabled) {
    btn.textContent = `✓ 完成本轮巡检（${state.activeRound.filled_count}/${state.activeRound.region_count}，有未保存内容）`;
  }
}

async function saveEntry(code, li) {
  const round = state.activeRound;
  if (!round || round.status === 'completed' || state.busy) return;
  const rec = round.regions.find((x) => x.code === code);
  const result = rec.__pick || rec.result;
  const note = (rec.__note !== undefined ? rec.__note : rec.note) || '';
  if (!result) { toast2(`区域「${code}」请先选择结论（正常/隐患）`, true); return; }
  if (result === '隐患' && !note.trim()) {
    toast2(`区域「${code}」结论为隐患，必须填写非空备注`, true, 5000);
    li.classList.add('entry-invalid');
    setTimeout(() => li.classList.remove('entry-invalid'), 1600);
    return;
  }
  state.busy = true;
  try {
    const data = await apiSend('PUT', `/api/rounds/${round.id}/records`, {
      region_code: code, result, note: note.trim(), version: round.version,
    });
    state.activeRound = data.round;
    state.dirty.delete(code);
    renderRoundWorkspace();
    renderRegions(state.pub);
    renderRoundsList();
    toast2(`区域「${code}」已保存（${result}）`);
  } catch (err) {
    handleRoundError(err, code);
  } finally {
    state.busy = false;
  }
}

$('btnCompleteRound').addEventListener('click', async () => {
  const round = state.activeRound;
  if (!round || round.status === 'completed' || state.busy) return;
  if (state.dirty.size) {
    toast2(`还有 ${state.dirty.size} 个区域改了但未保存，请先逐区保存再完成`, true, 5000);
    return;
  }
  const missing = round.regions.filter((r) => !r.result).map((r) => r.code);
  if (missing.length) {
    toast2(`仍有 ${missing.length} 个区域未填写：${missing.slice(0, 5).join('、')}`, true, 5000);
    return;
  }
  if (!confirm(`将完成第 ${round.seq} 轮巡检（${round.region_count} 区，隐患 ${round.hazard_count} 处）。\n完成后轮次与结果只读，确定吗？`)) {
    return;
  }
  state.busy = true;
  try {
    const data = await apiSend('POST', `/api/rounds/${round.id}/complete`,
      { version: round.version });
    state.activeRound = data.round;
    state.dirty = new Set();
    renderRoundWorkspace();
    renderRegions(state.pub);
    renderRoundsList();
    setBanner('');
    toast2(data.message || '本轮巡检已完成，结果已锁定为只读', false, 5000);
    stopPolling();
  } catch (err) {
    handleRoundError(err);
  } finally {
    state.busy = false;
  }
});

/**
 * 冲突/状态错误统一处理：
 *  - 409 ROUND_VERSION_CONFLICT / ROUND_INCOMPLETE / ROUND_CLOSED：
 *    用服务器最新状态同步其他区域，用户正在填写（dirty）的内容原样保留；
 *  - 404 UNKNOWN_REGION / 400 校验错误：提示，不写任何内容。
 */
function handleRoundError(err, code) {
  const serverRound = err.data && err.data.server && err.data.server.round;
  if (err.status === 409 && serverRound) {
    const wasClosed = serverRound.status === 'completed';
    // 用服务端最新状态整体替换，但 dirty 区的本地输入（__pick/__note）原样带回，不覆盖
    state.activeRound = mergeServerRound(state.activeRound, serverRound);
    renderRoundWorkspace();
    renderRegions(state.pub);
    renderRoundsList();
    const actions = code
      ? `<button class="btn btn-sm" id="bannerReload">用他人结果覆盖本区（将放弃未保存输入）</button>` : '';
    setBanner(`<strong>${err.code === 'ROUND_CLOSED' ? '轮次已关闭' : '版本冲突 / 无法完成'}</strong><br>${esc(err.message)}`,
      true, actions);
    const rb = $('bannerReload');
    if (rb) {
      rb.onclick = () => {
        state.dirty.delete(code);
        const local = state.activeRound.regions.find((x) => x.code === code);
        if (local) { delete local.__pick; delete local.__note; }
        renderRoundWorkspace();
        renderRegions(state.pub);
        setBanner('');
      };
    }
    if (wasClosed) stopPolling();
  } else {
    toast2(err.message, true, 6000);
  }
}

/** 用服务端最新轮次更新状态，但把 dirty 区的本地输入暂存回新对象 */
function mergeServerRound(oldRound, serverRound) {
  if (!oldRound) return serverRound;
  for (const nr of serverRound.regions) {
    const local = oldRound.regions.find((x) => x.code === nr.code);
    if (local && state.dirty.has(nr.code)) {
      nr.__pick = local.__pick;
      nr.__note = local.__note;
    }
  }
  return serverRound;
}

/* ------------------------------- 轻量轮询 ------------------------------- */

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (!state.activeRound || state.busy) return;
    if (document.visibilityState === 'hidden') return;
    refreshActiveRound();
  }, 4000);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function refreshActiveRound() {
  const cur = state.activeRound;
  if (!cur) return;
  let data;
  try {
    data = await apiGet(`/api/rounds/${cur.id}`);
  } catch (_) { return; }
  const srv = data.round;
  if (srv.version === cur.version && srv.status === cur.status) return;
  state.activeRound = mergeServerRound(cur, srv);
  renderRoundWorkspace();
  renderRegions(state.pub);
  renderRoundsList();
  if (srv.status === 'completed' && cur.status !== 'completed') {
    stopPolling();
    toast2('本轮巡检已被他人完成，结果已锁定为只读', false, 5000);
  } else if (state.dirty.size === 0) {
    setBanner('');
  }
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty.size) { e.preventDefault(); e.returnValue = ''; }
});

init();
