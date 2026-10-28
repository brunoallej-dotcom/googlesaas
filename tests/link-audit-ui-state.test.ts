import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompanyIdentity } from '../src/lib/link-audit/audit';
import { parseGoogleMapsLink } from '../src/lib/link-audit/maps-link';
import {
  canConfirm,
  canValidate,
  EMPTY_DETAILS,
  initialLinkAuditState,
  linkAuditReducer,
  type LinkAuditAction,
  type LinkAuditUiState,
} from '../src/components/link-audit/state';

/* Links e identificadores FICTÍCIOS. */
const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
const LINK = `https://www.google.com/maps/place/Padaria+Exemplo/data=!1s${FID}`;
const IDENTITY: CompanyIdentity = {
  originalLink: LINK,
  identifiers: { featureId: FID },
  confirmation: { confirmedBy: 'ana@empresa.com', confirmedAt: '2026-10-20T15:00:00.000Z' },
};

const run = (actions: readonly LinkAuditAction[], from: LinkAuditUiState = initialLinkAuditState): LinkAuditUiState =>
  actions.reduce(linkAuditReducer, from);

const validated = (link: string = LINK): LinkAuditUiState =>
  run([
    { type: 'LINK_CHANGED', link },
    { type: 'VALIDATE_START' },
    { type: 'VALIDATE_SUCCESS', requestId: 1, link, result: parseGoogleMapsLink(link) },
  ]);

test('estado inicial: nada digitado, nada validado, nada confirmado', () => {
  assert.equal(initialLinkAuditState.link, '');
  assert.equal(initialLinkAuditState.validation.phase, 'idle');
  assert.equal(initialLinkAuditState.validation.result, null);
  assert.equal(initialLinkAuditState.confirmation.identity, null);
  assert.deepEqual(initialLinkAuditState.details, EMPTY_DETAILS);
  assert.equal(canValidate(initialLinkAuditState), false);
  assert.equal(canConfirm(initialLinkAuditState), false);
});

test('validar: só com texto, uma requisição por vez, e o carregamento é refletido', () => {
  assert.equal(linkAuditReducer(initialLinkAuditState, { type: 'VALIDATE_START' }), initialLinkAuditState, 'sem link não valida');
  assert.equal(canValidate(run([{ type: 'LINK_CHANGED', link: '   ' }])), false, 'só espaços não valida');

  const typed = run([{ type: 'LINK_CHANGED', link: LINK }]);
  assert.equal(canValidate(typed), true);
  const loading = run([{ type: 'VALIDATE_START' }], typed);
  assert.equal(loading.validation.phase, 'loading');
  assert.equal(canValidate(loading), false, 'não valida de novo enquanto carrega');
  assert.equal(linkAuditReducer(loading, { type: 'VALIDATE_START' }), loading);

  const done = run([{ type: 'VALIDATE_SUCCESS', requestId: 1, link: LINK, result: parseGoogleMapsLink(LINK) }], loading);
  assert.equal(done.validation.phase, 'done');
  assert.equal(done.validation.result?.status, 'IDENTIFIED');
});

test('falha de validação guarda a mensagem e não deixa resultado', () => {
  const state = run([
    { type: 'LINK_CHANGED', link: LINK },
    { type: 'VALIDATE_START' },
    { type: 'VALIDATE_FAILURE', requestId: 1, link: LINK, message: 'Não foi possível conectar ao servidor.' },
  ]);
  assert.equal(state.validation.phase, 'error');
  assert.equal(state.validation.error, 'Não foi possível conectar ao servidor.');
  assert.equal(state.validation.result, null);
  assert.equal(canValidate(state), true, 'dá para tentar de novo');
});

test('resposta atrasada de um link antigo é descartada', () => {
  const loading = run([{ type: 'LINK_CHANGED', link: LINK }, { type: 'VALIDATE_START' }]);
  const edited = run([{ type: 'LINK_CHANGED', link: `${LINK}x` }], loading);
  assert.equal(edited.validation.phase, 'idle');
  // a resposta do link anterior chega depois da edição
  const late = run([{ type: 'VALIDATE_SUCCESS', requestId: 1, link: LINK, result: parseGoogleMapsLink(LINK) }], edited);
  assert.equal(late, edited);
  const lateFailure = run([{ type: 'VALIDATE_FAILURE', requestId: 1, link: LINK, message: 'x' }], edited);
  assert.equal(lateFailure, edited);
  // mesmo link, mas a tela já foi limpa
  const reset = run([{ type: 'RESET' }], loading);
  assert.equal(run([{ type: 'VALIDATE_SUCCESS', requestId: 1, link: LINK, result: parseGoogleMapsLink(LINK) }], reset), reset);
});

test('confirmação exige link identificado, caixa marcada e nenhuma requisição em andamento', () => {
  const ok = validated();
  assert.equal(canConfirm(ok), false, 'sem a caixa marcada');
  const acked = run([{ type: 'DETAILS_CHANGED', patch: { acknowledged: true } }], ok);
  assert.equal(canConfirm(acked), true);

  for (const link of [
    'https://maps.app.goo.gl/AbCd1234',
    'https://www.google.com/maps/search/padaria',
    'https://example.com/',
    '',
    'http://www.google.com/maps?cid=1',
    'https://www.google.com/maps?cid=abc',
  ]) {
    const state = run([{ type: 'DETAILS_CHANGED', patch: { acknowledged: true } }], link ? validated(link) : initialLinkAuditState);
    assert.equal(canConfirm(state), false, `não deve confirmar: ${link || '(vazio)'}`);
  }

  const loading = run([{ type: 'CONFIRM_START' }], acked);
  assert.equal(loading.confirmation.phase, 'loading');
  assert.equal(canConfirm(loading), false);
  assert.equal(linkAuditReducer(initialLinkAuditState, { type: 'CONFIRM_START' }), initialLinkAuditState, 'sem pré-requisitos nada acontece');
});

test('confirmar: guarda a identidade só em memória e trava a edição dos dados', () => {
  const acked = run([{ type: 'DETAILS_CHANGED', patch: { acknowledged: true, name: 'Padaria Exemplo' } }], validated());
  const confirmed = run([{ type: 'CONFIRM_START' }, { type: 'CONFIRM_SUCCESS', requestId: 2, link: LINK, identity: IDENTITY }], acked);
  assert.equal(confirmed.confirmation.phase, 'done');
  assert.deepEqual(confirmed.confirmation.identity, IDENTITY);
  assert.equal(canConfirm(confirmed), false, 'não confirma duas vezes');
  const edited = linkAuditReducer(confirmed, { type: 'DETAILS_CHANGED', patch: { name: 'Outro nome' } });
  assert.equal(edited, confirmed, 'dados não mudam depois de confirmados');
});

test('falha na confirmação não deixa identidade confirmada', () => {
  const acked = run([{ type: 'DETAILS_CHANGED', patch: { acknowledged: true } }], validated());
  const failed = run(
    [{ type: 'CONFIRM_START' }, { type: 'CONFIRM_FAILURE', requestId: 2, link: LINK, message: 'Este link não identifica uma empresa.' }],
    acked,
  );
  assert.equal(failed.confirmation.phase, 'error');
  assert.equal(failed.confirmation.identity, null);
  assert.equal(failed.confirmation.error, 'Este link não identifica uma empresa.');
  assert.equal(canConfirm(failed), true, 'pode tentar de novo');
});

test('limpeza: mudar o link, desfazer e limpar tudo descartam o que deve ser descartado', () => {
  const confirmed = run(
    [
      { type: 'DETAILS_CHANGED', patch: { acknowledged: true, name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' } },
      { type: 'CONFIRM_START' },
      { type: 'CONFIRM_SUCCESS', requestId: 2, link: LINK, identity: IDENTITY },
    ],
    validated(),
  );

  // mudar o link: resultado, dados digitados e confirmação somem; o texto novo fica
  const changed = linkAuditReducer(confirmed, { type: 'LINK_CHANGED', link: 'https://www.google.com/maps?cid=1' });
  assert.equal(changed.link, 'https://www.google.com/maps?cid=1');
  assert.equal(changed.validation.result, null);
  assert.equal(changed.validation.phase, 'idle');
  assert.deepEqual(changed.details, EMPTY_DETAILS);
  assert.equal(changed.confirmation.identity, null);

  // desfazer: some a confirmação e a caixa é desmarcada; o resultado e o link ficam
  const undone = linkAuditReducer(confirmed, { type: 'CONFIRMATION_UNDONE' });
  assert.equal(undone.confirmation.identity, null);
  assert.equal(undone.confirmation.phase, 'idle');
  assert.equal(undone.details.acknowledged, false);
  assert.equal(undone.link, LINK);
  assert.equal(undone.validation.result?.status, 'IDENTIFIED');
  assert.equal(canConfirm(undone), false, 'precisa marcar a caixa de novo');

  // limpar tudo: volta ao estado inicial
  assert.deepEqual(linkAuditReducer(confirmed, { type: 'RESET' }), { ...initialLinkAuditState, requestId: confirmed.requestId }, 'volta ao inicial, mantendo só o contador de pedidos');

  // validar de novo descarta confirmação e dados anteriores
  const revalidated = linkAuditReducer(confirmed, { type: 'VALIDATE_START' });
  assert.equal(revalidated.confirmation.identity, null);
  assert.deepEqual(revalidated.details, EMPTY_DETAILS);
});

test('o reducer é puro: não altera o estado recebido e não depende de relógio ou rede', () => {
  const before = validated();
  const snapshot = JSON.stringify(before);
  linkAuditReducer(before, { type: 'DETAILS_CHANGED', patch: { name: 'x' } });
  linkAuditReducer(before, { type: 'RESET' });
  assert.equal(JSON.stringify(before), snapshot);
});

test('corrida: resposta antiga do MESMO link não sobrescreve o pedido mais novo (validar)', () => {
  const first = run([{ type: 'LINK_CHANGED', link: LINK }, { type: 'VALIDATE_START' }]); // pedido 1 em andamento
  assert.equal(first.requestId, 1);
  // o operador troca o link e volta ao mesmo texto; um novo pedido (2) é iniciado
  const second = run(
    [{ type: 'LINK_CHANGED', link: 'https://www.google.com/maps?cid=1' }, { type: 'LINK_CHANGED', link: LINK }, { type: 'VALIDATE_START' }],
    first,
  );
  assert.equal(second.requestId, 2, 'o contador nunca volta atrás, nem ao mudar o link');
  const late = run([{ type: 'VALIDATE_SUCCESS', requestId: 1, link: LINK, result: parseGoogleMapsLink('https://www.google.com/maps?cid=7') }], second);
  assert.equal(late, second, 'a resposta do pedido 1 é ignorada');
  const current = run([{ type: 'VALIDATE_SUCCESS', requestId: 2, link: LINK, result: parseGoogleMapsLink(LINK) }], second);
  assert.equal(current.validation.phase, 'done');
  assert.equal(current.validation.result?.status, 'IDENTIFIED');
  const lateFailure = run([{ type: 'VALIDATE_FAILURE', requestId: 1, link: LINK, message: 'x' }], second);
  assert.equal(lateFailure, second);
});

test('corrida: confirmação antiga não aparece depois de desfazer e confirmar de novo com outros dados', () => {
  const ready = run([{ type: 'DETAILS_CHANGED', patch: { acknowledged: true, name: 'X' } }], validated());
  const firstConfirm = run([{ type: 'CONFIRM_START' }], ready); // pedido 2 com o nome X
  assert.equal(firstConfirm.requestId, 2);
  const undone = run([{ type: 'CONFIRMATION_UNDONE' }, { type: 'DETAILS_CHANGED', patch: { acknowledged: true, name: 'Y' } }], firstConfirm);
  const secondConfirm = run([{ type: 'CONFIRM_START' }], undone); // pedido 3 com o nome Y
  assert.equal(secondConfirm.requestId, 3);

  const lateIdentity: CompanyIdentity = { ...IDENTITY, name: 'X' };
  const ignored = run([{ type: 'CONFIRM_SUCCESS', requestId: 2, link: LINK, identity: lateIdentity }], secondConfirm);
  assert.equal(ignored, secondConfirm, 'a resposta do primeiro pedido (nome X) é descartada');
  const accepted = run([{ type: 'CONFIRM_SUCCESS', requestId: 3, link: LINK, identity: { ...IDENTITY, name: 'Y' } }], secondConfirm);
  assert.equal(accepted.confirmation.identity?.name, 'Y');

  // resposta tardia depois de desfazer, sem novo pedido: também ignorada
  const afterUndo = run([{ type: 'CONFIRMATION_UNDONE' }], firstConfirm);
  assert.equal(run([{ type: 'CONFIRM_SUCCESS', requestId: 2, link: LINK, identity: lateIdentity }], afterUndo), afterUndo);
  assert.equal(run([{ type: 'CONFIRM_FAILURE', requestId: 2, link: LINK, message: 'x' }], afterUndo), afterUndo);
});

test('RESET também preserva o contador (uma resposta velha nunca se passa por nova)', () => {
  const loading = run([{ type: 'LINK_CHANGED', link: LINK }, { type: 'VALIDATE_START' }]);
  const reset = run([{ type: 'RESET' }], loading);
  assert.equal(reset.requestId, loading.requestId);
  const again = run([{ type: 'LINK_CHANGED', link: LINK }, { type: 'VALIDATE_START' }], reset);
  assert.equal(again.requestId, 2);
  assert.equal(run([{ type: 'VALIDATE_SUCCESS', requestId: 1, link: LINK, result: parseGoogleMapsLink(LINK) }], again), again);
});
