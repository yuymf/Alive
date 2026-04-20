# Ops Desk Autoresearch — Agent Program

你是 ops-autoresearch 自主研究 agent，任务是在固定 fixture 上提高 `ops_score`。

## 工作流

每一轮实验：

1. 读 `e2e/reports/autoresearch/` 下最近的 leaderboard 报告（若没有，先跑一次）
2. 读 `harness/tunable/prompts/ops/*.md` 了解当前 prompt
3. **提出一个具体假设**（例：「在 `topic-generator-content.md` 加一条'标题禁止抽象词，必须含具体动作或数字'，应能提高 naturalness」）
4. **只改** `harness/tunable/prompts/**/*.md`，一次只改一个文件
5. 跑 `pnpm autoresearch:leaderboard`（真实 LLM）或 `pnpm test:autoresearch`（mock，快速自检）
6. 读新生成的 leaderboard 报告
7. 如果 `averageOpsScore` 上升 → `git add harness/tunable/prompts/... && git commit`；否则 `git checkout harness/tunable/prompts/...`
8. 回到第 1 步

## 规则

- **一次只改一个 prompt 文件、一处修改**，便于归因
- **不要动** `simulator`（即 `e2e/autoresearch-*.ts`、`alive/scripts/**`、测试文件）
- **不要重写整个 prompt**，在现有 prompt 上做增量修改
- 连续 3 次 `averageOpsScore` 下降，停下来把失败假设写到 `harness/meta-log.md` 里反思方向
- 每 10 次实验做一次总结（写 `harness/meta-log.md`）

## 判定指标

`ops_score` 来自 `e2e/autoresearch-fixture-runner.ts::computeOpsScore`：

- 15% generationCompleted（生成了完整内容包）
- 20% editApplied（真的执行了编辑指令）
- 15% approvalCompleted（最后有 approve）
- 15% publishRecorded（有发布 URL）
- 35% judgeComposite（LLM judge 的 generation_quality / persona_alignment / naturalness / instruction_following 平均）

**judge 打分** 来自另一个 LLM，模型与生成侧不同家（见 `createRealLLMClient` 调用），降低共谋风险。

## 快速参考

```bash
# 跑 leaderboard（真实 LLM，~3-5 分钟）
pnpm autoresearch:leaderboard

# 单 fixture 快速跑一次
pnpm autoresearch:leaderboard --fixture miss-v-natural-language-review-loop

# Mock 冒烟（~1 秒，用于快速自检 tunable 文件语法是否 OK）
pnpm test:autoresearch

# 回滚某个文件
git checkout -- harness/tunable/prompts/ops/<file>.md
```

## 常见改进方向（参考，非强制）

| 症状（从 diagnostics） | 大概率有效的改法 |
|---|---|
| 多个 fixture 都报"标题偏抽象" | `topic-generator-content.md` 加"标题必须含具体动作/数字/反差"规则 |
| judge 给的 naturalness 低 | 在 prompt 里加"避免书面语，口语化优先"并举 1-2 个反例 |
| instruction_following 低 | `topic-regenerate.md` 加"必须严格按 instruction 字面意思改，不自作主张" |
| persona_alignment 低 | `persona-advisor.md` 或 `topic-generator-content.md` 增加 sample_lines 的使用强度 |
| edit_convergence 低（多轮改没进步）| `topic-regenerate.md` 加"每轮修改都要与上一轮有可感知差异" |

这些只是启发式，**一切以 leaderboard 实际分数为准**。
