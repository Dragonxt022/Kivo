#!/usr/bin/env bash
# Backup completo do Kuruk Cloud: banco + storage + segredos + configs da infra,
# com manifesto/checksums, cópia offsite (rclone) e notificação (Uptime Kuma).
#
# Roda NO SERVIDOR (cron) ou por `npm run kuruk cloud:backup` (que chama por SSH).
#
# Isto complementa /opt/infraestrutura/bin/backup-mysql.sh, que já faz o dump diário
# de todos os bancos para /opt/backups/mysql/<data>/. Este script NÃO reimplementa o
# dump: ele reaproveita o do dia e, se ainda não existir, chama o script da infra.
# A diferença é o que ele acrescenta:
#   - pasta de restore point autocontida por execução (dump + storage + .env + configs);
#   - storage/ (imagens de catálogo, temas, mensagens) e .env, que o dump não cobre;
#   - manifesto com checksums e contagens (para o teste de restauração comparar);
#   - cópia para fora da máquina (rclone: R2, S3, B2, SFTP, Drive...);
#   - retenção local e remota;
#   - ping de sucesso/falha em monitor externo.
#
# Configuração: /opt/infraestrutura/backup.env (não versionado), variáveis:
#   KURUK_BACKUP_OFFSITE_REMOTE=r2:kuruk-backups
#   KURUK_BACKUP_OFFSITE_REQUIRED=1        # falha se o offsite não estiver configurado
#   KURUK_BACKUP_PING_URL=https://.../api/push/<token>
#   KURUK_BACKUP_PING_FAIL_URL=https://.../api/push/<token-fail>
#   KURUK_BACKUP_KEEP_DAYS=14
#   KURUK_BACKUP_OFFSITE_KEEP_DAYS=30
set -euo pipefail

ENV_FILE="${KURUK_BACKUP_ENV_FILE:-/opt/infraestrutura/backup.env}"
# shellcheck disable=SC1090
if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

APP_DIR="${KURUK_APP_DIR:-/opt/apps/kuruk-cloud}"
CLOUD_DIR="${KURUK_CLOUD_DIR:-$APP_DIR/cloud}"
# Padrão no home do usuário de deploy: /opt/backups é do root e o cron roda sem sudo.
# Para usar /opt/backups/kuruk-cloud, crie a pasta com sudo e defina KURUK_BACKUP_DIR.
DEST_ROOT="${KURUK_BACKUP_DIR:-$HOME/backups/kuruk-cloud}"
DB_BASE="${KURUK_DB_BACKUP_DIR:-/opt/backups/mysql}"
DB_SCRIPT="${KURUK_DB_BACKUP_SCRIPT:-/opt/infraestrutura/bin/backup-mysql.sh}"
KEEP_DAYS="${KURUK_BACKUP_KEEP_DAYS:-14}"
OFFSITE="${KURUK_BACKUP_OFFSITE_REMOTE:-}"
OFFSITE_KEEP_DAYS="${KURUK_BACKUP_OFFSITE_KEEP_DAYS:-30}"
OFFSITE_REQUIRED="${KURUK_BACKUP_OFFSITE_REQUIRED:-0}"
PING_OK="${KURUK_BACKUP_PING_URL:-}"
PING_FAIL="${KURUK_BACKUP_PING_FAIL_URL:-}"

STAMP="$(date +%F_%H%M)"
TODAY="$(date +%F)"
DEST="$DEST_ROOT/$STAMP"
LOG="$DEST_ROOT/backup.log"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$DEST"
chmod 700 "$DEST_ROOT" "$DEST"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

# Não deixa o log crescer sem limite (rotação simples: mantém ~1 MB).
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 5242880 ]; then
  tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

notify_ok() {
  [ -n "$PING_OK" ] || return 0
  curl -fsS -m 10 -o /dev/null "$PING_OK" || log "AVISO: ping de sucesso falhou"
}

notify_fail() {
  [ -n "$PING_FAIL" ] || return 0
  local msg
  msg="$(printf '%s' "$1" | tr ' ' '+' | head -c 120)"
  curl -fsS -m 10 -o /dev/null "$PING_FAIL?status=down&msg=$msg" || true
}

fail() {
  log "ERRO: $*"
  notify_fail "$*"
  exit 1
}

# --- 1. Dump do banco -------------------------------------------------------
# Nome do banco vem do .env do cloud (fonte da verdade), não de constante aqui.
DB_NAME="kuruk_cloud"
if [ -r "$CLOUD_DIR/.env" ]; then
  _name="$(grep -E '^CLOUD_DB_NAME=' "$CLOUD_DIR/.env" | cut -d= -f2- || true)"
  [ -n "$_name" ] && DB_NAME="$_name"
fi

DUMP_SRC="$DB_BASE/$TODAY/$DB_NAME.sql.gz"
if [ ! -s "$DUMP_SRC" ]; then
  if [ -x "$DB_SCRIPT" ]; then
    log "dump de $DB_NAME ($TODAY) ausente; executando $DB_SCRIPT"
    "$DB_SCRIPT" >>"$LOG" 2>&1 || log "AVISO: $DB_SCRIPT retornou erro"
  else
    log "AVISO: $DB_SCRIPT não existe ou não é executável"
  fi
fi
[ -s "$DUMP_SRC" ] || fail "dump de $DB_NAME não encontrado em $DUMP_SRC"
gzip -t "$DUMP_SRC" 2>/dev/null || fail "dump corrompido: $DUMP_SRC"

DB_ARCHIVE="$DEST/kuruk_db_$STAMP.sql.gz"
cp -p "$DUMP_SRC" "$DB_ARCHIVE"
chmod 600 "$DB_ARCHIVE"
DB_BYTES="$(stat -c%s "$DB_ARCHIVE")"
DB_SHA="$(sha256sum "$DB_ARCHIVE" | cut -d' ' -f1)"
# Contagem direto do dump: é o que o teste de restauração vai conseguir restaurar.
DB_TABLES="$(gzip -dc "$DB_ARCHIVE" | grep -c '^CREATE TABLE' || true)"
log "banco $DB_NAME: ${DB_TABLES} tabela(s), ${DB_BYTES} bytes"

# --- 2. Storage, uploads e segredos ----------------------------------------
[ -d "$CLOUD_DIR/storage" ] || fail "pasta storage não encontrada em $CLOUD_DIR"
STORAGE_ARCHIVE="$DEST/kuruk_storage_$STAMP.tar.gz"
TAR_ITEMS=()
for item in storage uploads .env; do
  [ -e "$CLOUD_DIR/$item" ] && TAR_ITEMS+=("$item")
done
log "compactando ${TAR_ITEMS[*]}"
tar -czf "$STORAGE_ARCHIVE" -C "$CLOUD_DIR" --ignore-failed-read "${TAR_ITEMS[@]}" \
  >>"$LOG" 2>&1 || fail "tar do storage falhou"
gzip -t "$STORAGE_ARCHIVE" 2>/dev/null || fail "arquivo de storage inválido"
chmod 600 "$STORAGE_ARCHIVE"
STORAGE_BYTES="$(stat -c%s "$STORAGE_ARCHIVE")"
STORAGE_FILES="$(tar -tzf "$STORAGE_ARCHIVE" | grep -vc '/$' || true)"
log "storage: ${STORAGE_FILES} arquivo(s), ${STORAGE_BYTES} bytes"

# --- 3. Configs da infra (para reconstruir o servidor) ----------------------
CONFIG_ARCHIVE="$DEST/kuruk_config_$STAMP.tar.gz"
CONFIG_ITEMS=()
for rel in opt/old-home/default.conf opt/old-home/compose.yaml \
           opt/mysql/.env opt/infraestrutura/backup.env; do
  [ -r "/$rel" ] && CONFIG_ITEMS+=("$rel")
done
while IFS= read -r f; do
  CONFIG_ITEMS+=("${f#/}")
done < <(find /opt/infraestrutura/bin -maxdepth 1 -type f -readable 2>/dev/null | sort)

if [ "${#CONFIG_ITEMS[@]}" -gt 0 ]; then
  tar -czf "$CONFIG_ARCHIVE" -C / "${CONFIG_ITEMS[@]}" >>"$LOG" 2>&1 \
    || fail "tar das configs falhou"
  chmod 600 "$CONFIG_ARCHIVE"
  log "configs: ${#CONFIG_ITEMS[@]} arquivo(s)"
else
  log "AVISO: nenhuma config de infra legível"
fi

# Snapshot do runtime: ajuda a reconstruir o servidor e a auditar o estado.
{
  echo "# runtime do backup $STAMP"
  echo "host=$(hostname)"
  echo "git=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "kernel=$(uname -sr)"
  echo
  echo "## containers"
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || true
  echo
  echo "## crontab"
  crontab -l 2>/dev/null || true
} > "$DEST/runtime.txt"

# --- 4. Manifesto + checksums ----------------------------------------------
# Contagens do banco VIVO no momento do backup. O dump é de mais cedo (03:30),
# então isso é referência — o teste de restauração exige apenas > 0 e compara
# com as contagens tiradas do próprio dump.
ROOT_PW="$(grep -E '^MYSQL_ROOT_PASSWORD=' /opt/mysql/.env 2>/dev/null | cut -d= -f2- || true)"
count_live() {
  [ -n "$ROOT_PW" ] || { echo '?'; return; }
  docker exec -e MYSQL_PWD="$ROOT_PW" mysql mysql -uroot -N \
    -e "SELECT COUNT(*) FROM \`$DB_NAME\`.\`$1\`" 2>/dev/null || echo '?'
}

{
  echo "stamp=$STAMP"
  echo "host=$(hostname)"
  echo "git=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "db_name=$DB_NAME"
  echo "db_archive=$(basename "$DB_ARCHIVE")"
  echo "db_bytes=$DB_BYTES"
  echo "db_sha256=$DB_SHA"
  echo "db_tables=$DB_TABLES"
  echo "store_archive=$(basename "$STORAGE_ARCHIVE")"
  echo "store_bytes=$STORAGE_BYTES"
  echo "store_files=$STORAGE_FILES"
  echo "live_companies=$(count_live companies)"
  echo "live_admin_users=$(count_live admin_users)"
  echo "live_plans=$(count_live plans)"
  echo "live_migrations=$(count_live _migrations)"
} > "$DEST/manifest.txt"

( cd "$DEST" && sha256sum ./*.gz > SHA256SUMS )

# --- 5. Retenção local ------------------------------------------------------
find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_*' \
  -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true

# --- 6. Cópia offsite -------------------------------------------------------
RCLONE="${KURUK_RCLONE_BIN:-$(command -v rclone || true)}"
if [ -z "$RCLONE" ] && [ -x "$HOME/.local/bin/rclone" ]; then
  RCLONE="$HOME/.local/bin/rclone"
fi

if [ -n "$OFFSITE" ]; then
  [ -n "$RCLONE" ] || fail "offsite configurado mas rclone não está instalado"
  REMOTE_BASE="${OFFSITE%/}/kuruk-cloud"
  log "enviando para $REMOTE_BASE/$STAMP"
  "$RCLONE" copy "$DEST" "$REMOTE_BASE/$STAMP" --checksum >>"$LOG" 2>&1 \
    || fail "rclone copy do backup falhou"
  "$RCLONE" check "$DEST" "$REMOTE_BASE/$STAMP" --size-only --one-way >>"$LOG" 2>&1 \
    || fail "rclone check falhou (cópia remota divergente)"

  if [ -d "$DB_BASE/$TODAY" ]; then
    "$RCLONE" copy "$DB_BASE/$TODAY" "${OFFSITE%/}/mysql/$TODAY" --checksum \
      >>"$LOG" 2>&1 || fail "rclone copy dos dumps do MySQL falhou"
  fi

  "$RCLONE" delete "$REMOTE_BASE" --min-age "${OFFSITE_KEEP_DAYS}d" --rmdirs \
    >>"$LOG" 2>&1 || log "AVISO: limpeza remota falhou"
  "$RCLONE" delete "${OFFSITE%/}/mysql" --min-age "${OFFSITE_KEEP_DAYS}d" --rmdirs \
    >>"$LOG" 2>&1 || log "AVISO: limpeza remota (mysql) falhou"
  log "offsite OK"
elif [ "$OFFSITE_REQUIRED" = "1" ]; then
  fail "offsite obrigatório, mas KURUK_BACKUP_OFFSITE_REMOTE está vazio"
else
  log "AVISO: cópia OFFSITE DESATIVADA — configure KURUK_BACKUP_OFFSITE_REMOTE em $ENV_FILE"
fi

log "concluído: $DEST"
notify_ok
