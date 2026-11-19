# alive-voice worker —— CPU-only 常驻容器（Step3-P2 dogfood）。
# 取代裸机 .venv-voice/bin/python agent.py dev；同 Python 3.10 + 同 livekit-agents 1.8.12。
#
# 0 显存：不装 CUDA/torch，不声明任何 GPU 设备，Runtime=runc（见 compose）。
# 日志：agent.py 的 print/[latency] 供宿主 harness 用 seek(offset) 读增量，
#       故 CMD append 到 bind-mount 的 /logs/agent.log（inode 不变，绝不 truncate）。
# 构建：docker compose -f alive/voice/worker/docker-compose.yml build
# 回退到裸机 venv 的一行命令：见 alive/voice/start-all.sh 与 var/restart_agent.sh 头注释。
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ALIVE_HOME=/nonexistent

WORKDIR /app

COPY worker/requirements.pin.txt /app/requirements.pin.txt
RUN pip install --no-cache-dir -r /app/requirements.pin.txt

# 只 COPY worker 运行需要的 .py（不含测试 / __pycache__ / 模型 / voice.env）。
COPY agent/agent.py agent/energy_vad.py agent/work_tools.py \
     agent/sherpa_stream_stt.py agent/voxcpm_tts.py agent/emotion_runtime.py /app/

# 情绪→控制串映射表：外部表，改表不改代码。路径由 ALIVE_EMOTION_MAP 显式钉住，
# 不依赖 __file__ 推导（容器里 .py 是平铺的，推导会落到 /emotion 上）。
COPY emotion/control-map.yaml /app/emotion/control-map.yaml

# exec 让 python 成为 PID 1，docker stop 的 SIGTERM 直达 livekit cli（优雅注销）。
# >> append：容器每次 restart 重新 open 同一 inode，从当前 EOF 追加，无稀疏 NUL 洞。
CMD ["sh", "-c", "exec python -u agent.py dev >> /logs/agent.log 2>&1"]
