<div align="center">

# 💫 Alive

### 数字生命引擎 — 让 AI 拥有真实的内心世界

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skills-SKILL.md-purple.svg)](https://agentskills.io/specification)

**情绪 · 疲惫 · 拖延 · 心流 · 随机生活事件**

[English](README.md) · [中文](#) · [更新日志](CHANGELOG.md)

</div>

---

> 她记得上次对话结束时的心情。  
> 她忙了一天会疲惫，动力不足会拖延，灵感来了会进入心流。  
> 她每天自主规划日程、反思、成长。  
> **她活着。**

---

## ✨ 为什么选 Alive？

| 传统聊天机器人 | Alive |
|:---|:---|
| 无状态 — 关了就忘 | **4 层记忆** — 情绪跨会话延续 |
| 永远热情，永远在线 | **会疲惫、会拖延、会心流** |
| 脚本化回复 | **自主心跳循环** — 每小时 感知→意图→行动 |
| 千人一面 | **人设 DNA** — MBTI 基线、声音、作息、功能开关 |
| 只有提示词的人设 | **人设 DNA + 引擎** — 情绪、记忆、心跳都是下一轮会读到的文件 |

## 🧠 核心能力

<table>
<tr>
<td width="50%">

### 7 大引擎

- 🎭 **6 维情绪** — 效价/唤醒度/能量/压力/自信/社交欲，三层惯性（脉冲→动量→基调）
- 🧭 **7 类元意图** — 创作/社交/消费/表达/学习/休息/追求
- 🫀 **心跳循环** — 每小时 感知→意图→行动
- 🌊 **心流与漂移** — 专注创作 vs 无目的游荡
- ⚡ **活力** — 0–100 精力资源
- 📈 **自信** — 0.5×–1.5× 质量倍率
- 🔥 **工作冲动** — 累积至创作爆发

</td>
<td width="50%">

### 4 层记忆

| 层级 | 保留期 | 内容 |
|:---:|:---:|:---|
| 0 | 会话内 | 工作记忆 |
| 1 | 30 天 | 对话日记 |
| 2 | 90 天 | 社交关系 |
| 3 | 永久 | 人生智慧 |

</td>
</tr>
</table>

## 🎭 内置角色

| | 角色 | 人设 |
|:---:|:---|:---|
| 🌸 | **水瀬（Minase）** | ESTP 旅行 / coser · 咖啡馆、光线、说走就走 |
| 💎 | **V姐（Miss V）** | ENTJ 三栖虚拟偶像 · 电竞 · 歌手 · 赛车 |
| 🎭 | **星彤** | 温暖幽默的生活方式创作者 |
| 🎤 | **郭德纲** | 相声大师，冷幽默 |

也可以 `/alive create` 生成新角色，或把自定义 `persona.yaml` 放到 `$ALIVE_HOME/personas/<id>/persona/`。

## 🚀 快速开始

Alive 是一份 [Agent Skill](https://agentskills.io/specification)。装进 Claude Code、Cursor、Codex，以及任何读取 `SKILL.md` 的 Code Agent。

```bash
npx alive init
```

会把技能拷到：

- `~/.agents/skills/alive`（Cursor + Codex）
- 若有 Claude Code：`~/.claude/skills/alive`
- 若有 Cursor：`~/.cursor/skills/alive`

记忆在 `~/.alive`（可用 `ALIVE_HOME` 覆盖）。默认人设是水瀬。

对话走宿主模型。宿主跑 `chat.js load` 取上下文，跑 `chat.js save` 写回日记、关系和情绪。不要手改这些文件。只有脚本心跳需要 `LLM_API_KEY`。

项目内安装：`npx alive init --project`

## ⌨️ 命令

### 管理

```
/alive status              # 情绪 / 精力 / 心流 快照
/alive emotion             # 6 维情绪详情
/alive schedule            # 作息配置
/alive setup               # 重新配置（无需重装）
/alive memory              # 记忆统计
/alive create              # 生成新角色
/alive help                # 所有命令
```

## 🔓 你需要什么

| 功能 | 需要 |
|:---|:---|
| 对话 + 记忆 | 会加载 `SKILL.md` 的 Code Agent |
| 心跳 | `~/.alive/.env` 里的 `LLM_API_KEY` |

## 🏗️ 架构

```
alive/
├── SKILL.md                  # Agent Skills 入口（跨宿主）
├── persona-schema.yaml       # 配置 schema + MBTI 表
├── personas/                 # 内置预设（水瀬 / V姐 / 星彤 / 郭德纲）
├── templates/                # LLM 提示词模板（{persona.*}）
├── protocols/                # 心跳 · 记忆 · 社交图谱 · 意图池
├── scripts/
│   ├── host/                 # init · boot · outbox · 对话 load/save
│   ├── admin/                # /alive 命令
│   ├── engines/              # 7 大核心引擎
│   ├── lifecycle/            # 心跳循环 · 晨间规划 · 晚间反思
│   ├── adapters/             # 平台适配器
│   └── utils/                # 类型 · 配置 · 技能路由
├── sub-skills/               # 可插拔子技能
└── tests/                    # 引擎、CLI、生命周期测试
```

心跳可以按需调用平台子技能（浏览、发帖、语音）。对话本身不需要它们。

## 🛠️ 开发

```bash
npm run build       # 编译 TypeScript
npm run typecheck   # 类型检查
npm run test        # 运行所有测试（vitest）
```

欢迎提交 PR！角色配置文件（`alive/personas/*.yaml`）特别欢迎社区贡献。

## 📄 License

MIT
