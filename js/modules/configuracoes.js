/**
 * Configurações: perfil (profile/main) e tema (settings/main), persistidos por usuário.
 * O módulo só monta a UI; leitura/escrita/validação ficam em services/preferences.js.
 */
import { el, toast, refreshIcons } from '../core/ui.js';
import { applyThemePreference } from '../components/theme.js';
import {
  getProfile,
  getSettings,
  saveProfile,
  saveSettings,
  defaultProfileName,
  PROFILE_NAME_MAX,
} from '../services/preferences.js';

export const meta = { title: 'Configurações', icon: 'settings' };

const THEME_OPTIONS = [
  { value: 'system', label: 'Seguir o sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
];

export async function render(container, { user }) {
  let profile = null;
  let settings = null;
  let loadError = false;
  try {
    [profile, settings] = await Promise.all([getProfile(user.uid), getSettings(user.uid)]);
  } catch (error) {
    console.error('[configuracoes] falha ao carregar preferências', error);
    loadError = true;
  }

  const nameInput = el('input', {
    type: 'text',
    id: 'profile-name',
    name: 'name',
    maxlength: PROFILE_NAME_MAX,
    autocomplete: 'name',
    value: profile?.name ?? defaultProfileName(user?.email),
  });
  const themeSelect = el(
    'select',
    { id: 'settings-theme', name: 'theme' },
    THEME_OPTIONS.map((o) =>
      el('option', { value: o.value, selected: (settings?.theme ?? 'system') === o.value }, o.label)
    )
  );
  const nameError = el('span', { class: 'form-error', 'data-for': 'name' });
  const themeError = el('span', { class: 'form-error', 'data-for': 'theme' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Salvar' });

  const form = el('form', { id: 'preferences-form', novalidate: true }, [
    el('div', { class: 'field' }, [
      el('label', { for: 'profile-email', text: 'E-mail (login)' }),
      el('input', { type: 'email', id: 'profile-email', value: user?.email ?? '', disabled: true }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'profile-name', text: 'Nome *' }),
      nameInput,
      nameError,
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'settings-theme', text: 'Tema' }),
      themeSelect,
      el('span', { class: 'field__hint', text: 'Também alternável na barra superior; vale em todos os seus dispositivos.' }),
      themeError,
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field__hint', text: 'Moeda: R$ (BRL) · Idioma: pt-BR · valores armazenados em centavos.' }),
    ]),
    submit,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    nameError.textContent = '';
    themeError.textContent = '';
    submit.disabled = true;
    try {
      const profileResult = await saveProfile(user.uid, {
        name: nameInput.value,
        email: user?.email,
      });
      const settingsResult = await saveSettings(user.uid, { theme: themeSelect.value });
      if (!profileResult.ok || !settingsResult.ok) {
        nameError.textContent = profileResult.errors?.name ?? profileResult.errors?._form ?? '';
        themeError.textContent = settingsResult.errors?.theme ?? settingsResult.errors?._form ?? '';
        toast('Corrija os campos destacados.', 5000);
        return;
      }
      applyThemePreference(themeSelect.value);
      toast('Preferências salvas.');
    } catch (error) {
      console.error('[configuracoes] falha ao salvar', error);
      toast('Não foi possível salvar. Tente novamente.', 5000);
    } finally {
      submit.disabled = false;
    }
  });

  container.replaceChildren(
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'settings', 'aria-hidden': 'true' })]),
        el('div', {}, [
          el('h2', { text: 'Configurações' }),
          el('p', { class: 'card__hint', text: 'Perfil e preferências de exibição, salvos na sua conta.' }),
        ]),
      ]),
      loadError
        ? el('p', { class: 'form-error', role: 'alert', text: 'Não foi possível carregar suas preferências.' })
        : null,
      form,
    ])
  );
  refreshIcons();
}
