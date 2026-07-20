#!/usr/bin/env bash
# Reimplanta o cloud/ na VPS: git pull + build + restart via PM2.
# Autenticação via chave SSH (sem senha).
set -euo pipefail

HOST="${KIVO_VPS_HOST:-187.77.251.231}"
SSH_USER="${KIVO_VPS_SSH_USER:-root}"
SITE_USER="${KIVO_VPS_SITE_USER:-buscamais-kivo}"
CLOUD_DIR="${KIVO_VPS_CLOUD_DIR:-/home/$SITE_USER/htdocs/kivo.buscamais.org/cloud}"
KEY="${KIVO_VPS_SSH_KEY:-$HOME/.ssh/kivo_vps_deploy}"
HEALTH_URL="${KIVO_CLOUD_HEALTH_URL:-https://kivo.buscamais.org/api/health}"
PM2_NAME="${KIVO_VPS_PM2_NAME:-kivo-cloud}"

# --- Verifica se a chave SSH existe ---
if [ ! -f "$KEY" ]; then
  echo ""
  echo "[deploy] ⚠  Chave SSH não encontrada: $KEY"
  echo ""
  echo "  Deseja gerar uma nova chave agora?"
  echo "  (será criada em $KEY)"
  echo ""
  printf "  [S/n] "
  read -r resposta
  if [[ "$resposta" =~ ^[Nn] ]]; then
    echo "[deploy] Cancelado. Configure KIVO_VPS_SSH_KEY ou gere a chave manualmente:"
    echo "  ssh-keygen -t ed25519 -f \"$KEY\""
    exit 1
  fi

  ssh-keygen -t ed25519 -f "$KEY" -N ""
  echo ""
  echo "[deploy] ✅ Chave gerada. Copie a chave pública para o servidor:"
  echo ""
  printf "  Comando para copiar (será pedida a senha): "
  echo "ssh-copy-id -i \"$KEY\" ${SSH_USER}@${HOST}"
  echo ""
  printf "  Pressione Enter após copiar a chave..."
  read -r

  echo "[deploy] Testando conexão..."
  if ! ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${SSH_USER}@${HOST}" "echo connected" 2>/dev/null; then
    echo "[deploy] ❌ Ainda não foi possível conectar."
    exit 1
  fi
  echo "[deploy] ✅ Conexão OK"
  echo ""
fi

echo "[deploy] conectando em ${SSH_USER}@${HOST}..."
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${SSH_USER}@${HOST}" "
  cd ${CLOUD_DIR}
  git pull origin main
  npm install
  npm run build
  export \$(cat .env | xargs)
  npm run migrate
  pm2 restart ${PM2_NAME}
  sleep 2
  pm2 show ${PM2_NAME} | grep status
"

echo "[deploy] verificando ${HEALTH_URL}..."
curl -sf "$HEALTH_URL"
echo ""
echo "[deploy] OK"
