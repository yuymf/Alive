# Alive — Universal Digital Life Engine

Alive 是一个通用的「活人感」引擎，让任何 AI 角色拥有情绪惯性、精力波动、拖延、心流、随机生活事件等不完美的人类特征。

## 架构

```
alive/                    ← 通用活人感引擎 (persona-agnostic)
├── SKILL.md              # OpenClaw skill 入口
├── persona-schema.yaml   # 人设 schema 定义
├── personas/             # 内置预设角色 (水瀬 Minase 等)
├── events.builtin.yaml   # 内置通用随机事件库
├── protocols/            # 行为协议 (memory, heartbeat, social-graph, ...)
├── templates/            # LLM 提示词模板 ({persona.*} 占位符)
├── scripts/
│   ├── engines/          # 核心状态引擎 (emotion, intent, flow, vitality, confidence, post-impulse)
│   ├── lifecycle/        # 生命周期 (heartbeat-tick, morning-plan, night-reflect)
│   ├── world/            # 随机事件 + 社交图谱
│   ├── router/           # 子 skill 路由调度
│   ├── hub/              # 技能发现 + 自动安装 (need-tracker, hub-client, adapter, lifecycle)
│   ├── persona/          # persona.yaml 加载与模板注入
│   ├── admin/            # /alive 斜杠命令处理器 (不经过 LLM)
│   ├── adapters/         # 平台适配器 (Instagram, 小红书, ContentProvider + 5 providers)
│   └── utils/            # 基础工具 (file-utils, llm-client, time-utils, types)
├── hooks/                # OpenClaw 钩子
├── sub-skills/           # 7 个官方子 skill
│   ├── instagram/        # Instagram 发帖管线
│   ├── voice-tts/        # 语音消息合成 (Noiz TTS)
│   ├── web-search/       # 网络搜索
│   ├── content-browse/   # 内容浏览 / 灵感收集 (多平台)
│   ├── send-message/     # 主动消息
│   ├── social-engagement/# 社交互动 (评论回复)
│   └── platform/         # 平台基础能力 (generate-image, gallery, content-planner, instagram-bridge, xhs-bridge)
└── tests/                # 67 个测试文件
```

## 快速开始

```bash
git clone https://github.com/yourname/alive.git
cd alive
npm install
npm run build
```

## 快速使用内置角色

运行 `alive`（无参数）即可从内置预设角色中交互式选择安装：

```bash
alive
```

## 创建你自己的角色

### 方式一：自动生成（推荐新手）

使用 `/alive create` 或 `alive --create` 一键生成完整角色，支持三种模式：

```bash
# 纯随机 — 一键生成
alive --create

# 指定名字和定位
alive --create --name "陈小鱼" --tagline "爱吃甜食的插画师"

# 引导模式 — 逐步填写
alive --create --guided
```

在聊天中也可以使用斜杠命令：

```
/alive create                              # 纯随机
/alive create 小鱼 "爱吃甜食的插画师"         # 指定名字+定位
/alive create --guided                     # 引导模式
/alive create --guided --name "陈小鱼" --tagline "爱画画" --mbti ENFP --traits "温柔,文艺"
```

生成的角色自动保存到 `alive/personas/` 目录，可直接安装使用。

### 方式二：手动编写 YAML

1. 复制 `alive/personas/minase.yaml` 为你的角色文件（如 `my-persona.yaml`）
2. 参考 `alive/persona-schema.yaml` 了解所有可配置字段
3. 修改 `meta`（名字、年龄、标语）、`personality`（MBTI、特质）、`voice`（语言风格）
4. 按需配置 `intimacy`、`schedule`、`events_extra`、`advisors`
5. 安装到 OpenClaw：

```bash
alive --persona ./my-persona.yaml
```

> **注意**：角色配置文件仅支持 YAML 格式（`.yaml` / `.yml`）。
> 将你的 `.yaml` 放入 `alive/personas/` 目录，下次运行 `alive` 即可在交互式菜单中选择。

## CLI 命令

所有命令都通过 `alive` CLI 调用。Skill 始终安装在 `~/.openclaw/skills/alive/`，每个角色拥有独立的记忆目录。

### 交互式选择角色（推荐）

```bash
alive
```

无参数运行，从内置预设角色中交互式选择并安装。

### 安装自定义角色

```bash
alive --persona <path/to/persona.yaml>
```

指定自定义角色文件安装。交互式引导配置 LLM API 密钥，初始化记忆目录，注册 cron 定时任务。

### 更新框架代码

```bash
alive --update --persona <path/to/persona.yaml>
```

仅更新 alive 框架代码文件，**保留**记忆数据、配置和 cron 任务不变。适用于拉取新版本后更新。

### 重装（完全重置）

```bash
alive --reinstall --persona <path/to/persona.yaml>
```

**清除**所有记忆、配置和 cron 任务，从零开始重新安装。需要交互确认。

### 卸载角色

```bash
alive --uninstall --persona <path/to/persona.yaml>
```

移除 skill 文件、配置和 cron 任务。可选保留记忆数据。

### 切换角色

```bash
alive --switch-persona --persona <path/to/another-persona.yaml>
```

热切换到另一个角色。更新 `persona.yaml`、`ALIVE_PERSONA` 环境变量，如果是首次使用该角色则自动初始化记忆。切换后需要重启 OpenClaw。

### E2E 全天测试

```bash
alive --real-day-test --persona <path/to/persona.yaml>
alive --real-day-test --persona <path/to/persona.yaml> --dry-run
```

卸载 + 重装 + 运行全天模拟测试（晨规划 → 每小时心跳 → 夜反思）。`--dry-run` 跳过实际 API 调用。

### 查看帮助

```bash
alive --help
```

## 开发

```bash
# 构建
npm run build

# 类型检查
npm run typecheck

# 测试
npm run test           # 运行全部测试 (67 test files)
npm run test:watch     # watch 模式
```

## 使用

安装完成后，直接打开 OpenClaw 和角色聊天即可。

**角色会记住你说的事情。** 第一次聊的时候不太熟，多聊几次关系会自然升温。

### 管理面板（斜杠命令）

在对话中输入 `/alive` 即可使用管理命令。这些命令**不经过角色人格、不写入日记、不影响记忆**——纯粹的系统管理操作。

| 命令 | 说明 |
|------|------|
| `/alive status` | 查看角色综合状态（情绪/精力/活力/心流/作息） |
| `/alive emotion` | 查看情绪维度详情（valence/arousal/energy/stress...） |
| `/alive emotion --reset` | 重置情绪到 MBTI 基线值 |
| `/alive schedule` | 查看当前作息配置 |
| `/alive schedule --wake 9 --sleep 1` | 修改起床/睡觉时间 |
| `/alive schedule --timezone Asia/Tokyo` | 修改时区 |
| `/alive skills` | 列出已启用的子技能及安装状态 |
| `/alive platform` | 查看平台配置（Instagram / 小红书等） |
| `/alive memory` | 查看记忆统计（日记天数/wisdom/意图池/关系数...） |
| `/alive create` | 随机生成一个新角色 |
| `/alive create <名字> "一句话定位"` | 用指定名字和定位生成角色 |
| `/alive create --guided` | 引导模式，逐步填写角色信息 |
| `/alive reset emotion` | 重置情绪状态 |
| `/alive reset vitality` | 重置活力值到 100 |
| `/alive reset flow` | 重置心流状态 |
| `/alive reset intents` | 清空意图池 |
| `/alive reset all` | 重置以上所有状态 |
| `/alive help` | 显示帮助 |

> **隔离保证：** 斜杠命令通过 `command-dispatch: tool` 直接路由到脚本执行，不加载 personality.md、不触发 context-loader / memory-save 钩子、不调用 LLM。角色完全感知不到这些操作。

### 多角色管理

Alive 支持多角色**并行运行**——每个角色拥有独立的 cron 调度和记忆目录，互不干扰：

```
~/.openclaw/skills/alive/          ← 共用的框架代码
~/.openclaw/workspace/memory/
├── minase/                        ← 角色 A 的记忆 + 独立 cron
├── another-persona/               ← 角色 B 的记忆 + 独立 cron
└── ...
```

- 使用 `alive --persona <path>` 安装新角色（增量添加，不影响已有角色）
- 使用 `alive --switch-persona` 切换 OpenClaw 当前对话的活跃角色
- 每个角色的记忆、情绪状态、日记完全隔离，不会丢失

### 记忆系统

记忆存储在 `~/.openclaw/workspace/memory/<persona-slug>/`：

```
diary.md               # 角色日记 (30 天滚动，低重要度自动压缩)
core-wisdom.json       # 从经历中蒸馏出的人生教训 (永久保留，上限 20 条)
emotion-state.json     # 6 维情绪状态
intent-pool.json       # 当前意图池
relations/             # 和每个人的关系档案 (90 天衰减)
preferences.json       # 角色偏好 (夜间反思涌现)
aspirations.json       # 梦想与愿望 (active/achieved/abandoned)
personality-drift.json # 性格漂移 (稀有 MBTI 基线微调)
voice-state.json       # 语音消息状态 (日计数 + 冷却)
skill-needs.json       # 能力缺口追踪 (技能自动发现用)
```

## 环境变量

所有环境变量在安装时通过交互式引导配置，保存在 `~/.openclaw/openclaw.json` 中。

| 变量 | 用途 | 必须 |
|------|------|------|
| `LLM_API_KEY` | LLM API 密钥 | 建议 |
| `LLM_API_BASE` | LLM API 地址（默认 `https://aihubmix.com/v1`） | 可选 |
| `LLM_MODEL` | LLM 模型名称（默认 `claude-sonnet-4-20250514`） | 可选 |
| `ALIVE_PERSONA` | 当前活跃角色的 slug（自动管理） | 自动 |
| `IMAGE_ENTRY` | 图片生成服务商：`AIHUBMIX` 或 `FAI` | 可选 |
| `AIHUBMIX_API_KEY` | AIHubMix API Key | 条件 |
| `FAL_KEY` | fal.ai API Key | 条件 |
| `IMGURL_TOKEN` | 图片上传到公共图床 | 可选 |
| `INSTAGRAM_USERNAME` | Instagram 登录用户名 | 可选 |
| `INSTAGRAM_PASSWORD` | Instagram 登录密码 | 可选 |
| `XHS_SKILLS_DIR` | 小红书 Python 脚本目录路径 | 可选 |

## 许可

MIT
