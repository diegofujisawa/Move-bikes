// =================================================================
// SCRIPT DE BACKEND - APLICATIVO DE REGISTRO DE BICICLETAS
// Versão: 85.22-persistence-fix
// Otimizações aplicadas (v85.22):
//   - FinalizeRouteBike agora usa LockService e salva estado do motorista.
//   - Frontend persiste metadados de carência no localStorage.
// =================================================================

// --- VERSÃO ---
const BACKEND_VERSION = '85.51-idempotency-fix';
const CUTOFF_MS = new Date('2026-03-24T00:00:00').getTime();

// --- CONFIGURAÇÃO GLOBAL ---
const ACCESS_SHEET_NAME        = 'Acesso';
const BIKES_SHEET_NAME         = 'Bicicletas';
const STATIONS_SHEET_NAME      = 'Estacao';
const REQUESTS_SHEET_NAME      = 'Solicitacao';
const REPORT_SHEET_NAME        = 'Relatorio';
const STATE_SHEET_NAME         = 'Dados';
const REPLENISHMENT_SHEET_NAME = 'Repor';
const VANDALIZED_SHEET_NAME    = 'Vandalizadas';
const VANDALISMO_SHEET_NAME    = 'Vandalismo';
const DAILY_SUMMARY_SHEET_NAME = 'ResumoDiario';
const MECHANICS_SHEET_NAME     = 'Mecanica';
const QUEUE_SHEET_NAME         = 'FilaProcessamento';
const ALERTS_SHEET_NAME        = 'Alertas';
const CHASSI_SHEET_NAME        = 'CHASSI';
const NOTIFICATIONS_SHEET_NAME = 'Notificacoes';

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
  NOTIFICATIONS: { DATA: 1, DESTINATARIO: 2, TIPO: 3, TITULO: 4, MENSAGEM: 5, BIKES: 6, STATUS: 7 },
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
// =================================================================
let _ss = null;
function updateBikeStatusInMainSheet(bikeNumber, newStatus) {
  if (!bikeNumber || !newStatus) return;
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(BIKES_SHEET_NAME);
    if (!sheet) return;
    const bikeStr = String(bikeNumber).trim();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    
    // Usa TextFinder para ser mais eficiente que loop
    const finder = sheet.getRange(2, COLUMN_INDICES.BIKES.PATRIMONIO, lastRow - 1, 1).createTextFinder(bikeStr).matchEntireCell(true);
    const range = finder.findNext();
    if (range) {
      sheet.getRange(range.getRow(), COLUMN_INDICES.BIKES.STATUS).setValue(newStatus);
      // Limpa caches relacionados
      const cache = CacheService.getScriptCache();
      cache.remove('bikes_index_v2');
      cache.remove('bike_statuses');
    }
  } catch (e) {
    console.error('Erro em updateBikeStatusInMainSheet:', e);
  }
}
function getSpreadsheet() {
  if (!_ss) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
      || '14U5Y6ZU5oeNr5B7hYLMhqvGgU68K4seeILUgTK335kQ';
    try {
      _ss = SpreadsheetApp.openById(id);
    } catch (err) {
      throw new Error('A propriedade SPREADSHEET_ID (' + id + ') não está configurada corretamente, o ID da planilha é inválido ou a conta que executou o script (' + Session.getEffectiveUser().getEmail() + ') não possui permissão de acesso a essa planilha. Detalhes: ' + err.message);
    }
  }
  return _ss;
}

// =================================================================
// --- HELPER: leitura da aba Bicicletas ---
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
function formatDateTime(date) {
  if (!date) return '';
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getScriptTzDate() {
  const tz = Session.getScriptTimeZone();
  const formatted = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm:ss");
  const parts = formatted.split(' ');
  const dateParts = parts[0].split('-');
  const timeParts = parts[1].split(':');
  return new Date(
    parseInt(dateParts[0], 10),
    parseInt(dateParts[1], 10) - 1,
    parseInt(dateParts[2], 10),
    parseInt(timeParts[0], 10),
    parseInt(timeParts[1], 10),
    parseInt(timeParts[2], 10)
  );
}

function normalizeCategory(str) {
  return (str || '').toString().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function parseTimestamp(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === 'number') {
    const d = new Date((raw - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = raw.toString().trim();
  const brMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?)?/);
  if (brMatch) {
    const d = new Date(parseInt(brMatch[3],10), parseInt(brMatch[2],10)-1, parseInt(brMatch[1],10),
      parseInt(brMatch[4]||'0',10), parseInt(brMatch[5]||'0',10), parseInt(brMatch[6]||'0',10));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toMs(raw) {
  const d = parseTimestamp(raw);
  return d ? d.getTime() : null;
}

function parseCoordinate(val) {
  if (val === undefined || val === null || val === '') return NaN;
  let num = typeof val === 'number' ? val
    : parseFloat(String(val).trim().replace(',', '.').replace(/[–—]/g, '-').replace(/[^\d.-]/g, ''));
  if (isNaN(num)) return NaN;
  while (Math.abs(num) > 180) num /= 10;
  return num;
}

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
// =================================================================
function hasBeenProcessed(key) {
  if (!key) return false;
  const cache = CacheService.getScriptCache();
  return cache.get('idempotency_' + key) === '1';
}

function markAsProcessed(key) {
  if (!key) return;
  const cache = CacheService.getScriptCache();
  cache.put('idempotency_' + key, '1', 600);
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
    if (request.idempotencyKey && action !== 'login' && hasBeenProcessed(request.idempotencyKey)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: true, deduplicated: true, version: BACKEND_VERSION
      })).setMimeType(ContentService.MimeType.JSON);
    }
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
          success: false, error: 'Servidor ocupado. Por favor, tente novamente em instantes.',
          version: BACKEND_VERSION, retryable: true
        })).setMimeType(ContentService.MimeType.JSON);
      }
      logOperationToQueue(action, request);
    }
    switch (action) {
      case 'getDriversSummary':     response = { ...getDriversSummary(request.timeRange, null, null, request.timelineDate), version: BACKEND_VERSION }; break;
      case 'getVehiclePlates':      response = { ...getVehiclePlates(), version: BACKEND_VERSION }; break;
      case 'login':                 response = { ...handleLogin(request.login, request.password, request.plate, request.kmInicial), version: BACKEND_VERSION }; break;
      case 'logout':                response = { ...handleLogout(request.userName), version: BACKEND_VERSION }; break;
      case 'search':                response = { ...searchBike(request.bikeNumber, request.driverName), version: BACKEND_VERSION }; break;
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
      case 'getAlerts':             response = { ...getAlerts(false), version: BACKEND_VERSION }; break;
      case 'confirmBikeFound':      response = { ...confirmBikeFound(request.alertId, request.driverName), version: BACKEND_VERSION }; break;
      case 'getVandalized':         response = { ...getVandalized(), version: BACKEND_VERSION }; break;
      case 'confirmVandalizedFound':response = { ...confirmVandalizedFound(request.alertId, request.driverName), version: BACKEND_VERSION }; break;
      case 'getRouteDetails':       response = { ...getRouteDetails(request.driverName, request.bikeNumbers), version: BACKEND_VERSION }; break;
      case 'switchVehicle':         response = { ...switchVehicle(request.driverName, request.plate, request.kmInicial), version: BACKEND_VERSION }; break;
      case 'sync':                  response = { ...handleSync(request), version: BACKEND_VERSION }; break;
      case 'getBicycles':           response = { ...getBicycles(), version: BACKEND_VERSION }; break;
      case 'generateDriverRoute':   response = { ...generateDriverRoute(request.driverName, request.location, request.filters, request.maxBikes, request.rangeKm), version: BACKEND_VERSION }; break;
      case 'getSheetsReportsToday': response = { ...getSheetsReportsToday(request), version: BACKEND_VERSION }; break;
      case 'saveDailySummary':      response = { ...saveDailySummary(request.summaryData), version: BACKEND_VERSION }; break;
      case 'getDirections':         response = { ...getDirections(request.fromLat, request.fromLng, request.toLat, request.toLng), version: BACKEND_VERSION }; break;
      case 'getBikeMovement':       response = { ...getBikeMovement(request.bikeNumber, request.limit), version: BACKEND_VERSION }; break;
      case 'confirmMechanicsReceipt': response = { ...confirmMechanicsReceipt(request.bikeNumber, request.mechanicName), version: BACKEND_VERSION }; break;
      case 'markAsNotFound':        response = { ...markAsNotFound(request.bikeNumber, request.mechanicName), version: BACKEND_VERSION }; break;
      case 'editMechanicsBike':     response = { ...editMechanicsBike(request.oldPat, request.newPat), version: BACKEND_VERSION }; break;
      case 'deleteMechanicsBike':   response = { ...deleteMechanicsBike(request.bikeNumber), version: BACKEND_VERSION }; break;
      case 'clearAlterarStatus':    response = { ...clearAlterarStatus(request.bikes), version: BACKEND_VERSION }; break;
      case 'removeFromTrailer':     response = { ...removeFromTrailer(request.bikeNumber, request.targetStatus), version: BACKEND_VERSION }; break;
      case 'sendToTechnical':       response = { ...sendToTechnical(request.bikeNumber, request.mechanicName), version: BACKEND_VERSION }; break;
      case 'getTechnicaList':       response = { ...getTechnicaList(), version: BACKEND_VERSION }; break;
      case 'getNextTrailerNumber':  response = { ...getNextTrailerNumber(), version: BACKEND_VERSION }; break;
      case 'getChassiInfo':         response = { ...getChassiInfo(request.bikeNumber), version: BACKEND_VERSION }; break;
      case 'confirmTechnicaReceipt':response = { ...confirmTechnicaReceipt(request.bikeNumber, request.technicianName), version: BACKEND_VERSION }; break;
      case 'finalizeTechnicaRepair':response = { ...finalizeTechnicaRepair(request.bikeNumber, request.technicianName, request.treatment), version: BACKEND_VERSION }; break;
      case 'insertBikeMechanics':   response = { ...insertBikeMechanics(request.bikeNumber, request.driverName, request.targetStatus), version: BACKEND_VERSION }; break;
      case 'notifyAdmins':          response = { ...notifyAdmins(request.message, request.bikes, request.trailerName), version: BACKEND_VERSION }; break;
      case 'sendNotification':      response = { ...sendNotification(request), version: BACKEND_VERSION }; break;
      case 'finalizeMechanicsRepair': response = { ...finalizeMechanicsRepair(request.bikeNumber, request.mechanicName, request.treatment), version: BACKEND_VERSION }; break;
      case 'markAsVandalizedNoRecovery': response = { ...markAsVandalizedNoRecovery(request.bikeNumber, request.mechanicName, request.room, request.observation || request.reasons), version: BACKEND_VERSION }; break;
      case 'organizeTrailer':       response = { ...organizeTrailer(request.bikeNumbers, request.trailerName), version: BACKEND_VERSION }; break;
      case 'finalizeTrailer':       response = { ...finalizeTrailer(request.trailerName), version: BACKEND_VERSION }; break;
      case 'getAnalyticalDashboardData': response = { ...getAnalyticalDashboardData(request.timeRange), version: BACKEND_VERSION }; break;
      default: response = { success: false, error: 'Ação desconhecida: ' + action, version: BACKEND_VERSION }; break;
    }
    if (lockAcquired) lock.releaseLock();
    if (response.success && request.idempotencyKey) {
      markAsProcessed(request.idempotencyKey);
    }
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
  rangeKm  = rangeKm  || 2;
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
    const occupiedBikes = new Set();
    let finalizedToday = new Set();

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
      finalizedToday = getFinalizedBikesToday(500);
    } catch (e) { console.warn('generateDriverRoute: erro ao ler ocupadas ou finalizadas — ' + e.message); }

    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60000);
    const filteredBikes = allBikes.filter(bike => {
      const pat = String(bike.patrimonio || '').trim();
      if (occupiedBikes.has(pat)) return false;
      const patNoZeros = String(parseFloat(pat));
      if (patNoZeros !== 'NaN' && occupiedBikes.has(patNoZeros)) return false;
      
      // Bloqueia bikes baixadas hoje
      if (finalizedToday.has(pat) || finalizedToday.has(patNoZeros)) return false;
      const lastInfo = parseTimestamp(bike.ultimaInfo);
      const isOffline = !lastInfo || lastInfo < thirtyMinutesAgo;
      if (filters.offline) { if (!isOffline) return false; } else { if (isOffline) return false; }
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
    const route = filteredBikes.sort((a, b) => a.distance - b.distance).slice(0, maxBikes);
    if (route.length === 0) {
      return { success: true, data: [], message: 'Nenhuma bicicleta encontrada num raio de ' + rangeKm + ' km.' };
    }
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

// =================================================================
// --- SINCRONIZAÇÃO UNIFICADA ---
// =================================================================
function handleSync(request) {
  const { driverName, category, summaryTimeRange, statusTimeRange, timelineDate, alertsVersion, force } = request;
  const cacheKey = `handleSync_${driverName || 'all'}_${category || 'all'}_${summaryTimeRange || 'day'}_${statusTimeRange || 'day'}_${timelineDate || 'none'}`;
  const cache = CacheService.getScriptCache();
  const cached = force ? null : cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      // requests sempre fresco — nunca serve do cache de 45s do handleSync.
      // Evita que notificações novas fiquem invisíveis por até 45s.
      const freshReqs = getRequests(driverName, category);
      parsed.data = parsed.data || {};
      parsed.data.requests = freshReqs.success ? (freshReqs.data || []) : [];
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

    response.data.requests = getRequests(driverName, category, getSheet(REQUESTS_SHEET_NAME)).data || [];

    const driverStateResult = getDriverState(driverName, getSheet(STATE_SHEET_NAME));
    response.data.driverState = driverStateResult.data || { routeBikes: [], collectedBikes: [] };
    response.data.driverStateSource = 'sheets';

    response.data.bikeStatuses = getBikeStatuses(getSheet(STATE_SHEET_NAME), getSheet(REPORT_SHEET_NAME)).data || {};
    response.data.schedule = getSchedule(driverName).data || {};

    const accessSheet = getSheet(ACCESS_SHEET_NAME);
    const accessData = accessSheet ? accessSheet.getDataRange().getValues() : [];
    response.data.motoristas = getMotoristas(accessData).data || [];
    response.data.driverLocations = getDriverLocations(accessData).data || [];

    const routeBikes = response.data.driverState.routeBikes || [];
    const collectedBikes = response.data.driverState.collectedBikes || [];
    const allBikes = [...new Set([...routeBikes, ...collectedBikes])];
    response.data.bikeDetails = allBikes.length > 0
      ? (getRouteDetails(driverName, allBikes, getSheet(BIKES_SHEET_NAME), getSheet(REQUESTS_SHEET_NAME)).data || {})
      : {};

    if (isAdm) {
      // v85.19: Uso dinâmico de versão para evitar cache stale no client
      const alertsResult = getAlerts(false);
      if (alertsResult.success) {
        const currentVersion = alertsResult.version || 'v15';
        if (alertsVersion && alertsVersion === currentVersion) {
          response.data.alertsVersion = currentVersion;
          response.data.alerts = null; // Client já tem a versão mais recente
        } else {
          response.data.alerts = alertsResult.data || [];
          response.data.alertsVersion = currentVersion;
        }
      } else {
        console.error('Erro em getAlerts durante sync:', alertsResult.error);
        response.data.alerts = [];
        response.data.alertsVersion = '';
      }
      const vandalizedResult = getVandalized();
      if (!vandalizedResult.success) {
        console.error('Erro em getVandalized durante sync:', vandalizedResult.error);
      }
      response.data.vandalized = vandalizedResult.data || [];
      response.data.changeStatusData = getChangeStatusData(statusTimeRange, {
        report: getSheet(REPORT_SHEET_NAME), bikes: getSheet(BIKES_SHEET_NAME)
      }).data || { vandalizadas: [], filial: [] };
    } else {
      response.data.driversSummary = getDriversSummary(summaryTimeRange, {
        access: getSheet(ACCESS_SHEET_NAME), report: getSheet(REPORT_SHEET_NAME),
        state: getSheet(STATE_SHEET_NAME), requests: getSheet(REQUESTS_SHEET_NAME),
        stations: getSheet(STATIONS_SHEET_NAME)
      }, driverName).data || [];
    }

    // CORREÇÃO v85.7: getAdminAlerts agora existe como stub seguro
    response.data.adminAlerts = getAdminAlerts(driverName, isAdm).alerts || [];

    if (isMecanica || isAdm) {
      response.data.mechanicsList = getMechanicsList().data || [];
    }

    try {
      // Não cacheia requests — tem cache próprio de 10s e precisa ser fresh
      // para garantir sincronia entre contador (pendingCounts) e lista de notificações
      const toCache = JSON.parse(JSON.stringify(response));
      delete toCache.data.requests;
      // v85.23: Reduz cache para motoristas para 3s para garantir frescor após ações e evitar persistência de bikes entregues
      // v85.24: Reduzimos cache de ADM para 12s para evitar lag em ações de confirmação
      const ttl = isAdm ? 12 : 3;
      cache.put(cacheKey, JSON.stringify(toCache), ttl);
    } catch (e) {}

    return response;
  } catch (e) {
    console.error('Erro na sincronização:', e);
    return { success: false, error: 'Erro na sincronização: ' + e.message };
  }
}

// =================================================================
// --- CORREÇÃO v85.7: getAdminAlerts (stub) ---
// Evita erro em runtime no handleSync. Retorna lista vazia.
// =================================================================
function getAdminAlerts(driverName, isAdm) {
  return { alerts: [] };
}

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
  if (kmInicial !== undefined) sheet.getRange(row, COLUMN_INDICES.ACCESS.KM_INICIAL).setValue(kmInicial);
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
    if (storedPassword !== password.toString().trim()) return { success: false, error: 'Senha incorreta.' };
    if (category === 'MOTORISTA') {
      if (!plate || kmInicial === undefined) return { success: false, error: 'Placa e KM Inicial são obrigatórios para motoristas.' };
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
        timestamp: timestampStr ? new Date(parseInt(timestampStr, 10)).toISOString() : new Date().toISOString(),
        stale: timestampStr ? ageMs > TEN_MIN : false
      });
    } catch (e) {
      Logger.log(`GPS inválido para ${row[COLUMN_INDICES.ACCESS.USUARIO - 1]}: ${gpsString}`);
    }
  });
  return { success: true, data: locations };
}

// =================================================================
// --- SEARCH BIKE ---
// =================================================================
function getBikeIndex(forceReload = false) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'bikes_index_v2';
  const cached = forceReload ? null : cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(BIKES_SHEET_NAME);
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const patIdx = headers.indexOf('patrimônio') !== -1 ? headers.indexOf('patrimônio') : COLUMN_INDICES.BIKES.PATRIMONIO - 1;
  const index = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const s = String(row[patIdx] || '').trim();
    if (!s || s === '0') continue;
    index[s] = row;
    const norm = s.replace(/^0+/, '');
    if (norm !== s && norm !== '') index[norm] = row;
  }
  try {
    const str = JSON.stringify(index);
    if (str.length < 100000) cache.put(cacheKey, str, 15);
  } catch (e) {}
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
    const sample = sheet.getRange(1, 1, Math.min(6, lastRow), Math.min(lastCol, 5)).getValues();
    const colBSample = lastRow > 1
      ? sheet.getRange(2, COLUMN_INDICES.BIKES.PATRIMONIO, Math.min(5, lastRow - 1), 1).getValues().map(r => ({ val: r[0], type: typeof r[0] }))
      : [];
    const index = getBikeIndex(true);
    const indexKeys = Object.keys(index);
    return {
      success: true, sheetName: BIKES_SHEET_NAME, allSheets, lastRow, lastCol,
      patrimonioColunaIndex: COLUMN_INDICES.BIKES.PATRIMONIO,
      primeiraLinhaHeaders: sample[0] || [],
      primeiros5Patrimonios: colBSample,
      totalIndexado: indexKeys.length,
      amostraIndexKeys: indexKeys.slice(0, 10),
      buscando: bikeNumber, tipoBuscado: typeof bikeNumber
    };
  } catch(e) { return { success: false, error: e.message }; }
}

function getChassiInfo(bikeNumber) {
  if (!bikeNumber) return { success: false, error: 'Número do patrimônio não fornecido.' };
  try {
    const sheet = getSpreadsheet().getSheetByName(CHASSI_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Aba "CHASSI" não encontrada na planilha.' };
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Nenhum dado encontrado na aba CHASSI.' };
    const data = sheet.getRange(2, 2, lastRow - 1, 14).getValues();
    const bikeNumStr = String(bikeNumber).trim();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const patrimonio = String(row[0]).trim();
      if (patrimonio === bikeNumStr) {
        return { success: true, data: { patrimonio, chassi: row[1], imei: row[9], status: row[12], telefone: row[13] } };
      }
    }
    return { success: false, error: `Patrimônio "${bikeNumber}" não encontrado na aba CHASSI.` };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar informações do chassi: ' + e.message };
  }
}

// Helper para identificar bikes que já tiveram baixa recentemente (60 min)
function getFinalizedBikesToday(limit = 1000, customBlockers = null) {
  const sheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
  const finalized = new Set();
  if (!sheet) return finalized;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return finalized;
  const numCheck = Math.min(lastRow - 1, limit);
  // Lê colunas: Timestamp (1), Patrimônio (2), Status (3), Observação (4), Motorista (5)
  const data = sheet.getRange(lastRow - numCheck + 1, 1, numCheck, 5).getValues();
  const now = new Date();
  const blockers = customBlockers || ['estação', 'estacao', 'recolhida', 'filial', 'vandalizada', 'remanejada', 'em posse', 'finalizada'];
  data.forEach(row => {
    const ts = row[0];
    const pat = String(row[1]).trim();
    const st = String(row[2]).trim().toLowerCase();
    const driver = String(row[4] || '').trim().toLowerCase();
    if (!pat) return;
    const tsDate = ts instanceof Date ? ts : parseTimestamp(ts);
    if (tsDate && (Math.abs(now - tsDate) / 60000 < 60) && blockers.some(s => st.includes(s))) {
      finalized.add(pat);
      finalized.add(String(parseFloat(pat)));
      if (driver) {
        finalized.add(pat + '|' + driver);
        finalized.add(String(parseFloat(pat)) + '|' + driver);
      }
    }
  });
  return finalized;
}

function searchBike(bikeNumber, driverName) {
  if (!bikeNumber) return { success: false, error: 'Número da bicicleta não informado.' };
  const bikeStr = String(bikeNumber).trim();
  const bikeNum = parseFloat(bikeStr);
  try {
    const index = getBikeIndex();
    let row = index[bikeStr];
    if (!row && !isNaN(bikeNum)) row = index[String(bikeNum)];
    if (!row) {
      const debugInfo = debugSearch(bikeStr);
      return { success: false, error: `Bicicleta "${bikeStr}" não encontrada.`, debug: debugInfo };
    }
    const stVal = String(row[COLUMN_INDICES.BIKES.STATUS - 1] || '').trim();
    const bikeObject = {
      'Patrimônio':                  row[COLUMN_INDICES.BIKES.PATRIMONIO - 1],
      'Status':                      stVal,
      'status':                      stVal,
      'statusSistema':               stVal,
      'situacao':                    stVal,
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
    
    if (driverName) {
      const finalized = getFinalizedBikesToday(1000);
      const dNorm = driverName.trim().toLowerCase();
      const bikeStrNorm = String(parseFloat(bikeStr) || bikeStr);
      if (finalized.has(bikeStr + '|' + dNorm) || finalized.has(bikeStrNorm + '|' + dNorm)) {
         return { success: false, error: `Você já registrou a bicicleta ${bikeStr} nos últimos 60 minutos. Evite duplicidade.` };
      }
    }

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
            const loc2 = String(reqData[i][COLUMN_INDICES.REQUESTS.LOCAL - 1] || '').toLowerCase();
            const occ2 = String(reqData[i][COLUMN_INDICES.REQUESTS.OCORRENCIA - 1] || '').toLowerCase();
            const dest2 = String(reqData[i][COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || '').toLowerCase();
            const isCarr2 = occ2.includes('carretinha') || loc2.includes('carretinha') || dest2.includes('carretinha');
            const isRot2  = occ2 === 'roteiro gerado'
              || loc2.includes('roteiro autom') // cobre "roteiro automático" e "roteiro automatico"
              || loc2.includes('criado via roteiro')
              || loc2.includes('via roteiro app')
              || loc2.includes('via app')
              || loc2.includes('roteiro app');
            if (!isCarr2 && !isRot2) { bikeObject.ocorrencia = true; break; }
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
// --- LOG REPORT ---
// =================================================================
function logReport(rowData, kmFinal, plate) {
  if (!Array.isArray(rowData) || rowData.length === 0) {
    return { success: false, error: 'Dados do relatório inválidos.' };
  }
  try {
    const sheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REPORT_SHEET_NAME}" não encontrada.`);
    const patrimonio = (rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
    const status = (rowData[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
    const motorista = (rowData[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
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
        if (sameKey && Math.abs(now - rowTs) / 60000 < 60) return { success: true, message: 'Registro duplicado ignorado.' };
      }
    }
    sheet.appendRow(rowData);
    try { updateBikeStatusInMainSheet(patrimonio, status); } catch (e) { console.error('Erro ao atualizar status na planilha principal:', e); }
    try { updateAlertFromReport(patrimonio, status, rowData[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]); } catch (alertErr) { console.error('Erro ao atualizar alerta incremental:', alertErr); }
    if (patrimonio) {
      const cache = CacheService.getScriptCache();
      cache.remove('bikes_index');
      cache.remove('bike_statuses');
    }
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
    syncWithRequests(patrimonio, status, rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1], motorista);
    const statusLower = status.toLowerCase();
    if (statusLower === 'não encontrada' || statusLower === 'nao encontrada') {
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
// --- SOLICITAÇÕES ---
// =================================================================
function getRequests(driverName, category, providedSheet) {
  const cacheKey = `requests_${driverName || 'none'}_${category || 'none'}`;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch (e) {} }
  const sheet = providedSheet || getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);
  let requests = [];
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const catNorm = normalizeCategory(category);
    const isMotorista = catNorm.includes('MOTORISTA');
    const userNameLower = (driverName || '').toLowerCase();
    const userNameNorm = normDriver(driverName); // normalizado para comparação robusta
    requests = data.map((row, index) => {
      const patrimonio = row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '';
      const status = (row[COLUMN_INDICES.REQUESTS.SITUACAO - 1] || STATUS.PENDENTE).trim().toLowerCase();
      const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || 'Todos').toString().trim().toLowerCase();
      const declinedBy = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());
      const isPending = status === 'pendente';
      // isForMe: compara com normDriver para tolerar "Andre" vs "ANDRE" vs "André"
      const isForMe = normDriver(recipient) === userNameNorm;
      // isForAllDrivers: alinhado com pendingCounts — aceita 'todos' para qualquer categoria
      const isForAllDrivers = recipient === 'todos';
      // declinedBy também deve usar normDriver para comparação robusta
      const declinedByNorm = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString()
        .split(',').map(s => normDriver(s.trim()));
      if (patrimonio && isPending && !declinedByNorm.includes(userNameNorm) && (isForMe || isForAllDrivers)) {
        return {
          id: index + 2, timestamp: row[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1],
          bikeNumber: patrimonio, reason: row[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1],
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
    history = data.map((row, index) => {
      const patrimonio = row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '';
      const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || 'Todos').toString().trim().toLowerCase();
      const acceptedBy = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim().toLowerCase();
      const declinedBy = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());
      const driverLower = (driverName || '').toLowerCase();
      if (patrimonio && (isAdm || recipient === driverLower || acceptedBy === driverLower || declinedBy.includes(driverLower))) {
        return {
          id: index + 2, timestamp: row[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1],
          bikeNumber: patrimonio, reason: row[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1],
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
  if (!patrimonio || !ocorrencia || !local || !recipient) return { success: false, error: 'Todos os campos são obrigatórios.' };
  
  // Bloqueio preventivo: evita criação de solicitação para bike já finalizada hoje pelo mesmo motorista
  const finalized = getFinalizedBikesToday(500);
  const rNorm = recipient.trim().toLowerCase();
  const pats = patrimonio.toString().split(',').map(s => s.trim()).filter(Boolean);
  const alreadyDoneByRecipient = pats.filter(p => finalized.has(p + '|' + rNorm) || finalized.has(String(parseFloat(p)) + '|' + rNorm));
  if (alreadyDoneByRecipient.length > 0) return { success: false, error: `Bikes já finalizadas recentemente pelo motorista ${recipient}: ${alreadyDoneByRecipient.join(', ')}.` };

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
  newRow[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1]    = new Date();
  newRow[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1]   = patrimonio;
  newRow[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1]   = ocorrencia;
  newRow[COLUMN_INDICES.REQUESTS.LOCAL - 1]        = finalLocal;
  newRow[COLUMN_INDICES.REQUESTS.SITUACAO - 1]     = STATUS.PENDENTE;
  newRow[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] = recipient;
  sheet.appendRow(newRow);
  CacheService.getScriptCache().remove(`requests_${recipient}_MOTORISTA`);
  return { success: true, message: 'Solicitação criada com sucesso.' };
}

function declineRequest(requestId, driverName) {
  if (!requestId) return { success: false, error: 'ID da solicitação é obrigatório.' };
  const sheet = getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);
  const row = parseInt(requestId, 10);
  if (isNaN(row) || row < 2 || row > sheet.getLastRow()) return { success: false, error: `ID inválido: ${requestId}` };
  const recipient = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.DESTINATARIO).getValue() || 'Todos').toString().trim().toLowerCase();
  if (recipient === 'todos' && driverName) {
    const current = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.RECUSADA_POR).getValue() || '').toString();
    const list = current.split(',').map(s => s.trim()).filter(Boolean);
    if (!list.includes(driverName)) { list.push(driverName); sheet.getRange(row, COLUMN_INDICES.REQUESTS.RECUSADA_POR).setValue(list.join(', ')); }
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
  if (isNaN(row) || row < 2 || row > sheet.getLastRow()) return { success: false, error: `ID inválido: ${requestId}` };
  const currentStatus = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.SITUACAO).getValue() || STATUS.PENDENTE).toString().trim().toLowerCase();
  if (currentStatus !== 'pendente') return { success: false, error: 'Esta solicitação já foi processada.' };
  sheet.getRange(row, COLUMN_INDICES.REQUESTS.ACEITA_POR, 1, 3).setValues([[driverName, new Date(), STATUS.ACEITA]]);
  const patrimonioRaw = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.PATRIMONIO).getValue() || '').toString();
  const bikesToAdd = patrimonioRaw.split(',').map(s => s.trim()).filter(Boolean);
  
  // Bloqueio definitivo: evita que bikes finalizadas retornem ao app via aceitação de solicitação (mesmo motorista)
  const finalized = getFinalizedBikesToday(500);
  const dNorm = driverName.trim().toLowerCase();
  const alreadyDoneByMe = bikesToAdd.filter(b => finalized.has(b + '|' + dNorm) || finalized.has(String(parseFloat(b)) + '|' + dNorm));
  if (alreadyDoneByMe.length > 0) return { success: false, error: `Você já finalizou estas bikes recentemente: ${alreadyDoneByMe.join(', ')}. Recuse esta solicitação.` };

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
        Id: row[COLUMN_INDICES.STATIONS.ID - 1], Numb: row[COLUMN_INDICES.STATIONS.NUMB - 1],
        Name: name, Address: row[COLUMN_INDICES.STATIONS.ADDRESS - 1],
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
    .map(row => row[COLUMN_INDICES.ACCESS.USUARIO - 1]).filter(Boolean);
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

// =================================================================
// --- HELPERS GLOBAIS DE NORMALIZAÇÃO ---
// Definidos no escopo global para uso em getDriversSummary,
// getAnalyticalDashboardData e qualquer outra função.
// =================================================================

/**
 * Normaliza patrimônio: converte "00476" → "476", "476" → "476"
 */
function normPat(p) {
  return String(parseFloat(p) || String(p).trim());
}

/**
 * Normaliza nome de motorista: lowercase + sem acentos + trim
 * "ANDRE", "André", "Andre" → "andre"
 */
function normDriver(d) {
  return (d || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function getDriverState(driverName, providedSheet) {
  const sheet = providedSheet || getSpreadsheet().getSheetByName(STATE_SHEET_NAME);
  if (!sheet) return { success: true, data: { routeBikes: [], collectedBikes: [] } };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, data: { routeBikes: [], collectedBikes: [] } };
  
  // v85.23: Filtra bikes entregues recentemente (60 min) para garantir que não retornem ao app
  const deliveredRecently = getFinalizedBikesToday(500, ['estação', 'estacao', 'filial', 'vandalizada', 'remanejada', 'mecanica', 'manutenção', 'técnica', 'recuperada', 'encontrada']);
  const normTarget = normalizeName(driverName);
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  
  for (let i = 0; i < data.length; i++) {
    if (normalizeName(data[i][COLUMN_INDICES.STATE.MOTORISTA - 1]) === normTarget) {
      let route     = (data[i][COLUMN_INDICES.STATE.ROTEIRO - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
      let collected = (data[i][COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
      
      // Filtra bikes que tiveram baixa no relatório recentemente
      route = route.filter(b => !deliveredRecently.has(b));
      collected = collected.filter(b => !deliveredRecently.has(b));

      return {
        success: true,
        data: { routeBikes: route, collectedBikes: collected }
      };
    }
  }
  return { success: true, data: { routeBikes: [], collectedBikes: [] } };
}

function updateDriverState(driverName, routeBikes, collectedBikes) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    return _updateDriverStateInternal(driverName, routeBikes, collectedBikes);
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function _updateDriverStateInternal(driverName, routeBikes, collectedBikes) {
  const sheet = getSpreadsheet().getSheetByName(STATE_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${STATE_SHEET_NAME}" não encontrada.`);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn() || 4;
  const routeStr = Array.isArray(routeBikes) ? [...new Set(routeBikes.map(b => String(b).trim()))].filter(Boolean).join(', ') : '';
  const collectedStr = Array.isArray(collectedBikes) ? [...new Set(collectedBikes.map(b => String(b).trim()))].filter(Boolean).join(', ') : '';
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
  const driverColIdx    = COLUMN_INDICES.STATE.MOTORISTA - 1;
  const routeColIdx     = COLUMN_INDICES.STATE.ROTEIRO - 1;
  const collectedColIdx = COLUMN_INDICES.STATE.RECOLHIDAS - 1;
  let driverFound = false, changed = false;
  for (let i = 0; i < dataRows.length; i++) {
    const currentNorm = normalizeName(dataRows[i][driverColIdx]);
    if (currentNorm === normTarget) {
      if (String(dataRows[i][routeColIdx]).trim() !== String(routeStr).trim() || String(dataRows[i][collectedColIdx]).trim() !== String(collectedStr).trim()) {
        dataRows[i][routeColIdx] = routeStr;
        dataRows[i][collectedColIdx] = collectedStr;
        changed = true;
      }
      driverFound = true;
    } else if (allBikes.length > 0) {
      let otherRoute     = String(dataRows[i][routeColIdx] || '').split(',').map(s => s.trim()).filter(Boolean);
      let otherCollected = String(dataRows[i][collectedColIdx] || '').split(',').map(s => s.trim()).filter(Boolean);
      const before = otherRoute.length + otherCollected.length;
      allBikes.forEach(bike => { 
        otherRoute = otherRoute.filter(b => b !== bike); 
        otherCollected = otherCollected.filter(b => b !== bike); 
      });
      if (otherRoute.length + otherCollected.length !== before) {
        dataRows[i][routeColIdx] = otherRoute.join(', ');
        dataRows[i][collectedColIdx] = otherCollected.join(', ');
        changed = true;
      }
    }
  }
  if (!driverFound) {
    const newRow = new Array(allData[0].length).fill('');
    newRow[driverColIdx] = driverName; newRow[routeColIdx] = routeStr; newRow[collectedColIdx] = collectedStr;
    sheet.appendRow(newRow);
  } else if (changed) {
    sheet.getRange(2, 1, dataRows.length, allData[0].length).setValues(dataRows);
  }
  CacheService.getScriptCache().remove('bike_statuses');
  return { success: true };
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
    for (let i = 0; i < data.length; i++) {
      const acceptedBy = (data[i][COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim().toLowerCase();
      const status = (data[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').toString().trim().toLowerCase();
      if (acceptedBy === driverLower && status === 'aceita') {
        sheet.getRange(i + 2, COLUMN_INDICES.REQUESTS.SITUACAO).setValue(STATUS.CANCELADA);
        changed = true;
      }
    }
    return { success: true, message: changed ? 'Roteiro cancelado.' : 'Nenhuma rota ativa.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateBikeAssignment(bikeNumber, driverName) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const ss = getSpreadsheet();
    
    // ATUALIZA STATUS NA PLANILHA PRINCIPAL
    updateBikeStatusInMainSheet(bikeNumber, `Recolhida por ${driverName}`);

    const sheet = ss.getSheetByName(STATE_SHEET_NAME);
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
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
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
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const { driverName, bikeNumber, finalStatus, finalObservation } = request;
    const stateResult = getDriverState(driverName);
    let routeBikes    = stateResult.success ? stateResult.data.routeBikes : [];
    let collectedBikes= stateResult.success ? stateResult.data.collectedBikes : [];
    const bikeResult  = searchBike(bikeNumber);
    if (!bikeResult.success) throw new Error(`Bicicleta ${bikeNumber} não encontrada.`);
    const bikeDetails = bikeResult.data;
    
    routeBikes = routeBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    collectedBikes = collectedBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    if (finalStatus === 'Recolhida') collectedBikes.push(bikeNumber);
    
    // Atualiza o estado do motorista na planilha
    _updateDriverStateInternal(driverName, routeBikes, collectedBikes);

    const statusLower = finalStatus.toLowerCase();
    if (statusLower.includes('recolhida') || statusLower.includes('vandalizada') || statusLower.includes('filial')) addToMechanics(bikeNumber);

    const rowData = [new Date(), bikeNumber, finalStatus, finalObservation, driverName,
      bikeDetails['Status'], bikeDetails['Bateria'], bikeDetails['Trava'], bikeDetails['Localidade']];
    return logReport(rowData);
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function finalizeCollectedBike(request) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // Espera um pouco mais pois envolve múltiplas operações
    const { driverName, bikeNumber, finalStatus, finalObservation } = request;
    const stateResult  = getDriverState(driverName);
    let routeBikes     = stateResult.success ? stateResult.data.routeBikes : [];
    let collectedBikes = stateResult.success ? stateResult.data.collectedBikes : [];
    const bikeResult   = searchBike(bikeNumber);
    if (!bikeResult.success) throw new Error(`Bicicleta ${bikeNumber} não encontrada.`);
    const bikeDetails  = bikeResult.data;
    routeBikes     = routeBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    collectedBikes = collectedBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    const reportStatus = finalStatus === 'Filial' ? 'Recolhida (Filial)' : finalStatus;
    const rowData = new Array(10).fill('');
    rowData[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]  = new Date();
    rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] = bikeNumber;
    rowData[COLUMN_INDICES.REPORTS.STATUS - 1]     = reportStatus;
    rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] = finalObservation;
    rowData[COLUMN_INDICES.REPORTS.MOTORISTA - 1]  = driverName;
    rowData[COLUMN_INDICES.REPORTS.STATUS_SISTEMA - 1] = bikeDetails['Status'];
    rowData[COLUMN_INDICES.REPORTS.BATERIA - 1]    = bikeDetails['Bateria'];
    rowData[COLUMN_INDICES.REPORTS.TRAVA - 1]      = bikeDetails['Trava'];
    rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] = bikeDetails['Localidade'];
    if (finalObservation.includes('Solicitado Recolha')) {
      rowData[COLUMN_INDICES.REPORTS.OCORRENCIA - 1] = 'Ocorrência';
      rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] = finalObservation.replace('Solicitado Recolha - ', '').replace('Solicitado Recolha', '').trim();
    }
    let reportResult = { success: true };
    if (finalStatus !== 'Carretinha') reportResult = logReport(rowData);
    const statusLower = finalStatus.toLowerCase();
    if (statusLower.includes('filial') || statusLower.includes('vandalizada') || statusLower.includes('recolhida')) addToMechanics(bikeNumber);
    
    // Usa versão interna pois já detemos o lock aqui em finalizeCollectedBike
    _updateDriverStateInternal(driverName, routeBikes, collectedBikes);
    return { ...reportResult, bikeDetails };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// =================================================================
// --- ALERTAS E VANDALIZADAS ---
// =================================================================
function getAlerts(forceScan = false) {
  const cache = CacheService.getScriptCache();
  const ALERTS_CACHE_VERSION = 'v15';
  const cacheKey = 'alerts_data_' + ALERTS_CACHE_VERSION;
  
  if (!forceScan) {
    const cached = cache.get(cacheKey);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        if (Array.isArray(data)) {
          return { success: true, data: data, cached: true, version: ALERTS_CACHE_VERSION };
        }
      } catch (e) {}
    }
  }

  try {
    const ss = getSpreadsheet();
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

    // SEMPRE forçamos um index fresco se estivermos reconstruindo a lista de alertas
    // para garantir que bikes marcadas como Roubada no Sheets sumam imediatamente.
    const bikeIdx = getBikeIndex(true); 

    const alerts = alertsData.map((row, idx) => {
      const patrimonio = String(row[0] || '').trim();
      if (!patrimonio || patrimonio === '0') return null;
      
      const sit = String(row[4] || '').trim().toLowerCase();
      
      // Status terminais que devem SUMIR da lista
      const terminalAlertStatuses = ['roubada', 'vandalizada', 'perdida', 'furtada', 'leiloada', 'sucateada'];
      if (terminalAlertStatuses.indexOf(sit) !== -1) return null;

      // Filtro de processamento: só as que estão em aberto (Pendente ou Localizada)
      if (sit === 'pendente' || sit === 'localizada' || sit === STATUS.PENDENTE.toLowerCase() || sit === STATUS.LOCALIZADA.toLowerCase()) {
        
        let isTerminalInBase = false;
        try {
          const bikeRow = bikeIdx[patrimonio];
          if (bikeRow) {
            const realStatus = String(bikeRow[COLUMN_INDICES.BIKES.STATUS - 1] || '').trim().toLowerCase();
            // Se na base principal (Bicicletas) o status for terminal, remove do alerta
            if (terminalAlertStatuses.indexOf(realStatus) !== -1) {
              isTerminalInBase = true;
              
              // Sincroniza a aba Alertas com o status terminal para evitar re-processamento
              try {
                const targetRow = idx + 2;
                alertsSheet.getRange(targetRow, 5).setValue(realStatus.charAt(0).toUpperCase() + realStatus.slice(1));
              } catch (e) {}
            }
          }
        } catch (e) {
          console.error('Erro ao verificar status real:', e);
        }

        if (!isTerminalInBase) {
          return {
            id: idx + 2,
            patrimonio: patrimonio,
            check1: row[1], check2: row[2], check3: row[3],
            situacao: row[4]
          };
        }
      }
      return null;
    }).filter(Boolean);

    try { cache.put(cacheKey, JSON.stringify(alerts), 600); } catch (e) {}
    return { success: true, data: alerts, version: ALERTS_CACHE_VERSION, count: alerts.length };
  } catch (e) {
    console.error('Erro em getAlerts:', e);
    return { success: false, error: 'Erro ao processar alertas: ' + e.message };
  }
}

function updateAlertFromReport(patrimonio, status, timestamp) {
  if (!patrimonio || !status) return;
  const st = status.toString().toLowerCase().trim();
  const pat = patrimonio.toString().trim();
  const isMissing = st === 'não encontrada' || st === 'nao encontrada';
  
  // v85.18: Separação de encontrados (remanejáveis) e terminais (Roubada/Vandalizada/Perdida)
  const isTerminal = st === 'roubada' || st === 'vandalizada' || st === 'perdida';
  const isFound = !isTerminal && (st.includes('remanejada') || st.includes('estação') || st.includes('estacao') || st.includes('filial') || st.includes('recolhida') || st.includes('mecanica') || st.includes('manutenção') || st.includes('manutencao') || st.includes('tecnica'));
  
  if (!isMissing && !isFound && !isTerminal) return;
  try {
    const ss = getSpreadsheet();
    let alertsSheet = ss.getSheetByName(ALERTS_SHEET_NAME) || ss.getSheetByName('Alertas') || ss.getSheetByName('Alerta');
    if (!alertsSheet) return;
    const lastRow = alertsSheet.getLastRow();
    let data = [];
    if (lastRow > 1) data = alertsSheet.getRange(2, 1, lastRow - 1, 7).getValues();
    let foundIdx = -1;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === pat) { foundIdx = i; break; }
    }
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (isMissing) {
      if (foundIdx === -1) {
        alertsSheet.appendRow([pat, ts, '', '', STATUS.PENDENTE, '', '']);
      } else {
        const rowData = data[foundIdx];
        const sit = String(rowData[4]).trim().toLowerCase();
        if (sit === STATUS.LOCALIZADA.toLowerCase()) {
          alertsSheet.getRange(foundIdx + 2, 2).setValue(ts);
          alertsSheet.getRange(foundIdx + 2, 3, 1, 2).setValues([['', '']]);
          alertsSheet.getRange(foundIdx + 2, 5).setValue(STATUS.PENDENTE);
        } else if (sit === STATUS.PENDENTE.toLowerCase() || sit === 'pendente') {
          if (!rowData[1]) alertsSheet.getRange(foundIdx + 2, 2).setValue(ts);
          else if (!rowData[2]) alertsSheet.getRange(foundIdx + 2, 3).setValue(ts);
          else if (!rowData[3]) alertsSheet.getRange(foundIdx + 2, 4).setValue(ts);
        }
      }
    } else if (isFound || isTerminal) {
      if (foundIdx !== -1) {
        const sit = String(data[foundIdx][4]).trim().toLowerCase();
        if (sit === STATUS.PENDENTE.toLowerCase() || sit === 'pendente' || sit === STATUS.LOCALIZADA.toLowerCase()) {
          if (isTerminal) {
            alertsSheet.getRange(foundIdx + 2, 5).setValue(st.charAt(0).toUpperCase() + st.slice(1));
          } else {
            alertsSheet.getRange(foundIdx + 2, 5).setValue(STATUS.LOCALIZADA);
          }
        }
      }
    }
    _clearAlertsCache();
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
    _clearAlertsCache();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Helpler para limpar caches de alertas (v13, v14, v15 etc)
 */
function _clearAlertsCache() {
  const cache = CacheService.getScriptCache();
  cache.remove('alerts_data_v13');
  cache.remove('alerts_data_v14');
  cache.remove('alerts_data_v15');
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
      sheet.getRange(i + 1, COLUMN_INDICES.VANDALIZED.SITUACAO, 1, 3).setValues([[STATUS.ENCONTRADA, motorista, new Date()]]);
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
    let reportSheet = ss.getSheetByName(REPORT_SHEET_NAME) || ss.getSheetByName('Relatório');
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
      const reportData = rowsToRead > 0 ? reportSheet.getRange(lastRowReport - rowsToRead + 1, 1, rowsToRead, reportSheet.getLastColumn()).getValues() : [];
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
          vandalizedHistory[pat] = { patrimonio: pat, data: ts, defeito: row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || 'Vandalismo reportado', local: row[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || 'N/A', situacao: STATUS.PENDENTE };
        }
      });
      const currentVData = vandalizedSheet.getDataRange().getValues();
      Object.values(vandalizedHistory).forEach(v => {
        let rowIndex = -1;
        for (let i = 1; i < currentVData.length; i++) {
          const patInSheet = (currentVData[i][0] || '').toString().trim();
          const sitInSheet = (currentVData[i][4] || '').toString().trim().toLowerCase();
          if (patInSheet === v.patrimonio && sitInSheet !== STATUS.ENCONTRADA.toLowerCase() && sitInSheet !== 'encontrada') { rowIndex = i + 1; break; }
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
    try { cache.put(cacheKey, JSON.stringify(vandalized), 120); } catch (e) {}
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
    sheet.getRange(row, COLUMN_INDICES.VANDALIZED.SITUACAO, 1, 3).setValues([[STATUS.ENCONTRADA, driverName, new Date()]]);
    CacheService.getScriptCache().remove('vandalized_data');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateVandalismoSheet(rowData) {
  const sheet = getSpreadsheet().getSheetByName(VANDALISMO_SHEET_NAME);
  if (!sheet) return;
  sheet.appendRow([rowData[COLUMN_INDICES.REPORTS.TIMESTAMP - 1], rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1], rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1], rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1]]);
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
// --- RELATÓRIOS E RESUMOS ---
// =================================================================
function saveDailySummary(summaryData) {
  try {
    let sheet = getSpreadsheet().getSheetByName(DAILY_SUMMARY_SHEET_NAME);
    if (!sheet) {
      sheet = getSpreadsheet().insertSheet(DAILY_SUMMARY_SHEET_NAME);
      sheet.appendRow(['Data','Motorista','Placa(s)','KM Total','Bateria Baixa','Manut. Bicicleta','Manut. Locker','Solicitado Recolha','Remanejadas (Estação)','Ocorrências','Não Encontradas','Vandalizadas','Início','Fim','Observações']);
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
  
  const baseLocal = getScriptTzDate();
  const filterDate = new Date(baseLocal.getTime()); filterDate.setHours(0, 0, 0, 0);
  const todayEnd = new Date(baseLocal.getTime()); todayEnd.setHours(23, 59, 59, 999);
  
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
    if (sess.inicio !== null && sess.fim !== null && sess.fim > sess.inicio) report.totalKmRodado += sess.fim - sess.inicio;
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
    const cleanTime = t => { if (!t) return ''; const m = t.match(/^(\d{1,2}:\d{2}):\d{2}$/); return m ? m[1] : t; };
    for (let i = 1; i < values.length; i++) {
      if ((values[i][driverColIdx] || '').trim().toLowerCase() !== driverLower) continue;
      for (let j = 0; j < headers.length; j++) {
        if (j === driverColIdx) continue;
        const header = headers[j].toString().trim();
        if (!header) continue;
        const v1 = cleanTime((values[i][j] || '').toString().trim());
        const v2 = (j + 1 < headers.length && !headers[j+1].toString().trim()) ? cleanTime((values[i][j+1] || '').toString().trim()) : '';
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
          if (!conflicts[bike].status && ['VANDALIZADA','MANUTENÇÃO','ROUBADA'].includes(sysSt)) conflicts[bike].status = sysSt;
          if (!conflicts[bike].recentAction && (now - ts.getTime() < FOUR_HOURS_MS)) {
            if (status.includes('FILIAL') || status === 'ESTAÇÃO' || status === 'ESTACAO') {
              conflicts[bike].recentAction = `${motorista} (${status})`;
            }
          }
        }
      }
    }
    try { cache.put(cacheKey, JSON.stringify(conflicts), 30); } catch (e) {}
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
    try { cache.put(cacheKey, JSON.stringify(data), 5); } catch (e) {}
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

    // v85.35: Busca bikes que já estão na mecânica ou organizadas para excluir da lista de pendentes
    const mechSheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    const inMechanics = new Set();
    const nowMs = Date.now();
    if (mechSheet && mechSheet.getLastRow() > 1) {
      const mechData = mechSheet.getDataRange().getValues();
      for (let i = 1; i < mechData.length; i++) {
        const pat = String(mechData[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
        const st = String(mechData[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim().toLowerCase();
        const tsEnt = toMs(mechData[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
        const tsFin = toMs(mechData[i][COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1]);
        const lastUpdateMs = Math.max(tsEnt || 0, tsFin || 0);

        const isActive = !['finalizada', 'remanejada', 'consertada', 'ativo', 'ativa'].includes(st);
        const isRecent = (nowMs - lastUpdateMs) < (18 * 60 * 60 * 1000); // 18h para cobrir trocas de turno

        if (pat && (isActive || isRecent)) inMechanics.add(pat);
      }
    }

    // Também bloqueia se o status atual no sistema já for Manutenção
    try {
      const bikeIndex = getBikeIndex();
      Object.keys(bikeIndex).forEach(pat => {
        const row = bikeIndex[pat];
        const status = String(row[COLUMN_INDICES.BIKES.STATUS - 1] || '').trim().toLowerCase();
        if (status.includes('manutenção') || status.includes('manutencao')) {
          inMechanics.add(pat.replace(/^0+/, ''));
        }
      });
    } catch (e) {}

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
      const isRecovery     = ['ativo','manutenção','manutencao','remanejada','consertada'].some(s => statusLower.includes(s));
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
      if (r.isRecovery || inMechanics.has(patrimonio)) return;
      const item = { patrimonio, observation: r.observation || '' };
      if (r.status.includes('vandalizada') || r.status.includes('vandalismo')) vandalizadas.push(item);
      else if (r.status.includes('filial') || r.status.includes('recolhida') || r.status.includes('recolher')) filial.push(item);
    });
    const result = { vandalizadas: vandalizadas.sort(sortFn), filial: filial.sort(sortFn) };
    if (!providedSheets) { try { cache.put(cacheKey, JSON.stringify(result), 120); } catch (e) {} }
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar dados de status: ' + e.message };
  }
}

function getDriversSummary(timeRange = 'day', providedSheets = null, driverNameFilter = null, timelineDate = null) {
  const cacheKey = `summary_${timeRange}_${driverNameFilter || 'all'}`;
  const cache = CacheService.getScriptCache();
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
          return cat.includes('MOTORISTA') && !user.toLowerCase().includes('aline') && !user.toLowerCase().includes('diego');
        })
        .map(row => row[COLUMN_INDICES.ACCESS.USUARIO - 1].toString().trim()))];
    }
    const baseLocal = getScriptTzDate();
    let filterDate = new Date(baseLocal.getTime()); filterDate.setHours(0,0,0,0);
    let endDate = new Date(baseLocal.getTime()); endDate.setHours(23,59,59,999);
    let rowsToRead = 1000;
    let timelineFilterDate = filterDate;
    let timelineEndDate = endDate;
    if (timelineDate) {
      const parts = timelineDate.split('-');
      timelineFilterDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 0, 0, 0, 0);
      timelineEndDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 23, 59, 59, 999);
      if (timeRange === 'day') {
        filterDate = timelineFilterDate;
        endDate = timelineEndDate;
      }
    }
    if (timeRange === 'week') { const day = baseLocal.getDay(); const diffToMon = (day === 0 ? -6 : 1) - day; filterDate.setDate(baseLocal.getDate() + diffToMon); filterDate.setHours(0,0,0,0); rowsToRead = 50000; }
    else if (timeRange === 'month') { filterDate.setDate(1); filterDate.setHours(0,0,0,0); rowsToRead = 80000; }
    else if (timeRange === '-1') { filterDate.setDate(baseLocal.getDate() - 1); filterDate.setHours(0,0,0,0); endDate.setDate(baseLocal.getDate() - 1); endDate.setHours(23,59,59,999); rowsToRead = 30000; }
    else if (timeRange === '-7') {
      const day = baseLocal.getDay(); const diffToMon = (day === 0 ? -6 : 1) - day;
      filterDate.setDate(baseLocal.getDate() + diffToMon - 7);
      filterDate.setHours(0,0,0,0);
      endDate.setDate(filterDate.getDate() + 6); endDate.setHours(23, 59, 59, 999); rowsToRead = 80000;
    }
    const lastRowR = reportSheet.getLastRow();
    let reportsData = [];
    if (lastRowR > 1) {
      const numRows = Math.min(lastRowR - 1, rowsToRead);
      reportsData = reportSheet.getRange(lastRowR - numRows + 1, 1, numRows, reportSheet.getLastColumn()).getValues();
    }
    const stats = {};
    const driverLookup = {};
    drivers.forEach(d => { stats[d] = { recolhidas: 0, remanejada: 0, naoEncontrada: 0, naoAtendida: 0 }; driverLookup[d.toLowerCase()] = d; });
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
    const deliveredRecently = getFinalizedBikesToday(500, ['estação', 'estacao', 'filial', 'vandalizada', 'remanejada', 'mecanica', 'manutenção', 'técnica', 'recuperada', 'encontrada']);
    stateData.forEach(row => {
      const driver = row[COLUMN_INDICES.STATE.MOTORISTA - 1];
      if (drivers.includes(driver)) {
        let route     = (row[COLUMN_INDICES.STATE.ROTEIRO - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
        let collected = (row[COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
        
        route = route.filter(b => !deliveredRecently.has(b));
        collected = collected.filter(b => !deliveredRecently.has(b));

        realTime[driver] = { route, collected };
      }
    });
    const pendingCounts = {};
    const occLookup = {}; // motorista_lower|patrimonio → true
    drivers.forEach(d => pendingCounts[d] = 0);
    const lastRowReq = requestsSheet.getLastRow();
    const reqData = lastRowReq > 1 ? requestsSheet.getRange(2, 1, lastRowReq - 1, requestsSheet.getLastColumn()).getValues() : [];

    reqData.forEach(row => {
      const status    = (row[COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').toLowerCase();
      const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || '').toString().trim().toLowerCase();
      const declined  = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());

      // 1. Conta solicitações pendentes
      if (status === 'pendente') {
        drivers.forEach(d => {
          const dNorm = normDriver(d);
          const recipientNorm = normDriver(recipient);
          const declinedNorm = declined.map(s => normDriver(s));
          if ((recipient === 'todos' || recipientNorm === dNorm) && !declinedNorm.includes(dNorm)) pendingCounts[d]++;
        });
      }
    });

    const timelines = {};
    const timelineWindows = {};
    drivers.forEach(d => { timelines[d] = []; });
    if (timeRange === 'day' || timeRange === '-1' || timelineDate) {
      const tlStart = timelineDate ? timelineFilterDate : filterDate;
      const tlEnd   = timelineDate ? timelineEndDate   : endDate;

      // 2. Mapeia ocorrências reais para a timeline (exclui roteiros e carretinhas)
      // AGORA RESTRITO À JANELA tlStart..tlEnd para coincidir com o dashboard
      reqData.forEach(row => {
        const acceptedBy   = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR  - 1] || '').toString().trim();
        const acceptedDate = row[COLUMN_INDICES.REQUESTS.ACEITA_DATA   - 1];
        const status       = (row[COLUMN_INDICES.REQUESTS.SITUACAO     - 1] || '').toString().trim().toLowerCase();

        if (acceptedBy && acceptedDate && (status === 'aceita' || status === 'finalizada')) {
          let tsAcc = parseTimestamp(acceptedDate);
          if (tsAcc && tsAcc.getHours() === 0 && tsAcc.getMinutes() === 0 && tsAcc.getSeconds() === 0) {
            const tsReq = parseTimestamp(row[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1]);
            if (tsReq) tsAcc = tsReq;
          }

          if (tsAcc && tsAcc >= tlStart && tsAcc <= tlEnd) {
            const loc = (row[COLUMN_INDICES.REQUESTS.LOCAL - 1] || '').toString().toLowerCase();
            const occCol = (row[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1] || '').toString().toLowerCase();
            const dest = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || '').toString().toLowerCase();
            
            const isCarretinha = occCol.includes('carretinha') || loc.includes('carretinha') || dest.includes('carretinha');
            const isRoteiro = occCol.includes('roteiro gerado') 
              || loc.includes('roteiro autom') 
              || loc.includes('criado via roteiro')
              || loc.includes('via roteiro app')
              || loc.includes('via app')
              || loc.includes('roteiro app')
              || loc.includes('app');

            if (!isCarretinha && !isRoteiro) {
              const pats = (row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '').toString().trim().split(',').map(s => s.trim()).filter(Boolean);
              pats.forEach(p => { 
                occLookup[normDriver(acceptedBy) + '|' + normPat(p)] = true; 
              });
            }
          }
        }
      });

      const driverFirstLast = {};
      const occAlreadyMarked = {};
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
        else if (status.includes('carretinha')) type = 'carretinha';
        if (type) {
          const pat = String(row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
          const obs = String(row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').trim();
          // isOcc: usa APENAS o occLookup (cruzamento direto com aba Solicitação)
          // O occLookup aplica os mesmos filtros do Dashboard Analítico:
          // exclui carretinha, roteiro automático, via app
          // NÃO usa coluna J do Relatório — foi gravada com filtros incorretos no passado
          const isOcc = !!occLookup[normDriver(driverRaw) + '|' + pat];
          // Restringe estrelas apenas para eventos de recolha ou não encontrada, e evita duplicidade por bike/dia
          const occKey = normDriver(driverRaw) + '|' + pat;
          let finalIsOcc = false;
          if (isOcc && (type === 'recolhida' || type === 'filial' || type === 'nao_encontrada' || type === 'vandalizada')) {
            if (!occAlreadyMarked[occKey]) {
              finalIsOcc = true;
              occAlreadyMarked[occKey] = true;
            }
          }
          timelines[driverKey].push({ tsMs: ts.getTime(), hour: ts.getHours(), min: ts.getMinutes(), type, bikeNumber: pat, observacao: obs, isOccurrence: finalIsOcc });
        }
      });
      drivers.forEach(d => { const fl = driverFirstLast[d]; if (fl) timelineWindows[d] = { startMs: fl.firstMs, endMs: fl.lastMs }; });
    }
    const summary = drivers.map(d => ({
      name: d, stats: stats[d], realTime: realTime[d] || { route: [], collected: [] },
      pendingRequests: pendingCounts[d], timeline: timelines[d] || [], timelineWindow: timelineWindows[d] || null
    }));
    if (useCache) { try { cache.put(cacheKey, JSON.stringify(summary), 30); } catch (e) {} }
    return { success: true, data: summary };
  } catch (e) {
    return { success: false, error: 'Erro ao gerar resumo: ' + e.message };
  }
}

// =================================================================
// --- CORREÇÃO v85.8: getAnalyticalDashboardData ---
// Lógica definitiva:
//   - Enviadas = solicitações manuais (Solicitar Recolha) aceitas pelo motorista
//     no período (data de aceite dentro de filterDate..endDate)
//     Excluídas: roteiro automático, ROTEIRO GERADO
//   - Atendidas = para cada solicitação aceita, verifica se o motorista registrou
//     um status FINALIZADOR no Relatório para aquele patrimônio APÓS o aceite:
//       • Estação / Estacao          → atendida com SUCESSO
//       • Recolhida / Filial         → atendida com SUCESSO
//       • Não encontrada             → atendida SEM SUCESSO (contabiliza em atendidas mas não em sucesso)
//     Se nenhum finalizador foi registrado → não atendida
//   - % Sucesso = sucesso / enviadas (só estação + recolhida/filial)
//   - Recolhidas / Remanejadas = totais gerais do Relatorio no período (independente de solicitação)
// =================================================================
function getAnalyticalDashboardData(timeRange) {
  const ss = getSpreadsheet();
  try {
    const now = new Date();
    let filterDate = new Date(now); filterDate.setHours(0, 0, 0, 0);
    let endDate = new Date(now); endDate.setHours(23, 59, 59, 999);
    let rowsToRead = 5000;
    if (timeRange === 'week')  { const day = now.getDay(); const diffToMon = (day === 0 ? -6 : 1) - day; filterDate.setDate(now.getDate() + diffToMon); rowsToRead = 60000; }
    else if (timeRange === 'month')  { filterDate.setDate(1); rowsToRead = 100000; }
    else if (timeRange === '-1')     { filterDate.setDate(now.getDate() - 1); endDate.setDate(now.getDate() - 1); endDate.setHours(23, 59, 59, 999); rowsToRead = 30000; }
    else if (timeRange === '-7')     { const day = now.getDay(); const diffToMon = (day === 0 ? -6 : 1) - day; filterDate.setDate(now.getDate() + diffToMon - 7); endDate.setDate(filterDate.getDate() + 6); endDate.setHours(23, 59, 59, 999); rowsToRead = 60000; }
    else if (timeRange === '-30')    { filterDate.setMonth(now.getMonth() - 1); filterDate.setDate(1); endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999); rowsToRead = 100000; }

    const reportSheet  = ss.getSheetByName(REPORT_SHEET_NAME);
    const accessSheet  = ss.getSheetByName(ACCESS_SHEET_NAME);
    const requestSheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
    if (!reportSheet) return { success: false, error: 'Planilha de relatórios não encontrada.' };

    // --- Monta lista de motoristas válidos ---
    const motoristasSet = new Set();
    if (accessSheet) {
      const lastRowA = accessSheet.getLastRow();
      if (lastRowA > 1) {
        accessSheet.getRange(2, 1, lastRowA - 1, accessSheet.getLastColumn()).getValues().forEach(row => {
          const cat  = normalizeCategory(row[COLUMN_INDICES.ACCESS.CATEGORIA - 1]);
          const user = (row[COLUMN_INDICES.ACCESS.USUARIO - 1] || '').toString().trim();
          if (cat.includes('MOTORISTA')) motoristasSet.add(user);
        });
      }
    }

    const stats = {};
    motoristasSet.forEach(driver => {
      const lower = driver.toLowerCase();
      if (lower.includes('aline') || lower.includes('diego')) return;
      stats[driver] = {
        recolhidas:   0,   // total geral no período
        remanejadas:  0,   // total geral no período
        enviadas:     0,   // solicitações manuais aceitas
        atendidas:    0,   // com status finalizador (qualquer)
        sucesso:      0,   // com status finalizador positivo (estação ou recolhida/filial)
      };
    });

    // --- 1. Lê o Relatório inteiro do período (para recolhidas/remanejadas gerais) ---
    // Também monta índice: "motorista_lower|patnorm" → [{tsMs, statusFinaliz}]
    // usado para cruzar com as solicitações
    const lastRowR = reportSheet.getLastRow();
    let reportData = [];
    if (lastRowR > 1) {
      const numRows = Math.min(lastRowR - 1, rowsToRead);
      const numCols = Math.max(reportSheet.getLastColumn(), 5);
      reportData = reportSheet.getRange(lastRowR - numRows + 1, 1, numRows, numCols).getValues();
    }

    // Índice de finalizadores: Map<"motorista_lower|patnorm", [{tsMs, tipo}]>
    // tipo: 'sucesso' | 'sem_sucesso'
    const finalizMap = {};

    for (let i = 0; i < reportData.length; i++) {
      const row    = reportData[i];
      const ts     = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      if (!ts) continue;

      const driver = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
      const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
      const pat    = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
      if (!driver || !pat) continue;

      const isRecolhida  = status.includes('filial') || status.includes('recolhida') || status === 'vandalizada';
      const isRemanejada = status.includes('estação') || status.includes('estacao');
      const isNaoEnc     = status.includes('não encontrada') || status.includes('nao encontrada');

      // Contagem geral - busca com normDriver para tolerar acentos/caps
      const driverKeyGeral = Object.keys(stats).find(d => normDriver(d) === normDriver(driver));
      if (ts >= filterDate && ts <= endDate && driverKeyGeral) {
        if (isRecolhida)  stats[driverKeyGeral].recolhidas++;
        if (isRemanejada) stats[driverKeyGeral].remanejadas++;
      }

      // Monta índice de finalizadores para cruzamento com solicitações
      // (usamos janela estendida: filterDate - 48h até endDate + 48h para não perder finalizações próximas das bordas)
      const isFinaliz = isRecolhida || isRemanejada || isNaoEnc;
      if (!isFinaliz) continue;

      const driverLow = normDriver(driver);
      const key = driverLow + '|' + normPat(pat);
      if (!finalizMap[key]) finalizMap[key] = [];
      finalizMap[key].push({
        tsMs: ts.getTime(),
        tipo: isNaoEnc ? 'sem_sucesso' : 'sucesso'
      });
    }

    // --- 2. Lê Solicitações: filtra apenas as manuais aceitas no período ---
    if (requestSheet && requestSheet.getLastRow() > 1) {
      const reqData = requestSheet
        .getRange(2, 1, requestSheet.getLastRow() - 1, requestSheet.getLastColumn())
        .getValues();

      reqData.forEach(row => {
        const acceptedBy   = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR  - 1] || '').toString().trim();
        const acceptedDate = row[COLUMN_INDICES.REQUESTS.ACEITA_DATA   - 1];
        const situacao     = (row[COLUMN_INDICES.REQUESTS.SITUACAO     - 1] || '').toString().trim().toLowerCase();
        const local        = (row[COLUMN_INDICES.REQUESTS.LOCAL        - 1] || '').toString().toLowerCase();
        const patrimonios  = (row[COLUMN_INDICES.REQUESTS.PATRIMONIO   - 1] || '').toString().trim();
        const ocorrencia   = (row[COLUMN_INDICES.REQUESTS.OCORRENCIA   - 1] || '').toString().toLowerCase().trim();

        // Filtra apenas solicitações manuais aceitas (excluindo roteiros automáticos)
        if (!acceptedBy || !acceptedDate) return;
        if (situacao !== 'aceita' && situacao !== 'finalizada') return;

        // Exclui roteiros automáticos e carretinhas — não são solicitações manuais de recolha
        const dest = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || '').toString().toLowerCase().trim();
        const isCarretinha = ocorrencia.includes('carretinha') || local.includes('carretinha') || dest.includes('carretinha');
        const isRoteiro    = ocorrencia === 'roteiro gerado'
          || local.includes('roteiro autom') // cobre "roteiro automático" e "roteiro automatico"
          || local.includes('criado via roteiro')
          || local.includes('roteiro app')
          || local.includes('via roteiro app')
          || local.includes('via app');
        if (isCarretinha || isRoteiro) return;

        // Data de aceite: usa aceita_data se tiver horário, senão cai para o timestamp da solicitação
        // (evita problema de aceita_data vindo só com a data sem hora = 00:00:00 UTC)
        let tsAceite = parseTimestamp(acceptedDate);
        if (!tsAceite) return;
        // Se veio só com data (sem hora = hora é meia-noite), usa o timestamp da solicitação como referência
        if (tsAceite.getHours() === 0 && tsAceite.getMinutes() === 0 && tsAceite.getSeconds() === 0) {
          const tsReq = parseTimestamp(row[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1]);
          if (tsReq) tsAceite = tsReq;
        }
        if (tsAceite < filterDate || tsAceite > endDate) return;

        // Motorista deve existir nos stats
        const driverKey = Object.keys(stats).find(d => normDriver(d) === normDriver(acceptedBy));
        if (!driverKey) return;

        const pats = patrimonios.split(',').map(s => s.trim()).filter(Boolean);
        pats.forEach(pat => {
          stats[driverKey].enviadas++;

          // Busca status finalizador no Relatorio para este motorista+patrimônio
          // APÓS o momento do aceite (não antes)
          const key = normDriver(driverKey) + '|' + normPat(pat);
          const finalizList = finalizMap[key] || [];

          // Pega o finalizador mais próximo ao aceite.
          // Tolerância de 2h antes: cobre casos onde o motorista registra o status
          // no Relatório antes de o sistema gravar o timestamp do aceite,
          // ou quando aceita_data vem só com a data (sem horário = 00:00:00).
          const SETE_DIAS_MS  = 7 * 24 * 60 * 60 * 1000;
          const TOLERANCIA_MS = 2 * 60 * 60 * 1000; // 2 horas
          const tsAceiteMs = tsAceite.getTime();
          const finalizadorApos = finalizList
            .filter(f => f.tsMs >= tsAceiteMs - TOLERANCIA_MS && f.tsMs <= tsAceiteMs + SETE_DIAS_MS)
            .sort((a, b) => a.tsMs - b.tsMs)[0];

          if (finalizadorApos) {
            stats[driverKey].atendidas++; // Estação, Recolhida/Filial OU Não encontrada
            if (finalizadorApos.tipo === 'sucesso') stats[driverKey].sucesso++; // só Estação / Recolhida/Filial
          }
        });
      });
    }

    // --- 3. Monta resultado final ---
    const result = Object.keys(stats).map(driver => {
      const d = stats[driver];
      return {
        driver,
        recolhidas:            d.recolhidas,
        remanejadas:           d.remanejadas,
        totalBikes:            d.recolhidas + d.remanejadas,
        solicitacoesRecebidas: d.enviadas,
        solicitacoesAtendidas: d.atendidas,
        solicitacoesSucesso:   d.sucesso,
        percOcorrencia:        d.enviadas > 0 ? (d.sucesso / d.enviadas) * 100 : 0
      };
    });

    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getRouteDetails(driverName, bikeNumbers, providedBikesSheet, providedRequestsSheet) {
  if (!bikeNumbers || bikeNumbers.length === 0) return { success: true, data: {} };
  // v85.33: Desabilitado cache de detalhes da rota para permitir atualização em tempo real
  try {
    const bikesSheet    = providedBikesSheet    || getSpreadsheet().getSheetByName(BIKES_SHEET_NAME);
    const requestsSheet = providedRequestsSheet || getSpreadsheet().getSheetByName(REQUESTS_SHEET_NAME);
    if (!bikesSheet || !requestsSheet) throw new Error('Planilhas não encontradas.');
    
    // v85.33: Sempre tenta um refresh do index se for uma consulta de detalhes de rota
    let bikeIndex = getBikeIndex(true); 
    const lastRowReq = requestsSheet.getLastRow();
    const numRowsReq = Math.min(lastRowReq - 1, 2000);
    const requestsData = lastRowReq > 1 ? requestsSheet.getRange(lastRowReq - numRowsReq + 1, 1, numRowsReq, requestsSheet.getLastColumn()).getValues() : [];
    const bikeNumberSet = new Set(bikeNumbers.map(n => String(parseFloat(n) || String(n).trim())));
    const result = {};

    const findInIndex = (pat, index) => {
      const bikeStr = String(pat).trim();
      const bikeNum = parseFloat(bikeStr);
      let row = index[bikeStr];
      if (!row && !isNaN(bikeNum)) row = index[String(bikeNum)];
      return row;
    };

    const fillResult = (pat, row) => {
      if (!row) return;
      const s = String(pat).trim();
      const st = String(row[COLUMN_INDICES.BIKES.STATUS - 1] || '').trim();
      result[s] = {
        bikeNumber: s,
        currentLat: parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
        currentLng: parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
        battery: row[COLUMN_INDICES.BIKES.BATERIA - 1],
        status: st, Status: st, statusSistema: st, situacao: st,
        initialLat: null, initialLng: null, ocorrencia: false
      };
    };

    bikeNumbers.forEach(pat => {
      const s = String(pat).trim();
      const row = bikeIndex[s] || bikeIndex[s.replace(/^0+/, '')];
      if (row) fillResult(pat, row);
    });

    for (let i = requestsData.length - 1; i >= 0; i--) {
      const patrimonioRaw = String(requestsData[i][COLUMN_INDICES.REQUESTS.PATRIMONIO - 1]).trim();
      const acceptedBy    = String(requestsData[i][COLUMN_INDICES.REQUESTS.ACEITA_POR - 1]).trim().toLowerCase();
      const situacao      = String(requestsData[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1]).trim().toLowerCase();
      patrimonioRaw.split(',').map(s => s.trim()).filter(Boolean).forEach(rawPat => {
        const patrimonio = String(rawPat).trim();
        const normPat = patrimonio.replace(/^0+/, '');
        
        if ((bikeNumberSet.has(patrimonio) || bikeNumberSet.has(normPat)) && acceptedBy === driverName.toLowerCase() && (situacao === 'aceita' || situacao === 'finalizada')) {
          const originalKey = bikeNumbers.find(n => {
            const sn = String(n).trim();
            return sn === patrimonio || sn === normPat;
          });
          
          if (originalKey) {
            if (!result[originalKey]) {
              const rowFromIndex = bikeIndex[originalKey] || bikeIndex[originalKey.replace(/^0+/, '')];
              if (rowFromIndex) {
                 fillResult(originalKey, rowFromIndex);
              } else {
                result[originalKey] = {
                  bikeNumber: originalKey,
                  currentLat: null, currentLng: null, battery: undefined,
                  status: 'EM ROTA', Status: 'EM ROTA', statusSistema: 'EM ROTA', situacao: 'EM ROTA',
                  initialLat: null, initialLng: null, ocorrencia: false
                };
              }
            }

            const locRD = String(requestsData[i][COLUMN_INDICES.REQUESTS.LOCAL - 1] || '').toLowerCase();
            const occRD = String(requestsData[i][COLUMN_INDICES.REQUESTS.OCORRENCIA - 1] || '').toLowerCase();
            const destRD = String(requestsData[i][COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || '').toLowerCase();
            
            const isCarrRD = occRD.includes('carretinha') || locRD.includes('carretinha') || destRD.includes('carretinha');
            const isRotRD  = occRD === 'roteiro gerado'
              || locRD.includes('roteiro autom')
              || locRD.includes('criado via roteiro')
              || locRD.includes('via roteiro app');
            
            if (!isCarrRD && !isRotRD) {
              result[originalKey].ocorrencia = true;
              if (result[originalKey].initialLat === null) {
                const m = locRD.match(/(-?[\d.,]+)\s*[,;]\s*(-?[\d.,]+)/);
                if (m) { 
                  const lat = parseCoordinate(m[1]);
                  const lng = parseCoordinate(m[2]);
                  result[originalKey].initialLat = lat;
                  result[originalKey].initialLng = lng;
                  if (result[originalKey].currentLat === null) {
                    result[originalKey].currentLat = lat;
                    result[originalKey].currentLng = lng;
                  }
                }
              }
            }
          }
        }
      });
    }
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar detalhes do roteiro: ' + e.message };
  }
}

function getBikeDetailsBatch(bikeNumbers) {
  if (!bikeNumbers || bikeNumbers.length === 0) return { success: true, data: {} };
  // v85.34: Força refresh e usa lógica robusta de index
  const index = getBikeIndex(true);
  const result = {};
  bikeNumbers.forEach(num => {
    const s = String(num).trim();
    const row = index[s] || index[s.replace(/^0+/, '')];
    if (row) {
      const st = String(row[COLUMN_INDICES.BIKES.STATUS - 1] || '').trim();
      result[num] = {
        'Patrimônio': row[COLUMN_INDICES.BIKES.PATRIMONIO - 1],
        'Status': st,
        'status': st,
        'statusSistema': st,
        'situacao': st,
        'Localidade': row[COLUMN_INDICES.BIKES.LOCALIDADE - 1],
        'Usuário': row[COLUMN_INDICES.BIKES.USUARIO - 1],
        'Bateria': row[COLUMN_INDICES.BIKES.BATERIA - 1],
        'Carregando': row[COLUMN_INDICES.BIKES.CARREGAMENTO - 1],
        'Trava': row[COLUMN_INDICES.BIKES.TRAVA - 1],
        'Latitude': parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
        'Longitude': parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
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
    if (kmFinalAtual !== undefined && kmFinalAtual !== null && kmFinalAtual !== '') {
      const plateToClose = currentPlate || '';
      if (plateToClose) updateVehicleKm(plateToClose, undefined, parseFloat(kmFinalAtual));
      if (reportSheet) reportSheet.appendRow([now, plateToClose || 'ATUAL', STATUS.FIM_TURNO, 'KM Final: ' + kmFinalAtual, driverName]);
    }
    updateVehicleKm(plate, kmInicial, undefined);
    if (reportSheet) reportSheet.appendRow([now, plate, STATUS.INICIO_TURNO, kmInicial, driverName]);
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

function getDirections(fromLat, fromLng, toLat, toLng) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_KEY');
    
    // Se a chave não estiver configurada, podemos usar o serviço nativo do Google Apps Script
    // que funciona gratuitamente e SEM necessidade de configurar chave de API!
    if (!key) {
      const directions = Maps.newDirectionFinder()
        .setOrigin(fromLat, fromLng)
        .setDestination(toLat, toLng)
        .setMode(Maps.DirectionFinder.Mode.DRIVING)
        .setLanguage('pt-BR')
        .getDirections();
        
      if (directions.status === 'OK' && directions.routes && directions.routes.length > 0) {
        const route = directions.routes[0];
        const leg = route.legs[0];
        return {
          success: true,
          distanceM: leg.distance.value,
          durationS: leg.duration.value,
          distanceText: leg.distance.text,
          durationText: leg.duration.text
        };
      }
      return { success: false, error: 'Serviço de Mapas nativo retornou: ' + (directions.status || 'Sem rotas') };
    }

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${fromLat},${fromLng}&destinations=${toLat},${toLng}&mode=driving&language=pt-BR&key=${key}`;
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(response.getContentText());
    if (data.status === 'OK' && data.rows?.[0]?.elements?.[0]?.status === 'OK') {
      const el = data.rows[0].elements[0];
      return { success: true, distanceM: el.distance.value, durationS: el.duration.value, distanceText: el.distance.text, durationText: el.duration.text };
    }
    return { success: false, error: 'Google Maps retornou: ' + data.status };
  } catch (e) {
    return { success: false, error: 'Erro ao chamar Google Maps: ' + e.message };
  }
}

function getBikeMovement(bikeNumber, limit) {
  if (!bikeNumber) return { success: false, error: 'Patrimônio não informado.' };
  // limit: 5, 10, 15 = últimos N registros | 0 = TODOS os registros históricos
  limit = parseInt(limit);
  if (isNaN(limit)) limit = 5;
  if (limit !== 0 && ![5, 10, 15].includes(limit)) limit = 5;

  const cache = CacheService.getScriptCache();
  // Só usa cache para consultas limitadas — "todos" sempre busca fresco
  const cacheKey = 'bike_movement_' + String(bikeNumber).trim() + '_' + limit;
  if (limit !== 0) {
    const cached = cache.get(cacheKey);
    if (cached) { try { return { success: true, data: JSON.parse(cached), cached: true }; } catch(e) {} }
  }
  try {
    const ss = getSpreadsheet();
    const bikeStr = String(bikeNumber).trim().replace(/^0+/, '');
    const records = [];
    const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    if (reportSheet && reportSheet.getLastRow() > 1) {
      const lastRow = reportSheet.getLastRow();
      // limit=0 → lê TODAS as linhas; caso contrário lê as últimas 5000
      const rowsToRead = limit === 0 ? lastRow - 1 : Math.min(lastRow - 1, 5000);
      const startRow = lastRow - rowsToRead + 1;
      const data = reportSheet.getRange(startRow, 1, rowsToRead, 9).getValues();
      for (let i = data.length - 1; i >= 0; i--) {
        const row = data[i];
        const pat = String(row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
        if (pat !== bikeStr) continue;
        const ts = row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1];
        const tsDate = ts instanceof Date ? ts : parseTimestamp(ts);
        if (!tsDate) continue;
        records.push({
          tsDate, timestamp: tsDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          status: (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim(),
          observacao: (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim(),
          motorista: (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim(),
          bateria: (row[COLUMN_INDICES.REPORTS.BATERIA - 1] || '').toString().trim(),
          trava: (row[COLUMN_INDICES.REPORTS.TRAVA - 1] || '').toString().trim(),
          localidade: (row[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim(),
          origem: 'relatorio'
        });
      }
    }
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
        const entDate = dataEnt instanceof Date ? dataEnt : parseTimestamp(dataEnt);
        if (entDate && status !== 'Remanejada') {
          records.push({ tsDate: entDate, timestamp: entDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }), status, observacao: tratativa && tratativa !== 'MANUAL' ? tratativa : '', motorista: mecanico, bateria: '', trava: '', localidade: '', origem: 'mecanica' });
        }
        const finDate = dataFin instanceof Date ? dataFin : parseTimestamp(dataFin);
        if (finDate && (status === 'Reserva' || status === 'Remanejada')) {
          records.push({ tsDate: finDate, timestamp: finDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }), status: status === 'Reserva' ? 'Reparo Finalizado → Reserva' : 'Remanejada', observacao: tratativa && tratativa !== 'MANUAL' ? `Tratativa: ${tratativa}` : '', motorista: mecanico, bateria: '', trava: '', localidade: '', origem: 'mecanica' });
        }
      });
    }
    records.sort((a, b) => b.tsDate - a.tsDate);
    // limit=0 → retorna tudo; caso contrário fatia no limite
    const limited = (limit === 0 ? records : records.slice(0, limit))
      .map(r => { const { tsDate, ...rest } = r; return rest; });
    if (limit !== 0) {
      try { cache.put(cacheKey, JSON.stringify(limited), 60); } catch(e) {}
    }
    return { success: true, data: limited, total: records.length };
  } catch (e) {
    return { success: false, error: 'Erro ao buscar movimentação: ' + e.message };
  }
}

function getMechanicsList() {
  const cache = CacheService.getScriptCache();
  const mechCacheKey = 'mechanics_list_v1';
  const mechCached = cache.get(mechCacheKey);
  if (mechCached) {
    try {
      const parsed = JSON.parse(mechCached);
      // Aplica filtro isSystemMaintenance mesmo no cache hit
      // (o status na aba Bicicletas pode ter mudado desde que o cache foi gravado)
      const bikeIdx = getBikeIndex();
      parsed.forEach((entry) => {
        if (entry.status !== 'Alterar Status') return;
        const row = bikeIdx[entry.patrimonio] || bikeIdx[String(parseFloat(entry.patrimonio))];
        if (!row) return;
        const st = String(row[COLUMN_INDICES.BIKES.STATUS - 1] || '').trim().toLowerCase();
        if (/manuten|oficina|reparo|aguardando/.test(st)) {
          entry.status = 'Aguardando Manutenção';
        }
      });
      return { success: true, data: parsed, cached: true };
    } catch(e) {}
  }
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(MECHANICS_SHEET_NAME);
      sheet.appendRow(['Patrimônio','Status','Data Entrada','Mecânico','Tratativa','Data Finalização','Carretinha']);
    } catch (e) {}
  }
  const bikeInfoMap = {};
  try {
    const index = getBikeIndex();
    Object.entries(index).forEach(([pat, row]) => {
      let bateria = row[COLUMN_INDICES.BIKES.BATERIA - 1];
      if (typeof bateria === 'number' && bateria <= 1 && bateria > 0) bateria = Math.round(bateria * 100);
      else if (typeof bateria === 'string' && bateria.includes('%')) bateria = parseInt(bateria.replace('%', ''));
      const carregamentoRaw = (row[COLUMN_INDICES.BIKES.CARREGAMENTO - 1] || '').toString().trim();
      const carregamento = carregamentoRaw.toLowerCase() === 'carregando' ? 'Carregando' : (carregamentoRaw ? 'Não carregando' : '');
      const statusBicicletas = (row[COLUMN_INDICES.BIKES.STATUS - 1] || '').toString().trim().toLowerCase();
      // v85.34: Normalizar status para facilitar checagens - Incluindo variantes e garantindo remoção de acentos se necessário
      const isSystemMaintenance = /manuten|oficina|reparo|aguardando|recolhida|filial/.test(statusBicicletas);
      const isSystemExit = /estação|estacao|ativa|lançada|estoque/.test(statusBicicletas);
      const info = { bateria, carregamento, statusBicicletas, isSystemMaintenance, isSystemExit };
      bikeInfoMap[pat] = info;
      const patSemZeros = pat.replace(/^0+/, '');
      if (patSemZeros !== pat) bikeInfoMap[patSemZeros] = info;
    });
  } catch(e) { console.error('getMechanicsList - erro ao ler bikes:', e); }

  let reportEntries = {};
  let lastExitByBike = {};
  const reportCacheKey = 'mechanics_report_scan_v10';
  const reportCached = cache.get(reportCacheKey);
  if (reportCached) {
    try {
      const parsed = JSON.parse(reportCached);
      reportEntries = parsed.reportEntries || {};
      lastExitByBike = parsed.lastExitByBike || {};
    } catch (e) { }
  }

  if (!reportCached) {
    const EXIT_STATUSES = ['estação', 'estacao', 'não encontrada', 'nao encontrada', 'não atendida', 'nao atendida', 'inicio_turno', 'fim_turno', 'remanejada', 'recuperada', 'encontrada', 'localizada', 'ativa', 'lançada', 'estoque', '[carretinha]', 'carretinha'];

    // Pré-carrega exit times da aba Mecânica (Remanejada + Data Finalização)
    // Isso permite que o Limpar Lista funcione sem gravar no Relatório
    const mechExitTimes = {};
    try {
      if (sheet) {
        const mechAllRows = sheet.getDataRange().getValues();
        for (let mi = mechAllRows.length - 1; mi >= 1; mi--) {
          const mPat = String(mechAllRows[mi][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
          const mSt  = String(mechAllRows[mi][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim().toLowerCase();
          const mFin = toMs(mechAllRows[mi][COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1]);
          const mEnt = toMs(mechAllRows[mi][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
          const mTs  = Math.max(mFin || 0, mEnt || 0);
          if (mPat && mSt === 'remanejada' && mTs > 0) {
            if (!mechExitTimes[mPat] || mTs > mechExitTimes[mPat]) {
              mechExitTimes[mPat] = mTs;
            }
          }
        }
      }
    } catch(e) {}

    try {
      const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME) || ss.getSheetByName('Relatorio') || ss.getSheetByName('Relatório');
      if (reportSheet && reportSheet.getLastRow() > 1) {
        const lastRow = reportSheet.getLastRow();
        const rowsToRead = Math.min(lastRow - 1, 1000);
        const reportData = reportSheet.getRange(lastRow - rowsToRead + 1, 1, rowsToRead, 10).getValues();
        reportData.forEach((row, idx) => {
          const rawTs = row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1];
          const tsMsBase = toMs(rawTs);
          if (!tsMsBase || tsMsBase < CUTOFF_MS) return;
          // Adiciona micro-offset baseado no índice da linha para preservar ordem cronológica no mesmo segundo
          const tsMs = tsMsBase + (idx / 1000000);
          const pat = String(row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
          if (!pat) return;
          const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
          if (!status) return;
          const observacao = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
          const motorista  = (row[COLUMN_INDICES.REPORTS.MOTORISTA  - 1] || '').toString().trim();

          const isExit = EXIT_STATUSES.some(s => status.includes(s));
          if (isExit) {
            if (!lastExitByBike[pat] || tsMs >= lastExitByBike[pat].tsMs) {
              lastExitByBike[pat] = { tsMs, status };
            }
          }

          const isInitial = (/recolhida|vandalizad|filial|recolher|vandalismo/.test(status) || /manuten[çc]ão/.test(status) || /oficina/.test(status)) && !status.includes('ação mecânica') && !status.includes('remanejada');
          if (isInitial) {
            if (!reportEntries[pat] || tsMs >= reportEntries[pat].tsMs) {
              const prev = reportEntries[pat] || {};
              reportEntries[pat] = { tsMs, status, motorista: motorista || prev.motorista || '', observacao: observacao || prev.observacao || '' };
            }
          }
        });
      }
      
      try {
        const reqSheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
        if (reqSheet && reqSheet.getLastRow() > 1) {
           const lastRowReq = reqSheet.getLastRow();
           const rowsReq = Math.min(lastRowReq - 1, 500);
           const reqData = reqSheet.getRange(lastRowReq - rowsReq + 1, 1, rowsReq, 8).getValues();
           reqData.forEach((row, idx) => {
             const tsMsBase = toMs(row[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1]);
             if (!tsMsBase || tsMsBase < CUTOFF_MS) return;
             // Adiciona micro-offset também nas solicitações para evitar empate com reportes do mesmo segundo
             const tsMs = tsMsBase + (idx / 1000000); 
             const pIdStr = String(row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '').trim();
             const status = (row[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1] || '').toString().toLowerCase();
             
             const pats = pIdStr.split(',').map(s => s.trim().replace(/^0+/, ''));
             pats.forEach(pat => {
               if (!pat) return;
               if (status.includes('carretinha')) {
                  if (!lastExitByBike[pat] || tsMs >= lastExitByBike[pat].tsMs) {
                     lastExitByBike[pat] = { tsMs, status: 'carretinha' };
                  }
               }
             });
           });
        }
      } catch(e) {}

      Object.keys(reportEntries).forEach(pat => {
        const exit = lastExitByBike[pat];
        const info = bikeInfoMap[pat] || {};
        // v85.42: Uso de >= garante que handled_at_the_same_second_as_report também limpe
        // Verifica também na aba Mecânica: Remanejada com Data Finalização > reportEntry
        const mechExit = mechExitTimes[pat] || 0;
        const isExitStatus = (exit && exit.tsMs >= reportEntries[pat].tsMs)
          || (mechExit >= reportEntries[pat].tsMs)  // Limpar Lista sem sujar o Relatório
          || info.isSystemExit;
        if (isExitStatus) delete reportEntries[pat];
      });
      cache.put(reportCacheKey, JSON.stringify({ reportEntries, lastExitByBike }), 5);
    } catch (e) { console.error('getMechanicsList - erro ao ler relatório:', e); }
  }
    const mechanicsStatus = {};
    if (sheet) {
      const mechValues = sheet.getDataRange().getValues();
      for (let i = mechValues.length - 1; i >= 1; i--) {
        const row = mechValues[i];
        const pat = String(row[COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
        if (!pat) continue;
        const status = (row[COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
        const tratativa = (row[COLUMN_INDICES.MECHANICS.TRATATIVA - 1] || '').toString().trim();
        const tsEntRaw = row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1];
        const tsFinRaw = row[COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1];
        const tsEnt = toMs(tsEntRaw);
        const tsFin = toMs(tsFinRaw);
        
        // v85.30: if status is Remanejada and was set today, consider tsMs as latest possible time if no time provided
        let tsMs = Math.max(tsEnt || 0, tsFin || 0) || null;
        if (tsMs && status === 'Remanejada') {
           // Se a data finalização for hoje mas sem hora, consideramos o fim do dia para evitar conflitos com reportes do mesmo dia
           const d = new Date(tsMs);
           if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
             d.setHours(23, 59, 59, 999);
             tsMs = d.getTime();
           }
        }

        if (mechanicsStatus[pat]) continue;

        const exit = lastExitByBike[pat];
        if (exit && exit.tsMs > (tsMs || 0)) continue;

        if (status === 'Remanejada') {
          if (tsMs !== null && tsMs < CUTOFF_MS) continue;
          mechanicsStatus[pat] = { row: i + 1, status, tsMs: tsMs || 0, dataEntrada: tsEntRaw, mecanico: row[COLUMN_INDICES.MECHANICS.MECANICO - 1], tratativa, dataFinalizacao: tsFinRaw, carretinha: row[COLUMN_INDICES.MECHANICS.CARRETINHA - 1], manual: false };
          continue;
        }
        const isActiveStatus = (status === 'Aguardando Manutenção' || status === 'Em Manutenção' || status === 'Reserva' || status === 'Aguardando Técnica' || status === 'Em Técnica');
        if (!isActiveStatus && tsMs !== null && tsMs < CUTOFF_MS) continue;
        if (tsMs === null && !isActiveStatus) continue;
        mechanicsStatus[pat] = { row: i + 1, status, tsMs: tsMs || 0, dataEntrada: tsEntRaw, mecanico: row[COLUMN_INDICES.MECHANICS.MECANICO - 1], tratativa, dataFinalizacao: tsFinRaw, carretinha: row[COLUMN_INDICES.MECHANICS.CARRETINHA - 1], manual: tratativa.toUpperCase() === 'MANUAL' };
      }
    }
  const bikeMap = {};
  const clearedProperties = PropertiesService.getScriptProperties().getProperties();
  const clearTimeMap = {};
  Object.keys(clearedProperties).forEach(key => {
    if (key.indexOf('MECH_CLEAR_') === 0) {
      clearTimeMap[key.substring(11)] = parseInt(clearedProperties[key], 10);
    }
  });

  Object.entries(reportEntries).forEach(([pat, entry]) => {
    // v85.26: Ignora reportes se a bike foi propositalmente limpa da lista após o reporte
    const lastClearTs = clearTimeMap[pat] || 0;
    if (entry.tsMs <= lastClearTs) return;

    const mechData = mechanicsStatus[pat];
    const info = bikeInfoMap[pat] || {};
    const isMechActive = mechData && (mechData.status === 'Aguardando Manutenção' || mechData.status === 'Em Manutenção' || mechData.status === 'Reserva' || mechData.status === 'Aguardando Técnica' || mechData.status === 'Em Técnica');
    const statusLow = entry.status.toLowerCase();
    const isMaintenanceReport = /manuten[çc]ão|oficina/.test(statusLow);
    const isReportInitial = /recolhida|vandalizad|filial|recolher|vandalismo/.test(statusLow);
    
    // v85.32: Reserva tem prioridade — mesmo que haja recolhida mais recente,
    // a bike em Reserva não deve voltar para Alterar Status
    const isMechReserva = mechData && mechData.status === 'Reserva';
    if (mechData && (mechData.tsMs >= entry.tsMs || isMechActive || isMechReserva)) {
      if (mechData.status === 'Remanejada') return;
      let displayStatus = mechData.status;
      // v85.34: Força status de manutenção se detectado no sistema
      if (info.isSystemMaintenance || isMaintenanceReport) {
        if (displayStatus === 'Alterar Status') displayStatus = 'Aguardando Manutenção';
      }
      bikeMap[pat] = { row: mechData.row, patrimonio: pat, status: displayStatus, dataEntrada: mechData.dataEntrada, mecanico: mechData.mecanico, tratativa: mechData.tratativa, dataFinalizacao: mechData.dataFinalizacao, carretinha: mechData.carretinha, bateria: info.bateria, carregamento: info.carregamento, manual: mechData.manual, motorista: entry.motorista || '', observacao: entry.observacao || '' };
    } else {
      let finalStatus = 'Alterar Status';
      // v85.34: Se for um reporte de manutenção ou se o status no sistema já for Manutenção, pula 'Alterar Status'
      if (isMaintenanceReport || info.isSystemMaintenance) {
        finalStatus = 'Aguardando Manutenção';
      }

      bikeMap[pat] = { row: -1, patrimonio: pat, status: finalStatus, dataEntrada: new Date(entry.tsMs), mecanico: '', tratativa: '', dataFinalizacao: '', carretinha: '', bateria: info.bateria, carregamento: info.carregamento, motorista: entry.motorista || '', observacao: entry.observacao || '', manual: false };
    }
  });
  Object.entries(mechanicsStatus).forEach(([pat, mechData]) => {
    if (bikeMap[pat]) return;
    const lastClearTs = clearTimeMap[pat] || 0;
    if (mechData.tsMs <= lastClearTs && mechData.status === 'Alterar Status') return;

    const info = bikeInfoMap[pat] || {};
    let displayStatus = mechData.status;
    if (displayStatus === 'Alterar Status' && info.isSystemMaintenance) {
      displayStatus = 'Aguardando Manutenção';
    }
    bikeMap[pat] = { row: mechData.row, patrimonio: pat, status: displayStatus, dataEntrada: mechData.dataEntrada, mecanico: mechData.mecanico, tratativa: mechData.tratativa, dataFinalizacao: mechData.dataFinalizacao, carretinha: mechData.carretinha, bateria: info.bateria, carregamento: info.carregamento, manual: true };
  });
  // v85.36: Pós-processamento — bikes com status Manutenção na aba Bicicletas
  // mas que ainda aparecem em 'Alterar Status' devem ir para 'Aguardando Manutenção'
  // Também cria entrada para bikes que têm isSystemMaintenance mas não estão no bikeMap
  Object.keys(bikeInfoMap).forEach(pat => {
    const info = bikeInfoMap[pat];
    if (!info.isSystemMaintenance) return;
    if (!bikeMap[pat]) {
      // Bike tem status Manutenção mas não está no bikeMap — adiciona em Aguardando
      const mechData = mechanicsStatus[pat];
      if (mechData && mechData.status !== 'Remanejada') {
        // Já tem entrada na Mecânica — usa ela com status corrigido
        bikeMap[pat] = { row: mechData.row, patrimonio: pat, status: 'Aguardando Manutenção',
          dataEntrada: mechData.dataEntrada, mecanico: mechData.mecanico,
          tratativa: mechData.tratativa, dataFinalizacao: mechData.dataFinalizacao,
          carretinha: mechData.carretinha, bateria: info.bateria,
          carregamento: info.carregamento, manual: mechData.manual };
      }
    } else if (bikeMap[pat].status === 'Alterar Status') {
      bikeMap[pat].status = 'Aguardando Manutenção';
    }
  });

  // Aplica isSystemMaintenance no resultado final — usa bikeInfoMap já construído
  Object.values(bikeMap).forEach(entry => {
    if (entry.status !== 'Alterar Status') return;
    const info = bikeInfoMap[entry.patrimonio] || {};
    if (info.isSystemMaintenance) entry.status = 'Aguardando Manutenção';
  });

  const result = Object.values(bikeMap).filter(b => b.status !== 'Remanejada');
  try { cache.put(mechCacheKey, JSON.stringify(result), 5); } catch(e) {}
  return { success: true, data: result };
}

function notifyAdmins(message, bikes, trailerName) {
  return sendNotification({ recipient: 'ADM', type: 'trailer_finalizado', title: trailerName, message: message, bikes: bikes });
}

function sendNotification(request) {
  const { recipient, type, title, message, bikes } = request;
  try {
    const ss = getSpreadsheet();
    let sheet = ss.getSheetByName(NOTIFICATIONS_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(NOTIFICATIONS_SHEET_NAME);
      sheet.appendRow(['Data', 'Destinatário', 'Tipo', 'Título', 'Mensagem', 'Bikes', 'Status']);
    }
    const bikesStr = Array.isArray(bikes) ? bikes.join(', ') : (bikes || '');
    sheet.appendRow([new Date(), recipient || 'ADM', type || 'alerta', title || '', message || '', bikesStr, 'pendente']);
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
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
    if (rowPat === pStr && rowStatus !== 'Remanejada') {
      if (tsMs && tsMs < CUTOFF_MS) continue;
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue(targetStatus);
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue('MANUAL');
      _clearMechanicsCache();
      return { success: true };
    }
  }
  sheet.appendRow([bikeNumber, targetStatus, new Date(), mechanicName, 'MANUAL', '', '']);
  _clearMechanicsCache();
  return { success: true };
}

function confirmMechanicsReceipt(bikeNumber, mechanicName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
    if (rowPat === pStr && rowStatus === 'Aguardando Manutenção') {
      if (tsMs && tsMs < CUTOFF_MS) continue;
      const row = i + 1;
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Em Manutenção');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
      _clearMechanicsCache();
      return { success: true };
    }
  }
  sheet.appendRow([bikeNumber, 'Em Manutenção', new Date(), mechanicName, '', '', '']);
  _clearMechanicsCache();
  return { success: true };
}

function markAsNotFound(bikeNumber, mechanicName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '') === pStr && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] !== 'Remanejada') {
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Não encontrada');
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
      _clearMechanicsCache();
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
    if (String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '') === oldStr && data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] !== 'Remanejada') {
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.PATRIMONIO).setValue(newPat);
      _clearMechanicsCache();
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
      if (rowStatus === 'Reserva') {
        const row = i + 1;
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Em Manutenção');
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue('');
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
        _clearMechanicsCache();
        return { success: true, movedToMaintenance: true };
      }
      sheet.deleteRow(i + 1);
      _clearMechanicsCache();
      return { success: true };
    }
  }
  return { success: false, error: 'Bicicleta não encontrada para exclusão.' };
}

function sendToTechnical(bikeNumber, mechanicName) {
  if (!bikeNumber) return { success: false, error: 'Patrimônio não informado.' };
  try {
    const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
    const pStr = String(bikeNumber).trim().replace(/^0+/, '');
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      const rowStatus = String(data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
      if (rowPat === pStr && rowStatus !== 'Remanejada') {
        sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Aguardando Técnica');
        sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName || '');
        _clearMechanicsCache();
        return { success: true };
      }
    }
    sheet.appendRow([bikeNumber, 'Aguardando Técnica', new Date(), mechanicName || '', '', '', '']);
    _clearMechanicsCache();
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

function getTechnicaList() {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: true, data: [] };
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
      result.push({ row: idx + 2, patrimonio: pat, status, dataEntrada: row[COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1], mecanico: row[COLUMN_INDICES.MECHANICS.MECANICO - 1], tratativa: row[COLUMN_INDICES.MECHANICS.TRATATIVA - 1], dataFinalizacao: row[COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO - 1], bateria: info.bateria, carregamento: info.carregamento });
    });
    return { success: true, data: result };
  } catch (e) { return { success: false, error: e.message }; }
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
        _clearMechanicsCache();
        return { success: true };
      }
    }
    sheet.appendRow([bikeNumber, 'Em Técnica', new Date(), technicianName || '', '', '', '']);
    _clearMechanicsCache();
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
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
        const mecanicoOriginal = originalMechanic || String(data[i][COLUMN_INDICES.MECHANICS.MECANICO - 1] || '').trim() || '';
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Em Manutenção');
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mecanicoOriginal);
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue('Retorno da Técnica: ' + treatment + (technicianName ? ' [' + technicianName + ']' : ''));
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue('');
        _clearMechanicsCache();
        return { success: true, originalMechanic: mecanicoOriginal };
      }
    }
    return { success: false, error: 'Bike não encontrada em Em Técnica.' };
  } catch (e) { return { success: false, error: e.message }; }
}

function removeFromTrailer(bikeNumber, targetStatus) {
  if (!bikeNumber) return { success: false, error: 'Patrimônio não informado.' };
  try {
    const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
    const pStr = String(bikeNumber).trim().replace(/^0+/, '');
    const data = sheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1] || '').trim().replace(/^0+/, '');
      if (rowPat === pStr) {
        const row = i + 1;
        sheet.getRange(row, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue('');
        if (targetStatus) {
          sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue(targetStatus);
          sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
        }
        _clearMechanicsCache();
        return { success: true, status: targetStatus || (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim(), mecanico: (data[i][COLUMN_INDICES.MECHANICS.MECANICO - 1] || '').toString().trim() };
      }
    }
    return { success: true, warning: 'Bike não encontrada na planilha de Mecânica.' };
  } catch (e) { return { success: false, error: e.message }; }
}

function clearAlterarStatus(bikes) {
  if (!bikes || !Array.isArray(bikes) || bikes.length === 0) return { success: true, cleared: 0 };
  try {
    const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
    const data = sheet.getDataRange().getValues();
    let cleared = 0;
    const now = new Date();
    const clearedProperties = PropertiesService.getScriptProperties().getProperties();
    const clearTimeMap = {};
    Object.keys(clearedProperties).forEach(key => {
      if (key.indexOf('MECH_CLEAR_') === 0) {
        clearTimeMap[key.substring(11)] = parseInt(clearedProperties[key], 10);
      }
    });

    const newClearProps = {};
    bikes.forEach(item => {
      const pat = String(item.patrimonio || '').trim().replace(/^0+/, '');
      if (!pat) return;
      
      newClearProps['MECH_CLEAR_' + pat] = now.getTime().toString();
      
      let handled = false;
      if (item.row && item.row > 1) {
        const rowData = data[item.row - 1];
        if (rowData) {
          const currentStatus = String(rowData[COLUMN_INDICES.MECHANICS.STATUS - 1] || '').trim();
          if (currentStatus !== 'Remanejada') { 
            sheet.getRange(item.row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Remanejada'); 
            sheet.getRange(item.row, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue(now); 
            cleared++; 
          }
          handled = true;
        }
      }
      
      if (!handled) {
        sheet.appendRow([item.patrimonio, 'Remanejada', now, 'SISTEMA', 'LIMPAR_LISTA', now, '']);
        cleared++;
      }

      // Relatório NÃO é alimentado pelo Limpar Lista
    });

    if (Object.keys(newClearProps).length > 0) {
      PropertiesService.getScriptProperties().setProperties(newClearProps);
    }
    _clearMechanicsCache();
    return { success: true, cleared };
  } catch (e) { return { success: false, error: 'Erro ao limpar lista: ' + e.message }; }
}

function finalizeMechanicsRepair(bikeNumber, mechanicName, treatment) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const pStr = String(bikeNumber).trim().replace(/^0+/, '');
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
    const isActiveStatus = (rowStatus === 'Aguardando Manutenção' || rowStatus === 'Em Manutenção' || rowStatus === 'Aguardando Técnica' || rowStatus === 'Em Técnica');
    if (rowPat === pStr && (rowStatus === 'Em Manutenção' || isActiveStatus)) {
      if (tsMs && tsMs < CUTOFF_MS) continue;
      const row = i + 1;
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Reserva');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue(treatment);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_ENTRADA).setValue(new Date());
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue(new Date());
      _clearMechanicsCache();
      return { success: true };
    }
  }
  return { success: false, error: 'Bicicleta não encontrada ou não está em um status ativo na mecânica.' };
}

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
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.STATUS).setValue('Vandalizada');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.MECANICO).setValue(mechanicName);
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.TRATATIVA).setValue('VANDALIZADA');
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue(new Date());
      sheet.getRange(row, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue(room);
      found = true;
      _clearMechanicsCache();
      break;
    }
  }
  if (!found) return { success: false, error: 'Bicicleta não encontrada na planilha mecânica.' };
  return { success: true };
}

function organizeTrailer(bikeNumbers, trailerName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  const bikes = (Array.isArray(bikeNumbers) ? bikeNumbers : [bikeNumbers]).map(b => String(b).trim().replace(/^0+/, ''));
  let count = 0;
  const processedBikes = new Set();
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
    if (bikes.includes(rowPat) && rowStatus === 'Reserva' && !processedBikes.has(rowPat)) {
      if (tsMs && tsMs < CUTOFF_MS) continue;
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.CARRETINHA).setValue(trailerName);
      processedBikes.add(rowPat);
      count++;
    }
  }
  _clearMechanicsCache();
  return { success: true, message: `${count} bikes organizadas na carretinha ${trailerName}.` };
}

function finalizeTrailer(trailerName) {
  const sheet = getSpreadsheet().getSheetByName(MECHANICS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Planilha Mecânica não encontrada.' };
  const data = sheet.getDataRange().getValues();
  let count = 0;
  const processedBikes = new Set();
  for (let i = data.length - 1; i >= 1; i--) {
    const rowPat = String(data[i][COLUMN_INDICES.MECHANICS.PATRIMONIO - 1]).trim().replace(/^0+/, '');
    const rowStatus = (data[i][COLUMN_INDICES.MECHANICS.STATUS - 1] || '').toString().trim();
    const rowTrailer = String(data[i][COLUMN_INDICES.MECHANICS.CARRETINHA - 1] || '').trim();
    const tsMs = toMs(data[i][COLUMN_INDICES.MECHANICS.DATA_ENTRADA - 1]);
        if (rowTrailer === String(trailerName) && rowStatus === 'Reserva' && !processedBikes.has(rowPat)) {
      if (tsMs && tsMs < CUTOFF_MS) continue;
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.STATUS).setValue('Remanejada');
      sheet.getRange(i + 1, COLUMN_INDICES.MECHANICS.DATA_FINALIZACAO).setValue(new Date());
      processedBikes.add(rowPat);
      count++;
      
      // v85.24: Loga no relatório para suspender reporte de manutenção
      try {
        const rowDataLog = new Array(10).fill('');
        rowDataLog[COLUMN_INDICES.REPORTS.TIMESTAMP - 1] = new Date();
        rowDataLog[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] = rowPat;
        rowDataLog[COLUMN_INDICES.REPORTS.STATUS - 1] = 'Remanejada (Carretinha)';
        rowDataLog[COLUMN_INDICES.REPORTS.MOTORISTA - 1] = 'SISTEMA'; // v85.32: finalizedBy removida (não declarada)
        logReport(rowDataLog);
      } catch(e) {}
    }
  }
  _clearMechanicsCache();
  return { success: true, message: `${count} bikes finalizadas da carretinha ${trailerName}.` };
}

// =================================================================
// --- getSheetsReportsToday ---
// =================================================================
function getSheetsReportsToday(payload) {
  try {
    const catNorm = normalizeCategory(payload.category || '');
    if (!catNorm.includes('ADM')) return { success: false, error: 'Acesso negado.' };
    const reportSheet = getSpreadsheet().getSheetByName(REPORT_SHEET_NAME);
    if (!reportSheet) return { success: false, error: 'Aba Relatorio nao encontrada.' };
    const lastRow = reportSheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };
    const rowsToRead = Math.min(lastRow - 1, 300);
    const startRow = lastRow - rowsToRead + 1;
    const data = reportSheet.getRange(startRow, 1, rowsToRead, 10).getValues();
    const targetDate = payload.date ? new Date(payload.date) : new Date();
    targetDate.setHours(0, 0, 0, 0);
    const targetMs = targetDate.getTime();
    const nextDayMs = targetMs + 86400000;
    const ALLOWED_STATUSES = ['recolhida', 'filial', 'vandalizada', 'estacao', 'nao encontrada'];
    const results = [];
    data.forEach(function(row) {
      var ts = parseTimestamp(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      if (!ts) return;
      var tsMs = ts.getTime();
      if (tsMs < targetMs || tsMs >= nextDayMs) return;
      var status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      var isAllowed = ALLOWED_STATUSES.some(function(s) { return status.includes(s); });
      if (!isAllowed) return;
      results.push({
        timestamp:     ts.toISOString(),
        patrimonio:    (row[COLUMN_INDICES.REPORTS.PATRIMONIO    - 1] || '').toString().trim(),
        status:        (row[COLUMN_INDICES.REPORTS.STATUS        - 1] || '').toString(),
        observacao:    (row[COLUMN_INDICES.REPORTS.OBSERVACAO    - 1] || '').toString(),
        motorista:     (row[COLUMN_INDICES.REPORTS.MOTORISTA     - 1] || '').toString().trim().toUpperCase(),
        statusSistema: (row[COLUMN_INDICES.REPORTS.STATUS_SISTEMA- 1] || '').toString(),
        bateria:       (row[COLUMN_INDICES.REPORTS.BATERIA       - 1] || '').toString(),
        trava:         (row[COLUMN_INDICES.REPORTS.TRAVA         - 1] || '').toString(),
        localidade:    (row[COLUMN_INDICES.REPORTS.LOCALIDADE    - 1] || '').toString(),
      });
    });
    return { success: true, data: results };
  } catch (e) {
    return { success: false, error: 'Erro em getSheetsReportsToday: ' + e.message };
  }
}

/**
 * Helpler para limpar caches relacionados à mecânica e dashboards
 */
function _clearMechanicsCache() {
  const cache = CacheService.getScriptCache();
  cache.remove('mechanics_list_v1');
  cache.remove('mechanics_report_scan_v8');  // legado
  cache.remove('mechanics_report_scan_v9');  // legado
  cache.remove('mechanics_report_scan_v10'); // atual
  cache.remove('change_status_data_24h');
  cache.remove('change_status_data_48h');
  cache.remove('change_status_data_72h');
  cache.remove('change_status_data_week');
}

/**
 * Retorna o próximo número de carretinha (1-4) de forma sequencial persistente.
 */
function getNextTrailerNumber() {
  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    const lastDate = props.getProperty('LAST_TRAILER_DATE');
    
    let lastNum;
    if (lastDate !== today) {
      lastNum = 0; // Reset for new day
      props.setProperty('LAST_TRAILER_DATE', today);
    } else {
      lastNum = parseInt(props.getProperty('LAST_TRAILER_NUM') || '0', 10);
    }
    
    let nextNum = (lastNum % 4) + 1;
    props.setProperty('LAST_TRAILER_NUM', nextNum.toString());
    return { success: true, next: nextNum };
  } catch (e) {
    return { success: false, error: 'Erro ao gerar número de carretinha: ' + e.message, next: 1 };
  }
}