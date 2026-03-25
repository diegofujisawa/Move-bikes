import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'firebase/firestore';

import firebaseConfig from './firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// =================================================================
// FIRESTORE com persistência offline — API atualizada para Firebase 12
// Substitui o depreciado enableIndexedDbPersistence()
// =================================================================
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  }),
}, (firebaseConfig as any).firestoreDatabaseId);

export const auth = getAuth(app);

// =================================================================
// LOGIN ANÔNIMO com retry e backoff exponencial
// =================================================================
const performAnonymousLogin = (retryCount = 0) => {
  const MAX_RETRIES = 3;

  if (typeof window !== 'undefined' && !navigator.onLine) {
    console.warn('[Firebase] Offline. Aguardando conexão para login anônimo...');
    window.addEventListener('online', () => performAnonymousLogin(retryCount), { once: true });
    return;
  }

  console.log(`[Firebase] Tentando login anônimo (tentativa ${retryCount + 1})...`);
  signInAnonymously(auth)
    .then(() => console.log('[Firebase] Login anônimo realizado com sucesso.'))
    .catch((err) => {
      console.error(`[Firebase] Erro no login anônimo (tentativa ${retryCount + 1}):`, err.code, err.message);

      if (
        (err.code === 'auth/network-request-failed' || err.code === 'auth/internal-error') &&
        retryCount < MAX_RETRIES
      ) {
        const delay = Math.pow(2, retryCount) * 2000 + Math.random() * 1000;
        console.log(`[Firebase] Retentando login anônimo em ${Math.round(delay)}ms...`);
        setTimeout(() => performAnonymousLogin(retryCount + 1), delay);
      } else if (err.code === 'auth/operation-not-allowed') {
        console.error('[Firebase] Login anônimo não está habilitado no console do Firebase.');
      }
    });
};

// =================================================================
// INICIALIZAÇÃO — persistência antes de qualquer ação
// =================================================================
if (typeof window !== 'undefined') {
  setPersistence(auth, browserLocalPersistence)
    .then(() => {
      console.log('[Firebase] Persistência configurada.');
      onAuthStateChanged(auth, (user) => {
        if (!user) {
          performAnonymousLogin();
        } else {
          console.log('[Firebase] Usuário já autenticado:', user.uid);
        }
      });
    })
    .catch(err => {
      console.error('[Firebase] Erro ao configurar persistência:', err);
      performAnonymousLogin();
    });
}

// =================================================================
// waitForAuth — aguarda o Firebase Auth estar pronto
// Use: await waitForAuth() antes de qualquer escrita no Firestore
// =================================================================
export const waitForAuth = (): Promise<void> => {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsubscribe();
        resolve();
      }
    });
  });
};

export default app;