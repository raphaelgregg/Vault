/**
 * Configuração pública do Firebase.
 *
 * ATENÇÃO: estes são PLACEHOLDERS. O usuário deve criar o projeto no console do
 * Firebase (plano gratuito Spark) e colar aqui os valores de "Configuração do SDK".
 *
 * Isto NÃO é credencial administrativa: a chave de API web é pública por design.
 * A segurança real está em firestore.rules + Authentication.
 *
 * NUNCA coloque aqui service account, Admin SDK, client_secret ou chave privada.
 */
export const firebaseConfig = {
  apiKey: 'COLE_AQUI_API_KEY',                      // exemplo: AIza...
  authDomain: 'COLE_AQUI.firebaseapp.com',          // exemplo: meu-finance.firebaseapp.com
  projectId: 'COLE_AQUI_PROJECT_ID',                // exemplo: meu-finance
  storageBucket: 'COLE_AQUI.appspot.com',           // não usado nesta fase
  messagingSenderId: 'COLE_AQUI_SENDER_ID',
  appId: 'COLE_AQUI_APP_ID',
};

/** true = config ainda não preenchida (a UI mostra aviso em vez de falhar em silêncio) */
export function isConfigPlaceholder(config = firebaseConfig) {
  return Object.values(config).some(
    (value) => typeof value === 'string' && value.startsWith('COLE_AQUI')
  );
}

/** Emuladores locais: usados apenas quando a página roda em localhost/127.0.0.1 */
export const USE_EMULATORS =
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  new URLSearchParams(window.location.search).get('emulator') !== '0';

export const EMULATOR_HOST = '127.0.0.1';
