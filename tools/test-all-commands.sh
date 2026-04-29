#!/bin/bash
# test-all-commands.sh
# 真实运行所有 /alive 斜杠命令，捕获命令+中间运行过程+结果+报错
# macOS 兼容版（不依赖 timeout 命令）

set -uo pipefail

PROJECT_DIR="/Users/halyu/Documents/Code/Alive"
ADMIN_HANDLER="$PROJECT_DIR/dist-alive/scripts/admin/command-handler.js"
OPS_HANDLER="$PROJECT_DIR/dist-alive/scripts/ops/ops-command-handler.js"
OUTPUT_DIR="$PROJECT_DIR/docs"
TIMESTAMP=$(date '+%Y-%m-%d-%H%M%S')
OUTPUT_FILE="$OUTPUT_DIR/slash-command-test-${TIMESTAMP}.md"
ERROR_FILE="$OUTPUT_DIR/slash-command-issues-${TIMESTAMP}.md"

# 确保 dist 是最新的
cd "$PROJECT_DIR"
echo "Building project..."
npm run build 2>&1 | tail -3

# 初始化输出文件
cat > "$OUTPUT_FILE" <<HEADER
# Alive 斜杠命令全量真实测试

> 本文档由 test-all-commands.sh 自动生成
> 所有命令均为真实运行，不使用 mock

- **生成时间**: $(date '+%Y-%m-%d %H:%M:%S')
- **项目路径**: $PROJECT_DIR
- **Admin Handler**: $ADMIN_HANDLER
- **Ops Handler**: $OPS_HANDLER

HEADER

# 加载环境变量
export ALIVE_PERSONA="${ALIVE_PERSONA:-miss-v}"
source_env() {
  local config_file="$HOME/.openclaw/openclaw.json"
  if [ -f "$config_file" ]; then
    eval "$(python3 -c "
import json
cfg = json.load(open('$config_file'))
env = cfg.get('skills', {}).get('entries', {}).get('alive', {}).get('env', {})
for k, v in env.items():
    if v:
        print(f'export {k}=\\\"{v}\\\"')
")"
  fi
}
source_env

FAILED_CMDS=()
WARN_CMDS=()

# 运行命令并记录
run_cmd() {
  local label="$1"
  shift
  local timeout_sec="${1:-60}"
  shift
  # remaining args are the command
  local cmd=("$@")

  echo "" >> "$OUTPUT_FILE"
  echo "---" >> "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
  echo "## $label" >> "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
  echo '```bash' >> "$OUTPUT_FILE"
  echo "${cmd[*]}" >> "$OUTPUT_FILE"
  echo '```' >> "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
  echo "### 输出" >> "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"

  local tmp_stdout="/tmp/alive-cmd-stdout-$$.txt"
  local tmp_stderr="/tmp/alive-cmd-stderr-$$.txt"
  local exit_code=0

  echo "⏳ 运行: ${cmd[*]}"

  # 使用 perl 作为 macOS 兼容的 timeout 替代
  if command -v perl &>/dev/null; then
    perl -e 'alarm shift; exec @ARGV' "$timeout_sec" "${cmd[@]}" > "$tmp_stdout" 2> "$tmp_stderr" || exit_code=$?
  else
    "${cmd[@]}" > "$tmp_stdout" 2> "$tmp_stderr" || exit_code=$?
  fi

  # 清理 ANSI 颜色码
  local clean_stdout="/tmp/alive-cmd-clean-$$.txt"
  sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$tmp_stdout" > "$clean_stdout" 2>/dev/null || true

  echo '```' >> "$OUTPUT_FILE"
  cat "$clean_stdout" >> "$OUTPUT_FILE" 2>/dev/null || true
  echo '```' >> "$OUTPUT_FILE"

  if [ -s "$tmp_stderr" ]; then
    echo "" >> "$OUTPUT_FILE"
    echo "### stderr 日志" >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE"
    echo '```' >> "$OUTPUT_FILE"
    sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$tmp_stderr" >> "$OUTPUT_FILE" 2>/dev/null || true
    echo '```' >> "$OUTPUT_FILE"
  fi

  echo "" >> "$OUTPUT_FILE"
  echo "### 执行信息" >> "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
  echo "| 项目 | 值 |" >> "$OUTPUT_FILE"
  echo "|------|------|" >> "$OUTPUT_FILE"
  echo "| 退出码 | $exit_code |" >> "$OUTPUT_FILE"
  echo "| 超时设置 | ${timeout_sec}s |" >> "$OUTPUT_FILE"

  if [ $exit_code -ne 0 ]; then
    echo "| 状态 | ❌ 失败 |" >> "$OUTPUT_FILE"
    FAILED_CMDS+=("$label")
    echo "  ⚠️ 失败: ${cmd[*]} (exit=$exit_code)"
  else
    echo "| 状态 | ✅ 成功 |" >> "$OUTPUT_FILE"
    echo "  ✅ 成功: ${cmd[*]}"
  fi

  # 检查输出中是否有 ⚠️ 警告
  if grep -q '⚠️' "$clean_stdout" 2>/dev/null; then
    WARN_CMDS+=("$label (输出含警告)")
  fi

  rm -f "$tmp_stdout" "$tmp_stderr" "$clean_stdout"
}

# ════════════════════════════════════════════════════════════════════
# 一、Admin 命令组
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 一、Admin 命令组" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "> 通过 command-handler.js 运行，不需要 LLM API key" >> "$OUTPUT_FILE"

run_cmd "1. /alive help" 30 node "$ADMIN_HANDLER" help
run_cmd "2. /alive status" 30 node "$ADMIN_HANDLER" status
run_cmd "3. /alive emotion" 30 node "$ADMIN_HANDLER" emotion
run_cmd "4. /alive schedule" 30 node "$ADMIN_HANDLER" schedule
run_cmd "5. /alive skills" 30 node "$ADMIN_HANDLER" skills
run_cmd "6. /alive features" 30 node "$ADMIN_HANDLER" features
run_cmd "7. /alive platform" 30 node "$ADMIN_HANDLER" platform
run_cmd "8. /alive memory" 30 node "$ADMIN_HANDLER" memory
run_cmd "9. /alive setup" 30 node "$ADMIN_HANDLER" setup
run_cmd "10. /alive setup llm" 30 node "$ADMIN_HANDLER" setup llm
run_cmd "11. /alive setup instagram" 30 node "$ADMIN_HANDLER" setup instagram
run_cmd "12. /alive emotion --reset" 30 node "$ADMIN_HANDLER" emotion --reset
run_cmd "13. /alive schedule --wake 9 --sleep 1" 30 node "$ADMIN_HANDLER" schedule --wake 9 --sleep 1
run_cmd "14. /alive reset emotion" 30 node "$ADMIN_HANDLER" reset emotion
run_cmd "15. /alive reset vitality" 30 node "$ADMIN_HANDLER" reset vitality
run_cmd "16. /alive reset flow" 30 node "$ADMIN_HANDLER" reset flow
run_cmd "17. /alive reset intents" 30 node "$ADMIN_HANDLER" reset intents

# ════════════════════════════════════════════════════════════════════
# 二、KB 命令组
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 二、爆款知识库命令组 (KB)" >> "$OUTPUT_FILE"

run_cmd "18. /alive kb" 30 node "$ADMIN_HANDLER" kb
run_cmd "19. /alive kb status" 30 node "$ADMIN_HANDLER" kb status
run_cmd "20. /alive kb search 赛车" 30 node "$ADMIN_HANDLER" kb search 赛车
run_cmd "21. /alive kb list" 30 node "$ADMIN_HANDLER" kb list
run_cmd "22. /alive kb formulas" 30 node "$ADMIN_HANDLER" kb formulas
run_cmd "23. /alive kb top --limit 5" 30 node "$ADMIN_HANDLER" kb top --limit 5
run_cmd "23b. /alive kb audit（空壳条目审计）" 30 node "$ADMIN_HANDLER" kb audit
run_cmd "23c. /alive kb repair --limit 3（修复空壳条目）" 30 node "$ADMIN_HANDLER" kb repair --limit 3

# ════════════════════════════════════════════════════════════════════
# 三、Strategy 命令组
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 三、运营策略命令组 (Strategy)" >> "$OUTPUT_FILE"

run_cmd "24. /alive strategy" 30 node "$ADMIN_HANDLER" strategy
run_cmd "25. /alive confirm-strategy" 30 node "$ADMIN_HANDLER" confirm-strategy
run_cmd "26. /alive insights" 30 node "$ADMIN_HANDLER" insights
run_cmd "27. /alive patterns" 30 node "$ADMIN_HANDLER" patterns

# ════════════════════════════════════════════════════════════════════
# 四、Ops 命令组（真实搜索+真实LLM）
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 四、运营工作台命令组 (Ops)" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "> 通过 ops-command-handler.js 运行，需要 LLM API key 和真实搜索" >> "$OUTPUT_FILE"

run_cmd "28. /alive brief（运营简报 - 真实搜索+LLM）" 600 node "$OPS_HANDLER" brief
run_cmd "29. /alive trends（热点趋势 - 真实搜索+LLM）" 300 node "$OPS_HANDLER" trends
run_cmd "30. /alive idea（选题生成 - 真实搜索+LLM）" 600 node "$OPS_HANDLER" idea
run_cmd "31. /alive idea 电竞（指定方向选题 - 真实搜索+LLM）" 600 node "$OPS_HANDLER" idea 电竞
run_cmd "32. /alive post（选题列表 - 本地队列）" 30 node "$OPS_HANDLER" post
run_cmd "33. /alive post 1（第1个选题详情）" 30 node "$OPS_HANDLER" post 1
run_cmd "34. /alive analyze（缺 URL 测试）" 30 node "$OPS_HANDLER" analyze
run_cmd "35. /alive advice（人设建议 - 真实搜索+LLM）" 300 node "$OPS_HANDLER" advice
run_cmd "36. /alive status（运营队列状态）" 30 node "$OPS_HANDLER" status
run_cmd "37. /alive candidates（候选对标）" 30 node "$OPS_HANDLER" candidates
run_cmd "38. /alive health（健康检查）" 30 node "$OPS_HANDLER" health
run_cmd "39. /alive help（运营帮助）" 30 node "$OPS_HANDLER" help
run_cmd "39b. /alive review（LLM 快速审核）" 300 node "$OPS_HANDLER" review
run_cmd "39c. /alive review approve-all（一键通过）" 30 node "$OPS_HANDLER" review approve-all
run_cmd "39d. /alive review discard-low（弃置低分）" 300 node "$OPS_HANDLER" review discard-low

# ════════════════════════════════════════════════════════════════════
# 五、Create 命令组（需要 LLM）
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 五、角色创建命令组 (Create)" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "> /alive create 需要 LLM API，/alive create --guided 不需要" >> "$OUTPUT_FILE"

run_cmd "40. /alive create（随机生成 - 真实 LLM）" 300 node "$ADMIN_HANDLER" create
run_cmd "41. /alive create --guided（引导模式问卷）" 30 node "$ADMIN_HANDLER" create --guided

# ════════════════════════════════════════════════════════════════════
# 汇总
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "---" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "## 测试汇总" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

TOTAL=47
FAILED=${#FAILED_CMDS[@]}
WARN=${#WARN_CMDS[@]}
PASSED=$((TOTAL - FAILED))

echo "| 指标 | 值 |" >> "$OUTPUT_FILE"
echo "|------|------|" >> "$OUTPUT_FILE"
echo "| 总命令数 | $TOTAL |" >> "$OUTPUT_FILE"
echo "| ✅ 成功 | $PASSED |" >> "$OUTPUT_FILE"
echo "| ❌ 失败 | $FAILED |" >> "$OUTPUT_FILE"
echo "| ⚠️ 含警告 | $WARN |" >> "$OUTPUT_FILE"
echo "| 测试时间 | $(date '+%Y-%m-%d %H:%M:%S') |" >> "$OUTPUT_FILE"
echo "| ALIVE_PERSONA | $ALIVE_PERSONA |" >> "$OUTPUT_FILE"
echo "| LLM_API_KEY | $([ -n "${LLM_API_KEY:-}" ] && echo '已设置' || echo '未设置') |" >> "$OUTPUT_FILE"
echo "| LLM_MODEL | ${LLM_MODEL:-未设置} |" >> "$OUTPUT_FILE"

if [ ${#FAILED_CMDS[@]} -gt 0 ]; then
  echo "" >> "$OUTPUT_FILE"
  echo "### 失败命令列表" >> "$OUTPUT_FILE"
  for cmd in "${FAILED_CMDS[@]}"; do
    echo "- $cmd" >> "$OUTPUT_FILE"
  done
fi

if [ ${#WARN_CMDS[@]} -gt 0 ]; then
  echo "" >> "$OUTPUT_FILE"
  echo "### 含警告命令列表" >> "$OUTPUT_FILE"
  for cmd in "${WARN_CMDS[@]}"; do
    echo "- $cmd" >> "$OUTPUT_FILE"
  done
fi

echo ""
echo "✅ 测试完成！"
echo "   输出文件: $OUTPUT_FILE"
echo "   总: $TOTAL  成功: $PASSED  失败: $FAILED  警告: $WARN"

# ════════════════════════════════════════════════════════════════════
# 生成问题文档
# ════════════════════════════════════════════════════════════════════

cat > "$ERROR_FILE" <<HEADER
# Alive 斜杠命令测试 — 问题清单

> 基于测试结果自动分析

- **生成时间**: $(date '+%Y-%m-%d %H:%M:%S')
- **对应测试文件**: $(basename "$OUTPUT_FILE")

HEADER

if [ ${#FAILED_CMDS[@]} -gt 0 ]; then
  echo "## ❌ 失败项 (exit ≠ 0)" >> "$ERROR_FILE"
  echo "" >> "$ERROR_FILE"
  for cmd in "${FAILED_CMDS[@]}"; do
    echo "- $cmd" >> "$ERROR_FILE"
  done
  echo "" >> "$ERROR_FILE"
else
  echo "## ❌ 失败项" >> "$ERROR_FILE"
  echo "" >> "$ERROR_FILE"
  echo "- 无" >> "$ERROR_FILE"
  echo "" >> "$ERROR_FILE"
fi

if [ ${#WARN_CMDS[@]} -gt 0 ]; then
  echo "## ⚠️ 警告项（输出含 ⚠️ 标记）" >> "$ERROR_FILE"
  echo "" >> "$ERROR_FILE"
  for cmd in "${WARN_CMDS[@]}"; do
    echo "- $cmd" >> "$ERROR_FILE"
  done
  echo "" >> "$ERROR_FILE"
else
  echo "## ⚠️ 警告项" >> "$ERROR_FILE"
  echo "" >> "$ERROR_FILE"
  echo "- 无" >> "$ERROR_FILE"
  echo "" >> "$ERROR_FILE"
fi

# 提取关键错误信息
echo "## 📋 关键错误信息提取" >> "$ERROR_FILE"
echo "" >> "$ERROR_FILE"
# 从输出文件中提取 stderr 的关键行
grep -A 2 "stderr 日志" "$OUTPUT_FILE" 2>/dev/null | grep -v "^--$\|^###\|^$" | head -50 >> "$ERROR_FILE" || echo "- 无关键错误" >> "$ERROR_FILE"

echo "" >> "$ERROR_FILE"
echo "## 🔧 环境信息" >> "$ERROR_FILE"
echo "" >> "$ERROR_FILE"
echo "| 变量 | 值 |" >> "$ERROR_FILE"
echo "|------|------|" >> "$ERROR_FILE"
echo "| ALIVE_PERSONA | $ALIVE_PERSONA |" >> "$ERROR_FILE"
echo "| LLM_API_KEY | $([ -n "${LLM_API_KEY:-}" ] && echo '已设置' || echo '❌ 未设置') |" >> "$ERROR_FILE"
echo "| LLM_API_BASE | ${LLM_API_BASE:-❌ 未设置} |" >> "$ERROR_FILE"
echo "| LLM_MODEL | ${LLM_MODEL:-❌ 未设置} |" >> "$ERROR_FILE"
echo "| BILIBILI_COOKIE | $([ -n "${BILIBILI_COOKIE:-}" ] && echo '已设置' || echo '❌ 未设置') |" >> "$ERROR_FILE"
echo "| AIHUBMIX_API_KEY | $([ -n "${AIHUBMIX_API_KEY:-}" ] && echo '已设置' || echo '❌ 未设置') |" >> "$ERROR_FILE"

echo ""
echo "✅ 问题文档: $ERROR_FILE"
