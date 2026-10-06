'use strict';
/*
 * 巡检轮次 HTTP API 端到端测试：node tests/rounds.test.js
 * 覆盖：
 *  - 未发布/缺失发布版不可发起；空区域发布版拒绝发起且不留半成品
 *  - 同一发布版可发起多轮（序号 1..n），列表/详情含图纸、发布序号、进度与每区结果
 *  - 逐区 upsert：合法正常/隐患、隐患必须非空备注、未知编号、非法结论、缺版本明确拒绝
 *  - 乐观锁：填写与完成均须带所见轮次版本；冲突返回 409 与最新状态，且不写入未提交内容
 *  - 相同内容重复提交幂等（changed=false，版本不前进）
 *  - 只有全部区域记录齐全才允许完成；完成后只读（再改再完成均 ROUND_COMPLETED）
 *  - 冻结不变性：完成后改名、区域编辑、再发新版，旧轮次的冻结区域与结果均不变
 *
 * 使用独立临时 DATA_DIR，在进程内启动真实 Express 服务。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'hpa-round-test-'));
process.env.DATA_DIR = tmpData;
process.env.PORT = String(8700 + Math.floor(Math.random() * 200));
process.env.HOST = '127.0.0.1';

const config = require('../server/config');
const app = require('../server/app'); // 启动监听
const server = app.server;

const base = `http://127.0.0.1:${config.port}`;
let n = 0;
async function check(name, fn) {
  await fn();
  n++;
  console.log('  ✓', name);
}

async function jfetch(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 无 JSON */ }
  return { status: res.status, data, res };
}

/* ----------------------- 生成合法 PNG（可通过服务端损坏检测） ----------------------- */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n2 = 0; n2 < 256; n2++) {
    let c = n2;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n2] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(w, h, gray = 200) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w, gray)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

async function createPlan(png, name) {
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 'plan.png');
  fd.append('name', name);
  const res = await fetch(base + '/api/plans', { method: 'POST', body: fd });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  return data;
}
async function addRegion(planId, code, risk, verts, planVersion) {
  const r = await jfetch('POST', `/api/plans/${planId}/regions`, {
    code, risk_level: risk, vertices: verts, plan_version: planVersion,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const square = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

/* -------------------------------- 测试主体 -------------------------------- */

async function run() {
  // 另一张「空图纸」用于验证空区域发布版不可发起
  const emptyPlan = (await createPlan(makePng(120, 120, 210), '空馆')).plan.id;
  const emptyPub = await jfetch('POST', `/api/plans/${emptyPlan}/publications`, { plan_version: 1 });
  assert.equal(emptyPub.status, 201, JSON.stringify(emptyPub.data));

  const created = await createPlan(makePng(300, 200, 200), '轮次测试馆');
  const planId = created.plan.id;

  await check('未发布时发起轮次 → 404 NO_PUBLICATION', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications/latest/rounds`, {});
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'NO_PUBLICATION');
    const r2 = await jfetch('POST', `/api/plans/${planId}/publications/1/rounds`, {});
    assert.equal(r2.status, 404);
    assert.equal(r2.data.error, 'NO_PUBLICATION');
  });

  await check('空区域发布版发起轮次 → 400 PUBLICATION_HAS_NO_REGIONS，且不留轮次', async () => {
    const r = await jfetch('POST', `/api/plans/${emptyPlan}/publications/1/rounds`, {});
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'PUBLICATION_HAS_NO_REGIONS');
    const list = await jfetch('GET', `/api/plans/${emptyPlan}/publications/1/rounds`);
    assert.equal(list.status, 200);
    assert.equal(list.data.count, 0);
  });

  // 两个区域后发布 #1
  const a = await addRegion(planId, 'A-01', '低风险', square(10, 10, 40), 1);
  const b = await addRegion(planId, 'B-02', '高风险', square(80, 80, 40), a.plan_version);
  const planV = b.plan_version;
  const pub1 = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: planV });
  assert.equal(pub1.status, 201);

  let roundId = null;
  await check('发起第 1 轮 → 201，含冻结发布版信息与逐区空结果，版本从 1 开始', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications/1/rounds`, { inspector: '张三' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.round.seq, 1);
    assert.equal(r.data.round.status, 'in_progress');
    assert.equal(r.data.round.version, 1);
    assert.equal(r.data.round.region_count, 2);
    assert.equal(r.data.round.filled_count, 0);
    assert.equal(r.data.round.hazard_count, 0);
    assert.equal(r.data.round.publication_seq, 1);
    assert.equal(r.data.round.plan_name, '轮次测试馆');
    assert.equal(r.data.publication.seq, 1);
    assert.deepEqual(r.data.regions.map((x) => x.code), ['A-01', 'B-02']);
    assert.ok(r.data.regions.every((x) => x.result === null));
    roundId = r.data.round.id;
  });

  await check('latest 别名可发起第 2 轮（同一发布版多轮并存）', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications/latest/rounds`, {});
    assert.equal(r.status, 201);
    assert.equal(r.data.round.seq, 2);
    assert.equal(r.data.round.filled_count, 0);
  });

  await check('非法结论 / 隐患缺备注 / 缺 version / 非法轮次 id 均被拒绝', async () => {
    const bad = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/A-01`,
      { conclusion: '损坏', remark: '', version: 1 });
    assert.equal(bad.status, 400);
    const noRemark = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/A-01`,
      { conclusion: '隐患', remark: '   ', version: 1 });
    assert.equal(noRemark.status, 400);
    assert.equal(noRemark.data.error, 'HAZARD_REMARK_REQUIRED');
    const noVersion = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/A-01`,
      { conclusion: '正常', remark: '' });
    assert.equal(noVersion.status, 400);
    const badId = await jfetch('GET', `/api/plans/${planId}/rounds/abc`);
    assert.equal(badId.status, 400);
  });

  await check('未知区域编号 → 400 UNKNOWN_REGION 且不产生任何记录', async () => {
    const before = await jfetch('GET', `/api/plans/${planId}/rounds/${roundId}`);
    assert.equal(before.data.round.filled_count, 0);
    const r = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/Z-99`,
      { conclusion: '正常', remark: '', version: 1 });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'UNKNOWN_REGION');
    const after = await jfetch('GET', `/api/plans/${planId}/rounds/${roundId}`);
    assert.equal(after.data.round.filled_count, 0);
  });

  await check('保存 A-01=正常：版本 1→2，进度 1/2', async () => {
    const r = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/A-01`,
      { conclusion: '正常', remark: '', version: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.data.round.version, 2);
    assert.equal(r.data.round.filled_count, 1);
    assert.equal(r.data.round.normal_count, 1);
    assert.equal(r.data.changed, true);
    const aRes = r.data.regions.find((x) => x.code === 'A-01').result;
    assert.equal(aRes.conclusion, '正常');
  });

  await check('他人先修改（旧 version=1）→ 409 ROUND_VERSION_CONFLICT 附最新状态，未写入被拒内容', async () => {
    const r = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/B-02`,
      { conclusion: '正常', remark: '', version: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'ROUND_VERSION_CONFLICT');
    assert.equal(r.data.server.round.version, 2);
    assert.ok(r.data.server.regions.find((x) => x.code === 'A-01').result);
    const detail = await jfetch('GET', `/api/plans/${planId}/rounds/${roundId}`);
    assert.equal(detail.data.regions.find((x) => x.code === 'B-02').result, null);
  });

  await check('相同内容重复提交幂等：changed=false，轮次版本不前进', async () => {
    const r = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/A-01`,
      { conclusion: '正常', remark: '', version: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.data.changed, false);
    assert.equal(r.data.round.version, 2);
  });

  await check('保存 B-02=隐患（带非空备注）：版本 2→3，隐患计数 1', async () => {
    const r = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/B-02`,
      { conclusion: '隐患', remark: '消防通道堆物，限期整改', version: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.data.round.version, 3);
    assert.equal(r.data.round.hazard_count, 1);
    assert.equal(r.data.round.filled_count, 2);
  });

  await check('齐全前完成：模拟缺区（第 2 轮为空）→ 400 ROUND_INCOMPLETE 带 missing_codes', async () => {
    const rounds = await jfetch('GET', `/api/plans/${planId}/publications/1/rounds`);
    const round2Id = rounds.data.rounds.find((x) => x.seq === 2).id;
    const r = await jfetch('POST',
      `/api/plans/${planId}/rounds/${round2Id}/complete`, { version: 1 });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'ROUND_INCOMPLETE');
    assert.deepEqual(r.data.missing_codes.sort(), ['A-01', 'B-02']);
  });

  await check('旧版本完成 → 409；当前版本完成 → 只读', async () => {
    const stale = await jfetch('POST',
      `/api/plans/${planId}/rounds/${roundId}/complete`, { version: 2 });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'ROUND_VERSION_CONFLICT');
    const ok = await jfetch('POST',
      `/api/plans/${planId}/rounds/${roundId}/complete`, { version: 3 });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.round.status, 'completed');
    assert.equal(ok.data.round.version, 4);
    assert.ok(ok.data.round.completed_at);
  });

  await check('完成后：改结果 / 再完成 均 409 ROUND_COMPLETED（只读）', async () => {
    const edit = await jfetch('PUT',
      `/api/plans/${planId}/rounds/${roundId}/results/A-01`,
      { conclusion: '隐患', remark: '试图篡改', version: 4 });
    assert.equal(edit.status, 409);
    assert.equal(edit.data.error, 'ROUND_COMPLETED');
    const again = await jfetch('POST',
      `/api/plans/${planId}/rounds/${roundId}/complete`, { version: 4 });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'ROUND_COMPLETED');
    // 结果没有被改动
    const detail = await jfetch('GET', `/api/plans/${planId}/rounds/${roundId}`);
    assert.equal(detail.data.regions.find((x) => x.code === 'A-01').result.conclusion, '正常');
    assert.equal(detail.data.regions.find((x) => x.code === 'B-02').result.remark,
      '消防通道堆物，限期整改');
  });

  await check('轮次列表（发布版维度与图纸维度）含图纸、发布序号、进度、隐患数', async () => {
    const byPub = await jfetch('GET', `/api/plans/${planId}/publications/1/rounds`);
    assert.equal(byPub.status, 200);
    assert.equal(byPub.data.count, 2);
    assert.equal(byPub.data.publication.seq, 1);
    const first = byPub.data.rounds.find((x) => x.seq === 1);
    assert.equal(first.status, 'completed');
    assert.equal(first.filled_count, 2);
    assert.equal(first.hazard_count, 1);
    assert.equal(first.publication_seq, 1);
    assert.equal(first.plan_name, '轮次测试馆');

    const byPlan = await jfetch('GET', `/api/plans/${planId}/rounds`);
    assert.equal(byPlan.status, 200);
    assert.equal(byPlan.data.count, 2);
    assert.equal(byPlan.data.rounds[0].id !== byPlan.data.rounds[1].id, true);
  });

  await check('冻结不变性：改名 + 区域编辑后，旧轮次冻结区域、风险等级与结果不变', async () => {
    // 图纸改名（urlencoded）
    let res = await fetch(base + `/api/plans/${planId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=' + encodeURIComponent('改名后的馆'),
    });
    assert.equal(res.status, 200, await res.text());
    // 编辑 B-02（形状/等级变化）；改名已推进图纸版本，先取最新版本
    const planNow = await jfetch('GET', `/api/plans/${planId}`);
    const upd = await jfetch('PUT', `/api/plans/${planId}/regions/2`, {
      code: 'B-02', risk_level: '中风险', vertices: square(90, 90, 30),
      version: 1, plan_version: planNow.data.plan.version,
    });
    assert.equal(upd.status, 200, JSON.stringify(upd.data));
    const detail = await jfetch('GET', `/api/plans/${planId}/rounds/${roundId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.publication.plan_name, '轮次测试馆', '轮次保留冻结时图纸名');
    assert.equal(detail.data.round.plan_name, '轮次测试馆');
    const b = detail.data.regions.find((x) => x.code === 'B-02');
    assert.deepEqual(b.vertices, square(80, 80, 40), '保留冻结坐标');
    assert.equal(b.risk_level, '高风险', '保留冻结风险等级');
    assert.equal(b.result.conclusion, '隐患');
    assert.equal(b.result.remark, '消防通道堆物，限期整改');
  });

  await check('再发新版 #2 后，旧轮次仍属 #1，新一轮基于 #2 的冻结区域', async () => {
    const detail = await jfetch('GET', `/api/plans/${planId}`);
    const curV = detail.data.plan.version;
    const pub2 = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: curV });
    assert.equal(pub2.status, 201);
    assert.equal(pub2.data.publication.seq, 2);
    const oldRound = await jfetch('GET', `/api/plans/${planId}/rounds/${roundId}`);
    assert.equal(oldRound.data.publication.seq, 1);
    const r3 = await jfetch('POST', `/api/plans/${planId}/publications/2/rounds`, {});
    assert.equal(r3.status, 201);
    assert.equal(r3.data.round.publication_seq, 2);
    // #2 只有一个区域（A-01 已被……实际仍有 A-01 + 编辑后的 B-02）
    assert.deepEqual(r3.data.regions.map((x) => x.code), ['A-01', 'B-02']);
    assert.equal(r3.data.regions.find((x) => x.code === 'B-02').risk_level, '中风险');
  });

  await check('跨图纸/不存在轮次访问 → 404 ROUND_NOT_FOUND', async () => {
    const r = await jfetch('GET', `/api/plans/${emptyPlan}/rounds/${roundId}`);
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'ROUND_NOT_FOUND');
    const miss = await jfetch('GET', `/api/plans/${planId}/rounds/99999`);
    assert.equal(miss.status, 404);
    assert.equal(miss.data.error, 'ROUND_NOT_FOUND');
  });

  await check('特殊字符区域编号（含 / 与空格）可经 URL 编码正常填写', async () => {
    // 新图纸：加一个带特殊编号的区域并发布、发起轮次
    const p = (await createPlan(makePng(200, 200), '特殊编号馆')).plan.id;
    const reg = await addRegion(p, 'A/1 号', '低风险', square(5, 5, 30), 1);
    const pub = await jfetch('POST', `/api/plans/${p}/publications`, { plan_version: reg.plan_version });
    assert.equal(pub.status, 201);
    const rd = await jfetch('POST', `/api/plans/${p}/publications/1/rounds`, {});
    assert.equal(rd.status, 201);
    const put = await jfetch('PUT',
      `/api/plans/${p}/rounds/${rd.data.round.id}/results/${encodeURIComponent('A/1 号')}`,
      { conclusion: '正常', remark: '', version: 1 });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal(put.data.round.filled_count, 1);
  });
}

run().then(() => {
  console.log(`\n巡检轮次 API 测试全部通过（${n} 项）`);
  server.close(() => {
    fs.rmSync(tmpData, { recursive: true, force: true });
    process.exit(0);
  });
}).catch((e) => {
  console.error('\n测试失败：', e);
  server.close(() => {
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
  });
});
