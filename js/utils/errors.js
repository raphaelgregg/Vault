/**
 * Mensagem amigável para erros inesperados (rede/Firebase). Puro: não conhece DOM nem rede.
 * Erros de validação de negócio NÃO passam por aqui (services retornam { ok:false, errors }).
 */
export function describeError(error) {
  const code = String(error?.code ?? '');
  if (code.includes('permission-denied')) {
    return 'Permissão negada pelo Firestore. Verifique se as regras mais recentes (firestore.rules) estão publicadas no projeto e se a sessão ainda é válida; nada foi gravado por completo.';
  }
  if (code.includes('unauthenticated')) return 'Sessão expirada. Entre novamente.';
  if (code.includes('unavailable') || code.includes('network') || code.includes('deadline-exceeded')) {
    return 'Sem conexão com o servidor. Tente novamente.';
  }
  if (code.includes('resource-exhausted')) return 'Cota do Firebase esgotada. Tente novamente mais tarde.';
  if (code.includes('failed-precondition')) return 'Operação indisponível (índice ou pré-condição ausente no Firestore).';
  return 'Não foi possível concluir a operação. Tente novamente.';
}
