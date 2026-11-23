import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SIGN_KEY_ID_PATTERN } from '../src/lib/link-audit-attestation/sign-chain';
import { CLOSURES_DIR } from '../src/lib/link-audit-attestation/sign-run';
import { MAX_TRUST_KEYS, parseTrustKeyring } from '../src/lib/link-audit-evidence/provenance';
import { REHEARSAL_KEY_PREFIX } from '../src/lib/link-audit-evidence/simulated';
import { CHANNEL_CLOSURES_DIR, CHANNEL_KEY_ID_PATTERN } from '../src/lib/link-audit-seals-channel/paths';
import { summaryLines } from '../src/lib/link-audit-seals-channel/summary';
import { MAX_TRUST_LIST_BYTES, parseTrustListFile, trustListEnvironmentViolations, trustListTransition, type TrustListItem } from '../src/lib/link-audit-seals-channel/trust-list';
import { registerCleanup } from './helpers/link-audit-evidence-fixtures';
import { signer, type TestSigner } from './helpers/link-audit-seal-close-key-fixtures';
import { ABSENT, AUD_A, AUD_B, baseBytes, canonicalText, chainInRepo, check, closureFor, closureRepoPath, codes, listFile, listItem, sealRepoPath, nextSeal, world, writeRepoFile, writeTrustList, type World } from './helpers/link-audit-seals-fixtures';

/*
 * P9.2 — a lista de confiança versionada `link-audit-seals/<amb>/trust-keys.txt` (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.3 e
 * S-12/S-13 do §5.4): parser do arquivo, regra de ambiente, regras de transição a partir do commit-base e prova das fixações. Chaves de TESTE
 * geradas em memória; checkout fictício em pasta temporária; nenhum git nem rede.
 */
registerCleanup();

const LIST = 'link-audit-seals/producao/trust-keys.txt';
const HML_LIST = 'link-audit-seals/homologacao/trust-keys.txt';
const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);

const KEY_A = signer('ek-lista-a');
const KEY_B = signer('ek-lista-b');
const KEY_C = signer('ek-lista-c');
const KEY_R = signer('ek-lista-aposentar');
const KEY_S = signer('ek-lista-sucessor');
const KEY_X = signer('ek-lista-fora');

const itemOf = (key: TestSigner, status: TrustListItem['status'] = 'active', closureSha256: string | null = null): TrustListItem => ({ id: key.keyId, publicRaw: key.publicRaw, status, closureSha256 });

/* ------------------------------------------------------------------------------------------------------------------- P9-T01 formato */

test('P9-T01 arquivo fora da gramática, com linha vazia, espaço, CRLF, sem \\n final, comentário, vírgula, mais de 16 itens, mais de 2 active, id ou chave repetidos ⇒ fora do formato; arquivo vazio ⇒ aceito (política fechada)', () => {
  const many = Array.from({ length: MAX_TRUST_KEYS + 1 }, (_, index) => listItem(signer(`ek-lista-n${String(index).padStart(2, '0')}`), 'retired'));
  const twin = { ...KEY_B, keyId: KEY_A.keyId };
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['fora da gramática', 'nao-e-um-item\n', 'ITEM_GRAMMAR'],
    ['estado desconhecido', `${listItem(KEY_A, 'Active')}\n`, 'ITEM_GRAMMAR'],
    ['hash fixado fora de retired', `${listItem(KEY_A, `active:${HASH_1}`)}\n`, 'ITEM_GRAMMAR'],
    ['linha vazia', `${listItem(KEY_A)}\n\n${listItem(KEY_B)}\n`, 'EMPTY_LINE'],
    ['espaço', `${listItem(KEY_A)} \n`, 'NOT_VISIBLE_ASCII'],
    ['CRLF', `${listItem(KEY_A)}\r\n`, 'NOT_VISIBLE_ASCII'],
    ['sem \\n final', listItem(KEY_A), 'NO_FINAL_NEWLINE'],
    ['comentário', `#chaves\n${listItem(KEY_A)}\n`, 'ITEM_GRAMMAR'],
    ['comentário com espaço', `# chaves\n${listItem(KEY_A)}\n`, 'NOT_VISIBLE_ASCII'],
    ['dois itens numa linha (vírgula)', `${listItem(KEY_A)},${listItem(KEY_B)}\n`, 'ITEM_GRAMMAR'],
    ['mais de 16 itens', listFile(many), 'TOO_MANY_ITEMS'],
    ['mais de 2 active', listFile([listItem(KEY_A), listItem(KEY_B), listItem(KEY_C)]), 'KEYRING_REFUSED'],
    ['id repetido', listFile([listItem(KEY_A), listItem(twin, 'retired')]), 'KEYRING_REFUSED'],
    ['chave repetida sob dois ids', listFile([listItem(KEY_A), listItem({ ...KEY_A, keyId: 'ek-lista-copia' }, 'retired')]), 'KEYRING_REFUSED'],
  ];
  for (const [label, text, issue] of cases) assert.deepEqual(parseTrustListFile(bytes(text)), { ok: false, issue }, label);
  assert.deepEqual(parseTrustListFile(new Uint8Array(MAX_TRUST_LIST_BYTES + 1).fill(0x61)), { ok: false, issue: 'TOO_LARGE' });
  assert.deepEqual(parseTrustListFile(new Uint8Array(0)), { ok: true, items: [], value: '' }, 'vazio = política fechada');
});

test('P9-T01 pelo job: lista alterada fora do formato ⇒ TRUST_LIST_FORMAT (com o motivo fixo, nunca o conteúdo); arquivo vazio passa', async () => {
  const w = world();
  writeRepoFile(w.root, LIST, `${listItem(KEY_A)} \n`);
  const refused = await check(w, [['M', LIST]], { baseTrust: { producao: ABSENT } });
  assert.deepEqual(refused.refusals, [{ rule: 'S-12', code: 'TRUST_LIST_FORMAT', path: 'producao/trust-keys.txt', detail: 'NOT_VISIBLE_ASCII' }]);
  assert.ok(!summaryLines(refused).join('\n').includes(KEY_A.publicRaw), 'o resumo não leva o conteúdo da lista');
  const empty = world();
  assert.deepEqual(codes(await check(empty, [['A', LIST]], { baseTrust: { producao: ABSENT } })), []);
});

/* ------------------------------------------------------------------------------------------------------------------- P9-T02 ambiente */

test('P9-T02 `ensaio-` em produção, ou id sem `ensaio-` em homologação ⇒ TRUST_LIST_ENV_PREFIX; cada ambiente com a sua regra passa', async () => {
  const rehearsal = signer(`${REHEARSAL_KEY_PREFIX}lista-01`);
  assert.deepEqual(trustListEnvironmentViolations('producao', [itemOf(KEY_A), itemOf(rehearsal)]), [rehearsal.keyId]);
  assert.deepEqual(trustListEnvironmentViolations('homologacao', [itemOf(KEY_A), itemOf(rehearsal)]), [KEY_A.keyId]);
  assert.deepEqual(trustListEnvironmentViolations('homologacao', [itemOf(rehearsal)]), []);
  assert.deepEqual(trustListEnvironmentViolations('producao', [itemOf(KEY_A)]), []);
  const w = world();
  writeTrustList(w, [listItem(rehearsal)]);
  writeTrustList(w, [listItem(KEY_A)], 'homologacao');
  const report = await check(w, [['M', LIST], ['M', HML_LIST]], { baseTrust: { producao: ABSENT, homologacao: ABSENT } });
  assert.deepEqual(report.refusals.map((item) => [item.code, item.path, item.detail]), [
    ['TRUST_LIST_ENV_PREFIX', 'homologacao/trust-keys.txt', KEY_A.keyId],
    ['TRUST_LIST_ENV_PREFIX', 'producao/trust-keys.txt', rehearsal.keyId],
  ]);
  const ok = world();
  writeTrustList(ok, [listItem(rehearsal)], 'homologacao');
  writeTrustList(ok, [listItem(KEY_A)]);
  assert.deepEqual(codes(await check(ok, [['M', LIST], ['M', HML_LIST]], { baseTrust: { producao: ABSENT, homologacao: ABSENT } })), []);
});

/* ------------------------------------------------------------------------------------------------------------------- P9-T03 transições */

test('P9-T03 cada transição proibida do §5.3 ⇒ violação com motivo fixo (revoked → outro, retired → active, hash trocado ou tirado, chave ou id trocados, item removido, voltar à lista vazia)', () => {
  const forbidden: ReadonlyArray<readonly [string, readonly TrustListItem[], readonly TrustListItem[], string]> = [
    ['revoked → active', [itemOf(KEY_A, 'revoked')], [itemOf(KEY_A)], 'REVOKED_CHANGED'],
    ['revoked → retired', [itemOf(KEY_A, 'revoked')], [itemOf(KEY_A, 'retired')], 'REVOKED_CHANGED'],
    ['revoked → retired:<h>', [itemOf(KEY_A, 'revoked')], [itemOf(KEY_A, 'retired', HASH_1)], 'REVOKED_CHANGED'],
    ['retired → active', [itemOf(KEY_A, 'retired')], [itemOf(KEY_A)], 'RETIRED_REACTIVATED'],
    ['retired:<h> → active', [itemOf(KEY_A, 'retired', HASH_1)], [itemOf(KEY_A)], 'RETIRED_REACTIVATED'],
    ['tirar o hash fixado', [itemOf(KEY_A, 'retired', HASH_1)], [itemOf(KEY_A, 'retired')], 'PIN_REMOVED'],
    ['trocar o hash fixado', [itemOf(KEY_A, 'retired', HASH_1)], [itemOf(KEY_A, 'retired', HASH_2)], 'PIN_CHANGED'],
    ['trocar a pública de um id', [itemOf(KEY_A)], [{ ...itemOf(KEY_A), publicRaw: KEY_B.publicRaw }], 'PUBLIC_KEY_CHANGED'],
    ['remover um item', [itemOf(KEY_A), itemOf(KEY_B, 'retired')], [itemOf(KEY_A)], 'ITEM_REMOVED'],
    ['voltar à lista vazia', [itemOf(KEY_A)], [], 'ITEM_REMOVED'],
  ];
  for (const [label, previous, next, reason] of forbidden) {
    const transition = trustListTransition(previous, next);
    assert.equal(transition.ok, false, label);
    assert.deepEqual(transition.violations.map((item) => item.reason), [reason], label);
  }
  const renamed = trustListTransition([itemOf(KEY_A)], [itemOf(KEY_A), { ...itemOf(KEY_A), id: 'ek-lista-outro-id' }]);
  assert.deepEqual(renamed.violations, [{ keyId: 'ek-lista-outro-id', reason: 'KEY_ID_CHANGED' }], 'a mesma pública sob outro id');
  const moved = trustListTransition([itemOf(KEY_A)], [{ ...itemOf(KEY_A), id: 'ek-lista-outro-id' }]);
  assert.deepEqual(moved.violations.map((item) => item.reason).sort(), ['ITEM_REMOVED', 'KEY_ID_CHANGED']);
});

test('P9-T03 cada transição permitida passa: item novo active ou retired, qualquer → revoked, active → retired, active/retired → retired:<h> (fixação a provar), lista igual; primeira instalação é livre', () => {
  const allowed: ReadonlyArray<readonly [string, readonly TrustListItem[], readonly TrustListItem[]]> = [
    ['item novo active', [itemOf(KEY_A)], [itemOf(KEY_A), itemOf(KEY_B)]],
    ['item novo retired', [itemOf(KEY_A)], [itemOf(KEY_A), itemOf(KEY_B, 'retired')]],
    ['item novo revoked', [itemOf(KEY_A)], [itemOf(KEY_A), itemOf(KEY_B, 'revoked')]],
    ['active → revoked', [itemOf(KEY_A)], [itemOf(KEY_A, 'revoked')]],
    ['retired → revoked', [itemOf(KEY_A, 'retired')], [itemOf(KEY_A, 'revoked')]],
    ['retired:<h> → revoked', [itemOf(KEY_A, 'retired', HASH_1)], [itemOf(KEY_A, 'revoked')]],
    ['active → retired', [itemOf(KEY_A)], [itemOf(KEY_A, 'retired')]],
    ['active → retired:<h>', [itemOf(KEY_A)], [itemOf(KEY_A, 'retired', HASH_1)]],
    ['retired → retired:<h>', [itemOf(KEY_A, 'retired')], [itemOf(KEY_A, 'retired', HASH_1)]],
    ['lista igual', [itemOf(KEY_A), itemOf(KEY_B, 'retired', HASH_1), itemOf(KEY_C, 'revoked')], [itemOf(KEY_A), itemOf(KEY_B, 'retired', HASH_1), itemOf(KEY_C, 'revoked')]],
    ['primeira instalação', [], [itemOf(KEY_A), itemOf(KEY_B, 'retired', HASH_1)]],
    ['ordem diferente', [itemOf(KEY_A), itemOf(KEY_B)], [itemOf(KEY_B), itemOf(KEY_A)]],
  ];
  for (const [label, previous, next] of allowed) assert.deepEqual(trustListTransition(previous, next).violations, [], label);
  assert.deepEqual(trustListTransition([itemOf(KEY_A)], [itemOf(KEY_A, 'retired', HASH_1)]).newPins, [{ keyId: KEY_A.keyId, closureSha256: HASH_1 }], 'a fixação nova vai para quem pode prová-la (o CI)');
  assert.deepEqual(trustListTransition([itemOf(KEY_A, 'retired', HASH_1)], [itemOf(KEY_A, 'retired', HASH_1)]).newPins, [], 'fixação já existente não se prova de novo');
});

test('P9-T03 pelo job: transição proibida ⇒ TRUST_LIST_TRANSITION com `<id> <MOTIVO>`; apagar o arquivo ⇒ TRUST_LIST_DELETED; permitida passa', async () => {
  const w = world();
  writeTrustList(w, [listItem(KEY_A)]);
  const previous = listFile([listItem(KEY_A, 'revoked'), listItem(KEY_B)]);
  const report = await check(w, [['M', LIST]], { baseTrust: { producao: baseBytes(previous) } });
  assert.deepEqual(report.refusals.map((item) => [item.code, item.detail]), [
    ['TRUST_LIST_TRANSITION', `${KEY_A.keyId} REVOKED_CHANGED`],
    ['TRUST_LIST_TRANSITION', `${KEY_B.keyId} ITEM_REMOVED`],
  ]);
  const deleted = world();
  fs.rmSync(path.join(deleted.root, ...LIST.split('/')));
  assert.deepEqual(codes(await check(deleted, [['D', LIST]], { baseTrust: { producao: baseBytes(listFile([listItem(KEY_A)])) } })), ['TRUST_LIST_DELETED']);
  const allowed = world();
  writeTrustList(allowed, [listItem(KEY_A, 'revoked'), listItem(KEY_B)]);
  assert.deepEqual(codes(await check(allowed, [['M', LIST]], { baseTrust: { producao: baseBytes(listFile([listItem(KEY_A)])) } })), []);
  const unreadable = world();
  writeTrustList(unreadable, [listItem(KEY_A)]);
  assert.deepEqual(codes(await check(unreadable, [['M', LIST]], { baseTrust: { producao: { kind: 'unreadable' } } })), ['TRUST_LIST_TRANSITION'], 'lista do commit-base ilegível ⇒ falha fechada');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-T04 / P9-T07 fixação */

interface PinWorld {
  readonly w: World;
  readonly closureText: string;
  readonly before: string;
}

/** Commit-base: R e S ativas, cadeia de A assinada por R e o fecho `_closures/R.json` (por S, cobrindo a cabeça) já mergeado. */
function pinWorld(retiredState = ''): PinWorld {
  const w = world();
  const before = listFile([listItem(KEY_R, retiredState), listItem(KEY_S)]);
  writeRepoFile(w.root, LIST, before);
  const chain = chainInRepo(w, AUD_A, [KEY_R]);
  const closureText = canonicalText(closureFor(KEY_R, KEY_S, chain));
  writeRepoFile(w.root, closureRepoPath(KEY_R.keyId), closureText);
  return { w, closureText, before };
}

const pinTo = (pin: PinWorld, closureSha256: string): void => {
  writeRepoFile(pin.w.root, LIST, listFile([listItem(KEY_R, `retired:${closureSha256}`), listItem(KEY_S)]));
};

test('P9-T07 `active → retired:<sha256>` com o fecho no commit-base, de sha256 igual e válido no S-11 ⇒ aceito, e a cadeia coberta autentica sob a lista nova (informação)', async () => {
  const pin = pinWorld();
  pinTo(pin, sha256(pin.closureText));
  const report = await check(pin.w, [['M', LIST]], { baseTrust: { producao: baseBytes(pin.before) } });
  assert.deepEqual(report.refusals, []);
  assert.deepEqual(report.chains, [{ env: 'producao', auditId: AUD_A, verdict: 'AUTHENTICATED', headSeq: 1 }]);
  const fromRetired = pinWorld('retired');
  pinTo(fromRetired, sha256(fromRetired.closureText));
  assert.deepEqual(codes(await check(fromRetired.w, [['M', LIST]], { baseTrust: { producao: baseBytes(fromRetired.before) } })), [], '`retired → retired:<sha256>` também');
});

test('P9-T07 (revisão do PR #72, item 4) o fecho HISTÓRICO de uma fixação segue a regra de antes: com o signatário aposentado na mesma mudança, a fixação ainda se prova (o `active` só vale para fecho novo)', async () => {
  const pin = pinWorld();
  writeRepoFile(pin.w.root, LIST, listFile([listItem(KEY_R, `retired:${sha256(pin.closureText)}`), listItem(KEY_S, 'retired')]));
  assert.deepEqual(codes(await check(pin.w, [['M', LIST]], { baseTrust: { producao: baseBytes(pin.before) } })), []);
});

test('P9-T07 `active → retired` sem hash ⇒ aceito, e o resumo avisa que as posições da chave deixam de autenticar até a fixação', async () => {
  const pin = pinWorld();
  writeRepoFile(pin.w.root, LIST, listFile([listItem(KEY_R, 'retired'), listItem(KEY_S)]));
  const report = await check(pin.w, [['M', LIST]], { baseTrust: { producao: baseBytes(pin.before) } });
  assert.deepEqual(report.refusals, []);
  assert.deepEqual(report.trustLists[0]?.notices, [{ keyId: KEY_R.keyId, notice: 'RETIRED_WITHOUT_PIN' }]);
  const text = summaryLines(report).join('\n');
  assert.match(text, new RegExp(`\`${KEY_R.keyId}\`: aposentada sem hash fixado: as posições desta chave deixam de autenticar até a fixação`));
  assert.deepEqual(report.chains.map((item) => item.verdict), ['SEAL_KEY_RETIRED_UNCOVERED'], 'a informação mostra a cadeia descoberta sob a lista nova');
});

test('P9-T04 fixar `retired:<hash>` (de active ou de retired) sem o fecho no commit-base, com outro hash, com fecho que não passa no S-11 ou acrescentado na mesma mudança ⇒ TRUST_LIST_TRANSITION PIN_UNPROVEN', async () => {
  for (const state of ['', 'retired']) {
    const missing = pinWorld(state);
    fs.rmSync(path.join(missing.w.root, ...closureRepoPath(KEY_R.keyId).split('/')));
    pinTo(missing, sha256(missing.closureText));
    const noClosure = await check(missing.w, [['M', LIST]], { baseTrust: { producao: baseBytes(missing.before) } });
    assert.deepEqual(noClosure.refusals.map((item) => item.detail), [`${KEY_R.keyId} PIN_UNPROVEN`], `sem fecho (${state || 'active'})`);

    const otherHash = pinWorld(state);
    pinTo(otherHash, HASH_1);
    assert.deepEqual((await check(otherHash.w, [['M', LIST]], { baseTrust: { producao: baseBytes(otherHash.before) } })).refusals.map((item) => item.detail), [`${KEY_R.keyId} PIN_UNPROVEN`], `outro hash (${state || 'active'})`);

    // fecho com cabeça que não está na cadeia do repositório (S-11: HEAD_NOT_IN_REPO), assinado por S e com o hash certo
    const badHead = pinWorld(state);
    const phantom = nextSeal(AUD_B, [], { signer: KEY_R });
    const badText = canonicalText(closureFor(KEY_R, KEY_S, [phantom]));
    writeRepoFile(badHead.w.root, closureRepoPath(KEY_R.keyId), badText);
    pinTo(badHead, sha256(badText));
    assert.deepEqual((await check(badHead.w, [['M', LIST]], { baseTrust: { producao: baseBytes(badHead.before) } })).refusals.map((item) => item.detail), [`${KEY_R.keyId} PIN_UNPROVEN`], `fecho fora do S-11 (${state || 'active'})`);

    // fecho assinado por uma chave fora da lista nova (S-11: SIGNER_NOT_LISTED)
    const outsider = pinWorld(state);
    const outsiderText = canonicalText(closureFor(KEY_R, KEY_X, chainInRepo(world(), AUD_A, [KEY_R])));
    writeRepoFile(outsider.w.root, closureRepoPath(KEY_R.keyId), outsiderText);
    pinTo(outsider, sha256(outsiderText));
    assert.deepEqual((await check(outsider.w, [['M', LIST]], { baseTrust: { producao: baseBytes(outsider.before) } })).refusals.map((item) => item.detail), [`${KEY_R.keyId} PIN_UNPROVEN`], `signatário fora da lista (${state || 'active'})`);
  }
  const sameChange = pinWorld();
  pinTo(sameChange, sha256(sameChange.closureText));
  const together = await check(sameChange.w, [['A', closureRepoPath(KEY_R.keyId)], ['M', LIST]], { baseTrust: { producao: baseBytes(sameChange.before) } });
  assert.ok(together.refusals.some((item) => item.detail === `${KEY_R.keyId} PIN_UNPROVEN`), 'o fecho do mesmo PR não está no commit-base');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-T05 */

test('P9-T05 lista e manifestos (ou um fecho) do MESMO ambiente no mesmo PR ⇒ SEALS_AND_TRUST_LIST_TOGETHER; ambientes diferentes não', async () => {
  const w = world();
  writeTrustList(w, [listItem(KEY_A)]);
  const seal = nextSeal(AUD_A, [], { signer: KEY_A });
  writeRepoFile(w.root, sealRepoPath(AUD_A, 1), canonicalText(seal));
  const report = await check(w, [['M', LIST], ['A', sealRepoPath(AUD_A, 1)]], { baseTrust: { producao: ABSENT } });
  assert.deepEqual(report.refusals.map((item) => [item.rule, item.code, item.path]), [['S-13', 'SEALS_AND_TRUST_LIST_TOGETHER', 'producao/trust-keys.txt']]);
  // um FECHO novo e válido também é "manifesto" para o S-13 (arquivo novo sob `<amb>/seals/`)
  const withClosure = world();
  writeTrustList(withClosure, [listItem(KEY_R), listItem(KEY_S)]);
  const chain = chainInRepo(withClosure, AUD_A, [KEY_R]);
  writeRepoFile(withClosure.root, closureRepoPath(KEY_R.keyId), canonicalText(closureFor(KEY_R, KEY_S, chain)));
  const closureAndList = await check(withClosure, [['M', LIST], ['A', closureRepoPath(KEY_R.keyId)]], { baseTrust: { producao: baseBytes(listFile([listItem(KEY_R)])) } });
  assert.deepEqual(closureAndList.refusals.map((item) => [item.rule, item.code, item.path]), [['S-13', 'SEALS_AND_TRUST_LIST_TOGETHER', 'producao/trust-keys.txt']], 'fecho válido + lista no mesmo ambiente');
  const apart = world();
  const rehearsal = signer(`${REHEARSAL_KEY_PREFIX}lista-02`);
  writeTrustList(apart, [listItem(KEY_A)]);
  writeTrustList(apart, [listItem(rehearsal)], 'homologacao');
  writeRepoFile(apart.root, sealRepoPath(AUD_A, 1), canonicalText(seal));
  // a lista de homologação muda; o manifesto é de produção (lista de produção inalterada, base = a do commit)
  const ok = await check(apart, [['M', HML_LIST], ['A', sealRepoPath(AUD_A, 1)]], { baseTrust: { homologacao: ABSENT } });
  assert.deepEqual(codes(ok), []);
});

/* ------------------------------------------------------------------------------------------------------------------- P9-T06 */

test('P9-T06 a junção das linhas por `,` é exatamente o que `parseTrustKeyring` aceita (mesmos ids, estados e hashes), e uma linha com dois itens é recusada mesmo que a junção fosse aceita', () => {
  const text = listFile([listItem(KEY_A), listItem(KEY_B, 'active'), listItem(KEY_C, 'revoked'), listItem(KEY_R, `retired:${HASH_1}`), listItem(KEY_S, 'retired')]);
  const parsed = parseTrustListFile(bytes(text));
  assert.ok(parsed.ok);
  assert.equal(parsed.value, text.trimEnd().split('\n').join(','));
  const ring = parseTrustKeyring(parsed.value);
  assert.ok(ring, 'parseTrustKeyring aceita a junção');
  assert.deepEqual(parsed.items.map((item) => [item.id, item.status, item.closureSha256]), [...ring.entries()].map(([id, entry]) => [id, entry.status, entry.closureSha256]));
  const joinedOnOneLine = `${listItem(KEY_A)},${listItem(KEY_B)}`;
  assert.ok(parseTrustKeyring(joinedOnOneLine), 'a junção em si seria aceita…');
  assert.equal(parseTrustListFile(bytes(`${joinedOnOneLine}\n`)).ok, false, '…mas o arquivo tem um item por linha');
});

test('P9-T06 (estático) o servidor continua lendo a lista pela variável: `scoring/shared.ts` sem `trust-keys.txt` nem `link-audit-seals`, e o `stack.yml` mantém a interpolação', () => {
  const root = path.join(__dirname, '..');
  const shared = fs.readFileSync(path.join(root, 'src', 'app', 'api', 'link-audit', 'scoring', 'shared.ts'), 'utf8');
  assert.ok(shared.includes('const trustKeys = trustKeysForServer(process.env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS, homologation);'));
  assert.ok(!/trust-keys\.txt|link-audit-seals/.test(shared), 'o servidor não lê o arquivo versionado');
  assert.ok(fs.readFileSync(path.join(root, 'deploy', 'hostinger', 'stack.yml'), 'utf8').includes('GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS: ${GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS:-}'));
});

/* ------------------------------------------------------------------------------------------------------------------- paridades */

test('paridade: o padrão de id do canal é o do verificador (`SIGN_KEY_ID_PATTERN`, aceito por `parseTrustKeyring`) e a pasta de fechos é o `CLOSURES_DIR` do `sign`', () => {
  assert.equal(CHANNEL_KEY_ID_PATTERN.source, SIGN_KEY_ID_PATTERN.source);
  assert.equal(CHANNEL_CLOSURES_DIR, CLOSURES_DIR);
  for (const id of ['ek-a', 'abcd', 'a'.repeat(32), 'ek-lista-a', '0abc']) assert.ok(parseTrustKeyring(`${id}:${KEY_A.publicRaw}`) && CHANNEL_KEY_ID_PATTERN.test(id), id);
  for (const id of ['abc', 'a'.repeat(33), '-abc', 'Abcd', 'ab_c', 'ab.c']) assert.ok(!parseTrustKeyring(`${id}:${KEY_A.publicRaw}`) && !CHANNEL_KEY_ID_PATTERN.test(id), id);
});
