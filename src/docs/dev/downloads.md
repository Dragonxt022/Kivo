# Download do Instalador e Leads — Regras de Negócio

Cadastro obrigatório antes de baixar o instalador do Kivo. O objetivo é duplo: liberar o
download para o visitante e registrar quem está testando, para o suporte conseguir ajudar
durante o período de teste.

## Visão geral

O site público (`/baixar`) pede **nome, celular e e-mail** antes de entregar o instalador.
O cadastro vira uma linha em `installer_leads` e um link com token libera o arquivo por
**7 dias**. O painel do Cloud mostra os leads e cruza com os testes criados
(`companies.plan = 'trial'`), mas o download em si não depende de o visitante ativar uma
licença.

## Fluxo público

1. `GET /baixar` renderiza o formulário (nome, celular, e-mail, campo oculto `website`,
   `origem` e a versão atual do instalador).
2. `POST /baixar` valida os campos:
   - nome entre 2 e 120 caracteres;
   - celular com 10 a 13 dígitos (DDD obrigatório);
   - e-mail válido, até 160 caracteres (salvo em minúsculas);
   - honeypot `website` vazio (bot que preenche é descartado em silêncio);
   - no máximo **8 cadastros por hora por IP**.
3. Grava `installer_leads` com nome, WhatsApp, e-mail, IP, user-agent, referer, origem,
   versão, token e validade. O token é aleatório (`randomBytes(24)` → 48 caracteres hex).
4. Redireciona para `/baixar/obrigado?t=<token>`. A página valida o token e mostra o botão
   de download; se o token não existir ou estiver expirado, volta para o formulário.
5. `GET /baixar/arquivo?t=<token>` valida o token, marca `downloaded_at` na primeira vez,
   incrementa `download_count` e redireciona para a URL real do instalador.

O download é **best-effort**: se o banco estiver fora, o cadastro é perdido, mas o visitante
não fica bloqueado — tanto o POST quanto a validação do arquivo liberam o download assim
mesmo. O token expirado, porém, volta para o formulário.

## Versão do instalador

`getReleaseInfo` resolve a versão e a URL nesta ordem:

1. `KIVO_DOWNLOAD_URL` / `KIVO_APP_VERSION` no ambiente (mirror ou versão congelada);
2. release mais recente do GitHub (`releases/latest`), procurando um asset
   `Kivo-Setup-*.exe` (ou `Katsu-Setup-*.exe`);
3. último valor conhecido em cache (TTL de 30 minutos);
4. fallback fixo definido no código.

A consulta ao GitHub tem timeout curto e falhas de rede não derrubam a página.

## Entidades

`installer_leads` (migration `0053_installer_leads`):

| Campo | Uso |
| --- | --- |
| `name`, `whatsapp`, `email` | dados do lead |
| `ip`, `user_agent`, `referer`, `origem` | origem e auditoria |
| `version` | versão exibida no momento do cadastro |
| `download_token`, `token_expires_at` | link de download com validade de 7 dias |
| `downloaded_at`, `download_count` | primeiro download e quantidade de downloads |
| `created_at` | data do cadastro |

A tabela antiga `installer_downloads` (migration `0043_installer_downloads`) registrava
cliques anônimos; o fluxo atual não escreve mais nela. Ela permanece apenas como histórico.

## Painel de downloads

`GET /admin/downloads` (somente administrador autenticado) mostra:

- KPIs: total de cadastros, downloads efetivados, cadastros nos últimos 7 dias e testes em
  andamento;
- os últimos 500 leads, com data, nome/IP, celular (com link direto para o WhatsApp),
  e-mail, versão e origem;
- a lista de empresas em trial, com máquina, versão e primeiro/último acesso — o lead pode
  existir sem teste criado, e o teste pode existir sem download registrado.

Para cada lead, o painel monta um link `https://wa.me/55...` para o time chamar o contato
com um clique. O número não duplica o DDI quando o celular já vem com `55`.

## Segurança e limites

- Token de 48 caracteres hex, com validade de 7 dias; o link só serve para aquele cadastro.
- Rate limit de 8 cadastros por hora por IP.
- Honeypot invisível para humanos; preenchido, o cadastro é descartado sem token.
- E-mail normalizado em minúsculas para facilitar a contagem de duplicados
  (`COUNT(DISTINCT email)` no painel).
- Sem FK com `companies`: o cadastro acontece antes de existir empresa.
- O painel limita a listagem aos 500 leads mais recentes; a retenção/limpeza é operacional.

## Erros comuns

- **Informe seu nome completo** — nome com menos de 2 caracteres.
- **Informe um celular válido, com DDD** — menos de 10 ou mais de 13 dígitos.
- **Informe um e-mail válido** — formato inválido ou acima de 160 caracteres.
- **Muitos cadastros seguidos — tente novamente mais tarde** — rate limit por IP (HTTP 429).
- **Token expirado** — o link tem 7 dias; refaça o cadastro em `/baixar`.

## Arquivos-chave

- `cloud/src/routes/landing.ts` — formulário, validação, token, download e release.
- `cloud/src/views/baixar.ejs` e `baixar-obrigado.ejs` — telas públicas.
- `cloud/src/routes/admin.ts` — painel `/admin/downloads` e estatísticas.
- `cloud/src/views/downloads.ejs` — tabela de leads e trials.
- `cloud/migrations/0053_installer_leads` — tabela de leads.
- `cloud/migrations/0043_installer_downloads` — histórico antigo de cliques.
