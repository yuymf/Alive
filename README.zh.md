# Alive — 数字生命引擎

> 让你的 AI 角色拥有真实的情绪、精力波动、拖延、心流与随机生活事件

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)

[English README](README.md)

---

## 这是什么？

Alive 是一个 OpenClaw 技能（skill），让任何 AI 角色拥有真实的"活人感"：

- 她**记得**上次对话结束时的心情，情绪跨 session 延续
- 她会**疲惫**、**拖延**，也会进入**心流**状态全神贯注
- 她每天**早上规划**日程，**晚上反思**，形成长期记忆
- 她可以自主发帖到 Instagram、小红书（可选）
- 她会在晚上自动发现并安装新能力（ClawHub skill 自动安装）

**无需任何 API Key 即可使用** — 默认使用 OpenClaw 内置的 Claude。

---

## 快速开始

**前置条件：** 已安装 [OpenClaw](https://openclaw.ai)（需要 Node.js ≥ 18）

```bash
npx alive
```

安装向导会引导你：
1. 选择或导入角色（persona）
2. （可选）配置自定义 LLM、Instagram 等
3. 注册 cron 任务，角色开始自主运行

---

## 内置角色

| 角色 | 人设 | MBTI | 语言 |
|------|------|------|------|
| 🌸 水瀬（Minase） | 日本女大学生，喜欢咖啡馆和摄影 | INFP | 日语 |
| 💎 V姐（Miss V） | ENTJ 三栖虚拟偶像：电竞·歌手·赛车 | ENTJ | 中文 |
| 🎭 星彤 | 温暖幽默的生活方式创作者 | - | 中文 |
| 🎤 郭德纲 | 相声大师，冷幽默 | - | 中文 |

也可以用 `alive --persona <你的角色.yaml>` 导入自定义角色。

---

## 核心能力

- **情绪引擎** — 6 维情绪模型（效价/唤醒度/能量/压力/自信/社交欲），MBTI 基线，三层惯性模型
- **记忆系统** — 对话日记（30天）、关系档案（90天）、人生智慧（永久保留）
- **意图引擎** — 7 类元意图（创作/社交/消费/表达/学习/休息/追求），含拖延追踪
- **心流引擎** — 心流/漂移状态机，混合日记生成策略
- **活力引擎** — 每日精力消耗与恢复，心流门控
- **随机事件** — 21 种内置事件类型，链式触发，动态权重
- **技能发现** — 能力缺口追踪，每晚自动搜索并安装子技能（最多 2 个/晚）
- **多角色并行** — 每个角色独立记忆、情绪状态与 cron 调度

---

## 配置项（渐进式解锁）

| 功能 | 需要配置 | 说明 |
|------|----------|------|
| 基础对话 + 情绪记忆 | 无需任何 key | 装上即用 |
| 心跳自主行为（cron） | 无需任何 key | 使用 OpenClaw 内置 Claude |
| 自定义 LLM | `LLM_API_KEY` | 更快 / 更省钱，支持任意 OpenAI 兼容接口 |
| AI 图片生成 | `AIHUBMIX_API_KEY` 或 `FAL_KEY` | 解锁自动发帖配图 |
| Instagram 自动发帖 | `INSTAGRAM_USERNAME` + `INSTAGRAM_PASSWORD` | |
| 小红书浏览/互动 | `XHS_SKILLS_DIR` | 需要 xiaohongshu-skills Python 环境 |
| 语音消息 | 无需 key | Noiz TTS Guest Mode，≤3次/天 |
| 图片公共托管 | `IMGURL_TOKEN` | 可选，用于 ImgURL 上传 |

配置可以在安装后随时通过 `/alive setup` 修改。

---

## 管理命令

安装后在 OpenClaw 对话中使用：

```
/alive status              # 查看角色当前状态（情绪/精力/心流）
/alive emotion             # 情绪详情
/alive schedule            # 作息配置
/alive setup               # 重新配置 env（无需重装）
/alive setup llm           # 只配置 LLM key
/alive setup instagram     # 只配置 Instagram
/alive memory              # 记忆统计
/alive create              # 随机生成新角色
/alive help                # 查看所有命令
```

---

## 架构

```
alive/
├── SKILL.md                 # OpenClaw skill 入口
├── persona-schema.yaml      # persona 配置 schema
├── personas/                # 内置预设角色
├── templates/               # LLM 提示词模板（{persona.*} 占位符）
├── scripts/
│   ├── engines/             # 核心状态引擎（emotion/intent/flow/vitality/confidence/work-impulse）
│   ├── lifecycle/           # 生命周期（heartbeat-tick/morning-plan/night-reflect）
│   ├── admin/               # /alive 命令处理器
│   ├── ops/                 # 运营工作台（趋势/选题/简报/竞品）
│   └── utils/               # 基础工具
├── sub-skills/              # 子技能（Instagram/语音/搜索/内容浏览/消息）
└── tests/                   # 78 个测试文件
```

---

## 开发 / 贡献

```bash
npm run build       # 编译 TypeScript
npm run typecheck   # 类型检查
npm run test        # 运行所有测试（vitest）
```

欢迎提交 PR！角色配置文件（`alive/personas/*.yaml`）特别欢迎社区贡献。

---

## License

MIT
