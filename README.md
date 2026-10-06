# 展馆平面图协作标注（Hall Plan Annotator）

本地运行的展馆平面图多人协作标注 Web 应用：上传 PNG / JPEG 平面图后，多个人可在同一图上
**缩放、平移、绘制多边形区域**，为每个区域填写**唯一编号**与**风险等级**。所有顶点按
**原图像素坐标**保存，换设备、刷新页面后位置完全一致。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器原生 SVG，无前端构建
- 完全本地运行，**不依赖任何第三方账号 / 外部服务**
- 数据库与原图保存在本地数据目录，可用 Docker 卷持久化

---

## 一、快速开始（Docker Compose，一键启动）

前置：已安装 Docker 与 Docker Compose 插件（Docker Desktop 自带）。

```bash
# 1. 在项目目录构建并后台启动（首次会自动初始化数据库与表结构）
docker compose up -d --build

# 2. 查看状态 / 日志
docker compose ps
docker compose logs -f

# 3. 停止（数据保留在 ./data，不会丢失）
docker compose down
```

启动后浏览器访问：

> **http://localhost:8080**

若宿主机 8080 端口被占用，改映射端口（容器内仍为 8080，无需改动应用）：

```bash
APP_PORT=18080 docker compose up -d --build
# 访问 http://localhost:18080
```

健康检查：`GET http://localhost:8080/api/plans`（返回 `{"plans":[...]}` 即正常）。

---

## 二、直接用 Node 运行（不使用 Docker）

要求 **Node.js >= 20**，无需全局安装其他工具。better-sqlite3 会安装预编译二进制
（无预编译时本机需具备 python3 / make / g++ 以从源码编译）。

```bash
# 1. 安装依赖
npm install

# 2. 初始化数据库（幂等；应用/容器启动时也会自动执行一次）
npm run migrate

# 3. 启动
npm start
```

默认访问：

> **http://localhost:8080**

运行测试：

```bash
npm test            # 几何校验单元测试（17 项）+ 巡检版发布端到端测试（15 项）
```

---

## 三、配置项（全部通过环境变量设置，均有默认值）

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口（容器内） |
| `HOST` | `0.0.0.0` | 监听地址。仅本机访问可设 `127.0.0.1`；容器内必须为 `0.0.0.0` |
| `DATA_DIR` | `./data`（本地）/ `/data`（容器） | 数据目录：存放 SQLite 库 `annotator.db` 与 `uploads/` 原图 |
| `MAX_UPLOAD_MB` | `30` | 上传原图大小上限（MB）。导入 JSON 内嵌 base64 图片，导入上限自动额外 +16MB |
| `APP_PORT` | `8080` | 仅 Compose 使用：宿主机映射端口 |

示例：

```bash
PORT=9000 HOST=127.0.0.1 MAX_UPLOAD_MB=50 DATA_DIR=/var/lib/hpa npm start
```

数据目录结构：

```
data/
├── annotator.db        # SQLite 主库（WAL 模式另有 -wal/-shm 文件）
├── uploads/            # 按平面图 id 命名的编辑态原图 1.png / 1.jpg ...
└── snapshots/          # 已发布巡检版的冻结原图（按发布记录 id 命名，永不随换图改变）
```

> 备份：停止写入后复制整个 `DATA_DIR` 即可；也可以直接使用应用内的「导出整图 JSON」。

---

## 四、使用说明

1. 首页**上传平面图**（PNG/JPEG），或**导入整图 JSON**。
2. 打开图纸后：
   - **滚轮**以光标为中心缩放；**拖动空白处**平移；工具栏可放大/缩小/适应窗口/1:1。
   - 点击 **绘制新区域**：在图上**单击**逐个添加顶点，拖空白处仍可平移；
     **双击 / 回车**闭合多边形，`Esc` 取消。
   - 闭合后可拖动顶点修改形状（边中点的小手柄可插入新顶点），
     填写**唯一编号**与**风险等级**（低 / 中 / 高风险）后保存。
   - 点击已有区域或左侧列表可选中编辑；保存 / 删除均带版本号。
3. **导出整图 JSON**：单文件自包含（原图 base64 + 尺寸 + 区域 + 双方版本号），
   可在另一台机器导入恢复；同名平面图不会被覆盖，导入时可指定新名称。
4. **发布只读巡检版**：编辑器下方「只读巡检版」面板点击 **🔒 发布巡检版**，
   即把当前**所见图纸版本**的原图与全部未删除区域（编号、风险等级、原图坐标）冻结为一个巡检版。
   - 发布后在面板中得到按序号排列的历史版本，点「查看」打开只读巡检页
     （`/inspector.html?plan=<图纸ID>&seq=<发布序号>`，`seq` 省略即为最新版），
     可把链接直接发给巡检人员；页面只有缩放/平移与版本切换，没有任何编辑入口。
   - 列表页与编辑器面板在未发布时明确提示「暂无巡检版」。
   - 发布请求携带所见图纸版本：期间图纸被改动会收到 **409 版本冲突**，不留下任何半成品快照；
     同一图纸版本重复发布为幂等操作，不会产生重复巡检版。
   - 发布后再编辑、删区或**同尺寸换图**，均不改变任何已发布巡检版：巡检版原图是
     `data/snapshots/` 下的独立副本，与编辑中的原图隔离。

多人协作：页面每 3 秒轮询一次最新数据。图纸与区域有任何变化都会收到提示，
区域列表与图纸版本实时刷新；正在编辑的草稿不会被刷新覆盖。

---

## 五、校验与冲突规则（需求实现说明）

### 形状校验（前后端使用同一份 `shared/geometry.js`，服务端为最终裁决）

保存、编辑、导入时都会拒绝下列形状，响应中给出**具体中文原因**：

- **自交**：非相邻边交叉、顶点触碰非相邻边（蝴蝶结等），即使是凹多边形只要简单多边形也允许；
- **越界**：任一顶点超出原图边界 `0..width / 0..height`，报错带顶点序号与坐标；
- **退化**：少于 3 个顶点、顶点重复、全部共线（面积为零）；
- **重叠**：与同一图上已有区域有任何面积重叠，或仅仅**边界相触**（共边、共角、顶点落在对方边上、包含、穿插），
  错误信息会指出冲突的对方编号与 id。

顶点保存前统一四舍五入到 0.001 像素；边界坐标 `0` 与 `width/height` 本身合法。

### 基于版本的并发控制（乐观锁）

- 每个**区域**有独立 `version`，每次保存 +1；每个**图纸**也有 `plan_version`，
  任何区域增删改都会 +1。
- 保存时必须带上编辑时所依据的 `version` 与 `plan_version`：
  - 区域已被他人更新 → **409 `VERSION_CONFLICT`**，提示双方版本号；
  - 图纸其他部分已被他人改动 → **409 `PLAN_VERSION_CONFLICT`**。
- 冲突时**未提交的编辑（编号、等级、所有顶点）原样保留在表单与画布上**，
  响应同时附带服务端最新快照，客户端自动刷新其他区域供比对合并。
- 删除同样校验版本，避免在不知情时删掉他人的新修改。
- 删除为**软删除墓碑**：区域对已删除区域的旧版本提交一律返回 **410 `REGION_DELETED`**，
  **无法再通过旧提交恢复**；界面可选择放弃，或把当前顶点转为「新建区域」重新保存。
  编号在删除后允许复用。

### 只读巡检版（发布快照）

- **冻结内容**：发布瞬间的原图副本 + 全部**未删除**区域的**编号、风险等级、原图坐标**；
  区域自身版本号、内部 id、已删除墓碑均不进入巡检版。
- **发布序号**：每张图纸独立从 1 递增（#1、#2…），序号一旦分配不复用、不改变。
- **乐观锁**：`POST` 必须带 `plan_version`（发布人所见版本）。
  - 与当前版本不一致 → **409 `PLAN_VERSION_CONFLICT`**，响应附服务端最新快照；
    发布整体中止，**不写巡检版记录、不写快照文件、不留临时文件**。
  - 同一 `plan_version` 重复发布 → **幂等**：HTTP 200 且 `reused=true`，
    返回首次发布的同一巡检版，**绝不产生重复版本**。
- **冻结保证**：发布记录写入与快照原图复制在同一个 SQLite 事务内完成
  （文件先写临时文件再原子改名，失败即回滚并清理）。之后的区域增删改、图纸改名、
  同尺寸替换原图，都只作用于编辑态数据；巡检版永远读取 `data/snapshots/<发布记录id>.png`
  的独立副本。
- **失败明确**：原图缺失 → **410 `IMAGE_MISSING`**；快照保存失败（磁盘满/权限）→
  **500 `SNAPSHOT_SAVE_FAILED`**；二者都不会记为发布成功（列表中无新增、序号不前进）。
- **未发布提示**：从未发布时，列表接口返回 `count: 0 / latest_seq: null`，
  `latest` 与任意序号详情返回 **404 `NO_PUBLICATION`**，巡检页显示「暂无巡检版」。

### 导出 / 导入的一致性与原子性

- 导出保留：原图、`width/height` 尺寸、全部区域（编号、风险等级、顶点原图坐标）、
  图纸版本与每个区域的版本号。
- 导入在**任何写入之前**完成全部校验：JSON 合法性、格式标识、尺寸、图片完整性、
  顶点范围、自交、文件内编号唯一、区域两两不重叠、版本号合法。
- 落库在单个 SQLite 事务内完成，图片先写临时文件再原子改名；
  **图片损坏或导入数据无效时，不会产生任何平面图、区域或半成品文件**。
- 上传损坏 / 截断 / 伪装的 PNG、JPEG 同样在写库前被拒绝，不留垃圾记录。

---

## 六、HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/plans` | multipart 上传 `image`（PNG/JPEG）与可选 `name` 新建图纸 |
| `GET` | `/api/plans` | 图纸列表 |
| `GET` | `/api/plans/:id` | 图纸详情（尺寸、图纸版本、全部区域） |
| `GET` | `/api/plans/:id/image` | 原图 |
| `PUT` | `/api/plans/:id` | 改名 / 替换原图（新图必须与原图**同尺寸**） |
| `POST` | `/api/plans/:id/regions` | 新建区域（`code`,`risk_level`,`vertices`,`plan_version`） |
| `PUT` | `/api/plans/:id/regions/:rid` | 更新区域（额外带区域 `version`） |
| `DELETE` | `/api/plans/:id/regions/:rid?version=&plan_version=` | 删除区域 |
| `GET` | `/api/plans/:id/export` | 下载整图 JSON |
| `POST` | `/api/import/file` | multipart 上传导出 JSON（可选 `name` 覆盖名称） |
| `POST` | `/api/plans/:id/publications` | 发布只读巡检版（body 带 `plan_version`；同版本幂等） |
| `GET` | `/api/plans/:id/publications` | 巡检版列表（`latest_seq`、按序号倒序的摘要） |
| `GET` | `/api/plans/:id/publications/latest` | 最新巡检版完整快照（未发布 → 404 `NO_PUBLICATION`） |
| `GET` | `/api/plans/:id/publications/:seq` | 按发布序号查看旧版完整快照 |
| `GET` | `/api/plans/:id/publications/:seq/image` | 该巡检版冻结原图（`:seq` 可为 `latest`） |
| 页面 | `/inspector.html?plan=<id>[&seq=<序号>]` | 只读巡检页（省略 `seq` 看最新版） |

顶点坐标格式：`vertices: [{"x": 120.5, "y": 88}, ...]`，均为**原图像素坐标**。
错误响应统一为：`{"error":"CODE","message":"中文原因", ...}`，冲突/删除响应另带 `server` 最新快照。

巡检版快照 JSON 形如：

```json
{
  "publication": {
    "id": 3, "plan_id": 1, "seq": 2, "plan_version": 4,
    "plan_name": "1号馆", "width": 300, "height": 200,
    "image_mime": "image/png", "region_count": 1, "published_at": "2026-10-06 01:24:47",
    "regions": [
      { "code": "A-01", "risk_level": "高风险",
        "vertices": [{"x":10,"y":10}, {"x":80,"y":10}, {"x":80,"y":80}, {"x":10,"y":80}] }
    ]
  }
}
```

### 巡检版调用示例（curl）

```bash
# 1) 发布：必须携带发布人当前所见的图纸版本（从 GET /api/plans/:id 的 plan.version 得到）
curl -X POST http://localhost:8080/api/plans/1/publications \
  -H 'Content-Type: application/json' -d '{"plan_version": 4}'
# 首次发布 → 201 {"publication":{"seq":2,...},"reused":false,...}
# 同一版本再发一次 → 200 {"reused":true,"publication":{"seq":2,...}}（不产生重复版本）
# 期间图纸已改动 → 409 PLAN_VERSION_CONFLICT（无任何部分快照）

# 2) 查看最新巡检版（页面与 API 均可）
curl http://localhost:8080/api/plans/1/publications/latest
# 浏览器打开只读页： http://localhost:8080/inspector.html?plan=1

# 3) 按发布序号查看某个历史旧版（JSON / 冻结原图 / 只读页）
curl http://localhost:8080/api/plans/1/publications/1
curl -o pub1.png http://localhost:8080/api/plans/1/publications/1/image
# 浏览器： http://localhost:8080/inspector.html?plan=1&seq=1

# 4) 未发布时 → 404 {"error":"NO_PUBLICATION", "message":"图纸「…」暂无巡检版，尚未发布过"}
```

---

## 七、目录结构

```
.
├── Dockerfile                 # 单镜像构建（含原生模块编译兜底）
├── docker-compose.yml         # 一键启动 + 卷持久化 + 健康检查
├── docker/entrypoint.sh       # 容器入口：先迁移数据库再启动
├── package.json
├── server/
│   ├── app.js                 # Express 路由、事务、版本/冲突、导出导入、巡检版发布
│   ├── config.js              # 环境变量配置
│   ├── db.js                  # SQLite 初始化 / 建表（可独立 npm run migrate）
│   └── image.js               # 纯 Node 解析 PNG/JPEG 尺寸与损坏检测
├── shared/
│   └── geometry.js            # 自交/越界/重叠校验（前后端共用）
├── public/
│   ├── index.html             # 单页界面（列表 + SVG 编辑器 + 发布面板）
│   ├── inspector.html         # 只读巡检页（按发布序号查看旧版/最新版）
│   ├── inspector.js           # 巡检页：冻结快照渲染 + 缩放/平移/版本切换
│   ├── styles.css
│   └── app.js                 # 缩放/平移/绘制/冲突保留/轮询协作/发布交互
└── tests/
    ├── geometry.test.js       # 几何规则单元测试
    └── publications.test.js   # 巡检版发布/幂等/冲突/冻结不变性 端到端测试
```

## 八、常见问题

- **换端口后打不开？** 容器内固定 8080；宿主机端口用 `APP_PORT` 控制。直接 Node 运行时用 `PORT`。
- **局域网其他设备访问？** Node 直跑设 `HOST=0.0.0.0`，防火墙放行对应端口后用 `http://<本机IP>:端口`。
- **上传大文件被拒？** 调大 `MAX_UPLOAD_MB`（导入 JSON 因含 base64 图片，限额自动更高）。
- **想清空全部数据？** `docker compose down` 后删除宿主机 `./data` 目录即可。
