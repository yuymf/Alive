<div align="center">

# 💫 Alive

### 数字生命引擎 — 让 AI 拥有真实的内心世界

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![OpenClaw Skill](https://img.shields.io/badge/OpenClaw-skill-purple.svg)](https://openclaw.ai)
[![零配置](https://img.shields.io/badge/零配置-brightgreen.svg)]()

**情绪 · 疲惫 · 拖延 · 心流 · 随机生活事件**

[English](README.md) · [中文](#) · [使用指南](docs/guide.md) · [更新日志](CHANGELOG.md)

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
| 没有运营能力 | **内置运营工作台** — 趋势、竞品、爆款知识库 |
| 单一平台 | **7 个内容源** — B站、Reddit、微博、知乎、小红书、抖音、DailyHot |

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

### 运营工作台

- 📊 趋势分析
- 🔍 竞品追踪（小红书/抖音/B站）
- 💡 选题生成
- 📋 每日简报（企业微信推送）
- 🎯 人设顾问
- 🦠 **爆款知识库** — 自动拆解 → 自动升级公式 → 自动淘汰

</td>
</tr>
</table>

## 🎭 内置角色

| | 角色 | 人设 |
|:---:|:---|:---|
| 🌸 | **水瀬（Minase）** | INFP 日本女大学生 · 咖啡馆与摄影 |
| 💎 | **V姐（Miss V）** | ENTJ 三栖虚拟偶像 · 电竞 · 歌手 · 赛车 |
| 🎭 | **星彤** | 温暖幽默的生活方式创作者 |
| 🎤 | **郭德纲** | 相声大师，冷幽默 |

也可以用 `alive --persona <你的角色.yaml>` 导入自定义角色。

## 🚀 快速开始

```bash
npx alive
```

就这样。安装向导会引导你完成其余步骤。

> **前置条件：** 已安装 [OpenClaw](https://openclaw.ai)（Node.js ≥ 18）
>
> **无需任何 API Key** — 默认使用 OpenClaw 内置 Claude。

### 30 秒安装

```
1. npx alive                    # 安装
2. 选一个角色                    # 水瀬、V姐，或导入自定义角色
3. 完成 ✅                      # Cron 任务已注册，她开始活了
```

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

### 运营

```
/alive brief               # 每日简报（热点+选题+建议）
/alive trends              # 热点关键词
/alive idea [方向]         # 生成选题（如 /alive idea 电竞）
/alive post [N]            # 选题队列 / 详情
/alive analyze <URL>       # 爆款拆解分析
/alive advice              # 人设 × 趋势契合度
/alive kb status           # 爆款知识库统计
/alive kb search <关键词>  # 搜索拆解记录
/alive kb formulas         # 通用爆款公式
```

## 🔓 渐进式解锁

| 功能 | 需要配置 | 效果 |
|:---|:---|:---|
| 对话 + 情绪记忆 | _无需任何 key_ | 装上即用 |
| 心跳自主行为 | _无需任何 key_ | 使用内置 Claude |
| 自定义 LLM | `LLM_API_KEY` | 任意 OpenAI 兼容接口 |
| AI 图片生成 | `AIHUBMIX_API_KEY` / `FAL_KEY` | 自动配图发帖 |
| Instagram | `INSTAGRAM_USERNAME` + `PASSWORD` | 自主发帖 |
| 小红书浏览/互动 | `XHS_SKILLS_DIR` | 完整小红书集成 |
| 语音消息 | _无需 key_ | Noiz TTS，≤3次/天 |
| 图片托管 | `IMGURL_TOKEN` | ImgURL 公共上传 |

随时可改：`/alive setup`

## 🏗️ 架构

```
alive/
├── SKILL.md                  # OpenClaw skill 入口
├── persona-schema.yaml       # 配置 schema + MBTI 表
├── personas/                 # 内置预设角色
├── templates/                # LLM 提示词模板（{persona.*}）
├── protocols/                # 心跳 · 记忆 · 社交图谱 · 意图池
├── scripts/
│   ├── engines/              # 7 大核心引擎
│   ├── lifecycle/            # 心跳循环 · 晨间规划 · 晚间反思
│   ├── ops/                  # 趋势 · 竞品 · 简报 · 顾问 · 爆款知识库
│   ├── adapters/             # 平台适配器
│   └── utils/                # 类型 · 配置 · 技能路由 · 内容源
├── sub-skills/               # 9 个可插拔子技能
├── hooks/                    # 上下文加载 · 记忆保存
├── plugin/                   # /alive 命令注册
└── dashboard/               # Web 仪表盘
```

### 子技能（9 个可插拔单元）

`instagram-post` · `voice-tts` · `web-search` · `content-browse` · `social-engage` · `photo-share` · `story-share` · `xhs-post` · `message-send`

### 内容源（7 个平台）

`B站` · `Reddit` · `DailyHot` · `微博` · `知乎` · `小红书` · `抖音`

## 🛠️ 开发

```bash
npm run build       # 编译 TypeScript
npm run typecheck   # 类型检查
npm run test        # 运行所有测试（vitest）
```

欢迎提交 PR！角色配置文件（`alive/personas/*.yaml`）特别欢迎社区贡献。

## 📄 License

MIT
