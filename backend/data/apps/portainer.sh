echo "==> Installing a private Docker environment for Portainer CE"
curl -fsSL https://get.docker.com | sh >/dev/null
systemctl enable --now docker
echo "==> Starting Portainer CE"
docker volume create portainer_data >/dev/null
docker rm -f portainer >/dev/null 2>&1 || true
docker run -d --name portainer --restart=always -p 8000:8000 -p 9443:9443 \
  -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:lts
echo "==> Portainer CE is running on https://<ip>:9443 (create the admin user within 5 minutes)"
echo "==> To manage the built-in Docker Engine too, add it in Portainer as an Agent environment"
