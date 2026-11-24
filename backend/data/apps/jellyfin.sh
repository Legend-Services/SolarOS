echo "==> Adding Jellyfin repository"
mkdir -p /etc/apt/keyrings
curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/jellyfin.gpg
cat >/etc/apt/sources.list.d/jellyfin.sources <<EOF
Types: deb
URIs: https://repo.jellyfin.org/debian
Suites: bookworm
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/jellyfin.gpg
EOF
apt-get update -qq
echo "==> Installing Jellyfin (bundles jellyfin-ffmpeg with Intel VAAPI/QSV drivers)"
apt-get install -y -qq jellyfin >/dev/null
systemctl enable --now jellyfin
[ -e /dev/dri/renderD128 ] && echo "==> /dev/dri present: enable Intel QuickSync under Dashboard > Playback > Transcoding"
echo "==> Jellyfin is running on port 8096"
