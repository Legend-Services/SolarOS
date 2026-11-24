echo "==> Installing Docker Engine"
curl -fsSL https://get.docker.com | sh >/dev/null
systemctl enable --now docker
echo "==> Downloading Immich release files"
mkdir -p /opt/immich && cd /opt/immich
curl -fsSL -o docker-compose.yml https://github.com/immich-app/immich/releases/latest/download/docker-compose.yml
curl -fsSL -o .env https://github.com/immich-app/immich/releases/latest/download/example.env
sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)/" .env
echo "==> Pulling and starting Immich (several GB, this takes a while)"
docker compose up -d --quiet-pull
echo "==> Immich is running on port 2283 (library in /opt/immich/library)"
