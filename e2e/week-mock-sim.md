## `e2e:week-mock` 使用说明（仅模拟，不真实发帖）

该方案用于**快速模拟 Minase 一周（默认 7 天）**，并按天产出质量结果，最后生成周汇总。

- 全程复用 `e2e/e2e-lifecycle.test.ts`（mock 路径）
- 不走 `e2e:real-day`
- 每天产物独立归档，避免覆盖

---

## 一键运行

```bash
npm run e2e:week-mock
```

默认行为：

- 起始日期：`2026-06-15`
- 运行天数：`7`
- 每天会执行一次单日生命周期 E2E（mock）

---

## 可选参数

### 指定起始日期

```bash
MINASE_WEEK_START=2026-06-20 npm run e2e:week-mock
```

### 指定运行天数（例如先试跑 1 天）

```bash
MINASE_WEEK_DAYS=1 npm run e2e:week-mock
```

### 指定 run-id（便于复盘）

```bash
MINASE_WEEK_RUN_ID=week-exp-a npm run e2e:week-mock
```

可组合使用：

```bash
MINASE_WEEK_START=2026-06-20 MINASE_WEEK_DAYS=7 MINASE_WEEK_RUN_ID=week-exp-a npm run e2e:week-mock
```

---

## 产物目录

每次周模拟会输出到：

- `e2e/weekly-runs/<run-id>/`

目录结构示例：

- `day-01-YYYY-MM-DD/`
  - 该天完整 `e2e-output` 归档
  - `quality-report.json`
  - `quality-summary.md`
  - `lifecycle-log.json`
  - `day-result.json`
  - `vitest.stdout.log` / `vitest.stderr.log`（有输出时）
- `day-02-...` ~ `day-07-...`
- `weekly-summary.json`
- `weekly-summary.md`

---

## 如何看结果

优先看：

1. `weekly-summary.md`
   - 每天命令是否成功
   - 每天质量是否 overall pass
   - 各维度平均分（image / emotion / memory）
2. 某天目录下的 `quality-summary.md`
   - 该天具体失败原因与建议
3. `day-result.json`
   - 结构化状态，适合做二次分析

---

## 安全边界（重要）

### 本方案是 mock-only

周模拟调用的是 `e2e/e2e-lifecycle.test.ts`，会使用 mock 环境，不执行真实平台发帖链路。

### 不要用下面命令做“无副作用周模拟”

```bash
npm run e2e:real-day
```

`e2e:real-day` 是真实链路验证脚本，依赖 `MINASE_REAL_E2E=1`，并关闭 IG/XHS mock，不符合“仅模拟”目标。

---

## 设计说明（关键行为）

- 周脚本串行跑每天，避免并行覆盖（`initSandbox()` 会清理固定目录）
- 每天跑完立刻归档，保证失败日也能保留证据
- 单日失败不会中断整周，最终在周汇总中标记
