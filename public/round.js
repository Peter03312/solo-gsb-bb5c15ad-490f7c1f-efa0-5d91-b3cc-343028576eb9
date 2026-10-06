'use strict';
/* 巡检轮次页：基于已发布巡检版的冻结区域逐区填写「正常/隐患」；完成后只读。 */

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const RESULT_COLORS = {
  '正常': { fill: 'rgba(22,163,74,.18)', stroke: '#16a34a' },
  '隐患': { fill: 'rgba(220,38,38,.22)', stroke: '#dc2626' },
};
const EMPTY_COLOR = { fill: 'rgba(107,114,128,.08)', stroke: '#9ca3af' };

const query = new URLSearchParams(location.search);
const planId = query.get('plan');
const roundIdRaw = query.get('round');

const state = {
  detail: null,           // 服务端轮次详情 {round, publication, regions}
  version: null,          // 当前服务端轮次版本（乐观锁基准）
  dirty: new Map(),       // code -> {conclusion, remark} 未提交编辑，刷新/冲突后仍保留
  selectedCode: null,
  transform: { scale: 1, tx: 0, ty: 0 },
  drag: null,
};

/* ------------------------------- 基础工具 ------------------------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pointsStr(verts) { return verts.map((p) => `${p.x},${p.y}`).join(' '); }
function centroid(verts) {
  let x = 0, y = 0;
  for (const p of verts) { x += p.x; y += p.y; }
  return { x: x / verts.length, y: y / verts.length };
}

async function api(method, url, body) {
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

function toast(message, kind = 'info', ms = 3400) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms);
  setTimeout(() => el.remove(), ms + 400);
}

function showEmpty(message, title = '轮次无法显示') {
  $('rdEmpty').classList.remove('hidden');
  $('rdEmptyTitle').textContent = title;
  $('rdEmptyText').textContent = message;
}

/* ------------------------------- 初始化加载 ------------------------------- */

async function init() {
  if (!planId || !/^\d+$/.test(String(planId))) {
    $('rdTitle').textContent = '参数错误';
    showEmpty('链接缺少有效的图纸 id（需要 ?plan=<图纸ID>&round=<轮次ID>）。');
    return;
  }
  if (!roundIdRaw || !/^\d+$/.test(String(roundIdRaw))) {
    $('rdTitle').textContent = '参数错误';
    showEmpty('链接缺少有效的轮次 id（需要 ?plan=<图纸ID>&round=<轮次ID>）。');
    return;
  }
  try {
    const detail = await api('GET', `/api/plans/${planId}/rounds/${roundIdRaw}`);
    applyServer(detail, { preserveDirty: false });
  } catch (err) {
    $('rdTitle').textContent = '加载失败';
    showEmpty(err.message);
  }
}

const isCompleted = () => state.detail && state.detail.round.status === 'completed';

/* 用服务端最新轮次详情刷新整体界面；默认保留未提交的本地编辑 */
function applyServer(detail, { preserveDirty = true } = {}) {
  state.detail = detail;
  state.version = detail.round.version;
  $('rdEmpty').classList.add('hidden');

  const { round, publication } = detail;
  $('rdTitle').textContent = `${publication.plan_name} · 第 ${publication.seq} 号发布版 · 第 ${round.seq} 轮`;
  $('rdBack').href = `/inspector.html?plan=${planId}&seq=${publication.seq}`;
  $('rdStatus').textContent =
    `发布版 #${publication.seq} · 第 ${round.seq} 轮 · ${round.status === 'completed' ? '已完成（只读）' : '进行中'}`;

  const statusBadge = round.status === 'completed'
    ? '<span class="badge badge-done">✅ 已完成（只读）</span>'
    : '<span class="badge badge-live">🚧 进行中</span>';
  $('rdBadges').innerHTML = `
    <span class="badge">所属图纸：${esc(publication.plan_name)}</span>
    <span class="badge">发布版 #${publication.seq}</span>
    <span class="badge">冻结自图纸 v${publication.plan_version}</span>
    <span class="badge">第 ${round.seq} 轮</span>
    <span class="badge">轮次版本 v${round.version}</span>
    ${statusBadge}`;
  if (round.inspector) {
    $('rdBadges').innerHTML += `<span class="badge">巡检人：${esc(round.inspector)}</span>`;
  }

  // 进度
  const total = publication.region_count;
  const pct = total ? Math.round(round.filled_count / total * 100) : 0;
  $('rdProgressWrap').innerHTML = `
    <div class="round-progress-text">
      巡检进度 <strong>${round.filled_count}/${total}</strong>（${pct}%）
      <span class="muted">正常 ${round.normal_count} · 隐患 ${round.hazard_count}</span>
    </div>
    <div class="round-progress-bar"><div class="round-progress-inner" style="width:${pct}%"></div></div>
    ${round.completed_at ? `<p class="muted" style="margin:4px 0 0">完成时间：${esc(round.completed_at)}</p>` : ''}`;

  $('rdEditingSection').hidden = round.status === 'completed';
  $('rdDoneSection').hidden = round.status !== 'completed';
  if (round.status === 'completed') {
    $('rdDoneText').textContent =
      `共 ${total} 个区域：正常 ${round.normal_count} 个，隐患 ${round.hazard_count} 个。完成时间 ${round.completed_at}。`;
  }

  $('rdActions').innerHTML = `
    <a class="btn header-btn" href="/api/plans/${planId}/rounds/${round.id}" target="_blank" rel="noopener">轮次 JSON</a>
    <a class="btn header-btn" href="/inspector.html?plan=${planId}&seq=${publication.seq}">返回巡检版</a>`;

  renderImage();
  renderPolygons();
  renderRegionCards(preserveDirty);
  fitView();
}

/* ------------------------------- 冻结画布 ------------------------------- */

function renderImage() {
  const pub = state.detail.publication;
  const url = `/api/plans/${planId}/publications/${pub.seq}/image`;
  const img = $('rdImage');
  img.setAttribute('href', url);
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
  img.setAttribute('width', pub.width);
  img.setAttribute('height', pub.height);
  $('rdBg').setAttribute('width', pub.width);
  $('rdBg').setAttribute('height', pub.height);
}

function renderPolygons() {
  const layer = $('rdRegionLayer');
  layer.innerHTML = '';
  for (const item of state.detail.regions) {
    const local = state.dirty.get(item.code);
    const conclusion = local ? local.conclusion : (item.result && item.result.conclusion);
    const c = RESULT_COLORS[conclusion] || EMPTY_COLOR;
    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', pointsStr(item.vertices));
    poly.setAttribute('fill', c.fill);
    poly.setAttribute('stroke', c.stroke);
    poly.setAttribute('class', 'polygon-region inspector-poly round-poly' +
      (state.selectedCode === item.code ? ' selected' : ''));
    poly.dataset.code = item.code;
    poly.addEventListener('click', () => selectCard(item.code));
    layer.appendChild(poly);

    const ctr = centroid(item.vertices);
    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('x', ctr.x);
    label.setAttribute('y', ctr.y);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('class', 'poly-label');
    label.textContent = conclusion ? `${item.code} · ${conclusion}` : item.code;
    layer.appendChild(label);
  }
}

/* ------------------------------- 逐区卡片 ------------------------------- */

function renderRegionCards(preserveDirty) {
  const ul = $('rdRegionList');
  ul.innerHTML = '';
  const total = state.detail.regions.length;
  $('rdCount').textContent = `（${state.detail.round.filled_count}/${total}）`;

  for (const item of state.detail.regions) {
    const saved = item.result;
    // 未提交的本地编辑优先；服务端值兜底
    const local = state.dirty.get(item.code);
    const conclusion = local ? local.conclusion : (saved && saved.conclusion) || '';
    const remark = local ? local.remark : (saved && saved.remark) || '';

    const li = document.createElement('li');
    li.className = 'round-card' + (saved ? ' filled' : '') +
      (conclusion === '隐患' ? ' hazard' : conclusion === '正常' ? ' normal' : '');
    li.dataset.code = item.code;
    li.innerHTML = `
      <div class="round-card-head">
        <span class="round-code">${esc(item.code)}</span>
        <span class="muted">${esc(item.risk_level)}</span>
        <span class="round-card-status"></span>
      </div>
      <div class="round-field" data-field="conclusion">
        <label><input type="radio" name="conc-${encodeURIComponent(item.code)}" value="正常"> 正常</label>
        <label><input type="radio" name="conc-${encodeURIComponent(item.code)}" value="隐患"> 隐患</label>
      </div>
      <textarea class="round-remark" maxlength="1000" rows="2"
        placeholder="备注（选填；结论为隐患时必填）">${esc(remark)}</textarea>
      <div class="round-card-foot">
        <span class="round-card-msg"></span>
        <span class="round-card-actions"></span>
      </div>`;

    const radios = li.querySelectorAll('input[type=radio]');
    const textarea = li.querySelector('.round-remark');
    const msg = li.querySelector('.round-card-msg');
    const actions = li.querySelector('.round-card-actions');
    const statusEl = li.querySelector('.round-card-status');

    for (const r of radios) if (r.value === conclusion) r.checked = true;
    const readOnly = isCompleted();
    for (const r of radios) r.disabled = readOnly;
    textarea.readOnly = readOnly;
    if (readOnly) {
      statusEl.textContent = saved ? `已记录：${saved.conclusion}` : '未填写';
      li.classList.toggle('filled', !!saved);
      ul.appendChild(li);
      continue;
    }
    if (saved) statusEl.textContent = `${saved.conclusion} · v${state.detail.round.version}`;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn primary';
    saveBtn.textContent = '保存本区';

    const readForm = () => ({
      conclusion: (li.querySelector('input[type=radio]:checked') || {}).value || '',
      remark: textarea.value.trim(),
    });

    const syncDirty = () => {
      const cur = readForm();
      const sameAsServer = saved && cur.conclusion === saved.conclusion && cur.remark === (saved.remark || '');
      if (!cur.conclusion) {
        state.dirty.delete(item.code);
      } else if (sameAsServer) {
        state.dirty.delete(item.code);
      } else {
        state.dirty.set(item.code, cur);
      }
      updateCardLook(li, item.code, cur, msg, saveBtn, statusEl);
      renderPolygons();
    };

    for (const r of radios) r.addEventListener('change', syncDirty);
    textarea.addEventListener('input', syncDirty);

    saveBtn.addEventListener('click', () => saveCard(item.code, li, textarea));
    actions.appendChild(saveBtn);
    updateCardLook(li, item.code, { conclusion, remark }, msg, saveBtn, statusEl);
    ul.appendChild(li);
  }
}

/** 更新单张卡片的提示与保存按钮可用性 */
function updateCardLook(li, code, cur, msg, saveBtn, statusEl) {
  const saved = state.detail.regions.find((r) => r.code === code).result;
  const isDirty = state.dirty.has(code);
  li.classList.toggle('dirty', isDirty);
  li.classList.toggle('hazard', cur.conclusion === '隐患');
  li.classList.toggle('normal', cur.conclusion === '正常');
  li.classList.toggle('filled', !!(saved || cur.conclusion));
  if (statusEl) {
    if (saved) statusEl.textContent = isDirty ? `未提交改动（已存：${saved.conclusion}）` : `已记录：${saved.conclusion}`;
    else statusEl.textContent = cur.conclusion ? '待保存' : '未填写';
  }
  if (!cur.conclusion) {
    msg.textContent = '请选择结论';
    msg.className = 'round-card-msg muted';
    saveBtn.disabled = true;
  } else if (cur.conclusion === '隐患' && !cur.remark) {
    msg.textContent = '隐患必须填写备注';
    msg.className = 'round-card-msg round-err';
    saveBtn.disabled = true;
  } else {
    msg.textContent = isDirty ? '有未保存的修改' : (saved ? '已与服务端一致' : '可保存');
    msg.className = 'round-card-msg ' + (isDirty ? 'round-warn' : 'muted');
    saveBtn.disabled = false;
  }
}

function selectCard(code) {
  state.selectedCode = code;
  renderPolygons();
  const cards = document.querySelectorAll('.round-card');
  for (const el of cards) {
    const hit = el.dataset.code === code;
    el.classList.toggle('selected', hit);
    if (hit) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* ------------------------------- 保存单区 ------------------------------- */

async function saveCard(code, li, textarea) {
  const checked = li.querySelector('input[type=radio]:checked');
  const conclusion = checked ? checked.value : '';
  const remark = textarea.value.trim();
  if (!conclusion) return toast(`区域「${code}」请先选择正常/隐患`, 'err');
  if (conclusion === '隐患' && !remark) return toast(`区域「${code}」是隐患，备注不能为空`, 'err');

  const btn = li.querySelector('.round-card-actions .btn');
  btn.disabled = true;
  try {
    const res = await api('PUT',
      `/api/plans/${planId}/rounds/${state.detail.round.id}/results/${encodeURIComponent(code)}`,
      { conclusion, remark, version: state.version });
    state.dirty.delete(code); // 本区已与服务端一致，清除未提交标记
    applyServer(res, { preserveDirty: true });
    if (res.changed === false) toast(`区域「${code}」内容未变化`, 'info', 2200);
    else toast(`区域「${code}」已保存（轮次 v${res.round.version}）`, 'ok');
  } catch (err) {
    handleRoundWriteError(err, code);
  } finally {
    btn.disabled = false;
  }
}

/** 冲突：服务端最新状态覆盖其他区，被拒区的未提交表单原样保留 */
function handleRoundWriteError(err, code) {
  if (err.status === 409 && err.data && err.data.server) {
    const server = err.data.server;
    // 保留当前冲突区的表单内容（已在 state.dirty 中），其余区同步到最新
    applyServer(server, { preserveDirty: true });
    if (err.code === 'ROUND_COMPLETED') {
      toast(`轮次已被他人完成并锁定，本区修改未保存：${err.message}`, 'err', 7000);
    } else {
      toast(`版本冲突，未覆盖你的填写：${err.message}`, 'err', 7000);
      selectCard(code);
    }
  } else if (err.code === 'UNKNOWN_REGION' || err.code === 'HAZARD_REMARK_REQUIRED') {
    toast(err.message, 'err', 6000);
  } else {
    toast(`保存失败：${err.message}`, 'err', 6000);
  }
}

/* ------------------------------- 完成轮次 ------------------------------- */

$('btnCompleteRound').addEventListener('click', async () => {
  const { round, regions } = state.detail;
  const missing = regions.filter((r) => {
    const local = state.dirty.get(r.code);
    const conclusion = local ? local.conclusion : (r.result && r.result.conclusion);
    return !conclusion;
  }).map((r) => r.code);
  if (missing.length) {
    toast(`还有 ${missing.length} 个区域未保存结果（${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' …' : ''}），全部齐全后才能完成`, 'err', 6000);
    return;
  }
  if (!confirm(`确认完成第 ${round.seq} 轮巡检？\n完成后轮次与全部结果将变为只读，不可再修改。`)) return;

  const btn = $('btnCompleteRound');
  btn.disabled = true;
  try {
    const res = await api('POST',
      `/api/plans/${planId}/rounds/${round.id}/complete`,
      { version: state.version });
    state.dirty.clear();
    applyServer(res, { preserveDirty: false });
    toast(res.message || '本轮巡检已完成（只读）', 'ok', 5000);
  } catch (err) {
    if (err.status === 409 && err.data && err.data.server) {
      applyServer(err.data.server, { preserveDirty: true });
      toast(`完成被拒绝：${err.message}`, 'err', 7000);
    } else if (err.code === 'ROUND_INCOMPLETE') {
      toast(`无法完成：${err.message}`, 'err', 7000);
      const missing = (err.data && err.data.missing_codes) || [];
      if (missing.length) selectCard(missing[0]);
    } else {
      toast(`完成失败：${err.message}`, 'err', 6000);
    }
  } finally {
    btn.disabled = false;
  }
});

$('btnRefreshRound').addEventListener('click', refreshRound);
$('btnRefreshDone') && $('btnRefreshDone').addEventListener('click', refreshRound);
async function refreshRound() {
  try {
    const detail = await api('GET', `/api/plans/${planId}/rounds/${state.detail.round.id}`);
    applyServer(detail, { preserveDirty: true });
    toast('已刷新为服务端最新状态（未提交的填写仍保留）', 'info', 2600);
  } catch (err) {
    toast('刷新失败：' + err.message, 'err');
  }
}

/* 有未提交内容时提醒不要直接离开 */
window.addEventListener('beforeunload', (e) => {
  if (state.dirty.size) { e.preventDefault(); e.returnValue = ''; }
});

/* ------------------------------- 视口交互 ------------------------------- */

const svg = $('rdSvg');
function applyTransform() {
  const t = state.transform;
  $('rdViewport').setAttribute('transform',
    `translate(${t.tx} ${t.ty}) scale(${t.scale})`);
  $('rdZoomLevel').textContent = `缩放 ${Math.round(t.scale * 100)}%`;
}
function fitView() {
  if (!state.detail) return;
  const pub = state.detail.publication;
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
  if (!state.detail) return;
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
  if (!state.detail || e.button !== 0) return;
  if (e.target.classList && e.target.classList.contains('round-poly')) return; // 点区域不触发平移
  state.drag = { x: e.clientX, y: e.clientY };
  svg.classList.add('panning');
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  const d = state.drag;
  if (!d) return;
  state.transform.tx += e.clientX - d.x;
  state.transform.ty += e.clientY - d.y;
  d.x = e.clientX; d.y = e.clientY;
  applyTransform();
});
window.addEventListener('mouseup', () => {
  state.drag = null;
  svg.classList.remove('panning');
});
svg.addEventListener('dblclick', (e) => {
  if (e.target.classList && e.target.classList.contains('round-poly')) return;
  fitView();
});
window.addEventListener('resize', () => state.detail && applyTransform());

init();
