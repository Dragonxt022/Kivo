# Backup e restauração do Kuruk Cloud

Como o cloud é protegido hoje, como provar que o backup restaura e o que fazer se o
servidor `old` morrer.

## O que existe

| Camada                        | Script                                          | Quando roda           | Onde grava                                         |
| ----------------------------- | ----------------------------------------------- | --------------------- | -------------------------------------------------- |
| Dump de **todos** os bancos   | `/opt/infraestrutura/bin/backup-mysql.sh`       | diário, 03:30 (cron)  | `/opt/backups/mysql/<data>/<banco>.sql.gz`         |
| Teste de restauração (mensal) | `/opt/infraestrutura/bin/testar-restauracao.sh` | dia 01, 04:00 (cron)  | restaura em `zz_restore_test` no MySQL de produção |
| **Restore point do cloud**    | `scripts/backup-cloud.sh` (este repo)           | diário, 03:50 (cron)  | `~/backups/kuruk-cloud/<data>_<hora>/`             |
| Cópia offsite                 | `scripts/backup-cloud.sh` + `rclone`            | junto do anterior     | remote configurado (`r2:kuruk-backups`)            |
| **Verificação real**          | `scripts/restore-cloud-verify.sh` (este repo)   | domingo, 04:40 (cron) | MySQL descartável, nada persiste                   |

O script do repo **não** reimplementa o dump: ele reaproveita o dump do dia feito pelo
`backup-mysql.sh` e só chama aquele script se o dump ainda não existir.

### O que cada restore point contém

`~/backups/kuruk-cloud/<stamp>/`

| Arquivo                        | Conteúdo                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| `kuruk_db_<stamp>.sql.gz`      | dump completo do banco `kuruk_cloud`                                   |
| `kuruk_storage_<stamp>.tar.gz` | `storage/` (catálogo, temas, mensagens), `uploads/` e `.env`           |
| `kuruk_config_<stamp>.tar.gz`  | nginx do `old-home`, `/opt/mysql/.env`, `backup.env`, scripts da infra |
| `manifest.txt`                 | checksums, tamanhos, nº de tabelas, contagens do banco vivo            |
| `SHA256SUMS`                   | integridade de todos os `.gz`                                          |
| `runtime.txt`                  | containers, `git rev`, crontab no momento do backup                    |

Tudo com permissão `600`. O `.env` e o `.env` do MySQL estão nesses arquivos: o bucket
offsite **precisa** ser privado.

## Cobertura e limites

- **Coberto:** banco `kuruk_cloud`, storage do cloud, segredos do cloud, segredos e
  scripts da infra, configs do nginx.
- **Não coberto:** dados dos **clientes desktop** (ficam na máquina de cada cliente e
  são enviados ao cloud via `/api/backup`); imagens de outros bancos em `/opt/backups/mysql`.
- **RPO:** até 24h para o banco (dump das 03:30); até 24h para storage/segredos.
- **RTO:** ~1h seguindo o runbook abaixo (servidor já provisionado: ~20min).
- **Sem cópia offsite configurada, o backup protege contra erro humano, não contra a
  perda do servidor.** O script avisa em todo run enquanto `KURUK_BACKUP_OFFSITE_REMOTE`
  estiver vazio.

## Comandos

```sh
npm run kuruk cloud:backup          # gera um restore point agora
npm run kuruk cloud:backup:verify   # restaura o mais recente e confere os dados
```

Ambos rodam o script **no servidor** via SSH (mesmas variáveis `KURUK_VPS_*` do
`cloud:deploy`). Os scripts precisam estar publicados: `npm run kuruk cloud:deploy`.

Arquivos de trabalho no servidor:

- `~/backups/kuruk-cloud/backup.log`
- `~/backups/kuruk-cloud/restore-verify.log`

## Configurar a cópia offsite (Cloudflare R2)

O `rclone` já está instalado em `~/.local/bin/rclone` (sem sudo).

1. No painel da Cloudflare: **R2 → Create bucket** (`kuruk-backups`), privado.
2. **Manage R2 API Tokens → Create API token**: permissão _Object Read & Write_,
   restrita ao bucket. Anote o _Access Key ID_ e o _Secret Access Key_.
3. No servidor:

   ```sh
   ~/.local/bin/rclone config
   ```

   - `n` (new remote) → nome `r2`
   - storage: `s3`
   - provider: `Cloudflare`
   - `access_key_id` / `secret_access_key`: do passo 2
   - endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - region: `auto`
   - ACL: `private`

4. Teste e habilite:

   ```sh
   ~/.local/bin/rclone lsd r2:
   ```

   Em `/opt/infraestrutura/backup.env`, descomente:

   ```env
   KURUK_BACKUP_OFFSITE_REMOTE=r2:kuruk-backups
   KURUK_BACKUP_OFFSITE_REQUIRED=1
   ```

5. Rode `npm run kuruk cloud:backup` e confira `rclone lsf -R r2:kuruk-backups`.

O script envia o restore point do dia e os dumps de `/opt/backups/mysql/<data>`, valida
com `rclone check --size-only` e apaga do remote o que passar de
`KURUK_BACKUP_OFFSITE_KEEP_DAYS` (30 dias).

Qualquer remote do rclone serve (S3, Backblaze B2, SFTP, Google Drive); só troque o
valor de `KURUK_BACKUP_OFFSITE_REMOTE`.

## Cron

```cron
# Restore point do cloud (depois do dump das 03:30)
50 3 * * * bash /opt/apps/kuruk-cloud/scripts/backup-cloud.sh >>/home/bruno/backups/kuruk-cloud/cron.log 2>&1
# Prova semanal de que o backup restaura
40 4 * * 0 bash /opt/apps/kuruk-cloud/scripts/restore-cloud-verify.sh >>/home/bruno/backups/kuruk-cloud/cron-verify.log 2>&1
```

## Alerta

No Uptime Kuma (`http://100.87.5.89:3001`) crie um monitor **Push**, com intervalo maior
que 24h (ex.: 26h) e período de carência de 2h. Cole a URL nos dois campos de
`/opt/infraestrutura/backup.env`:

```env
KURUK_BACKUP_PING_URL=http://100.87.5.89:3001/api/push/<token>
KURUK_BACKUP_PING_FAIL_URL=http://100.87.5.89:3001/api/push/<token>
```

Sucesso faz `GET <url>`; falha faz `GET <url>?status=down&msg=...`. Se o backup não rodar
no dia, o próprio monitor fica DOWN — é o alerta que importa.

## Espaço em disco

Medido no servidor `old` (nov/2026):

| Item                                     | Tamanho                                             |
| ---------------------------------------- | --------------------------------------------------- |
| 1 restore point                          | **~30 MB** (28 MB storage + ~1 MB banco + configs)  |
| Retenção de 14 dias, catálogo inalterado | **~430 MB**                                         |
| Dumps MySQL em `/opt/backups`            | ~1 MB/dia (o script da infra mantém 14 + 6 mensais) |
| Disco livre                              | ~93 GB                                              |

O storage (imagens de catálogo/temas) é a maior parte do backup, mas muda pouco. Por
isso o script calcula um fingerprint de `storage/`, `uploads/` e `.env`: se nada mudou
desde o restore point anterior, o arquivo é **reaproveitado por hardlink** — mesmo
inode, nenhum byte novo no disco, e a retenção continua segura (apagar um ponto antigo
não afeta os novos).

Antes de gravar, o script confere o espaço livre:

```env
KURUK_BACKUP_MIN_FREE_MB=2048   # padrão; abaixo disso o backup aborta
```

Encher o volume derrubaria o MySQL junto, então falhar alto é melhor que gravar.

Limite conhecido: o **offsite** ainda sobe uma cópia do storage por dia (R2 não deduplica).
Com 30 MB/dia e 30 dias são ~900 MB, dentro do free tier. Se o catálogo passar de ~500 MB,
vale mudar o storage remoto para archive endereçado por conteúdo (`storage/<sha>.tar.gz`),
que sobe uma vez por versão.

## Runbook: o servidor `old` morreu

1. **Provisione** Ubuntu com Docker e o usuário `bruno` (com a mesma chave SSH).
2. **Recupere o restore point** em outra máquina:

   ```sh
   rclone copy r2:kuruk-backups/kuruk-cloud/<stamp> ./restore
   cd restore && sha256sum -c SHA256SUMS
   ```

3. **Suba o MySQL** (`mysql:8.4`) e recrie banco e usuário — o dump traz só tabelas,
   **não** usuários/grants:

   ```sql
   CREATE DATABASE kuruk_cloud CHARACTER SET utf8mb4;
   CREATE USER 'kuruk_cloud_user'@'%' IDENTIFIED BY '<senha do .env>';
   GRANT ALL PRIVILEGES ON kuruk_cloud.* TO 'kuruk_cloud_user'@'%';
   ```

4. **Importe o banco**:

   ```sh
   gunzip -c kuruk_db_<stamp>.sql.gz | docker exec -i mysql mysql -uroot kuruk_cloud
   ```

5. **Clone o repo no commit do manifesto** (`git=<sha>` em `manifest.txt`), rode
   `npm ci`, `npm run build` e `npm run migrate` (deve ser no-op).
6. **Restaure storage e segredos**: extraia `kuruk_storage_<stamp>.tar.gz` dentro de
   `cloud/`; confirme que `cloud/.env` voltou.
7. **Suba os containers** (`kuruk-cloud`, `old-home`, `cloudflared`) e valide
   `https://kuruk.com.br/api/health` e o login do admin.
8. Se o R2 ainda estiver acessível, o passo 2 pode ser feito no próprio servidor novo.

## Verificação periódica

- Semanal: o cron de domingo já falha (e alerta) se o dump não restaurar.
- Mensal: olhe `restore-verify.log` e confirme que as contagens batem com o painel.
- A cada release: o backup usa `git rev` no manifesto; guarde o restore point anterior
  a migrations destrutivas.
