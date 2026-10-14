#!/usr/bin/env bash
# Sets up the Linux Practical Exam on a fresh Ubuntu 24.04 server (e.g. AWS EC2).
# Safe to run again: it updates the code and keeps existing settings and data.
#
#   sudo bash deploy/setup-ubuntu.sh
#
# Options (environment variables):
#   SITE_DOMAIN=exam.example.com   your own domain (default: <public-ip>.sslip.io)
#   REPO_URL=...                   default: https://github.com/EricRobuck/StudentTest.git
#   BRANCH=main
#   ENV_SOURCE=/tmp/linuxlab.env   first run only: use this prepared settings file
#
# Secrets are read from /opt/linuxlab/.env. If it doesn't exist yet, you're
# asked for them (or set INSTRUCTOR_PASSWORD / OPENAI_API_KEY beforehand).

set -euo pipefail

APP_DIR=/opt/linuxlab
APP_USER=linuxlab
REPO_URL=${REPO_URL:-https://github.com/EricRobuck/StudentTest.git}
BRANCH=${BRANCH:-main}

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0" >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive

say "Installing system packages"
apt-get update -q
apt-get install -y -q ca-certificates curl git gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v docker >/dev/null; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') -lt 24 ]]; then
  say "Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  say "Installing Caddy (HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

say "Creating the service account"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
# The exam server creates one container per student, so it needs Docker.
usermod -aG docker "$APP_USER"

say "Downloading the exam program"
if [[ -d $APP_DIR/.git ]]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data"

# Public address → free HTTPS name (1.2.3.4 → 1-2-3-4.sslip.io) unless a domain is given.
if [[ -z ${SITE_DOMAIN:-} ]]; then
  TOKEN=$(curl -s -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
  PUBLIC_IP=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
  [[ $PUBLIC_IP =~ ^[0-9.]+$ ]] || PUBLIC_IP=$(curl -s -m 5 https://checkip.amazonaws.com | tr -d '[:space:]')
  SITE_DOMAIN="${PUBLIC_IP//./-}.sslip.io"
fi
SITE_URL="https://$SITE_DOMAIN"

say "Settings ($APP_DIR/.env)"
ENV_FILE=$APP_DIR/.env
# ENV_SOURCE=/path/file: start from a prepared settings file (e.g. copied over
# with scp), so secrets never have to be typed or shown. The copy is removed.
if [[ -n ${ENV_SOURCE:-} && -f $ENV_SOURCE && ! -f $ENV_FILE ]]; then
  install -m 600 "$ENV_SOURCE" "$ENV_FILE"
  rm -f "$ENV_SOURCE"
fi
if [[ ! -f $ENV_FILE ]]; then
  if [[ -z ${INSTRUCTOR_PASSWORD:-} ]]; then
    while :; do
      read -rsp "Instructor password (at least 10 characters): " INSTRUCTOR_PASSWORD; echo
      [[ ${#INSTRUCTOR_PASSWORD} -ge 10 ]] && break
      echo "Too short."
    done
  fi
  if [[ -z ${OPENAI_API_KEY+x} ]]; then
    read -rsp "OpenAI API key for AI-written questions (Enter to skip): " OPENAI_API_KEY; echo
  fi
  umask 077
  {
    echo "INSTRUCTOR_PASSWORD=$INSTRUCTOR_PASSWORD"
    [[ -n ${OPENAI_API_KEY:-} ]] && echo "OPENAI_API_KEY=$OPENAI_API_KEY"
  } > "$ENV_FILE"
  umask 022
fi
# Server settings this script manages (secrets above are left alone).
sed -i '/^\(WEB_URL\|HOST\|PORT\|TRUST_PROXY\)=/d' "$ENV_FILE"
cat >> "$ENV_FILE" <<EOF
WEB_URL=$SITE_URL
HOST=127.0.0.1
PORT=3001
TRUST_PROXY=loopback
EOF
chmod 600 "$ENV_FILE"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Installing and building (a few minutes)"
sudo -u "$APP_USER" -H bash -c "cd $APP_DIR && npm ci --no-audit --no-fund && npm run build -w @linuxlab/web"

say "Building the student Linux image"
(cd "$APP_DIR" && docker build -q -t linuxlab/student-ubuntu:24.04 docker/student-ubuntu)

say "Starting the exam service"
cat > /etc/systemd/system/linuxlab.service <<EOF
[Unit]
Description=Linux Practical Exam server
After=network-online.target docker.service
Requires=docker.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run start -w @linuxlab/server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable linuxlab >/dev/null
systemctl restart linuxlab

say "Configuring HTTPS for $SITE_DOMAIN"
CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
cat > /etc/caddy/Caddyfile <<EOF
$SITE_DOMAIN {
	encode gzip

	header {
		X-Frame-Options DENY
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		Strict-Transport-Security "max-age=31536000"
		Content-Security-Policy "$CSP"
		-Server
	}

	# API and terminal traffic go to the exam server (private on 127.0.0.1).
	handle /api/* {
		reverse_proxy 127.0.0.1:3001
	}
	handle /ws/* {
		reverse_proxy 127.0.0.1:3001
	}

	# Everything else is the student / instructor web app.
	handle {
		root * $APP_DIR/apps/web/dist
		try_files {path} /index.html
		file_server
	}
}
EOF
# Caddy must be able to read the built site.
chmod o+rx /opt "$APP_DIR" "$APP_DIR/apps" "$APP_DIR/apps/web"
chmod -R o+rX "$APP_DIR/apps/web/dist"
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Checking"
for _ in $(seq 1 30); do
  curl -fs http://127.0.0.1:3001/api/health >/dev/null && break
  sleep 2
done
if curl -fs http://127.0.0.1:3001/api/health >/dev/null; then
  echo "Exam server: running"
else
  echo "Exam server did not start. See: sudo journalctl -u linuxlab -n 50"
fi

cat <<EOF

==============================================================
  Students go to:     $SITE_URL
  Instructor pages:   $SITE_URL/instructor

  The HTTPS certificate can take a minute the first time.
  Logs:     sudo journalctl -u linuxlab -f
  Update:   sudo bash $APP_DIR/deploy/setup-ubuntu.sh
==============================================================
EOF
