# Autoresearch Harness

参考 [karpathy/autoresearch](https://github.com/karpathy/autoresearch) 的单文件-单目标思路，把"跑通 E2E"升级为"让系统自己反复调优"。

## 这是什么

- **目标**：在固定 fixture 上提高 `ops_score`
- **被调优对象**：`harness/tunable/prompts/**` 目录下的 prompt 文件（其他代码不允许动）
- **评分器**：`e2e/autoresearch-fixture-runner.ts` + `e2e/autoresearch-leaderboard.ts`
- **被测 ops 模块**：`persona-advisor` / `strategy-engine` / `trend-analyzer` / `topic-generator`

所有接入的 ops 模块先调 `readTunablePrompt(relativePath)`；有 override 则用 override，没有就走模块内置 fallback prompt。这样 `harness/tunable/prompts/ops/*.md` 的每一次修改，都会被下一次 fixture run 用到。

## 快速开始

```bash
# 1. 跑一次单 fixture（走真实 LLM）
pnpm autoresearch:fixture --keep-workspace

# 2. 跑 leaderboard（跑多 fixture + 聚合诊断 + advisor 建议）
pnpm autoresearch:leaderboard

# 3. 只跑一个 fixture
pnpm autoresearch:leaderboard --fixture miss-v-natural-language-review-loop

# 4. 跑测试（使用 mock LLM，用于 CI / 冒烟）
pnpm test:autoresearch
```

报告会写到 `e2e/reports/autoresearch/`（gitignored）。

## 目录

```
harness/
├── README.md                 # 本文件
├── program.md                # 给 agent 的 skill / system prompt
└── tunable/
    └── prompts/
        ├── ops/              # 选题 / 策略 / 人设相关 prompt
        │   ├── persona-advisor.md
        │   ├── strategy-engine.md
        │   ├── trend-analyzer.md
        │   ├── topic-generator-content.md
        │   ├── topic-regenerate.md
        │   └── topic-hook-generator.md
        └── lifecycle/        # （可选）alive 日常 lifecycle prompt 覆盖
            └── morning-plan-prompt.md
```

## 允许 agent 改什么

**只允许**改 `harness/tunable/prompts/**` 里的 `.md` 文件。

不允许碰：

- `alive/scripts/**`、`alive/tests/**`、`e2e/**`：实现 + 评分器
- `harness/program.md`、`harness/README.md`：治理文件
- 任何 `*.ts` / `*.json`：结构化配置 / 代码

## Tunable prompt 变量

每个 tunable prompt 文件里的 `{{variable_name}}` 占位符会在调用时被渲染。具体可用变量见各 prompt 文件顶部的 `@available-vars`。

Agent 若把占位符写错（拼写/缺失），渲染结果对应位置会被替换成空字符串 —— **不会抛错**但可能降低生成质量，这本身也是 `ops_score` 能发现的。

## Fallback 策略

若某个 tunable prompt 文件缺失，对应 build*Prompt 会自动回到模块内置的 inline prompt。这保证：

1. 没有 `harness/tunable/prompts/` 安装时（生产环境），系统行为与原先完全一致。
2. agent 删除某个文件等同于"回到 baseline"，不需要 git 操作。

## 与生产的关系

`alive/scripts/utils/file-utils.ts` 的 `resolveTunablePromptPath()` 查找顺序：

1. `<skillBase>/tunable/prompts/<relative>` —— 安装后的 skill 路径
2. `<repoRoot>/harness/tunable/prompts/<relative>` —— 开发时的 repo 路径

所以在 repo 里改 `harness/tunable/prompts/ops/*.md`，直接跑 `pnpm autoresearch:fixture` 就会生效。
