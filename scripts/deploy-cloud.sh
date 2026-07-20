#!/usr/bin/env bash
# Reimplanta o cloud/ na VPS: git pull + build + restart do systemd, depois
# confere /api/health pelo domínio público. Autenticação via chave SSH (sem senha).
set -euo pipefail

HOST="${KIVO_VPS_HOST:-187.77.251.231}"
SSH_USER="${KIVO_VPS_SSH_USER:-root}"
SITE_USER="${KIVO_VPS_SITE_USER:-buscamais-kivo}"
APP_DIR="${KIVO_VPS_APP_DIR:-/home/$SITE_USER/htdocs/kivo.buscamais.org/app}"
KEY="${KIVO_VPS_SSH_KEY:-$HOME/.ssh/kivo_vps_deploy}"
HEALTH_URL="${KIVO_CLOUD_HEALTH_URL:-https://kivo.buscamais.org/api/health}"

echo "[deploy] conectando em ${SSH_USER}@${HOST}..."
ssh -i "$KEY" -o BatchMode=yes "${SSH_USER}@${HOST}" "
  sudo -u ${SITE_USER} bash -lc '
    set -e
    cd ${APP_DIR}
    git pull origin main
    cd cloud
    npm install
    npm run build
    export \$(cat .env | xargs)
    npm run migrate
  '
  systemctl restart kivo-cloud
  sleep 2
  systemctl is-active kivo-cloud
"

echo "[deploy] verificando ${HEALTH_URL}..."
curl -sf "$HEALTH_URL"
echo ""
echo "[deploy] OK"
