import { User } from './types';

// For maximum stability and security, we route all Google Apps Script communication
// through our Express server proxy (/api/proxy) to avoid cross-origin (CORS),
// cookie-blocking (iframe), and privacy-extension / adblocker issues.
// However, when hosted on static environments (e.g., Cloudflare Workers), we connect directly.
const GOOGLE_SCRIPT_DIRECT_URL = 'https://script.google.com/macros/s/AKfycbxqnNTX1M19jUY1hsULYOAkWO1DliXgBUtNAIxNznAl1HJwJUJsZ5h0TCIt135iS_NqWg/exec';

const isLocalOrPreview =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname.endsWith('run.app');

const SCRIPT_URL = isLocalOrPreview
  ? window.location.origin + '/api/proxy'
  : GOOGLE_SCRIPT_DIRECT_URL;

const credentialsMode = isLocalOrPreview ? 'include' : 'omit';


// =================================================================
// AÇÕES DE LEITURA — retry seguro (nunca duplicam dados)
// AÇÕES DE ESCRITA — retry apenas com idempotencyKey
// =================================================================
const READ_ACTIONS = new Set([
  'health', 'search', 'debugSearch', 'getRequests', 'getRequestsHistory', 'getStations',
  'getMotoristas', 'getMecanicos', 'getAllPatrimonioNumbers', 'getDriverLocations',
  'getDriverState', 'getBikeDetailsBatch', 'getDailyReportData',
  'getSchedule', 'getBikeStatuses', 'getReporData', 'getChangeStatusData',
  'getAlerts', 'getVandalized', 'getRouteDetails', 'getVehiclePlates',
  'getDriversSummary', 'getAdminAlerts', 'getMechanicsList', 'getChassiInfo',
  'getTechnicaList', 'getBicycles', 'getAnalyticalDashboardData',
  'getDirections', 'getBikeMovement', 'getSheetsRecoveredBikes',
  'exportAllData', 'sync',
]);

// =================================================================
// CACHE — evita chamadas repetidas para leituras frequentes
// TTL padrão: 30 segundos
// =================================================================
const CACHEABLE_ACTIONS = new Set([
  'getStations', 'getBikeStatuses', 'getMotoristas', 'getMecanicos',
  'getVehiclePlates', 'getMechanicsList',
]);

const CACHE_TTL_MS = 30_000; // 30 segundos

interface CacheEntry {
  data: any;
  expiresAt: number;
}

const memoryCache: Record<string, CacheEntry> = {};

function getCached(key: string): any | null {
  const entry = memoryCache[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    delete memoryCache[key];
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: any): void {
  memoryCache[key] = { data, expiresAt: Date.now() + CACHE_TTL_MS };
}

export function clearCache(action?: string): void {
  if (action) {
    // Remove todas as entradas que começam com a action
    for (const key in memoryCache) {
      if (key.startsWith(action + ':')) delete memoryCache[key];
    }
  } else {
    for (const key in memoryCache) delete memoryCache[key];
  }
}

// =================================================================
// SESSÃO — sessionStorage (isolado por aba) para dados ativos.
// localStorage apenas para preferências persistentes.
// =================================================================
function getSessionUser(): User | null {
  try {
    const raw = sessionStorage.getItem('bike_app_user')
      || localStorage.getItem('bike_app_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getSessionId(): string | null {
  return (
    sessionStorage.getItem('bike_app_session_id') ||
    localStorage.getItem('bike_app_session_id') ||
    null
  );
}

// =================================================================
// IDEMPOTENCY KEY
// Gerado uma vez por operação de escrita, reutilizado em retries.
// O backend rejeita silenciosamente qualquer repetição do mesmo key.
// =================================================================
function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// =================================================================
// FETCH COM TIMEOUT
// =================================================================
async function fetchWithTimeout(
  resource: RequestInfo,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout = 120000 } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// =================================================================
// PARSEIA RESPOSTA — trata erros específicos do Google Apps Script
// =================================================================
function parseJsonResponse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    console.error('[API] Falha ao parsear JSON. Conteúdo retornado:', text.slice(0, 1000));
    const lowerText = text.toLowerCase();
    if (
      lowerText.includes('service invoked too many times') ||
      lowerText.includes('too many simultaneous invocations') ||
      lowerText.includes('scripterror') ||
      lowerText.includes('exceeded maximum execution time') ||
      lowerText.includes('concurrent invocations limit exceeded') ||
      lowerText.includes('limit exceeded') ||
      lowerText.includes('service error') ||
      lowerText.includes('internal error') ||
      lowerText.includes('server error')
    ) {
      throw new Error('__SERVER_BUSY__');
    }
    if (text.includes('<title>Error</title>')) {
      throw new Error(
        'O servidor retornou uma página de erro do Google. ' +
        'Verifique se o script está implantado corretamente.'
      );
    }
    throw new Error(
      'O servidor retornou uma resposta inesperada. ' +
      'Verifique os logs de execução do Apps Script.'
    );
  }
}

// =================================================================
// ENRIQUECE PAYLOAD com dados de sessão
// =================================================================
function enrichPayload(payload: Record<string, any>): Record<string, any> {
  const enriched = { ...payload };
  const sessionId = getSessionId();
  const user = getSessionUser();

  if (sessionId && !enriched.sessionId) {
    enriched.sessionId = sessionId;
  }
  if (user?.name && !enriched.login && !enriched.driverName && !enriched.userName) {
    enriched.userName = user.name;
  }
  if (user?.category && !enriched.category) {
    enriched.category = user.category;
  }

  return enriched;
}

// =================================================================
// HELPERS
// =================================================================
function isRetryableNetworkError(err: any): boolean {
  return (
    err?.name === 'AbortError' ||
    err?.message?.includes('aborted') ||
    err?.message?.includes('Failed to fetch') ||
    err?.name === 'TypeError'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Backoff exponencial com jitter: 2s, 4s, 8s + ruído aleatório
function calcBackoff(attempt: number): number {
  const base = Math.min(2000 * Math.pow(2, attempt), 16000);
  const jitter = Math.random() * 1500;
  return base + jitter;
}

function normalizeError(err: any): Error {
  if (err?.name === 'AbortError' || err?.message?.includes('aborted')) {
    return new Error(
      'A operação demorou muito para ser concluída (timeout). Verifique sua conexão de rede.'
    );
  }
  if (err?.message?.includes('Failed to fetch') || err?.name === 'TypeError') {
    return new Error(
      'Falha de comunicação com o servidor (Failed to fetch). ' +
      'Certifique-se de que o script está implantado como "App da Web" ' +
      'com acesso "Qualquer pessoa".'
    );
  }
  return err instanceof Error ? err : new Error(String(err?.message || err));
}

// =================================================================
// API GET — leituras via GET (compatível com CORS sem preflight)
// Retries aumentados para 3. Cache automático para actions frequentes.
// =================================================================
export const apiGetCall = async (
  action: string,
  params: Record<string, string> = {},
  retries = 3,  // ← aumentado de 1 para 3
  customTimeout?: number
): Promise<any> => {

  // Verifica cache antes de fazer a requisição
  if (CACHEABLE_ACTIONS.has(action)) {
    const cacheKey = `${action}:${JSON.stringify(params)}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.info(`[GET] Cache hit para "${action}"`);
      return cached;
    }
  }

  const url = new URL(SCRIPT_URL);
  url.searchParams.append('action', action);

  const sessionId = getSessionId();
  if (sessionId) url.searchParams.append('sessionId', sessionId);

  const user = getSessionUser();
  if (user?.name) url.searchParams.append('userName', user.name);

  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const maxRetries = 3;
  const attempt = maxRetries - retries;

  try {
    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      mode: 'cors',
      credentials: credentialsMode,
      cache: 'no-store',
      redirect: 'follow',
      timeout: customTimeout || 120000,
    });

    if (!response.ok) {
      throw new Error(`Erro de rede: ${response.status} ${response.statusText}`);
    }

    const result = parseJsonResponse(await response.text());

    if (result.success === false) {
      if (result.sessionExpired) {
        window.dispatchEvent(new CustomEvent('session-expired', { detail: result.error }));
      }
      const error = new Error(result.error || 'O servidor retornou uma falha.');
      (error as any).response = result;
      throw error;
    }

    // Armazena no cache se aplicável
    if (CACHEABLE_ACTIONS.has(action)) {
      const cacheKey = `${action}:${JSON.stringify(params)}`;
      setCache(cacheKey, result);
    }

    return result;

  } catch (err: any) {
    if (retries > 0 && isRetryableNetworkError(err)) {
      const backoff = calcBackoff(attempt);
      console.warn(`[GET] Tentando novamente (${retries} restantes) em ${Math.round(backoff)}ms...`);
      await delay(backoff);
      return apiGetCall(action, params, retries - 1, customTimeout);
    }
    throw normalizeError(err);
  }
};

// =================================================================
// API POST — ponto central de todas as chamadas ao backend
//
// REGRA DE RETRY:
//   Leitura  → retry livre, sem risco de duplicata
//   Escrita  → retry com mesmo idempotencyKey, backend deduplica
//
// Retries aumentados para 3. Backoff exponencial com jitter.
// =================================================================
export const apiCall = async (
  payload: Record<string, any>,
  retries = 3,  // ← aumentado de 1 para 3
  silent = false
): Promise<any> => {
  const action = (payload.action || '').toString();
  const isReadAction = READ_ACTIONS.has(action);

  // Verifica cache antes de fazer a requisição (apenas leituras cacheáveis)
  if (isReadAction && CACHEABLE_ACTIONS.has(action)) {
    const cacheKey = `${action}:${JSON.stringify(payload)}`;
    const cached = getCached(cacheKey);
    if (cached) {
      if (!silent) console.info(`[POST] Cache hit para "${action}"`);
      return cached;
    }
  }

  // Gera o key uma vez por operação de escrita.
  // Se o caller já enviou um key (retry externo), reutiliza.
  const idempotencyKey = !isReadAction
    ? (payload.idempotencyKey || generateIdempotencyKey())
    : undefined;

  const enriched = enrichPayload({
    ...payload,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  const maxRetries = 3;
  const attempt = maxRetries - retries;

  try {
    const response = await fetchWithTimeout(SCRIPT_URL, {
      method: 'POST',
      mode: 'cors',
      credentials: credentialsMode,
      cache: 'no-store',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(enriched),
      timeout: 120000,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (!silent) console.error('[API] Resposta não-ok:', body);
      throw new Error(`Erro de rede: ${response.status} ${response.statusText}`);
    }

    let result: any;
    try {
      result = parseJsonResponse(await response.text());
    } catch (parseErr: any) {
      if (parseErr.message === '__SERVER_BUSY__') {
        if (retries > 0) {
          const backoff = calcBackoff(attempt);
          if (!silent) console.warn(`[API] Servidor ocupado. Tentativa ${attempt + 1}. Retry em ${Math.round(backoff)}ms...`);
          await delay(backoff);
          return apiCall({ ...payload, idempotencyKey }, retries - 1, silent);
        }
        throw new Error('O servidor está sobrecarregado. Aguarde alguns segundos e tente novamente.');
      }
      throw parseErr;
    }

    // Backend confirmou deduplicação — operação já foi processada anteriormente
    if (result.deduplicated) {
      if (!silent) console.info(`[API] ${action} já processado (deduplicated). Ignorando retry.`);
      return { success: true, deduplicated: true };
    }

    if (result.success === false) {
      if (result.sessionExpired) {
        window.dispatchEvent(new CustomEvent('session-expired', { detail: result.error }));
      }

      // Backend sinalizou que é seguro tentar novamente
      if (result.retryable && retries > 0) {
        const backoff = calcBackoff(attempt);
        if (!silent) console.warn(`[API] Servidor ocupado (retryable). Tentativa ${attempt + 1}. Retry em ${Math.round(backoff)}ms...`);
        await delay(backoff);
        return apiCall({ ...payload, idempotencyKey }, retries - 1, silent);
      }

      const error = new Error(result.error || 'O servidor retornou uma falha.');
      (error as any).response = result;
      throw error;
    }

    // Armazena no cache se aplicável
    if (isReadAction && CACHEABLE_ACTIONS.has(action)) {
      const cacheKey = `${action}:${JSON.stringify(payload)}`;
      setCache(cacheKey, result);
    }

    return result;

  } catch (err: any) {
    // Para ações de LEITURA, se falhar por QUALQUER motivo (404, 403, etc.),
    // tentamos imediatamente o fallback via GET para evitar travar a aplicação!
    if (isReadAction) {
      if (!silent) console.warn(`[API] POST para ação de leitura "${action}" falhou: ${err.message || err}. Tentando fallback automático via GET...`);
      try {
        const getParams: Record<string, string> = {};
        Object.entries(payload).forEach(([k, v]) => {
          if (k !== 'action') {
            getParams[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
          }
        });
        return await apiGetCall(action, getParams, 1); // 1 tentativa para ser rápido e silencioso
      } catch (getErr: any) {
        if (!silent) console.error(`[API] Fallback via GET para "${action}" também falhou:`, getErr);
      }
    }

    if (retries > 0 && isRetryableNetworkError(err)) {
      const backoff = calcBackoff(attempt);
      if (isReadAction) {
        if (!silent) console.warn(`[API][READ] Retry por falha de rede (${retries} restantes) em ${Math.round(backoff)}ms...`);
        await delay(backoff);
        return apiCall(payload, retries - 1, silent);
      } else {
        if (!silent) console.warn(`[API][WRITE] Retry com idempotencyKey (${retries} restantes) em ${Math.round(backoff)}ms...`);
        await delay(backoff);
        return apiCall({ ...payload, idempotencyKey }, retries - 1, silent);
      }
    }

    if (!silent) console.error(`[API] Falha definitiva em "${action}":`, err);
    throw normalizeError(err);
  }
};

// =================================================================
// HEALTH CHECK
// =================================================================
export const checkApiConnection = async (): Promise<any> => {
  try {
    // 3 tentativas em total (retries = 2) com 35 segundos de timeout cada para aguentar cold start do Google Apps Script
    return await apiGetCall('health', {}, 2, 35000);
  } catch (err: any) {
    throw normalizeError(err);
  }
};