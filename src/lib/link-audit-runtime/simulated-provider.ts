import { companyIdentitySchema, confirmIdentity, type CompanyIdentity } from '../link-audit/audit';
import type { CollectionInput, MapsProvider, MapsSearchRequest, ProviderOutcome } from '../link-audit/collector/types';
import { parseGoogleMapsLink } from '../link-audit/maps-link';
import type { ProviderCaptureInfo } from './serper-maps-provider';

/*
 * Gerador SINTÉTICO da coleta SIMULADA do ensaio da W5 (W5.2b, spec do P1 §5.7). Puro: nenhuma rede (não usa `fetch` nem o transporte do
 * Serper), nenhum disco, nenhum ambiente. Os dados são FIXOS e obviamente fictícios: nenhum identificador, nome ou endereço de empresa real,
 * nem telefone, site ou nota. Só existe para a homologação produzir a captura `c0001` e o hash `--json` que o `export` exige (S-02).
 */

/** FID com prefixo zero e sufixo curto: o CID derivado tem 6 dígitos (os de perfis reais têm 17 a 20). */
export const SIMULATED_FID = '0x0:0xe5a10';
export const SIMULATED_CID = '940560';
export const SIMULATED_LINK = `https://www.google.com/maps/place/Empresa+de+Ensaio/data=!1s${SIMULATED_FID}?cid=${SIMULATED_CID}`;
/** UF `ZZ` não existe. */
export const SIMULATED_COMPANY = { name: 'Empresa de Ensaio', city: 'Cidade de Ensaio', stateCode: 'ZZ' } as const;
const SIMULATED_ADDRESS = 'Endereço de Ensaio, s/n - Cidade de Ensaio - ZZ';
const SIMULATED_CATEGORY = 'Categoria de Ensaio';
/** Gravado em `request.url` da captura: não é um endereço de rede e deixa claro que nada foi enviado. */
export const SIMULATED_REQUEST_URL = 'simulado://ensaio-homologacao/maps';
/** Não houve HTTP: o status 2xx é o que o pipeline exige para gerar o relatório, e a captura inteira vai marcada como SIMULADA. */
const SIMULATED_HTTP_STATUS = 200;

/** Corpo sintético no formato do /maps (só os campos que o pipeline lê), marcado também por dentro. */
export function simulatedMapsBody(query: string): string {
  return JSON.stringify({
    simulated: true,
    searchParameters: { q: query, type: 'maps', engine: 'simulado-ensaio' },
    places: [{ position: 1, title: SIMULATED_COMPANY.name, address: SIMULATED_ADDRESS, type: SIMULATED_CATEGORY, types: [SIMULATED_CATEGORY], cid: SIMULATED_CID, fid: SIMULATED_FID }],
    credits: 0,
  });
}

export interface SimulatedMapsProviderConfig {
  /** Recebe o corpo sintético ANTES do processamento, como o provedor real entrega a resposta paga à persistência. */
  readonly onCapture?: (info: ProviderCaptureInfo) => Promise<void> | void;
  readonly now: () => Date;
}

/** Provedor de mapas SINTÉTICO (sem `live`): uma "consulta" que só monta o corpo fixo em memória. */
export function createSimulatedMapsProvider(config: SimulatedMapsProviderConfig): MapsProvider {
  return {
    async search(request: MapsSearchRequest): Promise<ProviderOutcome<readonly unknown[]>> {
      const bodyText = simulatedMapsBody(request.query);
      const capturedAt = config.now().toISOString();
      if (config.onCapture) {
        await config.onCapture({ url: SIMULATED_REQUEST_URL, requestBody: { q: request.query, simulated: true }, httpStatus: SIMULATED_HTTP_STATUS, bodyText, attempts: 0, failure: null, capturedAt });
      }
      const places = (JSON.parse(bodyText) as { places: readonly unknown[] }).places;
      return { state: 'OK', value: places, fetchedAt: capturedAt };
    },
  };
}

/** A identidade é a do ensaio: mesmos identificadores e mesma empresa sintética (qualquer outra ⇒ não é coleta simulada aceitável). */
export function isSyntheticIdentity(identity: CompanyIdentity): boolean {
  const ids = identity.identifiers;
  return (
    ids.cid === SIMULATED_CID &&
    ids.featureId === SIMULATED_FID &&
    ids.placeId === undefined &&
    identity.name === SIMULATED_COMPANY.name &&
    identity.city === SIMULATED_COMPANY.city &&
    identity.stateCode === SIMULATED_COMPANY.stateCode &&
    identity.address === undefined
  );
}

/** Entrada da coleta simulada: o link sintético, confirmado pelo operador, com a empresa sintética. */
export function simulatedCollectionInput(params: { readonly operator: string; readonly confirmedAt: string; readonly snapshotId: string }): CollectionInput {
  const link = parseGoogleMapsLink(SIMULATED_LINK);
  const confirmed = confirmIdentity(link, { confirmedBy: params.operator, confirmedAt: params.confirmedAt });
  if (!confirmed.ok) throw new SimulatedInputError(`identidade sintética não confirmada: ${confirmed.issues.join(' ')}`);
  const identity = companyIdentitySchema.parse({ ...confirmed.value, ...SIMULATED_COMPANY });
  return { snapshotId: params.snapshotId, link: { originalLink: SIMULATED_LINK, resolved: null }, identity };
}

export class SimulatedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulatedInputError';
  }
}
