import { SCRIPT_URL as RAW_SCRIPT_URL } from './components/constants';

const SCRIPT_URL = RAW_SCRIPT_URL.trim();

// Helper para fetch com timeout, para evitar que a aplicação fique travada
// esperando uma resposta do servidor por tempo indeterminado.
async function fetchWithTimeout(resource: RequestInfo, options: RequestInit & { timeout?: number } = {}) {
  // ATUALIZAÇÃO: Timeout padrão aumentado para 30 segundos para maior resiliência.
  const { timeout = 30000 } = options; 
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal  
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Função para testar a conexão com a API do Google Apps Script.
 * Usa uma requisição GET com timeout para um "health check" rápido e seguro.
 * @returns Um objeto com status 'ok' se a conexão for bem-sucedida.
 */
export const checkApiConnection = async () => {
  try {
    // Usamos apiGetCall para aproveitar a lógica de tratamento de erros e CORS já implementada.
    // Passamos uma ação inexistente ou vazia, o que fará o doGet retornar o status padrão "ok".
    const result = await apiGetCall('health');
    return result;

  } catch (err: any) {
     console.error("Falha no teste de conexão com a API:", err);
     
     const errorMessage = err.message || '';
     
     if (err.name === 'AbortError' || errorMessage.includes('aborted')) {
       throw new Error('A conexão com o servidor demorou muito (timeout). Verifique se a URL do script está correta e se ele está implantado.');
     }
     
     // O erro "Failed to fetch" é genérico e acontece quando a requisição nem chega a ser completada (CORS, DNS, Rede)
     if (errorMessage.includes('Failed to fetch') || err.name === 'TypeError') {
        throw new Error('Falha de conexão (Failed to fetch). Isso indica que o navegador bloqueou a requisição. CAUSA MAIS COMUM: O script não foi implantado com acesso para "Qualquer pessoa" (Anyone). Por favor, refaça a implantação no Google Apps Script selecionando "Quem pode acessar: Qualquer pessoa".');
     }
     
     throw new Error(errorMessage || 'Erro desconhecido durante o teste de conexão.');
  }
};

/**
 * Função para fazer chamadas GET à API do Google Apps Script.
 * Usada para buscar dados, como a localização de motoristas, de forma mais
 * compatível com CORS do que POST.
 * @param action A ação a ser executada no backend.
 * @param params Parâmetros adicionais para a query string.
 * @returns A resposta JSON do servidor.
 */
export const apiGetCall = async (action: string, params: Record<string, string> = {}, retries = 1) => {
  const url = new URL(SCRIPT_URL);
  url.searchParams.append('action', action);
  
  // Inclui sessionId e userName se disponível
  const sessionId = localStorage.getItem('bike_app_session_id');
  if (sessionId) {
    url.searchParams.append('sessionId', sessionId);
  }

  const savedUser = localStorage.getItem('bike_app_user');
  if (savedUser) {
    try {
      const user = JSON.parse(savedUser);
      if (user.name) url.searchParams.append('userName', user.name);
    } catch { /* ignore */ }
  }

  Object.entries(params).forEach(([key, value]) => url.searchParams.append(key, value));

  try {
    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      timeout: 30000,
    });

    if (!response.ok) {
        throw new Error(`Erro de rede na chamada GET: ${response.status} ${response.statusText}`);
    }

    const textResponse = await response.text();
    let result;
    try {
        result = JSON.parse(textResponse);
    } catch {
        console.error("Falha ao parsear a resposta JSON (GET):", textResponse);
        let detailedError = "O servidor retornou uma resposta inesperada (não-JSON) para uma requisição GET. Isso pode indicar um erro no script do Google. ";
        if (textResponse.includes('<title>Error</title>')) {
          detailedError += " A resposta parece ser uma página de erro do Google.";
        }
        throw new Error(detailedError);
    }

    if (result.success === false) { 
      if (result.sessionExpired) {
        window.dispatchEvent(new CustomEvent('session-expired', { detail: result.error }));
      }
      throw new Error(result.error || 'O servidor (GET) retornou uma falha sem especificar o motivo.');
    }
    return result;

  } catch (err: any) {
    if (retries > 0 && (err.name === 'AbortError' || err.message.includes('aborted') || err.message.includes('Failed to fetch'))) {
      console.warn(`Tentando novamente a chamada GET (${retries} tentativas restantes)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return apiGetCall(action, params, retries - 1);
    }

    console.error(`Falha na chamada GET da API para ${url.toString()}.`, err);
    if (err.name === 'AbortError' || err.message.includes('aborted')) {
      throw new Error('A busca de dados demorou muito para responder (timeout).');
    }
    if (err.message.includes('Failed to fetch') || err.name === 'TypeError') {
      throw new Error('Falha de comunicação com o servidor (Failed to fetch). Isso indica que o navegador bloqueou a requisição. CAUSA MAIS COMUM: O script não foi implantado com acesso para "Qualquer pessoa" (Anyone). Por favor, refaça a implantação no Google Apps Script selecionando "Quem pode acessar: Qualquer pessoa".');
    }
    throw err;
  }
};


/**
 * Função centralizada para fazer chamadas à API do Google Apps Script.
 * Usa 'Content-Type: text/plain' para evitar a verificação CORS "pre-flight"
 * e inclui um timeout para robustez.
 * @param payload O objeto de dados a ser enviado como corpo da requisição.
 * @param retries Número de tentativas em caso de falha (padrão 1).
 * @returns A resposta JSON do servidor.
 */
export const apiCall = async (payload: any, retries = 1, silent = false): Promise<any> => {
  try {
    // Tenta obter o nome e sessionId do usuário logado
    const savedUser = localStorage.getItem('bike_app_user');
    let userName = '';
    let storedSessionId = localStorage.getItem('bike_app_session_id');

    if (savedUser) {
      try {
        const user = JSON.parse(savedUser);
        userName = user.name;
        if (!storedSessionId && user.sessionId) {
          storedSessionId = user.sessionId;
        }
      } catch {
        // Ignora erro de parse
      }
    }

    const enrichedPayload = { ...payload };
    
    // Garante que o sessionId seja enviado se disponível
    if (storedSessionId && !enrichedPayload.sessionId) {
      enrichedPayload.sessionId = storedSessionId;
    }

    // Garante que a identidade do usuário seja enviada se disponível
    if (userName && !enrichedPayload.login && !enrichedPayload.driverName && !enrichedPayload.userName) {
      enrichedPayload.userName = userName;
    }

    const response = await fetchWithTimeout(SCRIPT_URL, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify(enrichedPayload),
      redirect: 'follow', // Essencial para seguir o redirecionamento do Google
      // ATUALIZAÇÃO: Timeout aumentado para 60 segundos para operações que podem demorar mais.
      timeout: 60000, 
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "Não foi possível ler o corpo do erro.");
        if (!silent) console.error("API response error body:", errorBody);
        throw new Error(`Erro de rede: ${response.status} ${response.statusText}`);
    }

    const textResponse = await response.text();
    let result;
    try {
        result = JSON.parse(textResponse);
    } catch {
        console.error("Falha ao parsear a resposta JSON:", textResponse);
        
        // Se a resposta contiver erros típicos de concorrência do Google
        if (textResponse.includes('Service invoked too many times') || 
            textResponse.includes('Too many simultaneous invocations') ||
            textResponse.includes('ScriptError')) {
          
          if (retries > 0) {
            const backoff = (2 - retries + 1) * 2000 + Math.random() * 1000;
            if (!silent) console.warn(`Servidor sobrecarregado. Tentando novamente em ${Math.round(backoff)}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            return apiCall(payload, retries - 1, silent);
          }
          throw new Error('O servidor está com muitos acessos simultâneos no momento. Por favor, aguarde alguns segundos e tente novamente.');
        }

        let detailedError = "O servidor retornou uma resposta inesperada (não-JSON). Isso geralmente indica um erro no script do Google. ";
        detailedError += "Verifique os logs de execução do script para mais detalhes.";
        
        if (textResponse.includes('<title>Error</title>') || textResponse.includes('the script completed but did not return anything')) {
          detailedError += " A resposta parece ser uma página de erro do Google.";
        }
        throw new Error(detailedError);
    }

    if (result.success === false) { 
      if (result.sessionExpired) {
        window.dispatchEvent(new CustomEvent('session-expired', { detail: result.error }));
      }
      throw new Error(result.error || 'O servidor retornou uma falha sem especificar o motivo.');
    }

    return result;

  } catch (err: any) {
    if (retries > 0 && (err.name === 'AbortError' || err.message.includes('aborted') || err.message.includes('Failed to fetch'))) {
      if (!silent) console.warn(`Tentando novamente a chamada da API (${retries} tentativas restantes)...`);
      // Espera um pouco antes de tentar novamente
      await new Promise(resolve => setTimeout(resolve, 2000));
      return apiCall(payload, retries - 1, silent);
    }

    if (!silent) console.error(`Falha na chamada da API para ${SCRIPT_URL}. Payload: ${JSON.stringify(payload)}`, err);
    if (err.name === 'AbortError' || err.message.includes('aborted')) {
      throw new Error('A operação demorou muito para ser concluída (timeout). Verifique sua conexão de rede ou a performance do servidor.');
    }
    if (err.message.includes('Failed to fetch') || err.name === 'TypeError') {
      throw new Error('Falha de comunicação com o servidor (Failed to fetch). Isso indica que o navegador bloqueou a requisição. CAUSA MAIS COMUM: O script não foi implantado com acesso para "Qualquer pessoa" (Anyone). Por favor, refaça a implantação no Google Apps Script selecionando "Quem pode acessar: Qualquer pessoa".');
    }
    throw err;
  }
};
