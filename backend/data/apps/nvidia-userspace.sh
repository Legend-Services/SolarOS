# NVIDIA user-space libraries matching the host driver ($SD_NVIDIA_VERSION). The host owns the kernel module.
if ! nvidia-smi >/dev/null 2>&1; then
  echo "==> Installing NVIDIA user-space driver ${SD_NVIDIA_VERSION} (no kernel module)"
  apt-get install -y -qq kmod libglvnd0 >/dev/null
  RUN="/tmp/NVIDIA-Linux-x86_64-${SD_NVIDIA_VERSION}.run"
  curl -fsSL -o "$RUN" "https://download.nvidia.com/XFree86/Linux-x86_64/${SD_NVIDIA_VERSION}/NVIDIA-Linux-x86_64-${SD_NVIDIA_VERSION}.run"
  sh "$RUN" --silent --no-kernel-module --no-x-check --no-nouveau-check \
    || { echo "!! NVIDIA installer failed"; tail -n 30 /var/log/nvidia-installer.log; exit 1; }
  rm -f "$RUN"
fi
echo "==> GPU visible inside the container:"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
