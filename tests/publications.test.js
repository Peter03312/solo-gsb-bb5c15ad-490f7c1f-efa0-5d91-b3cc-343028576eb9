'use strict';
/*
 * 只读巡检版 HTTP API 端到端测试：node tests/publications.test.js
 * 覆盖：
 *  - 发布必须携带 plan_version；版本不符 409 且不留任何快照
 *  - 未发布时 latest 返回 404 NO_PUBLICATION（页面据此提示「暂无巡检版」）
 *  - 发布序号从 1 递增；同版本重复发布幂等（reused=true，不产生新版本/快照文件）
 *  - 冻结不变性：发布后编辑、删区、同尺寸换图，旧巡检版内容与原图均不变
 *  - 巡检版原图走独立快照文件，不随 uploads 原图替换而变
 *  - 原图缺失时发布失败（不写记录）
 *
 * 使用独立临时 DATA_DIR，在进程内启动真实 Express 服务。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// 必须在 require 应用前指定独立数据目录与空闲端口
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'hpa-pub-test-'));
process.env.DATA_DIR = tmpData;
process.env.PORT = String(8900 + Math.floor(Math.random() * 900));
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

async function rawFetch(method, url) {
  const res = await fetch(base + url, { method });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), res };
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
/** 生成一张 w×h 的灰度 PNG（含 IHDR / IDAT / IEND） */
function makePng(w, h, gray = 200) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
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

function square(x, y, s) {
  return [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
}
const snapshotFiles = () =>
  fs.readdirSync(config.snapshotDir()).filter((f) => !f.startsWith('.'));

/* -------------------------------- 测试主体 -------------------------------- */

async function run() {
  const W = 300, H = 200;
  const png1 = makePng(W, H, 200);
  const png2 = makePng(W, H, 80); // 同尺寸不同内容，用于换图

  const created = await createPlan(png1, '巡检测试馆');
  const planId = created.plan.id;
  assert.equal(created.plan.version, 1);

  await check('健康检查 GET /api/plans 正常', async () => {
    const r = await jfetch('GET', '/api/plans');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.plans));
  });

  await check('未发布时：列表为空、latest 与按序号查看均为 404 NO_PUBLICATION', async () => {
    const list = await jfetch('GET', `/api/plans/${planId}/publications`);
    assert.equal(list.status, 200);
    assert.equal(list.data.count, 0);
    assert.equal(list.data.latest_seq, null);
    const latest = await jfetch('GET', `/api/plans/${planId}/publications/latest`);
    assert.equal(latest.status, 404);
    assert.equal(latest.data.error, 'NO_PUBLICATION');
    const old = await jfetch('GET', `/api/plans/${planId}/publications/1`);
    assert.equal(old.status, 404);
    assert.equal(old.data.error, 'NO_PUBLICATION');
  });

  await check('发布缺少 plan_version → 400', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications`, {});
    assert.equal(r.status, 400);
  });

  await check('plan_version 不匹配 → 409 PLAN_VERSION_CONFLICT 且不留快照', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: 99 });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'PLAN_VERSION_CONFLICT');
    const list = await jfetch('GET', `/api/plans/${planId}/publications`);
    assert.equal(list.data.count, 0);
    assert.equal(snapshotFiles().length, 0);
  });

  // 加两个区域：图纸版本 1 → 2 → 3
  const r1 = await addRegion(planId, 'A-01', '低风险', square(10, 10, 40), 1);
  const r2 = await addRegion(planId, 'B-02', '高风险', square(80, 80, 40), r1.plan_version);
  const planV2 = r2.plan_version;
  assert.equal(planV2, 3);

  await check('基于当前版本发布 → 201，seq=1，冻结编号/等级/坐标', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: planV2 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.reused, false);
    const pub = r.data.publication;
    assert.equal(pub.seq, 1);
    assert.equal(pub.plan_version, planV2);
    assert.equal(pub.region_count, 2);
    assert.equal(pub.width, W);
    assert.equal(pub.height, H);
    assert.deepEqual(pub.regions.map((x) => x.code), ['A-01', 'B-02']);
    assert.equal(pub.regions[1].risk_level, '高风险');
    assert.deepEqual(pub.regions[0].vertices, square(10, 10, 40));
  });

  await check('快照原图可读取，且字节与发布时原图一致', async () => {
    const img = await rawFetch('GET', `/api/plans/${planId}/publications/1/image`);
    assert.equal(img.status, 200);
    assert.ok(img.buf.equals(png1));
  });

  await check('同一图纸版本重复发布 → 200 reused=true，不产生重复巡检版/快照文件', async () => {
    const before = snapshotFiles().length;
    const r = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: planV2 });
    assert.equal(r.status, 200);
    assert.equal(r.data.reused, true);
    assert.equal(r.data.publication.seq, 1);
    const list = await jfetch('GET', `/api/plans/${planId}/publications`);
    assert.equal(list.data.count, 1);
    assert.equal(snapshotFiles().length, before);
  });

  // 后续编辑：改 B-02 等级 + 形状（v3→v4），删 A-01（v4→v5）
  const bRegion = r2.regions.find((x) => x.code === 'B-02');
  const upd = await jfetch('PUT', `/api/plans/${planId}/regions/${bRegion.id}`, {
    code: 'B-02', risk_level: '中风险', vertices: square(90, 90, 30),
    version: bRegion.version, plan_version: planV2,
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const afterUpdateV = upd.data.plan_version;
  const aRegion = upd.data.regions.find((x) => x.code === 'A-01');
  const del = await jfetch('DELETE',
    `/api/plans/${planId}/regions/${aRegion.id}?version=${aRegion.version}&plan_version=${afterUpdateV}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  const planV3 = del.data.plan_version;

  await check('编辑 + 删区后，旧巡检版 #1 内容保持冻结（编号/等级/坐标不变）', async () => {
    const r = await jfetch('GET', `/api/plans/${planId}/publications/1`);
    assert.equal(r.status, 200);
    const pub = r.data.publication;
    assert.equal(pub.region_count, 2);
    assert.deepEqual(pub.regions.map((x) => x.code), ['A-01', 'B-02']);
    const b = pub.regions.find((x) => x.code === 'B-02');
    assert.equal(b.risk_level, '高风险');
    assert.deepEqual(b.vertices, square(80, 80, 40));
  });

  await check('基于新版本再次发布 → seq=2，只含当前未删除区域', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: planV3 });
    assert.equal(r.status, 201);
    assert.equal(r.data.publication.seq, 2);
    assert.equal(r.data.publication.plan_version, planV3);
    assert.equal(r.data.publication.region_count, 1);
    assert.deepEqual(r.data.publication.regions.map((x) => x.code), ['B-02']);
    const list = await jfetch('GET', `/api/plans/${planId}/publications`);
    assert.equal(list.data.count, 2);
    assert.equal(list.data.latest_seq, 2);
  });

  await check('latest 指向 #2；按序号仍可查看历史 #1（含 latest 图片别名）', async () => {
    const latest = await jfetch('GET', `/api/plans/${planId}/publications/latest`);
    assert.equal(latest.status, 200);
    assert.equal(latest.data.publication.seq, 2);
    const one = await jfetch('GET', `/api/plans/${planId}/publications/1`);
    assert.equal(one.data.publication.seq, 1);
    const latestImg = await rawFetch('GET', `/api/plans/${planId}/publications/latest/image`);
    assert.equal(latestImg.status, 200);
  });

  await check('同尺寸换图后：最新原图变化，但两份巡检版快照原图都不变', async () => {
    const fd = new FormData();
    fd.append('image', new Blob([png2], { type: 'image/png' }), 'new.png');
    const upRes = await fetch(base + `/api/plans/${planId}`, { method: 'PUT', body: fd });
    assert.equal(upRes.status, 200, await upRes.text());
    const live = await rawFetch('GET', `/api/plans/${planId}/image`);
    assert.ok(live.buf.equals(png2), '编辑原图应已被替换');
    const snap1 = await rawFetch('GET', `/api/plans/${planId}/publications/1/image`);
    assert.ok(snap1.buf.equals(png1), '#1 快照必须仍是发布时的原图');
    const snap2 = await rawFetch('GET', `/api/plans/${planId}/publications/2/image`);
    assert.ok(snap2.buf.equals(png1), '#2 发布于换图前，也必须保持旧图');
  });

  await check('换图后版本已推进：带旧版本发布 → 409 且不新增巡检版/快照文件', async () => {
    const detail = await jfetch('GET', `/api/plans/${planId}`);
    const curV = detail.data.plan.version;
    assert.ok(curV > planV3);
    const r = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: planV3 });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'PLAN_VERSION_CONFLICT');
    const list = await jfetch('GET', `/api/plans/${planId}/publications`);
    assert.equal(list.data.count, 2, '冲突发布不得留下部分快照');
    assert.equal(snapshotFiles().length, 2);
  });

  await check('非法 seq → 400；越界序号 → 404 NO_PUBLICATION', async () => {
    const bad = await jfetch('GET', `/api/plans/${planId}/publications/abc`);
    assert.equal(bad.status, 400);
    const miss = await jfetch('GET', `/api/plans/${planId}/publications/99`);
    assert.equal(miss.status, 404);
    assert.equal(miss.data.error, 'NO_PUBLICATION');
  });

  await check('不存在的图纸 → 404 NOT_FOUND', async () => {
    const r = await jfetch('GET', '/api/plans/999999/publications');
    assert.equal(r.status, 404);
  });

  await check('原图缺失时发布失败（410，不新增记录）；恢复原图后可重新发布', async () => {
    const detail = await jfetch('GET', `/api/plans/${planId}`);
    const curV = detail.data.plan.version;
    const livePath = path.join(config.uploadDir(), `${planId}.png`);
    const bak = livePath + '.bak';
    fs.renameSync(livePath, bak);
    try {
      const r = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: curV });
      assert.equal(r.status, 410);
      assert.equal(r.data.error, 'IMAGE_MISSING');
      const list = await jfetch('GET', `/api/plans/${planId}/publications`);
      assert.equal(list.data.count, 2);
    } finally {
      fs.renameSync(bak, livePath);
    }
    const republished = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: curV });
    assert.equal(republished.status, 201, JSON.stringify(republished.data));
    assert.equal(republished.data.publication.seq, 3);
  });
}

run().then(() => {
  console.log(`\n巡检版 API 测试全部通过（${n} 项）`);
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
