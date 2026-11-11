# HTTPS com certificado próprio

O Kuruk continua servindo **HTTP** na porta `3123` para os atalhos já criados. Se houver
certificado, ele sobe **também** HTTPS na porta `3443` (configurável por
`KURUK_HTTPS_PORT`). É esse endereço que o tablet deve abrir para o Chrome liberar
instalação como aplicativo e Screen Wake Lock.

## Onde colocar os arquivos

A pasta é mostrada em **Configurações → Rede → HTTPS**. Em uma instalação normal é:

```
<raiz de dados>/certificados/
```

Formatos aceitos:

- `https.pfx` — PKCS#12; senha em `https.pfx.senha` (primeira linha) ou em
  `KURUK_HTTPS_PFX_PASSPHRASE`;
- `https.crt` + `https.key` — PEM.

Depois de colocar os arquivos, **reinicie o Kuruk**. A tela de Configurações mostra o
endereço HTTPS e o hostname extraído do certificado.

## Gerando com mkcert

O comando abaixo gera o certificado com o nome/IP desta máquina e copia a CA para a pasta:

```bash
npm run kuruk https:mkcert
# ou, escolhendo os nomes/IPs:
npm run kuruk https:mkcert -- kuruk.minhaloja.local 10.1.1.31
```

Requisitos no tablet:

1. instalar o `rootCA.pem` (que o comando copia para a pasta de certificados):
   **Configurações → Segurança → Criptografia e credenciais → Instalar certificado →
   Certificado de CA**;
2. abrir `https://<nome-ou-ip-do-certificado>:3443`;
3. instalar o Kuruk como aplicativo.

## Limite importante

O Chrome Android atual pode recusar uma **CA instalada pelo usuário** para instalar PWA
(Certificate Transparency). O HTTPS local com mkcert costuma servir para o Wake Lock, mas
a instalação como aplicativo **não é garantida** com CA local.

Para garantir instalação + notificação:

- use um **domínio com certificado de CA pública**;
- aponte o domínio para a máquina do Kuruk (DNS local/split-horizon) ou use um
  **Cloudflare Tunnel/reverse proxy**;
- coloque o certificado/chave na mesma pasta (ou deixe o túnel terminar o TLS).

Se o túnel/reverse proxy já termina o HTTPS, **não** configure o HTTPS local: use a URL
pública do túnel.

## Notificação com a tela desligada

HTTPS + PWA instalado libera o Screen Wake Lock, que mantém a tela acesa e o som
funcionando. Notificação com o aparelho **bloqueado** exigiria Web Push (serviço de push +
servidor), que é uma etapa separada.
