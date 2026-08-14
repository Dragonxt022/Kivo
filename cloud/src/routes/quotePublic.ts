/**
 * Página pública do orçamento — o que o CLIENTE da loja abre, fora do Kivo Web.
 *
 * Sem autenticação, por desenho: o vendedor manda o link pelo WhatsApp e o cliente
 * precisa abrir sem instalar nem entrar em lugar nenhum. O que segura a porta é o
 * endereço ser impossível de adivinhar — dois UUIDv4 (empresa + orçamento), 244 bits no
 * total. Mesmo modelo do cardápio online, que já é público por natureza.
 *
 * O que NÃO aparece aqui, e é deliberado: custo, margem, estoque, telefone/documento do
 * cliente e qualquer outro orçamento. A página renderiza exatamente uma proposta, com o
 * que o cliente já veria num papel impresso.
 */
import { Router } from 'express';
import { getPool } from '../db';
import { findEntity, listEntity, type QuotePayload, type ProductPayload } from '../mobileData';

const router = Router();

function brl(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** UUID v4 canônico. Recusar cedo evita consulta ao banco com lixo vindo da URL. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CompanyRow {
  name: string | null;
  phone: string | null;
  email: string | null;
  document: string | null;
  city: string | null;
  state: string | null;
  street: string | null;
  number: string | null;
  district: string | null;
}

router.get('/orcamento/:company/:uuid', async (req, res) => {
  const company = String(req.params.company);
  const uuid = String(req.params.uuid);
  if (!UUID.test(company) || !UUID.test(uuid)) {
    res.status(404).render('quote-public-404');
    return;
  }

  const quote = await findEntity<QuotePayload>(company, 'store.quotes', uuid);
  // Orçamento apagado no desktop some daqui junto: o link que o cliente tem para de
  // valer, que é o comportamento esperado de uma proposta retirada.
  if (!quote || quote.deletedAt) {
    res.status(404).render('quote-public-404');
    return;
  }

  const [rows] = await getPool().query(
    `SELECT name, phone, email, document, city, state, street, number, district
       FROM companies WHERE company_uuid = ?`,
    [company],
  );
  const empresa = (rows as CompanyRow[])[0] ?? null;
  if (!empresa) {
    res.status(404).render('quote-public-404');
    return;
  }

  // Nome do produto: o payload do item já traz `product_name` (congelado na cotação), e o
  // cadastro é só a rede de segurança para orçamento antigo salvo antes dessa coluna.
  const precisaCatalogo = (quote.payload.quote_items ?? []).some((i) => !i.product_name);
  const nomePorUuid = precisaCatalogo
    ? new Map(
        (await listEntity<ProductPayload>(company, 'commercial.products', { limit: 5000 }))
          .map((p) => [p.uuid, p.payload.name]),
      )
    : new Map<string, string>();

  res.render('quote-public', { quote, empresa, nomePorUuid, brl });
});

export default router;
