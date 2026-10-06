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
    const url = new URL(location.href);
    url.searchParams.set('seq', s);
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
  for (const r of pub.regions) {
    const c = RISK_COLORS[r.risk_level] || { fill: 'rgba(107,114,128,.15)', stroke: '#6b7280' };
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
    label.textContent = `${r.code} · ${r.risk_level}`;
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

init();
