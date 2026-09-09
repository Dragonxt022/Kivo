import { getSqlite } from '../../core/database/connection';
import { createLogger } from '../../core/logger';
import { validateImageBuffer } from '../../core/catalog/imageValidation';
import { saveLocalProductImage, cloudBaseUrl, cloudAuthHeaders } from '../../core/catalog/submissionQueue';
import { productRepository } from './repositories/ProductRepository';

/**
 * Preenchimento em lote de imagens de produtos (ou complementos) sem foto.
 *
 * Complementa o `prepareProductImage` das rotas de produto (que só age na hora de SALVAR
 * um criar/editar): aqui a gente varre os produtos que JÁ estão cadastrados sem imagem e
 * tenta preencher sozinho, em duas camadas:
 *
 *   1. LOCAL (sempre, offline, qualquer usuário) — se existe outro produto IGUAL cadastrado
 *      (mesmo código de barras → senão SKU → senão nome) que tenha foto, copia a foto. É a
 *      mesma regra do auto-preenchimento do cadastro, aplicada retroativamente — típico de
 *      catálogo importado/duplicado em que o "mesmo" item entrou mais de uma vez.
 *   2. NUVEM (best-effort, quando há internet + empresa ativada) — consulta o banco de
 *      imagens do Kivo Cloud pelo NOME do produto e, achando uma foto aprovada, baixa e
 *      salva localmente (fica disponível offline depois). A busca na nuvem NÃO tem gate de
 *      plano (ver cloud/src/routes/catalog.ts): funciona em trial/qualquer assinatura, só
 *      exige empresa autenticada — ou seja, independe do usuário ter plano pago.
 *
 * O escopo diz QUAL aba o lojista está preenchendo (a tela de produtos tem duas):
 *   - 'produtos'      — o que se vende avulso/montado (tudo que NÃO é complemento);
 *   - 'complementos'  — a aba "Complementos", que lista quem só existe como opção de
 *     complemento (product_type 'complemento') e o produto que participa de um grupo de
 *     complemento. O produto-pai de variações (que não se vende) fica fora dos dois.
 *
 * A execução é idempotente: rodar de novo só continua preenchendo o que ainda ficou sem
 * foto (a chamada da nuvem é limitada por rodada para não virar uma rajada de requests —
 * itens com nome muito curto ou sem correspondência seguem sem foto, sem erro).
 */

const log = createLogger('prod-imagens');

export type AutofillScope = 'produtos' | 'complementos';

/** Produto escondido que não se vende: o pai de variações. Não ganha imagem nem serve
 *  de fonte em NENHUM escopo. */
const PAI_VARIANTE = `NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)`;

/** "Complemento" na tela = tipo 'complemento' OU quem participa de um grupo de
 *  complemento — o mesmo critério de `is_complement` da listagem de produtos. */
const COMPLEMENTO = `(p.product_type = 'complemento'
  OR EXISTS (SELECT 1 FROM complement_group_items cgi
             WHERE cgi.product_id = p.id AND cgi.deleted_at IS NULL))`;

function scopePredicate(scope: AutofillScope): string {
  const emEscopo = scope === 'complementos' ? COMPLEMENTO : `NOT (${COMPLEMENTO})`;
  return `${emEscopo} AND ${PAI_VARIANTE}`;
}

/** Rodadas longas de rede travam a interface; cap por clique e o usuário repete. */
const MAX_REMOTE_FILLS_PER_RUN = 50;
/** Menos que isso o nome não descreve produto nenhum (a nuvem também exige 3+). */
const MIN_NAME_LEN = 3;

interface ProductImageRow {
  id: number;
  name: string;
  barcode: string | null;
  sku: string | null;
  updated_at: string;
  image_url?: string;
}

export interface AutofillImageResult {
  /** Produtos que estavam sem foto quando a rotina começou. */
  scanned: number;
  /** Preenchidos copiando a foto de um produto igual já cadastrado (local). */
  filledLocal: number;
  /** Preenchidos baixando do banco de imagens da nuvem. */
  filledCloud: number;
  /** Ainda sem foto ao fim desta rodada. */
  stillMissing: number;
  /** Rodada parou antes de tentar todos (limite de chamadas à nuvem) — rode de novo. */
  limited: boolean;
  /** Sem nuvem configurada/online — só a camada local rodou. */
  offline: boolean;
  /** Erro de rede/credencial que interrompeu a camada de nuvem. */
  remoteError?: string;
}

interface NormalizedIndex {
  byBarcode: Map<string, string>;
  bySku: Map<string, string>;
  byName: Map<string, string>;
}

/** Indexa produtos COM foto pelo campo mais específico (mais recente vence). */
function buildImageIndex(rows: ProductImageRow[]): NormalizedIndex {
  const index: NormalizedIndex = { byBarcode: new Map(), bySku: new Map(), byName: new Map() };
  // updated_at DESC → o primeiro a entrar no Map é o mais recente.
  const sorted = [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  for (const row of sorted) {
    if (!index.byBarcode.has(row.barcode ?? '') && row.barcode) index.byBarcode.set(row.barcode.trim(), row.image_url!);
    if (!index.bySku.has(row.sku ?? '') && row.sku) index.bySku.set(row.sku.trim(), row.image_url!);
    if (!index.byName.has(row.name) && row.name) index.byName.set(row.name.trim(), row.image_url!);
  }
  return index;
}

function localMatch(index: NormalizedIndex, row: ProductImageRow): string | null {
  if (row.barcode) {
    const hit = index.byBarcode.get(row.barcode.trim());
    if (hit) return hit;
  }
  if (row.sku) {
    const hit = index.bySku.get(row.sku.trim());
    if (hit) return hit;
  }
  if (row.name) {
    const hit = index.byName.get(row.name.trim());
    if (hit) return hit;
  }
  return null;
}

function db(): ReturnType<typeof getSqlite> {
  return getSqlite();
}

/** Fase 1 — reaproveita a foto de um produto igual já cadastrado (100% local/offline). */
function fillFromLocalProducts(scope: AutofillScope): { filled: number; remaining: ProductImageRow[] } {
  const missing = db()
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.sku, p.updated_at
       FROM products p WHERE p.deleted_at IS NULL AND (p.image_url IS NULL OR p.image_url = '')
       AND ${scopePredicate(scope)} ORDER BY p.updated_at DESC, p.id DESC`,
    )
    .all() as ProductImageRow[];

  if (!missing.length) return { filled: 0, remaining: [] };

  const sources = db()
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.sku, p.updated_at, p.image_url
       FROM products p WHERE p.deleted_at IS NULL AND p.image_url IS NOT NULL AND p.image_url != ''
       AND ${scopePredicate(scope)}`,
    )
    .all() as ProductImageRow[];
  const index = buildImageIndex(sources);

  let filled = 0;
  const remaining: ProductImageRow[] = [];
  for (const row of missing) {
    const imageUrl = localMatch(index, row);
    if (!imageUrl) {
      remaining.push(row);
      continue;
    }
    productRepository.rawRun(
      "UPDATE products SET image_url = ?, updated_at = datetime('now') WHERE id = ?",
      imageUrl, row.id,
    );
    filled++;
  }
  return { filled, remaining };
}

/**
 * Fase 2 — consulta o banco de imagens da nuvem pelo nome e salva a primeira foto
 * aprovada localmente. Nenhum gate de plano aqui (só empresa autenticada).
 */
async function fillFromCloud(rows: ProductImageRow[]): Promise<{
  filled: number;
  hitLimit: boolean;
  offline: boolean;
  remoteError?: string;
}> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return { filled: 0, hitLimit: false, offline: true };

  let filled = 0;
  let attempts = 0;
  let hitLimit = false;
  let offline = false;
  let remoteError: string | undefined;
  // Duplicados do mesmo nome baixam a foto uma vez só e reusam o arquivo local.
  const byNamePath = new Map<string, string>();

  for (const row of rows) {
    const name = (row.name ?? '').trim();
    if (name.length < MIN_NAME_LEN) continue;
    if (attempts >= MAX_REMOTE_FILLS_PER_RUN) {
      hitLimit = true; // ainda havia produto elegível — rode de novo para continuar
      break;
    }
    attempts++;

    try {
      const cached = byNamePath.get(name);
      if (cached) {
        productRepository.rawRun(
          "UPDATE products SET image_url = ?, updated_at = datetime('now') WHERE id = ?",
          cached, row.id,
        );
        filled++;
        continue;
      }
      const search = await fetch(`${base}/api/catalog/search?q=${encodeURIComponent(name)}`, {
        headers: auth, signal: AbortSignal.timeout(8000),
      });
      if (!search.ok) {
        if (search.status === 401 || search.status === 403) {
          remoteError = `Banco de imagens respondeu ${search.status}.`;
          offline = true;
          break;
        }
        continue;
      }
      const results = (await search.json()) as { url: string }[];
      if (!results.length) continue;

      const image = await fetch(`${base}${results[0].url}`, {
        headers: auth, signal: AbortSignal.timeout(8000),
      });
      if (!image.ok) {
        if (image.status === 401 || image.status === 403) {
          remoteError = `Banco de imagens respondeu ${image.status}.`;
          offline = true;
          break;
        }
        continue;
      }
      const buf = Buffer.from(await image.arrayBuffer());
      const check = validateImageBuffer(buf);
      if (!check.ok) continue;

      const localPath = saveLocalProductImage(buf, check.format);
      byNamePath.set(name, localPath);
      productRepository.rawRun(
        "UPDATE products SET image_url = ?, updated_at = datetime('now') WHERE id = ?",
        localPath, row.id,
      );
      filled++;
    } catch (e) {
      log.error('falha ao buscar imagem do banco de imagens', e);
      offline = true;
      remoteError = 'Banco de imagens indisponível agora.';
      break;
    }
  }

  return { filled, hitLimit, offline, remoteError };
}

export async function autofillMissingProductImages(scope: AutofillScope = 'produtos'): Promise<AutofillImageResult> {
  const { filled: filledLocal, remaining } = fillFromLocalProducts(scope);

  // Sem nuvem configurada o resultado já sai: a camada local é a única garantida para
  // quem não tem assinatura/empresa ativada (e funciona até 100% offline).
  if (!cloudBaseUrl() || !cloudAuthHeaders()) {
    return {
      scanned: filledLocal + remaining.length,
      filledLocal,
      filledCloud: 0,
      stillMissing: remaining.length,
      limited: false,
      offline: true,
    };
  }

  const cloud = await fillFromCloud(remaining);
  const stillMissing = Math.max(0, remaining.length - cloud.filled);
  return {
    scanned: filledLocal + remaining.length,
    filledLocal,
    filledCloud: cloud.filled,
    stillMissing,
    limited: cloud.hitLimit && stillMissing > 0,
    offline: cloud.offline,
    remoteError: cloud.remoteError,
  };
}
