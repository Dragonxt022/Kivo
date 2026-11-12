#!/usr/bin/env bash
# Testa a restauração do backup mais recente do Kuruk Cloud SEM tocar em produção.
#
# Sobe um MySQL descartável (container próprio, sem porta publicada), importa o dump,
# confere as contagens do manifesto e extrai o storage para um diretório temporário.
# No fim, remove tudo.
#
# Roda NO SERVIDOR (cron semanal) ou por `npm run kuruk cloud:backup:verify`.
#
# Uso:  restore-cloud-verify.sh [pasta-do-backup] [--keep]
#   sem argumento  -> usa o backup mais recente em /opt/backups/kuruk-cloud
#   --keep         -> não remove o container ao terminar (para inspeção manual)
set -euo pipefail

ENV_FILE="${KURUK_BACKUP_ENV_FILE:-/opt/infraestrutura/backup.env}"
# shellcheck disable=SC1090
if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

DEST_ROOT="${KURUK_BACKUP_DIR:-$HOME/backups/kuruk-cloud}"
IMAGE="${KURUK_VERIFY_MYSQL_IMAGE:-mysql:8.4}"
CONTAINER="kuruk-restore-verify"
KEEP_CONTAINER=0
DIR=""

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP_CONTAINER=1 ;;
    *) DIR="$arg" ;;
  esac
done

if [ -z "$DIR" ]; then
  DIR="$(find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_*' | sort | tail -1)"
fi
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "ERRO: nenhum backup encontrado em $DEST_ROOT"; exit 1; }

LOG="$DEST_ROOT/restore-verify.log"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

PING_OK="${KURUK_BACKUP_VERIFY_PING_URL:-${KURUK_BACKUP_PING_URL:-}}"
notify_ok() {
  [ -n "$PING_OK" ] || return 0
  curl -fsS -m 10 -o /dev/null "$PING_OK" || true
}
notify_fail() {
  [ -n "${KURUK_BACKUP_PING_FAIL_URL:-}" ] || return 0
  local msg
  msg="$(printf '%s' "$1" | tr ' ' '+' | head -c 120)"
  curl -fsS -m 10 -o /dev/null "$KURUK_BACKUP_PING_FAIL_URL?status=down&msg=$msg" || true
}
fail() { log "ERRO: $*"; notify_fail "$*"; exit 1; }

TMP="$(mktemp -d)"
cleanup() {
  if [ "$KEEP_CONTAINER" = "1" ]; then
    log "container $CONTAINER mantido (--keep)"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

manifest_get() {
  sed -n "s/^$1=//p" "$DIR/manifest.txt" | head -1
}

[ -f "$DIR/manifest.txt" ] || fail "manifest.txt ausente em $DIR"
[ -f "$DIR/SHA256SUMS" ] || fail "SHA256SUMS ausente em $DIR"

DB_ARCHIVE="$DIR/$(manifest_get db_archive)"
STORE_ARCHIVE="$DIR/$(manifest_get store_archive)"
[ -s "$DB_ARCHIVE" ] || fail "dump do banco ausente: $DB_ARCHIVE"
[ -s "$STORE_ARCHIVE" ] || fail "arquivo de storage ausente: $STORE_ARCHIVE"

log "verificando $DIR"

# --- 1. Integridade dos arquivos (detecta corrupção em disco) --------------
if ( cd "$DIR" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ); then
  log "checksums OK"
else
  fail "checksums divergentes — backup corrompido"
fi

# --- 2. Storage: extrai e confere contagem/segredos ------------------------
EXPECTED_FILES="$(manifest_get store_files)"
tar -xzf "$STORE_ARCHIVE" -C "$TMP" || fail "não foi possível extrair o storage"
GOT_FILES="$(find "$TMP" -type f | wc -l)"
[ "$GOT_FILES" = "$EXPECTED_FILES" ] \
  || fail "storage com $GOT_FILES arquivo(s), manifesto diz $EXPECTED_FILES"
[ -f "$TMP/.env" ] || log "AVISO: .env não está no arquivo de storage"
[ -d "$TMP/storage/catalog" ] || log "AVISO: storage/catalog não encontrado no arquivo"
log "storage OK: $GOT_FILES arquivo(s)"

# --- 3. Banco: restaura em MySQL descartável -------------------------------
command -v docker >/dev/null 2>&1 || fail "docker não encontrado"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "imagem $IMAGE não está no servidor"

TMP_PW="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e MYSQL_ROOT_PASSWORD="$TMP_PW" \
  -e MYSQL_DATABASE=verify_db \
  "$IMAGE" >/dev/null || fail "não foi possível subir o MySQL descartável"

# -i é obrigatório: o dump chega por stdin (`gzip -dc | docker exec -i`).
mexec() { docker exec -i -e MYSQL_PWD="$TMP_PW" "$CONTAINER" "$@"; }

READY=0
for _ in $(seq 1 120); do
  # `mysqladmin ping` responde "alive" mesmo antes da senha do root valer (fase de
  # inicialização do entrypoint). Só uma consulta autenticada prova que o servidor
  # definitivo está no ar.
  if mexec mysql -uroot -N -e 'SELECT 1' >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" = "1" ] || fail "MySQL descartável não ficou pronto em 120s"
log "MySQL descartável pronto; importando dump ($(manifest_get db_bytes) bytes)"

gzip -dc "$DB_ARCHIVE" | mexec mysql -uroot verify_db 2>>"$LOG" \
  || fail "falha ao importar o dump"

q() { mexec mysql -uroot -N -e "$1" 2>/dev/null; }

TABLES="$(q "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='verify_db'")"
EXPECTED_TABLES="$(manifest_get db_tables)"
[ "$TABLES" = "$EXPECTED_TABLES" ] \
  || fail "restauradas $TABLES tabela(s), manifesto diz $EXPECTED_TABLES"

for t in companies admin_users plans _migrations; do
  n="$(q "SELECT COUNT(*) FROM \`verify_db\`.\`$t\`")" || fail "tabela $t não restaurou"
  [ "${n:-0}" -gt 0 ] || fail "tabela $t restaurou vazia"
  log "  $t = $n"
done

log "banco OK: $TABLES tabela(s)"

log "restauração validada com sucesso"
notify_ok
