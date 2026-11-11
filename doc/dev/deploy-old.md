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
container via `/opt/old-home/compose.yaml`. A regra é “estático primeiro, cloud
como fallback”: o `index.html` do site continua na raiz e todo o resto (API,
admin, pagamento, cardápio, app mobile, `/css`, `/js`, `/img`) vai para o cloud.

```nginx
location / {
    root   /usr/share/nginx/html;
    index  index.html index.htm;
    try_files $uri $uri/ @cloud;
}

location @cloud {
    proxy_pass http://kuruk-cloud:3003;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 200m;
}
```

## Banco novo x banco antigo

Este deploy criou um banco **novo** (`kuruk_cloud`). As empresas, licenças e
cobranças que já existiam continuam no backend antigo
(`https://kivo.buscamais.org`, banco `kivo_cloud`). Para migrar os dados, é
preciso um dump do MySQL antigo e importar em `kuruk_cloud` (ou apontar o
`CLOUD_DB_NAME`/host do container para o banco antigo). Enquanto isso não for
feito, instalações existentes que já apontam para o backend antigo continuam
funcionando; instalações novas usam `https://kuruk.com.br`.

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
