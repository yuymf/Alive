#!/usr/bin/env bash
# 一条命令起 Alive 全双工语音三件套：VoxCPM2 TTS 侧车 / LiveKit 服务器 / agent worker。
#
# 用法：
#   alive/voice/start-all.sh start     # 启动（已跑的跳过）+ 等健康 + 预热模型
#   alive/voice/start-all.sh stop      # 停三件套
#   alive/voice/start-all.sh status    # 看 pid / 端口 / 健康
#   alive/voice/start-all.sh warmup    # 只跑一次合成，量首字耗时
#
# 配置来源（按顺序 overlay，后者覆盖前者）：本目录 voice.env → $ALIVE_HOME/.env → 进程环境。
# voice.env 随仓库走（只有本机地址与 LiveKit dev 默认账密），用户私有覆盖放 $ALIVE_HOME/.env。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ALIVE_HOME="${ALIVE_HOME:-$HOME/.alive}"
RUN_DIR="${ALIVE_RUN_DIR:-$ALIVE_HOME/run}"
LOG_DIR="${ALIVE_LOG_DIR:-$ALIVE_HOME/logs}"
PY="${ALIVE_PY:-$REPO_ROOT/.venv-voice/bin/python}"
mkdir -p "$RUN_DIR" "$LOG_DIR"

for f in "$HERE/voice.env" "$ALIVE_HOME/.env"; do
  if [ -f "$f" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$f"
    set +a
  fi
done

: "${VOXCPM_HOST:=127.0.0.1}"
: "${VOXCPM_PORT:=8801}"
: "${VOXCPM_MODEL:=/mnt/data/models/VoxCPM2}"
: "${VOXCPM_CUDA:=1}"
: "${LIVEKIT_BIND:=127.0.0.1}"
: "${LIVEKIT_NODE_IP:=127.0.0.1}"
: "${LIVEKIT_URL:=ws://127.0.0.1:7880}"
: "${LIVEKIT_API_KEY:=devkey}"
: "${LIVEKIT_API_SECRET:=secret}"
: "${LIVEKIT_WORKER_PORT:=8081}"
: "${VOXCPM_URL:=http://127.0.0.1:$VOXCPM_PORT}"
: "${WARMUP_TEXT:=你好，我是你的语音助手。}"
export VOXCPM_HOST VOXCPM_PORT VOXCPM_MODEL VOXCPM_URL LIVEKIT_URL LIVEKIT_API_KEY \
  LIVEKIT_API_SECRET LIVEKIT_WORKER_PORT

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# 端口反查真实监听进程 pid：setsid 后 $! 可能不是最终进程，pid 文件以端口为准最可靠。
pid_of_port() { ss -tlnp 2>/dev/null | grep -E ":$1\b" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

health_voxcpm() { curl -sS --noproxy '*' -m 5 "http://$VOXCPM_HOST:$VOXCPM_PORT/health"; }
health_livekit() { curl -sS --noproxy '*' -m 5 -o /dev/null -w '%{http_code}' "http://$LIVEKIT_BIND:7880/"; }

start_voxcpm() {
  if pid_alive "$RUN_DIR/voxcpm.pid"; then
    echo "[voxcpm] already running pid=$(cat "$RUN_DIR/voxcpm.pid")"
  else
    echo "[voxcpm] starting on $VOXCPM_HOST:$VOXCPM_PORT (model=$VOXCPM_MODEL, CUDA_VISIBLE_DEVICES=$VOXCPM_CUDA)"
    CUDA_VISIBLE_DEVICES="$VOXCPM_CUDA" setsid nohup "$PY" "$HERE/voxcpm/server.py" \
      >"$LOG_DIR/voxcpm.log" 2>&1 &
    echo $! >"$RUN_DIR/voxcpm.pid"
  fi
  for _ in $(seq 1 60); do
    if health_voxcpm >/dev/null 2>&1; then
      local lp; lp=$(pid_of_port "$VOXCPM_PORT"); [ -n "$lp" ] && echo "$lp" >"$RUN_DIR/voxcpm.pid"
      echo "[voxcpm] health ok: $(health_voxcpm) pid=$(cat "$RUN_DIR/voxcpm.pid")"
      return 0
    fi
    sleep 1
  done
  echo "[voxcpm] health 超时，见 $LOG_DIR/voxcpm.log" >&2
  return 1
}

start_livekit() {
  if pid_alive "$RUN_DIR/livekit.pid"; then
    echo "[livekit] already running pid=$(cat "$RUN_DIR/livekit.pid")"
  else
    echo "[livekit] starting on $LIVEKIT_BIND:7880 --dev (node-ip=$LIVEKIT_NODE_IP)"
    setsid nohup livekit-server --dev --bind "$LIVEKIT_BIND" --node-ip "$LIVEKIT_NODE_IP" \
      >"$LOG_DIR/livekit.log" 2>&1 &
    echo $! >"$RUN_DIR/livekit.pid"
  fi
  for _ in $(seq 1 30); do
    if [ "$(health_livekit 2>/dev/null || true)" = "200" ]; then
      local lp; lp=$(pid_of_port 7880); [ -n "$lp" ] && echo "$lp" >"$RUN_DIR/livekit.pid"
      echo "[livekit] http://$LIVEKIT_BIND:7880/ → 200 pid=$(cat "$RUN_DIR/livekit.pid")"
      return 0
    fi
    sleep 1
  done
  echo "[livekit] 起不来，见 $LOG_DIR/livekit.log" >&2
  return 1
}

warmup() {
  echo "[warmup] 首次合成（含模型加载/编译，可能要几分钟）→ 文本: $WARMUP_TEXT"
  local t0 t1 out
  t0=$(date +%s.%N)
  out=$(curl -sS --noproxy '*' -m 900 -o "$RUN_DIR/warmup.pcm" -w '%{http_code}' \
    -X POST "http://$VOXCPM_HOST:$VOXCPM_PORT/v1/audio/speech" \
    -H 'Content-Type: application/json' \
    -d "{\"input\":\"$WARMUP_TEXT\",\"voice\":\"default\"}")
  t1=$(date +%s.%N)
  if [ "$out" != "200" ]; then
    echo "[warmup] 失败 http=$out，见 $LOG_DIR/voxcpm.log" >&2
    return 1
  fi
  echo "[warmup] http=$out bytes=$(stat -c%s "$RUN_DIR/warmup.pcm") seconds=$(echo "$t1 - $t0" | bc)"
}

start_agent() {
  local persona_id="${1:-}"
  local agent_name worker_port voice pidfile logfile
  if [ -n "$persona_id" ]; then
    IFS=' ' read -r _id agent_name voice worker_port _cloned <<EOF
$("$PY" "$HERE/team.py" print | awk -v id="$persona_id" '$1==id {print}')
EOF
    if [ -z "${agent_name:-}" ]; then
      echo "[agent] unknown persona: $persona_id" >&2
      return 1
    fi
    pidfile="$RUN_DIR/agent-$persona_id.pid"
    logfile="$LOG_DIR/agent-$persona_id.log"
  else
    agent_name="${AGENT_NAME:-alive-voice}"
    worker_port="${LIVEKIT_WORKER_PORT:-8081}"
    voice="${VOXCPM_VOICE:-default}"
    persona_id="${ALIVE_PERSONA:-minase}"
    pidfile="$RUN_DIR/agent.pid"
    logfile="$LOG_DIR/agent.log"
  fi
  if pid_alive "$pidfile"; then
    echo "[agent $persona_id] already running pid=$(cat "$pidfile") name=$agent_name port=$worker_port"
    return 0
  fi
  echo "[agent $persona_id] starting name=$agent_name port=$worker_port voice=$voice"
  (
    cd "$HERE/agent" && \
    AGENT_NAME="$agent_name" \
    ALIVE_PERSONA="$persona_id" \
    VOXCPM_VOICE="$voice" \
    LIVEKIT_WORKER_PORT="$worker_port" \
    setsid nohup "$PY" agent.py dev >"$logfile" 2>&1 & echo $! >"$pidfile"
  )
  for _ in $(seq 1 90); do
    if grep -qE "registered worker|registered.*worker" "$logfile" 2>/dev/null; then
      local lp; lp=$(pid_of_port "$worker_port"); [ -n "$lp" ] && echo "$lp" >"$pidfile"
      echo "[agent $persona_id] registered: $(grep -E 'registered worker' "$logfile" | tail -1) pid=$(cat "$pidfile")"
      return 0
    fi
    sleep 1
  done
  echo "[agent $persona_id] 没等到注册，见 $logfile" >&2
  return 1
}

start_team() {
  echo "[team] Path A — one worker per persona"
  local id agent_name voice port cloned
  while read -r id agent_name voice port cloned; do
    [ -z "$id" ] && continue
    start_agent "$id" || return 1
  done < <("$PY" "$HERE/team.py" print)
}

# /token 与 /api/prompt 由编译后的 Node server 提供；team.yaml 是它的路由表。
start_voice_web() {
  local srv="$REPO_ROOT/dist-alive/scripts/voice/server.js"
  local port="${ALIVE_VOICE_PORT:-8766}"
  if [ ! -f "$srv" ]; then
    echo "[voice-web] compiling dist-alive (tsc)..."
    ( cd "$REPO_ROOT" && "$REPO_ROOT/node_modules/.bin/tsc" -p tsconfig.json ) || return 1
  fi
  if pid_alive "$RUN_DIR/voice-web.pid"; then
    echo "[voice-web] already running pid=$(cat "$RUN_DIR/voice-web.pid") port=$port"
    return 0
  fi
  echo "[voice-web] starting on 127.0.0.1:$port"
  (
    cd "$REPO_ROOT" && \
    setsid nohup node "$srv" >"$LOG_DIR/voice-web.log" 2>&1 & echo $! >"$RUN_DIR/voice-web.pid"
  )
  for _ in $(seq 1 30); do
    if curl -sS --noproxy '*' -m 2 -o /dev/null "http://127.0.0.1:$port/api/check"; then
      local lp; lp=$(pid_of_port "$port"); [ -n "$lp" ] && echo "$lp" >"$RUN_DIR/voice-web.pid"
      echo "[voice-web] health ok pid=$(cat "$RUN_DIR/voice-web.pid")"
      return 0
    fi
    sleep 1
  done
  echo "[voice-web] 起不来，见 $LOG_DIR/voice-web.log" >&2
  return 1
}

stop_team() {
  local id
  for id in $("$PY" "$HERE/team.py" print | awk '{print $1}'); do
    stop_one "agent-$id"
  done
  stop_one agent
}

stop_one() {
  local name="$1" pidfile="$RUN_DIR/$1.pid"
  if pid_alive "$pidfile"; then
    local p; p=$(cat "$pidfile")
    echo "[$name] stopping pid=$p"
    kill "$p" 2>/dev/null || true
    for _ in $(seq 1 20); do pid_alive "$pidfile" || break; sleep 0.5; done
    pid_alive "$pidfile" && { echo "[$name] 未退出，SIGKILL"; kill -9 "$p" 2>/dev/null || true; }
  else
    echo "[$name] not running"
  fi
  rm -f "$pidfile"
}

status() {
  for n in voxcpm livekit agent voice-web; do
    if pid_alive "$RUN_DIR/$n.pid"; then echo "$n: pid=$(cat "$RUN_DIR/$n.pid")"; else echo "$n: down"; fi
  done
  if [ -x "$PY" ] && [ -f "$HERE/team.py" ]; then
    local id agent_name voice port cloned
    while read -r id agent_name voice port cloned; do
      [ -z "$id" ] && continue
      if pid_alive "$RUN_DIR/agent-$id.pid"; then
        echo "agent-$id: pid=$(cat "$RUN_DIR/agent-$id.pid") name=$agent_name port=$port voice=$voice cloned=$cloned"
      else
        echo "agent-$id: down name=$agent_name port=$port"
      fi
    done < <("$PY" "$HERE/team.py" print)
  fi
  ss -tlnp 2>/dev/null | grep -E ':(7880|7881|8801|8081|8082|8084|8094)\b' || true
  echo "voxcpm health: $(health_voxcpm 2>/dev/null || echo down)"
}

case "${1:-start}" in
  start) start_voxcpm; start_livekit; warmup; start_voice_web; start_team; status ;;
  stop) stop_team; stop_one voice-web; stop_one livekit; stop_one voxcpm ;;
  start-agents) start_team; status ;;
  stop-agents) stop_team; status ;;
  start-web) start_voice_web; status ;;
  stop-web) stop_one voice-web; status ;;
  restart) "$0" stop; "$0" start ;;
  status) status ;;
  warmup) warmup ;;
  *) echo "用法: $0 {start|stop|restart|status|warmup|start-agents|stop-agents|start-web|stop-web}" >&2; exit 2 ;;
esac
