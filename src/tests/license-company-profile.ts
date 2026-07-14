/**
 * Testes do perfil de empresa que desce na ativação de licença (service.ts):
 *  - composeAddress(): monta o endereço numa linha só, sem vírgula solta quando falta parte.
 *  - applyCompanyProfile(): preenche as configurações da empresa SÓ quando estão vazias
 *    (nunca sobrescreve o que o lojista já ajustou à mão) — a regra escolhida no cadastro.
 *
 * Roda offline (não precisa de Docker/cloud): usa um SQLite temporário só deste teste.
 */
import path from 'node:path';
import type { CloudCompanyProfile } from '../core/license/service';

// Aponta o SQLite para um arquivo temporário ANTES de qualquer módulo abrir a conexão —
// por isso os módulos de runtime abaixo são carregados via require (roda depois desta linha).
process.env.KATSU_DB_PATH = path.resolve(process.cwd(), 'storage', 'temp', 'license-company-profile.db');

/* eslint-disable @typescript-eslint/no-require-imports */
const { migrateUp } = require('../core/database/migrator');
const { runSeeds } = require('../core/database/seeds');
const { resetTestDb } = require('./resetTestDb');
const { settingsRepository } = require('../core/repositories/SettingsRepository');
const { composeAddress, applyCompanyProfile } = require('../core/license/service');
/* eslint-enable @typescript-eslint/no-require-imports */

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function fullProfile(over: Partial<CloudCompanyProfile> = {}): CloudCompanyProfile {
  return {
    name: 'Padaria do Zé',
    legalName: 'Zé Alimentos LTDA',
    document: '11.222.333/0001-81',
    stateRegistration: '123.456.789',
    email: 'contato@ze.com',
    phone: '(11) 90000-0000',
    zip: '01000-000',
    street: 'Av. Brasil',
    number: '100',
    complement: 'Sala 2',
    district: 'Centro',
    city: 'São Paulo',
    state: 'SP',
    ...over,
  };
}

// ─── composeAddress (função pura) ───
check(
  'composeAddress: perfil completo numa linha',
  composeAddress(fullProfile()) === 'Av. Brasil, 100, Sala 2, Centro, São Paulo — SP, 01000-000',
  composeAddress(fullProfile()),
);
check(
  'composeAddress: sem número/complemento não deixa vírgula solta',
  composeAddress(fullProfile({ number: null, complement: '  ' })) === 'Av. Brasil, Centro, São Paulo — SP, 01000-000',
  composeAddress(fullProfile({ number: null, complement: '  ' })),
);
check(
  'composeAddress: só cidade/UF',
  composeAddress(fullProfile({ street: null, number: null, complement: null, district: null, zip: null })) === 'São Paulo — SP',
);
check(
  'composeAddress: tudo vazio → string vazia',
  composeAddress({
    name: null, legalName: null, document: null, stateRegistration: null, email: null, phone: null,
    zip: null, street: null, number: null, complement: null, district: null, city: null, state: null,
  }) === '',
);

// ─── applyCompanyProfile (preenche só se vazio) ───
resetTestDb();
migrateUp();
runSeeds();

// 1) Banco limpo: preenche os campos a partir do perfil.
applyCompanyProfile(fullProfile());
check('applyCompanyProfile: preenche nome fantasia', settingsRepository.get('empresa.nome') === 'Padaria do Zé');
check('applyCompanyProfile: preenche razão social', settingsRepository.get('empresa.razao_social') === 'Zé Alimentos LTDA');
check('applyCompanyProfile: preenche documento', settingsRepository.get('empresa.documento') === '11.222.333/0001-81');
check('applyCompanyProfile: preenche IE', settingsRepository.get('empresa.ie') === '123.456.789');
check('applyCompanyProfile: preenche telefone', settingsRepository.get('empresa.telefone') === '(11) 90000-0000');
check(
  'applyCompanyProfile: monta endereço do cupom',
  settingsRepository.get('empresa.endereco') === 'Av. Brasil, 100, Sala 2, Centro, São Paulo — SP, 01000-000',
  settingsRepository.get('empresa.endereco') ?? '(null)',
);

// 2) Campo já preenchido NÃO é sobrescrito por uma segunda ativação/revalidação.
settingsRepository.set('empresa.nome', 'Nome Editado à Mão');
applyCompanyProfile(fullProfile({ name: 'Nome do Cloud' }));
check(
  'applyCompanyProfile: não sobrescreve valor já existente',
  settingsRepository.get('empresa.nome') === 'Nome Editado à Mão',
  settingsRepository.get('empresa.nome') ?? '(null)',
);

// 3) Perfil nulo/vazio é no-op seguro.
settingsRepository.set('empresa.cidade', 'Campinas');
applyCompanyProfile(null);
applyCompanyProfile(undefined);
check('applyCompanyProfile: perfil nulo é no-op', settingsRepository.get('empresa.cidade') === 'Campinas');

// 4) Campo vazio no perfil não apaga nem grava chave vazia.
applyCompanyProfile(fullProfile({ email: '   ' }));
check('applyCompanyProfile: campo em branco no perfil não grava', settingsRepository.get('empresa.email') === 'contato@ze.com');

if (failures) {
  console.log(`\nPerfil de empresa: ${failures} FALHA(S)`);
  process.exit(1);
} else {
  console.log('\nPerfil de empresa: TODOS OS TESTES PASSARAM');
}
