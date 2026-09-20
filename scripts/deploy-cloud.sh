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
# `set -e` DENTRO do bloco remoto: sem ele, uma migration que falha não interrompe nada — o
# script seguia para o `pm2 restart`, o ssh devolvia o código do último comando (o `grep`, que
# tem sucesso) e o deploy terminava com "OK". Resultado: servidor reiniciado com código novo
# contra um banco sem as tabelas, e a falha só aparecendo no meio do log.
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${SSH_USER}@${HOST}" "
  set -euo pipefail
  cd ${CLOUD_DIR}
  git pull origin main
  npm install
  npm run build

  # \`export \\\$(cat .env | xargs)\` quebrava em linha de comentário ('export: #: not a valid
  # identifier') e corromperia qualquer valor com espaço. \`set -a\` + source exporta tudo o
  # que o arquivo define, respeitando comentários e aspas.
  set -a
  . ./.env
  set +a

  npm run migrate
  # Cadastra/atualiza os temas da loja (packs em seed-themes/). Idempotente.
  npm run seed:themes

  # Rotação dos logs do PM2: sem isto o kivo-cloud-out.log/-error.log cresce para sempre na
  # VPS (foi a origem dos arquivos de dezenas de GB). Idempotente: instala na primeira vez e
  # reaplica os limites nas seguintes.
  if ! pm2 describe pm2-logrotate >/dev/null 2>&1; then
    pm2 install pm2-logrotate
  fi
  pm2 set pm2-logrotate:max_size 50M
  pm2 set pm2-logrotate:retain 14
  pm2 set pm2-logrotate:compress true
  pm2 set pm2-logrotate:workerInterval 60

  pm2 restart ${PM2_NAME}
  sleep 2
  pm2 show ${PM2_NAME} | grep status
"

echo "[deploy] verificando ${HEALTH_URL}..."
curl -sf "$HEALTH_URL"
echo ""
echo "[deploy] OK"
