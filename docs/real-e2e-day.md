## `e2e-real-day` 使用说明

这个脚本用于**隔离地运行一次真实的一天循环 E2E**：

- **保留原有** `e2e/e2e-lifecycle.test.ts` 的 mock 行为不变
- **不做发帖兜底**，也**不做主动评论兜底**
- 只观察这些链路在一天循环里是否**自然触发并跑通**
- 业务状态仍写入 `e2e/sandbox/memory/minase`
- 真实副作用只会发生在当前已接入的平台桥接层

### 运行前提

- **显式风险开关**：必须设置 `MINASE_REAL_E2E=1`
- **Instagram 必填环境变量**：
  - `INSTAGRAM_USERNAME`
  - `INSTAGRAM_PASSWORD`
- **可选**：
  - `INSTAGRAM_TOTP_SECRET`
  - `IMGURL_TOKEN`
- **LLM / 图像相关密钥**：脚本会继续复用现有 `~/.openclaw/openclaw.json` 中的配置
- **XHS 只读链路**：需要当前机器上的小红书 CLI 已可用且已登录；否则会在摘要里记为失败或不可用

### 运行命令

```bash
MINASE_REAL_E2E=1 INSTAGRAM_USERNAME=... INSTAGRAM_PASSWORD=... npm run e2e:real-day
```

如果还需要 2FA：

```bash
MINASE_REAL_E2E=1 INSTAGRAM_USERNAME=... INSTAGRAM_PASSWORD=... INSTAGRAM_TOTP_SECRET=... npm run e2e:real-day
```

### 脚本行为

脚本会按压缩时间推进以下时间点：

- `07:00`：`runMorningPlan()`
- `08:00` - `22:00`：逐小时 `regularTick()`
- `23:00`：`runNightReflect()`

同时会保持以下运行策略：

- **Instagram mock 关闭**
- **XHS mock 关闭**
- **cron mock 保留开启**，避免改写真实 OpenClaw 定时任务
- **inline pipeline 开启**，便于在单进程内观察自然触发的真实发帖链路

### 默认种子状态

脚本会在沙箱里预置：

- 偏高的发帖冲动与较好的情绪状态
- 两个 `core/familiar` 级别的 Instagram 社交关系
- 强化过的偏好配置
- 空的 `inspiration.json`，让 morning plan 去做真实刷新

这些种子**只用于提高自然触发概率**，但脚本**不会手动补跑** `runPipeline()` 或 `engageOutbound()`。

### 链路状态说明

脚本最终会对下面这些链路分别给出状态：

- `instagramBrowse`
- `xhsBrowse`
- `instagramPost`
- `instagramOutboundComment`
- `instagramReplyComment`

状态只有三种：

- **`success`**：自然触发并产出了可核对证据
- **`not_triggered`**：本次运行中没有自然命中，或命中了检查但没有形成实际动作
- **`failed`**：链路执行时报错，或关键前置条件缺失

### 特别说明

- **未触发不等于失败**
- **不会为了覆盖率额外补触发发帖或评论**
- **回评链路**只有在运行开始时就存在已到期 `pending-engagement.json` 时，才有机会自然触发
- `IMGURL` 不是本次结果判定核心；它的问题会记录到日志，但不会直接把 Instagram 发帖链路判成失败

### 产物位置

每次运行都会把归档输出放到：

- `e2e/real-day-runs/<run-id>/`

其中包含：

- `live-summary.json`
- `live-summary.md`
- `state-snapshots/`
- `final-state/`
- `images/`

### 排查建议

- **脚本启动即拒绝运行**：检查 `MINASE_REAL_E2E=1` 是否已设置
- **Instagram 预检失败**：检查 `INSTAGRAM_USERNAME` / `INSTAGRAM_PASSWORD` / `INSTAGRAM_TOTP_SECRET`
- **XHS 只读失败**：检查本机 XHS CLI 是否已登录可用
- **发帖未触发**：优先看 `live-summary.md` 是否为 `not_triggered`，不要先按失败处理
- **主动评论未触发**：优先看 `instagram_trends.trending_hashtags` 和社交关系是否有有效证据
