#!/usr/bin/env bash
# Reimplanta o cloud/ na VPS: git pull + build + restart via PM2.
# Autenticação via chave SSH/agente (sem senha).
set -euo pipefail

HOST="${KURUK_VPS_HOST:-100.87.5.89}"
SSH_USER="${KURUK_VPS_SSH_USER:-bruno}"
CLOUD_DIR="${KURUK_VPS_CLOUD_DIR:-/opt/apps/kuruk-cloud/cloud}"
KEY="${KURUK_VPS_SSH_KEY:-}"
HEALTH_URL="${KURUK_CLOUD_HEALTH_URL:-https://kuruk.com.br/api/health}"
PM2_NAME="${KURUK_VPS_PM2_NAME:-kuruk-cloud}"
# No servidor OLD o PM2 roda como nodeapps. Deixe vazio para chamar pm2 direto.
PM2_USER="${KURUK_VPS_PM2_USER-nodeapps}"
if [ -n "$PM2_USER" ]; then
  PM2="sudo -iu $PM2_USER pm2"
else
  PM2="pm2"
fi

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
if [ -n "$KEY" ]; then
  SSH_OPTS+=(-i "$KEY")
fi

# --- Verifica se a chave SSH configurada existe ---
if [ -n "$KEY" ] && [ ! -f "$KEY" ]; then
  echo ""
  echo "[deploy] ⚠  Chave SSH não encontrada: $KEY"
  echo ""
  echo "  Deseja gerar uma nova chave agora?"
  echo "  (será criada em $KEY)"
  echo ""
  printf "  [S/n] "
  read -r resposta
  if [[ "$resposta" =~ ^[Nn] ]]; then
    echo "[deploy] Cancelado. Configure KURUK_VPS_SSH_KEY ou gere a chave manualmente:"
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
  if ! ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" "echo connected" 2>/dev/null; then
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
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" "
  set -euo pipefail
  cd ${CLOUD_DIR}
  # --ff-only: se a VPS tiver commit local, o deploy FALHA em vez de criar merge silencioso.
  git pull --ff-only origin main
  # --include=dev: o build (tsc) e as migrations (tsx) dependem de devDependencies. Sem isso,
  # um NODE_ENV=production no ambiente pularia o tsx e o migrate quebraria.
  npm install --include=dev
  npm run build

  # \`export \\\$(cat .env | xargs)\` quebrava em linha de comentário ('export: #: not a valid
  # identifier') e corromperia qualquer valor com espaço. \`set -a\` + source exporta tudo o
  # que o arquivo define, respeitando comentários e aspas.
  if [ ! -f ./.env ]; then
    echo '[deploy] ERRO: falta o arquivo .env em ${CLOUD_DIR} (config do banco/cloud). Abortando antes de migrar.'
    exit 1
  fi
  set -a
  . ./.env
  set +a

  npm run migrate
  # Cadastra/atualiza os temas da loja (packs em seed-themes/). Idempotente.
  npm run seed:themes

  # Rotação dos logs do PM2: sem isto o kuruk-cloud-out.log/-error.log cresce para sempre na
  # VPS (foi a origem dos arquivos de dezenas de GB). Idempotente: instala na primeira vez e
  # reaplica os limites nas seguintes.
  if ! ${PM2} describe pm2-logrotate >/dev/null 2>&1; then
    ${PM2} install pm2-logrotate
  fi
  ${PM2} set pm2-logrotate:max_size 50M
  ${PM2} set pm2-logrotate:retain 14
  ${PM2} set pm2-logrotate:compress true
  ${PM2} set pm2-logrotate:workerInterval 60

  ${PM2} restart ${PM2_NAME}
  sleep 2
  ${PM2} show ${PM2_NAME} | grep status
"

echo "[deploy] verificando ${HEALTH_URL}..."
curl -sf "$HEALTH_URL"
echo ""
echo "[deploy] OK"
