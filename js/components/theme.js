/** Modo claro/escuro persistido no localStorage (chave própria da UI, não dado financeiro). */
const STORAGE_KEY = 'pf:theme';

const PREFERENCES = ['light', 'dark', 'system'];

/** Preferência ('light'|'dark'|'system') + preferência do SO → tema efetivo. Puro. */
export function resolveTheme(preference, prefersDark) {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

function readCache() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return PREFERENCES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function writeCache(preference) {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* armazenamento indisponível: o tema só não persiste localmente */
  }
}

/** Aplica uma preferência ao documento. Se `cache`, guarda no localStorage (evita flash no reload). */
export function applyThemePreference(preference, { cache = true } = {}) {
  const pref = PREFERENCES.includes(preference) ? preference : 'system';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolveTheme(pref, prefersDark);
  document.documentElement.dataset.theme = theme;
  if (cache) writeCache(pref);
  return theme;
}

/** Aplica o tema do cache local (execução síncrona, antes da sessão/Firestore). */
export function applyStoredTheme() {
  return applyThemePreference(readCache(), { cache: false });
}

/** Persistência remota (settings/main), registrada pelo app após a sessão. */
let persister = null;
export function setThemePersister(fn) {
  persister = typeof fn === 'function' ? fn : null;
}

/** Alterna claro/escuro, guarda no cache e persiste no Firestore (best-effort). */
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyThemePreference(next);
  if (persister) {
    Promise.resolve(persister(next)).catch((error) =>
      console.error('[theme] falha ao persistir tema', error)
    );
  }
  return next;
}

export function mountThemeToggle(container) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--icon';
  button.title = 'Alternar tema claro/escuro';
  button.setAttribute('aria-label', 'Alternar tema claro/escuro');
  const render = () => {
    const theme = document.documentElement.dataset.theme;
    button.innerHTML = `<i data-lucide="${theme === 'dark' ? 'sun' : 'moon'}" aria-hidden="true"></i>`;
    if (window.lucide) window.lucide.createIcons();
  };
  button.addEventListener('click', () => {
    toggleTheme();
    render();
  });
  render();
  container.append(button);
  return button;
}
