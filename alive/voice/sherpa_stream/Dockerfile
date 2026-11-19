# sherpa-onnx 流式 STT 服务 —— CPU-only，0 显存。
# 构建：见同目录 docker-compose.yml（模型只读挂载，不进镜像）
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SHERPA_PORT=8802 \
    SHERPA_MODEL_DIR=/models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30

WORKDIR /app

# onnxruntime(sherpa-onnx 自带) + numpy + aiohttp；纯 CPU wheel，无 CUDA 依赖
RUN pip install --no-cache-dir \
        "sherpa-onnx==1.13.8" \
        "numpy==2.2.6" \
        "aiohttp==3.14.5"

COPY server.py tail_flush.py /app/

EXPOSE 8802
CMD ["python", "server.py"]
