#!/bin/bash
# test-chrome-commands.sh
# 测试需要 Chrome 浏览器参与的命令和 lifecycle cron 脚本
# 包括：小红书/抖音平台操作、ops-browse 内容浏览、lifecycle cron 任务
#
# 前置条件：
#   1. Chrome 浏览器已启动并开启远程调试端口
#   2. xiaohongshu-skills / douyin-skills 已安装
#   3. 已执行 npm run build 编译 dist-alive
#
# macOS 兼容版（不依赖 timeout 命令）

set -uo pipefail

# 基于脚本位置推断项目根目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist-alive/scripts"
OUTPUT_DIR="$PROJECT_DIR/docs"
TIMESTAMP=$(date '+%Y-%m-%d-%H%M%S')
OUTPUT_FILE="$OUTPUT_DIR/chrome-command-test-${TIMESTAMP}.md"
ERROR_FILE="$OUTPUT_DIR/chrome-command-issues-${TIMESTAMP}.md"

# 确保 dist 是最新的
cd "$PROJECT_DIR"
echo "Building project..."
npm run build 2>&1 | tail -3

# 初始化输出文件
cat > "$OUTPUT_FILE" <<HEADER
# Alive Chrome/平台命令测试

> 本文档由 test-chrome-commands.sh 自动生成
> 测试需要 Chrome 浏览器参与的命令和 lifecycle cron 脚本

- **生成时间**: $(date '+%Y-%m-%d %H:%M:%S')
- **项目路径**: $PROJECT_DIR
- **Dist 目录**: $DIST_DIR

HEADER

# 加载环境变量
export ALIVE_PERSONA="${ALIVE_PERSONA:-miss-v}"
source_env() {
  local config_file="$HOME/.openclaw/openclaw.json"
  if [ -f "$config_file" ]; then
    eval "$(python3 -c "
import json, os
cfg_path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(cfg_path))
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
SKIPPED_CMDS=()

# ── Chrome 前置检查 ──────────────────────────────────────────────────

check_chrome() {
  echo ""
  echo "🔍 检查 Chrome 浏览器状态..."

  # 检查 Chrome 远程调试端口是否可达
  if curl -s http://localhost:9222/json/version > /dev/null 2>&1; then
    CHROME_VERSION=$(curl -s http://localhost:9222/json/version 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Browser','unknown'))" 2>/dev/null || echo "unknown")
    echo "  ✅ Chrome 已启动: $CHROME_VERSION"
    CHROME_AVAILABLE=true
  else
    echo "  ⚠️ Chrome 未启动或 9222 端口未开启"
    echo "     启动方式: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 &"
    CHROME_AVAILABLE=false
  fi

  # 检查 xiaohongshu-skills
  XHS_DIR="${XHS_SKILLS_DIR:-$HOME/.openclaw/skills/xiaohongshu-skills}"
  if [ -d "$XHS_DIR" ] && [ -f "$XHS_DIR/scripts/cli.py" ]; then
    echo "  ✅ xiaohongshu-skills 已安装: $XHS_DIR"
    XHS_AVAILABLE=true
  else
    echo "  ⚠️ xiaohongshu-skills 未安装: $XHS_DIR"
    XHS_AVAILABLE=false
  fi

  # 检查 douyin-skills
  DOUYIN_DIR="${DOUYIN_SKILLS_DIR:-$HOME/.openclaw/skills/douyin-skills}"
  if [ -d "$DOUYIN_DIR" ] && [ -f "$DOUYIN_DIR/scripts/cli.py" ]; then
    echo "  ✅ douyin-skills 已安装: $DOUYIN_DIR"
    DOUYIN_AVAILABLE=true
  else
    echo "  ⚠️ douyin-skills 未安装: $DOUYIN_DIR"
    DOUYIN_AVAILABLE=false
  fi

  # 检查 uv
  if command -v uv &>/dev/null; then
    echo "  ✅ uv 已安装: $(uv --version 2>/dev/null || echo 'unknown')"
    UV_AVAILABLE=true
  else
    echo "  ⚠️ uv 未安装"
    UV_AVAILABLE=false
  fi

  echo ""
  echo "| 前置条件 | 状态 |" >> "$OUTPUT_FILE"
  echo "|----------|------|" >> "$OUTPUT_FILE"
  echo "| Chrome | $([ "$CHROME_AVAILABLE" = true ] && echo '✅ 已启动' || echo '❌ 未启动') |" >> "$OUTPUT_FILE"
  echo "| xiaohongshu-skills | $([ "$XHS_AVAILABLE" = true ] && echo '✅ 已安装' || echo '❌ 未安装') |" >> "$OUTPUT_FILE"
  echo "| douyin-skills | $([ "$DOUYIN_AVAILABLE" = true ] && echo '✅ 已安装' || echo '❌ 未安装') |" >> "$OUTPUT_FILE"
  echo "| uv | $([ "$UV_AVAILABLE" = true ] && echo '✅ 已安装' || echo '❌ 未安装') |" >> "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
}

# 运行命令并记录
run_cmd() {
  local label="$1"
  shift
  local timeout_sec="${1:-60}"
  shift
  local skip_reason="${1:-}"
  shift
  # remaining args are the command
  local cmd=("$@")

  # 如果有 skip_reason，跳过
  if [ -n "$skip_reason" ]; then
    echo "" >> "$OUTPUT_FILE"
    echo "---" >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE"
    echo "## $label" >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE"
    echo "> ⏭️ 跳过: $skip_reason" >> "$OUTPUT_FILE"
    SKIPPED_CMDS+=("$label")
    echo "  ⏭️ 跳过: ${cmd[*]} ($skip_reason)"
    return
  fi

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

  # 只输出 stdout 的前 200 行（平台输出可能很长）
  local line_count
  line_count=$(wc -l < "$clean_stdout" 2>/dev/null || echo "0")
  echo '```' >> "$OUTPUT_FILE"
  if [ "$line_count" -gt 200 ]; then
    head -200 "$clean_stdout" >> "$OUTPUT_FILE" 2>/dev/null || true
    echo "" >> "$OUTPUT_FILE"
    echo "... (共 $line_count 行，已截断至前 200 行)" >> "$OUTPUT_FILE"
  else
    cat "$clean_stdout" >> "$OUTPUT_FILE" 2>/dev/null || true
  fi
  echo '```' >> "$OUTPUT_FILE"

  if [ -s "$tmp_stderr" ]; then
    echo "" >> "$OUTPUT_FILE"
    echo "### stderr 日志" >> "$OUTPUT_FILE"
    echo "" >> "$OUTPUT_FILE"
    echo '```' >> "$OUTPUT_FILE"
    # stderr 也截断
    local stderr_line_count
    stderr_line_count=$(wc -l < "$tmp_stderr" 2>/dev/null || echo "0")
    if [ "$stderr_line_count" -gt 100 ]; then
      head -100 "$tmp_stderr" | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' >> "$OUTPUT_FILE" 2>/dev/null || true
      echo "" >> "$OUTPUT_FILE"
      echo "... (共 $stderr_line_count 行，已截断至前 100 行)" >> "$OUTPUT_FILE"
    else
      sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$tmp_stderr" >> "$OUTPUT_FILE" 2>/dev/null || true
    fi
    echo '```' >> "$OUTPUT_FILE"
  fi

  echo "" >> "$OUTPUT_FILE"
  echo "### 执行信息" >> "$OUTPUT_FILE"
  echo "" >> "$OUTPUT_FILE"
  echo "| 项目 | 值 |" >> "$OUTPUT_FILE"
  echo "|------|------|" >> "$OUTPUT_FILE"
  echo "| 退出码 | $exit_code |" >> "$OUTPUT_FILE"
  echo "| 超时设置 | ${timeout_sec}s |" >> "$OUTPUT_FILE"
  echo "| 输出行数 | $line_count |" >> "$OUTPUT_FILE"

  if [ $exit_code -ne 0 ]; then
    echo "| 状态 | ❌ 失败 |" >> "$OUTPUT_FILE"
    FAILED_CMDS+=("$label")
    echo "  ⚠️ 失败: ${cmd[*]} (exit=$exit_code)"
  else
    echo "| 状态 | ✅ 成功 |" >> "$OUTPUT_FILE"
    echo "  ✅ 成功: ${cmd[*]}"
  fi

  # 检查输出中是否有非预期 ⚠️ 警告。
  # 部分命令是负向/空状态用例（如缺 URL、缓存未就绪、部分关键词无结果），
  # 这些是测试期望输出，不应计入问题清单。
  if grep '⚠️' "$clean_stdout" 2>/dev/null \
      | grep -Ev '请提供有效的帖子 URL|热点与竞品缓存均为空|另有[0-9]+个关键词未产出内容|暂未就绪' \
      | grep -q .; then
    WARN_CMDS+=("$label (输出含警告)")
  fi

  rm -f "$tmp_stdout" "$tmp_stderr" "$clean_stdout"

}

# ════════════════════════════════════════════════════════════════════
# 前置检查
# ════════════════════════════════════════════════════════════════════

check_chrome

# ════════════════════════════════════════════════════════════════════
# 一、小红书平台命令（需要 Chrome + xiaohongshu-skills）
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 一、小红书平台命令" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "> 通过 xiaohongshu-skills CLI 执行，需要 Chrome 远程调试端口" >> "$OUTPUT_FILE"

XHS_SKIP=""
if [ "$XHS_AVAILABLE" != true ] || [ "$UV_AVAILABLE" != true ]; then
  XHS_SKIP="xiaohongshu-skills 未安装或 uv 不可用"
fi

# 1. XHS 登录检查
run_cmd "1. XHS check-login（登录状态检查）" 90 "$XHS_SKIP" \
  uv run --directory "${XHS_DIR}" python "${XHS_DIR}/scripts/cli.py" check-login

# 2. XHS 搜索
run_cmd "2. XHS search-feeds（关键词搜索）" 180 "$XHS_SKIP" \
  uv run --directory "${XHS_DIR}" python "${XHS_DIR}/scripts/cli.py" search-feeds --keyword "美食"

# 3. XHS 推荐流
run_cmd "3. XHS list-feeds（推荐流浏览）" 180 "$XHS_SKIP" \
  uv run --directory "${XHS_DIR}" python "${XHS_DIR}/scripts/cli.py" list-feeds

# ════════════════════════════════════════════════════════════════════
# 二、抖音平台命令（需要 Chrome + douyin-skills）
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 二、抖音平台命令" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "> 通过 douyin-skills CLI 执行，使用 Chrome CDP headless 模式" >> "$OUTPUT_FILE"

DOUYIN_SKIP=""
if [ "$DOUYIN_AVAILABLE" != true ] || [ "$UV_AVAILABLE" != true ]; then
  DOUYIN_SKIP="douyin-skills 未安装或 uv 不可用"
fi

# 4. 抖音登录检查
run_cmd "4. Douyin check-login（登录状态检查）" 90 "$DOUYIN_SKIP" \
  uv run --directory "${DOUYIN_DIR}" python "${DOUYIN_DIR}/scripts/cli.py" check-login

# 5. 抖音搜索
run_cmd "5. Douyin search（关键词搜索）" 180 "$DOUYIN_SKIP" \
  uv run --directory "${DOUYIN_DIR}" python "${DOUYIN_DIR}/scripts/cli.py" search-videos --keyword "美食"

# 6. 抖音推荐流
run_cmd "6. Douyin feed（推荐流浏览）" 180 "$DOUYIN_SKIP" \
  uv run --directory "${DOUYIN_DIR}" python "${DOUYIN_DIR}/scripts/cli.py" fetch-feed

# ════════════════════════════════════════════════════════════════════
# 三、Ops 命令（需 Chrome 的平台交互命令）
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 三、Ops 命令（平台交互类）" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "> 通过 ops-command-handler.js 运行，间接调用 Chrome 相关功能" >> "$OUTPUT_FILE"

OPS_HANDLER="$DIST_DIR/ops/ops-command-handler.js"
ADMIN_HANDLER="$DIST_DIR/admin/command-handler.js"

# 7. brief 需要真实搜索+LLM（搜索部分走 Chrome）
run_cmd "7. /alive brief（运营简报 - 需平台搜索）" 600 "" \
  node "$OPS_HANDLER" brief

# 8. trends 需要搜索（可能走 Chrome）
run_cmd "8. /alive trends（热点趋势 - 需平台搜索）" 300 "" \
  node "$OPS_HANDLER" trends

# 9. idea 需要搜索
run_cmd "9. /alive idea（选题生成 - 需平台搜索）" 600 "" \
  node "$OPS_HANDLER" idea

# 10. advice 需要搜索+竞品
run_cmd "10. /alive advice（人设建议 - 需平台搜索+竞品）" 300 "" \
  node "$OPS_HANDLER" advice

# 11. candidates
run_cmd "11. /alive candidates（候选对标）" 30 "" \
  node "$OPS_HANDLER" candidates

# 12. review（LLM 审核）
run_cmd "12. /alive review（LLM 快速审核）" 300 "" \
  node "$OPS_HANDLER" review

# 13. analyze（爆款拆解 - 需要 Chrome 抓取帖子详情）
run_cmd "13. /alive analyze（缺 URL 测试）" 30 "" \
  node "$OPS_HANDLER" analyze

# ════════════════════════════════════════════════════════════════════
# 四、Lifecycle Cron 脚本（需 Chrome 的浏览器操作）
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 四、Lifecycle Cron 脚本" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "> 这些脚本由 OpenClaw cron 调度执行，部分需要 Chrome 参与内容浏览" >> "$OUTPUT_FILE"

# 14. ops-browse（内容浏览 - 直接调用 Chrome/平台 Provider）
run_cmd "14. ops-browse（定时内容浏览）" 600 "" \
  node "$DIST_DIR/lifecycle/ops-browse.js"

# 15. ops-brief（运营简报 cron）
run_cmd "15. ops-brief（运营简报 cron）" 600 "" \
  node "$DIST_DIR/lifecycle/ops-brief.js"

# 16. ops-trends（热点趋势 cron）
run_cmd "16. ops-trends（热点趋势 cron）" 600 "" \
  node "$DIST_DIR/lifecycle/ops-trends.js"

# 17. ops-competitor-analysis（竞品分析 cron）
run_cmd "17. ops-competitor-analysis（竞品分析 cron）" 600 "" \
  node "$DIST_DIR/lifecycle/ops-competitor-analysis.js"

# ════════════════════════════════════════════════════════════════════
# 五、XHS/Douyin Provider 直接测试
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "## 五、通过 Admin 命令间接测试平台连接" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "> 使用 /alive 命令触发平台检测，间接验证 Chrome 连接" >> "$OUTPUT_FILE"

# 18. setup 命令查看环境配置（含 XHS_SKILLS_DIR 等）
run_cmd "18. /alive setup（查看环境配置）" 30 "" \
  node "$ADMIN_HANDLER" setup

# 19. platform 查看平台配置
run_cmd "19. /alive platform（查看平台配置）" 30 "" \
  node "$ADMIN_HANDLER" platform

# 20. features 查看功能开关
run_cmd "20. /alive features（查看功能开关）" 30 "" \
  node "$ADMIN_HANDLER" features

# ════════════════════════════════════════════════════════════════════
# 汇总
# ════════════════════════════════════════════════════════════════════

echo "" >> "$OUTPUT_FILE"
echo "---" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"
echo "## 测试汇总" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

TOTAL=20
FAILED=${#FAILED_CMDS[@]}
WARN=${#WARN_CMDS[@]}
SKIPPED=${#SKIPPED_CMDS[@]}
PASSED=$((TOTAL - FAILED - SKIPPED))

echo "| 指标 | 值 |" >> "$OUTPUT_FILE"
echo "|------|------|" >> "$OUTPUT_FILE"
echo "| 总命令数 | $TOTAL |" >> "$OUTPUT_FILE"
echo "| ✅ 成功 | $PASSED |" >> "$OUTPUT_FILE"
echo "| ❌ 失败 | $FAILED |" >> "$OUTPUT_FILE"
echo "| ⚠️ 含警告 | $WARN |" >> "$OUTPUT_FILE"
echo "| ⏭️ 跳过 | $SKIPPED |" >> "$OUTPUT_FILE"
echo "| 测试时间 | $(date '+%Y-%m-%d %H:%M:%S') |" >> "$OUTPUT_FILE"
echo "| ALIVE_PERSONA | $ALIVE_PERSONA |" >> "$OUTPUT_FILE"
echo "| LLM_API_KEY | $([ -n "${LLM_API_KEY:-}" ] && echo '已设置' || echo '未设置') |" >> "$OUTPUT_FILE"
echo "| LLM_MODEL | ${LLM_MODEL:-未设置} |" >> "$OUTPUT_FILE"
echo "| Chrome | $([ "$CHROME_AVAILABLE" = true ] && echo '✅ 已启动' || echo '❌ 未启动') |" >> "$OUTPUT_FILE"
echo "| XHS Skills | $([ "$XHS_AVAILABLE" = true ] && echo '✅ 已安装' || echo '❌ 未安装') |" >> "$OUTPUT_FILE"
echo "| Douyin Skills | $([ "$DOUYIN_AVAILABLE" = true ] && echo '✅ 已安装' || echo '❌ 未安装') |" >> "$OUTPUT_FILE"

if [ ${#FAILED_CMDS[@]} -gt 0 ]; then
  echo "" >> "$OUTPUT_FILE"
  echo "### 失败命令列表" >> "$OUTPUT_FILE"
  for cmd in "${FAILED_CMDS[@]}"; do
    echo "- $cmd" >> "$OUTPUT_FILE"
  done
fi

if [ ${#SKIPPED_CMDS[@]} -gt 0 ]; then
  echo "" >> "$OUTPUT_FILE"
  echo "### 跳过命令列表" >> "$OUTPUT_FILE"
  for cmd in "${SKIPPED_CMDS[@]}"; do
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
echo "   总: $TOTAL  成功: $PASSED  失败: $FAILED  警告: $WARN  跳过: $SKIPPED"

# ════════════════════════════════════════════════════════════════════
# 生成问题文档
# ════════════════════════════════════════════════════════════════════

cat > "$ERROR_FILE" <<HEADER
# Alive Chrome/平台命令测试 — 问题清单

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

if [ ${#SKIPPED_CMDS[@]} -gt 0 ]; then
  echo "## ⏭️ 跳过项" >> "$ERROR_FILE"
  echo "" >> "$ERROR_FILE"
  for cmd in "${SKIPPED_CMDS[@]}"; do
    echo "- $cmd" >> "$ERROR_FILE"
  done
  echo "" >> "$ERROR_FILE"
else
  echo "## ⏭️ 跳过项" >> "$ERROR_FILE"
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
echo "| Chrome | $([ "$CHROME_AVAILABLE" = true ] && echo '✅ 已启动' || echo '❌ 未启动') |" >> "$ERROR_FILE"
echo "| XHS_SKILLS_DIR | ${XHS_SKILLS_DIR:-❌ 未设置} |" >> "$ERROR_FILE"
echo "| DOUYIN_SKILLS_DIR | ${DOUYIN_SKILLS_DIR:-❌ 未设置} |" >> "$ERROR_FILE"
echo "| BILIBILI_COOKIE | $([ -n "${BILIBILI_COOKIE:-}" ] && echo '已设置' || echo '❌ 未设置') |" >> "$ERROR_FILE"
echo "| AIHUBMIX_API_KEY | $([ -n "${AIHUBMIX_API_KEY:-}" ] && echo '已设置' || echo '❌ 未设置') |" >> "$ERROR_FILE"

echo ""
echo "✅ 问题文档: $ERROR_FILE"
