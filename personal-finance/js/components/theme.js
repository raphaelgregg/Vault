/** Modo claro/escuro persistido no localStorage (chave própria da UI, não dado financeiro). */
const STORAGE_KEY = 'pf:theme';

export function applyStoredTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = stored === 'light' || stored === 'dark' ? stored : prefersDark ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(STORAGE_KEY, next);
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
