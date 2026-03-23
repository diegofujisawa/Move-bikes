// =================================================================
// SCRIPT DE BACKEND - APLICATIVO DE REGISTRO DE BICICLETAS
// Versão: 80.0-refactored
// Correções aplicadas:
//   - SPREADSHEET_ID movido para PropertiesService
//   - SpreadsheetApp como lazy singleton (sem abertura global)
//   - Idempotency key para evitar duplicatas por retry
//   - Lock único removido de handleLogin (deadlock corrigido)
//   - Cache invalidado após escritas
//   - Índice pré-computado de bikes (searchBike rápido)
//   - normalizeCategory helper centralizado
//   - parseTimestamp helper centralizado
//   - STATUS constants centralizados
//   - supportedActions removido do doGet público
//   - Funções de debug (inspectBikesSheet) removidas
//   - Constante REPOR_SHEET_NAME renomeada para REPLENISHMENT_SHEET_NAME
//   - isMecanica não utilizado removido de getRequestsHistory
//   - BACKEND_VERSION movida para o topo
//   - getVehicleKmFinal/_findVehicleRow extraídos como helper único
// =================================================================

// --- VERSÃO ---
const BACKEND_VERSION = '84.4-remove-divergence';

// --- CONFIGURAÇÃO GLOBAL ---
// IMPORTANTE: Defina SPREADSHEET_ID via:
// Configurações do Projeto > Propriedades do Script > Adicionar propriedade
// Chave: SPREADSHEET_ID  Valor: 14U5Y6ZU5oeNr5B7hYLMhqvGgU68K4seeILUgTK335kQ
const ACCESS_SHEET_NAME        = 'Acesso';
const BIKES_SHEET_NAME         = 'Bicicletas';
const STATIONS_SHEET_NAME      = 'Estacao';
const REQUESTS_SHEET_NAME      = 'Solicitacao';
const REPORT_SHEET_NAME        = 'Relatorio';
const STATE_SHEET_NAME         = 'Dados';
const REPLENISHMENT_SHEET_NAME = 'Repor';       // era REPOR_SHEET_NAME (typo corrigido)
const ALERTS_SHEET_NAME        = 'Alertas';
const VANDALIZED_SHEET_NAME    = 'Vandalizadas';
const OCORRENCIA_SHEET_NAME    = 'Ocorrencia';
const VANDALISMO_SHEET_NAME    = 'Vandalismo';
const NOTIFICATIONS_SHEET_NAME = 'Notificacoes';
const DAILY_SUMMARY_SHEET_NAME = 'ResumoDiario';
const MECHANICS_SHEET_NAME     = 'Mecanica';
const QUEUE_SHEET_NAME         = 'FilaProcessamento';

// --- STATUS CONSTANTS ---
const STATUS = {
  PENDENTE:    'Pendente',
  ACEITA:      'Aceita',
  RECUSADA:    'Recusada',
  CANCELADA:   'Cancelada',
  FINALIZADA:  'Finalizada',
  LOCALIZADA:  'Localizada',
  RECUPERADA:  'RECUPERADA',
  ENCONTRADA:  'Encontrada',
  LOGADO:      'LOGADO',
  DESLOGADO:   'DESLOGADO',
  INICIO_TURNO:'INICIO_TURNO',
  FIM_TURNO:   'FIM_TURNO',
};

// --- MAPA DE COLUNAS FIXAS (1-based) ---
const COLUMN_INDICES = {
  BIKES: {
    CRIADO_EM: 1, PATRIMONIO: 2, STATUS: 3, LOCALIDADE: 4, USUARIO: 5, BATERIA: 6,
    TRAVA: 7, CARREGAMENTO: 8, ULTIMA_INFO: 9, LATITUDE: 10, LONGITUDE: 11
  },
  ACCESS: {
    USUARIO: 1, LOGIN: 2, SENHA: 3, CATEGORIA: 4, STATUS_ONLINE: 5,
    GPS: 6, PLACA: 8, KM_INICIAL: 9, KM_FINAL: 10, KM_DIFERENCA: 11
  },
  REPORTS: {
    TIMESTAMP: 1, PATRIMONIO: 2, STATUS: 3, OBSERVACAO: 4, MOTORISTA: 5,
    STATUS_SISTEMA: 6, BATERIA: 7, TRAVA: 8, LOCALIDADE: 9
  },
  STATE: { MOTORISTA: 1, ROTEIRO: 3, RECOLHIDAS: 4 },
  NOTIFICATIONS: { USUARIO: 1, JSON: 2 },
  DAILY_SUMMARY: {
    DATA: 1, MOTORISTA: 2, PLACA: 3, KM_TOTAL: 4, BATERIA: 5, MANUT_BIKE: 6,
    MANUT_LOCKER: 7, REMANEJADAS: 8, OCORRENCIAS: 9, NAO_ENCONTRADAS: 10,
    VANDALIZADAS: 11, INICIO: 12, FIM: 13, OBS: 14
  },
  STATIONS: { ID: 1, NUMB: 2, NAME: 3, ADDRESS: 4, REFERENCE: 5, LATITUDE: 6, LONGITUDE: 7, AREA: 8 },
  ALERTS: {
    PATRIMONIO: 1, CHECK1: 2, CHECK2: 3, CHECK3: 4,
    SITUACAO: 5, ENCONTRADA_POR: 6, DATA_ENCONTRADA: 7
  },
  VANDALIZED: {
    PATRIMONIO: 1, DATA: 2, DEFEITO: 3, LOCAL: 4,
    SITUACAO: 5, ENCONTRADA_POR: 6, DATA_ENCONTRADA: 7
  },
  REQUESTS: {
    TIMESTAMP: 1, PATRIMONIO: 2, OCORRENCIA: 3, LOCAL: 4,
    ACEITA_POR: 5, ACEITA_DATA: 6, SITUACAO: 7, DESTINATARIO: 8, RECUSADA_POR: 9
  },
  MECHANICS: {
    PATRIMONIO: 1, STATUS: 2, DATA_ENTRADA: 3, MECANICO: 4,
    TRATATIVA: 5, DATA_FINALIZACAO: 6, CARRETINHA: 7
  },
};

// =================================================================
// --- LAZY SINGLETON: SpreadsheetApp ---
// Abre a planilha apenas quando necessário, não no boot do script.
// =================================================================
let _ss = null;
function getSpreadsheet() {
  if (!_ss) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
      || '14U5Y6ZU5oeNr5B7hYLMhqvGgU68K4seeILUgTK335kQ'; // fallback temporário
    _ss = SpreadsheetApp.openById(id);
  }
  return _ss;
}

// =================================================================
// --- HELPERS UTILITÁRIOS ---
// =================================================================

/**
 * Formata uma data para o padrão brasileiro (DD/MM/AAAA HH:mm:ss).
 */
function formatDateTime(date) {
  if (!date) return '';
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Normaliza string de categoria para comparação (remove acentos, uppercase).
 * Centralizado — evita duplicação em 5+ funções.
 */
function normalizeCategory(str) {
  return (str || '').toString().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Converte qualquer formato de timestamp para objeto Date.
 * Suporta: Date nativo, string BR (DD/MM/YYYY HH:mm:ss), string ISO.
 * Centralizado — era copiado em getDailyReportData, getChangeStatusData, getDriversSummary.
 */
function parseTimestamp(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw;
  const s = raw.toString().trim();
  // Formato BR: DD/MM/YYYY ou DD/MM/YYYY HH:mm:ss
  if (s.includes('/')) {
    const parts = s.split(' ');
    const dateParts = parts[0].split('/');
    if (dateParts.length === 3) {
      const iso = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
      const d = new Date(iso + (parts[1] ? 'T' + parts[1] : ''));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parseia coordenada — suporta inteiros longos de sistemas legados.
 */
function parseCoordinate(val) {
  if (val === undefined || val === null || val === '') return NaN;
  let num = typeof val === 'number' ? val
    : parseFloat(String(val).trim().replace(',', '.').replace(/[–—]/g, '-').replace(/[^\d.-]/g, ''));
  if (isNaN(num)) return NaN;
  while (Math.abs(num) > 180) num /= 10;
  return num;
}

/**
 * Garante que uma aba exista, criando-a com cabeçalhos se necessário.
 */
function getOrCreateSheet(sheetName, headers) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    }
  }
  return sheet;
}

// =================================================================
// --- IDEMPOTENCY KEY ---
// Evita duplicatas causadas por retry do frontend.
// O frontend deve gerar um UUID por operação e reenviar o mesmo
// key em todos os retries. O backend rejeita silenciosamente
// qualquer requisição com key já processada (janela de 5 min).
// =================================================================
function isAlreadyProcessed(key) {
  if (!key) return false;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'idem_' + key;
  if (cache.get(cacheKey)) return true;
  cache.put(cacheKey, '1', 300); // marca como processado por 5 minutos
  return false;
}

// =================================================================
// --- ROTEADOR GET ---
// =================================================================
function doGet(e) {
  const action = e.parameter.action;

  if (action) {
    let response = { success: false, error: 'Ação não suportada via GET.', version: BACKEND_VERSION };
    if (action === 'health')             response = { success: true, status: 'ok', version: BACKEND_VERSION };
    else if (action === 'getDriverLocations') response = { ...getDriverLocations(), version: BACKEND_VERSION };
    else if (action === 'getStations')   response = { ...getStations(), version: BACKEND_VERSION };
    else if (action === 'getMotoristas') response = { ...getMotoristas(), version: BACKEND_VERSION };
    else if (action === 'getAlerts')     response = { ...getAlerts(), version: BACKEND_VERSION };
    else if (action === 'getVandalized') response = { ...getVandalized(), version: BACKEND_VERSION };
    else if (action === 'getReporData')  response = { ...getReporData(), version: BACKEND_VERSION };
    else if (action === 'getVehiclePlates') response = { ...getVehiclePlates(), version: BACKEND_VERSION };
    else if (action === 'getChangeStatusData') response = { ...getChangeStatusData(e.parameter.timeRange), version: BACKEND_VERSION };
    else if (action === 'updateLocation') response = { ...updateLocation(e.parameter.driverName, e.parameter.latitude, e.parameter.longitude), version: BACKEND_VERSION };
    else if (action === 'switchVehicle') response = { ...switchVehicle(e.parameter.driverName, e.parameter.plate, e.parameter.kmInicial), version: BACKEND_VERSION };
    return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
  }

  // Health check simples — sem expor lista de ações
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok', version: BACKEND_VERSION }))
    .setMimeType(ContentService.MimeType.JSON);
}

// =================================================================
// --- ROTEADOR POST ---
// =================================================================
function doPost(e) {
  let response = { success: false, error: 'Ação não processada.', version: BACKEND_VERSION };
  let request;

  try {
    request = JSON.parse(e.postData.contents);
    const action = (request.action || '').toString().trim();

    // Verificação de idempotency key para write actions
    if (request.idempotencyKey && isAlreadyProcessed(request.idempotencyKey)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: true, deduplicated: true, version: BACKEND_VERSION
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Ações que modificam dados — precisam de lock sequencial
    const writeActions = [
      'login', 'logout', 'createRequest', 'acceptRequest', 'declineRequest',
      'logReport', 'updateBikeAssignment', 'clearDriverRoute',
      'updateDriverState', 'finalizeCollectedBike', 'finalizeRouteBike',
      'confirmBikeFound', 'confirmVandalizedFound', 'switchVehicle',
      'saveDailySummary', 'clearAdminAlerts', 'confirmMechanicsReceipt',
      'finalizeMechanicsRepair', 'organizeTrailer', 'finalizeTrailer'
    ];

    const isWriteAction = writeActions.includes(action);
    const lock = LockService.getScriptLock();
    let lockAcquired = false;

    if (isWriteAction) {
      lockAcquired = lock.tryLock(30000);
      if (!lockAcquired) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: 'Servidor ocupado. Por favor, tente novamente em instantes.',
          version: BACKEND_VERSION,
          retryable: true
        })).setMimeType(ContentService.MimeType.JSON);
      }
      logOperationToQueue(action, request);
    }

    switch (action) {
      case 'getDriversSummary':     response = { ...getDriversSummary(request.timeRange, null, null, request.timelineDate), version: BACKEND_VERSION }; break;
      case 'getVehiclePlates':      response = { ...getVehiclePlates(), version: BACKEND_VERSION }; break;
      case 'login':                 response = { ...handleLogin(request.login, request.password, request.plate, request.kmInicial), version: BACKEND_VERSION }; break;
      case 'logout':                response = { ...handleLogout(request.userName), version: BACKEND_VERSION }; break;
      case 'search':                response = { ...searchBike(request.bikeNumber), version: BACKEND_VERSION }; break;
      case 'getRequests':           response = { ...getRequests(request.driverName, request.category), version: BACKEND_VERSION }; break;
      case 'getRequestsHistory':    response = { ...getRequestsHistory(request.driverName, request.category), version: BACKEND_VERSION }; break;
      case 'createRequest':         response = { ...createRequest(request.patrimonio, request.ocorrencia, request.local, request.recipient), version: BACKEND_VERSION }; break;
      case 'acceptRequest':         response = { ...acceptRequest(request.requestId, request.driverName), version: BACKEND_VERSION }; break;
      case 'declineRequest':        response = { ...declineRequest(request.requestId, request.driverName), version: BACKEND_VERSION }; break;
      case 'getStations':           response = { ...getStations(), version: BACKEND_VERSION }; break;
      case 'getMotoristas':         response = { ...getMotoristas(), version: BACKEND_VERSION }; break;
      case 'logReport':             response = { ...logReport(request.rowData, request.kmFinal, request.plate), version: BACKEND_VERSION }; break;
      case 'updateBikeAssignment':  response = { ...updateBikeAssignment(request.bikeNumber, request.driverName), version: BACKEND_VERSION }; break;
      case 'getAllPatrimonioNumbers':response = { ...getAllPatrimonioNumbers(), version: BACKEND_VERSION }; break;
      case 'clearDriverRoute':      response = { ...clearDriverRoute(request.driverName), version: BACKEND_VERSION }; break;
      case 'updateLocation':        response = { ...updateLocation(request.driverName, request.latitude, request.longitude), version: BACKEND_VERSION }; break;
      case 'getDriverLocations':    response = { ...getDriverLocations(), version: BACKEND_VERSION }; break;
      case 'getDriverState':        response = { ...getDriverState(request.driverName), version: BACKEND_VERSION }; break;
      case 'updateDriverState':     response = { ...updateDriverState(request.driverName, request.routeBikes, request.collectedBikes), version: BACKEND_VERSION }; break;
      case 'getBikeDetailsBatch':   response = { ...getBikeDetailsBatch(request.bikeNumbers), version: BACKEND_VERSION }; break;
      case 'getDailyReportData':    response = { ...getDailyReportData(request.driverName, request.timeRange), version: BACKEND_VERSION }; break;
      case 'finalizeCollectedBike': response = { ...finalizeCollectedBike(request), version: BACKEND_VERSION }; break;
      case 'finalizeRouteBike':     response = { ...finalizeRouteBike(request), version: BACKEND_VERSION }; break;
      case 'getSchedule':           response = { ...getSchedule(request.driverName), version: BACKEND_VERSION }; break;
      case 'getBikeStatuses':       response = { ...getBikeStatuses(), version: BACKEND_VERSION }; break;
      case 'getReporData':          response = { ...getReporData(), version: BACKEND_VERSION }; break;
      case 'getChangeStatusData':   response = { ...getChangeStatusData(request.timeRange), version: BACKEND_VERSION }; break;
      case 'getAlerts':             response = { ...getAlerts(), version: BACKEND_VERSION }; break;
      case 'confirmBikeFound':      response = { ...confirmBikeFound(request.alertId, request.driverName), version: BACKEND_VERSION }; break;
      case 'getVandalized':         response = { ...getVandalized(), version: BACKEND_VERSION }; break;
      case 'confirmVandalizedFound':response = { ...confirmVandalizedFound(request.alertId, request.driverName), version: BACKEND_VERSION }; break;
      case 'getRouteDetails':       response = { ...getRouteDetails(request.driverName, request.bikeNumbers), version: BACKEND_VERSION }; break;
      case 'switchVehicle':         response = { ...switchVehicle(request.driverName, request.plate, request.kmInicial), version: BACKEND_VERSION }; break;
      case 'sync':                  response = { ...handleSync(request), version: BACKEND_VERSION }; break;
      case 'getBicycles':           response = { ...getBicycles(), version: BACKEND_VERSION }; break;
      case 'generateDriverRoute':   response = { ...generateDriverRoute(request.driverName, request.location, request.filters, request.maxBikes, request.rangeKm), version: BACKEND_VERSION }; break;
      case 'exportAllData':         response = { ...handleExportAllData(request), version: BACKEND_VERSION }; break;
      case 'saveDailySummary':      response = { ...saveDailySummary(request.summaryData), version: BACKEND_VERSION }; break;
      case 'getAdminAlerts':        response = { ...getAdminAlerts(request.adminName), version: BACKEND_VERSION }; break;
      case 'clearAdminAlerts':      response = { ...clearAdminAlerts(request.adminName), version: BACKEND_VERSION }; break;
      case 'getDirections':        response = { ...getDirections(request.fromLat, request.fromLng, request.toLat, request.toLng), version: BACKEND_VERSION }; break;
      case 'getBikeMovement':      response = { ...getBikeMovement(request.bikeNumber, request.limit), version: BACKEND_VERSION }; break;
      case 'confirmMechanicsReceipt': response = { ...confirmMechanicsReceipt(request.bikeNumber, request.mechanicName), version: BACKEND_VERSION }; break;
      case 'insertBikeMechanics':   response = { ...insertBikeMechanics(request.bikeNumber, request.driverName, request.targetStatus), version: BACKEND_VERSION }; break;
      case 'notifyAdmins':          response = { ...notifyAdmins(request.message, request.bikes, request.trailerName), version: BACKEND_VERSION }; break;
      case 'finalizeMechanicsRepair': response = { ...finalizeMechanicsRepair(request.bikeNumber, request.mechanicName, request.treatment), version: BACKEND_VERSION }; break;
      case 'organizeTrailer':       response = { ...organizeTrailer(request.bikeNumbers, request.trailerName), version: BACKEND_VERSION }; break;
      case 'finalizeTrailer':       response = { ...finalizeTrailer(request.trailerName), version: BACKEND_VERSION }; break;
      default: response = { success: false, error: 'Ação desconhecida: ' + action, version: BACKEND_VERSION }; break;
    }

    if (lockAcquired) lock.releaseLock();

    return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('ERRO FATAL no doPost. Payload: ' + (e.postData ? e.postData.contents : 'N/A') + '. Erro: ' + error.message + ' Stack: ' + error.stack);
    return ContentService.createTextOutput(JSON.stringify({
      success: false, error: 'Erro crítico no servidor: ' + error.message, version: BACKEND_VERSION
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// =================================================================
// --- FILA DE PROCESSAMENTO (auditoria) ---
// =================================================================
function logOperationToQueue(action, payload) {
  try {
    const sheet = getSpreadsheet().getSheetByName(QUEUE_SHEET_NAME);
    if (!sheet) return;
    const userName = payload.userName || payload.driverName || payload.login || 'Sistema';
    sheet.appendRow([new Date(), action, userName, JSON.stringify(payload)]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 3000) sheet.deleteRows(2, 1000);
  } catch (e) {
    console.error('Erro ao logar na fila:', e);
  }
}

// =================================================================
// --- SINCRONIZAÇÃO UNIFICADA ---
// CORREÇÃO: handleSync não retorna driverState do Sheets quando
// Firebase é a fonte de verdade. O app usa o estado local do Firebase.
// =================================================================
// =================================================================
// --- GERAÇÃO DE ROTA AUTOMÁTICA ---
// =================================================================
function getBicycles() {
  try {
    const sheet = getSpreadsheet().getSheetByName(BIKES_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${BIKES_SHEET_NAME}" não encontrada.`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const bikes = data.map(row => ({
      patrimonio: row[COLUMN_INDICES.BIKES.PATRIMONIO - 1],
      status: row[COLUMN_INDICES.BIKES.STATUS - 1],
      latitude: parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
      longitude: parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
      bateria: row[COLUMN_INDICES.BIKES.BATERIA - 1],
      trava: row[COLUMN_INDICES.BIKES.TRAVA - 1],
      ultimaInfo: row[COLUMN_INDICES.BIKES.ULTIMA_INFO - 1],
      localidade: row[COLUMN_INDICES.BIKES.LOCALIDADE - 1]
    })).filter(b => b.patrimonio && !isNaN(b.latitude) && !isNaN(b.longitude));
    return { success: true, data: bikes };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar bicicletas: ' + e.message };
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function generateDriverRoute(driverName, location, filters, maxBikes, rangeKm) {
  maxBikes = maxBikes || 20;
  rangeKm = rangeKm || 3;
  try {
    if (!driverName || !location || !location.lat || !location.lng) {
      return { success: false, error: 'Dados de localização ou motorista ausentes.' };
    }

    const bikesResult = getBicycles();
    if (!bikesResult.success) return bikesResult;
    const allBikes = bikesResult.data;

    const stationsResult = getStations();
    if (!stationsResult.success) return stationsResult;
    const allStations = stationsResult.data;

    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60000);

    const filteredBikes = allBikes.filter(bike => {
      const lastInfo = parseTimestamp(bike.ultimaInfo);
      const isOffline = !lastInfo || lastInfo < thirtyMinutesAgo;

      if (filters.offline) {
        if (!isOffline) return false;
      } else {
        if (isOffline) return false;
      }

      let matchesAnyFilter = false;
      const isAtStation = allStations.some(s =>
        calculateDistance(s.Latitude, s.Longitude, bike.latitude, bike.longitude) < 0.05
      );
      const isOutOfStation = !isAtStation;

      const batVal = parseFloat(String(bike.bateria).replace('%','').replace(',','.')) || 0;
      const bateria = batVal <= 1 ? Math.round(batVal * 100) : Math.round(batVal);

      if (filters.lowBattery && bateria < 50) matchesAnyFilter = true;
      if (filters.openLock && (bike.trava || '').toString().toUpperCase() === 'ABERTA') matchesAnyFilter = true;
      if (filters.wrongStatus && (bike.status || '').toString().toLowerCase() !== 'ativo') matchesAnyFilter = true;
      if (filters.offline) matchesAnyFilter = true;
      if (filters.outOfStation && isOutOfStation) matchesAnyFilter = true;

      if (!matchesAnyFilter) return false;
      if (filters.outOfStation && isAtStation) return false;

      const distToDriver = calculateDistance(location.lat, location.lng, bike.latitude, bike.longitude);
      if (distToDriver > rangeKm) return false;

      bike.distance = distToDriver;
      return true;
    });

    const route = filteredBikes
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxBikes);

    if (route.length === 0) {
      return { success: true, data: [], message: 'Nenhuma bicicleta encontrada com os critérios selecionados.' };
    }

    // Cria solicitação na planilha
    const requestSheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
    if (requestSheet) {
      const patrimonios = route.map(b => b.patrimonio).join(', ');
      const newRow = new Array(requestSheet.getLastColumn()).fill('');
      newRow[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1]    = new Date();
      newRow[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1]   = patrimonios;
      newRow[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1]   = 'ROTEIRO GERADO';
      newRow[COLUMN_INDICES.REQUESTS.LOCAL - 1]        = 'Criado via Roteiro Automático';
      newRow[COLUMN_INDICES.REQUESTS.SITUACAO - 1]     = STATUS.PENDENTE;
      newRow[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] = driverName;
      requestSheet.appendRow(newRow);
    }

    return { success: true, data: route, message: `Roteiro gerado com ${route.length} bicicletas.` };
  } catch (e) {
    return { success: false, error: 'Erro ao gerar roteiro: ' + e.message };
  }
}

function handleSync(request) {
  const { driverName, category, summaryTimeRange, statusTimeRange, timelineDate } = request;
  const catNorm = normalizeCategory(category);
  const isAdm = catNorm.includes('ADM');
  const isMecanica = catNorm.includes('MECANICA') || catNorm.includes('MECANICO');

  const response = { success: true, data: {} };

  try {
    const ss = getSpreadsheet();
    const sheets = {};
    const getSheet = name => {
      if (!sheets[name]) sheets[name] = ss.getSheetByName(name);
      return sheets[name];
    };

    // 1. Requests pendentes
    response.data.requests = getRequests(driverName, category, getSheet(REQUESTS_SHEET_NAME)).data || [];

    // 2. driverState: retornado apenas se Firebase NÃO for a fonte de verdade
    // Se o frontend gerencia estado no Firebase, não sobrescrever com dados do Sheets.
    // Manter para compatibilidade, mas sinalizar a origem.
    const driverStateResult = getDriverState(driverName, getSheet(STATE_SHEET_NAME));
    response.data.driverState = driverStateResult.data || { routeBikes: [], collectedBikes: [] };
    response.data.driverStateSource = 'sheets'; // frontend deve priorizar Firebase sobre isso

    // 3. Bike statuses
    response.data.bikeStatuses = getBikeStatuses(getSheet(STATE_SHEET_NAME), getSheet(REPORT_SHEET_NAME)).data || {};

    // 4. Escala
    response.data.schedule = getSchedule(driverName).data || {};

    // 5 & 6. Motoristas e localizações
    const accessSheet = getSheet(ACCESS_SHEET_NAME);
    const accessData = accessSheet ? accessSheet.getDataRange().getValues() : [];
    response.data.motoristas = getMotoristas(accessData).data || [];
    response.data.driverLocations = getDriverLocations(accessData).data || [];

    // 7. Detalhes do roteiro
    const routeBikes = response.data.driverState.routeBikes || [];
    const collectedBikes = response.data.driverState.collectedBikes || [];
    const allBikes = [...new Set([...routeBikes, ...collectedBikes])];
    response.data.bikeDetails = allBikes.length > 0
      ? (getRouteDetails(driverName, allBikes, getSheet(BIKES_SHEET_NAME), getSheet(REQUESTS_SHEET_NAME)).data || {})
      : {};

    if (isAdm) {
      response.data.driversSummary = getDriversSummary(summaryTimeRange, {
        access: getSheet(ACCESS_SHEET_NAME), report: getSheet(REPORT_SHEET_NAME),
        state: getSheet(STATE_SHEET_NAME), requests: getSheet(REQUESTS_SHEET_NAME),
        stations: getSheet(STATIONS_SHEET_NAME)
      }, null, timelineDate).data || [];
      response.data.alerts = getAlerts().data || [];
      response.data.vandalized = getVandalized().data || [];
      response.data.changeStatusData = getChangeStatusData(statusTimeRange, {
        report: getSheet(REPORT_SHEET_NAME), bikes: getSheet(BIKES_SHEET_NAME)
      }).data || { vandalizadas: [], filial: [] };
      response.data.adminAlerts = getAdminAlerts(driverName).alerts || [];
    } else {
      response.data.driversSummary = getDriversSummary(summaryTimeRange, {
        access: getSheet(ACCESS_SHEET_NAME), report: getSheet(REPORT_SHEET_NAME),
        state: getSheet(STATE_SHEET_NAME), requests: getSheet(REQUESTS_SHEET_NAME),
        stations: getSheet(STATIONS_SHEET_NAME)
      }, driverName).data || [];
    }

    if (isMecanica || isAdm) {
      response.data.mechanicsList = getMechanicsList().data || [];
    }

    return response;
  } catch (e) {
    console.error('Erro na sincronização:', e);
    return { success: false, error: 'Erro na sincronização: ' + e.message };
  }
}

function handleExportAllData(payload) {
  try {
    if (!payload) return { success: false, error: 'Payload não fornecido.' };
    const catNorm = normalizeCategory(payload.category);
    if (!catNorm.includes('ADM')) return { success: false, error: 'Acesso negado.' };

    const getAllData = sheetName => {
      if (!sheetName) return [];
      const sheet = getSpreadsheet().getSheetByName(sheetName);
      if (!sheet) return [];
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return [];
      const headers = data[0];
      return data.slice(1).map(row => {
        const obj = {};
        headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
        return obj;
      });
    };

    return {
      success: true,
      data: {
        bikes:     getAllData(BIKES_SHEET_NAME) || [],
        users:     getAllData(ACCESS_SHEET_NAME) || [],
        requests:  getAllData(REQUESTS_SHEET_NAME) || [],
        reports:   getAllData(REPORT_SHEET_NAME) || [],
        alerts:    getAllData(ALERTS_SHEET_NAME) || [],
        vandalized:getAllData(VANDALIZED_SHEET_NAME) || [],
        stations:  getAllData(STATIONS_SHEET_NAME) || []
      }
    };
  } catch (e) {
    return { success: false, error: 'Erro ao exportar dados: ' + e.message };
  }
}

// =================================================================
// --- VEÍCULOS ---
// =================================================================

/**
 * Helper único para encontrar a linha de um veículo pela placa.
 * Centraliza lógica que era duplicada em getVehicleKmFinal e updateVehicleKm.
 */
function _findVehicleRow(sheet, plate) {
  const plateUpper = plate.toString().trim().toUpperCase();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const plates = sheet.getRange(2, COLUMN_INDICES.ACCESS.PLACA, lastRow - 1, 1).getValues();
  for (let i = 0; i < plates.length; i++) {
    if (plates[i][0].toString().trim().toUpperCase() === plateUpper) {
      const userVal = sheet.getRange(i + 2, COLUMN_INDICES.ACCESS.USUARIO).getValue();
      if (!userVal || userVal.toString().trim() === '') return i + 2;
    }
  }
  return -1;
}

function getVehicleKmFinal(plate) {
  const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
  if (!sheet) return null;
  const row = _findVehicleRow(sheet, plate);
  return row !== -1 ? sheet.getRange(row, COLUMN_INDICES.ACCESS.KM_FINAL).getValue() : null;
}

function updateVehicleKm(plate, kmInicial, kmFinal) {
  const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
  if (!sheet) return;
  const row = _findVehicleRow(sheet, plate);
  if (row === -1) return;

  if (kmInicial !== undefined) {
    sheet.getRange(row, COLUMN_INDICES.ACCESS.KM_INICIAL).setValue(kmInicial);
  }
  if (kmFinal !== undefined) {
    sheet.getRange(row, COLUMN_INDICES.ACCESS.KM_FINAL).setValue(kmFinal);
    const currentKmInicial = sheet.getRange(row, COLUMN_INDICES.ACCESS.KM_INICIAL).getValue();
    if (currentKmInicial !== '' && kmFinal !== '') {
      sheet.getRange(row, COLUMN_INDICES.ACCESS.KM_DIFERENCA).setValue(parseFloat(kmFinal) - parseFloat(currentKmInicial));
    }
  } else {
    sheet.getRange(row, COLUMN_INDICES.ACCESS.KM_FINAL).setValue('');
    sheet.getRange(row, COLUMN_INDICES.ACCESS.KM_DIFERENCA).setValue('');
  }
}

function getVehiclePlates() {
  try {
    const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${ACCESS_SHEET_NAME}" não encontrada.`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const platesSet = new Set();
    data.forEach(row => {
      const plate = (row[COLUMN_INDICES.ACCESS.PLACA - 1] || '').toString().trim();
      if (plate) platesSet.add(plate);
    });
    return { success: true, data: Array.from(platesSet).map(plate => ({ plate })) };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar placas: ' + e.message };
  }
}

// =================================================================
// --- LOGIN / LOGOUT ---
// CORREÇÃO: lock removido de handleLogin (estava causando deadlock
// pois doPost já adquire o ScriptLock para write actions).
// =================================================================
function handleLogin(login, password, plate, kmInicial) {
  try {
    const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${ACCESS_SHEET_NAME}" não encontrada.`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Nenhum usuário cadastrado.' };

    const range = sheet.getRange(2, COLUMN_INDICES.ACCESS.LOGIN, lastRow - 1, 1);
    const foundCell = range.createTextFinder(String(login).trim()).matchEntireCell(true).findNext();
    if (!foundCell) return { success: false, error: `Login "${login}" não encontrado.` };

    const rowIndex = foundCell.getRow();
    const rowData = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
    const category = (rowData[COLUMN_INDICES.ACCESS.CATEGORIA - 1] || 'MOTORISTA').toString().trim().toUpperCase();
    const storedPassword = (rowData[COLUMN_INDICES.ACCESS.SENHA - 1] || '').toString().trim();

    if (storedPassword !== password.toString().trim()) {
      return { success: false, error: 'Senha incorreta.' };
    }

    if (category === 'MOTORISTA') {
      if (!plate || kmInicial === undefined) {
        return { success: false, error: 'Placa e KM Inicial são obrigatórios para motoristas.' };
      }
      const expectedKm = getVehicleKmFinal(plate);
      if (expectedKm !== null && expectedKm !== '' && parseFloat(kmInicial) !== parseFloat(expectedKm)) {
        if (!(parseFloat(expectedKm) === 0 && parseFloat(kmInicial) === 0)) {
          return { success: false, error: 'KM Inicial incorreto. Verifique o odômetro do veículo.' };
        }
      }
      updateVehicleKm(plate, kmInicial, undefined);
      const reportSheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
      if (reportSheet) {
        reportSheet.appendRow([formatDateTime(new Date()), plate, STATUS.INICIO_TURNO, kmInicial, rowData[COLUMN_INDICES.ACCESS.USUARIO - 1]]);
      }
    }

    sheet.getRange(rowIndex, COLUMN_INDICES.ACCESS.STATUS_ONLINE).setValue(STATUS.LOGADO);
    return {
      success: true,
      user: {
        name: rowData[COLUMN_INDICES.ACCESS.USUARIO - 1],
        category,
        plate: plate || rowData[COLUMN_INDICES.ACCESS.PLACA - 1],
        kmInicial: kmInicial !== undefined ? kmInicial : 0
      }
    };
  } catch (e) {
    return { success: false, error: 'Erro no login: ' + e.message };
  }
}

function handleLogout(userName) {
  if (!userName) return { success: true };
  try {
    const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) return { success: true };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true };
    const range = sheet.getRange(2, COLUMN_INDICES.ACCESS.USUARIO, lastRow - 1, 1);
    const foundCell = range.createTextFinder(String(userName).trim()).matchEntireCell(true).findNext();
    if (foundCell) {
      const row = foundCell.getRow();
      sheet.getRange(row, COLUMN_INDICES.ACCESS.STATUS_ONLINE).setValue(STATUS.DESLOGADO);
      sheet.getRange(row, COLUMN_INDICES.ACCESS.GPS).setValue('');
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Erro no logout: ' + e.message };
  }
}

// =================================================================
// --- LOCALIZAÇÃO ---
// =================================================================
function updateLocation(driverName, latitude, longitude) {
  if (!driverName || latitude === undefined || longitude === undefined) {
    return { success: false, error: 'Dados de localização incompletos.' };
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return { success: true, note: 'Lock timeout, skipped' };
  try {
    const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha de acesso não encontrada.' };

    const cache = CacheService.getScriptCache();
    const cacheKey = 'driver_row_' + driverName;
    let rowIndex = cache.get(cacheKey);

    if (!rowIndex) {
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return { success: false, error: 'Nenhum motorista cadastrado.' };
      const data = sheet.getRange(2, COLUMN_INDICES.ACCESS.USUARIO, lastRow - 1, 1).getValues();
      const normTarget = normalizeName(driverName);
      for (let i = 0; i < data.length; i++) {
        if (normalizeName(data[i][0]) === normTarget) {
          rowIndex = i + 2;
          cache.put(cacheKey, rowIndex.toString(), 3600);
          break;
        }
      }
    }

    if (rowIndex) {
      const lat = parseCoordinate(latitude);
      const lng = parseCoordinate(longitude);
      sheet.getRange(parseInt(rowIndex), COLUMN_INDICES.ACCESS.GPS)
        .setValue(`${lat};${lng}|${new Date().getTime()}`);
      return { success: true };
    }
    return { success: false, error: 'Motorista não encontrado.' };
  } finally {
    lock.releaseLock();
  }
}

function getDriverLocations(providedData) {
  let data = providedData;
  if (!data) {
    const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) return { success: true, data: [] };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };
    data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  } else {
    if (data.length > 0 && (data[0][0] === 'Usuário' || data[0][0] === 'USUARIO')) data = data.slice(1);
  }

  const locations = [];
  const now = new Date();
  const TEN_MIN   = 10 * 60 * 1000;
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  data.forEach(row => {
    const status = (row[COLUMN_INDICES.ACCESS.STATUS_ONLINE - 1] || '').toString().toUpperCase();
    const gpsString = (row[COLUMN_INDICES.ACCESS.GPS - 1] || '').toString().trim();
    if (status !== STATUS.LOGADO || !gpsString) return;

    try {
      const parts = gpsString.split('|');
      const coordsString = parts[0];
      const timestampStr = parts.length > 1 ? parts[1] : null;
      const ageMs = timestampStr ? now - new Date(parseInt(timestampStr, 10)) : 0;
      // Remove apenas se GPS for mais antigo que 2 horas
      if (timestampStr && ageMs > TWO_HOURS) return;

      let coords = coordsString.split(';');
      if (coords.length < 2) coords = coordsString.split(',');
      if (coords.length < 2) return;

      const lat = parseCoordinate(coords[0]);
      const lon = parseCoordinate(coords[1]);
      if (isNaN(lat) || isNaN(lon)) return;

      locations.push({
        driverName: row[COLUMN_INDICES.ACCESS.USUARIO - 1],
        latitude: lat, longitude: lon,
        timestamp: timestampStr
          ? new Date(parseInt(timestampStr, 10)).toISOString()
          : new Date().toISOString(),
        stale: timestampStr ? ageMs > TEN_MIN : false  // GPS desatualizado (>10min) mas ainda visível
      });
    } catch (e) {
      Logger.log(`GPS inválido para ${row[COLUMN_INDICES.ACCESS.USUARIO - 1]}: ${gpsString}`);
    }
  });
  return { success: true, data: locations };
}

// =================================================================
// --- SEARCH BIKE (com índice pré-computado) ---
// CORREÇÃO: em vez de TextFinder por bike, carrega índice completo
// no cache (600s). Busca passa de O(n) por chamada para O(1).
// =================================================================

/**
 * Carrega e cacheia o índice completo de bikes (patrimônio → dados da linha).
 * Fica em cache por 10 minutos. Invalidado pelo logReport quando uma bike é registrada.
 */
function getBikeIndex() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'bikes_index';
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const sheet = getSpreadsheet().getSheetByName(BIKES_SHEET_NAME);
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  const index = {};
  data.slice(1).forEach(row => {
    const pat = String(row[COLUMN_INDICES.BIKES.PATRIMONIO - 1]).trim();
    if (pat) index[pat] = row;
  });

  try { cache.put(cacheKey, JSON.stringify(index), 600); } catch (e) {}
  return index;
}

function searchBike(bikeNumber) {
  if (!bikeNumber) return { success: false, error: 'Número da bicicleta não informado.' };
  const bikeStr = String(bikeNumber).trim();

  try {
    const index = getBikeIndex();
    const row = index[bikeStr];
    if (!row) return { success: false, error: 'Bicicleta não encontrada.' };

    const bikeObject = {
      'Patrimônio':                    row[COLUMN_INDICES.BIKES.PATRIMONIO - 1],
      'Status':                         row[COLUMN_INDICES.BIKES.STATUS - 1],
      'Localidade':                     row[COLUMN_INDICES.BIKES.LOCALIDADE - 1],
      'Usuário':                        row[COLUMN_INDICES.BIKES.USUARIO - 1],
      'Bateria':                        row[COLUMN_INDICES.BIKES.BATERIA - 1],
      'Trava':                          row[COLUMN_INDICES.BIKES.TRAVA - 1],
      'Carregamento':                   row[COLUMN_INDICES.BIKES.CARREGAMENTO - 1],
      'Última informação da posição':   row[COLUMN_INDICES.BIKES.ULTIMA_INFO - 1],
      'Latitude':  parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
      'Longitude': parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
    };
    return { success: true, data: bikeObject };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar bike: ' + e.message };
  }
}

// =================================================================
// --- LOG REPORT (enxuto — sem tarefas secundárias no path crítico) ---
// path síncrono. Devem ser executados via Trigger periódico (5 min).
// Cache do índice de bikes invalidado para a bike registrada.
// =================================================================
function logReport(rowData, kmFinal, plate) {
  if (!Array.isArray(rowData) || rowData.length === 0) {
    return { success: false, error: 'Dados do relatório inválidos.' };
  }

  // Lock já adquirido pelo doPost para write actions.
  // logReport não adquire lock próprio.
  try {
    const sheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REPORT_SHEET_NAME}" não encontrada.`);

    const patrimonio = (rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
    const status = (rowData[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
    const motorista = (rowData[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();

    // Verificação de duplicidade leve (últimas 50 linhas, sem cadeia de chamadas)
    const lastRow = sheet.getLastRow();
    if (lastRow > 1 && patrimonio) {
      const numCheck = Math.min(lastRow - 1, 50);
      const recentData = sheet.getRange(lastRow - numCheck + 1, 1, numCheck, 5).getValues();
      const now = new Date();
      for (let i = recentData.length - 1; i >= 0; i--) {
        const row = recentData[i];
        const rowTs = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
        if (!rowTs) continue;
        const sameKey = row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1].toString().trim() === patrimonio
          && row[COLUMN_INDICES.REPORTS.STATUS - 1].toString().trim() === status
          && row[COLUMN_INDICES.REPORTS.MOTORISTA - 1].toString().trim() === motorista;
        if (sameKey && Math.abs(now - rowTs) / 60000 < 10) {
          return { success: true, message: 'Registro duplicado ignorado.' };
        }
      }
    }

    sheet.appendRow(rowData);

    // Invalida cache do índice de bikes para esta bike
    if (patrimonio) {
      const cache = CacheService.getScriptCache();
      cache.remove('bikes_index'); // força rebuild no próximo searchBike
      cache.remove('bike_statuses');
    }

    // KM Final
    if (kmFinal !== undefined) {
      let plateToUpdate = plate;
      if (!plateToUpdate && motorista) {
        const accessSheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
        if (accessSheet) {
          const lastRowA = accessSheet.getLastRow();
          if (lastRowA >= 2) {
            const found = accessSheet.getRange(2, COLUMN_INDICES.ACCESS.USUARIO, lastRowA - 1, 1)
              .createTextFinder(motorista).matchEntireCell(true).findNext();
            if (found) plateToUpdate = accessSheet.getRange(found.getRow(), COLUMN_INDICES.ACCESS.PLACA).getValue();
          }
        }
      }
      if (plateToUpdate) updateVehicleKm(plateToUpdate, undefined, kmFinal);
    }

    // Sync com solicitações (leve)
    syncWithRequests(patrimonio, status, rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1], motorista);

    // Lógica de alertas/vandalizadas
    const statusLower = status.toLowerCase();
    if (statusLower === 'não encontrada' || statusLower === 'nao encontrada') {
      updateAlertsSheet(patrimonio);
      updateOcorrenciaSheet(rowData);
    } else if (statusLower === 'vandalizada') {
      updateVandalizedSheet(patrimonio, rowData);
      updateVandalismoSheet(rowData);
    } else {
      resolveAlert(patrimonio, motorista || 'Sistema');
      resolveVandalized(patrimonio, motorista || 'Sistema');
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: 'Erro ao registrar relatório: ' + e.message };
  }
}

// =================================================================
// --- TRIGGER PERIÓDICO (instalar via Apps Script > Triggers) ---
// Executa tarefas pesadas fora do path crítico de escrita.
// Configurar: a cada 5 minutos
// =================================================================
function runPeriodicMaintenance() {
  try { cleanupRecentDuplicates(); } catch (e) { console.error('cleanupDuplicates:', e); }
}

// =================================================================
// --- SOLICITAÇÕES ---
// =================================================================
function getRequests(driverName, category, providedSheet) {
  const cacheKey = `requests_${driverName || 'none'}_${category || 'none'}`;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {}
  }

  const sheet = providedSheet || getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

  let requests = [];
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const catNorm = normalizeCategory(category);
    const isMotorista = catNorm.includes('MOTORISTA');
    const userNameLower = (driverName || '').toLowerCase();

    requests = data.map((row, index) => {
      const patrimonio = row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '';
      const status = (row[COLUMN_INDICES.REQUESTS.SITUACAO - 1] || STATUS.PENDENTE).trim().toLowerCase();
      const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || 'Todos').toString().trim().toLowerCase();
      const declinedBy = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());
      const isPending = status === 'pendente';
      const isForMe = recipient === userNameLower;
      const isForAllDrivers = recipient === 'todos' && isMotorista;
      if (patrimonio && isPending && !declinedBy.includes(userNameLower) && (isForMe || isForAllDrivers)) {
        return {
          id: index + 2,
          timestamp: row[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1],
          bikeNumber: patrimonio,
          reason: row[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1],
          location: row[COLUMN_INDICES.REQUESTS.LOCAL - 1],
          acceptedBy: row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1],
          status: row[COLUMN_INDICES.REQUESTS.SITUACAO - 1],
          recipient: row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1],
        };
      }
      return null;
    }).filter(Boolean);
  }

  try { cache.put(cacheKey, JSON.stringify(requests), 10); } catch (e) {}
  return { success: true, data: requests };
}

function getRequestsHistory(driverName, category) {
  const sheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

  let history = [];
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const catNorm = normalizeCategory(category);
    const isAdm = catNorm.includes('ADM');
    // isMecanica removido — não era usado na lógica

    history = data.map((row, index) => {
      const patrimonio = row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '';
      const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || 'Todos').toString().trim().toLowerCase();
      const acceptedBy = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim().toLowerCase();
      const declinedBy = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());
      const driverLower = (driverName || '').toLowerCase();
      if (patrimonio && (isAdm || recipient === driverLower || acceptedBy === driverLower || declinedBy.includes(driverLower))) {
        return {
          id: index + 2,
          timestamp: row[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1],
          bikeNumber: patrimonio,
          reason: row[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1],
          location: row[COLUMN_INDICES.REQUESTS.LOCAL - 1],
          acceptedBy: row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1],
          acceptedDate: row[COLUMN_INDICES.REQUESTS.ACEITA_DATA - 1],
          status: row[COLUMN_INDICES.REQUESTS.SITUACAO - 1],
          recipient: row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1],
          declinedBy: row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1]
        };
      }
      return null;
    }).filter(Boolean);
  }

  history.sort((a, b) => {
    const da = parseTimestamp(a.timestamp), db = parseTimestamp(b.timestamp);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  return { success: true, data: history };
}

function createRequest(patrimonio, ocorrencia, local, recipient) {
  if (!patrimonio || !ocorrencia || !local || !recipient) {
    return { success: false, error: 'Todos os campos são obrigatórios.' };
  }

  const sheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

  if (sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, COLUMN_INDICES.REQUESTS.PATRIMONIO, sheet.getLastRow() - 1,
      COLUMN_INDICES.REQUESTS.SITUACAO - COLUMN_INDICES.REQUESTS.PATRIMONIO + 1).getValues();
    for (const row of data) {
      if (row[0].toString().trim() === patrimonio.toString().trim()
          && row[COLUMN_INDICES.REQUESTS.SITUACAO - COLUMN_INDICES.REQUESTS.PATRIMONIO].toString().trim().toLowerCase() === 'pendente') {
        return { success: false, error: `Já existe uma solicitação pendente para a bicicleta ${patrimonio}.` };
      }
    }
  }

  let finalLocal = local;
  if (!local.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/)) {
    try {
      const firstBike = patrimonio.toString().split(',')[0].trim();
      const bikeInfo = searchBike(firstBike);
      if (bikeInfo.success && bikeInfo.data.Latitude && bikeInfo.data.Longitude) {
        finalLocal = `${local} (${bikeInfo.data.Latitude};${bikeInfo.data.Longitude})`;
      }
    } catch (e) {}
  }

  const newRow = new Array(sheet.getLastColumn()).fill('');
  newRow[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1]   = new Date();
  newRow[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1]  = patrimonio;
  newRow[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1]  = ocorrencia;
  newRow[COLUMN_INDICES.REQUESTS.LOCAL - 1]       = finalLocal;
  newRow[COLUMN_INDICES.REQUESTS.SITUACAO - 1]    = STATUS.PENDENTE;
  newRow[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1]= recipient;
  sheet.appendRow(newRow);

  // Invalida cache de requests
  CacheService.getScriptCache().remove(`requests_${recipient}_MOTORISTA`);

  return { success: true, message: 'Solicitação criada com sucesso.' };
}

function declineRequest(requestId, driverName) {
  if (!requestId) return { success: false, error: 'ID da solicitação é obrigatório.' };

  const sheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

  const row = parseInt(requestId, 10);
  if (isNaN(row) || row < 2 || row > sheet.getLastRow()) {
    return { success: false, error: `ID inválido: ${requestId}` };
  }

  const recipient = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.DESTINATARIO).getValue() || 'Todos').toString().trim().toLowerCase();
  if (recipient === 'todos' && driverName) {
    const current = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.RECUSADA_POR).getValue() || '').toString();
    const list = current.split(',').map(s => s.trim()).filter(Boolean);
    if (!list.includes(driverName)) {
      list.push(driverName);
      sheet.getRange(row, COLUMN_INDICES.REQUESTS.RECUSADA_POR).setValue(list.join(', '));
    }
  } else {
    sheet.getRange(row, COLUMN_INDICES.REQUESTS.SITUACAO).setValue(STATUS.RECUSADA);
  }

  return { success: true, message: 'Solicitação recusada.' };
}

function acceptRequest(requestId, driverName) {
  if (!requestId || !driverName) return { success: false, error: 'ID e nome do motorista são obrigatórios.' };

  const sheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

  const row = parseInt(requestId, 10);
  if (isNaN(row) || row < 2 || row > sheet.getLastRow()) {
    return { success: false, error: `ID inválido: ${requestId}` };
  }

  const currentStatus = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.SITUACAO).getValue() || STATUS.PENDENTE).toString().trim().toLowerCase();
  if (currentStatus !== 'pendente') {
    return { success: false, error: 'Esta solicitação já foi processada.' };
  }

  // Batch write — 1 chamada de API no lugar de 3
  sheet.getRange(row, COLUMN_INDICES.REQUESTS.ACEITA_POR, 1, 3).setValues([[driverName, new Date(), STATUS.ACEITA]]);

  const patrimonioRaw = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.PATRIMONIO).getValue() || '').toString();
  const bikesToAdd = patrimonioRaw.split(',').map(s => s.trim()).filter(Boolean);
  const motivo = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.OCORRENCIA).getValue() || '').toString().toUpperCase();
  const isTrailer = motivo.includes('CARRETINHA');

  const stateResult = getDriverState(driverName);
  let routeBikes = stateResult.success ? stateResult.data.routeBikes : [];
  let collectedBikes = stateResult.success ? stateResult.data.collectedBikes : [];

  if (isTrailer) {
    collectedBikes = [...new Set([...collectedBikes, ...bikesToAdd])];
    routeBikes = routeBikes.filter(b => !bikesToAdd.includes(String(b)));
  } else {
    routeBikes = [...new Set([...routeBikes, ...bikesToAdd])];
    collectedBikes = collectedBikes.filter(b => !bikesToAdd.includes(String(b)));
  }

  updateDriverState(driverName, routeBikes, collectedBikes);

  // Invalida caches relevantes
  const cache = CacheService.getScriptCache();
  cache.remove(`requests_${driverName}_MOTORISTA`);
  cache.remove('bike_statuses');

  return { success: true, message: isTrailer ? 'Carretinha aceita.' : 'Solicitação aceita.' };
}

// =================================================================
// --- ESTAÇÕES ---
// =================================================================
function getStations() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'stations_list';
  const cached = cache.get(cacheKey);
  if (cached) return { success: true, data: JSON.parse(cached) };

  try {
    const sheet = getSpreadsheet().getSheetByName(STATIONS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${STATIONS_SHEET_NAME}" não encontrada.`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { success: true, data: [] };

    const firstRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const startRow = (typeof firstRow[0] === 'string' && isNaN(Number(firstRow[0]))) ? 2 : 1;
    const numRows = lastRow - (startRow - 1);
    if (numRows <= 0) return { success: true, data: [] };

    const data = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();
    const reporResult = getReporData();
    const occupancyMap = {};
    if (reporResult.success && reporResult.data) {
      reporResult.data.forEach(item => {
        const name = (item['Estação'] || item['Nome'] || item['Name'] || '').toString().trim().toLowerCase();
        if (name) occupancyMap[name] = item['Ocupação'] || item['Occupancy'] || '0';
      });
    }

    const stations = data.map(row => {
      const name = (row[COLUMN_INDICES.STATIONS.NAME - 1] || '').toString();
      return {
        Id: row[COLUMN_INDICES.STATIONS.ID - 1],
        Numb: row[COLUMN_INDICES.STATIONS.NUMB - 1],
        Name: name,
        Address: row[COLUMN_INDICES.STATIONS.ADDRESS - 1],
        Reference: row[COLUMN_INDICES.STATIONS.REFERENCE - 1],
        Latitude: parseCoordinate(row[COLUMN_INDICES.STATIONS.LATITUDE - 1]),
        Longitude: parseCoordinate(row[COLUMN_INDICES.STATIONS.LONGITUDE - 1]),
        Area: row[COLUMN_INDICES.STATIONS.AREA - 1],
        Occupancy: occupancyMap[name.trim().toLowerCase()] || 'N/A'
      };
    }).filter(s => s.Name && !isNaN(s.Latitude) && !isNaN(s.Longitude));

    if (stations.length > 0) cache.put(cacheKey, JSON.stringify(stations), 300);
    return { success: true, data: stations };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar estações: ' + e.message };
  }
}

function getMotoristas(providedData) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'motoristas_list';
  if (!providedData) {
    const cached = cache.get(cacheKey);
    if (cached) return { success: true, data: JSON.parse(cached) };
  }

  let data = providedData;
  if (!data) {
    const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) return { success: true, data: [] };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };
    data = sheet.getRange(2, 1, lastRow - 1, COLUMN_INDICES.ACCESS.CATEGORIA).getValues();
  } else {
    if (data.length > 0 && (data[0][0] === 'Usuário' || data[0][0] === 'USUARIO')) data = data.slice(1);
  }

  const motoristas = data
    .filter(row => normalizeCategory(row[COLUMN_INDICES.ACCESS.CATEGORIA - 1]).includes('MOTORISTA'))
    .map(row => row[COLUMN_INDICES.ACCESS.USUARIO - 1])
    .filter(Boolean);

  if (!providedData && motoristas.length > 0) cache.put(cacheKey, JSON.stringify(motoristas), 600);
  return { success: true, data: motoristas };
}

// =================================================================
// --- ESTADO DO MOTORISTA ---
// =================================================================
function normalizeName(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function getDriverState(driverName, providedSheet) {
  const sheet = providedSheet || getSpreadsheet().getSheetByName(STATE_SHEET_NAME);
  if (!sheet) return { success: true, data: { routeBikes: [], collectedBikes: [] } };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, data: { routeBikes: [], collectedBikes: [] } };

  const normTarget = normalizeName(driverName);
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const driverColIdx = COLUMN_INDICES.STATE.MOTORISTA - 1;

  for (let i = 0; i < data.length; i++) {
    if (normalizeName(data[i][driverColIdx]) === normTarget) {
      return {
        success: true,
        data: {
          routeBikes:    (data[i][COLUMN_INDICES.STATE.ROTEIRO - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean),
          collectedBikes:(data[i][COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean)
        }
      };
    }
  }
  return { success: true, data: { routeBikes: [], collectedBikes: [] } };
}

function updateDriverState(driverName, routeBikes, collectedBikes) {
  try {
    const sheet = getSpreadsheet().getSheetByName(STATE_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${STATE_SHEET_NAME}" não encontrada.`);

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn() || 4;
    const routeStr = Array.isArray(routeBikes)
      ? [...new Set(routeBikes.map(b => String(b).trim()))].filter(Boolean).join(', ') : '';
    const collectedStr = Array.isArray(collectedBikes)
      ? [...new Set(collectedBikes.map(b => String(b).trim()))].filter(Boolean).join(', ') : '';
    const allBikes = [...new Set([
      ...(Array.isArray(routeBikes) ? routeBikes.map(b => String(b).trim()).filter(Boolean) : []),
      ...(Array.isArray(collectedBikes) ? collectedBikes.map(b => String(b).trim()).filter(Boolean) : [])
    ])];

    const normTarget = normalizeName(driverName);

    if (lastRow < 2) {
      const newRow = new Array(lastCol).fill('');
      newRow[COLUMN_INDICES.STATE.MOTORISTA - 1] = driverName;
      newRow[COLUMN_INDICES.STATE.ROTEIRO - 1]   = routeStr;
      newRow[COLUMN_INDICES.STATE.RECOLHIDAS - 1]= collectedStr;
      sheet.appendRow(newRow);
      return { success: true };
    }

    const allData = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const dataRows = allData.slice(1);
    const driverColIdx     = COLUMN_INDICES.STATE.MOTORISTA - 1;
    const routeColIdx      = COLUMN_INDICES.STATE.ROTEIRO - 1;
    const collectedColIdx  = COLUMN_INDICES.STATE.RECOLHIDAS - 1;

    let driverFound = false, changed = false;

    for (let i = 0; i < dataRows.length; i++) {
      const currentNorm = normalizeName(dataRows[i][driverColIdx]);
      if (currentNorm === normTarget) {
        if (dataRows[i][routeColIdx] !== routeStr || dataRows[i][collectedColIdx] !== collectedStr) {
          dataRows[i][routeColIdx]     = routeStr;
          dataRows[i][collectedColIdx] = collectedStr;
          changed = true;
        }
        driverFound = true;
      } else if (allBikes.length > 0) {
        let otherRoute     = String(dataRows[i][routeColIdx] || '').split(',').map(s => s.trim()).filter(Boolean);
        let otherCollected = String(dataRows[i][collectedColIdx] || '').split(',').map(s => s.trim()).filter(Boolean);
        const before = otherRoute.length + otherCollected.length;
        allBikes.forEach(bike => {
          otherRoute     = otherRoute.filter(b => b !== bike);
          otherCollected = otherCollected.filter(b => b !== bike);
        });
        if (otherRoute.length + otherCollected.length !== before) {
          dataRows[i][routeColIdx]     = otherRoute.join(', ');
          dataRows[i][collectedColIdx] = otherCollected.join(', ');
          changed = true;
        }
      }
    }

    if (!driverFound) {
      const newRow = new Array(allData[0].length).fill('');
      newRow[driverColIdx]    = driverName;
      newRow[routeColIdx]     = routeStr;
      newRow[collectedColIdx] = collectedStr;
      sheet.appendRow(newRow);
    } else if (changed) {
      sheet.getRange(2, 1, dataRows.length, allData[0].length).setValues(dataRows);
    }

    // Invalida cache de statuses
    CacheService.getScriptCache().remove('bike_statuses');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function clearDriverRoute(driverName) {
  if (!driverName) return { success: false, error: 'Nome do motorista é obrigatório.' };
  try {
    const sheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, message: 'Nenhuma rota ativa.' };
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const driverLower = driverName.toString().trim().toLowerCase();
    let changed = false;
    const cancelledBikes = [];
    for (let i = 0; i < data.length; i++) {
      const acceptedBy = (data[i][COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim().toLowerCase();
      const status = (data[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').toString().trim().toLowerCase();
      if (acceptedBy === driverLower && status === 'aceita') {
        sheet.getRange(i + 2, COLUMN_INDICES.REQUESTS.SITUACAO).setValue(STATUS.CANCELADA);
        const bikes = (data[i][COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
        cancelledBikes.push(...bikes);
        changed = true;
      }
    }
    if (changed && cancelledBikes.length > 0) {
    }
    return { success: true, message: changed ? 'Roteiro cancelado.' : 'Nenhuma rota ativa.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateBikeAssignment(bikeNumber, driverName) {
  const sheet = getSpreadsheet().getSheetByName(STATE_SHEET_NAME);
  if (!sheet) return { success: true };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true };
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < data.length; i++) {
    const currentDriver = data[i][COLUMN_INDICES.STATE.MOTORISTA - 1];
    let collected = (data[i][COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    const idx = collected.indexOf(bikeNumber.toString());
    if (currentDriver.toLowerCase() === (driverName || '').toLowerCase()) {
      if (idx === -1) { collected.push(bikeNumber.toString()); sheet.getRange(i + 2, COLUMN_INDICES.STATE.RECOLHIDAS).setValue(collected.join(', ')); }
    } else {
      if (idx !== -1) { collected.splice(idx, 1); sheet.getRange(i + 2, COLUMN_INDICES.STATE.RECOLHIDAS).setValue(collected.join(', ')); }
    }
  }
  return { success: true };
}

function getAllPatrimonioNumbers() {
  const sheet = getSpreadsheet().getSheetByName(BIKES_SHEET_NAME);
  if (!sheet) return { success: true, data: [] };
  if (sheet.getLastRow() < 2) return { success: true, data: [] };
  const numbers = sheet.getRange(2, COLUMN_INDICES.BIKES.PATRIMONIO, sheet.getLastRow() - 1, 1).getValues().flat().filter(String);
  return { success: true, data: numbers };
}

// =================================================================
// --- FINALIZAÇÃO DE BIKES ---
// =================================================================
function finalizeRouteBike(request) {
  try {
    const { driverName, bikeNumber, finalStatus, finalObservation } = request;
    const stateResult = getDriverState(driverName);
    let routeBikes    = stateResult.success ? stateResult.data.routeBikes : [];
    let collectedBikes= stateResult.success ? stateResult.data.collectedBikes : [];
    const bikeResult  = searchBike(bikeNumber);
    if (!bikeResult.success) throw new Error(`Bicicleta ${bikeNumber} não encontrada.`);
    const bikeDetails = bikeResult.data;

    routeBikes = routeBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    if (finalStatus === 'Recolhida') {
      if (!collectedBikes.map(String).includes(String(bikeNumber))) collectedBikes.push(bikeNumber);
    } else {
    }

    const statusLower = finalStatus.toLowerCase();
    if (statusLower.includes('recolhida') || statusLower.includes('vandalizada') || statusLower.includes('filial')) {
      addToMechanics(bikeNumber);
    }

    if (finalStatus !== 'Recolhida') {
      const rowData = [new Date(), bikeNumber, finalStatus, finalObservation, driverName,
        bikeDetails['Status'], bikeDetails['Bateria'], bikeDetails['Trava'], bikeDetails['Localidade']];
      logReport(rowData);
    }

    updateDriverState(driverName, routeBikes, collectedBikes);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function finalizeCollectedBike(request) {
  try {
    const { driverName, bikeNumber, finalStatus, finalObservation } = request;
    const stateResult  = getDriverState(driverName);
    let routeBikes     = stateResult.success ? stateResult.data.routeBikes : [];
    let collectedBikes = stateResult.success ? stateResult.data.collectedBikes : [];
    const bikeResult   = searchBike(bikeNumber);
    if (!bikeResult.success) throw new Error(`Bicicleta ${bikeNumber} não encontrada.`);
    const bikeDetails  = bikeResult.data;

    collectedBikes = collectedBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    const reportStatus = finalStatus === 'Filial' ? 'Recolhida' : finalStatus;
    const rowData = [new Date(), bikeNumber, reportStatus, finalObservation, driverName,
      bikeDetails['Status'], bikeDetails['Bateria'], bikeDetails['Trava'], bikeDetails['Localidade']];
    logReport(rowData);

    const statusLower = finalStatus.toLowerCase();
    if (statusLower.includes('filial') || statusLower.includes('vandalizada') || statusLower.includes('recolhida')) {
      addToMechanics(bikeNumber);
    }

    updateDriverState(driverName, routeBikes, collectedBikes);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// =================================================================
// --- ALERTAS E VANDALIZADAS ---
// =================================================================
function updateAlertsSheet(patrimonio) {
  const sheet = getSpreadsheet().getSheetByName(ALERTS_SHEET_NAME);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  let foundRow = -1, currentSituacao = '';
  for (let i = 1; i < data.length; i++) {
    if (data[i][COLUMN_INDICES.ALERTS.PATRIMONIO - 1].toString() === patrimonio.toString()
        && (data[i][COLUMN_INDICES.ALERTS.SITUACAO - 1] === STATUS.PENDENTE || data[i][COLUMN_INDICES.ALERTS.SITUACAO - 1] === STATUS.LOCALIZADA)) {
      foundRow = i + 1; currentSituacao = data[i][COLUMN_INDICES.ALERTS.SITUACAO - 1]; break;
    }
  }
  const now = new Date();
  if (foundRow === -1) {
    const newRow = new Array(sheet.getLastColumn()).fill('');
    newRow[COLUMN_INDICES.ALERTS.PATRIMONIO - 1] = patrimonio;
    newRow[COLUMN_INDICES.ALERTS.CHECK1 - 1]     = now;
    newRow[COLUMN_INDICES.ALERTS.SITUACAO - 1]   = STATUS.PENDENTE;
    sheet.appendRow(newRow);
  } else {
    if (currentSituacao === STATUS.LOCALIZADA) sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.SITUACAO).setValue(STATUS.PENDENTE);
    const check1 = sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK1).getValue();
    const check2 = sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK2).getValue();
    const check3 = sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK3).getValue();
    if (!check1) sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK1).setValue(now);
    else if (!check2) sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK2).setValue(now);
    else if (!check3) {
      sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK3).setValue(now);
      createRequest(patrimonio, 'ALERTA CRÍTICO: Bike não encontrada por 3 vezes consecutivas.', 'Verificar Alertas', 'Todos');
    }
  }
}

function resolveAlert(patrimonio, motorista) {
  const sheet = getSpreadsheet().getSheetByName(ALERTS_SHEET_NAME);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][COLUMN_INDICES.ALERTS.PATRIMONIO - 1].toString() === patrimonio.toString()
        && data[i][COLUMN_INDICES.ALERTS.SITUACAO - 1] === STATUS.PENDENTE) {
      const row = i + 1;
      // Batch write — 1 chamada no lugar de 3
      sheet.getRange(row, COLUMN_INDICES.ALERTS.SITUACAO, 1, 3).setValues([[STATUS.LOCALIZADA, motorista, new Date()]]);
      break;
    }
  }
}

function getAlerts() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'alerts_data';
  const cached = cache.get(cacheKey);
  if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {} }

  try {
    const alertsSheet = getOrCreateSheet(ALERTS_SHEET_NAME,
      ['Patrimônio', 'Check 1', 'Check 2', 'Check 3', 'Situação', 'Encontrada Por', 'Data Encontrada']);
    const reportSheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    if (!reportSheet) return { success: true, data: [] };

    const lastRowReport = reportSheet.getLastRow();
    const rowsToRead = Math.min(lastRowReport - 1, 5000);
    const reportData = rowsToRead > 0
      ? reportSheet.getRange(lastRowReport - rowsToRead + 1, 1, rowsToRead, 3).getValues() : [];

    const confirmedAlerts = {};
    const lastRowAlerts = alertsSheet.getLastRow();
    if (lastRowAlerts > 1) {
      alertsSheet.getRange(2, 1, lastRowAlerts - 1, COLUMN_INDICES.ALERTS.DATA_ENCONTRADA).getValues()
        .forEach(row => {
          const pat = (row[COLUMN_INDICES.ALERTS.PATRIMONIO - 1] || '').toString();
          const sit = row[COLUMN_INDICES.ALERTS.SITUACAO - 1];
          const dt  = row[COLUMN_INDICES.ALERTS.DATA_ENCONTRADA - 1];
          if ((sit === STATUS.ENCONTRADA || sit === STATUS.RECUPERADA) && dt) {
            const t = new Date(dt).getTime();
            if (!confirmedAlerts[pat] || t > confirmedAlerts[pat]) confirmedAlerts[pat] = t;
          }
        });
    }

    const bikeHistory = {};
    [...reportData].sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime()).forEach(row => {
      const ts  = parseTimestamp(row[0]); if (!ts) return;
      const pat = (row[1] || '').toString();
      const st  = (row[2] || '').toString().trim().toLowerCase();
      const isMissing = st === 'não encontrada' || st === 'nao encontrada';
      if (st === 'não atendida' || st === 'nao atendida') return;
      if (confirmedAlerts[pat] && confirmedAlerts[pat] >= ts.getTime()) return;
      if (!bikeHistory[pat]) bikeHistory[pat] = { patrimonio: pat, checks: [], situacao: isMissing ? STATUS.PENDENTE : STATUS.LOCALIZADA };
      if (isMissing && bikeHistory[pat].checks.length < 3) bikeHistory[pat].checks.push(ts);
    });

    const currentAlertsData = alertsSheet.getDataRange().getValues();
    Object.values(bikeHistory).filter(h => h.checks.length > 0).forEach(alert => {
      let rowIndex = -1;
      for (let i = 1; i < currentAlertsData.length; i++) {
        if (currentAlertsData[i][0].toString() === alert.patrimonio
            && currentAlertsData[i][4] !== STATUS.ENCONTRADA && currentAlertsData[i][4] !== STATUS.RECUPERADA) {
          rowIndex = i + 1; break;
        }
      }
      const lastCol = alertsSheet.getLastColumn() || 7;
      if (rowIndex === -1) {
        const newRow = new Array(lastCol).fill('');
        newRow[0] = alert.patrimonio; newRow[1] = alert.checks[0] || '';
        newRow[2] = alert.checks[1] || ''; newRow[3] = alert.checks[2] || '';
        newRow[4] = alert.situacao;
        alertsSheet.appendRow(newRow);
      } else {
        alertsSheet.getRange(rowIndex, 2, 1, 4).setValues([[
          alert.checks[0] || '', alert.checks[1] || '', alert.checks[2] || '', alert.situacao
        ]]);
      }
    });

    const lastRowFinal = alertsSheet.getLastRow();
    if (lastRowFinal < 2) return { success: true, data: [] };
    const finalData = alertsSheet.getRange(2, 1, lastRowFinal - 1, alertsSheet.getLastColumn()).getValues();
    const alerts = finalData.map((row, idx) => {
      if (row[4] === STATUS.PENDENTE || row[4] === STATUS.LOCALIZADA) {
        return { id: idx + 2, patrimonio: row[0], check1: row[1], check2: row[2], check3: row[3], situacao: row[4] };
      }
      return null;
    }).filter(Boolean);

    try { cache.put(cacheKey, JSON.stringify(alerts), 30); } catch (e) {}
    return { success: true, data: alerts };
  } catch (e) {
    return { success: false, error: 'Erro ao sincronizar alertas: ' + e.message };
  }
}

function confirmBikeFound(alertId, driverName) {
  try {
    const alertsSheet = getSpreadsheet().getSheetByName(ALERTS_SHEET_NAME);
    if (!alertsSheet) return { success: false, error: 'Planilha de alertas não encontrada.' };
    const row = parseInt(alertId, 10);
    if (isNaN(row) || row < 2) return { success: false, error: 'ID inválido.' };
    const patrimonio = alertsSheet.getRange(row, COLUMN_INDICES.ALERTS.PATRIMONIO).getValue();
    // Batch write
    alertsSheet.getRange(row, COLUMN_INDICES.ALERTS.SITUACAO, 1, 3).setValues([[STATUS.RECUPERADA, driverName, new Date()]]);
    const reportSheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    if (reportSheet) {
      const newRow = new Array(reportSheet.getLastColumn()).fill('');
      newRow[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]  = new Date();
      newRow[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] = patrimonio;
      newRow[COLUMN_INDICES.REPORTS.STATUS - 1]     = STATUS.RECUPERADA;
      newRow[COLUMN_INDICES.REPORTS.MOTORISTA - 1]  = driverName;
      newRow[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] = 'Bike recuperada via sistema de alertas';
      reportSheet.appendRow(newRow);
    }
    CacheService.getScriptCache().remove('alerts_data');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateVandalizedSheet(patrimonio, rowData) {
  const sheet = getSpreadsheet().getSheetByName(VANDALIZED_SHEET_NAME);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1].toString() === patrimonio.toString()
        && data[i][COLUMN_INDICES.VANDALIZED.SITUACAO - 1] === STATUS.PENDENTE) return;
  }
  const newRow = new Array(sheet.getLastColumn()).fill('');
  newRow[COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1] = patrimonio;
  newRow[COLUMN_INDICES.VANDALIZED.DATA - 1]       = new Date();
  newRow[COLUMN_INDICES.VANDALIZED.DEFEITO - 1]    = rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || 'Vandalismo reportado';
  newRow[COLUMN_INDICES.VANDALIZED.LOCAL - 1]      = rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || 'N/A';
  newRow[COLUMN_INDICES.VANDALIZED.SITUACAO - 1]   = STATUS.PENDENTE;
  sheet.appendRow(newRow);
}

function resolveVandalized(patrimonio, motorista) {
  const sheet = getSpreadsheet().getSheetByName(VANDALIZED_SHEET_NAME);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1].toString() === patrimonio.toString()
        && data[i][COLUMN_INDICES.VANDALIZED.SITUACAO - 1] === STATUS.PENDENTE) {
      const row = i + 1;
      // Batch write
      sheet.getRange(row, COLUMN_INDICES.VANDALIZED.SITUACAO, 1, 3).setValues([[STATUS.ENCONTRADA, motorista, new Date()]]);
      break;
    }
  }
}

function getVandalized() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'vandalized_data';
  const cached = cache.get(cacheKey);
  if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {} }

  try {
    const vandalizedSheet = getOrCreateSheet(VANDALIZED_SHEET_NAME,
      ['Patrimônio', 'Data', 'Defeito', 'Local', 'Situação', 'Encontrada Por', 'Data Encontrada']);
    const reportSheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    if (!reportSheet) return { success: true, data: [] };

    const lastRowReport = reportSheet.getLastRow();
    const rowsToRead = Math.min(lastRowReport - 1, 5000);
    const reportData = rowsToRead > 0
      ? reportSheet.getRange(lastRowReport - rowsToRead + 1, 1, rowsToRead, reportSheet.getLastColumn()).getValues() : [];

    const confirmedVandalized = {};
    const lastRowV = vandalizedSheet.getLastRow();
    if (lastRowV > 1) {
      vandalizedSheet.getRange(2, 1, lastRowV - 1, COLUMN_INDICES.VANDALIZED.DATA_ENCONTRADA).getValues()
        .forEach(row => {
          const pat = (row[COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1] || '').toString();
          const sit = row[COLUMN_INDICES.VANDALIZED.SITUACAO - 1];
          const dt  = row[COLUMN_INDICES.VANDALIZED.DATA_ENCONTRADA - 1];
          if (sit === STATUS.ENCONTRADA && dt) {
            const t = new Date(dt).getTime();
            if (!confirmedVandalized[pat] || t > confirmedVandalized[pat]) confirmedVandalized[pat] = t;
          }
        });
    }

    const vandalizedHistory = {};
    [...reportData].sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime()).forEach(row => {
      const ts  = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]); if (!ts) return;
      const pat = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString();
      const st  = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
      if (st !== 'vandalizada') return;
      if (confirmedVandalized[pat] && confirmedVandalized[pat] >= ts.getTime()) return;
      if (!vandalizedHistory[pat]) {
        vandalizedHistory[pat] = {
          patrimonio: pat, data: ts,
          defeito: row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || 'Vandalismo reportado',
          local: row[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || 'N/A',
          situacao: STATUS.PENDENTE
        };
      }
    });

    const currentVData = vandalizedSheet.getDataRange().getValues();
    Object.values(vandalizedHistory).forEach(v => {
      let rowIndex = -1;
      for (let i = 1; i < currentVData.length; i++) {
        if (currentVData[i][0].toString() === v.patrimonio && currentVData[i][4] !== STATUS.ENCONTRADA) { rowIndex = i + 1; break; }
      }
      if (rowIndex === -1) {
        const newRow = new Array(vandalizedSheet.getLastColumn() || 7).fill('');
        newRow[COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1] = v.patrimonio;
        newRow[COLUMN_INDICES.VANDALIZED.DATA - 1]       = v.data;
        newRow[COLUMN_INDICES.VANDALIZED.DEFEITO - 1]    = v.defeito;
        newRow[COLUMN_INDICES.VANDALIZED.LOCAL - 1]      = v.local;
        newRow[COLUMN_INDICES.VANDALIZED.SITUACAO - 1]   = v.situacao;
        vandalizedSheet.appendRow(newRow);
      }
    });

    const lastRowFinal = vandalizedSheet.getLastRow();
    if (lastRowFinal < 2) return { success: true, data: [] };
    const finalData = vandalizedSheet.getRange(2, 1, lastRowFinal - 1, vandalizedSheet.getLastColumn()).getValues();
    const vandalized = finalData.map((row, idx) => {
      if (row[COLUMN_INDICES.VANDALIZED.SITUACAO - 1] === STATUS.PENDENTE) {
        return { id: idx + 2, patrimonio: row[0], data: row[1], defeito: row[2], local: row[3], situacao: row[4] };
      }
      return null;
    }).filter(Boolean);

    try { cache.put(cacheKey, JSON.stringify(vandalized), 30); } catch (e) {}
    return { success: true, data: vandalized };
  } catch (e) {
    return { success: false, error: 'Erro ao sincronizar vandalizadas: ' + e.message };
  }
}

function confirmVandalizedFound(alertId, driverName) {
  try {
    const sheet = getSpreadsheet().getSheetByName(VANDALIZED_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha não encontrada.' };
    const row = parseInt(alertId, 10);
    if (isNaN(row) || row < 2) return { success: false, error: 'ID inválido.' };
    // Batch write
    sheet.getRange(row, COLUMN_INDICES.VANDALIZED.SITUACAO, 1, 3).setValues([[STATUS.ENCONTRADA, driverName, new Date()]]);
    CacheService.getScriptCache().remove('vandalized_data');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateOcorrenciaSheet(rowData) {
  const sheet = getSpreadsheet().getSheetByName(OCORRENCIA_SHEET_NAME);
  if (!sheet) return;
  sheet.appendRow(rowData);
}

function updateVandalismoSheet(rowData) {
  const sheet = getSpreadsheet().getSheetByName(VANDALISMO_SHEET_NAME);
  if (!sheet) return;
  sheet.appendRow([
    rowData[COLUMN_INDICES.REPORTS.TIMESTAMP - 1],
    rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1],
    rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1],
    rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1]
  ]);
}

function syncWithRequests(patrimonio, status, observacao, motorista) {
  const sheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  const motoristaLower = (motorista || '').toString().toLowerCase();
  const patrimonioStr = (patrimonio || '').toString();
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPatrimonios = (data[i][COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '').toString().split(',').map(s => s.trim());
    const rowStatus = (data[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').toString().toLowerCase();
    const rowAceitaPor = (data[i][COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().toLowerCase();
    if (rowPatrimonios.includes(patrimonioStr) && rowStatus === 'aceita' && rowAceitaPor === motoristaLower) {
      sheet.getRange(i + 1, COLUMN_INDICES.REQUESTS.SITUACAO).setValue(STATUS.FINALIZADA);
      return;
    }
  }
}

// =================================================================
// --- NOTIFICAÇÕES E DIVERGÊNCIAS ---
// =================================================================



function batchAddNotifications(notificationsMap) {
  let sheet = getSpreadsheet().getSheetByName(NOTIFICATIONS_SHEET_NAME);
  if (!sheet) {
    sheet = getSpreadsheet().insertSheet(NOTIFICATIONS_SHEET_NAME);
    sheet.appendRow(['Usuário', 'Notificações (JSON)']);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#f3f3f3');
    sheet.setFrozenRows(1);
  }
  const data = sheet.getDataRange().getValues();
  const userRows = {};
  for (let i = 1; i < data.length; i++) userRows[data[i][0]] = i + 1;

  Object.keys(notificationsMap).forEach(userName => {
    const message = notificationsMap[userName];
    const notification = { msg: message, time: new Date().toISOString(), id: Utilities.getUuid() };
    const rowIndex = userRows[userName];
    if (!rowIndex) {
      sheet.appendRow([userName, JSON.stringify([notification])]);
    } else {
      let current = [];
      try { current = JSON.parse(sheet.getRange(rowIndex, COLUMN_INDICES.NOTIFICATIONS.JSON).getValue() || '[]'); } catch (e) {}
      const isDuplicate = current.some(n => n.msg === message && (new Date() - new Date(n.time)) < 6 * 60 * 60 * 1000);
      if (!isDuplicate) {
        current.unshift(notification);
        if (current.length > 50) current = current.slice(0, 50);
        sheet.getRange(rowIndex, COLUMN_INDICES.NOTIFICATIONS.JSON).setValue(JSON.stringify(current));
      }
    }
  });
}


function getAdminAlerts(adminName) {
  try {
    const sheet = getSpreadsheet().getSheetByName(NOTIFICATIONS_SHEET_NAME);
    if (!sheet) return { success: true, alerts: [] };
    const data = sheet.getDataRange().getValues();
    const adminLower = (adminName || '').toString().trim().toLowerCase();
    for (let i = 1; i < data.length; i++) {
      if ((data[i][0] || '').toString().trim().toLowerCase() === adminLower) {
        try { return { success: true, alerts: JSON.parse(data[i][COLUMN_INDICES.NOTIFICATIONS.JSON - 1] || '[]') }; }
        catch (e) { return { success: true, alerts: [] }; }
      }
    }
    return { success: true, alerts: [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function clearAdminAlerts(adminName) {
  try {
    const sheet = getSpreadsheet().getSheetByName(NOTIFICATIONS_SHEET_NAME);
    if (!sheet) return { success: true };
    const data = sheet.getDataRange().getValues();
    const adminLower = (adminName || '').toString().trim().toLowerCase();
    for (let i = 1; i < data.length; i++) {
      if ((data[i][0] || '').toString().trim().toLowerCase() === adminLower) {
        sheet.getRange(i + 1, COLUMN_INDICES.NOTIFICATIONS.JSON).setValue('[]');
        SpreadsheetApp.flush();
        break;
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// =================================================================
// --- RELATÓRIOS E RESUMOS ---
// =================================================================
function saveDailySummary(summaryData) {
  try {
    let sheet = getSpreadsheet().getSheetByName(DAILY_SUMMARY_SHEET_NAME);
    if (!sheet) {
      sheet = getSpreadsheet().insertSheet(DAILY_SUMMARY_SHEET_NAME);
      sheet.appendRow(['Data','Motorista','Placa(s)','KM Total','Bateria Baixa','Manut. Bicicleta','Manut. Locker',
        'Solicitado Recolha','Remanejadas (Estação)','Ocorrências','Não Encontradas','Vandalizadas','Início','Fim','Observações']);
      sheet.getRange(1, 1, 1, 15).setFontWeight('bold').setBackground('#f3f3f3');
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([new Date(), summaryData.driverName, summaryData.plates, summaryData.totalKm,
      summaryData.bateriaCount, summaryData.manutBikeCount, summaryData.manutLockerCount,
      summaryData.solicitadoRecolhaCount || 0, summaryData.remanejadasCount,
      summaryData.ocorrenciasCount, summaryData.naoEncontradasCount, summaryData.vandalizadasCount,
      summaryData.startTime, summaryData.endTime, summaryData.obs || '']);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getDailyReportData(driverName, timeRange = 'day') {
  const reportSheet   = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
  const requestSheet  = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!reportSheet || !requestSheet) return { success: false, error: 'Planilhas não encontradas.' };

  const filterDate = new Date();
  filterDate.setHours(0, 0, 0, 0);
  if (timeRange === 'week') {
    const day = filterDate.getDay();
    filterDate.setDate(filterDate.getDate() - day + (day === 0 ? -6 : 1));
  } else if (timeRange === 'month') {
    filterDate.setDate(1);
  }
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

  const report = {
    recolhidas: [], remanejadas: [], estacoes: {}, ocorrencias: [],
    naoEncontrada: [], naoAtendida: [], vandalizadas: [],
    totalKmRodado: 0, platesUsed: new Set(), startTime: null, endTime: null,
    counts: { bateriaBaixa: 0, manutencaoBicicleta: 0, manutencaoLocker: 0, solicitadoRecolha: 0 }
  };
  const sessions = {};

  const lastRowReport = reportSheet.getLastRow();
  if (lastRowReport > 1) {
    const data = reportSheet.getRange(2, 1, lastRowReport - 1, reportSheet.getLastColumn()).getValues();
    data.forEach(row => {
      const ts = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      if (!ts || ts < filterDate || ts > todayEnd) return;
      const motorista = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
      if (motorista.toLowerCase() !== driverName.toLowerCase()) return;

      if (!report.startTime || ts < report.startTime) report.startTime = ts;
      if (!report.endTime || ts > report.endTime) report.endTime = ts;

      const patrimonio = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
      const status     = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
      const statusLower= status.toLowerCase();
      const observacao = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
      const obsLower   = observacao.toLowerCase();

      if (status === STATUS.INICIO_TURNO) {
        const km = parseFloat(observacao) || 0;
        if (!sessions[patrimonio]) sessions[patrimonio] = [];
        sessions[patrimonio].push({ inicio: km, fim: null });
        report.platesUsed.add(patrimonio);
      } else if (status === STATUS.FIM_TURNO) {
        const km = parseFloat(observacao.replace('KM Final: ', '')) || 0;
        if (sessions[patrimonio]) {
          for (let i = sessions[patrimonio].length - 1; i >= 0; i--) {
            if (sessions[patrimonio][i].fim === null) { sessions[patrimonio][i].fim = km; break; }
          }
        }
        report.platesUsed.add(patrimonio);
      }

      if (statusLower.includes('filial') || statusLower.includes('recolhida') || statusLower === 'vandalizada') {
        if (!report.recolhidas.includes(patrimonio)) report.recolhidas.push(patrimonio);
        if (statusLower === 'vandalizada' && !report.vandalizadas.includes(patrimonio)) report.vandalizadas.push(patrimonio);
        if (obsLower.includes('bateria baixa')) report.counts.bateriaBaixa++;
        else if (obsLower.includes('manutenção bicicleta') || obsLower.includes('manutencao bicicleta')) report.counts.manutencaoBicicleta++;
        else if (obsLower.includes('manutenção locker') || obsLower.includes('manutencao locker')) report.counts.manutencaoLocker++;
        else if (obsLower.includes('solicitado recolha')) report.counts.solicitadoRecolha++;
      } else if (statusLower === 'estação' || statusLower === 'estacao') {
        if (!report.remanejadas.includes(patrimonio)) report.remanejadas.push(patrimonio);
        const stationName = observacao || 'Estação';
        report.estacoes[stationName] = (report.estacoes[stationName] || 0) + 1;
      } else if (statusLower === 'não encontrada' || statusLower === 'nao encontrada') {
        if (!report.naoEncontrada.includes(patrimonio)) report.naoEncontrada.push(patrimonio);
      } else if (statusLower === 'não atendida' || statusLower === 'nao atendida') {
        if (!report.naoAtendida.includes(patrimonio)) report.naoAtendida.push(patrimonio);
      }
    });
  }

  Object.values(sessions).forEach(s => s.forEach(sess => {
    if (sess.inicio !== null && sess.fim !== null && sess.fim > sess.inicio) {
      report.totalKmRodado += sess.fim - sess.inicio;
    }
  }));

  if (requestSheet.getLastRow() > 1) {
    const reqData = requestSheet.getRange(2, 1, requestSheet.getLastRow() - 1, requestSheet.getLastColumn()).getValues();
    reqData.forEach(row => {
      const acceptedBy   = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim();
      const acceptedDate = row[COLUMN_INDICES.REQUESTS.ACEITA_DATA - 1];
      const local        = (row[COLUMN_INDICES.REQUESTS.LOCAL - 1] || '').toString().trim();
      if (acceptedBy.toLowerCase() === driverName.toLowerCase() && acceptedDate) {
        const ts = parseTimestamp(acceptedDate);
        if (ts && ts >= filterDate && ts <= todayEnd && !local.toLowerCase().includes('roteiro')) {
          const patrimonio = (row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '').toString().trim();
          const ocorrencia = (row[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1] || '').toString().trim();
          report.ocorrencias.push(`${patrimonio}: ${ocorrencia}`);
        }
      }
    });
  }

  report.platesUsed = Array.from(report.platesUsed);
  return { success: true, data: report };
}

function getSchedule(driverName) {
  try {
    const sheet = getSpreadsheet().getSheetByName('Escala');
    if (!sheet) return { success: false, error: 'Aba "Escala" não encontrada.' };
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return { success: true, data: {} };
    const headers = values[0];
    const driverColIdx = headers.findIndex(h => h.toString().trim().toLowerCase() === 'motorista');
    if (driverColIdx === -1) return { success: false, error: 'Coluna "Motorista" não encontrada.' };

    const schedule = {};
    const driverLower = (driverName || '').trim().toLowerCase();
    const cleanTime = t => {
      if (!t) return '';
      const m = t.match(/^(\d{1,2}:\d{2}):\d{2}$/);
      return m ? m[1] : t;
    };

    for (let i = 1; i < values.length; i++) {
      if ((values[i][driverColIdx] || '').trim().toLowerCase() !== driverLower) continue;
      for (let j = 0; j < headers.length; j++) {
        if (j === driverColIdx) continue;
        const header = headers[j].toString().trim();
        if (!header) continue;
        const v1 = cleanTime((values[i][j] || '').toString().trim());
        const v2 = (j + 1 < headers.length && !headers[j+1].toString().trim())
          ? cleanTime((values[i][j+1] || '').toString().trim()) : '';
        const combined = v1 + (v2 && v2 !== v1 ? ' - ' + v2 : '');
        if (combined) schedule[header] = combined;
      }
      break;
    }
    return { success: true, data: schedule };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar escala: ' + e.message };
  }
}

function getBikeStatuses(providedStateSheet, providedReportSheet) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'bike_statuses';
  const cached = cache.get(cacheKey);
  if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {} }

  try {
    const stateSheet  = providedStateSheet  || getSpreadsheet().getSheetByName(STATE_SHEET_NAME);
    const reportSheet = providedReportSheet || getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    const conflicts = {};
    const now = new Date().getTime();
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

    if (stateSheet) {
      stateSheet.getDataRange().getValues().slice(1).forEach(row => {
        const driver = row[COLUMN_INDICES.STATE.MOTORISTA - 1];
        if (!driver) return;
        const route     = (row[COLUMN_INDICES.STATE.ROTEIRO - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
        const collected = (row[COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
        route.forEach(bike => {
          if (!conflicts[bike]) conflicts[bike] = { drivers: [], status: '', recentAction: '' };
          if (!conflicts[bike].drivers.includes(driver)) conflicts[bike].drivers.push(driver);
        });
        collected.forEach(bike => {
          if (!conflicts[bike]) conflicts[bike] = { drivers: [], status: '', recentAction: '' };
          const label = driver + ' (Em Posse)';
          if (!conflicts[bike].drivers.includes(label)) conflicts[bike].drivers.push(label);
        });
      });
    }

    if (reportSheet) {
      const lastRow = reportSheet.getLastRow();
      if (lastRow > 1) {
        const numRows = Math.min(lastRow - 1, 300);
        const data = reportSheet.getRange(lastRow - numRows + 1, 1, numRows, 6).getValues();
        for (let i = data.length - 1; i >= 0; i--) {
          const row = data[i];
          const ts  = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
          if (!ts) continue;
          const bike      = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString();
          const status    = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().toUpperCase();
          const motorista = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString();
          const sysSt     = (row[COLUMN_INDICES.REPORTS.STATUS_SISTEMA - 1] || '').toString().toUpperCase();
          if (!conflicts[bike]) conflicts[bike] = { drivers: [], status: '', recentAction: '' };
          if (!conflicts[bike].status && ['VANDALIZADA','MANUTENÇÃO','ROUBADA'].includes(sysSt)) {
            conflicts[bike].status = sysSt;
          }
          if (!conflicts[bike].recentAction && (now - ts.getTime() < FOUR_HOURS_MS)) {
            if (status.includes('FILIAL') || status === 'ESTAÇÃO' || status === 'ESTACAO') {
              conflicts[bike].recentAction = `${motorista} (${status})`;
            }
          }
        }
      }
    }

    try { cache.put(cacheKey, JSON.stringify(conflicts), 15); } catch (e) {}
    return { success: true, data: conflicts };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar status das bikes: ' + e.message };
  }
}

function getReporData() {
  try {
    const sheet = getSpreadsheet().getSheetByName(REPLENISHMENT_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Aba "Repor" não encontrada.' };
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { success: true, data: [] };
    const allValues = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
    const firstRow  = allValues[0];
    const isHeader  = isNaN(Number(firstRow[0])) && firstRow[1] && isNaN(Number(firstRow[1]));
    const headers   = isHeader ? firstRow.map(h => (h || '').toString().trim()) : ['ID', 'Estação', 'Ocupação', 'Porcentagem'];
    const startIdx  = isHeader ? 1 : 0;
    const data = [];
    for (let i = startIdx; i < allValues.length; i++) {
      const rowObj = {};
      let hasContent = false;
      headers.forEach((h, idx) => {
        const key = h || `Coluna ${idx + 1}`;
        const val = allValues[i][idx];
        rowObj[key] = val;
        if (val && val.toString().trim()) hasContent = true;
      });
      if (hasContent) data.push(rowObj);
    }
    return { success: true, data };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar dados de reposição: ' + e.message };
  }
}

function getChangeStatusData(timeRange = '24h', providedSheets = null) {
  const cacheKey = 'change_status_data_' + timeRange;
  const cache = CacheService.getScriptCache();
  if (!providedSheets) {
    const cached = cache.get(cacheKey);
    if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {} }
  }

  try {
    const reportSheet  = providedSheets ? providedSheets.report  : getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    const stationSheet = providedSheets ? providedSheets.stations : getSpreadsheet().getSheetByName(STATIONS_SHEET_NAME);
    if (!reportSheet) return { success: true, data: { vandalizadas: [], filial: [] } };

    const stationNames = [];
    if (stationSheet && stationSheet.getLastRow() > 1) {
      stationSheet.getRange(2, COLUMN_INDICES.STATIONS.NAME, stationSheet.getLastRow() - 1, 1).getValues()
        .forEach(row => { if (row[0]) stationNames.push(row[0].toString().trim().toLowerCase()); });
    }

    const now = new Date();
    const cutoffDate = new Date();
    let rowsToRead = 5000;
    if (timeRange === '48h')   { cutoffDate.setDate(now.getDate() - 2); rowsToRead = 8000; }
    else if (timeRange === '72h')   { cutoffDate.setDate(now.getDate() - 3); rowsToRead = 12000; }
    else if (timeRange === 'week')  { cutoffDate.setDate(now.getDate() - 7); rowsToRead = 20000; }
    else                             { cutoffDate.setDate(now.getDate() - 1); }

    const lastRow = reportSheet.getLastRow();
    if (lastRow < 2) return { success: true, data: { vandalizadas: [], filial: [] } };
    const actualRows = Math.min(lastRow - 1, rowsToRead);
    const data = reportSheet.getRange(lastRow - actualRows + 1, 1, actualRows, 6).getValues();

    const lastReports = {};
    data.forEach(row => {
      const ts = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      if (!ts || ts < cutoffDate) return;
      let patrimonio = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim().replace(/^0+/, '');
      if (!patrimonio || patrimonio.toUpperCase() === 'TESTE') return;
      const status      = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
      const statusLower = status.toLowerCase();
      const observacao  = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
      const isStatusChange = ['recolhida','vandalizada','filial','oficina','recolher','vandalismo'].some(s => statusLower.includes(s));
      const isRecovery     = ['ativo','manutenção','manutencao'].some(s => statusLower.includes(s));
      const isStation      = stationNames.includes(statusLower) || statusLower === 'estação' || statusLower === 'estacao';
      const effectiveStatus= isStation ? (statusLower === 'estação' || statusLower === 'estacao' ? observacao.toLowerCase() : statusLower) : statusLower;
      const current = lastReports[patrimonio];
      let shouldUpdate = !current
        || (isStatusChange && (!current.isStatusChange || ts > current.timestamp))
        || (isRecovery && ts > current.timestamp)
        || (!current.isStatusChange && !current.isRecovery && ts > current.timestamp);
      if (shouldUpdate) lastReports[patrimonio] = { timestamp: ts, status: effectiveStatus, observation: observacao, isStatusChange, isRecovery };
    });

    const sortFn = (a, b) => (parseInt(a.patrimonio.replace(/\D/g,'')) || 0) - (parseInt(b.patrimonio.replace(/\D/g,'')) || 0);
    const vandalizadas = [], filial = [];
    Object.keys(lastReports).forEach(patrimonio => {
      const r = lastReports[patrimonio];
      if (r.isRecovery) return;
      const item = { patrimonio, observation: r.observation || '' };
      if (r.status.includes('vandalizada') || r.status.includes('vandalismo')) vandalizadas.push(item);
      else if (r.status.includes('filial') || r.status.includes('recolhida') || r.status.includes('recolher')) filial.push(item);
    });

    const result = { vandalizadas: vandalizadas.sort(sortFn), filial: filial.sort(sortFn) };
    if (!providedSheets) { try { cache.put(cacheKey, JSON.stringify(result), 30); } catch (e) {} }
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar dados de status: ' + e.message };
  }
}

function getDriversSummary(timeRange = 'day', providedSheets = null, driverNameFilter = null, timelineDate = null) {
  const cacheKey = `summary_${timeRange}_${driverNameFilter || 'all'}`;
  const cache = CacheService.getScriptCache();
  // Não usa cache para 'day' e '-1' — precisam de timeline em tempo real
  const useCache = timeRange !== 'day' && timeRange !== '-1';
  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {} }
  }

  try {
    const accessSheet   = providedSheets ? providedSheets.access   : getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
    const reportSheet   = providedSheets ? providedSheets.report   : getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    const stateSheet    = providedSheets ? providedSheets.state    : getSpreadsheet().getSheetByName(STATE_SHEET_NAME);
    const requestsSheet = providedSheets ? providedSheets.requests : getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
    if (!accessSheet || !reportSheet || !stateSheet || !requestsSheet) throw new Error('Planilhas necessárias não encontradas.');

    let drivers = [];
    if (driverNameFilter) {
      drivers = [driverNameFilter.toString().trim()];
    } else {
      const lastRowA = accessSheet.getLastRow();
      if (lastRowA < 2) return { success: true, data: [] };
      const driversData = accessSheet.getRange(2, 1, lastRowA - 1, accessSheet.getLastColumn()).getValues();
      drivers = [...new Set(driversData
        .filter(row => normalizeCategory(row[COLUMN_INDICES.ACCESS.CATEGORIA - 1]).includes('MOTORISTA'))
        .map(row => row[COLUMN_INDICES.ACCESS.USUARIO - 1].toString().trim()))];
    }

    const now = new Date();
    const filterDate = new Date(); filterDate.setHours(0,0,0,0);
    let endDate = new Date(); endDate.setHours(23,59,59,999);
    let rowsToRead = 1000;

    // Se timelineDate específica foi fornecida, usa ela para a timeline
    let timelineFilterDate = filterDate;
    let timelineEndDate = endDate;
    if (timelineDate) {
      const parts = timelineDate.split('-');
      timelineFilterDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 0, 0, 0, 0);
      timelineEndDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 23, 59, 59, 999);
    }

    if (timeRange === 'week') {
      const day = now.getDay();
      filterDate.setDate(now.getDate() - day + (day === 0 ? -6 : 1));
      rowsToRead = 5000;
    } else if (timeRange === 'month') {
      filterDate.setDate(1); rowsToRead = 15000;
    } else if (timeRange === '-1') {
      filterDate.setDate(now.getDate() - 1); endDate.setDate(now.getDate() - 1); rowsToRead = 2000;
    } else if (timeRange === '-7') {
      const day = now.getDay();
      const mondayThisWeek = now.getDate() - day + (day === 0 ? -6 : 1);
      filterDate.setDate(mondayThisWeek - 7); endDate.setDate(mondayThisWeek - 1); rowsToRead = 10000;
    }

    const lastRowR = reportSheet.getLastRow();
    let reportsData = [];
    if (lastRowR > 1) {
      const numRows = Math.min(lastRowR - 1, rowsToRead);
      reportsData = reportSheet.getRange(lastRowR - numRows + 1, 1, numRows, reportSheet.getLastColumn()).getValues();
    }

    const stats = {};
    const driverLookup = {};
    drivers.forEach(d => {
      stats[d] = { recolhidas: 0, remanejada: 0, naoEncontrada: 0, naoAtendida: 0 };
      driverLookup[d.toLowerCase()] = d;
    });

    reportsData.forEach(row => {
      const ts = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      if (!ts || ts < filterDate || ts > endDate) return;
      const driverRaw = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
      const driverKey = driverLookup[driverRaw.toLowerCase()];
      if (!driverKey) return;
      const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
      if (status.includes('filial') || status.includes('recolhida') || status === 'vandalizada') stats[driverKey].recolhidas++;
      else if (status === 'estação' || status === 'estacao') stats[driverKey].remanejada++;
      else if (status === 'não encontrada' || status === 'nao encontrada') stats[driverKey].naoEncontrada++;
      else if (status === 'não atendida' || status === 'nao atendida') stats[driverKey].naoAtendida++;
    });

    const lastRowSt = stateSheet.getLastRow();
    const stateData = lastRowSt > 1 ? stateSheet.getRange(2, 1, lastRowSt - 1, stateSheet.getLastColumn()).getValues() : [];
    const realTime = {};
    stateData.forEach(row => {
      const driver = row[COLUMN_INDICES.STATE.MOTORISTA - 1];
      if (drivers.includes(driver)) {
        realTime[driver] = {
          route:     (row[COLUMN_INDICES.STATE.ROTEIRO - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean),
          collected: (row[COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean)
        };
      }
    });

    const pendingCounts = {};
    drivers.forEach(d => pendingCounts[d] = 0);
    const lastRowReq = requestsSheet.getLastRow();
    if (lastRowReq > 1) {
      requestsSheet.getRange(2, 1, lastRowReq - 1, requestsSheet.getLastColumn()).getValues().forEach(row => {
        const status    = (row[COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').toLowerCase();
        const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || '').toString().trim().toLowerCase();
        const declined  = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());
        if (status === 'pendente') {
          drivers.forEach(d => {
            if ((recipient === 'todos' || recipient === d.toLowerCase()) && !declined.includes(d.toLowerCase())) {
              pendingCounts[d]++;
            }
          });
        }
      });
    }

    // Monta timeline de eventos por motorista
    // Se timelineDate fornecida, usa essa data específica; senão usa filterDate/endDate do período
    const timelines = {};
    const timelineWindows = {};
    drivers.forEach(d => { timelines[d] = []; });
    if (timeRange === 'day' || timeRange === '-1' || timelineDate) {
      const tlStart = timelineDate ? timelineFilterDate : filterDate;
      const tlEnd   = timelineDate ? timelineEndDate   : endDate;

      // Primeira passagem: pega todos os eventos para determinar janela
      const driverFirstLast = {};
      reportsData.forEach(row => {
        const ts = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
        if (!ts || ts < tlStart || ts > tlEnd) return;
        const driverRaw = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
        const driverKey = driverLookup[driverRaw.toLowerCase()];
        if (!driverKey) return;
        const tsMs = ts.getTime();
        if (!driverFirstLast[driverKey]) driverFirstLast[driverKey] = { firstMs: tsMs, lastMs: tsMs };
        if (tsMs < driverFirstLast[driverKey].firstMs) driverFirstLast[driverKey].firstMs = tsMs;
        if (tsMs > driverFirstLast[driverKey].lastMs) driverFirstLast[driverKey].lastMs = tsMs;
      });

      // Segunda passagem: monta eventos
      reportsData.forEach(row => {
        const ts = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
        if (!ts || ts < tlStart || ts > tlEnd) return;
        const driverRaw = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
        const driverKey = driverLookup[driverRaw.toLowerCase()];
        if (!driverKey) return;
        const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
        let type = null;
        if (status === 'recolhida' || status === 'vandalizada') type = 'recolhida';
        else if (status === 'estação' || status === 'estacao') type = 'estacao';
        else if (status.includes('filial')) type = 'filial';
        else if (status.includes('não encontrada') || status.includes('nao encontrada')) type = 'nao_encontrada';
        else if (status.includes('não atendida') || status.includes('nao atendida')) type = 'nao_atendida';
        if (type) {
          const pat = String(row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
          const obs = String(row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').trim();
          timelines[driverKey].push({ tsMs: ts.getTime(), hour: ts.getHours(), min: ts.getMinutes(), type, bikeNumber: pat, observacao: obs });
        }
      });

      drivers.forEach(d => {
        const fl = driverFirstLast[d];
        if (fl) timelineWindows[d] = { startMs: fl.firstMs, endMs: fl.lastMs };
      });
    }

    const summary = drivers.map(d => ({
      name: d,
      stats: stats[d],
      realTime: realTime[d] || { route: [], collected: [] },
      pendingRequests: pendingCounts[d],
      timeline: timelines[d] || [],
      timelineWindow: timelineWindows[d] || null
    }));

    if (useCache) { try { cache.put(cacheKey, JSON.stringify(summary), 30); } catch (e) {} }
    return { success: true, data: summary };
  } catch (e) {
    return { success: false, error: 'Erro ao gerar resumo: ' + e.message };
  }
}

function getRouteDetails(driverName, bikeNumbers, providedBikesSheet, providedRequestsSheet) {
  if (!bikeNumbers || bikeNumbers.length === 0) return { success: true, data: {} };

  const cacheKey = `route_details_${driverName}_${[...bikeNumbers].sort().join(',')}`;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {} }

  try {
    const bikesSheet    = providedBikesSheet    || getSpreadsheet().getSheetByName(BIKES_SHEET_NAME);
    const requestsSheet = providedRequestsSheet || getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
    if (!bikesSheet || !requestsSheet) throw new Error('Planilhas não encontradas.');

    const bikeIndex = getBikeIndex();
    const lastRowReq = requestsSheet.getLastRow();
    const numRowsReq = Math.min(lastRowReq - 1, 2000);
    const requestsData = lastRowReq > 1
      ? requestsSheet.getRange(lastRowReq - numRowsReq + 1, 1, numRowsReq, requestsSheet.getLastColumn()).getValues() : [];

    const bikeNumberSet = new Set(bikeNumbers.map(String));
    const result = {};

    bikeNumbers.forEach(pat => {
      const row = bikeIndex[String(pat).trim()];
      if (row) {
        result[pat] = {
          bikeNumber: pat,
          currentLat: parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
          currentLng: parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
          battery: row[COLUMN_INDICES.BIKES.BATERIA - 1],
          initialLat: null, initialLng: null
        };
      }
    });

    for (let i = requestsData.length - 1; i >= 0; i--) {
      const patrimonioRaw = String(requestsData[i][COLUMN_INDICES.REQUESTS.PATRIMONIO - 1]).trim();
      const acceptedBy    = String(requestsData[i][COLUMN_INDICES.REQUESTS.ACEITA_POR - 1]).trim().toLowerCase();
      const situacao      = String(requestsData[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1]).trim().toLowerCase();
      patrimonioRaw.split(',').map(s => s.trim()).filter(Boolean).forEach(patrimonio => {
        if (bikeNumberSet.has(patrimonio) && acceptedBy === driverName.toLowerCase() && situacao === 'aceita') {
          if (result[patrimonio] && result[patrimonio].initialLat === null) {
            const local = String(requestsData[i][COLUMN_INDICES.REQUESTS.LOCAL - 1]);
            const m = local.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
            if (m) { result[patrimonio].initialLat = parseCoordinate(m[1]); result[patrimonio].initialLng = parseCoordinate(m[2]); }
          }
        }
      });
    }

    try { cache.put(cacheKey, JSON.stringify(result), 10); } catch (e) {}
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar detalhes do roteiro: ' + e.message };
  }
}

function getBikeDetailsBatch(bikeNumbers) {
  if (!bikeNumbers || bikeNumbers.length === 0) return { success: true, data: {} };
  const index = getBikeIndex();
  const result = {};
  bikeNumbers.forEach(num => {
    const row = index[String(num).trim()];
    if (row) {
      result[num] = {
        'Patrimônio': row[COLUMN_INDICES.BIKES.PATRIMONIO - 1],
        'Status':     row[COLUMN_INDICES.BIKES.STATUS - 1],
        'Localidade': row[COLUMN_INDICES.BIKES.LOCALIDADE - 1],
        'Usuário':    row[COLUMN_INDICES.BIKES.USUARIO - 1],
        'Bateria':    row[COLUMN_INDICES.BIKES.BATERIA - 1],
        'Trava':      row[COLUMN_INDICES.BIKES.TRAVA - 1],
        'Latitude':   parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
        'Longitude':  parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
      };
    }
  });
  return { success: true, data: result };
}

// =================================================================
// --- MECÂNICA ---
// =================================================================
function switchVehicle(driverName, plate, kmInicial) {
  try {
    const sheet = getSpreadsheet().getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${ACCESS_SHEET_NAME}" não encontrada.`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Nenhum usuário cadastrado.' };
    const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    let foundRow = -1;
    for (let i = 0; i < values.length; i++) {
      if (values[i][0].toString().trim().toLowerCase() === driverName.toLowerCase()) { foundRow = i + 2; break; }
    }
    if (foundRow === -1) return { success: false, error: `Motorista "${driverName}" não encontrado.` };
    updateVehicleKm(plate, kmInicial, undefined);
    const reportSheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    if (reportSheet) reportSheet.appendRow([formatDateTime(new Date()), plate, STATUS.INICIO_TURNO, kmInicial, driverName]);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function addToMechanics(bikeNumber) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  const bikeStr = String(bikeNumber).trim().replace(/^0+/, '');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '') === bikeStr
        && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] !== 'Remanejada') return;
  }
  sheet.appendRow([bikeNumber, 'Aguardando Confirmação', new Date(), '', '', '', '']);
}

// =================================================================
// --- GOOGLE DIRECTIONS PROXY ---
// Chave configurada em Projeto > Propriedades do Script > GOOGLE_MAPS_KEY
// =================================================================
function getDirections(fromLat, fromLng, toLat, toLng) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_KEY');
    if (!key) return { success: false, error: 'Chave Google Maps não configurada.' };

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${fromLat},${fromLng}&destinations=${toLat},${toLng}&mode=driving&language=pt-BR&key=${key}`;
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(response.getContentText());

    if (data.status === 'OK' && data.rows?.[0]?.elements?.[0]?.status === 'OK') {
      const el = data.rows[0].elements[0];
      return {
        success: true,
        distanceM: el.distance.value,
        durationS: el.duration.value,
        distanceText: el.distance.text,
        durationText: el.duration.text
      };
    }
    return { success: false, error: 'Google Maps retornou: ' + data.status };
  } catch (e) {
    return { success: false, error: 'Erro ao chamar Google Maps: ' + e.message };
  }
}

function getBikeMovement(bikeNumber, limit) {
  if (!bikeNumber) return { success: false, error: 'Patrimônio não informado.' };
  limit = parseInt(limit) || 5;
  if (![5, 10, 15].includes(limit)) limit = 5;

  try {
    const ss = getSpreadsheet();
    const bikeStr = String(bikeNumber).trim().replace(/^0+/, '');
    const records = [];

    // 1. Lê o Relatório (movimentação dos motoristas)
    const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    if (reportSheet && reportSheet.getLastRow() > 1) {
      const lastRow = reportSheet.getLastRow();
      const rowsToRead = Math.min(lastRow - 1, 10000);
      const data = reportSheet.getRange(lastRow - rowsToRead + 1, 1, rowsToRead, 9).getValues();

      for (let i = data.length - 1; i >= 0; i--) {
        const row = data[i];
        const pat = String(row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
        if (pat !== bikeStr) continue;

        const ts = row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1];
        const tsDate = ts instanceof Date ? ts : parseTimestamp(ts);
        if (!tsDate) continue;

        records.push({
          tsDate,
          timestamp:  tsDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          status:     (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim(),
          observacao: (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim(),
          motorista:  (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim(),
          bateria:    (row[COLUMN_INDICES.REPORTS.BATERIA - 1] || '').toString().trim(),
          trava:      (row[COLUMN_INDICES.REPORTS.TRAVA - 1] || '').toString().trim(),
          localidade: (row[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim(),
          origem:     'relatorio'
        });
      }
    }

    // 2. Lê a aba Mecânica (movimentação interna)
    const mecSheet = ss.getSheetByName(MECHANICS_SHEET_NAME);
    if (mecSheet && mecSheet.getLastRow() > 1) {
      const mecData = mecSheet.getDataRange().getValues().slice(1);
      mecData.forEach(row => {
        const pat = String(row[COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
        if (pat !== bikeStr) return;

        const status    = (row[COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
        const mecanico  = (row[COLUMN_INDICES.MECHANICS.MECANICO - 1] || '').toString().trim();
        const tratativa = (row[COLUMN_INDICES.MECHANICS.TRATATIVA - 1] || '').toString().trim();
        const dataFin   = row[COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1];
        const dataEnt   = row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1];

        // Entrada na mecânica
        const entDate = dataEnt instanceof Date ? dataEnt : parseTimestamp(dataEnt);
        if (entDate && status !== 'Remanejada') {
          records.push({
            tsDate: entDate,
            timestamp: entDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
            status,
            observacao: tratativa && tratativa !== 'MANUAL' ? tratativa : '',
            motorista:  mecanico,
            bateria:    '',
            trava:      '',
            localidade: '',
            origem:     'mecanica'
          });
        }

        // Finalização (Reserva/Remanejada)
        const finDate = dataFin instanceof Date ? dataFin : parseTimestamp(dataFin);
        if (finDate && (status === 'Reserva' || status === 'Remanejada')) {
          records.push({
            tsDate: finDate,
            timestamp: finDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
            status: status === 'Reserva' ? 'Reparo Finalizado → Reserva' : 'Remanejada',
            observacao: tratativa && tratativa !== 'MANUAL' ? `Tratativa: ${tratativa}` : '',
            motorista:  mecanico,
            bateria:    '',
            trava:      '',
            localidade: '',
            origem:     'mecanica'
          });
        }
      });
    }

    // Ordena por data decrescente e limita
    records.sort((a, b) => b.tsDate - a.tsDate);
    const limited = records.slice(0, limit).map(r => {
      const { tsDate, ...rest } = r;
      return rest;
    });

    return { success: true, data: limited };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar movimentação: ' + e.message };
  }
}

function getMechanicsList() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(MECHANICS_SHEET_NAME);
      sheet.appendRow(['Patrimônio','Status','Data Entrada','Mecânico','Tratativa','Data Finalização','Carretinha']);
    } catch (e) {}
  }

  const CUTOFF_MS = new Date('2026-03-20T00:00:00').getTime();

  // Mapa de bateria/carregamento — lê direto da planilha sem cache
  const bikeInfoMap = {};
  try {
    const bikesSheet = ss.getSheetByName(BIKES_SHEET_NAME);
    if (bikesSheet && bikesSheet.getLastRow() > 1) {
      const nCols = COLUMN_INDICES.BIKES.CARREGAMENTO; // lê até coluna H (8)
      bikesSheet.getRange(2, 1, bikesSheet.getLastRow() - 1, nCols).getValues().forEach(row => {
        const pat = String(row[COLUMN_INDICES.BIKES.PATRIMONIO - 1] || '').trim();
        if (!pat) return;
        let bateria = row[COLUMN_INDICES.BIKES.BATERIA - 1];
        if (typeof bateria === 'number' && bateria <= 1 && bateria > 0) bateria = Math.round(bateria * 100);
        else if (typeof bateria === 'string' && bateria.includes('%')) bateria = parseInt(bateria.replace('%', ''));
        const carregamentoRaw = (row[COLUMN_INDICES.BIKES.CARREGAMENTO - 1] || '').toString().trim();
        const carregamento = carregamentoRaw.toLowerCase() === 'carregando' ? 'Carregando' : (carregamentoRaw ? 'Não carregando' : '');
        const info = { bateria, carregamento };
        bikeInfoMap[pat] = info;
        const patSemZeros = pat.replace(/^0+/, '');
        if (patSemZeros !== pat) bikeInfoMap[patSemZeros] = info;
      });
    }
  } catch(e) { console.error('getMechanicsList - erro ao ler bikes:', e); }

  // Helper: converte qualquer valor de data para ms
  const toMs = (raw) => {
    if (!raw) return null;
    if (raw instanceof Date) return raw.getTime();
    const s = raw.toString().trim();
    if (!s) return null;
    if (s.includes('/')) {
      const parts = s.split(' ');
      const dp = parts[0].split('/');
      if (dp.length === 3) {
        const d = new Date(`${dp[2]}-${dp[1]}-${dp[0]}${parts[1] ? 'T' + parts[1] : ''}`);
        return isNaN(d.getTime()) ? null : d.getTime();
      }
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.getTime();
  };

  // =================================================================
  // LÓGICA:
  // - Aguardando Confirmação → vem SOMENTE do Relatório (Recolhida/Vandalizada como último status)
  // - Em Manutenção / Reserva → vem da aba Mecânica (mecânico processa manualmente)
  // - Inserção manual via app → aparece com badge Manual
  // - A aba Mecânica NÃO registra "Aguardando Confirmação" — só Em Manutenção em diante
  // =================================================================

  // Passo 1: Relatório — última ocorrência de Recolhida/Vandalizada por bike
  // Se após a última Recolhida existir saída (Estação, etc.), bike não aparece
  const reportEntries = {};
  const lastStatusByBike = {};
  const EXIT_STATUSES = new Set([
    'estação', 'estacao', 'não encontrada', 'nao encontrada',
    'não atendida', 'nao atendida', 'inicio_turno', 'fim_turno'
  ]);

  try {
    const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    if (reportSheet && reportSheet.getLastRow() > 1) {
      const lastRow = reportSheet.getLastRow();
      const rowsToRead = Math.min(lastRow - 1, 8000);
      const reportData = reportSheet.getRange(lastRow - rowsToRead + 1, 1, rowsToRead, 5).getValues();

      reportData.forEach(row => {
        const tsMs = toMs(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
        if (!tsMs || tsMs < CUTOFF_MS) return;
        const pat = String(row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
        if (!pat) return;
        const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
        if (!status) return;
        const observacao = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
        const motorista  = (row[COLUMN_INDICES.REPORTS.MOTORISTA  - 1] || '').toString().trim();

        // Último status geral
        if (!lastStatusByBike[pat] || tsMs > lastStatusByBike[pat].tsMs) {
          lastStatusByBike[pat] = { tsMs, status };
        }

        // Última ocorrência de Recolhida/Vandalizada — guarda motorista e observação
        if (status === 'recolhida' || status === 'vandalizada') {
          if (!reportEntries[pat] || tsMs > reportEntries[pat].tsMs) {
            reportEntries[pat] = { tsMs, status, motorista, observacao };
          }
        }
      });

      // Remove bikes cuja última ocorrência geral é uma saída posterior à última Recolhida
      Object.keys(reportEntries).forEach(pat => {
        const last = lastStatusByBike[pat];
        if (last && EXIT_STATUSES.has(last.status) && last.tsMs > reportEntries[pat].tsMs) {
          delete reportEntries[pat];
        }
      });
    }
  } catch (e) {
    console.error('getMechanicsList - erro ao ler relatório:', e);
  }

  // Passo 2: Aba Mecânica — apenas Em Manutenção e Reserva (não Aguardando)
  const mechanicsStatus = {};
  if (sheet) {
    sheet.getDataRange().getValues().slice(1).forEach((row, idx) => {
      const pat    = String(row[COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      const status = (row[COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
      if (!pat) return;
      if (status === 'Remanejada' || status === 'Aguardando Confirmação') return;
      const tsMs = toMs(row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
      if (tsMs !== null && tsMs < CUTOFF_MS) return;
      if (tsMs === null) return;
      const tratativa = (row[COLUMN_INDICES.MECHANICS.TRATATIVA - 1] || '').toString().trim();
      if (!mechanicsStatus[pat] || tsMs > (mechanicsStatus[pat].tsMs || 0)) {
        mechanicsStatus[pat] = {
          row: idx + 2, status, tsMs: tsMs || 0,
          dataEntrada: row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1],
          mecanico:    row[COLUMN_INDICES.MECHANICS.MECANICO - 1],
          tratativa,
          dataFinalizacao: row[COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1],
          carretinha:      row[COLUMN_INDICES.MECHANICS.CARRETINHA - 1],
          manual: tratativa.toUpperCase() === 'MANUAL'
        };
      }
    });
  }

  // Passo 3: Monta resultado final
  const bikeMap = {};

  // 3a. Bikes do Relatório
  Object.entries(reportEntries).forEach(([pat, entry]) => {
    const mechData = mechanicsStatus[pat];
    const info = bikeInfoMap[pat] || {};
    if (mechData) {
      // Já processada pelo mecânico — usa status da aba, mas mantém motorista/observacao do Relatório
      bikeMap[pat] = {
        row: mechData.row, patrimonio: pat, status: mechData.status,
        dataEntrada: mechData.dataEntrada, mecanico: mechData.mecanico,
        tratativa: mechData.tratativa, dataFinalizacao: mechData.dataFinalizacao,
        carretinha: mechData.carretinha, bateria: info.bateria,
        carregamento: info.carregamento, manual: mechData.manual,
        motorista: entry.motorista || '',
        observacao: entry.observacao || ''
      };
    } else {
      // Ainda não processada → Aguardando Confirmação
      bikeMap[pat] = {
        row: -1, patrimonio: pat, status: 'Aguardando Confirmação',
        dataEntrada: new Date(entry.tsMs), mecanico: '', tratativa: '',
        dataFinalizacao: '', carretinha: '',
        bateria: info.bateria, carregamento: info.carregamento,
        motorista: entry.motorista || '',
        observacao: entry.observacao || '',
        manual: false
      };
    }
  });

  // 3b. Bikes da aba Mecânica não presentes no Relatório (inserção manual)
  Object.entries(mechanicsStatus).forEach(([pat, mechData]) => {
    if (bikeMap[pat]) return;
    const info = bikeInfoMap[pat] || {};
    bikeMap[pat] = {
      row: mechData.row, patrimonio: pat, status: mechData.status,
      dataEntrada: mechData.dataEntrada, mecanico: mechData.mecanico,
      tratativa: mechData.tratativa, dataFinalizacao: mechData.dataFinalizacao,
      carretinha: mechData.carretinha, bateria: info.bateria,
      carregamento: info.carregamento, manual: true
    };
  });

  return { success: true, data: Object.values(bikeMap) };
}

function notifyAdmins(message, bikes, trailerName) {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(NOTIFICATIONS_SHEET_NAME) || ss.insertSheet(NOTIFICATIONS_SHEET_NAME);
    sheet.appendRow([new Date(), 'ADM', 'trailer_finalizado', trailerName, message, (bikes || []).join(', '), 'pendente']);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function insertBikeMechanics(bikeNumber, mechanicName, targetStatus) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };

  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  const data = sheet.getDataRange().getValues();

  // Verifica se já existe entrada ativa
  for (let i = 1; i < data.length; i++) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    if (rowPat === pStr && rowStatus !== 'Remanejada') {
      // Atualiza entrada existente
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue(targetStatus);
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue('MANUAL');
      return { success: true };
    }
  }

  // Insere nova linha — TRATATIVA = 'MANUAL' para identificar inserção manual
  sheet.appendRow([bikeNumber, targetStatus, new Date(), mechanicName, 'MANUAL', '', '']);
  return { success: true };
}

function confirmMechanicsReceipt(bikeNumber, mechanicName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '') === pStr
        && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] === 'Aguardando Confirmação') {
      const row = i + 1;
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Em Manutenção');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      return { success: true };
    }
  }
  sheet.appendRow([bikeNumber, 'Em Manutenção', new Date(), mechanicName, '', '', '']);
  return { success: true };
}

function finalizeMechanicsRepair(bikeNumber, mechanicName, treatment) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]) === String(bikeNumber)
        && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] === 'Em Manutenção') {
      const row = i + 1;
      // Atualiza cada coluna individualmente para evitar escrita nas colunas erradas
      // Colunas: STATUS(2), MECANICO(4), TRATATIVA(5), DATA_FINALIZACAO(6)
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Reserva');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue(treatment);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue(new Date());
      return { success: true };
    }
  }
  return { success: false, error: 'Bicicleta não encontrada ou não está em manutenção.' };
}

function organizeTrailer(bikeNumbers, trailerName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const bikes = Array.isArray(bikeNumbers) ? bikeNumbers : [bikeNumbers];
  let count = 0;
  for (let i = 1; i < data.length; i++) {
    if (bikes.includes(String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]))
        && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] === 'Reserva') {
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue(trailerName);
      count++;
    }
  }
  return { success: true, message: `${count} bikes organizadas na carretinha ${trailerName}.` };
}

function finalizeTrailer(trailerName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  let count = 0;
  const remanejadas = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COLUMN_INDICES.MECHANICS.CARRETINHA - 1]) === String(trailerName)
        && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] === 'Reserva') {
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Remanejada');
      remanejadas.push(String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]));
      count++;
    }
  }
  if (count > 0) {
  }
  return { success: true, message: `${count} bikes finalizadas da carretinha ${trailerName}.` };
}

// =================================================================
// --- FUNÇÃO DE TESTE (executar manualmente no Apps Script para diagnóstico) ---
// =================================================================
function testMechanics() {
  const result = getMechanicsList();
  Logger.log('=== RESULTADO MECANICA ===');
  Logger.log('Total: ' + result.data.length);
  Logger.log('Aguardando: ' + result.data.filter(b => b.status === 'Aguardando Confirmação').length);
  Logger.log('Em Manutenção: ' + result.data.filter(b => b.status === 'Em Manutenção').length);
  Logger.log('Reserva: ' + result.data.filter(b => b.status === 'Reserva').length);
  Logger.log('--- Bikes Aguardando Confirmação ---');
  result.data.filter(b => b.status === 'Aguardando Confirmação').forEach(b => {
    Logger.log('Bike: ' + b.patrimonio + ' | Data: ' + b.dataEntrada);
  });
}

function testTimestamp() {
  // Testa se parseTimestamp funciona corretamente com datas do Sheets
  const sheet = getSpreadsheet().getSheetByName('Relatorio');
  if (!sheet) { Logger.log('Aba Relatorio não encontrada'); return; }
  const lastRow = sheet.getLastRow();
  const sample = sheet.getRange(lastRow - 10, 1, 10, 3).getValues();
  const CUTOFF_MS = new Date('2026-03-20T00:00:00').getTime();
  sample.forEach((row, i) => {
    const raw = row[0];
    const ts = raw instanceof Date ? raw : parseTimestamp(raw);
    const tsMs = ts ? ts.getTime() : null;
    Logger.log(`Row ${lastRow - 10 + i}: raw=${raw} | type=${typeof raw} | isDate=${raw instanceof Date} | tsMs=${tsMs} | afterCutoff=${tsMs ? tsMs >= CUTOFF_MS : 'null'} | status=${row[2]}`);
  });
}

// =================================================================
// --- LIMPEZA DE DUPLICATAS (executada pelo Trigger periódico) ---
// =================================================================
function cleanupRecentDuplicates() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    if (!sheet) return 0;
    const lastRow = sheet.getLastRow();
    if (lastRow < 3) return 0;
    const numRows = Math.min(lastRow - 1, 200);
    const startRow = lastRow - numRows + 1;
    const data = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();
    const rowsToDelete = [];
    for (let i = data.length - 1; i >= 1; i--) {
      const cur = data[i];
      const curTs  = parseTimestamp(cur[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      const curPat = (cur[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
      const curSt  = (cur[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
      const curMot = (cur[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
      const curLoc = (cur[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim();
      const curObs = (cur[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
      if (!curPat || !curTs) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = data[j];
        const prevTs  = parseTimestamp(prev[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
        if (!prevTs) continue;
        const sameKey = (prev[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim() === curPat
          && (prev[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim() === curSt
          && (prev[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim() === curMot
          && ((prev[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim() === curObs
              || (prev[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim() === curLoc);
        if (sameKey && Math.abs(curTs - prevTs) / 60000 < 10) {
          rowsToDelete.push(startRow + i); break;
        }
      }
    }
    const unique = [...new Set(rowsToDelete)].sort((a, b) => b - a);
    const deletedBikes = unique.map(row => {
      const rowIdx = row - startRow;
      return (data[rowIdx] ? data[rowIdx][COLUMN_INDICES.REPORTS.PATRIMONIO - 1] : '').toString();
    }).filter(Boolean);
    unique.forEach(row => { try { sheet.deleteRow(row); } catch (e) {} });
    if (unique.length > 0) {
      SpreadsheetApp.flush();
      if (deletedBikes.length > 0) {
      }
    }
    return unique.length;
  } finally {
    lock.releaseLock();
  }
}