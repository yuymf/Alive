# Exa 搜索能力集成设计

> Minase 的"掏手机查东西"能力——让她在对话和自主心跳中真正搜索而非模拟。

## 背景

当前 Minase 有 `学习` 和 `窥屏` 两个意图类别，但选中这些意图后只会产出 simulated action（假装搜了），不会真正执行搜索。`SKILL.md` 虽然声明了 `WebSearch`/`WebFetch`，但 heartbeat 脚本中没有对应的 real action 执行路径。

本设计引入 [Exa](https://exa.ai) 的免费 MCP 搜索端点作为底层，为 Minase 提供两个入口的真实搜索能力。

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 搜索后端 | Exa MCP (mcp.exa.ai/mcp) | 免费无 API key，神经搜索质量好 |
| Heartbeat 调用方式 | MCP SDK 直连 | 避免 mcporter CLI 依赖，Node.js 原生 |
| 知识沉淀 | 只记 diary.md | MVP 保持简单，不建知识库 |
| 不可用回退 | 降级为 simulated | 不做 WebSearch 回退，保持单一后端 |
| 执行模式 | Inline（非 detached） | 搜索结果需要写回 vitality 和 diary，不像 post-pipeline 可以后台跑 |
| MCP 传输 | SSE（需验证） | 实现前先 `curl` 测试 mcp.exa.ai/mcp 确认支持 SSE 协议；若仅支持 Streamable HTTP 则改用 `StreamableHTTPClientTransport` |

## 架构

```
┌─────────────────────────────────────────────────────┐
│                  Minase 搜索能力                      │
├────────────────────────┬────────────────────────────┤
│  入口 A: 对话场景       │  入口 B: Heartbeat 场景     │
│                        │                            │
│  SKILL.md 声明         │  search-pipeline.ts        │
│  mcp-tools:            │  (类似 post-pipeline.ts)    │
│    exa.web_search_exa  │                            │
│                        │  Intent 触发:               │
│  Agent 自行决定何时     │    学习 → search            │
│  "掏手机查一下"         │    窥屏 → browse + search   │
├────────────────────────┴────────────────────────────┤
│              共享底层: exa-client.ts                   │
│              MCP SSE → mcp.exa.ai/mcp               │
├─────────────────────────────────────────────────────┤
│              输出: diary.md 条目                      │
└─────────────────────────────────────────────────────┘
```

## 入口 A：对话场景

### SKILL.md 改动

在 `allowed-tools` 之后增加 MCP 工具声明：

```markdown
mcp-tools:
  exa:
    endpoint: https://mcp.exa.ai/mcp
    tools:
      - web_search_exa
```

### Behavior Trigger Map 增加

```markdown
## 搜索行为
trigger: 遇到不懂的话题 / 被问到不确定的事实 / 好奇心驱使
action: 用 web_search_exa 搜索，然后用自己的话复述给对方
persona: 像掏出手机查了一下的感觉，不是机器人式的"我来为您搜索"
```

### 效果

OpenClaw agent 收到 MCP 工具声明后，Minase 在对话中遇到不懂的东西可以自然地调用搜索。无需 TypeScript 代码改动。

## 入口 B：Heartbeat 搜索流水线

### 触发条件

在 `heartbeat-tick.ts` 的 real action 处理中增加搜索路由：

```typescript
const isSearchIntent = /search|搜|查|学习|研究|了解/.test(lowerSkill);
if (isSearchIntent) {
  vitality = await executeSearchPipeline(action, vitality, actionResults);
  continue;
}
```

### search-pipeline.ts 流程

```
1. extractQuery(action)            → 从 action 描述提取搜索关键词
2. checkSearchBudget()             → 检查当日搜索次数（≤5）和体力（>20）
3. exaWebSearch(query)             → MCP 调用 Exa 获取结果
4. digestResults(results, context) → LLM 消化结果，生成 Minase 视角摘要
5. writeDiary(summary)             → 通过 file-utils.ts 写入 diary.md
6. updateSearchState()             → 通过 writeJSON(PATHS.searchState, ...) 更新计数
7. applyActionCost(vitality, 'search') → 使用 vitality-engine 消耗体力
```

**注意**：所有 JSON 读写使用 `file-utils.ts` 的 `readJSON`/`writeJSON`（自动 `.bak` 备份和回退）。不直接操作 `fs`。

### exa-client.ts

封装 MCP 连接逻辑：

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_TIMEOUT_MS = 10_000;

export async function exaWebSearch(
  query: string,
  numResults = 5,
  searchType: 'auto' | 'fast' | 'deep' = 'auto'
): Promise<SearchResult[]> {
  const transport = new SSEClientTransport(new URL('https://mcp.exa.ai/mcp'));
  const client = new Client({ name: 'minase', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await Promise.race([
      client.callTool({
        name: 'web_search_exa',
        arguments: { query, numResults, searchType },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Exa search timeout')), SEARCH_TIMEOUT_MS)
      ),
    ]);
    return parseSearchResults(result);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * 解析 MCP CallToolResult 为 SearchResult[]。
 * Exa 的 web_search_exa 返回 content 数组，每项为 TextContent。
 * 具体结构需在集成测试中确认，此处做防御性解析。
 */
function parseSearchResults(result: unknown): SearchResult[] {
  // result.content is an array of { type: 'text', text: string }
  // The text field contains JSON or structured search result data
  // Implementation will be finalized after verifying Exa's actual response format
  return [];
}
```

超时通过 `Promise.race` 实现（10 秒）。连接失败或超时抛出错误，由 search-pipeline 捕获并降级。`client.close()` 的错误被静默忽略以防吞掉原始异常。

**注意**：`parseSearchResults()` 的具体实现需要在集成测试中确认 Exa `web_search_exa` 的实际返回格式后编写。MCP `CallToolResult` 的 `content` 数组通常为 `TextContent` 类型。

**执行模式说明**：search-pipeline 采用 **inline 执行**（直接 await），不像 post-pipeline 以 detached child process 运行。原因是搜索结果需要立即写回 vitality 和 diary，而 post-pipeline 可以后台慢慢跑。如果 Exa 响应慢，最多阻塞 10 秒（超时后降级）。

### search-digest-prompt.md（新模板）

```markdown
你是水瀬いのり。你刚用手机搜了"{query}"。

{voice_directive}

搜索结果：
{search_results}

请用你自己的话总结你学到了什么，写成日记格式。
不要罗列链接，用自然的口吻描述发现。
如果搜索结果不太相关或者没什么有用的，也诚实地说。
字数控制在 50-150 字。
```

### heartbeat-prompt.md 改动

在 action 类型说明处增加：

```markdown
### 可选 action 类型
- `type: "real", skill: "post-pipeline"` — 拍照发帖（需体力>30）
- `type: "real", skill: "search-pipeline"` — 掏手机搜索/研究某个问题（需体力>20）
- `type: "simulated"` — 想象/假装做某事
- `type: "inner"` — 内心独白
```

附加指引：

```markdown
当你对某件事好奇、想学新东西、或者需要了解信息时，可以选择 search-pipeline。
不要每个 tick 都搜——只在真正好奇或有明确问题时才搜。
搜索也消耗体力，不要在体力低的时候硬撑。
```

## 错误处理

| 场景 | 处理 |
|------|------|
| Exa MCP 连接超时（10s） | 降级为 simulated，日记写"手机信号不好没搜到..." |
| Exa 返回空结果 | LLM 消化时说明没找到有用的信息 |
| 当日搜索次数 ≥ 5 | 跳过搜索，降级为 simulated |
| 体力 ≤ 20 | 不触发搜索 action（intent engine 层面拦截） |

## 频率控制

- 每日最多 5 次搜索（硬上限）
- 在 `search-state.json` 中记录：`{ "date": "2026-03-16", "count": 0 }`
- 新的一天自动重置计数
- 体力门槛 >20

## 状态文件

`search-state.json`（初始值）：

```json
{
  "date": "",
  "count": 0
}
```

安装器 `bin/cli.js` 在初始化阶段创建此文件。

## 文件变动

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `skill/scripts/exa-client.ts` | MCP 连接封装 |
| 新建 | `skill/scripts/search-pipeline.ts` | 搜索流水线主逻辑 |
| 新建 | `skill/templates/search-digest-prompt.md` | LLM 消化搜索结果模板 |
| 修改 | `skill/scripts/heartbeat-tick.ts` | 增加 search action 路由 |
| 修改 | `skill/scripts/file-utils.ts` | 增加 `PATHS.searchState` getter |
| 修改 | `skill/scripts/vitality-engine.ts` | 增加 `'search'` action type 的体力消耗值 |
| 修改 | `skill/templates/heartbeat-prompt.md` | 增加搜索 action 说明 |
| 修改 | `skill/SKILL.md` | MCP 工具声明 + 搜索行为触发 + Memory File Paths 增加 search-state.json |
| 修改 | `package.json` | 增加 `@modelcontextprotocol/sdk` 依赖 |
| 修改 | `bin/cli.js` | 安装时创建 `search-state.json` |

## 新增依赖

- `@modelcontextprotocol/sdk` — MCP 客户端 SDK

**CommonJS 兼容性注意**：项目 tsconfig 使用 CommonJS 模块（`"module": "commonjs"`），但 `@modelcontextprotocol/sdk` 使用 ES 模块风格的子路径导入（如 `@modelcontextprotocol/sdk/client/index.js`）。实现前需验证该 SDK 的 `package.json` `exports` 是否支持 CommonJS resolution。若不支持，可能需要：
- 调整 tsconfig 的 `moduleResolution` 为 `"bundler"` 或 `"node16"`
- 或使用 `require()` 风格的动态导入

## 测试计划

- [ ] exa-client.ts 单元测试 — `vi.mock('@modelcontextprotocol/sdk/client/index.js')` mock Client 的 connect/callTool/close 方法；验证超时、错误处理、close 静默失败
- [ ] search-pipeline.ts 单元测试 — `vi.mock('./exa-client')` + `vi.mock('./llm-client')` mock 搜索和 LLM；验证完整流程、预算检查、降级逻辑
- [ ] heartbeat-tick.ts 中搜索路由的集成测试 — 验证 `skill: "search-pipeline"` 的 action 被正确路由
- [ ] 搜索频率控制 — 验证次数上限（5/天）、体力门槛（>20）、日期重置
- [ ] Exa 不可用时的降级行为 — 超时和连接错误都应产出 simulated diary 条目
- [ ] 手动集成验证 — 运行 heartbeat，确认搜索 action 产出和日记写入格式正确

## 实现前验证

在开始编码前，先验证 Exa MCP 端点的协议兼容性：

```bash
# 测试 SSE 连接是否可用
curl -N -H "Accept: text/event-stream" https://mcp.exa.ai/mcp
```

如果 SSE 不可用，检查 Streamable HTTP：

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}' \
  https://mcp.exa.ai/mcp
```

根据结果选择 `SSEClientTransport` 或 `StreamableHTTPClientTransport`。
