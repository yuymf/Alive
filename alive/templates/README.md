# Prompt 模板三层结构

本项目中的 prompt 模板分布在三个层级，由 `alive/scripts/utils/file-utils.ts` 的 `resolveTunablePromptPath()` 统一加载。

## 层级

| 层级 | 路径 | 用途 | 优先级 |
|------|------|------|--------|
| **1. 安装覆盖** | `<skillBase>/tunable/prompts/<relative>` | 生产环境中通过 skill 安装路径覆盖 | 最高 |
| **2. 仓库覆盖** | `<repoRoot>/eval/tunable/prompts/<relative>` | 开发时的可调优 prompt（autoresearch eval 用） | 中 |
| **3. 内置默认** | `alive/templates/<name>` 或模块 inline prompt | 兜底默认值 | 最低 |

## 各层内容

### `alive/templates/` — 核心生命周期 prompt
- `heartbeat-prompt.md` — 心跳 tick 用的主 prompt
- `morning-plan-prompt.md` — 晨规划 prompt
- `night-reflect-prompt.md` — 睡前反思 prompt
- `reflection-prompt.md` — 通用反思 prompt
- `flow-evolution-prompt.md` — 流程进化 prompt
- `persona-generate-prompt.md` — 人格生成 prompt
- `diary-entry.md` / `identity.md` / `personality.md` / `simulated-action.md` / `soul-injection.md` / `user.md` — 模板组件

### `alive/sub-skills/*/templates/` — 子技能 prompt
每个 sub-skill 自带 templates 目录，包含该技能专用的 prompt：
- `content-browse/templates/` — 内容浏览相关 prompt
- `social-engagement/templates/` — 社交互动 prompt
- `voice-tts/templates/` — 语音 TTS prompt
- `web-search/templates/` — 搜索 prompt
- `send-message/templates/` — 消息发送 prompt
- `platform/content-planner/templates/` — 内容策划 prompt
- 等等

### `eval/tunable/prompts/` — 可调优 prompt 覆盖
autoresearch eval 系统使用的可调优 prompt，开发时覆盖内置默认：
- `ops/persona-advisor.md` — 人设顾问 prompt
- `ops/strategy-engine.md` — 策略引擎 prompt
- `ops/trend-analyzer.md` — 趋势分析 prompt
- `ops/topic-generator-content.md` — 选题生成 prompt
- `ops/topic-regenerate.md` — 选题重写 prompt
- `ops/topic-hook-generator.md` — 钩子生成 prompt
- `ops/candidate-scorer.weights.json` — 候选评分权重
- `ops/brief-generator.limits.json` — Brief 生成限制

## 修改指南

- **修改内置默认 prompt**：编辑 `alive/templates/` 或 `alive/sub-skills/*/templates/`
- **开发调优 prompt**：编辑 `eval/tunable/prompts/` 下的文件（autoresearch agent 只允许改这里）
- **生产覆盖**：通过 skill 安装路径的 `tunable/prompts/` 目录覆盖
