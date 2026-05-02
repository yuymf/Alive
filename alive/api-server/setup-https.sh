#!/usr/bin/env bash
set -euo pipefail

# ── Alive API Server HTTPS 一键部署脚本 ──
# 在云桌面上运行: bash setup-https.sh

IP="21.139.186.145"
DOMAIN="missv-ops.pages.woa.com"
BACKEND_PORT=3001

echo "=== 1/5 生成自签名 SSL 证书 ==="
sudo mkdir -p /etc/nginx/ssl
if [ -f /etc/nginx/ssl/server.crt ]; then
  echo "  证书已存在，跳过生成"
else
  sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/server.key \
    -out /etc/nginx/ssl/server.crt \
    -subj "/CN=${IP}"
  echo "  ✓ 证书已生成"
fi

echo "=== 2/5 写入 nginx 反代配置 ==="
sudo tee /etc/nginx/conf.d/api-proxy.conf <<EOF
# HTTP → HTTPS 重定向
server {
    listen 80;
    server_name ${IP};
    return 301 https://\$host\$request_uri;
}

# HTTPS 反代到 Express
server {
    listen 443 ssl;
    server_name ${IP};

    ssl_certificate     /etc/nginx/ssl/server.crt;
    ssl_certificate_key /etc/nginx/ssl/server.key;

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
echo "  ✓ nginx 配置已写入"

echo "=== 3/5 检查并启动 nginx ==="
sudo nginx -t
sudo systemctl start nginx || true
sudo systemctl enable nginx
echo "  ✓ nginx 已启动并设为开机自启"

echo "=== 4/5 更新 .env CORS 配置 ==="
ENV_FILE="/opt/alive/alive/api-server/.env"
# 尝试常见路径
for candidate in \
  "/opt/alive/alive/api-server/.env" \
  "$HOME/alive/alive/api-server/.env" \
  "$HOME/Alive/alive/api-server/.env"; do
  if [ -f "$candidate" ]; then
    ENV_FILE="$candidate"
    break
  fi
done

if [ -f "$ENV_FILE" ]; then
  if grep -q "^CORS_ORIGIN=" "$ENV_FILE"; then
    sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://${DOMAIN}|" "$ENV_FILE"
  else
    echo "CORS_ORIGIN=https://${DOMAIN}" >> "$ENV_FILE"
  fi
  echo "  ✓ .env CORS_ORIGIN 已更新为 https://${DOMAIN}"
else
  echo "  ⚠ 未找到 .env 文件，请手动设置 CORS_ORIGIN=https://${DOMAIN}"
  echo "    搜索路径: /opt/alive, \$HOME/alive, \$HOME/Alive"
fi

echo "=== 5/5 重启 Express ==="
if command -v pm2 &>/dev/null; then
  pm2 restart alive-api-server 2>/dev/null && echo "  ✓ pm2 已重启 alive-api-server" || echo "  ⚠ pm2 中未找到 alive-api-server，请手动重启"
else
  echo "  ⚠ pm2 未安装，请手动重启 Express"
fi

echo ""
echo "=== 部署完成，验证中... ==="
sleep 2
echo ""
if command -v curl &>/dev/null; then
  curl -sk "https://${IP}/api/health" && echo "" || echo "⚠ 健康检查失败，请检查服务是否正常"
fi

echo ""
echo "前端请设置: VITE_API_BASE_URL=https://${IP}"
