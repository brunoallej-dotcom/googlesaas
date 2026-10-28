import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * A mesma empresa vira um lead NOVO a cada campanha. A proteção contra auditoria duplicada (49
 * consultas pagas) precisa casar por `place_id`, não por `lead_id`.
 */
test('listAuditsForLeadKeyword consulta por place_id e filtra a palavra-chave normalizada', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake-ref.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-de-teste-0123456789';
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify([
        { id: 'a-concluida', status: 'COMPLETED', target_keyword: '  Clínica  Odontológica ', updated_at: '2026-10-16T01:30:00Z', battlefield_payload: { points: [] } },
        { id: 'a-outra-palavra', status: 'COMPLETED', target_keyword: 'Barbearia', updated_at: '2026-10-16T01:30:00Z', battlefield_payload: null },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
  try {
    const { gmnRepository } = await import('../src/lib/supabase');
    const found = await gmnRepository.listAuditsForLeadKeyword('ChIJjYYImWClXpMRvft2XWMnCPc', 'clínica odontológica');
    assert.match(urls[0] ?? '', /place_id=eq\.ChIJjYYImWClXpMRvft2XWMnCPc/);
    assert.doesNotMatch(urls[0] ?? '', /lead_id=/);
    assert.deepEqual(found.map((a) => a.id), ['a-concluida'], 'só a mesma palavra-chave, ignorando caixa e espaços');
    assert.equal(found[0]?.hasBattlefield, true);

    const { decideEnqueue } = await import('../src/lib/audit-liveness');
    const decision = decideEnqueue(found, true);
    assert.equal(decision.action === 'REUSE' && decision.code, 'ALREADY_COMPLETED');
  } finally {
    globalThis.fetch = original;
  }
});
