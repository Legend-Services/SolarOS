echo "==> Installing Ollama"
apt-get install -y -qq zstd >/dev/null
curl -fsSL https://ollama.com/install.sh | sh
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' >/etc/systemd/system/ollama.service.d/listen.conf
systemctl daemon-reload
systemctl restart ollama
echo "==> Ollama API on port 11434 (pull a model from Shell: ollama pull llama3.2)"
