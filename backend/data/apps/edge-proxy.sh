echo "==> Installing nginx (reverse proxy + TCP/UDP streams)"
apt-get install -y -qq nginx libnginx-mod-stream git socat >/dev/null
rm -f /etc/nginx/sites-enabled/default
mkdir -p /etc/nginx/solardeck-proxy.d /var/lib/solardeck-proxy/acme
echo "==> Hardening the nginx service (read-only system, no new privileges, minimal capabilities)"
mkdir -p /etc/systemd/system/nginx.service.d
cat > /etc/systemd/system/nginx.service.d/solardeck-hardening.conf <<'EOF'
[Service]
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/log/nginx /var/lib/nginx /run /var/lib/solardeck-proxy
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_SETUID CAP_SETGID CAP_CHOWN CAP_DAC_OVERRIDE
EOF
systemctl daemon-reload
if ! systemctl restart nginx; then
  # Some container hosts cannot set up the sandbox namespaces: run without them rather than not at all.
  echo "==> Service sandboxing is not available in this container; continuing without it"
  rm -f /etc/systemd/system/nginx.service.d/solardeck-hardening.conf
  systemctl daemon-reload && systemctl restart nginx
fi
systemctl enable -q nginx
echo "==> Edge proxy ready; SolarDeck pushes its configuration"
