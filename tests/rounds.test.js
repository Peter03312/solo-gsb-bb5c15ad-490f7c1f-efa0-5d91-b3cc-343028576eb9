'use strict';
/*
 * 巡检轮次 HTTP API 端到端测试：node tests/rounds.test.js
 * 覆盖：
 *  - 空区域巡检版不可发起（EMPTY_PUBLICATION）；非空版发起后轮次序号版内递增
 *  - 轮次列表/详情：所属图纸、发布序号、巡检进度、每区结果
 *  - 逐区保存：未知区域编号 404、非法结论 400、隐患缺备注 400，均不留半成品
 *  - 正常可无备注；UPSERT 改判；进度/隐患数随之更新
 *  - 乐观锁：缺 version 400；他人先修改 → 409 ROUND_VERSION_CONFLICT 且附最新状态
 *  - 未全部填写不可完成（409 ROUND_INCOMPLETE，附缺失编号）；齐全后完成
 *  - 完成后只读：再保存/再完成 → 409 ROUND_CLOSED
 *  - 冻结不变性：完成后图纸改名、换图、区域编辑、新发布，旧轮次详情与结果不变
 *  - 缺失发布版 / 缺失轮次 / 非法参数均明确拒绝
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
process.env.PORT = String(8900 + Math.floor(Math.random() * 900));
process.env.HOST = '127.0.0.1';

const config = require('../server/config');
const app = require('../server/app');
const server = app.server;

const base = `http://127.0.0.1:${config.port}`;
let n = 0;
async function check(name, fn) {
  await fn();
  n++;
  console.log('  ✓', name);
}

async function jfetch(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
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
async function publish(planId, pv) {
  const r = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: pv });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.data));
  return r.data.publication;
}
function square(x, y, s) {
  return [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
}
const recOf = (round, code) => round.regions.find((x) => x.code === code);

/* -------------------------------- 测试主体 -------------------------------- */

async function run() {
  const W = 400, H = 300;
  const created = await createPlan(makePng(W, H, 200), '轮次测试馆');
  const planId = created.plan.id;

  await check('未发布版上发起轮次 → 404 NO_PUBLICATION', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications/latest/rounds`, {});
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'NO_PUBLICATION');
  });

  // 空区域发布：直接用 plan v1 发布（还没有任何区域）
  const emptyPub = await publish(planId, 1);

  await check('空区域巡检版不可发起轮次 → 400 EMPTY_PUBLICATION', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications/${emptyPub.seq}/rounds`, {});
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'EMPTY_PUBLICATION');
    const list = await jfetch('GET', `/api/plans/${planId}/publications/${emptyPub.seq}/rounds`);
    assert.equal(list.data.count, 0);
  });

  // 加两个区域（v1→v2→v3），发布第 2 号巡检版
  const r1 = await addRegion(planId, 'A-01', '低风险', square(10, 10, 40), 1);
  const r2 = await addRegion(planId, 'B-02', '高风险', square(100, 100, 40), r1.plan_version);
  const planV3 = r2.plan_version;
  const pub = await publish(planId, planV3);
  assert.equal(pub.seq, 2);
  assert.equal(pub.region_count, 2);

  let roundId;
  await check('非空版发起轮次 → 201，seq=1，进度 0/2，每区 result=null', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications/2/rounds`, {});
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const rd = r.data.round;
    roundId = rd.id;
    assert.equal(rd.seq, 1);
    assert.equal(rd.status, 'in_progress');
    assert.equal(rd.version, 1);
    assert.equal(rd.publication_seq, 2);
    assert.equal(rd.region_count, 2);
    assert.equal(rd.filled_count, 0);
    assert.equal(rd.hazard_count, 0);
    assert.equal(rd.plan_name, '轮次测试馆');
    assert.deepEqual(rd.regions.map((x) => x.code), ['A-01', 'B-02']);
    assert.equal(recOf(rd, 'A-01').result, null);
    assert.equal(recOf(rd, 'A-01').note, '');
  });

  await check('同一巡检版可发起多轮：第 2 轮 seq=2，互不影响', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications/latest/rounds`, {});
    assert.equal(r.status, 201);
    assert.equal(r.data.round.seq, 2);
    assert.equal(r.data.round.filled_count, 0);
  });

  await check('版内轮次列表 / 图纸全量轮次列表正确（含跨发布版）', async () => {
    const list = await jfetch('GET', `/api/plans/${planId}/publications/2/rounds`);
    assert.equal(list.status, 200);
    assert.equal(list.data.count, 2);
    assert.deepEqual(list.data.rounds.map((x) => x.seq), [2, 1]);
    assert.equal(list.data.rounds[0].publication_seq, 2);
    const all = await jfetch('GET', `/api/plans/${planId}/rounds`);
    assert.equal(all.data.count, 2); // 空版上没发起成功，只有 pub#2 的两轮
  });

  await check('未知区域编号 → 404 UNKNOWN_REGION，且不留任何记录', async () => {
    const r = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'X-99', result: '正常', note: '', version: 1,
    });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'UNKNOWN_REGION');
    const detail = await jfetch('GET', `/api/rounds/${roundId}`);
    assert.equal(detail.data.round.filled_count, 0);
  });

  await check('非法结论 → 400 VALIDATION_ERROR', async () => {
    const r = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'A-01', result: '报废', note: '', version: 1,
    });
    assert.equal(r.status, 400);
    const empty = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'A-01', version: 1,
    });
    assert.equal(empty.status, 400);
  });

  await check('隐患缺少非空备注 → 400 HAZARD_NOTE_REQUIRED（空白串也算空）', async () => {
    const r = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'A-01', result: '隐患', note: '   ', version: 1,
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'HAZARD_NOTE_REQUIRED');
    const detail = await jfetch('GET', `/api/rounds/${roundId}`);
    assert.equal(detail.data.round.filled_count, 0);
  });

  await check('缺少/非法 version → 400', async () => {
    const r = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'A-01', result: '正常',
    });
    assert.equal(r.status, 400);
    const bad = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'A-01', result: '正常', version: 0,
    });
    assert.equal(bad.status, 400);
  });

  await check('正常可无备注：保存成功，版本 r1→r2，进度 1/2', async () => {
    const r = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'A-01', result: '正常', note: '', version: 1,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const rd = r.data.round;
    assert.equal(rd.version, 2);
    assert.equal(rd.filled_count, 1);
    assert.equal(rd.hazard_count, 0);
    assert.equal(recOf(rd, 'A-01').result, '正常');
  });

  await check('旧版本 r1 再提交（他人已先改）→ 409 ROUND_VERSION_CONFLICT 且附最新状态，不覆盖', async () => {
    const r = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'B-02', result: '正常', note: '', version: 1,
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'ROUND_VERSION_CONFLICT');
    assert.ok(r.data.server && r.data.server.round);
    assert.equal(r.data.server.round.version, 2);
    assert.equal(r.data.server.round.filled_count, 1);
  });

  await check('B-02 隐患带备注 → 保存成功，隐患数 1；随后改判正常 → UPSERT，隐患数 0', async () => {
    const r = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'B-02', result: '隐患', note: '消防通道堆物', version: 2,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.round.hazard_count, 1);
    assert.equal(recOf(r.data.round, 'B-02').note, '消防通道堆物');

    const r2up = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'B-02', result: '正常', note: '', version: 3,
    });
    assert.equal(r2up.status, 200);
    assert.equal(r2up.data.round.filled_count, 2);
    assert.equal(r2up.data.round.hazard_count, 0);
    assert.equal(recOf(r2up.data.round, 'B-02').result, '正常');
  });

  await check('未齐全时完成 → 409 ROUND_INCOMPLETE 附缺失编号（用第 2 轮演示，版本不对也先报版本）', async () => {
    const list = await jfetch('GET', `/api/plans/${planId}/publications/2/rounds`);
    const round2 = list.data.rounds.find((x) => x.seq === 2);
    const r = await jfetch('POST', `/api/rounds/${round2.id}/complete`, { version: round2.version });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'ROUND_INCOMPLETE');
    assert.ok(r.data.server.round);
    assert.deepEqual(
      r.data.server.round.regions.filter((x) => !x.result).map((x) => x.code).sort(),
      ['A-01', 'B-02']
    );
  });

  await check('第 1 轮两区齐全后完成 → 200，status=completed、completed_at 落定', async () => {
    const before = await jfetch('GET', `/api/rounds/${roundId}`);
    const ver = before.data.round.version;
    assert.equal(before.data.round.filled_count, 2);
    const r = await jfetch('POST', `/api/rounds/${roundId}/complete`, { version: ver });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const rd = r.data.round;
    assert.equal(rd.status, 'completed');
    assert.ok(rd.completed_at);
    assert.equal(rd.version, ver + 1);
  });

  await check('完成后只读：再保存 → 409 ROUND_CLOSED；再完成 → 409 ROUND_CLOSED', async () => {
    const detail = await jfetch('GET', `/api/rounds/${roundId}`);
    const ver = detail.data.round.version;
    const save = await jfetch('PUT', `/api/rounds/${roundId}/records`, {
      region_code: 'A-01', result: '隐患', note: '试图改写', version: ver,
    });
    assert.equal(save.status, 409);
    assert.equal(save.data.error, 'ROUND_CLOSED');
    const again = await jfetch('POST', `/api/rounds/${roundId}/complete`, { version: ver });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'ROUND_CLOSED');
    // 结果未被改动
    const after = await jfetch('GET', `/api/rounds/${roundId}`);
    assert.equal(recOf(after.data.round, 'A-01').result, '正常');
    assert.equal(recOf(after.data.round, 'B-02').result, '正常');
  });

  await check('冻结不变性：改名 + 区域编辑 + 同尺寸换图 + 再发布，旧轮次关联冻结区域与结果不变', async () => {
    // 改名（multipart 表单，仅 name 字段）
    const fd = new FormData();
    fd.append('name', '改名后的新馆名');
    const ren = await fetch(base + `/api/plans/${planId}`, { method: 'PUT', body: fd });
    assert.equal(ren.status, 200, await ren.text());

    // 编辑 A-01 区域形状（其在当前编辑态仍存在）
    const detail = await jfetch('GET', `/api/plans/${planId}`);
    const curV = detail.data.plan.version;
    const a = detail.data.regions.find((x) => x.code === 'A-01');
    const upd = await jfetch('PUT', `/api/plans/${planId}/regions/${a.id}`, {
      code: 'A-01', risk_level: '高风险', vertices: square(200, 200, 50),
      version: a.version, plan_version: curV,
    });
    assert.equal(upd.status, 200, JSON.stringify(upd.data));

    // 同尺寸换图
    const fd2 = new FormData();
    fd2.append('image', new Blob([makePng(W, H, 90)], { type: 'image/png' }), 'new.png');
    const swap = await fetch(base + `/api/plans/${planId}`, { method: 'PUT', body: fd2 });
    assert.equal(swap.status, 200, await swap.text());

    // 新发布巡检版
    const detail2 = await jfetch('GET', `/api/plans/${planId}`);
    const pub3 = await publish(planId, detail2.data.plan.version);
    assert.equal(pub3.seq, 3);

    // 旧轮次：仍引用 #2 冻结版（旧区域位置），结果不变
    const old = await jfetch('GET', `/api/rounds/${roundId}`);
    assert.equal(old.status, 200);
    const rd = old.data.round;
    assert.equal(rd.publication_seq, 2);
    assert.equal(rd.status, 'completed');
    assert.deepEqual(rd.regions.map((x) => x.code), ['A-01', 'B-02']);
    assert.deepEqual(recOf(rd, 'A-01').vertices, square(10, 10, 40));
    assert.equal(recOf(rd, 'A-01').risk_level, '低风险');
    assert.equal(recOf(rd, 'A-01').result, '正常');
    assert.equal(recOf(rd, 'B-02').result, '正常');
    assert.equal(rd.plan_name, '轮次测试馆', '轮次内图纸名为发起时冻结名');
  });

  await check('非法轮次 id / 不存在轮次 → 400 / 404 ROUND_NOT_FOUND', async () => {
    const bad = await jfetch('GET', '/api/rounds/abc');
    assert.equal(bad.status, 400);
    const miss = await jfetch('GET', '/api/rounds/999999');
    assert.equal(miss.status, 404);
    assert.equal(miss.data.error, 'ROUND_NOT_FOUND');
    const save = await jfetch('PUT', '/api/rounds/999999/records', {
      region_code: 'A-01', result: '正常', version: 1,
    });
    assert.equal(save.status, 404);
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
