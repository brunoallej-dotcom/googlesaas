import type { ScoringContext } from './context';
import { compareAddress, compareHours, compareName, comparePhone, nameEquivalenceKey, type FieldComparison } from './nap-compare';
import { countBounds, nvFromResolution, scoreAge, scoreAsc } from './eval-common';
import { combineBasis, notVerified, absence, scored, withNotes, type Basis } from './results';
import { CATEGORICAL, TIERS } from './ruler';
import type { SubcriterionResult } from './types';

const has = (value: string | undefined): boolean => typeof value === 'string' && value.trim().length > 0;

function recordBasis(basis: Basis, ...recordIds: string[]): Basis {
  return { ...basis, operatorRecordIds: [...new Set([...basis.operatorRecordIds, ...recordIds])].sort() };
}

function presenceString(ctx: ScoringContext, id: 'N1' | 'N3' | 'C1', key: 'name' | 'phone' | 'primaryCategory', what: string): SubcriterionResult {
  const resolved = ctx.resolve(key);
  if (resolved.status !== 'OK') return nvFromResolution(id, resolved);
  if (typeof resolved.value === 'string' && resolved.value.trim().length > 0) {
    return scored(id, CATEGORICAL.PRESENT, 'presente', `${what} presente no perfil`, resolved.basis, 'PRESENT');
  }
  if (resolved.complete) return absence(id, 'ABSENCE_PROVEN_NATIVE', `${what} ausente no perfil (campo exposto e lido por inteiro).`, resolved.basis);
  return notVerified(id, 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', `${what}: o campo não foi lido por inteiro.`, resolved.basis);
}

export const evalN1 = (ctx: ScoringContext): SubcriterionResult => presenceString(ctx, 'N1', 'name', 'Nome');
export const evalN3 = (ctx: ScoringContext): SubcriterionResult => presenceString(ctx, 'N3', 'phone', 'Telefone');
export const evalC1 = (ctx: ScoringContext): SubcriterionResult => presenceString(ctx, 'C1', 'primaryCategory', 'Categoria principal');

export function evalN2(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('address');
  if (resolved.status !== 'OK') return nvFromResolution('N2', resolved);
  const parsed = resolved.value.parsed;
  if (!parsed) return notVerified('N2', 'ADDRESS_UNPARSED', 'Endereço sem decomposição estruturada: não decidível por regra.', resolved.basis);
  if (parsed.serviceArea === true) return scored('N2', CATEGORICAL.N2_FULL, 'área de atendimento declarada', 'Área de atendimento declarada', resolved.basis, 'PRESENT');
  if (has(parsed.street) && has(parsed.number) && has(parsed.city) && has(parsed.state)) {
    return scored('N2', CATEGORICAL.N2_FULL, 'endereço completo', 'Endereço completo (logradouro, número, cidade e UF)', resolved.basis, 'PRESENT');
  }
  if (has(parsed.street) && has(parsed.city)) {
    return scored('N2', CATEGORICAL.N2_PARTIAL, 'endereço incompleto', 'Endereço com logradouro e cidade, mas sem número ou UF', resolved.basis, 'PRESENT');
  }
  // o texto existe mas a decomposição não decide: zero só se o perfil declara explicitamente que não há endereço
  if (parsed.none === true && resolved.complete) return absence('N2', 'ABSENCE_PROVEN_NATIVE', 'O perfil não tem endereço nem área de atendimento (campo lido por inteiro).', resolved.basis);
  return notVerified('N2', 'ADDRESS_UNPARSED', 'O endereço não pôde ser decomposto por regra (nem declarado ausente): Não verificado, nunca zero.', resolved.basis);
}

export function evalN4(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('hours');
  if (resolved.status !== 'OK') return nvFromResolution('N4', resolved);
  const value = resolved.value;
  if (value.kind === 'TEXT') return notVerified('N4', 'HOURS_UNSTRUCTURED', 'Horários em texto livre: não decidíveis por regra.', resolved.basis);
  if (value.alwaysOpen === true) return scored('N4', 4, '7 dias definidos', 'Atendimento 24 horas', resolved.basis, 'PRESENT');
  const bounds = countBounds(value.days.length, resolved.complete, 7);
  return scoreAsc('N4', TIERS.N4, bounds.lo, bounds.hi, resolved.basis, 'Horários');
}

const EXTERNAL_ORIGINS = ['OFFICIAL_SITE', 'OFFICIAL_SOCIAL', 'THIRD_PARTY', 'INSTITUTIONAL'] as const;
type NapField = 'name' | 'address' | 'phone' | 'hours';

/** N5: consistência do perfil com as fontes externas LISTADAS (escopo declarado); ambíguo nunca conta como divergência. */
export function evalN5(ctx: ScoringContext): SubcriterionResult {
  const sources = ctx.input.nap?.sources ?? [];
  const equivalences = new Set(ctx.records('NAME_EQUIVALENCE').map((record) => nameEquivalenceKey(record.nameA, record.nameB)));
  const profile = {
    name: ctx.resolve('name'),
    address: ctx.resolve('address'),
    phone: ctx.resolve('phone'),
    hours: ctx.resolve('hours'),
  };
  const outcome = new Map<NapField, FieldComparison[]>();
  const usedProfileBases: Basis[] = [];
  const usedSourceBases: Basis[] = [];
  let bestComparable = 0;
  const usedFields = new Set<NapField>();

  for (const source of sources) {
    const grounded = ctx.ground(source.evidenceIds, EXTERNAL_ORIGINS);
    if (!grounded.ok) continue;
    let comparable = 0;
    const push = (field: NapField, comparison: FieldComparison): void => {
      outcome.set(field, [...(outcome.get(field) ?? []), comparison]);
      if (comparison !== 'AMBIGUOUS') {
        comparable += 1;
        usedFields.add(field);
      }
    };
    if (source.name !== undefined && profile.name.status === 'OK' && typeof profile.name.value === 'string') {
      push('name', compareName(profile.name.value, source.name, equivalences));
    }
    if (source.phone !== undefined && profile.phone.status === 'OK' && typeof profile.phone.value === 'string') {
      push('phone', comparePhone(profile.phone.value, source.phone));
    }
    if (source.address !== undefined && profile.address.status === 'OK') {
      push('address', compareAddress(profile.address.value.raw, source.address));
    }
    if (source.hours !== undefined && profile.hours.status === 'OK') {
      push('hours', compareHours(profile.hours.value, source.hours));
    }
    if (comparable > 0) usedSourceBases.push(grounded.basis);
    bestComparable = Math.max(bestComparable, comparable);
  }
  if (bestComparable < 2) {
    return notVerified('N5', 'NAP_NOT_COMPARABLE', 'Menos de 2 campos comparáveis em uma fonte externa lida (ambíguo ou ausente não conta como divergência).');
  }
  let divergent = 0;
  const divergentFields: string[] = [];
  for (const field of ['name', 'address', 'phone', 'hours'] as const) {
    const list = outcome.get(field) ?? [];
    if (list.includes('DIVERGENT')) {
      divergent += 1;
      divergentFields.push(field);
    }
  }
  for (const field of usedFields) {
    const resolved = profile[field];
    if (resolved.status === 'OK') usedProfileBases.push(resolved.basis);
  }
  const basis = withNotes(combineBasis(...usedProfileBases, ...usedSourceBases), `Fontes comparadas: ${usedSourceBases.length}; campos divergentes: ${divergentFields.length === 0 ? 'nenhum' : divergentFields.join(', ')}.`);
  return scoreAge('N5', TIERS.N5, divergent, divergent, basis, 'Consistência de NAP entre o perfil e as fontes listadas');
}

export function evalC2(ctx: ScoringContext): SubcriterionResult {
  const category = ctx.resolve('primaryCategory');
  if (category.status !== 'OK' || typeof category.value !== 'string' || category.value.trim() === '') {
    return notVerified('C2', 'BASIS_MISSING', 'Sem categoria principal observada: não há o que confirmar.', category.status === 'OK' ? category.basis : undefined);
  }
  const judgement = ctx.judgement('C2');
  if (!judgement) return notVerified('C2', 'OPERATOR_CONFIRMATION_REQUIRED', 'A compatibilidade com a atividade real exige confirmação registrada do operador.', category.basis);
  const key = judgement.value as keyof typeof CATEGORICAL.C2;
  const labels = { COMPATIBLE: 'compatível', PARTIAL: 'parcialmente compatível', INCOMPATIBLE: 'incompatível' } as const;
  return scored('C2', CATEGORICAL.C2[key], labels[key], `Compatibilidade confirmada pelo operador (registro ${judgement.id}): ${labels[key]}`, recordBasis(category.basis, judgement.id));
}

export function evalC3(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('additionalCategories');
  if (resolved.status !== 'OK') return nvFromResolution('C3', resolved);
  if (!resolved.complete) return notVerified('C3', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'Lista de categorias adicionais não lida por inteiro.', resolved.basis);
  const judgement = ctx.judgement('C3');
  const size = resolved.value.length;
  if (size === 0) {
    if (judgement?.value === 'MISSING_NEEDED') {
      return absence('C3', 'ABSENCE_PROVEN_NATIVE', `Nenhuma categoria adicional e o operador registrou (${judgement.id}) que faltam.`, recordBasis(resolved.basis, judgement.id));
    }
    if (judgement) {
      ctx.reject(`juízo ${judgement.id}: C3 com lista vazia só aceita MISSING_NEEDED (ou N/A NO_ADDITIONAL_NEEDED)`);
      return notVerified('C3', 'BASIS_MISSING', 'Juízo inconsistente com a lista vazia.', resolved.basis);
    }
    return notVerified('C3', 'OPERATOR_CONFIRMATION_REQUIRED', 'Lista vazia: o operador precisa registrar "nenhuma necessária" (N/A) ou "faltam".', resolved.basis);
  }
  if (!judgement) return notVerified('C3', 'OPERATOR_CONFIRMATION_REQUIRED', 'Relevância e coerência das adicionais exigem confirmação registrada do operador.', resolved.basis);
  if (judgement.value === 'MISSING_NEEDED') {
    ctx.reject(`juízo ${judgement.id}: MISSING_NEEDED é inconsistente com uma lista que já tem categorias adicionais`);
    return notVerified('C3', 'BASIS_MISSING', 'Juízo inconsistente com a lista.', resolved.basis);
  }
  const key = judgement.value as 'ALL_RELEVANT' | 'MOSTLY_RELEVANT' | 'MOSTLY_IRRELEVANT';
  const labels = { ALL_RELEVANT: 'todas pertinentes', MOSTLY_RELEVANT: 'maioria pertinente', MOSTLY_IRRELEVANT: 'maioria incoerente' } as const;
  return scored('C3', CATEGORICAL.C3[key], labels[key], `Adicionais (${size}, sem limite de quantidade): ${labels[key]} segundo o operador (${judgement.id})`, recordBasis(resolved.basis, judgement.id));
}

function countField(ctx: ScoringContext, id: 'S2' | 'S3' | 'S4', key: 'services' | 'attributes' | 'products', what: string): SubcriterionResult {
  const resolved = ctx.resolve(key);
  if (resolved.status !== 'OK') return nvFromResolution(id, resolved);
  const bounds = countBounds(resolved.value, resolved.complete);
  return scoreAsc(id, TIERS[id], bounds.lo, bounds.hi, resolved.basis, what);
}

export function evalS1(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('description');
  if (resolved.status !== 'OK') return nvFromResolution('S1', resolved);
  const bounds = countBounds(resolved.value.lengthChars, resolved.complete);
  return scoreAsc('S1', TIERS.S1, bounds.lo, bounds.hi, resolved.basis, 'Descrição nativa');
}
export const evalS2 = (ctx: ScoringContext): SubcriterionResult => countField(ctx, 'S2', 'services', 'Serviços/itens cadastrados no Google');
export const evalS3 = (ctx: ScoringContext): SubcriterionResult => countField(ctx, 'S3', 'attributes', 'Atributos do perfil');
export const evalS4 = (ctx: ScoringContext): SubcriterionResult => countField(ctx, 'S4', 'products', 'Produtos cadastrados no Google');
