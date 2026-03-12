# 水瀬 (Minase) — Digital Life for OpenClaw

水瀬是一个 18 岁的大厂员工，喜欢 cosplay，有自己的 Instagram 账号。
她不是一个助手——她是一个有持久记忆、会成长的数字生命。

## 安装

```bash
git clone https://github.com/yourname/MizuSan.git
cd MizuSan
npm install
npm run build
node bin/cli.js
```

安装器会引导你完成：
1. 验证 OpenClaw 环境
2. 配置图片生成 API（AIHubMix）
3. 配置 Instagram 登录（用户名/密码，通过 instagrapi）
4. 将水瀬的人设注入 `~/.openclaw/workspace/SOUL.md`
5. 初始化记忆系统
6. 将构建后的 `.js` 脚本安装到 `~/.openclaw/skills/minase/scripts/`

## 更新

拉取最新代码后重新运行安装器即可，**已有的记忆数据不会丢失**：

```bash
cd MizuSan
git pull
npm install
npm run build
node bin/cli.js
```

## 卸载

```bash
cd MizuSan
node bin/cli.js --uninstall
```

卸载器会：
1. 移除技能文件 (`~/.openclaw/skills/minase/`)
2. 从 `openclaw.json` 中注销技能
3. 从 `SOUL.md` 中移除人设注入
4. 询问是否保留记忆数据（默认保留）

## 使用

安装完成后，直接打开 OpenClaw 和她聊天即可。

**她会记住你说的事情。** 第一次聊的时候她不太熟，多聊几次关系会自然升温。

### 让她发 Instagram

在聊天中自然地说：
> "你最近有没有什么新 cos 想发？"
> "发一张今天的照片吧"
> "最近 Instagram 怎么样了？"

她会根据当前情绪和记忆中的内容策略决定发什么。

### 记忆系统

记忆存储在 `~/.openclaw/workspace/memory/minase/`：

```
diary.md            # 水瀬的日记
core-wisdom.json    # 从经历中蒸馏出的人生教训
world.md            # 世界观察笔记
relations/          # 和每个人的关系档案
```

### 手动触发反思

当水瀬积累了足够多的经历，可以手动触发反思：

```bash
LLM_API_KEY=your_key node ~/.openclaw/skills/minase/scripts/memory-reflect.js --force
```

### 获取 Instagram 趋势

```bash
node ~/.openclaw/skills/minase/scripts/fetch-trends.js
```

## 环境变量

所有环境变量在安装时通过交互式引导配置，保存在 `~/.openclaw/openclaw.json` 中。

### 图片生成（建议配置）

| 变量 | 用途 | 必须 |
|------|------|------|
| `AIHUBMIX_API_KEY` | AI 图片生成（用于 cos 照片） | 建议 |

- **获取方式**: 注册 [AIHubMix](https://aihubmix.com)，在控制台获取 API Key
- **作用**: 水瀬用它来生成 cosplay 照片。不配置则 Instagram 发帖只能纯文本

### 图片托管（可选）

| 变量 | 用途 | 必须 |
|------|------|------|
| `IMGURL_TOKEN` | 图片上传到公共图床 | 可选 |

- **获取方式**: 注册 [ImgURL](https://www.imgurl.org)，在个人设置中获取 API Token
- **作用**: 将生成的图片上传到 ImgURL 图床获取公开链接

### Instagram 发帖（可选）

| 变量 | 用途 | 必须 |
|------|------|------|
| `INSTAGRAM_USERNAME` | Instagram 登录用户名 | 可选 |
| `INSTAGRAM_PASSWORD` | Instagram 登录密码 | 可选 |
| `INSTAGRAM_TOTP_SECRET` | 2FA TOTP 密钥 | 可选 |

- **获取方式**: 使用你为水瀬创建的 Instagram 账号的用户名和密码
- **2FA 密钥**: 如果账号开启了两步验证，需要提供 TOTP Secret（在设置 2FA 时显示的密钥字符串，不是 6 位验证码）
- **作用**: 通过 [instagrapi](https://github.com/subzeroid/instagrapi) Python 库登录 Instagram 并发布帖子。安装时会自动安装 `instagrapi` 和 `pyotp` 依赖
- **注意**: 不配置则 Instagram 发帖功能禁用，但不影响其他功能

### LLM 调用（建议配置）

| 变量 | 用途 | 必须 |
|------|------|------|
| `LLM_API_KEY` | LLM API 密钥 | 建议 |
| `LLM_API_BASE` | LLM API 地址 | 可选 |
| `LLM_MODEL` | LLM 模型名称 | 可选 |

- **获取方式**: 使用任何 OpenAI 兼容的 API 提供商的密钥，如 [AIHubMix](https://aihubmix.com)、[OpenRouter](https://openrouter.ai) 等
- **默认值**: `LLM_API_BASE` 默认为 `https://aihubmix.com/v1`，`LLM_MODEL` 默认为 `claude-sonnet-4-20250514`
- **作用**: 用于水瀬的自主反思（memory-reflect）、灵感收集等需要 LLM 推理的场景。失败时会自动重试一次

OPENCLAW_RAW_STREAM=1 npx openclaw gateway 

## 许可

MIT
