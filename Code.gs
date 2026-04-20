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
const BACKEND_VERSION = '85.4-resilience-fix';
const CUTOFF_MS = new Date('2026-03-24T00:00:00').getTime();

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
const VANDALIZED_SHEET_NAME    = 'Vandalizadas';
const VANDALISMO_SHEET_NAME    = 'Vandalismo';
const DAILY_SUMMARY_SHEET_NAME = 'ResumoDiario';
const MECHANICS_SHEET_NAME     = 'Mecanica';
const QUEUE_SHEET_NAME         = 'FilaProcessamento';
const ALERTS_SHEET_NAME        = 'Alertas';
const CHASSI_SHEET_NAME        = 'CHASSI';

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
    STATUS_SISTEMA: 6, BATERIA: 7, TRAVA: 8, LOCALIDADE: 9, OCORRENCIA: 10
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
// --- HELPER: leitura da aba Bicicletas sem assumir cabeçalho ---
// A planilha pode ou não ter linha de cabeçalho.
// Se a célula da coluna PATRIMONIO na linha 1 for numérica → sem header.
// Retorna { sheet, startRow, rows } onde rows = array de linhas de dados.
// =================================================================
function getBikesSheetData() {
  const sheet = getSpreadsheet().getSheetByName(BIKES_SHEET_NAME);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { sheet, startRow: 1, rows: [] };
  const firstCell = sheet.getRange(1, COLUMN_INDICES.BIKES.PATRIMONIO).getValue();
  const hasHeader = isNaN(parseFloat(String(firstCell).trim())) || String(firstCell).trim() === '';
  const startRow = hasHeader ? 2 : 1;
  const numRows = lastRow - startRow + 1;
  if (numRows < 1) return { sheet, startRow, rows: [] };
  const rows = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();
  return { sheet, startRow, rows };
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
  
  // Suporte a números (serial dates do Google Sheets)
  if (typeof raw === 'number') {
    // Google Sheets usa dias desde 30/12/1899. 
    // 25569 é a diferença de dias entre 30/12/1899 e 01/01/1970.
    const d = new Date((raw - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d;
  }

  const s = raw.toString().trim();
  
  // Formato BR: DD/MM/YYYY HH:mm:ss ou DD/MM/YYYY (suporta : ou . como separador de tempo)
  const brMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?)?/);
  if (brMatch) {
    const day = parseInt(brMatch[1], 10);
    const month = parseInt(brMatch[2], 10);
    const year = parseInt(brMatch[3], 10);
    const hour = parseInt(brMatch[4] || '0', 10);
    const minute = parseInt(brMatch[5] || '0', 10);
    const second = parseInt(brMatch[6] || '0', 10);
    const d = new Date(year, month - 1, day, hour, minute, second);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Converte qualquer valor de data para ms (timestamp).
 * @param {any} raw Valor bruto da célula.
 * @returns {number|null}
 */
function toMs(raw) {
  const d = parseTimestamp(raw);
  return d ? d.getTime() : null;
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
    else if (action === 'getAlerts')     response = { ...getAlerts(e.parameter.forceScan === 'true'), version: BACKEND_VERSION };
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
      'finalizeMechanicsRepair', 'organizeTrailer', 'finalizeTrailer',
      'moveToAguardandoManutencao', 'declineMechanicsReceipt',
      'markAsNotFound', 'editMechanicsBike', 'deleteMechanicsBike', 'clearAlterarStatus', 'removeFromTrailer',
      'sendToTechnical', 'confirmTechnicaReceipt', 'finalizeTechnicaRepair'
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
      case 'debugSearch':           response = { ...debugSearch(request.bikeNumber), version: BACKEND_VERSION }; break;
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
      case 'getAlerts':             response = { ...getAlerts(request.forceScan === 'true'), version: BACKEND_VERSION }; break;
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
      case 'moveToAguardandoManutencao': response = { ...moveToAguardandoManutencao(request.bikeNumber), version: BACKEND_VERSION }; break;
      case 'declineMechanicsReceipt': response = { ...declineMechanicsReceipt(request.bikeNumber, request.mechanicName), version: BACKEND_VERSION }; break;
      case 'markAsNotFound': response = { ...markAsNotFound(request.bikeNumber, request.mechanicName), version: BACKEND_VERSION }; break;
      case 'editMechanicsBike': response = { ...editMechanicsBike(request.oldPat, request.newPat), version: BACKEND_VERSION }; break;
      case 'deleteMechanicsBike': response = { ...deleteMechanicsBike(request.bikeNumber), version: BACKEND_VERSION }; break;
      case 'clearAlterarStatus':   response = { ...clearAlterarStatus(request.bikes), version: BACKEND_VERSION }; break;
      case 'removeFromTrailer':     response = { ...removeFromTrailer(request.bikeNumber, request.targetStatus), version: BACKEND_VERSION }; break;
      case 'sendToTechnical':       response = { ...sendToTechnical(request.bikeNumber, request.mechanicName), version: BACKEND_VERSION }; break;
      case 'getTechnicaList':       response = { ...getTechnicaList(), version: BACKEND_VERSION }; break;
      case 'getChassiInfo':         response = { ...getChassiInfo(request.bikeNumber), version: BACKEND_VERSION }; break;
      case 'confirmTechnicaReceipt':response = { ...confirmTechnicaReceipt(request.bikeNumber, request.technicianName), version: BACKEND_VERSION }; break;
      case 'finalizeTechnicaRepair':response = { ...finalizeTechnicaRepair(request.bikeNumber, request.technicianName, request.treatment), version: BACKEND_VERSION }; break;
      case 'insertBikeMechanics':   response = { ...insertBikeMechanics(request.bikeNumber, request.driverName, request.targetStatus), version: BACKEND_VERSION }; break;
      case 'notifyAdmins':          response = { ...notifyAdmins(request.message, request.bikes, request.trailerName), version: BACKEND_VERSION }; break;
      case 'finalizeMechanicsRepair': response = { ...finalizeMechanicsRepair(request.bikeNumber, request.mechanicName, request.treatment), version: BACKEND_VERSION }; break;
      case 'markAsVandalizedNoRecovery': response = { ...markAsVandalizedNoRecovery(request.bikeNumber, request.mechanicName, request.room, request.observation || request.reasons), version: BACKEND_VERSION }; break;
      case 'organizeTrailer':       response = { ...organizeTrailer(request.bikeNumbers, request.trailerName), version: BACKEND_VERSION }; break;
      case 'finalizeTrailer':       response = { ...finalizeTrailer(request.trailerName), version: BACKEND_VERSION }; break;
      case 'getAnalyticalDashboardData': response = { ...getAnalyticalDashboardData(request.timeRange), version: BACKEND_VERSION }; break;
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
    const bd = getBikesSheetData();
    if (!bd) throw new Error('Planilha "' + BIKES_SHEET_NAME + '" não encontrada.');
    const bikes = bd.rows.map(row => ({
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
  rangeKm  = rangeKm  || 2; // máximo 2 km
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

    // --- Monta set de bikes ocupadas (em posse ou em roteiro de QUALQUER motorista) ---
    const occupiedBikes = new Set();
    try {
      const stateSheet = getSpreadsheet().getSheetByName(STATE_SHEET_NAME);
      if (stateSheet && stateSheet.getLastRow() > 1) {
        const stateData = stateSheet.getRange(2, 1, stateSheet.getLastRow() - 1, stateSheet.getLastColumn()).getValues();
        stateData.forEach(row => {
          const routeStr     = (row[COLUMN_INDICES.STATE.ROTEIRO    - 1] || '').toString();
          const collectedStr = (row[COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString();
          routeStr.split(',').forEach(b => { const t = b.trim(); if (t) occupiedBikes.add(t); });
          collectedStr.split(',').forEach(b => { const t = b.trim(); if (t) occupiedBikes.add(t); });
        });
      }
    } catch (e) {
      console.warn('generateDriverRoute: erro ao ler estados — ' + e.message);
    }
    // ---------------------------------------------------------------------------------

    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60000);

    const filteredBikes = allBikes.filter(bike => {
      const pat = String(bike.patrimonio || '').trim();

      // Ignora bikes em posse ou roteiro de qualquer motorista
      if (occupiedBikes.has(pat)) return false;
      const patNoZeros = String(parseFloat(pat));
      if (patNoZeros !== 'NaN' && occupiedBikes.has(patNoZeros)) return false;

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
      return { success: true, data: [], message: 'Nenhuma bicicleta encontrada num raio de ' + rangeKm + ' km.' };
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

    return { success: true, data: route, message: `Roteiro gerado com ${route.length} bicicleta(s) em até ${rangeKm} km.` };
  } catch (e) {
    return { success: false, error: 'Erro ao gerar roteiro: ' + e.message };
  }
}

function handleSync(request) {
  const { driverName, category, summaryTimeRange, statusTimeRange, timelineDate } = request;
  const cacheKey = `handleSync_${driverName || 'all'}_${category || 'all'}_${summaryTimeRange || 'day'}_${statusTimeRange || 'day'}_${timelineDate || 'none'}`;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      parsed.cached = true;
      return parsed;
    } catch (e) {}
  }

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
      const alertsResult = getAlerts();
      if (alertsResult.success) {
        response.data.alerts = alertsResult.data || [];
        response.data.alertsVersion = alertsResult.version || '';
        console.log('Sync alerts: ' + (response.data.alerts.length) + ' itens');
      } else {
        console.error('Erro em getAlerts durante sync:', alertsResult.error);
      }
      
      const vandalizedResult = getVandalized();
      if (!vandalizedResult.success) {
        console.error('Erro em getVandalized durante sync:', vandalizedResult.error);
      }
      response.data.vandalized = vandalizedResult.data || [];
      
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

    try {
      cache.put(cacheKey, JSON.stringify(response), 8); // Cache de 8 segundos
    } catch (e) {}

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

    const ss = getSpreadsheet();
    const sheets = ss.getSheets();
    const allData = {};

    sheets.forEach(sheet => {
      const name = sheet.getName();
      const data = sheet.getDataRange().getValues();
      if (data.length < 1) {
        allData[name] = [];
        return;
      }
      const headers = data[0];
      const rows = data.slice(1).map(row => {
        const obj = {};
        headers.forEach((h, i) => { 
          const key = h ? String(h).trim() : `col_${i}`;
          obj[key] = row[i]; 
        });
        return obj;
      });
      allData[name] = rows;
    });

    return {
      success: true,
      data: allData
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
    const user = (row[COLUMN_INDICES.ACCESS.USUARIO - 1] || '').toString().trim();
    const lowerUser = user.toLowerCase();
    const cat = normalizeCategory(row[COLUMN_INDICES.ACCESS.CATEGORIA - 1]);
    if (!cat.includes('MOTORISTA') || lowerUser.includes('aline') || lowerUser.includes('diego')) return;

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
function getBikeIndex(forceReload = false) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'bikes_index';
  const cached = forceReload ? null : cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const sheet = getSpreadsheet().getSheetByName(BIKES_SHEET_NAME);
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  if (!data.length) return {};

  // Detecta se linha 1 é cabeçalho ou dado numérico
  // Planilha sem header: primeira célula da coluna patrimônio é numérica
  const firstCell = String(data[0][COLUMN_INDICES.BIKES.PATRIMONIO - 1]).trim();
  const hasHeader = isNaN(parseFloat(firstCell)) || firstCell === '';
  const rows = hasHeader ? data.slice(1) : data;

  const index = {};
  rows.forEach(row => {
    const pat = String(row[COLUMN_INDICES.BIKES.PATRIMONIO - 1]).trim();
    if (!pat || pat === '0') return;
    index[pat] = row;
    // Indexa também sem zeros à esquerda e como número puro
    // Ex: "0111" → também indexa "111"; 111 (number) → também indexa "111"
    const patNoZeros = String(parseFloat(pat));
    if (patNoZeros !== pat && patNoZeros !== 'NaN') index[patNoZeros] = row;
  });

  try { cache.put(cacheKey, JSON.stringify(index), 300); } catch (e) {} // Cache aumentado para 300s (5 min)
  return index;
}

function debugSearch(bikeNumber) {
  try {
    const ss = getSpreadsheet();
    const allSheets = ss.getSheets().map(s => s.getName());
    const sheet = ss.getSheetByName(BIKES_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Aba não encontrada', sheetName: BIKES_SHEET_NAME, allSheets };
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    // Lê primeiras 5 linhas para diagnóstico
    const sample = sheet.getRange(1, 1, Math.min(6, lastRow), Math.min(lastCol, 5)).getValues();
    const colBSample = lastRow > 1
      ? sheet.getRange(2, COLUMN_INDICES.BIKES.PATRIMONIO, Math.min(5, lastRow - 1), 1).getValues().map(r => ({ val: r[0], type: typeof r[0] }))
      : [];
    const index = getBikeIndex(true);
    const indexKeys = Object.keys(index);
    return {
      success: true,
      sheetName: BIKES_SHEET_NAME,
      allSheets,
      lastRow,
      lastCol,
      patrimonioColunaIndex: COLUMN_INDICES.BIKES.PATRIMONIO,
      primeiraLinhaHeaders: sample[0] || [],
      primeiros5Patrimonios: colBSample,
      totalIndexado: indexKeys.length,
      amostraIndexKeys: indexKeys.slice(0, 10),
      buscando: bikeNumber,
      tipoBuscado: typeof bikeNumber
    };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function getChassiInfo(bikeNumber) {
  if (!bikeNumber) return { success: false, error: 'Número do patrimônio não fornecido.' };
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CHASSI_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Aba "CHASSI" não encontrada na planilha.' };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Nenhum dado encontrado na aba CHASSI.' };

    const data = sheet.getRange(2, 2, lastRow - 1, 14).getValues(); // Coluna B (2) até O (15)
    const bikeNumStr = String(bikeNumber).trim();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const patrimonio = String(row[0]).trim(); // Coluna B (index 0 no range)

      if (patrimonio === bikeNumStr) {
        return {
          success: true,
          data: {
            patrimonio: patrimonio,
            chassi: row[1],      // Coluna C (index 1)
            imei: row[9],        // Coluna K (index 9)
            status: row[12],     // Coluna N (index 12)
            telefone: row[13]    // Coluna O (index 13)
          }
        };
      }
    }

    return { success: false, error: `Patrimônio "${bikeNumber}" não encontrado na aba CHASSI.` };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar informações do chassi: ' + e.message };
  }
}

function searchBike(bikeNumber) {
  if (!bikeNumber) return { success: false, error: 'Número da bicicleta não informado.' };
  const bikeStr = String(bikeNumber).trim();
  const bikeNum = parseFloat(bikeStr);

  try {
    // Usa o índice em cache (10 min) — evita re-leitura da planilha a cada busca.
    // getBikeIndex() indexa por string E por número sem zeros à esquerda.
    const index = getBikeIndex();

    // Tenta match direto pela string
    let row = index[bikeStr];

    // Fallback: match numérico (ex: "111" encontra 111 armazenado como número)
    if (!row && !isNaN(bikeNum)) {
      const bikeNumStr = String(bikeNum); // remove zeros à esquerda
      row = index[bikeNumStr];
    }

    if (!row) {
      const debugInfo = debugSearch(bikeStr);
      return { 
        success: false, 
        error: `Bicicleta "${bikeStr}" não encontrada.`,
        debug: debugInfo
      };
    }

    const bikeObject = {
      'Patrimônio':                  row[COLUMN_INDICES.BIKES.PATRIMONIO - 1],
      'Status':                      row[COLUMN_INDICES.BIKES.STATUS - 1],
      'Localidade':                  row[COLUMN_INDICES.BIKES.LOCALIDADE - 1],
      'Usuário':                     row[COLUMN_INDICES.BIKES.USUARIO - 1],
      'Bateria':                     row[COLUMN_INDICES.BIKES.BATERIA - 1],
      'Trava':                       row[COLUMN_INDICES.BIKES.TRAVA - 1],
      'Carregamento':                row[COLUMN_INDICES.BIKES.CARREGAMENTO - 1],
      'Última informação da posição':row[COLUMN_INDICES.BIKES.ULTIMA_INFO - 1],
      'Latitude':  parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
      'Longitude': parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
      'ocorrencia': false
    };

    // Check if it's an active request
    const requestsSheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
    if (requestsSheet) {
      const lastRow = requestsSheet.getLastRow();
      if (lastRow > 1) {
        const numRows = Math.min(lastRow - 1, 500);
        const reqData = requestsSheet.getRange(lastRow - numRows + 1, 1, numRows, requestsSheet.getLastColumn()).getValues();
        const normalizedSearch = String(parseFloat(bikeStr) || bikeStr);
        for (let i = reqData.length - 1; i >= 0; i--) {
          const patRaw = String(reqData[i][COLUMN_INDICES.REQUESTS.PATRIMONIO - 1]).trim();
          const situacao = String(reqData[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1]).trim().toLowerCase();
          const pats = patRaw.split(',').map(s => String(parseFloat(s.trim()) || s.trim()));
          if (pats.includes(normalizedSearch) && (situacao === 'aceita' || situacao === 'pendente')) {
            const local = String(reqData[i][COLUMN_INDICES.REQUESTS.LOCAL - 1] || '');
            if (!local.toLowerCase().includes('app')) {
              bikeObject.ocorrencia = true;
              break;
            }
          }
        }
      }
    }

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

    // Atualização incremental de alertas (Evita varredura pesada no getAlerts)
    try {
      updateAlertFromReport(patrimonio, status, rowData[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
    } catch (alertErr) {
      console.error('Erro ao atualizar alerta incremental:', alertErr);
    }

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
      // Divergência identificada no relatório. Notificação será enviada pelo App.
      return { success: true, divergence: true, patrimonio: patrimonio };
    } else if (statusLower === 'vandalizada') {
      updateVandalizedSheet(patrimonio, rowData);
      updateVandalismoSheet(rowData);
    } else {
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
    .filter(row => {
      const cat = normalizeCategory(row[COLUMN_INDICES.ACCESS.CATEGORIA - 1]);
      const user = (row[COLUMN_INDICES.ACCESS.USUARIO - 1] || '').toString().trim();
      const lowerUser = user.toLowerCase();
      return cat.includes('MOTORISTA') && !lowerUser.includes('aline') && !lowerUser.includes('diego');
    })
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
  const bd = getBikesSheetData();
  if (!bd || bd.rows.length === 0) return { success: true, data: [] };
  const numbers = bd.rows.map(r => r[COLUMN_INDICES.BIKES.PATRIMONIO - 1]).filter(v => v !== '' && v !== null && v !== undefined);
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
    collectedBikes = collectedBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());

    if (finalStatus === 'Recolhida') {
      collectedBikes.push(bikeNumber);
    } 

    const statusLower = finalStatus.toLowerCase();
    if (statusLower.includes('recolhida') || statusLower.includes('vandalizada') || statusLower.includes('filial')) {
      addToMechanics(bikeNumber);
    }

    if (finalStatus !== 'Recolhida' || true) { // Permitindo Recolhida no relatório conforme solicitação
      const rowData = [new Date(), bikeNumber, finalStatus, finalObservation, driverName,
        bikeDetails['Status'], bikeDetails['Bateria'], bikeDetails['Trava'], bikeDetails['Localidade']];
      return logReport(rowData);
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

    routeBikes     = routeBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    collectedBikes = collectedBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    
    const reportStatus = finalStatus === 'Filial' ? 'Recolhida' : finalStatus;
    
    // Create row with 10 columns to include the new OCORRENCIA column
    const rowData = new Array(10).fill('');
    rowData[COLUMN_INDICES.REPORTS.TIMESTAMP - 1] = new Date();
    rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] = bikeNumber;
    rowData[COLUMN_INDICES.REPORTS.STATUS - 1] = reportStatus;
    rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] = finalObservation;
    rowData[COLUMN_INDICES.REPORTS.MOTORISTA - 1] = driverName;
    rowData[COLUMN_INDICES.REPORTS.STATUS_SISTEMA - 1] = bikeDetails['Status'];
    rowData[COLUMN_INDICES.REPORTS.BATERIA - 1] = bikeDetails['Bateria'];
    rowData[COLUMN_INDICES.REPORTS.TRAVA - 1] = bikeDetails['Trava'];
    rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] = bikeDetails['Localidade'];
    
    // If it's an occurrence, mark it in the new column
    if (finalObservation.includes('Solicitado Recolha')) {
      rowData[COLUMN_INDICES.REPORTS.OCORRENCIA - 1] = 'Ocorrência';
      // Remove the tag from observation as requested
      rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] = finalObservation.replace('Solicitado Recolha - ', '').replace('Solicitado Recolha', '').trim();
    }

    let reportResult = { success: true };
    if (finalStatus !== 'Carretinha') {
      reportResult = logReport(rowData);
    }

    const statusLower = finalStatus.toLowerCase();
    if (statusLower.includes('filial') || statusLower.includes('vandalizada') || statusLower.includes('recolhida')) {
      addToMechanics(bikeNumber);
    }

    updateDriverState(driverName, routeBikes, collectedBikes);
    return { ...reportResult, bikeDetails };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// =================================================================
// --- ALERTAS E VANDALIZADAS ---
// =================================================================
function resolveAlert(patrimonio, motorista) {
  // Função mantida para compatibilidade se necessário, mas sem ação
  return;
}

function getAlerts(forceScan = false) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'alerts_data_v13';
  const cached = cache.get(cacheKey);
  
  if (!forceScan && cached) { 
    try { 
      const data = JSON.parse(cached);
      if (Array.isArray(data)) {
        console.log(`getAlerts: Retornando ${data.length} itens do cache (v13)`);
        return { success: true, data: data, cached: true, version: 'v13' }; 
      }
    } catch (e) {} 
  }

  const startTime = Date.now();
  try {
    const ss = getSpreadsheet();
    // Busca ultra-robusta
    let alertsSheet = ss.getSheetByName(ALERTS_SHEET_NAME) || ss.getSheetByName('Alertas') || ss.getSheetByName('Alerta');
    if (!alertsSheet) {
      const sheets = ss.getSheets();
      alertsSheet = sheets.find(s => {
        const n = s.getName().toLowerCase().trim();
        return n === 'alertas' || n === 'alerta' || n === ALERTS_SHEET_NAME.toLowerCase().trim();
      });
    }
    
    if (!alertsSheet) {
      alertsSheet = getOrCreateSheet(ALERTS_SHEET_NAME, ['Patrimônio', 'Check 1', 'Check 2', 'Check 3', 'Situação', 'Encontrada Por', 'Data Encontrada']);
    }
    
    let lastRowAlerts = alertsSheet.getLastRow();
    let alertsData = [];
    if (lastRowAlerts > 1) {
      alertsData = alertsSheet.getRange(2, 1, lastRowAlerts - 1, 7).getValues();
    }

    // Se a planilha estiver vazia OU for solicitado forceScan, fazemos a varredura no Relatório
    // Consideramos vazia se não houver nenhuma linha com status Pendente ou Localizada
    const hasActiveAlerts = alertsData.some(row => {
      const sit = String(row[4] || '').trim().toLowerCase();
      return sit === 'pendente' || sit === 'localizada' || sit === STATUS.PENDENTE.toLowerCase() || sit === STATUS.LOCALIZADA.toLowerCase();
    });
    console.log(`getAlerts: hasActiveAlerts=${hasActiveAlerts}, forceScan=${forceScan}`);

    if (!hasActiveAlerts || forceScan) {
      console.log('Iniciando varredura no Relatório (forceScan=' + forceScan + ', hasActive=' + hasActiveAlerts + ')');
      try {
        const confirmedAlerts = {};
        alertsData.forEach(row => {
          const pat = String(row[0] || '').trim();
          const sit = String(row[4] || '').trim().toLowerCase();
          const dt  = row[6];
          if ((sit === 'encontrada' || sit === 'recuperada' || sit === STATUS.ENCONTRADA.toLowerCase() || sit === STATUS.RECUPERADA.toLowerCase()) && dt) {
            const t = dt instanceof Date ? dt.getTime() : new Date(dt).getTime();
            if (!isNaN(t)) {
              if (!confirmedAlerts[pat] || t > confirmedAlerts[pat]) confirmedAlerts[pat] = t;
            }
          }
        });

        const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME) || ss.getSheetByName('Relatorio') || ss.getSheetByName('Relatório');
        if (reportSheet) {
          const lastRowReport = reportSheet.getLastRow();
          if (lastRowReport > 1) {
            const lastRowReport = reportSheet.getLastRow();
            const numRows = Math.min(lastRowReport - 1, 20000);
            const startRow = Math.max(2, lastRowReport - 20000 + 1);
            console.log(`Scan Relatório: lastRow=${lastRowReport}, numRows=${numRows}, startRow=${startRow}`);
            const reportData = reportSheet.getRange(startRow, 1, numRows, 3).getValues();
            const bikeHistory = {};

            for (let i = 0; i < reportData.length; i++) {
              if (Date.now() - startTime > 25000) break;
              
              const row = reportData[i];
              const tsRaw = row[0];
              const pat = String(row[1] || '').trim();
              const st = String(row[2] || '').trim().toLowerCase();
              
              if (!tsRaw || !pat) continue;
              const ts = parseTimestamp(tsRaw);
              if (!ts) continue;
              
              const tsTime = ts.getTime();
              if (confirmedAlerts[pat] && confirmedAlerts[pat] >= tsTime) {
                delete bikeHistory[pat];
                continue;
              }
              
              const isMissing = st === 'não encontrada' || st === 'nao encontrada';
              const isFound = st.includes('remanejada') || st.includes('estação') || st.includes('estacao') || st.includes('filial') || st.includes('vandalizada') || st.includes('recolhida') || st.includes('mecanica') || st.includes('manutenção') || st.includes('manutencao') || st.includes('tecnica');
              
              if (isMissing) {
                if (!bikeHistory[pat] || bikeHistory[pat].situacao === STATUS.LOCALIZADA) {
                  bikeHistory[pat] = { patrimonio: pat, checks: [ts], situacao: STATUS.PENDENTE };
                } else if (bikeHistory[pat].situacao === STATUS.PENDENTE) {
                  if (bikeHistory[pat].checks.length < 3) {
                    bikeHistory[pat].checks.push(ts);
                  }
                }
              } else if (isFound) {
                if (bikeHistory[pat] && bikeHistory[pat].situacao === STATUS.PENDENTE) {
                  bikeHistory[pat].situacao = STATUS.LOCALIZADA;
                }
              }
            }

            const patsInSheet = alertsData.map(r => String(r[0]).trim());
            let sheetChanged = false;
            
            for (let i = 0; i < alertsData.length; i++) {
              const pat = patsInSheet[i];
              if (bikeHistory[pat]) {
                const h = bikeHistory[pat];
                alertsData[i][1] = h.checks[0] || '';
                alertsData[i][2] = h.checks[1] || '';
                alertsData[i][3] = h.checks[2] || '';
                alertsData[i][4] = h.situacao;
                sheetChanged = true;
                delete bikeHistory[pat];
              }
            }
            
            if (sheetChanged && alertsData.length > 0) {
              alertsSheet.getRange(2, 1, alertsData.length, 7).setValues(alertsData);
            }
            
            const newRows = Object.values(bikeHistory).filter(h => h.checks.length > 0).map(h => {
              const row = new Array(7).fill('');
              row[0] = h.patrimonio;
              row[1] = h.checks[0] || '';
              row[2] = h.checks[1] || '';
              row[3] = h.checks[2] || '';
              row[4] = h.situacao;
              return row;
            });
            
            if (newRows.length > 0) {
              alertsSheet.getRange(alertsSheet.getLastRow() + 1, 1, newRows.length, 7).setValues(newRows);
              sheetChanged = true;
            }
            
            if (sheetChanged) {
              const finalData = alertsSheet.getDataRange().getValues();
              finalData.shift();
              alertsData = finalData;
            }
          }
        }
      } catch (scanError) {
        console.error('Erro na varredura de recuperação:', scanError);
      }
    }

    const alerts = alertsData.map((row, idx) => {
      const sit = String(row[4] || '').trim().toLowerCase();
      if (sit === 'pendente' || sit === 'localizada' || sit === STATUS.PENDENTE.toLowerCase() || sit === STATUS.LOCALIZADA.toLowerCase()) {
        return { 
          id: idx + 2, 
          patrimonio: String(row[0] || '').trim(), 
          check1: row[1], 
          check2: row[2], 
          check3: row[3], 
          situacao: row[4] 
        };
      }
      return null;
    }).filter(Boolean);

    try { cache.put(cacheKey, JSON.stringify(alerts), 300); } catch (e) {} // 5 min cache
    console.log(`getAlerts finalizado (v13): ${alerts.length} alertas encontrados.`);
    return { success: true, data: alerts, version: 'v13', count: alerts.length };
  } catch (e) {
    console.error('Erro em getAlerts:', e);
    return { success: false, error: 'Erro ao processar alertas: ' + e.message };
  }
}

/**
 * Atualiza a aba de Alertas de forma incremental a partir de um novo registro no Relatório.
 * Chamado pelo logReport para manter a lista de alertas sempre atualizada sem varreduras.
 */
function updateAlertFromReport(patrimonio, status, timestamp) {
  if (!patrimonio || !status) return;
  
  const st = status.toString().toLowerCase().trim();
  const pat = patrimonio.toString().trim();
  
  const isMissing = st === 'não encontrada' || st === 'nao encontrada';
  const isFound = st.includes('remanejada') || st.includes('estação') || st.includes('estacao') || st.includes('filial') || st.includes('vandalizada') || st.includes('recolhida') || st.includes('mecanica') || st.includes('manutenção') || st.includes('manutencao') || st.includes('tecnica');
  
  if (!isMissing && !isFound) return;

  try {
    const ss = getSpreadsheet();
    let alertsSheet = ss.getSheetByName(ALERTS_SHEET_NAME) || ss.getSheetByName('Alertas') || ss.getSheetByName('Alerta');
    if (!alertsSheet) return;

    const lastRow = alertsSheet.getLastRow();
    let data = [];
    if (lastRow > 1) {
      data = alertsSheet.getRange(2, 1, lastRow - 1, 7).getValues();
    }

    let foundIdx = -1;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === pat) {
        foundIdx = i;
        break;
      }
    }

    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp);

    if (isMissing) {
      if (foundIdx === -1) {
        // Nova bike em alerta
        alertsSheet.appendRow([pat, ts, '', '', STATUS.PENDENTE, '', '']);
      } else {
        const rowData = data[foundIdx];
        const sit = String(rowData[4]).trim().toLowerCase();
        
        if (sit === STATUS.LOCALIZADA.toLowerCase()) {
          // Se estava localizada e sumiu de novo, volta para pendente e reseta checks
          alertsSheet.getRange(foundIdx + 2, 2).setValue(ts);
          alertsSheet.getRange(foundIdx + 2, 3, 1, 2).setValues([['', '']]);
          alertsSheet.getRange(foundIdx + 2, 5).setValue(STATUS.PENDENTE);
        } else if (sit === STATUS.PENDENTE.toLowerCase() || sit === 'pendente') {
          // Adiciona Check 2 ou 3
          if (!rowData[1]) {
             alertsSheet.getRange(foundIdx + 2, 2).setValue(ts);
          } else if (!rowData[2]) {
             alertsSheet.getRange(foundIdx + 2, 3).setValue(ts);
          } else if (!rowData[3]) {
             alertsSheet.getRange(foundIdx + 2, 4).setValue(ts);
          }
        }
      }
    } else if (isFound) {
      if (foundIdx !== -1) {
        const sit = String(data[foundIdx][4]).trim().toLowerCase();
        if (sit === STATUS.PENDENTE.toLowerCase() || sit === 'pendente') {
          alertsSheet.getRange(foundIdx + 2, 5).setValue(STATUS.LOCALIZADA);
        }
      }
    }
    
    // Invalida cache de alertas
    CacheService.getScriptCache().remove('alerts_data_v13');
  } catch (e) {
    console.error('Erro em updateAlertFromReport:', e);
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
    CacheService.getScriptCache().remove('alerts_data_v13');
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
    const ss = getSpreadsheet();
    const vandalizedSheet = getOrCreateSheet(VANDALIZED_SHEET_NAME,
      ['Patrimônio', 'Data', 'Defeito', 'Local', 'Situação', 'Encontrada Por', 'Data Encontrada']);
    
    let reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    if (!reportSheet) {
      reportSheet = ss.getSheetByName('Relatório'); // Tenta com acento
    }

    const confirmedVandalized = {};
    const lastRowV = vandalizedSheet.getLastRow();
    if (lastRowV > 1) {
      vandalizedSheet.getRange(2, 1, lastRowV - 1, Math.max(vandalizedSheet.getLastColumn(), 7)).getValues()
        .forEach(row => {
          const pat = (row[COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1] || '').toString().trim();
          const sit = (row[COLUMN_INDICES.VANDALIZED.SITUACAO - 1] || '').toString().trim().toLowerCase();
          const dt  = row[COLUMN_INDICES.VANDALIZED.DATA_ENCONTRADA - 1];
          if ((sit === STATUS.ENCONTRADA.toLowerCase() || sit === 'encontrada') && dt) {
            const t = new Date(dt).getTime();
            if (!confirmedVandalized[pat] || t > confirmedVandalized[pat]) confirmedVandalized[pat] = t;
          }
        });
    }

    if (reportSheet) {
      const lastRowReport = reportSheet.getLastRow();
      const rowsToRead = Math.min(lastRowReport - 1, 5000);
      const reportData = rowsToRead > 0
        ? reportSheet.getRange(lastRowReport - rowsToRead + 1, 1, rowsToRead, reportSheet.getLastColumn()).getValues() : [];

      const vandalizedHistory = {};
      [...reportData].sort((a, b) => {
        const dateA = a[0] instanceof Date ? a[0] : new Date(a[0]);
        const dateB = b[0] instanceof Date ? b[0] : new Date(b[0]);
        return dateB.getTime() - dateA.getTime();
      }).forEach(row => {
        const ts  = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]); if (!ts) return;
        const pat = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
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
          const patInSheet = (currentVData[i][0] || '').toString().trim();
          const sitInSheet = (currentVData[i][4] || '').toString().trim().toLowerCase();
          if (patInSheet === v.patrimonio && 
              sitInSheet !== STATUS.ENCONTRADA.toLowerCase() && 
              sitInSheet !== 'encontrada') {
            rowIndex = i + 1; 
            break;
          }
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
    }

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
  // Função removida conforme solicitação
  return;
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
  // Função removida conforme solicitação — notificações agora via Firebase
  return;
}


function getAdminAlerts(adminName) {
  return { success: true, alerts: [] };
}


function clearAdminAlerts(adminName) {
  return { success: true };
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
      summaryData.bateria || summaryData.bateriaCount || 0,
      summaryData.manutBike || summaryData.manutBikeCount || 0,
      summaryData.manutLocker || summaryData.manutLockerCount || 0,
      summaryData.solicitadoRecolha || summaryData.solicitadoRecolhaCount || 0,
      summaryData.remanejadas || summaryData.remanejadasCount || 0,
      summaryData.ocorrencias || summaryData.ocorrenciasCount || 0,
      summaryData.naoEncontradas || summaryData.naoEncontradasCount || 0,
      summaryData.vandalizadas || summaryData.vandalizadasCount || 0,
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
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  if (timeRange === 'week') {
    const day = filterDate.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    filterDate.setDate(filterDate.getDate() + diff);
  } else if (timeRange === 'month') {
    filterDate.setDate(1);
  } else if (timeRange === '-1') {
    filterDate.setDate(filterDate.getDate() - 1);
    todayEnd.setDate(todayEnd.getDate() - 1);
  } else if (timeRange === '-7') {
    // Semana anterior (Segunda a Domingo)
    const day = filterDate.getDay();
    const diffToMon = (day === 0 ? -6 : 1) - day;
    filterDate.setDate(filterDate.getDate() + diffToMon - 7);
    todayEnd.setDate(filterDate.getDate() + 6);
    todayEnd.setHours(23, 59, 59, 999);
  }

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
      } else if (statusLower.includes('estação') || statusLower.includes('estacao')) {
        if (!report.remanejadas.includes(patrimonio)) report.remanejadas.push(patrimonio);
        const stationName = observacao || 'Estação';
        report.estacoes[stationName] = (report.estacoes[stationName] || 0) + 1;
      } else if (statusLower.includes('não encontrada') || statusLower.includes('nao encontrada')) {
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

    try { cache.put(cacheKey, JSON.stringify(conflicts), 5); } catch (e) {} // Cache reduzido para 5s
    return { success: true, data: conflicts };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar status das bikes: ' + e.message };
  }
}

function getReporData() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'repor_data';
  const cached = cache.get(cacheKey);
  if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {} }

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
    try { cache.put(cacheKey, JSON.stringify(data), 5); } catch (e) {} // Cache de 5s
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
        .filter(row => {
          const cat = normalizeCategory(row[COLUMN_INDICES.ACCESS.CATEGORIA - 1]);
          const user = (row[COLUMN_INDICES.ACCESS.USUARIO - 1] || '').toString().trim();
          const lowerUser = user.toLowerCase();
          return cat.includes('MOTORISTA') && !lowerUser.includes('aline') && !lowerUser.includes('diego');
        })
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
      const diffToMon = (day === 0 ? -6 : 1) - day;
      filterDate.setDate(now.getDate() + diffToMon);
      rowsToRead = 50000;
    } else if (timeRange === 'month') {
      filterDate.setDate(1); rowsToRead = 80000;
    } else if (timeRange === '-1') {
      filterDate.setDate(now.getDate() - 1); 
      endDate.setDate(now.getDate() - 1); 
      rowsToRead = 30000;
    } else if (timeRange === '-7') {
      const day = now.getDay();
      const diffToMon = (day === 0 ? -6 : 1) - day;
      filterDate.setDate(now.getDate() + diffToMon - 7);
      endDate.setDate(filterDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
      rowsToRead = 80000;
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
      else if (status.includes('estação') || status.includes('estacao')) stats[driverKey].remanejada++;
      else if (status.includes('não encontrada') || status.includes('nao encontrada')) stats[driverKey].naoEncontrada++;
      else if (status.includes('não atendida') || status.includes('nao atendida')) stats[driverKey].naoAtendida++;
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
          const isOcc = String(row[COLUMN_INDICES.REPORTS.OCORRENCIA - 1] || '').trim() === 'Ocorrência';
          timelines[driverKey].push({ 
            tsMs: ts.getTime(), 
            hour: ts.getHours(), 
            min: ts.getMinutes(), 
            type, 
            bikeNumber: pat, 
            observacao: obs,
            isOccurrence: isOcc
          });
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

function getAnalyticalDashboardData(timeRange) {
  const ss = getSpreadsheet();
  try {
    const now = new Date();
    let filterDate = new Date(now);
    filterDate.setHours(0, 0, 0, 0);
    let endDate = new Date(now);
    endDate.setHours(23, 59, 59, 999);
    let rowsToRead = 5000;

    if (timeRange === 'week') {
      const day = now.getDay();
      const diffToMon = (day === 0 ? -6 : 1) - day;
      filterDate.setDate(now.getDate() + diffToMon);
      rowsToRead = 60000;
    } else if (timeRange === 'month') {
      filterDate.setDate(1);
      rowsToRead = 100000;
    } else if (timeRange === '-1') {
      filterDate.setDate(now.getDate() - 1);
      endDate.setDate(now.getDate() - 1);
      endDate.setHours(23, 59, 59, 999);
      rowsToRead = 30000;
    } else if (timeRange === '-7') {
      // Semana anterior (Segunda a Domingo)
      const day = now.getDay();
      const diffToMon = (day === 0 ? -6 : 1) - day;
      filterDate.setDate(now.getDate() + diffToMon - 7);
      endDate.setDate(filterDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
      rowsToRead = 60000;
    } else if (timeRange === '-30') {
      // Mes anterior
      filterDate.setMonth(now.getMonth() - 1);
      filterDate.setDate(1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      rowsToRead = 100000;
    }

    const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    const accessSheet = ss.getSheetByName(ACCESS_SHEET_NAME);
    
    if (!reportSheet) return { success: false, error: 'Planilha de relatórios não encontrada.' };

    const motoristasSet = new Set();
    if (accessSheet) {
      const lastRowA = accessSheet.getLastRow();
      if (lastRowA > 1) {
        const accessData = accessSheet.getRange(2, 1, lastRowA - 1, accessSheet.getLastColumn()).getValues();
        accessData.forEach(row => {
          if (normalizeCategory(row[COLUMN_INDICES.ACCESS.CATEGORIA - 1]).includes('MOTORISTA')) {
            motoristasSet.add(row[COLUMN_INDICES.ACCESS.USUARIO - 1].toString().trim());
          }
        });
      }
    }

    const lastRowR = reportSheet.getLastRow();
    let reportData = [];
    if (lastRowR > 1) {
      const numRows = Math.min(lastRowR - 1, rowsToRead);
      const numCols = Math.max(reportSheet.getLastColumn(), 10);
      reportData = reportSheet.getRange(lastRowR - numRows + 1, 1, numRows, numCols).getValues();
    }

    const stats = {}; 
    motoristasSet.forEach(driver => {
      const lowerDriver = driver.toLowerCase();
      if (lowerDriver.includes('aline') || lowerDriver.includes('diego')) return;
      stats[driver] = { 
        recolhidas: 0, 
        remanejadas: 0, 
        ocorrencias: 0, 
        naoEncontradas: 0,
        solicitacoesRecebidas: 0
      };
    });

    // Process Report Data for counts
    for (let i = 0; i < reportData.length; i++) {
      const row = reportData[i];
      const ts = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      if (!ts || ts < filterDate || ts > endDate) continue;

      const driver = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
      if (!driver || !stats[driver]) continue;

      const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
      const obs = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().toLowerCase();

      // Logic consistent with getDriversSummary and getDailyReportData
      if (status.includes('filial') || status.includes('recolhida') || status === 'vandalizada') {
        stats[driver].recolhidas++;
        // Check the new OCORRENCIA column (index 10) or fallback to observation for old records
        const occVal = String(row[COLUMN_INDICES.REPORTS.OCORRENCIA - 1] || '').trim().toLowerCase();
        const isOccurrence = occVal.includes('ocorr') || obs.includes('solicitado recolha');
        if (isOccurrence) {
          stats[driver].ocorrencias++;
        }
      } else if (status.includes('estação') || status.includes('estacao')) {
        stats[driver].remanejadas++;
        // Also check for occurrences delivered to stations
        const occVal = String(row[COLUMN_INDICES.REPORTS.OCORRENCIA - 1] || '').trim().toLowerCase();
        const isOccurrence = occVal.includes('ocorr') || obs.includes('solicitado recolha');
        if (isOccurrence) {
          stats[driver].ocorrencias++;
        }
      } else if (status.includes('não encontrada') || status.includes('nao encontrada')) {
        stats[driver].naoEncontradas++;
        // Check the new OCORRENCIA column or fallback to observation
        const occVal = String(row[COLUMN_INDICES.REPORTS.OCORRENCIA - 1] || '').trim().toLowerCase();
        const isOccurrence = occVal.includes('ocorr') || obs.includes('solicitado recolha');
        if (isOccurrence) {
          // We don't increment ocorrencias here because ocorrencias represents "found" in the current formula
        }
      }
    }

    // Process Requests Data (Solicitacao) to count sent requests
    const requestSheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
    if (requestSheet && requestSheet.getLastRow() > 1) {
      const requestData = requestSheet.getRange(2, 1, requestSheet.getLastRow() - 1, requestSheet.getLastColumn()).getValues();
      for (let i = 0; i < requestData.length; i++) {
        const row = requestData[i];
        const ts = parseTimestamp(row[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1]);
        if (!ts || ts < filterDate || ts > endDate) continue;

        const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || '').toString().trim();
        const acceptedBy = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim();
        
        // If it was sent to a specific driver or accepted by a driver
        const driversToCount = [];
        if (recipient.toLowerCase() === 'todos (geral)') {
          // For "Todos", we could count it for everyone or only those who interacted
          // The user wants to know how many were SENT to the driver. 
          // If it's Geral, it's sent to all active drivers.
          Object.keys(stats).forEach(d => driversToCount.push(d));
        } else if (recipient) {
          driversToCount.push(recipient);
        }

        driversToCount.forEach(driver => {
          if (stats[driver]) {
            stats[driver].solicitacoesRecebidas++;
          }
        });
      }
    }

    const result = Object.keys(stats).map(driver => {
      const d = stats[driver];
      
      return {
        driver,
        recolhidas: d.recolhidas,
        remanejadas: d.remanejadas,
        totalBikes: d.recolhidas + d.remanejadas,
        solicitacoesRecebidas: d.solicitacoesRecebidas,
        solicitacoesAtendidas: d.ocorrencias,
        percOcorrencia: d.solicitacoesRecebidas > 0 ? (d.ocorrencias / d.solicitacoesRecebidas) * 100 : 0
      };
    });

    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
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

    const bikeNumberSet = new Set(bikeNumbers.map(n => String(parseFloat(n) || String(n).trim())));
    const result = {};

    bikeNumbers.forEach(pat => {
      const bikeStr = String(pat).trim();
      const bikeNum = parseFloat(bikeStr);
      let row = bikeIndex[bikeStr];
      if (!row && !isNaN(bikeNum)) row = bikeIndex[String(bikeNum)];

      if (row) {
        result[pat] = {
          bikeNumber: pat,
          currentLat: parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
          currentLng: parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
          battery: row[COLUMN_INDICES.BIKES.BATERIA - 1],
          initialLat: null, initialLng: null,
          ocorrencia: false
        };
      }
    });

    for (let i = requestsData.length - 1; i >= 0; i--) {
      const patrimonioRaw = String(requestsData[i][COLUMN_INDICES.REQUESTS.PATRIMONIO - 1]).trim();
      const acceptedBy    = String(requestsData[i][COLUMN_INDICES.REQUESTS.ACEITA_POR - 1]).trim().toLowerCase();
      const situacao      = String(requestsData[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1]).trim().toLowerCase();
      
      patrimonioRaw.split(',').map(s => s.trim()).filter(Boolean).forEach(rawPat => {
        const patrimonio = String(parseFloat(rawPat) || rawPat);
          if (bikeNumberSet.has(patrimonio) && acceptedBy === driverName.toLowerCase() && (situacao === 'aceita' || situacao === 'finalizada')) {
            // Find the original bike number key in result
            const originalKey = bikeNumbers.find(n => String(parseFloat(n) || String(n).trim()) === patrimonio);
            if (originalKey && result[originalKey]) {
              const local = String(requestsData[i][COLUMN_INDICES.REQUESTS.LOCAL - 1] || '');
              const isPickup = !local.toLowerCase().includes('app');
              
              if (isPickup) {
                result[originalKey].ocorrencia = true;
                if (result[originalKey].initialLat === null) {
                  const m = local.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
                  if (m) { result[originalKey].initialLat = parseCoordinate(m[1]); result[originalKey].initialLng = parseCoordinate(m[2]); }
                }
              }
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
        'Carregando': row[COLUMN_INDICES.BIKES.CARREGAMENTO - 1],
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
function switchVehicle(driverName, plate, kmInicial, kmFinalAtual, currentPlate) {
  try {
    const reportSheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    const now = formatDateTime(new Date());

    // 1. Grava FIM_TURNO do carro atual (se informado)
    if (kmFinalAtual !== undefined && kmFinalAtual !== null && kmFinalAtual !== '') {
      const plateToClose = currentPlate || '';
      if (plateToClose) {
        // Atualiza KM Final na aba Acesso
        updateVehicleKm(plateToClose, undefined, parseFloat(kmFinalAtual));
      }
      // Grava FIM_TURNO no Relatório
      if (reportSheet) {
        reportSheet.appendRow([now, plateToClose || 'ATUAL', STATUS.FIM_TURNO, 'KM Final: ' + kmFinalAtual, driverName]);
      }
    }

    // 2. Grava INICIO_TURNO do novo carro
    updateVehicleKm(plate, kmInicial, undefined);
    if (reportSheet) {
      reportSheet.appendRow([now, plate, STATUS.INICIO_TURNO, kmInicial, driverName]);
    }

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
  sheet.appendRow([bikeNumber, 'Alterar Status', new Date(), '', '', '', '']);
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

  // Mapa de bateria/carregamento — usa cache do getBikeIndex
  const bikeInfoMap = {};
  try {
    const index = getBikeIndex();
    Object.entries(index).forEach(([pat, row]) => {
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
  } catch(e) { console.error('getMechanicsList - erro ao ler bikes:', e); }

  // =================================================================
  // LÓGICA:
  // - Aguardando Confirmação → vem SOMENTE do Relatório (Recolhida/Vandalizada como último status)
  // - Em Manutenção / Reserva → vem da aba Mecânica (mecânico processa manualmente)
  // - Inserção manual via app → aparece com badge Manual
  // - A aba Mecânica NÃO registra "Aguardando Confirmação" — só Em Manutenção em diante
  // =================================================================

  // Passo 1: Relatório — última ocorrência de Recolhida/Vandalizada por bike
  // Se após a última Recolhida existir saída (Estação, etc.), bike não aparece
  let reportEntries = {};
  let lastStatusByBike = {};
  const cache = CacheService.getScriptCache();
  const cacheKey = 'mechanics_report_scan_v6';
  let cached = cache.get(cacheKey);
  
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      reportEntries = parsed.reportEntries;
      lastStatusByBike = parsed.lastStatusByBike;
    } catch (e) { cached = null; }
  }

  if (!cached) {
    const EXIT_STATUSES = [
      'estação', 'estacao', 'não encontrada', 'nao encontrada',
      'não atendida', 'nao atendida', 'inicio_turno', 'fim_turno',
      'remanejada', 'recuperada', 'encontrada', 'localizada'
    ];

    try {
      const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME) || ss.getSheetByName('Relatorio') || ss.getSheetByName('Relatório') || ss.getSheetByName('relatorio');
      if (reportSheet) {
        console.log('getMechanicsList: Usando planilha de relatório: ' + reportSheet.getName());
        if (reportSheet.getLastRow() > 1) {
          const lastRow = reportSheet.getLastRow();
          const rowsToRead = Math.min(lastRow - 1, 10000);
          const reportData = reportSheet.getRange(lastRow - rowsToRead + 1, 1, rowsToRead, 10).getValues();

          reportData.forEach((row, idx) => {
            const rawTs = row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1];
            const tsMsBase = toMs(rawTs);
            if (!tsMsBase || tsMsBase < CUTOFF_MS) return;
            
            const tsMs = tsMsBase + (idx / 1000000);
            
            const pat = String(row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
            if (!pat) return;
            const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
            if (!status) return;
            const observacao = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
            const motorista  = (row[COLUMN_INDICES.REPORTS.MOTORISTA  - 1] || '').toString().trim();

            // Último status geral
            if (!lastStatusByBike[pat] || tsMs >= lastStatusByBike[pat].tsMs) {
              lastStatusByBike[pat] = { tsMs, status };
            }

            // Última ocorrência de status inicial (Recolhida, Vandalizada, etc.)
            // Expandido para capturar variações e também checar o status do sistema (coluna F)
            const statusSistema = (row[COLUMN_INDICES.REPORTS.STATUS_SISTEMA - 1] || '').toString().trim().toLowerCase();
            
            const isInitial = /recolhida|vandalizad|filial|recolher|vandalismo|roubada|recuperada|manuten[çc]ão|oficina/.test(status) || 
                             /manuten[çc]ão/.test(statusSistema);
            
            if (isInitial) {
              if (!reportEntries[pat] || tsMs >= reportEntries[pat].tsMs) {
                const prev = reportEntries[pat] || {};
                reportEntries[pat] = { 
                  tsMs, 
                  status, 
                  motorista: motorista || prev.motorista || '', 
                  observacao: observacao || prev.observacao || '' 
                };
              }
            }
          });
        }
      } else {
        console.error('getMechanicsList: Planilha de relatório não encontrada!');
      }
        console.log('getMechanicsList: Report scan complete. Found ' + Object.keys(reportEntries).length + ' initial entries.');

        // Remove bikes cuja última ocorrência geral é uma saída posterior à última Recolhida
        Object.keys(reportEntries).forEach(pat => {
          const last = lastStatusByBike[pat];
          // Se o último status contém qualquer um dos EXIT_STATUSES e é posterior à recolhida, remove
          const isExit = EXIT_STATUSES.some(s => last.status.includes(s));
          if (last && isExit && last.tsMs > reportEntries[pat].tsMs) {
            console.log('getMechanicsList: Removing ' + pat + ' because last status is exit: ' + last.status);
            delete reportEntries[pat];
          }
        });
        
        cache.put(cacheKey, JSON.stringify({ reportEntries, lastStatusByBike }), 300);
    } catch (e) {
      console.error('getMechanicsList - erro ao ler relatório:', e);
    }
  }

  // Passo 2: Aba Mecânica
  // Inclui 'Remanejada' no índice para que o Passo 3a possa suprimir bikes do Relatório
  // que foram limpas via clearAlterarStatus. Bikes Remanejadas são filtradas no retorno final.
  const mechanicsStatus = {};
  if (sheet) {
    const mechValues = sheet.getDataRange().getValues();
    for (let i = mechValues.length - 1; i >= 1; i--) {
      const row = mechValues[i];
      const pat = String(row[COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      if (!pat) continue;
      
      const status = (row[COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
      const tratativa = (row[COLUMN_INDICES.MECHANICS.TRATATIVA - 1] || '').toString().trim();
      
      // Usa o mais recente entre Entrada e Finalização para comparação com o Relatório
      const tsEnt = toMs(row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
      const tsFin = toMs(row[COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1]);
      const tsMs = Math.max(tsEnt || 0, tsFin || 0) || null;

      if (mechanicsStatus[pat]) continue;

      if (status === 'Remanejada') {
        if (tsMs !== null && tsMs < CUTOFF_MS) continue;
        mechanicsStatus[pat] = {
          row: i + 1, status, tsMs: tsMs || 0,
          dataEntrada: row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1],
          mecanico: row[COLUMN_INDICES.MECHANICS.MECANICO - 1],
          tratativa, dataFinalizacao: row[COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1],
          carretinha: row[COLUMN_INDICES.MECHANICS.CARRETINHA - 1],
          manual: false
        };
        continue;
      }

      const isActiveStatus = (status === 'Aguardando Manutenção' || status === 'Em Manutenção' || status === 'Reserva' || status === 'Aguardando Técnica' || status === 'Em Técnica');
      if (!isActiveStatus && tsMs !== null && tsMs < CUTOFF_MS) continue;
      if (tsMs === null && !isActiveStatus) continue;

      mechanicsStatus[pat] = {
        row: i + 1, status, tsMs: tsMs || 0,
        dataEntrada: row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1],
        mecanico:    row[COLUMN_INDICES.MECHANICS.MECANICO - 1],
        tratativa,
        dataFinalizacao: row[COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1],
        carretinha:      row[COLUMN_INDICES.MECHANICS.CARRETINHA - 1],
        manual: tratativa.toUpperCase() === 'MANUAL'
      };
    }
  }

  // Passo 3: Monta resultado final
  const bikeMap = {};

  // 3a. Bikes do Relatório
  Object.entries(reportEntries).forEach(([pat, entry]) => {
    const mechData = mechanicsStatus[pat];
    const info = bikeInfoMap[pat] || {};
    
    // SÓ usa o status da Mecânica se ele for MAIS RECENTE que o registro do Relatório
    // OU se o status da Mecânica for um status ativo e o do Relatório for apenas uma sinalização inicial (recolhida/vandalizada/filial)
    // A ÚLTIMA AÇÃO DEVE SER SOBERANA: Se o mecânico mexeu na bike recentemente, o status da aba Mecânica prevalece.
    const isMechActive = mechData && (mechData.status === 'Aguardando Manutenção' || mechData.status === 'Em Manutenção' || mechData.status === 'Reserva' || mechData.status === 'Aguardando Técnica' || mechData.status === 'Em Técnica');
    const statusLow = entry.status.toLowerCase();
    const isReportInitial = statusLow.includes('recolhida') || statusLow.includes('vandalizada') || statusLow.includes('filial') || statusLow.includes('recolher') || statusLow.includes('vandalismo') || statusLow.includes('roubada');

    // Se a bike está na mecânica e o registro é manual ou ativo, damos preferência a ele
    // a menos que haja um registro de saída (estação) posterior à última ação do mecânico.
    if (mechData && (mechData.tsMs >= entry.tsMs || (isMechActive && isReportInitial))) {
      // Se foi marcada como Remanejada APÓS o último registro do Relatório → suprime
      if (mechData.status === 'Remanejada') return;
      
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
      // Ainda não processada OU o registro do Relatório é mais recente (bike voltou para a rua e foi recolhida de novo)
      bikeMap[pat] = {
        row: -1, patrimonio: pat, status: 'Alterar Status',
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

  // Segurança: nunca retorna bikes Remanejadas (foram suprimidas via clearAlterarStatus ou finalizeTrailer)
  return { success: true, data: Object.values(bikeMap).filter(b => b.status !== 'Remanejada') };
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

  // Verifica se já existe entrada ativa RECENTE (itera de trás para frente)
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);

    if (rowPat === pStr && rowStatus !== 'Remanejada') {
      // Se for uma entrada antiga (antes do cutoff), ignoramos e inserimos nova
      if (tsMs && tsMs < CUTOFF_MS) continue;

      // Atualiza entrada existente recente
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

  // Itera de trás para frente para pegar a entrada mais recente
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);

    if (rowPat === pStr && rowStatus === 'Aguardando Manutenção') {
      // Ignora se for muito antigo
      if (tsMs && tsMs < CUTOFF_MS) continue;

      const row = i + 1;
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Em Manutenção');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date()); // Atualiza para refletir atividade recente
      return { success: true };
    }
  }
  sheet.appendRow([bikeNumber, 'Em Manutenção', new Date(), mechanicName, '', '', '']);
  return { success: true };
}

function moveToAguardandoManutencao(bikeNumber) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  
  let foundIndex = -1;
  let currentStatus = '';

  // Itera de trás para frente para pegar a entrada mais recente
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const status = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);

    if (rowPat === pStr) {
      // Ignora se for muito antigo
      if (tsMs && tsMs < CUTOFF_MS) continue;

      // Se já estiver em um status "avançado" RECENTE, não retrocede nem duplica
      if (status === 'Em Manutenção' || status === 'Reserva' || status === 'Aguardando Técnica' || status === 'Em Técnica') {
        return { success: true, message: 'Bicicleta já está em processo avançado.' };
      }
      if (status !== 'Remanejada' && status !== 'Não encontrada') {
        foundIndex = i;
        currentStatus = status;
        break; // Pega a mais recente e para
      }
    }
  }
  
  if (foundIndex !== -1) {
    // Se encontrou uma entrada recente (que não seja avançada), atualiza para Aguardando Manutenção
    // Independente de ser 'Alterar Status' ou outro status inicial (como 'Recolhida')
    sheet.getRange(foundIndex + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Aguardando Manutenção');
    sheet.getRange(foundIndex + 1, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
    return { success: true };
  }
  
  sheet.appendRow([bikeNumber, 'Aguardando Manutenção', new Date(), '', '', '', '']);
  return { success: true };
}

function declineMechanicsReceipt(bikeNumber, mechanicName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  
  // Itera de trás para frente
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);

    if (rowPat === pStr && rowStatus === 'Aguardando Manutenção') {
      if (tsMs && tsMs < CUTOFF_MS) continue;

      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Não encontrada');
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      return { success: true };
    }
  }
  return { success: false, error: 'Bicicleta não encontrada em Aguardando Manutenção.' };
}

function markAsNotFound(bikeNumber, mechanicName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '') === pStr
        && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] !== 'Remanejada') {
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Não encontrada');
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
      return { success: true };
    }
  }
  
  sheet.appendRow([bikeNumber, 'Não encontrada', new Date(), mechanicName, '', '', '']);
  return { success: true };
}

function editMechanicsBike(oldPat, newPat) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const oldStr = String(oldPat).trim().replace(/^0+/, '');
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '') === oldStr
        && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] !== 'Remanejada') {
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.PATRIMONIO).setValue(newPat);
      return { success: true };
    }
  }
  return { success: false, error: 'Bicicleta não encontrada para edição.' };
}

function deleteMechanicsBike(bikeNumber) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    if (rowPat === pStr) {
      const rowStatus = String(data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
      
      // Se a bike está na Reserva, "excluir" significa voltar para Manutenção (conforme pedido do usuário)
      if (rowStatus === 'Reserva') {
        const row = i + 1;
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Em Manutenção');
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue('');
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
        return { success: true, movedToMaintenance: true };
      }
      
      // Caso contrário, deleta a linha normalmente
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, error: 'Bicicleta não encontrada para exclusão.' };
}

// =================================================================
// --- PERFIL TÉCNICA ---
// Bikes enviadas da Mecânica para análise técnica especializada.
// Fluxo: Aguardando Técnica → Em Técnica → Reserva (mesma saída da Mecânica)
// =================================================================

function sendToTechnical(bikeNumber, mechanicName) {
  if (!bikeNumber) return { success: false, error: 'Patrimônio não informado.' };
  try {
    const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
    const pStr = String(bikeNumber).trim().replace(/^0+/, '');
    const data = sheet.getDataRange().getValues();

    // Atualiza linha existente se bike já está na aba Mecânica
    for (let i = 1; i < data.length; i++) {
      const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      const rowStatus = String(data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
      if (rowPat === pStr && rowStatus !== 'Remanejada') {
        sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Aguardando Técnica');
        sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName || '');
        return { success: true };
      }
    }
    // Insere nova linha se não existe
    sheet.appendRow([bikeNumber, 'Aguardando Técnica', new Date(), mechanicName || '', '', '', '']);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getTechnicaList() {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: true, data: [] };

    // Mapa de bateria
    const bikeInfoMap = {};
    const bikesSheet = ss.getSheetByName(BIKES_SHEET_NAME);
    if (bikesSheet && bikesSheet.getLastRow() > 1) {
      bikesSheet.getRange(2, 1, bikesSheet.getLastRow() - 1, COLUMN_INDICES.BIKES.CARREGAMENTO).getValues().forEach(row => {
        const pat = String(row[COLUMN_INDICES.BIKES.PATRIMONIO - 1] || '').trim();
        if (!pat) return;
        let bateria = row[COLUMN_INDICES.BIKES.BATERIA - 1];
        if (typeof bateria === 'number' && bateria <= 1 && bateria > 0) bateria = Math.round(bateria * 100);
        else if (typeof bateria === 'string' && bateria.includes('%')) bateria = parseInt(bateria.replace('%', ''));
        const carregamentoRaw = (row[COLUMN_INDICES.BIKES.CARREGAMENTO - 1] || '').toString().trim();
        const carregamento = carregamentoRaw.toLowerCase() === 'carregando' ? 'Carregando' : (carregamentoRaw ? 'Não carregando' : '');
        bikeInfoMap[pat] = { bateria, carregamento };
        const patSZ = pat.replace(/^0+/, '');
        if (patSZ !== pat) bikeInfoMap[patSZ] = { bateria, carregamento };
      });
    }

    const TECHNICAL_STATUSES = new Set(['Aguardando Técnica', 'Em Técnica']);
    const result = [];
    const data = sheet.getDataRange().getValues().slice(1);

    data.forEach((row, idx) => {
      const pat    = String(row[COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      const status = String(row[COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
      if (!pat || !TECHNICAL_STATUSES.has(status)) return;

      const info = bikeInfoMap[pat] || {};
      result.push({
        row: idx + 2,
        patrimonio: pat,
        status,
        dataEntrada:     row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1],
        mecanico:        row[COLUMN_INDICES.MECHANICS.MECANICO - 1],
        tratativa:       row[COLUMN_INDICES.MECHANICS.TRATATIVA - 1],
        dataFinalizacao: row[COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1],
        bateria:         info.bateria,
        carregamento:    info.carregamento,
      });
    });

    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function confirmTechnicaReceipt(bikeNumber, technicianName) {
  if (!bikeNumber) return { success: false, error: 'Patrimônio não informado.' };
  try {
    const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
    const pStr = String(bikeNumber).trim().replace(/^0+/, '');
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const rowPat    = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      const rowStatus = String(data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
      if (rowPat === pStr && rowStatus === 'Aguardando Técnica') {
        sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Em Técnica');
        if (technicianName) sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.MECANICO).setValue(technicianName);
        return { success: true };
      }
    }
    // Se não encontrou como Aguardando, insere direto como Em Técnica
    sheet.appendRow([bikeNumber, 'Em Técnica', new Date(), technicianName || '', '', '', '']);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function finalizeTechnicaRepair(bikeNumber, technicianName, treatment, originalMechanic) {
  if (!bikeNumber || !treatment) return { success: false, error: 'Dados incompletos.' };
  try {
    const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
    const pStr = String(bikeNumber).trim().replace(/^0+/, '');
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const rowPat    = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      const rowStatus = String(data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
      if (rowPat === pStr && rowStatus === 'Em Técnica') {
        const row = i + 1;
        // Devolve ao mecânico original (quem enviou para Técnica)
        const mecanicoOriginal = originalMechanic
          || String(data[i][COLUMN_INDICES.MECHANICS.MECANICO - 1] || '').trim()
          || '';
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Em Manutenção');
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mecanicoOriginal);
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue(
          'Retorno da Técnica: ' + treatment + (technicianName ? ' [' + technicianName + ']' : '')
        );
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue('');
        return { success: true, originalMechanic: mecanicoOriginal };
      }
    }
    return { success: false, error: 'Bike não encontrada em Em Técnica.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// =================================================================
// --- REMOVER BIKE DA CARRETINHA ---
// Limpa o campo CARRETINHA da bike na aba Mecânica, voltando para "Sem Carretinha"
// =================================================================
function removeFromTrailer(bikeNumber, targetStatus) {
  if (!bikeNumber) return { success: false, error: 'Patrimônio não informado.' };
  try {
    const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
    const pStr = String(bikeNumber).trim().replace(/^0+/, '');
    const data = sheet.getDataRange().getValues();

    // Itera de trás para frente para pegar a entrada mais recente
    for (let i = data.length - 1; i >= 1; i--) {
      const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      if (rowPat === pStr) {
        const row = i + 1;
        // Remove da carretinha
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue('');
        
        // Se um novo status foi solicitado (ex: 'Em Manutenção'), atualiza
        if (targetStatus) {
          sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue(targetStatus);
          // Atualiza timestamp para ser soberano
          sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
        }
        
        return { 
          success: true, 
          status: targetStatus || (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim(),
          mecanico: (data[i][COLUMN_INDICES.MECHANICS.MECANICO - 1] || '').toString().trim() 
        };
      }
    }
    // Se não encontrou na mecânica, retornamos sucesso para não travar o app, 
    // já que o objetivo era garantir que não estivesse em nenhuma carretinha.
    return { success: true, warning: 'Bike não encontrada na planilha de Mecânica.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// =================================================================
// --- LIMPAR LISTA ALTERAR STATUS ---
// Remove bikes da seção "Alterar Status" sem gerar registros.
// Bikes com linha na aba Mecânica → marca como Remanejada (getMechanicsList ignora)
// Bikes vindas só do Relatório (row=-1) → insere linha Remanejada para suprimir
// =================================================================
function clearAlterarStatus(bikes) {
  if (!bikes || !Array.isArray(bikes) || bikes.length === 0) {
    return { success: true, cleared: 0 };
  }

  try {
    const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };

    const data = sheet.getDataRange().getValues();
    let cleared = 0;
    const now = new Date();

    bikes.forEach(item => {
      const pat = String(item.patrimonio || '').trim().replace(/^0+/, '');
      if (!pat) return;

      if (item.row && item.row > 1) {
        // Bike tem linha na aba Mecânica — apenas muda status para Remanejada
        const rowData = data[item.row - 1];
        if (rowData) {
          const currentStatus = String(rowData[COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
          if (currentStatus !== 'Remanejada') {
            sheet.getRange(item.row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Remanejada');
            cleared++;
          }
        }
      } else {
        // Bike vem só do Relatório (row=-1) — insere linha Remanejada para suprimir
        // Verifica se já existe uma linha ativa antes de inserir
        let alreadyExists = false;
        for (let i = 1; i < data.length; i++) {
          const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
          const rowStatus = String(data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
          if (rowPat === pat && rowStatus !== 'Remanejada') {
            sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Remanejada');
            alreadyExists = true;
            cleared++;
            break;
          }
        }
        if (!alreadyExists) {
          // Insere nova linha Remanejada — getMechanicsList filtra por status Remanejada
          sheet.appendRow([item.patrimonio, 'Remanejada', now, '', 'LIMPAR_LISTA', now, '']);
          cleared++;
        }
      }
    });

    return { success: true, cleared };
  } catch (e) {
    return { success: false, error: 'Erro ao limpar lista: ' + e.message };
  }
}

function finalizeMechanicsRepair(bikeNumber, mechanicName, treatment) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');

  // Itera de trás para frente para pegar a entrada mais recente
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);

    const isActiveStatus = (rowStatus === 'Aguardando Manutenção' || rowStatus === 'Em Manutenção' || rowStatus === 'Aguardando Técnica' || rowStatus === 'Em Técnica');

    if (rowPat === pStr && (rowStatus === 'Em Manutenção' || isActiveStatus)) {
      // Ignora se for muito antigo (antes do cutoff)
      if (tsMs && tsMs < CUTOFF_MS) continue;

      const row = i + 1;
      // Atualiza cada coluna individualmente para evitar escrita nas colunas erradas
      // Colunas: STATUS(2), MECANICO(4), TRATATIVA(5), DATA_FINALIZACAO(6)
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Reserva');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue(treatment);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date()); // Atualiza para refletir atividade recente
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue(new Date());
      return { success: true };
    }
  }
  return { success: false, error: 'Bicicleta não encontrada ou não está em um status ativo na mecânica.' };
}

/**
 * Marca uma bicicleta como vandalizada sem recuperação (direto da mecânica)
 * @param {string} bikeNumber Número do patrimônio
 * @param {string} mechanicName Nome do mecânico
 * @param {string} room Número da sala de destino
 * @param {string} reasons Motivos da vandalização
 */
function markAsVandalizedNoRecovery(bikeNumber, mechanicName, room, reasons) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  
  const data = sheet.getDataRange().getValues();
  let found = false;
  
  for (let i = 1; i < data.length; i++) {
    const patrimonio = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim();
    if (patrimonio === String(bikeNumber).trim()) {
      const row = i + 1;
      // Atualiza a linha na planilha mecânica
      // Colunas: STATUS(2), MECANICO(4), TRATATIVA(5), DATA_FINALIZACAO(6), CARRETINHA(7)
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Vandalizada');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue('VANDALIZADA');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue(new Date());
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue(room); // Coluna G
      found = true;
      break;
    }
  }
  
  if (!found) {
    return { success: false, error: 'Bicicleta não encontrada na planilha mecânica.' };
  }

  return { success: true };
}

function organizeTrailer(bikeNumbers, trailerName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const bikes = (Array.isArray(bikeNumbers) ? bikeNumbers : [bikeNumbers]).map(b => String(b).trim().replace(/^0+/, ''));
  
  let count = 0;
  // Itera de trás para frente para garantir que estamos pegando a entrada RECENTE de cada bike
  // Como uma bike pode estar em Reserva apenas uma vez no período ativo, podemos usar um Set para evitar processar a mesma bike duas vezes
  const processedBikes = new Set();

  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);

    if (bikes.includes(rowPat) && rowStatus === 'Reserva' && !processedBikes.has(rowPat)) {
      // Ignora se for muito antigo
      if (tsMs && tsMs < CUTOFF_MS) continue;

      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue(trailerName);
      processedBikes.add(rowPat);
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
  
  // Itera de trás para frente
  const processedBikes = new Set();

  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const rowTrailer = String(data[i][COLUMN_INDICES.MECHANICS.CARRETINHA - 1] || '').trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);

    if (rowTrailer === String(trailerName) && rowStatus === 'Reserva' && !processedBikes.has(rowPat)) {
      // Ignora se for muito antigo
      if (tsMs && tsMs < CUTOFF_MS) continue;

      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Remanejada');
      remanejadas.push(rowPat);
      processedBikes.add(rowPat);
      count++;
    }
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