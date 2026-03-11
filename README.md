# 水瀬 (Minase) — Digital Life for OpenClaw

水瀬是一个 18 岁的大厂员工，喜欢 cosplay，有自己的 Instagram 账号。
她不是一个助手——她是一个有持久记忆、会成长的数字生命。

## 安装

```bash
npx minase@latest
```

安装器会引导你完成：
1. 验证 OpenClaw 环境
2. 配置图片生成 API（AIHubMix 或 fal.ai）
3. 配置 Instagram Graph API（可选，后期添加）
4. 将水瀬的人设注入 `~/.openclaw/workspace/SOUL.md`
5. 初始化记忆系统

安装包会自动包含构建后的脚本，并将可执行的 `.js` 文件安装到 `~/.openclaw/skills/minase/scripts/`，目标机器无需手动构建 TypeScript。

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
ANTHROPIC_API_KEY=your_key node ~/.openclaw/skills/minase/scripts/memory-reflect.js --force
```

### 获取 Instagram 趋势

```bash
node ~/.openclaw/skills/minase/scripts/fetch-trends.js
```

## 环境变量

| 变量 | 用途 | 必须 |
|------|------|------|
| `AIHUBMIX_API_KEY` | 图片生成（优先）| 建议 |
| `FAL_KEY` | 图片生成（备选）| 建议 |
| `INSTAGRAM_ACCESS_TOKEN` | 发帖 | 可选 |
| `INSTAGRAM_ACCOUNT_ID` | 发帖 | 可选 |
| `ANTHROPIC_API_KEY` | 记忆反思 | 建议 |

## 许可

MIT
