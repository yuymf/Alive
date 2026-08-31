# Examples

从 [awesome-human-distillation](https://github.com/mliu98/awesome-human-distillation) 里挑了几份**已经能跑的公开人格 skill**，接进 Alive。

目录里大多数条目是蒸馏工具或私人关系 skill。这里只放公开人物、MIT、带 `SKILL.md`、可以直接 `adopt` 的。

```bash
npx alive init
npx alive adopt ./examples/ace-taffy
# 或
npx alive adopt ./examples/steve-jobs
```

也可以不经过本目录，直接对上游 git 跑 `adopt`。

| 例子 | 人 | 味道 | 上游 |
|:---|:---|:---|:---|
| `ace-taffy` | 永雏塔菲 | 虚拟偶像 + 单机主播 | [ace-taffy-skill](https://github.com/ly-xxx/ace-taffy-skill) |
| `steve-jobs` | Steve Jobs | 产品判断 · 叙事 | [steve-jobs-skill](https://github.com/alchaincyf/steve-jobs-skill) |
| `wangxiaobo` | 王小波 | 自由精神 · 黑色幽默 | [wangxiaobo-skill](https://github.com/Panmax/wangxiaobo-skill) |
| `wangyangming` | 王阳明 | 知行合一 · 致良知 | [wangyangming-skill](https://github.com/Panmax/wangyangming-skill) |
| `karpathy` | Andrej Karpathy | AI 工程现实主义 | [karpathy-skill](https://github.com/alchaincyf/karpathy-skill) |

完整清单见 [catalog.yaml](catalog.yaml)。

## 每个目录里有什么

- `SKILL.md` — 原始人格规则（对话和心跳都读）
- `persona.md` / `references/` — 有则保留
- `origin.yaml` — 上游地址、作者、许可证

`adopt` 之后，Alive 会再写出 `persona.yaml`（情绪基线、作息、子技能），原文拷到 `$ALIVE_HOME/personas/<id>/skill-source/`。

## 版权

这些 skill 都是上游的 **MIT** 副本，版权归原作者。Alive 只负责给它们身体。要更新某一份，重新 `git clone` 上游再覆盖对应目录，或直接：

```bash
npx alive adopt https://github.com/alchaincyf/steve-jobs-skill
```

更多案例：<https://github.com/mliu98/awesome-human-distillation>
