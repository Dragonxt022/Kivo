/**
 * Rotas do resgate de senha. **Públicas por necessidade**: quem esqueceu a senha não tem
 * sessão para autenticar, exatamente como o primeiro acesso (`POST /api/auth/first-run`).
 *
 * O que segura a porta, já que não há login:
 *  - nada acontece sem a resposta certa, e a resposta só sai do suporte;
 *  - rate limit agressivo aqui, porque a rota é alcançável pela rede local quando o
 *    lojista liga "Rede local" (o app passa a escutar em 0.0.0.0, ver electron/main.ts);
 *  - 5 tentativas por desafio, contadas no banco (ver recovery/service.ts).
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { availability, startRecovery, completeRecovery, type RecoveryError } from './service';

const router = Router();

/**
 * Mais apertado que o limiter do login (5/30s): errar a senha no meio do expediente é
 * rotina, pedir resgate não é. Duas janelas separadas porque abrir desafio e tentar código
 * são abusos diferentes — quem varre códigos não deveria conseguir zerar o contador
 * pedindo um desafio novo.
 */
const abrirLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Muitos pedidos de resgate. Aguarde alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const tentarLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Mensagem para o lojista. O erro cru fica no código; aqui é o que ele lê na tela. */
const MENSAGENS: Record<RecoveryError, string> = {
  sem_segredo:
    'Este computador ainda não recebeu o código de segurança da sua licença. Conecte-o à internet por alguns minutos e tente de novo.',
  usuario_desconhecido: 'Não existe usuário ativo com esse nome neste computador.',
  desafio_desconhecido: 'Este pedido de resgate não existe mais. Gere um código novo.',
  desafio_expirado: 'Este código expirou. Gere um novo e ligue para o suporte de novo.',
  tentativas_esgotadas: 'Número de tentativas esgotado para este código. Gere um novo.',
  codigo_incorreto: 'Código de liberação incorreto. Confira os caracteres com o suporte.',
  senha_fraca: 'A senha nova não atende aos requisitos.',
};

/**
 * O que a tela de login precisa saber para decidir o que oferecer: se existe outro
 * administrador (caminho normal), se o resgate por código está disponível nesta máquina,
 * e para quem ligar. Pública e sem segredo nenhum — nada aqui ajuda quem não passou pelo
 * suporte, e sem isso a tela teria que oferecer um resgate que talvez nem funcione.
 */
router.get('/status', (_req, res) => {
  res.json(availability());
});

router.post('/iniciar', abrirLimiter, (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  if (!username) {
    res.status(400).json({ error: 'Informe o usuário que perdeu a senha.' });
    return;
  }
  const result = startRecovery(username);
  if (!result.ok) {
    res.status(result.error === 'sem_segredo' ? 503 : 404).json({ error: MENSAGENS[result.error] });
    return;
  }
  res.json({
    challenge: result.challenge,
    user: result.user,
    expiraEm: result.expiraEm,
    instalacao: availability().instalacao,
  });
});

router.post('/concluir', tentarLimiter, (req, res) => {
  const { challenge, response, newPassword } = req.body ?? {};
  if (!challenge || !response || !newPassword) {
    res.status(400).json({ error: 'Informe o código de liberação e a senha nova.' });
    return;
  }
  const result = completeRecovery(req, {
    challenge: String(challenge),
    response: String(response),
    newPassword: String(newPassword),
  });
  if (!result.ok) {
    // As tentativas restantes vão DENTRO da mensagem, e não num campo ao lado: em resposta
    // de erro o envelope (`shared/responseEnvelope.ts`) mantém só `error` e descarta o
    // resto, então um campo separado nunca chegaria na tela. Saber quantas sobraram evita
    // a pessoa queimar as 5 sem perceber e ter que ligar de novo para o suporte.
    const sufixo =
      result.tentativasRestantes != null
        ? ` Tentativas restantes: ${result.tentativasRestantes}.`
        : '';
    res.status(result.error === 'sem_segredo' ? 503 : 400).json({
      error: (result.detalhe ?? MENSAGENS[result.error]) + sufixo,
    });
    return;
  }
  res.json({ username: result.username, trocada: true });
});

export default router;
