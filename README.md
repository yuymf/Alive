# Alive — Universal Digital Life Engine

Alive 是一个通用的「活人感」引擎，让任何 AI 角色拥有情绪惯性、精力波动、拖延、心流、随机生活事件等不完美的人类特征。

## 架构

```
alive/                    ← 通用活人感引擎 (persona-agnostic)
├── SKILL.md              # OpenClaw skill 入口
├── persona-schema.yaml   # 人设 schema 定义
├── persona.example.yaml  # 示例人设 (水瀬 Minase)
├── events.builtin.yaml   # 内置通用随机事件库
├── protocols/            # 行为协议 (memory, heartbeat, social-graph, ...)
├── templates/            # LLM 提示词模板 ({persona.*} 占位符)
├── scripts/
│   ├── engines/          # 核心状态引擎 (emotion, intent, flow, vitality, confidence)
│   ├── lifecycle/        # 生命周期 (heartbeat-tick, morning-plan, night-reflect)
│   ├── world/            # 随机事件 + 社交图谱
│   ├── router/           # 子 skill 路由调度
│   ├── persona/          # persona.yaml 加载与模板注入
│   └── utils/            # 基础工具 (file-utils, llm-client, types)
├── hooks/                # OpenClaw 钩子
├── sub-skills/           # 官方子 skill
│   ├── instagram/        # Instagram 发帖管线
│   ├── web-search/       # 网络搜索
│   ├── content-browse/   # 内容浏览 / 灵感收集
│   ├── send-message/     # 主动消息
│   ├── social-engagement/# 社交互动 (评论回复)
│   └── platform/         # 平台基础能力 (图片生成, gallery, bridge...)
└── tests/                # 44 个测试文件, 712 tests
```

## 创建你自己的角色

1. 复制 `alive/persona.example.yaml` 为 `persona.yaml`
2. 修改 `meta`（名字、年龄、标语）、`personality`（MBTI、特质）、`voice`（语言风格）
3. 按需配置 `intimacy`、`schedule`、`events_extra`、`advisors`
4. 安装到 OpenClaw:

```bash
git clone https://github.com/yourname/alive.git
cd alive
npm install
npm run build
alive --persona ./my-persona.json
```

## 开发

```bash
# 构建
npm run build

# 类型检查
npm run typecheck

# 测试
npm run test           # 运行全部测试 (44 files, 712 tests)
npm run test:watch     # watch 模式
```

## 使用

安装完成后，直接打开 OpenClaw 和角色聊天即可。

**角色会记住你说的事情。** 第一次聊的时候不太熟，多聊几次关系会自然升温。

### 记忆系统

记忆存储在 `~/.openclaw/workspace/memory/{persona-slug}/`：

```
diary.md            # 角色日记
core-wisdom.json    # 从经历中蒸馏出的人生教训
emotion-state.json  # 情绪状态
relations/          # 和每个人的关系档案
```

## 环境变量

所有环境变量在安装时通过交互式引导配置，保存在 `~/.openclaw/openclaw.json` 中。

| 变量 | 用途 | 必须 |
|------|------|------|
| `LLM_API_KEY` | LLM API 密钥 | 建议 |
| `LLM_API_BASE` | LLM API 地址（默认 `https://aihubmix.com/v1`） | 可选 |
| `LLM_MODEL` | LLM 模型名称（默认 `claude-sonnet-4-20250514`） | 可选 |
| `IMAGE_ENTRY` | 图片生成服务商：`AIHUBMIX` 或 `FAI` | 可选 |
| `AIHUBMIX_API_KEY` | AIHubMix API Key | 条件 |
| `FAL_KEY` | fal.ai API Key | 条件 |
| `IMGURL_TOKEN` | 图片上传到公共图床 | 可选 |
| `INSTAGRAM_USERNAME` | Instagram 登录用户名 | 可选 |
| `INSTAGRAM_PASSWORD` | Instagram 登录密码 | 可选 |

## 许可

MIT
