echo "==> Installing rclone (S3-compatible, SFTP and WebDAV uploads)"
apt-get install -y -qq rclone openssh-client >/dev/null
useradd --system --home /var/lib/solardeck-backup --create-home solardeck-backup 2>/dev/null || true
echo "==> Backup worker ready; SolarDeck starts offsite copies here"
