/**
 * Paginação por cursor (VF-4-03), sem DOM nem rede: o chamador injeta `fetchPage`.
 * `fetchPage({ limit, startAfterId })` deve devolver os documentos na ordem de busca; o pager pede
 * `pageSize + 1` para saber se há mais (sem página vazia extra) e descarta o excedente.
 * Cada página custa `pageSize + 1` leituras (+1 do cursor a partir da 2ª).
 */
export const DEFAULT_PAGE_SIZE = 100;

export function createPager({ fetchPage, pageSize = DEFAULT_PAGE_SIZE }) {
  let items = [];
  let more = false;
  let loading = false;

  async function load(startAfterId) {
    const page = await fetchPage({ limit: pageSize + 1, startAfterId });
    more = page.length > pageSize;
    return more ? page.slice(0, pageSize) : page;
  }

  return {
    pageSize,
    get items() { return items; },
    get hasMore() { return more; },
    get loading() { return loading; },
    /** Recarrega do início (descarta o que estava carregado). */
    async loadFirst() {
      items = await load(null);
      return items;
    },
    /** Próxima página (mais antiga, na ordem de busca). Sem mais páginas, não consulta. Evita chamadas concorrentes. */
    async loadMore() {
      if (!more || loading || !items.length) return items;
      loading = true;
      try {
        const page = await load(items[items.length - 1].id);
        items = [...items, ...page];
      } finally {
        loading = false;
      }
      return items;
    },
  };
}
