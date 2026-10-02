/**
 * Teste de integração do odontograma e das situações odontológicas (PR §9 e §10).
 *
 * Cobre o que a PR pede: dentes identificados (FDI), superfícies (M, D, O, V, L), situação por
 * dente e por face, histórico de cada dente, tratamentos planejados x realizados, e o catálogo
 * de situações EXPANSÍVEL (§10: nada de lista fixa).
 *
 * A regra que o teste protege com mais cuidado: mudar a situação NÃO sobrescreve — grava uma
 * linha nova; "desfazer" revela o estado anterior sem apagar o registro.
 *
 * KIVO_DB_PATH TEM que vir do ambiente — rode com
 *   node scripts/test-isolated.js src/tests/odonto-odontograma.ts
 */
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite } from '../core/database/connection';
import { createServer } from '../core/server';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap } from './testUtils';

const PORT = Number(process.env.KIVO_PORT ?? 3848);
const base = `http://localhost:${PORT}`;
const O = '/api/odonto';
const NOTA = 'Cárie oclusal profunda, sem exposição pulpar (teste)';

let failures = 0;

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(path: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function loginAs(u: string, p: string): Promise<string | null> {
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

interface Condition { id: number; code: string; name: string; color: string; applies_to: string; is_neutral: boolean; active: boolean }
interface State {
  id: number; tooth: string; surface: string | null; kind: string;
  condition_id: number; condition_code: string; condition_name: string; condition_color: string;
  is_neutral: boolean; note: string | null; recorded_at: string;
  created_by_name: string | null; undone_at: string | null; undone_by_name: string | null;
}
interface Odontogram {
  conditions: Condition[];
  states: State[];
  current: Record<string, { whole: State | null; surfaces: Record<string, State>; planned: State[] }>;
  resumo: { dentes_com_situacao: number; planejados: number; registros: number };
}
interface ToothDetail {
  tooth: string;
  history: State[];
  planned: State[];
  procedures: { id: number; happened_at: string; name: string; note: string | null }[];
}

async function main(): Promise<void> {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  try {
    const admin = await loginAs('admin', 'admin');
    check('login admin', admin !== null);
    check('sem login → 401', (await api(`${O}/patients/1/odontogram`)).status === 401);

    // ── Base ───────────────────────────────────────────────────────────────
    const paciente = (await unwrap<{ id: number }>(await api(`${O}/patients`, {
      method: 'POST', body: JSON.stringify({ name: 'Rafael Odontograma (teste)' }),
    }, admin!))).id;
    const dentista = (await unwrap<{ id: number }>(await api(`${O}/professionals`, {
      method: 'POST', body: JSON.stringify({ name: 'Dr. Sérgio (teste)', cro: '11223', cro_state: 'MT' }),
    }, admin!))).id;
    const restauracao = (await unwrap<{ id: number }>(await api(`${O}/procedures`, {
      method: 'POST', body: JSON.stringify({ name: 'Restauração (teste odontograma)', duration_min: 60 }),
    }, admin!))).id;
    check('base criada', paciente > 0 && dentista > 0 && restauracao > 0);

    // ── Situações iniciais da PR §10 ───────────────────────────────────────
    const condicoes = await unwrap<Condition[]>(await api(`${O}/tooth-conditions`, {}, admin!));
    const codigos = condicoes.map((c) => c.code);
    check('as nove situações da PR foram semeadas',
      ['integro', 'carie', 'restaurado', 'endodontia', 'ausente', 'extracao_indicada', 'fratura', 'implante', 'coroa']
        .every((c) => codigos.includes(c)),
      codigos.join(', '));
    check('situação tem cor para o desenho', condicoes.every((c) => /^#[0-9a-fA-F]{6}$/.test(c.color)));
    const carie = condicoes.find((c) => c.code === 'carie')!;
    const restaurado = condicoes.find((c) => c.code === 'restaurado')!;
    const fratura = condicoes.find((c) => c.code === 'fratura')!;
    const ausente = condicoes.find((c) => c.code === 'ausente')!;
    const integro = condicoes.find((c) => c.code === 'integro')!;
    check('situação "ausente" vale para o dente inteiro', ausente.applies_to === 'dente', ausente.applies_to);
    check('"íntegro" é a situação neutra', integro.is_neutral === true);

    // ── Catálogo expansível (PR §10) ───────────────────────────────────────
    const novaSit = await api(`${O}/tooth-conditions`, {
      method: 'POST', body: JSON.stringify({ code: 'selante', name: 'Selante', color: '#22c55e', applies_to: 'superficie' }),
    }, admin!);
    check('clínica cria situação nova (201)', novaSit.status === 201, String(novaSit.status));
    const selante = await unwrap<Condition>(novaSit);
    check('situação nova entra na lista',
      (await unwrap<Condition[]>(await api(`${O}/tooth-conditions`, {}, admin!))).some((c) => c.code === 'selante'));

    check('código repetido → 409', (await api(`${O}/tooth-conditions`, {
      method: 'POST', body: JSON.stringify({ code: 'selante', name: 'Outro' }),
    }, admin!)).status === 409);
    check('código inválido → 400', (await api(`${O}/tooth-conditions`, {
      method: 'POST', body: JSON.stringify({ code: '9 ruim!', name: 'X' }),
    }, admin!)).status === 400);
    check('situação sem nome → 400', (await api(`${O}/tooth-conditions`, {
      method: 'POST', body: JSON.stringify({ code: 'sem_nome' }),
    }, admin!)).status === 400);

    // ── Estado do dente: histórico append-only ─────────────────────────────
    const registrar = (corpo: Record<string, unknown>) => api(`${O}/patients/${paciente}/odontogram`, {
      method: 'POST', body: JSON.stringify(corpo),
    }, admin!);

    const denteInteiro = await registrar({
      tooth: '26', condition_id: carie.id, note: NOTA, recorded_at: '2026-11-10 09:00',
      professional_id: dentista,
    });
    check('situação do dente inteiro registrada (201)', denteInteiro.status === 201, String(denteInteiro.status));
    const estado1 = await unwrap<State>(denteInteiro);
    check('registro guarda dente, situação e observação',
      estado1.tooth === '26' && estado1.condition_code === 'carie' && estado1.note === NOTA,
      JSON.stringify({ t: estado1.tooth, c: estado1.condition_code }));

    let odonto = await unwrap<Odontogram>(await api(`${O}/patients/${paciente}/odontogram`, {}, admin!));
    check('estado atual do dente 26 é cárie', odonto.current['26']?.whole?.condition_code === 'carie');
    check('resumo conta o dente com situação', odonto.resumo.dentes_com_situacao === 1, JSON.stringify(odonto.resumo));

    const face = await registrar({ tooth: '26', surface: 'O', condition_id: restaurado.id, recorded_at: '2026-11-10 09:30' });
    check('situação por face registrada (201)', face.status === 201, String(face.status));
    odonto = await unwrap<Odontogram>(await api(`${O}/patients/${paciente}/odontogram`, {}, admin!));
    check('face oclusal restaurada', odonto.current['26']?.surfaces?.O?.condition_code === 'restaurado');
    check('a situação do dente inteiro continua', odonto.current['26']?.whole?.condition_code === 'carie');

    // Mudar a MESMA face: nova linha; a anterior fica no histórico.
    await registrar({ tooth: '26', surface: 'O', condition_id: fratura.id, recorded_at: '2026-11-11 10:00' });
    odonto = await unwrap<Odontogram>(await api(`${O}/patients/${paciente}/odontogram`, {}, admin!));
    check('mudar a face passa a valer a nova situação', odonto.current['26']?.surfaces?.O?.condition_code === 'fratura');
    const detalhe26 = await unwrap<ToothDetail>(await api(`${O}/patients/${paciente}/odontogram/26`, {}, admin!));
    check('o histórico do dente guarda as duas linhas da face',
      detalhe26.history.filter((h) => h.surface === 'O' && !h.undone_at).length === 2,
      `${detalhe26.history.filter((h) => h.surface === 'O').length} linha(s)`);

    // ── Desfazer revela o estado anterior (sem apagar) ─────────────────────
    const ultima = detalhe26.history.find((h) => h.surface === 'O' && h.condition_code === 'fratura')!;
    const desfeito = await api(`${O}/odontogram/${ultima.id}/undo`, {
      method: 'POST', body: JSON.stringify({ motivo: 'lancei no dente errado' }),
    }, admin!);
    check('desfazer responde 200', desfeito.status === 200, String(desfeito.status));
    odonto = await unwrap<Odontogram>(await api(`${O}/patients/${paciente}/odontogram`, {}, admin!));
    check('desfazer revela o estado anterior', odonto.current['26']?.surfaces?.O?.condition_code === 'restaurado',
      String(odonto.current['26']?.surfaces?.O?.condition_code));

    const detalheDepois = await unwrap<ToothDetail>(await api(`${O}/patients/${paciente}/odontogram/26`, {}, admin!));
    const registroDesfeito = detalheDepois.history.find((h) => h.id === ultima.id);
    check('o registro desfeito continua no histórico', !!registroDesfeito);
    check('o histórico diz quem desfez', registroDesfeito?.undone_by_name === 'admin', String(registroDesfeito?.undone_by_name));

    check('desfazer duas vezes → 400', (await api(`${O}/odontogram/${ultima.id}/undo`, {
      method: 'POST', body: JSON.stringify({}),
    }, admin!)).status === 400);

    // ── Tratamento planejado x realizado ───────────────────────────────────
    const planejado = await registrar({
      tooth: '26', kind: 'planejado', condition_id: restaurado.id, note: 'Restauração em resina planejada',
    });
    check('tratamento planejado registrado (201)', planejado.status === 201, String(planejado.status));
    odonto = await unwrap<Odontogram>(await api(`${O}/patients/${paciente}/odontogram`, {}, admin!));
    check('planejado aparece separado da situação', (odonto.current['26']?.planned?.length ?? 0) === 1,
      JSON.stringify(odonto.current['26']?.planned?.length));
    check('planejado não muda a situação do dente', odonto.current['26']?.whole?.condition_code === 'carie');

    // Procedimento do prontuário citando o dente aparece no detalhe do dente (realizado).
    await api(`${O}/patients/${paciente}/notes`, {
      method: 'POST',
      body: JSON.stringify({
        happened_at: '2026-11-12 14:00',
        procedures: [{ procedure_id: restauracao, tooth: '26', note: 'face oclusal' }],
        observations: 'Restauração executada.',
      }),
    }, admin!);
    const detalheComProcedimento = await unwrap<ToothDetail>(await api(`${O}/patients/${paciente}/odontogram/26`, {}, admin!));
    check('procedimento do prontuário aparece como realizado no dente',
      detalheComProcedimento.procedures.some((p) => p.name === 'Restauração (teste odontograma)'),
      JSON.stringify(detalheComProcedimento.procedures.map((p) => p.name)));

    // ── Validações ─────────────────────────────────────────────────────────
    check('dente fora da numeração FDI → 400', (await registrar({ tooth: '99', condition_id: carie.id })).status === 400);
    check('dente com um dígito → 400', (await registrar({ tooth: '9', condition_id: carie.id })).status === 400);
    check('situação inexistente → 400', (await registrar({ tooth: '26', condition_id: 99999 })).status === 400);
    check('superfície inválida → 400', (await registrar({ tooth: '26', surface: 'X', condition_id: carie.id })).status === 400);
    check('situação que vale só para o dente numa face → 400',
      (await registrar({ tooth: '27', surface: 'O', condition_id: ausente.id })).status === 400);
    check('situação que vale só para a face sem escolher face → 400',
      (await registrar({ tooth: '27', condition_id: selante.id })).status === 400);
    check('data/hora inválida → 400', (await registrar({ tooth: '26', condition_id: carie.id, recorded_at: '10/11/2026' })).status === 400);
    check('profissional inexistente → 400',
      (await registrar({ tooth: '26', condition_id: carie.id, professional_id: 4242 })).status === 400);
    check('paciente inexistente → 404',
      (await api(`${O}/patients/9999/odontogram`, { method: 'POST', body: JSON.stringify({ tooth: '26', condition_id: carie.id }) }, admin!)).status === 404);
    check('detalhe de dente inválido → 400', (await api(`${O}/patients/${paciente}/odontogram/99`, {}, admin!)).status === 400);

    // Situação desativada não pode ser usada.
    const outra = await unwrap<Condition>(await api(`${O}/tooth-conditions`, {
      method: 'POST', body: JSON.stringify({ code: 'teste_inativo', name: 'Situação de teste' }),
    }, admin!));
    await api(`${O}/tooth-conditions/${outra.id}`, { method: 'PUT', body: JSON.stringify({ active: false }) }, admin!);
    check('situação desativada não pode ser registrada',
      (await registrar({ tooth: '27', condition_id: outra.id })).status === 400);

    // ── Exclusão de situação: em uso desativa, sem uso apaga ───────────────
    const apagarEmUso = await api(`${O}/tooth-conditions/${carie.id}`, { method: 'DELETE' }, admin!);
    const resultadoEmUso = await unwrap<{ desativada: boolean }>(apagarEmUso);
    check('situação em uso é desativada (não apagada)', resultadoEmUso.desativada === true, JSON.stringify(resultadoEmUso));
    const aindaNaLista = await unwrap<Condition[]>(await api(`${O}/tooth-conditions?active=false`, {}, admin!));
    check('situação em uso continua no catálogo, inativa',
      aindaNaLista.some((c) => c.code === 'carie' && !c.active));

    const apagarSemUso = await api(`${O}/tooth-conditions/${outra.id}`, { method: 'DELETE' }, admin!);
    check('situação sem uso é apagada', (await unwrap<{ desativada: boolean }>(apagarSemUso)).desativada === false);
    const depoisDeApagar = await unwrap<Condition[]>(await api(`${O}/tooth-conditions?active=false`, {}, admin!));
    check('situação sem uso sai do catálogo', !depoisDeApagar.some((c) => c.code === 'teste_inativo'));

    // ── Permissões ─────────────────────────────────────────────────────────
    const roleSemClinica = await unwrap<{ id: number; slug: string }>(
      await api('/api/roles', { method: 'POST', body: JSON.stringify({ name: 'Recepção Odontograma' }) }, admin!),
    );
    await api(`/api/roles/${roleSemClinica.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions: ['odonto.patients.view'] }),
    }, admin!);
    await api('/api/users', {
      method: 'POST', body: JSON.stringify({ username: 'recepcao_od', name: 'Recepção', password: 'Teste1234', roleSlug: roleSemClinica.slug }),
    }, admin!);
    const recepcao = await loginAs('recepcao_od', 'Teste1234');
    check('login da recepção', recepcao !== null);
    check('sem permissão clínica não vê o odontograma (403)',
      (await api(`${O}/patients/${paciente}/odontogram`, {}, recepcao!)).status === 403);
    check('sem permissão clínica não registra (403)',
      (await api(`${O}/patients/${paciente}/odontogram`, {
        method: 'POST', body: JSON.stringify({ tooth: '26', condition_id: restaurado.id }),
      }, recepcao!)).status === 403);
    check('sem permissão clínica não cria situação (403)',
      (await api(`${O}/tooth-conditions`, {
        method: 'POST', body: JSON.stringify({ code: 'x_recepcao', name: 'X' }),
      }, recepcao!)).status === 403);

    // ── Auditoria ──────────────────────────────────────────────────────────
    const logs = db.prepare(
      "SELECT action, after_json FROM audit_logs WHERE entity = 'odonto_tooth_state' ORDER BY id",
    ).all() as { action: string; after_json: string | null }[];
    check('auditoria registrou os estados', logs.length >= 4, `${logs.length} registro(s)`);
    check('auditoria diz dente, face e situação',
      (logs[0]?.after_json ?? '').includes('"tooth":"26"') && (logs[0]?.after_json ?? '').includes('"situacao":"carie"'),
      String(logs[0]?.after_json).slice(0, 120));
    check('auditoria NÃO copia a observação clínica', !logs.some((l) => (l.after_json ?? '').includes(NOTA)));

    const logsCondicao = db.prepare(
      "SELECT after_json FROM audit_logs WHERE entity = 'odonto_tooth_condition'",
    ).all() as { after_json: string | null }[];
    check('auditoria registrou o catálogo de situações', logsCondicao.length >= 2, `${logsCondicao.length}`);

    // ── Excluir o paciente leva o odontograma junto ────────────────────────
    await api(`${O}/patients/${paciente}`, { method: 'DELETE' }, admin!);
    const restantes = db.prepare(
      'SELECT COUNT(*) AS t FROM odonto_tooth_states WHERE patient_id = ? AND deleted_at IS NULL',
    ).get(paciente) as { t: number };
    check('odontograma do paciente excluído sai por soft delete', restantes.t === 0, `${restantes.t} linha(s)`);

    // ── Módulo fora do plano → API bloqueada ──────────────────────────────
    db.prepare(`UPDATE license SET modules_json = ?, license_key = 'teste', company_uuid = 'teste' WHERE id = 1`)
      .run(JSON.stringify(['commercial', 'finance']));
    check('módulo fora do plano → 403 no odontograma',
      (await api(`${O}/tooth-conditions`, {}, admin!)).status === 403);
    db.prepare(`UPDATE license SET modules_json = NULL, license_key = NULL, company_uuid = NULL WHERE id = 1`).run();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? '\nOdontograma: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
