# 从零配一个角色，到能跟它说话

这份文档只做一件事：带你从空目录走到 **文字聊天** 和 **打电话**。打电话走 LiveKit + VoxCPM，交互和 [talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) 同一套。

需要：Node.js 18+。打电话还要 Python 3.11+。VoxCPM 克隆音色需要 NVIDIA GPU（显存 ≥ 8GB）；没有 GPU 也能先用默认音色联调，或先走文字聊天。

---

## 1. 安装 Alive

```bash
git clone https://github.com/yuymf/Alive.git
cd Alive
npm install
npm run build
npm link          # 让终端里有 `alive` 命令
alive init
```

`alive init` 会：

- 把 skill 拷到 `~/.agents/skills/alive`（以及本机已有的 Claude / Cursor / Codex / Hermes / OpenClaw skill 目录）
- 在 `~/.alive` 写下记忆和 `.env`
- 默认角色是 **水瀬**
- 若 Hermes / OpenClaw 已经有模型 key，心跳直接复用，不必再填 `LLM_API_KEY`

只装某一家：

```bash
alive init --agent hermes
alive init --agent openclaw
alive init --agent hermes,openclaw
```

数据都在 `$ALIVE_HOME`，默认 `~/.alive`。以后改配置只改这个文件：

```bash
$EDITOR ~/.alive/.env
```

---

## 2. 做一个新角色

三条路，选一条。做完当前人就是这个角色。

### 路 A：一键蒸馏（推荐）

有名字、有素材、或者就是想要峰哥：

```bash
alive distill 峰哥
# 或
alive distill 你想蒸馏的人
# 或已经有仓库
alive distill https://github.com/YeJe-cpu/talk-to-fengge
```

没有 `LLM_API_KEY` 时，在 Cursor / Claude Code 里对 Alive skill 说「蒸馏 xxx」。宿主会按协议写出 `SKILL.md` 再 adopt。

### 路 B：接入现成 skill

```bash
alive adopt ./examples/fengge
alive adopt ./examples/ace-taffy
alive adopt https://github.com/ly-xxx/ace-taffy-skill
```

### 路 C：现场生成

```bash
alive create 陈小鱼 "爱抬杠的街头观察者"
# 或在对话里 /alive create --guided
```

确认当前人：

```bash
alive status
```

应看到名字、情绪、日程。不对就检查 `~/.alive/.env` 里的 `ALIVE_PERSONA`。

---

## 3. 先文字聊天（到这里已经能交流）

打开 Cursor / Claude Code / Codex（skill 已装好）。直接对这个人说话，不要先解释你是 AI。

宿主每一轮会跑：

```bash
node ~/.agents/skills/alive/scripts/host/chat.js load
```

你会看到他**正在做什么**、今天的安排、日记。回完一句，宿主会 `chat.js save`，下次还记得。

命令行自检：

```bash
alive context
```

有输出、有人名，文字交流就通了。下面的心跳和电话都是加身体，不是重新做人。

---

## 4. 让他自己过日子（可选，但推荐）

文字聊天走宿主模型，不需要额外 key。心跳（自己排日程、发自拍、发社媒、主动打电话）需要一份 OpenAI 兼容的 LLM。装在 Hermes / OpenClaw 里时，Alive 会读那个宿主已经配好的 key，不用再写一份。

没有这两家、或想覆盖宿主配置时，再写 `~/.alive/.env`：

```bash
# ~/.alive/.env
LLM_API_KEY=sk-...
LLM_API_BASE=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

国产、低延迟可以用 MiniMax（和 talk-to-fengge 同一路）：

```bash
LLM_API_KEY=你的minimax-key
LLM_API_BASE=https://api.minimaxi.com/v1
LLM_MODEL=MiniMax-Text-01
```

然后：

```bash
alive morning          # 生成今天的安排
alive tick             # 过一个小时
alive start            # 每小时 tick + 拉起通话栈
```

自拍走 `gallery`（有照片就发，没有就先发文字）。Instagram 要另配账号，见 `/alive setup instagram`。没配也能过日子，只是发帖会记在日记里而不是真发出去。

---

## 5. 打电话：LiveKit + VoxCPM

完整链路和 talk-to-fengge 一样：

```
你说话 → 浏览器 WebRTC
       → LiveKit Server（房间）
       → Alive Agent（Python）
            STT → 人格 LLM → VoxCPM TTS
       → 你听到他的声音
```

### 5.1 LiveKit（本机开发，一条命令）

安装 LiveKit Server：

```bash
# macOS
brew install livekit

# 其他系统
# https://docs.livekit.io/home/self-hosting/local/
```

写进 `~/.alive/.env`（`livekit-server --dev` 的默认账密，不要改）：

```bash
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
AGENT_NAME=alive-voice
ALIVE_VOICE_PORT=8766
```

云端 LiveKit 就把这三项换成控制台里的 `wss://...` / API Key / Secret。

自检：

```bash
livekit-server --dev --bind 127.0.0.1
# 另开终端
curl -sS http://127.0.0.1:7880
```

`alive voice` 发现 `LIVEKIT_URL` 是本机 7880 且 7880 没人占用时，会自己拉起 `livekit-server --dev`。

还没写进 `.env`、只想先用本机默认账密试一次：

```bash
alive voice --livekit-dev
```

这会临时加上 `ws://127.0.0.1:7880` / `devkey` / `secret`。长期用还是写进 `.env`。

还没装 LiveKit、只想看页面：

```bash
alive voice
```

通话页仍在 `http://127.0.0.1:8766`，这时走浏览器语音（能聊，但不是 VoxCPM）。

### 5.2 STT（语音识别）

Agent 要把你的话听成字。推荐 Cartesia ink-whisper（免费层够用，中文好）：

1. 打开 https://www.cartesia.ai/ 注册
2. 复制 API Key

```bash
# ~/.alive/.env
STT_PROVIDER=cartesia
CARTESIA_API_KEY=你的cartesia-key
CARTESIA_STT_MODEL=ink-whisper
CARTESIA_STT_LANGUAGE=zh
```

没有 Cartesia 时，用 OpenAI 兼容 STT（可复用上面的 `LLM_API_KEY`）：

```bash
STT_PROVIDER=openai
```

### 5.3 VoxCPM（音色）

VoxCPM 是独立的 HTTP 服务。Alive Agent 只访问 `VOXCPM_URL`，不把 GPU 模型塞进 Node。

```bash
# ~/.alive/.env
TTS_PROVIDER=voxcpm
VOXCPM_URL=http://127.0.0.1:8000
VOXCPM_VOICE=default
```

**本机有 NVIDIA GPU（推荐）**

```bash
cd /path/to/Alive
python3 -m venv .venv-voxcpm
source .venv-voxcpm/bin/activate
pip install -r alive/voice/voxcpm/requirements.txt
pip install voxcpm
python alive/voice/voxcpm/server.py
```

第一次会下载 `openbmb/VoxCPM2`，要几分钟。起来后：

```bash
curl -sS http://127.0.0.1:8000/health
```

应返回 `"ok": true`。

**默认音色就能打电话。** 想克隆某个人的声音：准备 15–45 秒干净人声 wav（不要背景音乐），再注册：

```bash
curl -sS -X POST http://127.0.0.1:8000/v1/voices \
  -H 'Content-Type: application/json' \
  -d '{"name":"xiaoyu","wav_path":"/绝对路径/xiaoyu.wav","prompt_text":"这段录音里逐字说的话"}'
```

然后把 `.env` 改成 `VOXCPM_VOICE=xiaoyu`。

**没有 GPU，先把链路跑通**

```bash
VOXCPM_MOCK=1 python alive/voice/voxcpm/server.py
```

会出静音，但 LiveKit → Agent → TTS HTTP 是通的。正式听声再换真模型，或把 `VOXCPM_URL` 指到一台云 GPU（RunPod L4 一类）。

**云 GPU**

在 GPU 机器上跑同一个 `alive/voice/voxcpm/server.py`，用 SSH 隧道或公网把 8000 转到本机，`.env` 里的 `VOXCPM_URL` 对着它即可。

### 5.4 装 Agent（Python worker）

```bash
cd /path/to/Alive
python3 -m venv .venv-agent
source .venv-agent/bin/activate
pip install -r alive/voice/agent/requirements.txt
```

Agent 读的是同一份 `~/.alive/.env`：人格 prompt 从通话页 `GET /api/prompt` 拉，LLM 用 `LLM_API_*`，TTS 打 `VOXCPM_URL`。

### 5.5 一键启动并接通

三个东西都要在（`alive voice` 会尽量帮你拉前两个）：

| 进程 | 做什么 | 端口 |
|------|--------|------|
| `livekit-server --dev` | WebRTC 房间 | 7880 |
| `python alive/voice/voxcpm/server.py` | 音色 | 8000 |
| `alive voice` | 通话页 + 派 Agent 进房间 | 8766 + 8081 |

```bash
# 终端 1：VoxCPM（GPU 或 MOCK）
python alive/voice/voxcpm/server.py

# 终端 2：通话栈
alive voice --check          # 先看缺什么
alive voice                  # 拉 LiveKit（如需要）+ Agent + 通话页
```

浏览器打开 **http://127.0.0.1:8766**

1. 应看到角色名、正在做什么、今天安排
2. 底栏应写 `LiveKit 实时语音 · VoxCPM 已就绪 · Agent 在线`
3. 允许麦克风，点中间大圆按钮
4. 说话。他用 VoxCPM 的声音回你
5. 再点一次挂断

命令行邀请（心跳也会自己写）：

```bash
alive call
```

把打印出来的 URL 发给自己，打开就是同一页。

---

## 6. 检查清单

```bash
alive voice --check
```

| 项 | 通过长什么样 |
|----|----------------|
| LiveKit | `.env` 已配，且本机开发时 `curl http://127.0.0.1:7880` 有响应 |
| VoxCPM | `http://127.0.0.1:8000` 有响应 |
| STT | `cartesia` 或 `openai`，不是 `none` |
| LLM | Hermes / OpenClaw 宿主 key，或 `LLM_API_KEY` 已填 |
| Agent worker | `127.0.0.1:8081` 在听 |
| 通话页 | `http://127.0.0.1:8766` |

全是 ✓ 再点麦克风。缺哪项，回到上面那一节补。

页面自检：

```bash
curl -sS http://127.0.0.1:8766/api/check
curl -sS http://127.0.0.1:8766/api/life
```

`livekit` / `voxcpm` / `worker` 都应是 `true`。

---

## 7. 常见问题

**点了麦克风没声音**

- `/api/life` 里 `worker` 是否为 true？Agent 没起来，房间是空的。
- `voxcpm` 是否为 true？TTS 没起来，Agent 听得见但合成失败。
- 浏览器是否允许麦克风？
- `STT_PROVIDER` 和对应 key 是否填了？没 STT 等于没听懂。

**`/token` 返回 503 `livekit-not-configured`**

`.env` 里三件套没齐：`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`。本机开发用第 5.1 节那三行即可。

**Agent 起来了但不进房间**

`AGENT_NAME` 必须两端一致，默认 `alive-voice`。通话页发 token 时会 `dispatch` 这个名字。改了名字要同时改 `.env` 并重启 `alive voice`。

**VoxCPM 下载模型很慢 / 显存不够**

先 `VOXCPM_MOCK=1` 把电话链路跑通，再换真 GPU 或云端。8GB 显存是舒适线。

**只想文字、暂时不打电话**

做到第 3 节就可以停。第 5 节随时再加。

**想换另一个人**

再 `alive distill` / `alive adopt` / `alive create` 一次。通话页和 Agent 下次启动会读新的 `ALIVE_PERSONA` 和 `/api/prompt`。克隆新音色就再 `POST /v1/voices`，改 `VOXCPM_VOICE`。

---

## 8. 和 talk-to-fengge 的关系

| | talk-to-fengge | Alive |
|--|----------------|-------|
| 人格 | `worker/persona.py` | `alive distill` / `adopt` 后的 skill + 日记 + 正在做的事 |
| 房间 | LiveKit | 同一套，本仓库自己发 token、dispatch Agent |
| 声音 | VoxCPM | 同一套 HTTP 合同：`/v1/audio/speech` |
| 过日子 | 无 | 心跳、自拍、社媒、主动来电 |

Alive **不**再把电话甩到外链。装完 skill，角色用蒸馏人格跟你聊天、干活、分享生活；打电话时就是这套 LiveKit + VoxCPM。
