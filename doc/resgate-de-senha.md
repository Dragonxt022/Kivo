# Resgate de senha — roteiro do atendimento

O que fazer quando o lojista liga dizendo que perdeu a senha do Kivo.

---

## Antes de tudo: pergunte se existe outro administrador

**É a solução na maioria dos casos e não precisa de você.** Qualquer pessoa com acesso de
administrador entra no Kivo, abre **Usuários**, clica no nome de quem perdeu a senha e define
uma nova. Funciona offline e leva quinze segundos.

O resgate por código abaixo é para o caso em que o administrador é **único** — aí não existe
ninguém do lado de dentro que consiga destravar.

---

## Por que não existe "recuperar por e-mail"

A senha do Kivo mora no SQLite **da máquina da loja**, não numa conta na nuvem. Um link de
recuperação chegaria no celular do lojista e teria que alcançar um servidor em
`localhost:3123`, atrás do NAT da internet residencial dele — sem IP público e sem porta
aberta. É o mesmo motivo pelo qual o Kivo Web usa SSE em vez de webhook.

Somando: o PDV precisa se recuperar **com a internet caída**, que é exatamente quando e-mail
não chega.

---

## O roteiro

1. **Confirme quem está na linha.** O código troca a senha de um usuário do sistema do
   cliente. O Kivo registra a troca na auditoria dele, mas **quem valida a identidade é
   você** — não existe nada no sistema que faça isso no seu lugar. Um funcionário pedindo o
   resgate da senha do dono é um cenário real.

2. Peça para ele clicar em **Esqueci minha senha** na tela de login do Kivo, escolher o
   caminho "Resgatar com o suporte" e digitar o nome do usuário cuja senha será trocada.

3. Ele vai ler dois valores na tela:
   - o **código deste computador** (formato `XXXX-XXXX-XXXX-XXXX`)
   - a **instalação** (8 caracteres) — use para conferir que é a máquina certa.

4. No painel: **Empresas → a empresa → aba Licença → Resgate de senha do cliente**. Cole o
   código que ele ditou e clique em **Gerar resposta**.

5. Dite a resposta (`XXXXX-XXXXX`). Ele digita, escolhe a senha nova e pronto.

O alfabeto dos códigos não tem **I**, **L**, **O** nem **U** — se você ouvir uma dessas,
foi confusão com 1, 0 ou V, e o sistema já corrige sozinho. Maiúscula/minúscula e hífen
também não importam.

---

## Limites (e o que dizer quando esbarrar neles)

| Situação | O que acontece | O que dizer |
|---|---|---|
| Passaram 30 minutos | O código expira | "Gere um código novo aí e me dite de novo" |
| Errou 5 vezes | Aquele código trava de vez | "Gere um novo — o antigo não vale mais" |
| Ele gerou outro código | O anterior morre na hora | Use sempre o **último** que ele ditar |
| Muitas tentativas seguidas | A tela bloqueia por alguns minutos | "Espera uns minutos e tenta de novo" |

---

## "Esta empresa ainda não tem segredo de resgate"

O segredo é entregue ao Kivo do cliente quando ele valida a licença — no máximo a cada 4h, e
também ~20s depois de abrir o programa. Empresas em teste já nascem com ele.

Se a mensagem aparecer no painel, ou se o Kivo dele disser que *"este computador ainda não
recebeu o código de segurança"*, é a mesma causa: **aquela instalação nunca ficou online
depois desta versão**. Peça para abrir o Kivo conectado à internet por alguns minutos e
tentar de novo.

---

## O que o código **não** permite

- Não entra na conta de ninguém — só permite **definir uma senha nova**, que o lojista
  escolhe e digita ele mesmo. Você nunca vê nem escolhe a senha dele.
- Não vale para outra máquina nem para outra empresa: cada resposta serve para **um desafio
  só**, e o desafio é daquela instalação.
- Não expõe o segredo da empresa. O painel mostra apenas a resposta derivada. Mesmo alguém
  com o histórico de todas as respostas já ditadas não consegue gerar a próxima.

Toda troca fica em **Auditoria** no Kivo do cliente, como `senha_resgatada`, com o horário e
o usuário afetado.

---

## Nota técnica

Resposta = `HMAC-SHA256(segredo da empresa, "kivo-resgate-v1|" + desafio)`, truncada para 6
bytes e escrita em base32 Crockford.

O segredo é **por empresa** (coluna `companies.recovery_secret`), não uma chave mestra no
instalador. Com "Rede local" ligada o Kivo escuta em `0.0.0.0`, então a tela de resgate é
alcançável por qualquer máquina da rede da loja — uma chave extraída do instalador
destravaria qualquer Kivo alcançável. No desktop o segredo fica no cofre
(`storage/secrets.json`), fora do banco, fora do backup e fora do motor de sync.

Código: [`src/core/recovery/`](../src/core/recovery/) (desktop),
[`cloud/src/recoveryCodes.ts`](../cloud/src/recoveryCodes.ts) (nuvem),
[`src/tests/recuperacao-senha.ts`](../src/tests/recuperacao-senha.ts) (testes).
