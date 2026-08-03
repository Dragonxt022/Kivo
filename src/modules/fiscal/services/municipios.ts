/**
 * Municípios do IBGE — o `cMun` é obrigatório no XML da nota e o Kivo não tinha essa
 * informação em lugar nenhum (só `empresa.cidade`, texto livre).
 *
 * A lista vem da API pública do IBGE, uma UF por vez (~100 a 850 municípios), e fica em
 * cache no disco. O plano previa embutir um JSON com os 5.570 municípios; buscar da fonte
 * oficial é melhor por dois motivos: o dado fica correto e atualizado (municípios mudam de
 * nome e são criados), e não carregamos 400 KB de tabela no instalador.
 *
 * O cache torna isso um custo único: depois da primeira busca, a configuração funciona
 * offline. Se a busca falhar, a tela cai na digitação manual do código — configurar a nota
 * fiscal nunca fica bloqueado por causa de uma lista.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Municipio {
  /** Código IBGE de 7 dígitos (cMun). */
  code: string;
  name: string;
}

const CACHE_TTL_MS = 180 * 24 * 3600 * 1000; // 6 meses — a lista quase nunca muda
const FETCH_TIMEOUT_MS = 8000;

function cacheDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  const dir = path.join(path.dirname(path.dirname(dbPath)), 'storage', 'fiscal', 'ibge');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheFile(uf: string): string {
  return path.join(cacheDir(), `municipios-${uf.toUpperCase()}.json`);
}

function readCache(uf: string): Municipio[] | null {
  const file = cacheFile(uf);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Municipio[];
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/** Cache vencido ainda serve se a rede estiver fora — lista velha é melhor que lista nenhuma. */
function readStaleCache(uf: string): Municipio[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(uf), 'utf8')) as Municipio[];
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

interface IbgeMunicipio {
  id: number;
  nome: string;
}

export async function listMunicipios(uf: string): Promise<Municipio[]> {
  const sigla = uf.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(sigla)) throw new Error('UF inválida.');

  const cached = readCache(sigla);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${sigla}/municipios`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`IBGE respondeu ${res.status}`);
    const raw = (await res.json()) as IbgeMunicipio[];
    const list = raw
      .map((m) => ({ code: String(m.id), name: m.nome }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    if (!list.length) throw new Error('IBGE devolveu lista vazia.');
    fs.writeFileSync(cacheFile(sigla), JSON.stringify(list));
    return list;
  } catch (e) {
    const stale = readStaleCache(sigla);
    if (stale) {
      console.error(`[fiscal] busca de municípios de ${sigla} falhou; usando cache antigo:`, e);
      return stale;
    }
    throw new Error(
      'Não foi possível carregar a lista de municípios do IBGE. Confira a internet ou informe o código de 7 dígitos manualmente.',
    );
  }
}

/** Confere se um código pertence à UF (os dois primeiros dígitos são o código da UF). */
export async function findMunicipio(uf: string, code: string): Promise<Municipio | null> {
  const list = await listMunicipios(uf);
  return list.find((m) => m.code === code.trim()) ?? null;
}
