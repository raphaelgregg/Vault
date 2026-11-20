/**
 * Leitura de estornos (`reversals`) com as Security Rules AINDA NÃO publicadas (VF-COR-01).
 *
 * A coleção `reversals` só existe nas Rules da VF-ARQ-02. Enquanto as Rules publicadas forem as antigas, a leitura dá
 * `permission-denied` — e, com a função de servidor já publicada (que grava com Admin SDK), ESTORNOS PODEM EXISTIR sem que o
 * navegador consiga lê-los. Portanto "negado" NUNCA significa "nenhum estorno": é um dado DESCONHECIDO.
 *
 *  - padrão (estrito): `permission-denied` → `ReversalsUnavailableError` (a tela mostra erro, nunca valores supostos);
 *  - `tolerate: true` (só telas que sabem operar em MODO LIMITADO): devolve `[]` marcado com `reversalsUnavailable = true`;
 *    o chamador DEVE ocultar tudo que dependa de estornos (recebido/guardado/situação) e avisar o usuário;
 *  - qualquer outro erro (rede, indisponibilidade…) propaga sempre.
 */
export const isPermissionDenied = (error) => String(error?.code ?? '').includes('permission-denied');

export class ReversalsUnavailableError extends Error {
  constructor() {
    super('Não foi possível ler os estornos: as regras de acesso publicadas ainda não incluem essa coleção. Valores que dependem de estornos (recebido, situação das parcelas, guardado em metas) estão indisponíveis até a publicação.');
    this.name = 'ReversalsUnavailableError';
    this.code = 'reversals-unavailable';
  }
}

/** `[]` marcado como DESCONHECIDO (não como "nenhum"). */
export const unknownReversals = () => Object.assign([], { reversalsUnavailable: true });
/** O resultado de uma leitura de estornos é desconhecido (leitura negada em modo tolerante)? */
export const reversalsUnavailable = (rows) => rows?.reversalsUnavailable === true;

/** Lê estornos: sucesso passa; `permission-denied` → erro estrito ou lista DESCONHECIDA (`tolerate`); outros erros propagam. */
export function readReversals(promise, { tolerate = false } = {}) {
  return Promise.resolve(promise).catch((error) => {
    if (!isPermissionDenied(error)) throw error;
    if (!tolerate) throw new ReversalsUnavailableError();
    console.warn('[estornos] leitura negada pelas Rules publicadas: estornos DESCONHECIDOS (modo limitado).');
    return unknownReversals();
  });
}

/** Mensagem de erro de carga para a tela: a explicação específica do estorno ilegível; senão a descrição genérica do chamador. */
export const loadErrorMessage = (error, describe) => (error?.code === 'reversals-unavailable' ? error.message : describe(error));
