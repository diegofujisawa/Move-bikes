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
// FIRESTORE CONECTIVIDADE E CACHE OFFLINE PERSISTENTE (OTIMIZAÇÃO DE LEITURAS)
// =================================================================
// Ativamos o cache offline persistente com gerenciador de múltiplas abas para:
// 1. Reduzir as leituras no servidor Firebase em até 90% (evita estourar o limite de 50.000 leituras/dia)
// 2. Aumentar drasticamente a agilidade das consultas ao carregar dados locais instantaneamente
// 3. Garantir funcionamento correto e estável mesmo quando a rede estiver oscilando
const dbId = (firebaseConfig as any).firestoreDatabaseId && (firebaseConfig as any).firestoreDatabaseId !== '(default)'
  ? (firebaseConfig as any).firestoreDatabaseId
  : undefined;

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
}, dbId);

export const auth = getAuth(app);

// =================================================================
// LOGIN ANÔNIMO com retry e backoff exponencial
// =================================================================
let isLoggingIn = false;

const performAnonymousLogin = async (retryCount = 0) => {
  const MAX_RETRIES = 8; // Aumentado para 8 retries para maior resiliência

  if (isLoggingIn) return;
  
  // Se já estiver logado, não faz nada
  if (auth.currentUser) {
    console.log('[Firebase] Já autenticado, pulando login anônimo.');
    return;
  }

  isLoggingIn = true;

  // Pequeno delay na primeira tentativa para garantir que o ambiente esteja pronto
  if (retryCount === 0) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Verifica novamente se logou nesse meio tempo
    if (auth.currentUser) {
      isLoggingIn = false;
      return;
    }
  }

  if (typeof window !== 'undefined' && !navigator.onLine) {
    console.warn('[Firebase] Offline. Aguardando conexão para login anônimo...');
    const handleOnline = () => {
      isLoggingIn = false;
      performAnonymousLogin(retryCount);
    };
    window.addEventListener('online', handleOnline, { once: true });
    isLoggingIn = false;
    return;
  }

  console.log(`[Firebase] Tentando login anônimo (tentativa ${retryCount + 1})...`);
  try {
    await signInAnonymously(auth);
    console.log('[Firebase] Login anônimo realizado com sucesso.');
  } catch (err: any) {
    console.error(`[Firebase] Erro no login anônimo (tentativa ${retryCount + 1}):`, err.code, err.message);

    const retryableErrors = [
      'auth/network-request-failed',
      'auth/internal-error',
      'auth/too-many-requests',
      'auth/web-storage-unsupported',
      'auth/quota-exceeded'
    ];

    if (retryableErrors.includes(err.code) && retryCount < MAX_RETRIES) {
      // Backoff exponencial: 2s, 4s, 8s, 16s... com jitter
      const delay = Math.min(Math.pow(2, retryCount) * 1000 + Math.random() * 1000, 30000);
      console.log(`[Firebase] Retentando login anônimo em ${Math.round(delay)}ms...`);
      setTimeout(() => {
        isLoggingIn = false;
        performAnonymousLogin(retryCount + 1);
      }, delay);
    } else {
      if (err.code === 'auth/operation-not-allowed') {
        console.error('[Firebase] Login anônimo não está habilitado no console do Firebase.');
      } else if (err.code === 'auth/network-request-failed') {
        console.error('[Firebase] Falha persistente de rede. Verifique se o domínio do Firebase está acessível ou se há um firewall bloqueando.');
      }
      isLoggingIn = false;
    }
    return;
  }
  isLoggingIn = false;
};

// =================================================================
// INICIALIZAÇÃO — persistência com fallback
// =================================================================
const setupAuth = async () => {
  if (typeof window === 'undefined') return;

  try {
    // Tenta persistência local (localStorage)
    await setPersistence(auth, browserLocalPersistence);
    console.log('[Firebase] Persistência local configurada.');
  } catch (err) {
    console.warn('[Firebase] Falha na persistência local, tentando sessão...', err);
    try {
      // Fallback para sessão (sessionStorage)
      const { browserSessionPersistence } = await import('firebase/auth');
      await setPersistence(auth, browserSessionPersistence);
      console.log('[Firebase] Persistência de sessão configurada.');
    } catch (err2) {
      console.warn('[Firebase] Falha na persistência de sessão, usando memória...', err2);
      try {
        // Fallback final para memória
        const { inMemoryPersistence } = await import('firebase/auth');
        await setPersistence(auth, inMemoryPersistence);
        console.log('[Firebase] Persistência em memória configurada.');
      } catch (err3) {
        console.error('[Firebase] Falha crítica ao configurar persistência:', err3);
      }
    }
  }

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      performAnonymousLogin();
    } else {
      console.log('[Firebase] Usuário já autenticado:', user.uid);
    }
  });
};

if (typeof window !== 'undefined') {
  setupAuth();
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