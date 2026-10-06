'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

/**
 * 打开（并按需初始化）SQLite 数据库。
 * 幂等：表/索引已存在时不会重建，数据得以保留。
 * 同时可作为迁移脚本独立运行：npm run migrate
 */
function openDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir(), { recursive: true });
  fs.mkdirSync(config.snapshotDir(), { recursive: true });

  const db = new Database(config.dbFile());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      image_file   TEXT    NOT NULL,
      image_mime   TEXT    NOT NULL,
      width        INTEGER NOT NULL,
      height       INTEGER NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS regions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id      INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      code         TEXT    NOT NULL,
      risk_level   TEXT    NOT NULL,
      vertices     TEXT    NOT NULL,   -- JSON: [{"x":..,"y":..}, ...]，原图坐标
      version      INTEGER NOT NULL DEFAULT 1,
      deleted      INTEGER NOT NULL DEFAULT 0,  -- 软删除墓碑，用于版本/冲突语义
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 同一图上「未删除」区域编号唯一；编号删除后允许复用
    CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_code_active
      ON regions(plan_id, code) WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_regions_plan
      ON regions(plan_id, deleted);

    -- 只读巡检版：一次发布即冻结原图快照与全部未删除区域，后续编辑不可改变
    CREATE TABLE IF NOT EXISTS publications (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id         INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,          -- 图纸内发布序号，从 1 递增
      plan_version    INTEGER NOT NULL,          -- 发布时所见图纸版本（乐观锁依据）
      plan_name       TEXT    NOT NULL,          -- 冻结当时的图纸名称
      width           INTEGER NOT NULL,
      height          INTEGER NOT NULL,
      image_file      TEXT    NOT NULL,          -- data/snapshots 下的独立原图副本，不随换图变化
      image_mime      TEXT    NOT NULL,
      regions_json    TEXT    NOT NULL,          -- 冻结区域：[{code,risk_level,vertices}]
      region_count    INTEGER NOT NULL DEFAULT 0,
      published_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 同一图纸版本重复发布幂等：不产生第二条巡检版
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_plan_version
      ON publications(plan_id, plan_version);

    -- 序号在图纸内唯一（并用 seq DESC 取最新版）
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_plan_seq
      ON publications(plan_id, seq);

    -- 巡检轮次：针对某个已发布（冻结）巡检版发起的一轮巡检；
    -- 轮次只关联冻结版（publication_id），后续图纸改名/换图/区域编辑/新发布均不影响。
    CREATE TABLE IF NOT EXISTS inspection_rounds (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id        INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      seq            INTEGER NOT NULL,          -- 同一巡检版内轮次序号，从 1 递增
      plan_name      TEXT    NOT NULL,          -- 发起时冗余的图纸名（展示用，冻结）
      status         TEXT    NOT NULL DEFAULT 'in_progress', -- in_progress / completed
      version        INTEGER NOT NULL DEFAULT 1, -- 轮次版本：每次保存/完成 +1（乐观锁依据）
      total_regions  INTEGER NOT NULL,          -- 发起时冻结版的区域总数
      filled_regions INTEGER NOT NULL DEFAULT 0,-- 已填写区域数（完成时必须等于总数）
      hazard_count   INTEGER NOT NULL DEFAULT 0,-- 结论为「隐患」的区域数
      started_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at   TEXT
    );

    -- 同一巡检版内轮次序号唯一
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_pub_seq
      ON inspection_rounds(publication_id, seq);
    CREATE INDEX IF NOT EXISTS idx_rounds_plan
      ON inspection_rounds(plan_id);

    -- 逐区巡检结果：每轮每区至多一条（UPSERT）；区域编号以冻结版为准
    CREATE TABLE IF NOT EXISTS inspection_records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id    INTEGER NOT NULL REFERENCES inspection_rounds(id) ON DELETE CASCADE,
      region_code TEXT    NOT NULL,            -- 对应冻结版 regions_json 中的编号
      result      TEXT    NOT NULL,            -- 正常 / 隐患
      note        TEXT    NOT NULL DEFAULT '', -- 备注；隐患必须非空
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(round_id, region_code)
    );
  `);

  return db;
}

// 直接执行 `node server/db.js` 时完成初始化并退出（供依赖初始化/CI 使用）
if (require.main === module) {
  const db = openDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'"
  ).all();
  console.log('数据库初始化完成:', config.dbFile());
  console.log('对象:', tables.map((t) => t.name).join(', '));
  db.close();
}

module.exports = { openDb };
