echo "==> Installing Docker Engine"
curl -fsSL https://get.docker.com | sh >/dev/null
systemctl enable --now docker
echo "==> Starting Nginx Proxy Manager"
mkdir -p /opt/npm/data /opt/npm/letsencrypt
docker rm -f npm >/dev/null 2>&1 || true
docker run -d --name npm --restart=always -p 80:80 -p 81:81 -p 443:443 \
  -v /opt/npm/data:/data -v /opt/npm/letsencrypt:/etc/letsencrypt jc21/nginx-proxy-manager:latest
echo "==> Admin UI on port 81 (admin@example.com / changeme)"
