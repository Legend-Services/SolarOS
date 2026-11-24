#!/usr/bin/env bash
# Self-signed HTTPS certificate for SolarDeck's nginx. Run as root inside the SolarDeck container; idempotent.
# Called by install.sh and self-update.sh; the caller tests and reloads nginx afterwards.
#
# A certificate installed from Network & Services → Certificates (custom upload or ACME) is never replaced: only the
# certificate this script made (CN "SolarDeck self-signed") is renewed, when it expires within 30 days or the
# container's addresses or hostname changed. SSL_DIR / SSL_SNIPPET override the paths (tests).
set -euo pipefail

PREFIX="${SYSTEM_PREFIX:-solardeck}"
DIR="${SSL_DIR:-/etc/nginx/ssl}"
CRT="$DIR/${PREFIX}.crt"
KEY="$DIR/${PREFIX}.key"
SANS_FILE="$DIR/${PREFIX}.san"
SNIPPET="${SSL_SNIPPET:-/etc/nginx/${PREFIX}-ssl.conf}"
CN="SolarDeck self-signed"

command -v openssl >/dev/null || { apt-get install -y -qq openssl >/dev/null; }

HOST="$(hostname -s 2>/dev/null || hostname)"
IPS="$( (hostname -I 2>/dev/null || true) | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' || true)"
SAN="DNS:${HOST},DNS:${HOST}.local,DNS:localhost,IP:127.0.0.1"
for ip in $IPS; do SAN="${SAN},IP:${ip}"; done

write_snippet() {  # same format as net_services.apply_nginx_cert, so that code can replace it later
  printf 'listen 443 ssl;\nlisten [::]:443 ssl;\nssl_certificate %s;\nssl_certificate_key %s;\n' "$CRT" "$KEY" > "$SNIPPET"
}

if [[ -s "$CRT" ]]; then
  subject="$(openssl x509 -in "$CRT" -noout -subject 2>/dev/null || true)"
  if [[ "$subject" != *"$CN"* ]]; then
    echo "https: keeping the installed certificate (${subject#subject=})"
    [[ -s "$SNIPPET" ]] || write_snippet
    exit 0
  fi
  if openssl x509 -in "$CRT" -noout -checkend 2592000 >/dev/null 2>&1 && [[ "$(cat "$SANS_FILE" 2>/dev/null)" == "$SAN" ]]; then
    [[ -s "$SNIPPET" ]] || write_snippet
    echo "https: self-signed certificate is current"
    exit 0
  fi
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
CONF="$(mktemp)"
trap 'rm -f "$CONF" "$CRT.tmp" "$KEY.tmp"' EXIT
cat > "$CONF" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${CN}
O = SolarDeck
[ext]
subjectAltName = ${SAN}
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
EOF
# 825 days: the longest validity Apple platforms and Chrome accept for a certificate trusted by hand.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 825 \
  -config "$CONF" -keyout "$KEY.tmp" -out "$CRT.tmp" 2>/dev/null
chmod 600 "$KEY.tmp" "$CRT.tmp"
mv "$KEY.tmp" "$KEY"
mv "$CRT.tmp" "$CRT"
echo "$SAN" > "$SANS_FILE"
write_snippet
echo "https: created a self-signed certificate for ${SAN}"
