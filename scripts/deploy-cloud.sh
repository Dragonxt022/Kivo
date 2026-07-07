#!/usr/bin/env bash
# Reimplanta o cloud/ na VPS: git pull + build + restart do systemd, depois
# confere /api/health pelo domínio público. Autenticação via chave SSH (sem senha).
set -euo pipefail

HOST="${KATSU_VPS_HOST:-187.77.251.231}"
SSH_USER="${KATSU_VPS_SSH_USER:-root}"
SITE_USER="${KATSU_VPS_SITE_USER:-buscamais-katsu}"
APP_DIR="${KATSU_VPS_APP_DIR:-/home/$SITE_USER/htdocs/katsu.buscamais.org/app}"
KEY="${KATSU_VPS_SSH_KEY:-$HOME/.ssh/katsu_vps_deploy}"
HEALTH_URL="${KATSU_CLOUD_HEALTH_URL:-https://katsu.buscamais.org/api/health}"

echo "[deploy] conectando em ${SSH_USER}@${HOST}..."
ssh -i "$KEY" -o BatchMode=yes "${SSH_USER}@${HOST}" "
  sudo -u ${SITE_USER} bash -lc '
    set -e
    cd ${APP_DIR}
    git pull origin main
    cd cloud
    npm install
    npm run build
  '
  systemctl restart katsu-cloud
  sleep 2
  systemctl is-active katsu-cloud
"

echo "[deploy] verificando ${HEALTH_URL}..."
curl -sf "$HEALTH_URL"
echo ""
echo "[deploy] OK"
