# MissV Ops Web Platform — Design Spec

**Date:** 2026-04-23
**Status:** Approved
**Author:** Brainstorming session

---

## 1. 概述

将 MissV Ops 的全部运营功能（slash 命令、选题审核、竞品管理、爆款知识库等）做成运营友好的 Web 查阅平台。多名运营人员通过浏览器共享访问，无需账号体系。

### 目标

- 让运营无需进入终端，通过 Web UI 完成所有日常 ops 操作
- 可视化呈现选题队列、热点趋势、竞品动态、爆款知识库
- 支持运营直接在 Web 上添加/编辑竞品、审核选题、触发 AI 生成

### 不在范围内

- 用户账号/权限体系（共享 Token 鉴权即可）
- 移动 App（Web 响应式已足够）
- 直接发帖到社交平台（仍由 OpenClaw heartbeat 负责）
- 修改 persona.yaml 以外的系统配置

---

## 2. 系统架构

### 双仓库 + 双机器部署

```
┌─────────────────────────────────┐         ┌─────────────────────────────────┐
│  Alive 机器（原有）               │         │  Web 平台机器（新）               │
│                                 │         │                                 │
│  OpenClaw + heartbeat cron      │  HTTPS  │  missv-ops-web 仓库             │
│                                 │ ──────► │  Vite + React + TypeScript      │
│  Alive 仓库 新增:                │ X-API-Key│  Tailwind CSS                  │
│  alive/api-server/              │         │  TanStack Query                 │
│    Express.js + TypeScript      │         │  Nginx 静态托管                  │
│    直接 import ops 模块           │         │                                 │
│    读写 ~/.openclaw 文件          │         │  env: VITE_API_BASE_URL         │
│    port 3001, pm2 守护           │         │                                 │
└─────────────────────────────────┘         └─────────────────────────────────┘
```

### 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 前端框架 | Vite + React + TypeScript | 轻量 SPA，构建产物静态托管，无 SSR 复杂度 |
| 后端位置 | Alive 仓库内 `alive/api-server/` | 直接 import 现有 ops TypeScript 模块，零重写 |
| 数据访问 | 直接读写 `~/.openclaw/workspace/memory/` | 零延迟，无额外进程，文件已有 .bak 备份保护 |
| 鉴权 | `X-API-Key` HTTP Header + 环境变量配置 | 简单可靠，满足共享访问需求，无需账号体系 |
| 重量级操作 | `child_process` 调用 `ops-command-handler.js` | /brief、/idea、/analyze 需要 LLM，复用现有入口 |

---

## 3. 仓库结构

### Alive 仓库新增（`alive/api-server/`）

```
alive/api-server/
├── server.ts              # Express 入口，挂载所有路由，启动 port 3001
├── middleware/
│   └── auth.ts            # X-API-Key 鉴权中间件
├── routes/
│   ├── queue.ts           # 选题队列 CRUD
│   ├── trends.ts          # 热点趋势读取
│   ├── competitors.ts     # 竞品管理 CRUD
│   ├── viral-kb.ts        # 爆款知识库查询
│   ├── brief.ts           # 简报生成（调用 CLI）
│   ├── analyze.ts         # 爆款拆解（调用 CLI）
│   ├── advice.ts          # 人设建议（调用 CLI）
│   └── status.ts          # 队列状态概览
└── package.json           # 独立依赖：express, cors, tsx
```

**重要约束：** `api-server/` 只能 import `alive/scripts/` 内的模块；不引入任何前端代码；不修改现有 ops 模块逻辑。

### missv-ops-web 仓库（新建独立仓库）

```
missv-ops-web/
├── src/
│   ├── api/
│   │   └── client.ts          # axios 实例，注入 X-API-Key，统一错误处理
│   ├── pages/
│   │   ├── Brief.tsx          # 今日简报
│   │   ├── Queue.tsx          # 选题队列（列表+详情双列）
│   │   ├── Trends.tsx         # 热点趋势
│   │   ├── Competitors.tsx    # 竞品管理（列表+详情双列）
│   │   ├── ViralKB.tsx        # 爆款知识库（列表+6维详情）
│   │   └── Advice.tsx         # 人设建议
│   ├── components/
│   │   ├── layout/
│   │   │   ├── TopNav.tsx     # 顶部 Tab 导航
│   │   │   └── Layout.tsx     # 页面容器
│   │   ├── queue/
│   │   │   ├── QueueList.tsx
│   │   │   ├── QueueItem.tsx
│   │   │   └── QueueDetail.tsx
│   │   ├── competitors/
│   │   │   ├── CompetitorList.tsx
│   │   │   ├── CompetitorCard.tsx
│   │   │   ├── CompetitorDetail.tsx
│   │   │   └── CompetitorForm.tsx  # 添加/编辑表单
│   │   ├── viral-kb/
│   │   │   ├── EntryList.tsx
│   │   │   ├── EntryDetail.tsx     # 6维拆解卡片
│   │   │   └── FormulaList.tsx     # UniversalFormula
│   │   └── shared/
│   │       ├── TagBadge.tsx
│   │       ├── VelocityBar.tsx     # 速度分进度条
│   │       └── FreshnessBanner.tsx # 缓存新鲜度提示
│   ├── hooks/
│   │   ├── useQueue.ts
│   │   ├── useTrends.ts
│   │   ├── useCompetitors.ts
│   │   └── useViralKB.ts
│   ├── types/
│   │   └── api.ts              # API 响应类型定义（与后端对齐）
│   └── main.tsx
├── .env.example                # VITE_API_BASE_URL=https://alive-api.example.com
├── vite.config.ts
└── package.json
```

---

## 4. API 设计

Base URL: `https://<alive-machine>/api`
鉴权: 所有请求携带 `X-API-Key: <token>` Header

### 端点列表

| Method | Path | 操作 | 实现方式 |
|--------|------|------|----------|
| GET | `/queue` | 读取审核队列 | 直接读 `review-queue.json` |
| POST | `/queue/idea` | 生成新选题 | 调用 `ops-command-handler.js idea` |
| POST | `/queue/review` | 批量审核 | 调用 `ops-command-handler.js review [sub]` |
| POST | `/queue/:id/approve` | 通过选题 | 调用 `markApproved()` |
| POST | `/queue/:id/discard` | 弃置选题 | 调用 `markDiscarded()` |
| PUT | `/queue/:id` | 修改选题字段 | 直接写 `review-queue.json` |
| GET | `/trends` | 读热点缓存 | 直接读 `trend-cache.json` |
| GET | `/competitors` | 读竞品列表 | 读 `competitor-log.json` + persona.yaml |
| POST | `/competitors` | 添加竞品 | 写入 `competitors-override.json` |
| PUT | `/competitors/:id` | 编辑竞品 | 更新 `competitors-override.json` 对应条目 |
| DELETE | `/competitors/:id` | 删除竞品 | 从 `competitors-override.json` 移除 |
| POST | `/analyze` | 爆款拆解 | 调用 `ops-command-handler.js analyze <url>` |
| GET | `/viral-kb` | 读爆款条目 | 直接读 `viral-kb/entries.json` |
| GET | `/viral-kb/formulas` | 读通用公式 | 直接读 `viral-kb/formulas.json` |
| GET | `/brief` | 生成今日简报 | 调用 `ops-command-handler.js brief` |
| GET | `/advice` | 人设建议报告 | 调用 `ops-command-handler.js advice` |
| GET | `/status` | 队列状态概览 | 直接读 `review-queue.json` 聚合 |

### LLM 操作超时处理

`/brief`、`/idea`、`/analyze`、`/advice` 均通过 `child_process.spawn` 调用 CLI，设置 360s 超时。前端使用 TanStack Query 的 `staleTime` 缓存结果，避免重复触发。

---

## 5. 页面设计

### 全局布局

顶部固定 Tab 导航（B 方案）：

```
[MissV Ops]  [📋 简报]  [💡 选题]  [🔥 热点]  [👥 竞品]  [🏆 爆款库]  [🎯 建议]
──────────────────────────────────────────────────────────────────────────────
                            当前页面内容
```

配色方案：深色背景（`#0d0d1a`），强调色红（`#e94560`）、绿（`#00d4aa`）、紫（`#a64dff`）、橙（`#f0a500`）。

### 5.1 今日简报（Brief）

**布局：** 全宽单列

- 顶部 4 个数字卡片：待审核 / 今日发布 / 热点数 / 爆款入库
- 三栏内容区：热点摘要 | 待审核预览（点击跳转选题页）| AI 主动建议
- 右上角「生成/刷新简报」按钮，触发 `GET /brief`（长操作，显示 loading）
- 缓存新鲜度 Banner（热点数据 / 竞品数据各自显示更新时间）

### 5.2 选题队列（Queue）

**布局：** 左列表（280px）+ 右详情面板（flex-1）

**左侧列表：**
- 顶部工具栏：待审核数量统计 / 生成新选题 / AI 批量审核 / 全部通过
- 条目按状态分组：待审核（正常显示）→ 已发布（灰显）
- 每条显示：状态 Badge / 身份 Tag / 标题 / 热点钩子 + 速度分 + 时间

**右侧详情面板：**
- 标题 + Tags（身份、速度分、Hook 类型）
- 操作按钮：✓ 通过 / ✏ 修改 / ✕ 弃置
- 热点钩子卡片（橙色）
- XHS / 抖音 Tab 切换，展示对应文案内容
- 参考竞品（紫色卡片）
- 图片 Prompt（若有）

**修改流程：** 点击「✏ 改」弹出内联编辑区，直接修改标题/文案，保存调用 `PUT /queue/:id`。

### 5.3 热点趋势（Trends）

**布局：** 左主列表（flex-1）+ 右信号池概览（160px）

**左侧：**
- 按 bucket 分组：🏷️ 推荐流 / 📰 热榜 / 🔍 搜索
- 每条热点：速度分进度条可视化（颜色按阈值变化：>2x 红 / >1.5x 橙 / 其他蓝）
- 每条右侧「出选题」按钮，触发 `POST /queue/idea` 并跳转到选题页

**右侧：** 信号池概览，分 bucket 列出 top 5 关键词和速度分

**顶部：** 缓存时间 + 手动「刷新」按钮

### 5.4 竞品管理（Competitors）

**布局：** 左列表（260px）+ 右详情/编辑面板（flex-1）

**左侧列表：**
- 顶部 Tag 过滤器（按 group/tag 分类）
- 每张竞品卡片：头像缩写 / 平台 / 今日更新状态 / 内容比例 Tags
- 拉取失败的账号灰显，标注「拉取失败」
- 「＋ 添加竞品」按钮

**右侧详情面板：**
- 账号名 + 平台链接（可跳转）
- 内容混合比例彩色条形图
- 受众画像 + 互动风格（2列卡片）
- 可学习要点（绿色卡片）/ 避坑点（红色卡片）
- 最近内容列表，每条有「拆解分析」按钮（触发 `/analyze`，结果展示在弹出层）
- 「✏ 编辑」打开同页内联表单，修改所有字段后调用 `PUT /competitors/:id`

**竞品数据来源合并策略：**
- `persona.yaml` 里的 `ops.competitors[]` 作为**只读基准**（随代码版本管理）
- `competitors-override.json`（存放在 `{MEMORY_BASE}/competitors-override.json`）保存运营通过 Web 添加/编辑的竞品
- API Server 读取时将两者合并，override 文件中的条目以 `name + platform` 为 key 覆盖 yaml 基准；删除操作在 override 文件中标记 `_deleted: true`
- 这样 persona.yaml 永远不被 Web 平台修改，重新部署也不会丢失运营录入的竞品

**添加竞品表单：** 侧边滑入抽屉，字段：平台 / URL / 账号名 / Tag / 分组 / 内容比例 / 受众 / 互动风格 / 可学习 / 避坑点

### 5.5 爆款知识库（Viral KB）

**布局：** 两个子 Tab — 「条目库」/ 「通用公式」

**条目库 Tab：**
- 左列表（260px）+ 右 6 维拆解详情（flex-1）
- 筛选栏：Hook 类型 / 身份模式 / 排序（点赞↓ / 入库时间↓）
- 每条条目：身份 Tag / likes 数 / 标题 / Hook Tag / 平台
- 右侧 6 维拆解 3×2 卡片网格：钩子类型 / 内容类型 / 身份模式 / 情绪弧线 / 互动设计 / 视觉风格
- 底部 AI 拆解摘要文本

**通用公式 Tab：**
- 卡片网格展示 UniversalFormula
- 每张公式卡：平台 + 内容类型 + Hook 类型（自动晋升条件：同 platform+content_type+hook_type ≥3 次）
- 显示出处条目数量和最后更新时间

### 5.6 人设建议（Advice）

**布局：** 全宽单列

- 顶部「生成建议」按钮（触发 `GET /advice`，LLM 操作，显示 loading）
- 人设对齐报告卡片（按身份维度分段）
- 身份匹配度评分（进度条展示各维度匹配度）
- 竞品对比参考（表格形式）
- 主动建议列表（绿色高亮卡片）
- 缓存新鲜度 Banner

---

## 6. 数据流与状态管理

### TanStack Query 配置

```
查询键策略:
  ['queue']          → staleTime: 30s，每 30s 自动轮询
  ['trends']         → staleTime: 5min（缓存本身已是热点数据）
  ['competitors']    → staleTime: 2min
  ['viral-kb']       → staleTime: 10min（变化慢）
  ['brief']          → staleTime: 0（每次手动触发）
  ['advice']         → staleTime: 0（每次手动触发）
```

### 乐观更新

选题的通过/弃置操作使用乐观更新：立即更新本地 cache，后台发请求，失败时回滚并 toast 提示。

---

## 7. 鉴权方案

**API Server 端：**
- 所有路由通过 `auth.ts` 中间件校验 `X-API-Key` Header
- Token 存在 Alive 机器环境变量 `OPS_API_KEY`
- 校验失败返回 `401 Unauthorized`

**前端端：**
- Token 存在 `.env` 文件 `VITE_API_KEY`（构建时注入，或运行时从 `localStorage` 读取）
- `client.ts` axios 拦截器自动注入 Header

**网络安全：**
- API Server 建议只监听内网或通过 Nginx 反代加 HTTPS
- 前端静态资源通过 Nginx 托管，可加 Basic Auth 做额外保护

---

## 8. 部署方案

### Alive 机器

```bash
# 安装 api-server 依赖
cd alive/api-server && npm install

# pm2 启动
pm2 start dist-api/server.js --name alive-api-server
pm2 save

# Nginx 反代（可选，建议加 HTTPS）
# proxy_pass http://127.0.0.1:3001
```

### Web 平台机器

```bash
# 构建
VITE_API_BASE_URL=https://alive-api.example.com \
VITE_API_KEY=<token> \
npm run build

# Nginx 托管静态文件
# root /var/www/missv-ops-web/dist
# try_files $uri $uri/ /index.html
```

### 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `OPS_API_KEY` | Alive 机器 `.env` | API Server 鉴权 Token |
| `VITE_API_BASE_URL` | Web 机器构建时 | Alive API Server 地址 |
| `VITE_API_KEY` | Web 机器构建时 | 与 `OPS_API_KEY` 相同值 |

---

## 9. 错误处理

- **API 超时（LLM 操作）：** 前端显示 loading spinner + 「操作需要 30-120 秒，请稍候」提示，超时后 toast 错误
- **缓存为空（cold cache）：** 显示「数据正在加载，cron 将在 X 分钟内完成首次抓取」Banner
- **竞品拉取失败：** 列表中灰显，标注「拉取失败」，不阻断其他操作
- **API 401：** 全局拦截，显示「访问密钥无效」，提示检查配置
- **网络断开：** TanStack Query 自动重试 3 次，失败后显示离线 Banner

---

## 10. 技术选型汇总

### missv-ops-web

| 类别 | 选型 |
|------|------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 数据获取 | TanStack Query v5 |
| HTTP | axios |
| 路由 | React Router v6（Hash 模式，适配 Nginx try_files） |
| 图标 | lucide-react |
| Toast | react-hot-toast |

### alive/api-server

| 类别 | 选型 |
|------|------|
| 框架 | Express.js 4 |
| 语言 | TypeScript（tsx 直接运行，或编译到 dist-api/） |
| 跨域 | cors（限制 Web 平台域名） |
| 进程管理 | pm2 |

---

## 11. 实现顺序建议

1. **Alive 仓库：** `api-server/` 骨架 + 鉴权中间件 + `/status` 端点（验证联通性）
2. **missv-ops-web：** Vite 项目初始化 + TopNav + `client.ts` + `/status` 联调
3. **选题队列：** `GET /queue`、`POST /queue/:id/approve`、`POST /queue/:id/discard`（核心高频操作）
4. **热点趋势：** `GET /trends`（纯读，快速实现）
5. **今日简报：** `GET /brief`（LLM 操作，加 loading 处理）
6. **竞品管理：** CRUD 全套 + 表单
7. **爆款知识库：** 条目库 + 通用公式
8. **人设建议：** `GET /advice`（LLM 操作）
9. **细化：** 乐观更新、轮询、错误处理、缓存 Banner
