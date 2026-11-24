echo "==> Installing Samba"
apt-get install -y -qq samba >/dev/null
mkdir -p /srv/public
chmod 0755 /srv/public
cat >>/etc/samba/smb.conf <<'EOF'

[public]
   path = /srv/public
   guest ok = yes
   read only = yes
   browseable = yes
EOF
if [ -d /mnt/storage ]; then
  cat >>/etc/samba/smb.conf <<'EOF'

[storage]
   path = /mnt/storage
   read only = no
   browseable = yes
   force user = root
   valid users = @sambashare
EOF
  echo "==> Add a user with: useradd -M -G sambashare <name> && smbpasswd -a <name>"
fi
testparm -s >/dev/null
systemctl restart smbd
echo "==> Samba is running"
