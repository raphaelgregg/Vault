/**
 * Inicialização única do SDK do Firebase (v10 modular via CDN).
 * Exporta instâncias de app, auth e firestore já conectadas aos emuladores
 * quando estiver rodando localmente.
 *
 * Regra: se a config real ainda são placeholders E estamos em localhost, usamos
 * uma config DEMO apontando para o Emulator Suite. Isso permite desenvolver sem
 * projeto Firebase; nada disso alcança a nuvem.
 */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, isConfigPlaceholder, USE_EMULATORS, EMULATOR_HOST } from './config.js';

/** Config fictícia: só funciona contra os emuladores locais. */
const DEMO_CONFIG = Object.freeze({
  apiKey: 'demo-api-key',
  authDomain: 'demo-vault-finance.firebaseapp.com',
  projectId: 'demo-vault-finance',
  storageBucket: 'demo-vault-finance.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:demo',
});

export const usingDemoConfig = USE_EMULATORS && isConfigPlaceholder(firebaseConfig);

/** true = sem config real e sem emulador: a UI avisa em vez de falhar em silêncio. */
export const configMissing = isConfigPlaceholder(firebaseConfig) && !usingDemoConfig;

const activeConfig = usingDemoConfig ? DEMO_CONFIG : firebaseConfig;

const app = getApps().length ? getApps()[0] : initializeApp(activeConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

let emulatorsConnected = false;
export function connectEmulatorsOnce() {
  if (emulatorsConnected || !USE_EMULATORS) return;
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
  emulatorsConnected = true;
  console.info('[firebase] conectado aos emuladores locais (auth:9099, firestore:8080)');
}

export { app };
