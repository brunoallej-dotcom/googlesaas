import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  brazilianPhoneE164,
  isLikelyBrazilianMobile,
  presentWhatsAppContact,
  safePublicWhatsAppUrl,
} from '../src/lib/whatsapp-contact';
import { HeadProspectorAgent } from '../src/agents/head-prospector';

test('normaliza celular brasileiro com ou sem DDI e recusa números inválidos', () => {
  assert.equal(brazilianPhoneE164('(62) 99988-7766'), '+5562999887766');
  assert.equal(brazilianPhoneE164('+55 (62) 99988-7766'), '+5562999887766');
  assert.equal(brazilianPhoneE164('(62) 3333-4444'), '+556233334444');
  assert.equal(brazilianPhoneE164('999999999999999999'), null);
  assert.equal(isLikelyBrazilianMobile('+5562999887766'), true);
  assert.equal(isLikelyBrazilianMobile('+556233334444'), false);
});

test('celular exibe telefone e cria somente link de TENTATIVA do WhatsApp', () => {
  const result = presentWhatsAppContact({
    phoneRaw: '(62) 99988-7766',
    phoneE164: '+5562999887766',
    whatsappStatus: 'LIKELY_MOBILE_WHATSAPP',
    whatsappUrl: 'https://wa.me/5562999887766',
  });
  assert.equal(result.phoneText, '(62) 99988-7766');
  assert.equal(result.phoneHref, 'tel:+5562999887766');
  assert.equal(result.whatsappHref, 'https://wa.me/5562999887766');
  assert.equal(result.actionLabel, 'Testar no WhatsApp');
  assert.match(result.statusLabel, /não confirmado/);
});

test('telefone fixo é exibido sem link de WhatsApp inventado', () => {
  const result = presentWhatsAppContact({
    phoneRaw: '(62) 3333-4444',
    phoneE164: '+556233334444',
    whatsappStatus: 'LANDLINE_ONLY',
    whatsappUrl: null,
  });
  assert.equal(result.phoneText, '(62) 3333-4444');
  assert.equal(result.whatsappHref, null);
  assert.equal(result.phoneHref, 'tel:+556233334444');
});

test('link de WhatsApp fornecido pela ficha fica disponível mesmo sem telefone listado', () => {
  const result = presentWhatsAppContact({
    phoneRaw: null,
    phoneE164: null,
    whatsappStatus: 'VERIFIED_WHATSAPP',
    whatsappUrl: 'https://api.whatsapp.com/send?phone=5562999887766',
  });
  assert.equal(result.phoneText, null);
  assert.equal(result.whatsappPhoneText, '(62) 99988-7766');
  assert.equal(result.whatsappHref, 'https://api.whatsapp.com/send?phone=5562999887766');
  assert.equal(result.actionLabel, 'Abrir link WhatsApp');
});

test('não permite links mascarados que usam whatsapp no caminho ou subdomínio malicioso', () => {
  assert.equal(safePublicWhatsAppUrl('https://wa.me.example.com/5562999887766'), null);
  assert.equal(safePublicWhatsAppUrl('https://fake.org/path?next=wa.me'), null);
  assert.equal(safePublicWhatsAppUrl('javascript:alert(1)'), null);
  assert.equal(safePublicWhatsAppUrl('https://wa.me/'), null);
  const result = presentWhatsAppContact({
    phoneRaw: null,
    phoneE164: null,
    whatsappStatus: 'VERIFIED_WHATSAPP',
    whatsappUrl: 'https://wa.me.example.com/5562999887766',
  });
  assert.equal(result.whatsappHref, null);
});

test('Head Agent não classifica site malicioso como WhatsApp; detecta links públicos reais', () => {
  const head = new HeadProspectorAgent();
  assert.equal(
    head.analyzeWhatsAppStatus('(62) 99988-7766', 'https://example.org/?ref=wa.me').status,
    'LIKELY_MOBILE_WHATSAPP'
  );
  assert.equal(
    head.analyzeWhatsAppStatus(undefined, 'https://wa.me/5562999887766').status,
    'VERIFIED_WHATSAPP'
  );
  assert.equal(
    head.analyzeWhatsAppStatus('(62) 3333-4444', 'https://example.org').status,
    'LANDLINE_ONLY'
  );
});
