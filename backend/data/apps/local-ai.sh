# Solar AI Studio. Env from the backend: SD_COMPUTE (cpu | nvidia:* | intel:* | amd:*), SD_WEBUI (0/1).
echo "==> Installing Ollama (compute target: ${SD_COMPUTE:-cpu})"
apt-get install -y -qq zstd >/dev/null
if [ "${SD_COMPUTE%%:*}" = amd ]; then
  apt-get install -y -qq pciutils >/dev/null  # lets the Ollama installer detect the AMD GPU and add ROCm
  curl -fsSL https://ollama.com/install.sh | sh
else
  # Hide host GPUs from the installer's lspci/lshw probe: with a visible NVIDIA card and no nvidia-smi it would try
  # to install CUDA kernel drivers, which cannot work in a container. NVIDIA targets already have nvidia-smi.
  mkdir -p /tmp/sd-nogpu
  printf '#!/bin/sh\nexit 0\n' > /tmp/sd-nogpu/lspci
  cp /tmp/sd-nogpu/lspci /tmp/sd-nogpu/lshw
  chmod +x /tmp/sd-nogpu/lspci /tmp/sd-nogpu/lshw
  curl -fsSL https://ollama.com/install.sh | PATH="/tmp/sd-nogpu:$PATH" sh
  rm -rf /tmp/sd-nogpu
fi
case "${SD_COMPUTE%%:*}" in intel|amd) apt-get install -y -qq mesa-vulkan-drivers libvulkan1 >/dev/null ;; esac
mkdir -p /etc/systemd/system/ollama.service.d /usr/share/ollama/.ollama/models
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' >/etc/systemd/system/ollama.service.d/listen.conf
chown -R ollama:ollama /usr/share/ollama
systemctl daemon-reload
systemctl restart ollama
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
echo "==> Ollama API on port 11434 (OpenAI-compatible at /v1)"

install_webui() {
  apt-get install -y -qq python3-venv >/dev/null &&
    python3 -m venv /opt/open-webui &&
    /opt/open-webui/bin/pip install -q --upgrade pip &&
    /opt/open-webui/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cpu &&
    /opt/open-webui/bin/pip install -q open-webui &&
    mkdir -p /opt/open-webui/data &&
    printf '%s\n' '[Unit]' 'Description=Open WebUI' 'After=network-online.target ollama.service' '' '[Service]' \
      'Environment=DATA_DIR=/opt/open-webui/data' 'Environment=OLLAMA_BASE_URL=http://127.0.0.1:11434' \
      'ExecStart=/opt/open-webui/bin/open-webui serve --host 0.0.0.0 --port 3000' 'Restart=always' '' \
      '[Install]' 'WantedBy=multi-user.target' >/etc/systemd/system/open-webui.service &&
    systemctl daemon-reload &&
    systemctl enable --now open-webui
}
if [ "${SD_WEBUI:-0}" = 1 ]; then
  echo "==> Installing Open WebUI on port 3000 (Python venv, several minutes)"
  install_webui || echo "!! Open WebUI could not be installed; Ollama itself is ready."
fi
