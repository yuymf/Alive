#!/bin/bash

# 运行 LLM dump 测试
# 非 LLM 模式（只看 prompt 组装和热榜采集）：
#   ./run_llm_dump_test.sh
#
# 真实 LLM 模式（需先设置环境变量）：
#   export LLM_API_KEY=xxx LLM_API_BASE=xxx LLM_MODEL=xxx
#   ./run_llm_dump_test.sh

if [ -z "$LLM_API_KEY" ]; then
  echo "ℹ️  LLM_API_KEY 未设置，将只运行 prompt capture 模式（A-D 段）"
  echo "   要启用真实 LLM 测试（E 段），请先 export LLM_API_KEY=..."
  echo ""
fi

./node_modules/.bin/vitest run alive/tests/ops/ops-llm-dump.test.ts --reporter=verbose 2>&1 | tee /tmp/llm-dump-test-output.log

echo ""
echo "=== 测试完成，结果已保存到 /tmp/llm-dump-test-output.log ==="
