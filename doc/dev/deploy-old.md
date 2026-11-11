# Deploy do cloud no servidor OLD

Infraestrutura atual do Kuruk Cloud em produção.

## Servidor

- Host: `100.87.5.89` (servidor `old`)
- Usuário de deploy: `bruno`
- Aplicação: `/opt/apps/kuruk-cloud` (clone do repositório)
- Cloud: `/opt/apps/kuruk-cloud/cloud`
- Container: `kuruk-cloud` (`node:24-alpine`, rede host do Docker isolada nas redes `old-proxy` e `mysql-internal`)
- MySQL: container `mysql`, banco `kuruk_cloud`, usuário `kuruk_cloud_user`
- Site/landing: container `old-home` (nginx), com proxy para o cloud

O container do cloud não publica porta no host: o nginx do `old-home` fala com
`kuruk-cloud:3003` pela rede Docker. O MySQL só é acessível pela rede
`mysql-internal`.

## Primeiro acesso ao painel

`https://kuruk.com.br/admin/setup` cria o primeiro administrador. Depois disso,
o login fica em `https://kuruk.com.br/login`.

## Deploy

```sh
npm run kuruk cloud:deploy
```

O script:

1. conecta em `bruno@100.87.5.89`;
2. faz `git pull --ff-only` em `/opt/apps/kuruk-cloud`;
3. roda `npm ci`, build, migrations e `seed:themes`;
4. reinicia o container `kuruk-cloud`;
5. valida `https://kuruk.com.br/api/health`.

## Nginx (`old-home`)

O arquivo persistente fica em `/opt/old-home/default.conf` e é montado no
container via `/opt/old-home/compose.yaml`. A raiz `/` agora é a landing page
do próprio cloud; o site estático antigo não é mais servido. Só o arquivo
`/health` continua estático, porque a infraestrutura usa esse caminho.

```nginx
location = /health {
    root   /usr/share/nginx/html;
}

location / {
    proxy_pass http://kuruk-cloud:3003;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 200m;
}
```

## Banco de dados

O banco `kuruk_cloud` foi populado a partir do dump `kivo.sql` e rebrandado:

- 5 empresas, 2 administradores (`admin` e `admin2`), 3 planos, 1 tema e 54
  migrations;
- hashes, licenças, UUIDs e o nome histórico da migration `0019_kivo_web`
  foram preservados de propósito (renomear a migration faria o migrator
  reaplicá-la);
- textos visíveis, domínios e caminhos foram trocados para Kuruk;
- backup pós-importação em `/opt/apps/kuruk-cloud/backups/`.

O conteúdo de `storage/` foi importado de `archive.zip`:

- `storage/backups` — 8 arquivos `.gz`;
- `storage/catalog` — 328 imagens;
- `storage/messages` — 1 imagem;
- `storage/themes` — 8 arquivos.

As permissões foram ajustadas para o grupo `nodeapps`. O campo
`cloud_backups.storage_path` usa o caminho visto de dentro do container
(`/app/storage/backups/...`), e os 7 registros foram conferidos um a um.

## Variáveis do cloud

Arquivo `/opt/apps/kuruk-cloud/cloud/.env` (não versionado):

```env
NODE_ENV=production
CLOUD_PORT=3003
CLOUD_DB_HOST=127.0.0.1
CLOUD_DB_PORT=3306
CLOUD_DB_USER=kuruk_cloud_user
CLOUD_DB_PASSWORD=<segredo>
CLOUD_DB_NAME=kuruk_cloud
CLOUD_PUBLIC_URL=https://kuruk.com.br
```

No container, `CLOUD_DB_HOST` é sobrescrito para `mysql` (nome do container na
rede `mysql-internal`).
