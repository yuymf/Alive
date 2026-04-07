# Alive — 安装指南 / Installation Guide

> 中文在前，English below.

---

## 中文安装指南

### 前置条件

- [OpenClaw](https://openclaw.ai) 已安装并可用（`openclaw --version` 能正常输出）
- Node.js ≥ 18（`node --version` 确认）
- 无需任何 API Key — 默认使用 OpenClaw 内置 Claude

### 方式一：交互式安装（推荐新手）

```bash
# 克隆仓库
git clone https://github.com/yuymf/Alive.git
cd Alive

# 安装依赖
npm install

# 启动安装向导
node bin/cli.js
```

向导分三步：

**Step 1 — 选择角色**
```
  ╭─────────────────────────────────────────────╮
  │         🌟 Alive — Choose Your Persona       │
  ╰─────────────────────────────────────────────╯

    1. 水瀬 (Minase)  [ESTP]
       辣妹系 coser × 数字游民旅行博主

    2. V姐 (Miss V)  [ENTJ]
       三栖虚拟偶像：电竞·歌手·赛车

    3. 星瞳 (Xingtong)
       虚拟偶像 × 时尚博主 × 虚拟歌手

    4. 郭德纲 (Guo Degang)
       相声演员 × 德云社班主

    0. Cancel — I'll provide my own persona.yaml
```

**Step 2 — 可选配置（2 个问题）**
```
  ✦ OpenClaw's built-in Claude is used by default — no LLM key required.
  Use a custom LLM? (leave blank to use OpenClaw's built-in Claude):

  Enable Instagram auto-posting? (y/N):
```

- 直接回车两次 = 零配置，装好即用
- 输入自定义 LLM key = 使用自己的模型（更快/更省钱）
- 输入 `y` 开启 Instagram = 继续询问账号密码

**Step 3 — 功能解锁摘要**
```
  ╭─────────────────────────────────────────────╮
  │         🌟 Feature Unlock Status             │
  ╰─────────────────────────────────────────────╯
  ✓ Core engine        — always on
  ✓ Memory & emotions  — always on
  ✓ Heartbeat loop     — OpenClaw built-in Claude
  ○ AI image gen        — add AIHUBMIX_API_KEY or FAL_KEY
  ○ Instagram posting   — add INSTAGRAM_USERNAME + PASSWORD
  ○ Voice messages     — no key needed (Noiz TTS, ≤3/day)
```

安装完成，角色开始自主运行。

---

### 方式二：用 .env 文件（非交互式，适合服务器）

```bash
# 复制模板
cp .env.example .env

# 按需填写（全部可选）
vim .env

# 非交互式安装（跳过所有提问）
node bin/cli.js --persona alive/personas/minase.yaml --env-file .env
```

`.env` 文件格式：

```bash
# 留空 = 使用 OpenClaw 内置 Claude
LLM_API_KEY=

# 可选：AI 图片生成
AIHUBMIX_API_KEY=

# 可选：Instagram 自动发帖
INSTAGRAM_USERNAME=
INSTAGRAM_PASSWORD=
```

---

### 方式三：自定义角色

```bash
# 参考内置角色创建自己的 persona.yaml
cp alive/personas/minase.yaml my-persona.yaml
vim my-persona.yaml

# 安装自定义角色
node bin/cli.js --persona my-persona.yaml
```

角色 schema 定义见 `alive/persona-schema.yaml`。

---

### 安装后验证

打开 OpenClaw，输入：

```
/alive status    # 查看角色状态（情绪/精力/心流）
/alive help      # 查看所有可用命令
```

---

### 更新 / 切换 / 卸载

```bash
# 更新引擎代码（保留记忆和配置）
node bin/cli.js --update --persona alive/personas/minase.yaml

# 热切换到另一个角色
node bin/cli.js --switch-persona --persona alive/personas/miss-v.yaml

# 完全重装（清空记忆）
node bin/cli.js --reinstall --persona alive/personas/minase.yaml

# 卸载
node bin/cli.js --uninstall --persona alive/personas/minase.yaml
```

---

### 安装后配置（在对话中）

无需重装，随时修改 env 配置：

```
/alive setup              # 查看当前配置状态
/alive setup llm          # 配置自定义 LLM key
/alive setup instagram    # 配置 Instagram 凭据
```

---

### 常见问题

**Q: 安装后角色没有反应？**
A: 查看 cron 注册状态：`openclaw cron list`。心跳 cron（`alive:tick`）应该每小时触发一次。

**Q: 想用自己的 LLM（如 GPT-4、Claude API）？**
A: 安装时填入 `LLM_API_KEY`，或安装后运行 `/alive setup llm`。支持任意 OpenAI 兼容接口。

**Q: 多个角色能同时运行吗？**
A: 可以。每个角色有独立的 memory 目录和 cron 任务。用 `--switch-persona` 切换活跃角色，或直接安装多个角色（各自的 cron 并行运行）。

**Q: 记忆在哪里？**
A: `~/.openclaw/workspace/memory/<persona-id>/`，包含日记、情绪状态、关系档案等。

---

## English Installation Guide

### Prerequisites

- [OpenClaw](https://openclaw.ai) installed (`openclaw --version` works)
- Node.js ≥ 18
- No API keys required — uses OpenClaw's built-in Claude by default

### Quick Install (Interactive)

```bash
git clone https://github.com/yuymf/Alive.git
cd Alive
npm install
node bin/cli.js
```

The wizard asks 2 optional questions:
1. **Custom LLM?** — leave blank to use OpenClaw's built-in Claude
2. **Enable Instagram?** — `y` to configure auto-posting

Press Enter twice for zero-config install.

### Silent Install (with .env file)

```bash
cp .env.example .env
# Edit .env as needed (all keys optional)
node bin/cli.js --persona alive/personas/minase.yaml --env-file .env
```

### After Install

In OpenClaw chat:
```
/alive status    # view current state
/alive setup     # view/change env config
/alive help      # all commands
```

### Update / Switch / Uninstall

```bash
node bin/cli.js --update --persona alive/personas/minase.yaml      # update code, keep memory
node bin/cli.js --switch-persona --persona alive/personas/miss-v.yaml  # hot-swap persona
node bin/cli.js --reinstall --persona alive/personas/minase.yaml   # full reset
node bin/cli.js --uninstall --persona alive/personas/minase.yaml   # remove
```

### Memory Files

Located at `~/.openclaw/workspace/memory/<persona-id>/`:
- `diary.md` — episodic diary (30-day rolling)
- `emotion-state.json` — current 6D emotion state
- `core-wisdom.json` — permanent life lessons
- `relations/` — per-user relationship files
