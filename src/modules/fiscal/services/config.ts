/**
 * Configuração fiscal: leitura/escrita tipada sobre `settings` (prefixo `fiscal.*`).
 *
 * Os SEGREDOS não passam por aqui — CSC, senha do certificado e token do emissor vão para
 * `core/secrets`, porque `GET /api/settings` devolve todas as chaves para quem tem
 * `settings.view` e o backup manda o banco inteiro para a nuvem.
 */
import { settingsRepository } from '../../../core/repositories/SettingsRepository';
import { getSecret, hasSecret, setSecret } from '../../../core/secrets/service';

export const SECRET_CSC = 'fiscal.csc';
export const SECRET_CERT_PASSWORD = 'fiscal.cert_senha';
export const SECRET_PROVIDER_TOKEN = 'fiscal.provider_token';

/** 1 = Simples Nacional, 2 = Simples excesso de sublimite, 3 = Regime Normal. */
export type Crt = 1 | 2 | 3;
/** 1 = produção, 2 = homologação. */
export type Environment = 1 | 2;

export interface FiscalConfig {
  ambiente: Environment;
  modelo: '65';
  serie: number;
  crt: Crt;
  cfop: string;
  csosnPadrao: string;
  cstPadrao: string;
  origemPadrao: number;
  emitirAuto: boolean;
  pedirCpf: boolean;
  provider: string;
  idCsc: string;
  /** Preenchido pela leitura do .pfx — só para exibir, nunca é fonte de verdade. */
  certTitular: string;
  certValidade: string;
  certArquivo: string;
  /** ISO da última emissão de teste autorizada — destrava a troca para produção. */
  testeOkEm: string;
}

export interface EmpresaFiscal {
  razaoSocial: string;
  nomeFantasia: string;
  cnpj: string;
  ie: string;
  cep: string;
  rua: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  municipioIbge: string;
  telefone: string;
}

function str(key: string, fallback = ''): string {
  return settingsRepository.get(key) ?? fallback;
}

function num(key: string, fallback: number): number {
  const raw = settingsRepository.get(key);
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getConfig(): FiscalConfig {
  const crt = num('fiscal.crt', 1);
  return {
    // Nunca cai em produção por omissão: sem valor gravado, homologação.
    ambiente: num('fiscal.ambiente', 2) === 1 ? 1 : 2,
    modelo: '65',
    serie: num('fiscal.serie', 1),
    crt: (crt === 2 || crt === 3 ? crt : 1) as Crt,
    cfop: str('fiscal.cfop', '5102'),
    csosnPadrao: str('fiscal.csosn_padrao', '102'),
    cstPadrao: str('fiscal.cst_padrao', '00'),
    origemPadrao: num('fiscal.origem_padrao', 0),
    emitirAuto: settingsRepository.getBool('fiscal.emitir_auto', false),
    pedirCpf: settingsRepository.getBool('fiscal.pedir_cpf', true),
    provider: str('fiscal.provider'),
    idCsc: str('fiscal.id_csc'),
    certTitular: str('fiscal.cert_titular'),
    certValidade: str('fiscal.cert_validade'),
    certArquivo: str('fiscal.cert_arquivo'),
    testeOkEm: str('fiscal.teste_ok_em'),
  };
}

/**
 * Grava só o que veio no patch. `ambiente` é deliberadamente ignorado aqui — mudar de
 * homologação para produção passa por `promoteToProduction()`, que exige a emissão de
 * teste aprovada.
 */
export function saveConfig(patch: Partial<Omit<FiscalConfig, 'ambiente' | 'modelo'>>): void {
  const map: Record<string, string | undefined> = {
    'fiscal.serie': patch.serie != null ? String(patch.serie) : undefined,
    'fiscal.crt': patch.crt != null ? String(patch.crt) : undefined,
    'fiscal.cfop': patch.cfop,
    'fiscal.csosn_padrao': patch.csosnPadrao,
    'fiscal.cst_padrao': patch.cstPadrao,
    'fiscal.origem_padrao': patch.origemPadrao != null ? String(patch.origemPadrao) : undefined,
    'fiscal.emitir_auto': patch.emitirAuto != null ? (patch.emitirAuto ? '1' : '0') : undefined,
    'fiscal.pedir_cpf': patch.pedirCpf != null ? (patch.pedirCpf ? '1' : '0') : undefined,
    'fiscal.provider': patch.provider,
    'fiscal.id_csc': patch.idCsc,
  };
  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined) settingsRepository.set(key, value);
  }
}

/** Dados do emitente. Reaproveita `empresa.*`, que já existe e é preenchido na ativação. */
export function getEmpresa(): EmpresaFiscal {
  return {
    razaoSocial: str('empresa.razao_social'),
    nomeFantasia: str('empresa.nome'),
    cnpj: str('empresa.documento'),
    ie: str('empresa.ie'),
    cep: str('empresa.cep'),
    rua: str('empresa.rua'),
    numero: str('empresa.numero'),
    complemento: str('empresa.complemento'),
    bairro: str('empresa.bairro'),
    cidade: str('empresa.cidade'),
    uf: str('empresa.uf'),
    municipioIbge: str('empresa.municipio_ibge'),
    telefone: str('empresa.telefone'),
  };
}

/**
 * Grava os dados do emitente. Também recompõe `empresa.endereco` (a linha única usada no
 * cabeçalho dos cupons), senão o lojista preencheria o endereço estruturado aqui e o cupom
 * continuaria mostrando o endereço antigo.
 */
export function saveEmpresa(patch: Partial<EmpresaFiscal>): void {
  const map: Record<string, string | undefined> = {
    'empresa.razao_social': patch.razaoSocial,
    'empresa.nome': patch.nomeFantasia,
    'empresa.documento': patch.cnpj,
    'empresa.ie': patch.ie,
    'empresa.cep': patch.cep,
    'empresa.rua': patch.rua,
    'empresa.numero': patch.numero,
    'empresa.complemento': patch.complemento,
    'empresa.bairro': patch.bairro,
    'empresa.cidade': patch.cidade,
    'empresa.uf': patch.uf,
    'empresa.municipio_ibge': patch.municipioIbge,
    'empresa.telefone': patch.telefone,
  };
  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined) settingsRepository.set(key, value.trim());
  }

  const e = getEmpresa();
  const linha1 = [e.rua, e.numero].filter(Boolean).join(', ');
  const cidadeUf = [e.cidade, e.uf].filter(Boolean).join(' — ');
  const endereco = [linha1, e.complemento, e.bairro, cidadeUf, e.cep].filter(Boolean).join(', ');
  if (endereco) settingsRepository.set('empresa.endereco', endereco);
}

export function getCsc(): string | null {
  return getSecret(SECRET_CSC);
}

export function setCsc(csc: string): void {
  setSecret(SECRET_CSC, csc.trim());
}

export function hasCsc(): boolean {
  return hasSecret(SECRET_CSC);
}

export function getProviderToken(): string | null {
  return getSecret(SECRET_PROVIDER_TOKEN);
}

export function setProviderToken(token: string): void {
  setSecret(SECRET_PROVIDER_TOKEN, token.trim());
}

export function hasProviderToken(): boolean {
  return hasSecret(SECRET_PROVIDER_TOKEN);
}

/**
 * Troca para produção. Só passa com uma emissão de teste autorizada registrada — é a trava
 * do beta: enquanto o lojista não viu uma nota ser aceita em homologação, o Kivo não deixa
 * mandar nada com valor fiscal.
 */
export function promoteToProduction(): { ok: true } | { ok: false; error: string } {
  if (!getConfig().testeOkEm) {
    return {
      ok: false,
      error: 'Emita uma nota de teste em homologação e obtenha autorização antes de ativar a produção.',
    };
  }
  settingsRepository.set('fiscal.ambiente', '1');
  return { ok: true };
}

/** Volta para homologação. Sempre permitido — voltar para o modo seguro nunca é bloqueado. */
export function backToHomologation(): void {
  settingsRepository.set('fiscal.ambiente', '2');
}

/** Registra que a emissão de teste passou; é isso que destrava `promoteToProduction()`. */
export function markTestPassed(): void {
  settingsRepository.set('fiscal.teste_ok_em', new Date().toISOString());
}
