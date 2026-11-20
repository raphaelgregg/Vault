/**
 * Leitura de estornos (`reversals`) tolerante às Security Rules AINDA NÃO publicadas (VF-COR-01).
 *
 * A coleção `reversals` só existe nas Rules da VF-ARQ-02. Enquanto as Rules publicadas forem as antigas, qualquer leitura
 * dela dá `permission-denied` e derrubava telas inteiras (Transferências em branco; modal de parcelas e "Nova dívida" do
 * devedor sem abrir). Com as Rules antigas NÃO PODEM existir estornos (nada os grava), então "negado" equivale a "nenhum".
 * Só `permission-denied` é tolerado: qualquer outra falha (rede, indisponível…) continua propagando, para nunca mostrar
 * saldos/recebimentos sem descontar estornos por engano de infraestrutura.
 */
export const isPermissionDenied = (error) => String(error?.code ?? '').includes('permission-denied');

/** Resolve com `[]` se a leitura de estornos for negada pelas Rules publicadas; propaga qualquer outro erro. */
export function reversalsOrNone(promise) {
  return Promise.resolve(promise).catch((error) => {
    if (!isPermissionDenied(error)) throw error;
    console.warn('[estornos] leitura negada pelas Rules publicadas (ainda sem a coleção `reversals`): tratando como sem estornos.');
    return [];
  });
}
