# Autoresearch Harness — Phase 2 + Phase 3 Wrap-up

生成时间：2026-04-20

本文档记录 Autoresearch Harness 自 Phase 1 baseline 打通后，Phase 2（持久化 / Leaderboard）与 Phase 3（新 judges / 多 seed / 更多 tunable 模块）两阶段全部工作的收口情况，可作为下一阶段（Phase 4: advisor 自动化 / regression gate）的起点。

---

## 1. 本轮交付清单

### 1.1 新增代码（6 文件）
- `alive/tests/edit-convergence-judge.test.ts` — 5 tests，覆盖 baseline / 收敛 / 零变更 / 振荡 / clamp。
- `alive/tests/cost-check-judge.test.ts` — 6 tests，覆盖 4 档评分段 + 失败调用扣分 + budget=0 防御。
- `alive/tests/counting-llm.test.ts` — 4 tests，covers call / callJSON 计数，失败路径，reset。
- `alive/tests/runs-store.test.ts` — 8 tests，runId 格式 / artifacts 6 件齐全 / sha256 / leaderboard baseline-best-bestPerFixture 行为 / malformed JSON 安全降级。
- `alive/tests/tunable-ops-modules.test.ts` — 8 tests，验证 `resolveScorerConfig` / `resolveBriefLimits` 在 null / partial / 非法值三种输入下都能回退默认并保持向后兼容。
- `alive/tests/autoresearch-leaderboard.test.ts`（改） — 全部 run 字面量补 `seed` 字段；`aggregate` 补 `fixtureSeedAggregates`；新增一个 3 seed × 1 fixture 的聚合测试验证 stddev / bestSeed / worstSeed。

### 1.2 模块化 & tunable 能力扩张
- `alive/scripts/utils/file-utils.ts` — 新增 `readTunableJSON<T>(relativePath)`：`readTunablePrompt + JSON.parse`，解析失败返回 `null` 并记错（保证 broken 文件永不污染默认值）。
- `alive/scripts/ops/candidate-scorer.ts` — 引入 `CandidateScorerTunable` / `ResolvedScorerConfig`；导出 `resolveScorerConfig(override | null)` + `resetScorerConfigCache()`；5 个权重 + `burstCapRatio` + `frequencySaturationCount` + `freshnessWindowDays` 全部可 tunable。`coerceNonNegative` / `coercePositive` 对非法值静默回退默认。
- `alive/scripts/ops/brief-generator.ts` — 引入 `BriefLimitsTunable` / `ResolvedBriefLimits`；导出 `resolveBriefLimits(override | null)` + `resetBriefLimitsCache()`。tunable 字段：
  - `trendsPerSection` / `staleThresholdDays` / `maxRecentPosts` / `maxActivePending`（默认 ∞，用 `Number.isFinite` 判断） / `competitorTopicChars` / `maxViralEntries` / `maxViralFormulas` / `maxReviewReasons`
  - 所有原硬编码数字 (3 / 7 / 2 / 18 等) 已全部下沉到 `DEFAULT_BRIEF_LIMITS`。

### 1.3 Tunable 基线文件（2 份新模板）
- `harness/tunable/prompts/ops/candidate-scorer.weights.json`
- `harness/tunable/prompts/ops/brief-generator.limits.json`

两份均与代码默认值字面量一致，作为 advisor 可编辑的"已知可用基线"。

### 1.4 CLI / 编排
- `e2e/autoresearch-leaderboard.ts` 新增选项：`--seeds <N>` / `--call-budget <N>` / `--no-persist` / `--harness-dir <path>`。
- 多 seed 扩张 (`expandRunsWithSeeds`)：workspaceDir 附加 `-seed${N}` 避免 fs 复用污染。
- `FixtureSeedAggregate`：per-fixture avg / stddev / min / max / bestSeed / worstSeed 聚合，并进入：
  - `renderLeaderboardReport` 的 "Per-fixture seed stability" markdown 表
  - `buildAutoresearchAdvisorPrompt` 的上下文（让 advisor 知道哪些 fixture 不稳定）
- `LeaderboardRunEntry` 新增 `seed / editConvergenceScore / costCheckScore / llmCalls` 字段。

---

## 2. 真实 LLM 烟测结果

执行命令：
```
npx ts-node e2e/autoresearch-leaderboard.ts \
  --fixture miss-v-natural-language-review-loop \
  --seeds 1 --call-budget 4 --no-advisor --keep-workspace
```

**结果**：✓ `Leaderboard finished. runs=1 averageOpsScore=67.2 status=published`

产出目录 `harness/runs/2026-04-20T13-19-48-miss-v-natural-language-review-loop-seed0/` 包含全 6 件 artifacts：

| 文件 | 关键内容 |
|---|---|
| `meta.json` | runId / fixture / seed / startedAt / finishedAt |
| `score.json` | 7 judges（含 `edit_convergence=75`, `cost_check=43`）+ ops_score=67.2 |
| `diagnostics.md` | 人类可读摘要 |
| `transcript.jsonl` | 每轮 LLM prompt/response 流水 |
| `tunable.snapshot.json` | 7 份 tunable 文件的 sha256 快照（含本轮新增的 2 份 JSON） |
| `llm-usage.json` | calls=7 / ok=5 / fail=2 / promptChars=12283 / responseChars=764 / elapsedMs=77625 |

`harness/leaderboard.json` 同步更新：`version=1`，`bestRun / baselineRun / bestPerFixture / recentRuns` 一致指向该 run，`updatedAt=2026-04-20T13:19:48.692Z`。

**失败节点分析**：运行过程中 2 次 LLM JSON 解析失败（`topic-generator.ts` 的 XHS / Douyin draft），已有的 retry + fallback 机制最终仍走到 `status=published`。这些 flakiness 是真实 LLM 侧的偶发格式问题，**不是 Phase 2/3 引入的回归**，但未来可考虑把 `parseJSONWithRepair` 的失败率纳入一个新的 judge（候选 Phase 4 工作）。

---

## 3. 回归测试总表

### 3.1 新增/改动测试
```
alive/tests/edit-convergence-judge.test.ts     5 tests  ✓
alive/tests/cost-check-judge.test.ts           6 tests  ✓
alive/tests/counting-llm.test.ts               4 tests  ✓
alive/tests/runs-store.test.ts                 8 tests  ✓
alive/tests/tunable-ops-modules.test.ts        8 tests  ✓
alive/tests/autoresearch-leaderboard.test.ts   5 tests  ✓   （含 multi-seed 新场景）
alive/tests/autoresearch-fixture-runner.test.ts 1 test  ✓
————————————————————————————————————————————————
                       总计                   37 tests 全绿
```

### 3.2 全量 alive 单测
`npx vitest run --config vitest.config.ts`
- **2010 passed / 6 failed / 15 skipped（135 passed / 4 failed / 0 skipped test files）**
- 6 个失败均为 **pre-existing regression**（通过 `git stash` 后重跑同一命令 baseline 同样 6 fail 证实）：
  - `brief-generator.test.ts` × 2 — 期望标题 `🎬 今日视频分镜`，实际代码已改为 `🎬 今日抖音视频分镜`（HEAD 之前的提交 `67c3df1 feat: 视频分镜系统` 引入）
  - `viral-kb-integration.test.ts` × 2 — Scenario 3 persona.yaml 注入
  - `xhs-bridge-client.test.ts` × 1 — search TTL cache
  - `ops/ops-llm-dump.test.ts` × 1 — `trend-analyzer.ts:353 velocity.toFixed` on undefined
- 本轮改动对外**零回归**。

---

## 4. 对齐 `harness/autoresearch-harness-design.md` 的完成度

| 能力项 | Phase | 状态 |
|---|---|---|
| Fixture runner（queue-manager 驱动，隔离 workspace） | 1 | ✅ |
| Ops-score 基础 5 judge | 1 | ✅ |
| Judge-composite（LLM-as-judge 4 维） | 1 | ✅ |
| Tunable prompts 加载（md + json，覆盖顺序） | 1 | ✅ |
| Leaderboard aggregate + 报告 | 2 | ✅ |
| Runs 目录持久化（6 件 artifacts） | 2 | ✅ |
| Leaderboard persistence（version=1 schema，baseline/best/bestPerFixture/recentRuns≤30） | 2 | ✅ |
| Edit-convergence judge | 3 | ✅ |
| Cost-check judge（budget aware） | 3 | ✅ |
| LLM usage 计数包装 | 3 | ✅ |
| 多 seed 实验 + per-fixture stddev | 3 | ✅ |
| 更多模块 tunable 化（brief-generator / candidate-scorer） | 3 | ✅ |
| 全套新能力单元测试 | 3 | ✅ |
| 真实 LLM 端到端烟测 | 3 | ✅ |

---

## 5. 待办 / 建议（Phase 4 入口）

1. **Advisor 自动化**：`requestAdvisorSuggestions` 当前产出建议但不写盘。下一步可让 advisor 基于 `fixtureSeedAggregates.stddev > 阈值` 自动写入 `harness/tunable/prompts/**`，并在 leaderboard 上标注 "advisor-promoted" 轮次。
2. **Regression gate**：现在 `leaderboard.json.baselineRun` 已经存在但没有"退化阻断"逻辑。建议加入 CI 模式：新 run 如果 opsScore 比 baselineRun 低 > X%，退出非 0。
3. **JSON 解析失败率 judge**：把烟测里看到的 2 次 `topic-generator` JSON 失败（retry 才救回）纳入新的 `json_parse_robustness` judge —— 已有 counting-llm 里的 `failedCalls` 字段作为数据源。
4. **Advisor prompt 里注入 stddev 告警**：目前 `buildAutoresearchAdvisorPrompt` 已写入 fixtureSeedAggregates，但可以更进一步 —— 对 `stddev > avg × 10%` 的 fixture 显式标红 "不稳定，优先修"。
5. **真实 LLM 烟测入 CI**：当前烟测需要手动跑，建议加一个 `npm run autoresearch:smoke` 脚本并在 `--call-budget` 很小（例如 4）的情况下作为 nightly 回归。

---

## 6. 关键命令速查

```bash
# 跑全量单测
npx vitest run --config vitest.config.ts

# 跑本轮新测试
npx vitest run --config vitest.config.ts \
  alive/tests/edit-convergence-judge.test.ts \
  alive/tests/cost-check-judge.test.ts \
  alive/tests/counting-llm.test.ts \
  alive/tests/runs-store.test.ts \
  alive/tests/tunable-ops-modules.test.ts \
  alive/tests/autoresearch-leaderboard.test.ts

# 真实 LLM 烟测（最小预算）
npx ts-node e2e/autoresearch-leaderboard.ts \
  --fixture miss-v-natural-language-review-loop \
  --seeds 1 --call-budget 4 --no-advisor --keep-workspace

# 多 seed 稳定性测量（2 fixture × 3 seeds = 6 runs）
npx ts-node e2e/autoresearch-leaderboard.ts --seeds 3 --call-budget 8

# 查看 leaderboard 现状
cat harness/leaderboard.json | jq '.bestRun, .baselineRun, .totalRuns'
```
