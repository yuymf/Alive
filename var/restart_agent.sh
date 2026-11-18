#!/usr/bin/env bash
# 只重启 alive-voice worker「容器」（不动 VoxCPM / LiveKit / sherpa / hindsight-api /
# vup-team 3 个 worker / 本机其它 alive-baseline）。
# 卡面要求：worker 从裸机 .venv-voice 迁进 Docker 常驻容器后，冷启动验收
# （冷启动验收）每轮调本脚本重启 worker → 这里改用容器编排，且保持
# 「轮换日志 inode、等 registered worker」的原有语义，让 harness 读到本轮真实增量。
#
# 回退到裸机 venv（切回过渡态，一行，从仓库根执行）：
#   docker compose -f alive/voice/worker/docker-compose.yml down && \
#     ( cd alive/voice/agent && setsid nohup env SHERPA_WS_URL=ws://127.0.0.1:8802/v1/stt/stream \
#       SHERPA_PREFLIGHT=0 ALIVE_VAD_MIN_SILENCE=0.35 ../../.venv-voice/bin/python agent.py dev \
#       > ~/.alive/logs/agent.log 2>&1 & )
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKERCTL="$REPO_ROOT/alive/voice/worker/workerctl.sh"
LOG="${ALIVE_LOG_DIR:-$HOME/.alive/logs}/agent.log"

SHERPA_PREFLIGHT="${SHERPA_PREFLIGHT:-0}" \
ALIVE_VAD_MIN_SILENCE="${ALIVE_VAD_MIN_SILENCE:-0.35}" \
  bash "$WORKERCTL" restart

for _ in $(seq 1 60); do
  grep -a -q 'registered worker' "$LOG" 2>/dev/null && break
  sleep 1
done
grep -a -q 'registered worker' "$LOG" 2>/dev/null || {
  echo "[restart] 60s 未见 registered worker，见: bash $WORKERCTL logs" >&2
  exit 1
}
exit 0
