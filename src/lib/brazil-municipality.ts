import municipios from '@/data/municipios.json';
import estados from '@/data/estados.json';

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const estadosPorUF = new Map(
  estados.map((estado) => [estado.uf, estado.codigo_uf] as const)
);

const municipiosPorLocalidade = new Map(
  municipios.map((municipio) => [
    `${municipio.codigo_uf}:${normalize(municipio.nome)}`,
    municipio,
  ] as const)
);

export function resolveBrazilMunicipality(city: string, stateCode: string) {
  const uf = stateCode.trim().toUpperCase();
  const codigoUF = estadosPorUF.get(uf);

  if (codigoUF === undefined) {
    throw new Error(`UF inválida: ${stateCode}`);
  }

  const municipio = municipiosPorLocalidade.get(
    `${codigoUF}:${normalize(city)}`
  );

  if (!municipio) {
    throw new Error(
      `Município não encontrado: ${city}/${uf}. Confira a cidade e a UF.`
    );
  }

  return {
    city: municipio.nome,
    stateCode: uf,
    latitude: municipio.latitude,
    longitude: municipio.longitude,
  };
}
