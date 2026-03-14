// =================================================================
// SCRIPT DE BACKEND PARA APLICATIVO DE REGISTRO DE BICICLETAS (v59 - Alertas e Vandalismo)
// =================================================================
// IMPORTANTE: Após salvar este código, você DEVE fazer uma NOVA IMPLANTAÇÃO 
// (Implantar -> Nova Implantação -> Tipo: App da Web -> Acesso: Qualquer pessoa)
// para que as novas funções (getAlerts, getVandalized, etc) fiquem disponíveis.
// =================================================================

// --- CONFIGURAÇÃO GLOBAL ---
const SPREADSHEET_ID = '14U5Y6ZU5oeNr5B7hYLMhqvGgU68K4seeILUgTK335kQ';
const ACCESS_SHEET_NAME = 'Acesso'; 
const BIKES_SHEET_NAME = 'Bicicletas';
const STATIONS_SHEET_NAME = 'Estacao';
const REQUESTS_SHEET_NAME = 'Solicitacao';
const REPORT_SHEET_NAME = 'Relatorio';
const STATE_SHEET_NAME = 'Dados';
const REPOR_SHEET_NAME = 'Repor';
const ALERTS_SHEET_NAME = 'Alertas';
const VANDALIZED_SHEET_NAME = 'Vandalizadas';
const OCORRENCIA_SHEET_NAME = 'Ocorrencia';
const VANDALISMO_SHEET_NAME = 'Vandalismo';
const DIVERGENCE_SHEET_NAME = 'Divergencia';
const NOTIFICATIONS_SHEET_NAME = 'Notificacoes';
const DAILY_SUMMARY_SHEET_NAME = 'ResumoDiario';

// --- MAPA DE COLUNAS FIXAS (BASEADO NAS IMAGENS E DIRETRIZES) ---
// As colunas são 1-based (A=1, B=2, etc.) para uso com `getRange`.
const COLUMN_INDICES = {
  BIKES: {
    CRIADO_EM: 1, PATRIMONIO: 2, STATUS: 3, LOCALIDADE: 4, USUARIO: 5, BATERIA: 6,
    TRAVA: 7, CARREGAMENTO: 8, ULTIMA_INFO: 9, LATITUDE: 10, LONGITUDE: 11
  },
  ACCESS: {
    USUARIO: 1, LOGIN: 2, SENHA: 3, CATEGORIA: 4, STATUS_ONLINE: 5, GPS: 6, PLACA: 8, KM_INICIAL: 9, KM_FINAL: 10, KM_DIFERENCA: 11
  },
  REPORTS: {
    TIMESTAMP: 1, PATRIMONIO: 2, STATUS: 3, OBSERVACAO: 4, MOTORISTA: 5,
    STATUS_SISTEMA: 6, BATERIA: 7, TRAVA: 8, LOCALIDADE: 9
  },
  STATE: { // Aba 'Dados'
    MOTORISTA: 1, ROTEIRO: 3, RECOLHIDAS: 4
  },
  DIVERGENCE: {
    TIMESTAMP: 1, MOTORISTA: 2, PATRIMONIO: 3, MENSAGEM: 4
  },
  NOTIFICATIONS: {
    USUARIO: 1, JSON: 2
  },
  DAILY_SUMMARY: {
    DATA: 1, MOTORISTA: 2, PLACA: 3, KM_TOTAL: 4, BATERIA: 5, MANUT_BIKE: 6, MANUT_LOCKER: 7, REMANEJADAS: 8, OCORRENCIAS: 9, NAO_ENCONTRADAS: 10, VANDALIZADAS: 11, INICIO: 12, FIM: 13, OBS: 14
  },
  STATIONS: {
    ID: 1, NUMB: 2, NAME: 3, ADDRESS: 4, REFERENCE: 5, LATITUDE: 6, LONGITUDE: 7, AREA: 8
  },
  ALERTS: {
    PATRIMONIO: 1, CHECK1: 2, CHECK2: 3, CHECK3: 4, SITUACAO: 5, ENCONTRADA_POR: 6, DATA_ENCONTRADA: 7
  },
  VANDALIZED: {
    PATRIMONIO: 1, DATA: 2, DEFEITO: 3, LOCAL: 4, SITUACAO: 5, ENCONTRADA_POR: 6, DATA_ENCONTRADA: 7
  },
  REQUESTS: {
    TIMESTAMP: 1, PATRIMONIO: 2, OCORRENCIA: 3, LOCAL: 4,
    ACEITA_POR: 5, ACEITA_DATA: 6, SITUACAO: 7, DESTINATARIO: 8,
    RECUSADA_POR: 9
  },
};

const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

/**
 * Ponto de entrada para requisições GET.
 * Usado para um "health check" ultra-simplificado para garantir que a API está acessível.
 * Retorna uma resposta JSON com cabeçalhos CORS explícitos.
 */
function inspectBikesSheet() {
  const sheet = ss.getSheetByName(BIKES_SHEET_NAME);
  if (!sheet) return { error: 'Sheet not found' };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = sheet.getRange(2, 1, 5, sheet.getLastColumn()).getValues();
  return { success: true, headers: headers, data: data };
}

function inspectStateSheet() {
  const sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet) return { error: 'Sheet not found' };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return { success: true, headers: headers };
}

function doGet(e) {
  const action = e.parameter.action;
  
  if (action === 'inspectState') {
    return ContentService
      .createTextOutput(JSON.stringify(inspectStateSheet()))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Se houver uma ação, tenta processá-la (útil para chamadas GET de plataformas como Netlify)
  if (action) {
    let response = { success: false, error: 'Ação não suportada via GET.', version: BACKEND_VERSION };
    
    if (action === 'getDriverLocations') {
      response = { ...getDriverLocations(), version: BACKEND_VERSION };
    } else if (action === 'health') {
      response = { success: true, status: 'ok', version: BACKEND_VERSION };
    } else if (action === 'getStations') {
      response = { ...getStations(), version: BACKEND_VERSION };
    } else if (action === 'getMotoristas') {
      response = { ...getMotoristas(), version: BACKEND_VERSION };
    } else if (action === 'getAlerts') {
      response = { ...getAlerts(), version: BACKEND_VERSION };
    } else if (action === 'getVandalized') {
      response = { ...getVandalized(), version: BACKEND_VERSION };
    } else if (action === 'getReporData') {
      response = { ...getReporData(), version: BACKEND_VERSION };
    } else if (action === 'getChangeStatusData') {
      response = { ...getChangeStatusData(e.parameter.timeRange), version: BACKEND_VERSION };
    } else if (action === 'updateLocation') {
      response = { ...updateLocation(e.parameter.driverName, e.parameter.latitude, e.parameter.longitude), version: BACKEND_VERSION };
    } else if (action === 'getVehiclePlates') {
      response = { ...getVehiclePlates(), version: BACKEND_VERSION };
    } else if (action === 'switchVehicle') {
      response = { ...switchVehicle(e.parameter.driverName, e.parameter.plate, e.parameter.kmInicial), version: BACKEND_VERSION };
    }
    
    return ContentService
      .createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const response = { 
    status: "ok", 
    version: BACKEND_VERSION,
    supportedActions: [
      'getDriversSummary', 'login', 'logout', 'search', 'getRequests', 
      'createRequest', 'acceptRequest', 'declineRequest', 'getStations', 
      'getMotoristas', 'logReport', 'updateBikeAssignment', 'getAllPatrimonioNumbers',
      'clearDriverRoute', 'updateLocation', 'getDriverLocations', 'getDriverState',
      'updateDriverState', 'getBikeDetailsBatch', 'getDailyReportData', 'getSchedule',
      'getBikeStatuses', 'getReporData', 'getAlerts', 'confirmBikeFound', 
      'getVandalized', 'confirmVandalizedFound', 'getRouteDetails', 'getVehiclePlates', 'switchVehicle'
    ]
  };
  
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}


const BACKEND_VERSION = "76.0-vehicle-control";

/**
 * Formata uma data para o padrão brasileiro (DD/MM/AAAA HH:mm:ss).
 */
function formatDateTime(date) {
  if (!date) return "";
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

// --- ROTEADOR PRINCIPAL DE REQUISIÇÕES ---
function doPost(e) {
  let response = { success: false, error: 'Ação não processada.', version: BACKEND_VERSION };
  let request;
  try {
    request = JSON.parse(e.postData.contents);
    const action = (request.action || '').toString().trim();
    
    switch (action) {
      case 'getDriversSummary': response = { ...getDriversSummary(request.timeRange), version: BACKEND_VERSION }; break;
      case 'getVehiclePlates': response = { ...getVehiclePlates(), version: BACKEND_VERSION }; break;
      case 'login': response = { ...handleLogin(request.login, request.password, request.plate, request.kmInicial), version: BACKEND_VERSION }; break;
      case 'logout': response = { ...handleLogout(request.userName), version: BACKEND_VERSION }; break;
      case 'search': response = { ...searchBike(request.bikeNumber), version: BACKEND_VERSION }; break;
      case 'getRequests': response = { ...getRequests(request.driverName, request.category), version: BACKEND_VERSION }; break;
      case 'getRequestsHistory': response = { ...getRequestsHistory(request.driverName, request.category), version: BACKEND_VERSION }; break;
      case 'createRequest': response = { ...createRequest(request.patrimonio, request.ocorrencia, request.local, request.recipient), version: BACKEND_VERSION }; break;
      case 'acceptRequest': response = { ...acceptRequest(request.requestId, request.driverName), version: BACKEND_VERSION }; break;
      case 'declineRequest': response = { ...declineRequest(request.requestId, request.driverName), version: BACKEND_VERSION }; break;
      case 'getStations': response = { ...getStations(), version: BACKEND_VERSION }; break;
      case 'getMotoristas': response = { ...getMotoristas(), version: BACKEND_VERSION }; break;
      case 'logReport': response = { ...logReport(request.rowData, request.kmFinal, request.plate), version: BACKEND_VERSION }; break;
      case 'updateBikeAssignment': response = { ...updateBikeAssignment(request.bikeNumber, request.driverName), version: BACKEND_VERSION }; break;
      case 'getAllPatrimonioNumbers': response = { ...getAllPatrimonioNumbers(), version: BACKEND_VERSION }; break;
      case 'clearDriverRoute': response = { ...clearDriverRoute(request.driverName), version: BACKEND_VERSION }; break;
      case 'updateLocation': response = { ...updateLocation(request.driverName, request.latitude, request.longitude), version: BACKEND_VERSION }; break;
      case 'getDriverLocations': response = { ...getDriverLocations(), version: BACKEND_VERSION }; break;
      case 'getDriverState': response = { ...getDriverState(request.driverName), version: BACKEND_VERSION }; break;
      case 'updateDriverState': response = { ...updateDriverState(request.driverName, request.routeBikes, request.collectedBikes), version: BACKEND_VERSION }; break;
      case 'getBikeDetailsBatch': response = { ...getBikeDetailsBatch(request.bikeNumbers), version: BACKEND_VERSION }; break;
      case 'getDailyReportData': response = { ...getDailyReportData(request.driverName, request.timeRange), version: BACKEND_VERSION }; break;
      case 'finalizeCollectedBike': response = { ...finalizeCollectedBike(request), version: BACKEND_VERSION }; break;
      case 'finalizeRouteBike': response = { ...finalizeRouteBike(request), version: BACKEND_VERSION }; break;
      case 'getSchedule': response = { ...getSchedule(request.driverName), version: BACKEND_VERSION }; break;
      case 'getBikeStatuses': response = { ...getBikeStatuses(), version: BACKEND_VERSION }; break;
      case 'getReporData': response = { ...getReporData(), version: BACKEND_VERSION }; break;
      case 'getChangeStatusData': response = { ...getChangeStatusData(request.timeRange), version: BACKEND_VERSION }; break;
      case 'getAlerts': response = { ...getAlerts(), version: BACKEND_VERSION }; break;
      case 'confirmBikeFound': response = { ...confirmBikeFound(request.alertId, request.driverName), version: BACKEND_VERSION }; break;
      case 'getVandalized': response = { ...getVandalized(), version: BACKEND_VERSION }; break;
      case 'confirmVandalizedFound': response = { ...confirmVandalizedFound(request.alertId, request.driverName), version: BACKEND_VERSION }; break;
      case 'getRouteDetails': response = { ...getRouteDetails(request.driverName, request.bikeNumbers), version: BACKEND_VERSION }; break;
      case 'switchVehicle': response = { ...switchVehicle(request.driverName, request.plate, request.kmInicial), version: BACKEND_VERSION }; break;
      case 'sync': response = { ...handleSync(request), version: BACKEND_VERSION }; break;
      case 'saveDailySummary': response = { ...saveDailySummary(request.summaryData), version: BACKEND_VERSION }; break;
      case 'getAdminAlerts': response = { ...getAdminAlerts(request.adminName), version: BACKEND_VERSION }; break;
      case 'clearAdminAlerts': response = { ...clearAdminAlerts(request.adminName), version: BACKEND_VERSION }; break;
      default: response = { success: false, error: 'Ação desconhecida: ' + action, version: BACKEND_VERSION }; break;
    }
  } catch (error) {
    Logger.log('ERRO FATAL no doPost. Payload: ' + (e.postData ? e.postData.contents : 'N/A') + '. Erro: ' + error.message + ' Stack: ' + error.stack);
    response = { success: false, error: 'Erro crítico no servidor: ' + error.message, version: BACKEND_VERSION };
  }
  
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}


// --- LÓGICA DE SINCRONIZAÇÃO UNIFICADA ---

/**
 * Consolida múltiplas consultas em uma única chamada para reduzir a concorrência no Google Apps Script.
 * Isso ajuda a evitar o erro "Too many simultaneous invocations".
 */
function handleSync(request) {
  const { driverName, category, summaryTimeRange, statusTimeRange } = request;
  const isAdm = category && category.toUpperCase().includes('ADM');
  
  const response = { success: true, data: {} };
  
  try {
    // OTIMIZAÇÃO: Abre as abas principais uma única vez
    const sheets = {
      requests: ss.getSheetByName(REQUESTS_SHEET_NAME),
      state: ss.getSheetByName(STATE_SHEET_NAME),
      report: ss.getSheetByName(REPORT_SHEET_NAME),
      access: ss.getSheetByName(ACCESS_SHEET_NAME),
      bikes: ss.getSheetByName(BIKES_SHEET_NAME),
      stations: ss.getSheetByName(STATIONS_SHEET_NAME)
    };
    
    // 1. Requests (Solicitações Pendentes)
    response.data.requests = getRequests(driverName, category, sheets.requests).data || [];
    
    // 2. Driver State (Roteiro e Posse)
    const driverStateResult = getDriverState(driverName, sheets.state);
    response.data.driverState = driverStateResult.data || { routeBikes: [], collectedBikes: [] };
    
    // 3. Bike Statuses (Conflitos e Status Críticos)
    response.data.bikeStatuses = getBikeStatuses(sheets.state, sheets.report).data || {};
    
    // 4. Schedule (Escala)
    response.data.schedule = getSchedule(driverName).data || {};
    
    // 5 & 6. Motoristas e Localizações (Ambos usam ACCESS sheet)
    const accessData = sheets.access ? sheets.access.getDataRange().getValues() : [];
    response.data.motoristas = getMotoristas(accessData).data || [];
    response.data.driverLocations = getDriverLocations(accessData).data || [];
    
    // 11. Route and Collected Details
    const routeBikes = response.data.driverState.routeBikes || [];
    const collectedBikes = response.data.driverState.collectedBikes || [];
    const allBikes = [...new Set([...routeBikes, ...collectedBikes])];
    
    if (allBikes.length > 0) {
      response.data.bikeDetails = getRouteDetails(driverName, allBikes, sheets.bikes, sheets.requests).data || {};
    } else {
      response.data.bikeDetails = {};
    }
    
    if (isAdm) {
      // 7. Drivers Summary
      response.data.driversSummary = getDriversSummary(summaryTimeRange, sheets).data || [];
      
      // 8. Alerts
      response.data.alerts = getAlerts().data || [];
      
      // 9. Vandalized
      response.data.vandalized = getVandalized().data || [];
      
      // 10. Change Status Data
      response.data.changeStatusData = getChangeStatusData(statusTimeRange, sheets).data || { vandalizadas: [], filial: [] };
      
      // 12. Admin Alerts
      response.data.adminAlerts = getAdminAlerts(driverName).alerts || [];
    }
    
    return response;
  } catch (e) {
    console.error("Erro na sincronização:", e);
    return { success: false, error: "Erro na sincronização: " + e.message };
  }
}

// --- LÓGICA DAS AÇÕES (REESCRITAS COM ÍNDICES FIXOS) ---

function getVehiclePlates() {
  try {
    const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${ACCESS_SHEET_NAME}" não encontrada.`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };

    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const platesSet = new Set();

    data.forEach(row => {
      const plate = (row[COLUMN_INDICES.ACCESS.PLACA - 1] || '').toString().trim();
      if (plate) {
        platesSet.add(plate);
      }
    });

    const plates = Array.from(platesSet).map(plate => ({
      plate: plate
    }));

    return { success: true, data: plates };
  } catch (e) {
    return { success: false, error: "Erro ao buscar placas: " + e.message };
  }
}

function handleLogin(login, password, plate, kmInicial) {
  const lock = LockService.getScriptLock();
  // Aumentado para 20 segundos para dar mais chance em momentos de pico
  lock.waitLock(20000);
  try {
    const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${ACCESS_SHEET_NAME}" não encontrada.`);

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Nenhum usuário cadastrado.' };

    // OTIMIZAÇÃO: Usa TextFinder para encontrar o login de forma eficiente
    const loginCol = COLUMN_INDICES.ACCESS.LOGIN;
    const range = sheet.getRange(2, loginCol, lastRow - 1, 1);
    const textFinder = range.createTextFinder(String(login).trim()).matchEntireCell(true);
    const foundCell = textFinder.findNext();
    
    if (!foundCell) {
      return { success: false, error: `Login "${login}" não encontrado.` };
    }

    const rowIndexInSheet = foundCell.getRow();
    const lastCol = sheet.getLastColumn();
    const rowData = sheet.getRange(rowIndexInSheet, 1, 1, lastCol).getValues()[0];
    const category = (rowData[COLUMN_INDICES.ACCESS.CATEGORIA - 1] || 'MOTORISTA').toString().trim().toUpperCase();
    const storedPassword = (rowData[COLUMN_INDICES.ACCESS.SENHA - 1] || '').toString().trim();

    if (storedPassword === password.toString().trim()) {
      // Validação de Placa e KM se fornecidos (Obrigatório apenas para MOTORISTA)
      if (category === 'MOTORISTA') {
        if (!plate || kmInicial === undefined) {
          return { success: false, error: 'Placa e KM Inicial são obrigatórios para motoristas.' };
        }

        // Validação estrita de KM Inicial contra o último KM Final registrado.
        const expectedKm = getVehicleKmFinal(plate);
        if (expectedKm !== null && expectedKm !== undefined && expectedKm !== "" && parseFloat(kmInicial) !== parseFloat(expectedKm)) {
          if (!(parseFloat(expectedKm) === 0 && parseFloat(kmInicial) === 0)) {
            return { success: false, error: 'KM Inicial incorreto. Verifique o odômetro do veículo.' };
          }
        }

        // Atualiza o KM na linha do VEÍCULO (independente do motorista)
        updateVehicleKm(plate, kmInicial, undefined);

        // Registra INICIO_TURNO na aba de Relatórios
        const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
        if (reportSheet) {
          const now = new Date();
          const timestamp = formatDateTime(now);
          const userName = rowData[COLUMN_INDICES.ACCESS.USUARIO - 1];
          reportSheet.appendRow([timestamp, plate, 'INICIO_TURNO', kmInicial, userName]);
        }
      }

      sheet.getRange(rowIndexInSheet, COLUMN_INDICES.ACCESS.STATUS_ONLINE).setValue('LOGADO');
      
      return { 
        success: true, 
        user: { 
          name: rowData[COLUMN_INDICES.ACCESS.USUARIO - 1], 
          category: category,
          plate: plate || rowData[COLUMN_INDICES.ACCESS.PLACA - 1],
          kmInicial: kmInicial !== undefined ? kmInicial : 0
        } 
      };
    } else {
      return { success: false, error: 'Senha incorreta.' };
    }
  } finally {
    lock.releaseLock();
  }
}

function handleLogout(userName) {
  if (!userName) return { success: true };
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) return { success: true };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true };

    // OTIMIZAÇÃO: Usa TextFinder para encontrar o usuário de forma eficiente
    const userCol = COLUMN_INDICES.ACCESS.USUARIO;
    const range = sheet.getRange(2, userCol, lastRow - 1, 1);
    const textFinder = range.createTextFinder(String(userName).trim()).matchEntireCell(true);
    const foundCell = textFinder.findNext();

    if (foundCell) {
      const rowIndexInSheet = foundCell.getRow();
      sheet.getRange(rowIndexInSheet, COLUMN_INDICES.ACCESS.STATUS_ONLINE).setValue('DESLOGADO');
      sheet.getRange(rowIndexInSheet, COLUMN_INDICES.ACCESS.GPS).setValue('');
    }
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function parseCoordinate(val) {
  if (val === undefined || val === null || val === '') return NaN;
  let num;
  if (typeof val === 'number') {
    num = val;
  } else {
    let s = String(val).trim().replace(',', '.');
    // Substitui travessões por hífen comum
    s = s.replace(/[–—]/g, '-');
    // Remove tudo exceto dígitos, ponto e o sinal de menos
    const cleaned = s.replace(/[^\d.-]/g, '');
    num = parseFloat(cleaned);
  }
  
  if (isNaN(num)) return NaN;

  // Se o valor for muito grande (ex: -23550000), provavelmente está sem o ponto decimal
  // Coordenadas válidas estão entre -180 e 180.
  if (Math.abs(num) > 1000) {
    let tempNum = num;
    // Divide por 10 até que o valor esteja em uma faixa de coordenada válida (-180 a 180)
    // Isso resolve o problema de coordenadas que vêm como inteiros longos de sistemas legados
    while (Math.abs(tempNum) > 180) {
      tempNum /= 10;
    }
    return tempNum;
  }
  
  return num;
}

function updateLocation(driverName, latitude, longitude) {
  if (!driverName || latitude === undefined || longitude === undefined) {
    return { success: false, error: 'Dados de localização incompletos.' };
  }
  const lock = LockService.getScriptLock();
  // Tenta obter o lock por apenas 2 segundos. Se não conseguir, pula esta atualização de GPS
  // para não travar o sistema, já que atualizações de GPS são frequentes e não críticas.
  if (!lock.tryLock(2000)) {
    return { success: true, note: 'Lock timeout, skipped update' };
  }
  try {
    const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Planilha de acesso não encontrada.' };
    
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Nenhum motorista cadastrado.' };

    // OTIMIZAÇÃO: Usa TextFinder para encontrar o motorista de forma eficiente
    const userCol = COLUMN_INDICES.ACCESS.USUARIO;
    const range = sheet.getRange(2, userCol, lastRow - 1, 1);
    const textFinder = range.createTextFinder(String(driverName).trim()).matchEntireCell(true);
    const foundCell = textFinder.findNext();

    if (foundCell) {
      const rowIndexInSheet = foundCell.getRow();
      const latFixed = parseCoordinate(latitude);
      const lngFixed = parseCoordinate(longitude);
      const locationString = `${latFixed};${lngFixed}|${new Date().getTime()}`;
      sheet.getRange(rowIndexInSheet, COLUMN_INDICES.ACCESS.GPS).setValue(locationString);
      return { success: true };
    } else {
      return { success: false, error: 'Motorista não encontrado para atualizar localização.' };
    }
  } finally {
    lock.releaseLock();
  }
}

function getDriverLocations(providedData) {
  let data = providedData;
  if (!data) {
    const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${ACCESS_SHEET_NAME}" não encontrada.`);

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };

    data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  } else {
    // Se os dados foram providos, removemos o cabeçalho se ele estiver lá
    if (data.length > 0 && (data[0][0] === 'Usuário' || data[0][0] === 'USUARIO')) {
      data = data.slice(1);
    }
  }

  const locations = [];
  const now = new Date();
  const TEN_MINUTES_IN_MS = 10 * 60 * 1000;

  data.forEach(row => {
    const status = (row[COLUMN_INDICES.ACCESS.STATUS_ONLINE - 1] || '').toString().toUpperCase();
    const gpsString = (row[COLUMN_INDICES.ACCESS.GPS - 1] || '').toString().trim();

    if (status === 'LOGADO' && gpsString) {
      try {
        const parts = gpsString.split('|');
        const coordsString = parts[0];
        const timestampString = parts.length > 1 ? parts[1] : null;

        let isLocationValid = false;
        
        if (timestampString) {
          // Se houver timestamp, verifica se é recente
          const timestamp = new Date(parseInt(timestampString, 10));
          if (!isNaN(timestamp.getTime()) && (now - timestamp <= TEN_MINUTES_IN_MS)) {
            isLocationValid = true;
          }
        } else {
          // Se não houver timestamp, considera a localização válida para exibição.
          // Isso garante que dados inseridos manualmente apareçam no mapa.
          isLocationValid = true; 
        }

        if (isLocationValid) {
          // ATUALIZAÇÃO: Tenta primeiro o ponto e vírgula, depois a vírgula (para compatibilidade legada)
          let coords = coordsString.split(';');
          if (coords.length < 2) {
            coords = coordsString.split(',');
          }
          
          if (coords.length < 2) throw new Error("Formato de coordenadas inválido.");

          const lat = parseCoordinate(coords[0]);
          const lon = parseCoordinate(coords[1]);

          if (isNaN(lat) || isNaN(lon)) {
             throw new Error(`Coordenadas inválidas: lat=${coords[0]}, lon=${coords[1]}`);
          }

          locations.push({
            driverName: row[COLUMN_INDICES.ACCESS.USUARIO - 1],
            latitude: lat,
            longitude: lon,
            timestamp: timestampString ? new Date(parseInt(timestampString, 10)).toISOString() : new Date().toISOString()
          });
        }
      } catch (e) {
        Logger.log(`Ignorando localização inválida para o usuário ${row[COLUMN_INDICES.ACCESS.USUARIO - 1]}: "${gpsString}". Erro: ${e.message}`);
      }
    }
  });
  return { success: true, data: locations };
}

function searchBike(bikeNumber) {
    const sheet = ss.getSheetByName(BIKES_SHEET_NAME);
    if (!sheet) throw new Error('Planilha "Bicicletas" não encontrada.');

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Nenhuma bicicleta cadastrada.' };

    const bikeCol = COLUMN_INDICES.BIKES.PATRIMONIO;
    const bikeColumnRange = sheet.getRange(2, bikeCol, lastRow - 1, 1);
    const textFinder = bikeColumnRange.createTextFinder(String(bikeNumber).trim()).matchEntireCell(true);
    const foundCell = textFinder.findNext();

    if (foundCell) {
        const rowIndex = foundCell.getRow();
        const maxCols = Math.max(sheet.getLastColumn(), 11);
        const rowData = sheet.getRange(rowIndex, 1, 1, maxCols).getValues()[0];
        const bikeObject = {
          'Patrimônio': rowData[COLUMN_INDICES.BIKES.PATRIMONIO - 1],
          'Status': rowData[COLUMN_INDICES.BIKES.STATUS - 1],
          'Localidade': rowData[COLUMN_INDICES.BIKES.LOCALIDADE - 1],
          'Usuário': rowData[COLUMN_INDICES.BIKES.USUARIO - 1],
          'Bateria': rowData[COLUMN_INDICES.BIKES.BATERIA - 1],
          'Trava': rowData[COLUMN_INDICES.BIKES.TRAVA - 1],
          'Carregamento': rowData[COLUMN_INDICES.BIKES.CARREGAMENTO - 1],
          'Última informação da posição': rowData[COLUMN_INDICES.BIKES.ULTIMA_INFO - 1],
          'Latitude': parseCoordinate(rowData[COLUMN_INDICES.BIKES.LATITUDE - 1]),
          'Longitude': parseCoordinate(rowData[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
        };
        return { success: true, data: bikeObject };
    } else {
        return { success: false, error: 'Bicicleta não encontrada.' };
    }
}

function getRequests(driverName, category, providedSheet) {
    const sheet = providedSheet || ss.getSheetByName(REQUESTS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);
    
    let requests = []; 
    const lastRow = sheet.getLastRow();

    if (lastRow >= 2) {
        const lastCol = sheet.getLastColumn();
        const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
        const userCategory = (category || '').toUpperCase();
        const isMotorista = userCategory.includes('MOTORISTA');
        const userNameLower = (driverName || '').toLowerCase();

        requests = data.map((row, index) => {
            const patrimonio = row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '';
            const status = (row[COLUMN_INDICES.REQUESTS.SITUACAO - 1] || 'Pendente').trim().toLowerCase();
            const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || 'Todos').toString().trim().toLowerCase();
            const declinedBy = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());
            
            const isPending = status === 'pendente';
            const hasDeclined = declinedBy.includes(userNameLower);
            
            // REGRA: Se destinatário for eu OU se for 'Todos' e eu for motorista
            const isForMe = recipient === userNameLower;
            const isForAllDrivers = recipient === 'todos' && isMotorista;
            
            if (patrimonio && isPending && !hasDeclined && (isForMe || isForAllDrivers)) {
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

    return { success: true, data: requests };
}


function getRequestsHistory(driverName, category) {
    const sheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);
    
    let history = [];

    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
        const lastCol = sheet.getLastColumn();
        const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
        const isAdm = category && category.toUpperCase().includes('ADM');

        history = data.map((row, index) => {
            const patrimonio = row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '';
            const status = (row[COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').trim().toLowerCase();
            const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || 'Todos').toString().trim().toLowerCase();
            const acceptedBy = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim().toLowerCase();
            const declinedBy = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());
            
            const isForDriver = recipient === driverName.toLowerCase();
            const wasAcceptedByDriver = acceptedBy === driverName.toLowerCase();
            const wasDeclinedByDriver = declinedBy.includes(driverName.toLowerCase());
            
            // ADM vê tudo. Motorista vê o que era pra ele especificamente, ou o que ele aceitou/recusou.
            if (patrimonio && (isAdm || isForDriver || wasAcceptedByDriver || wasDeclinedByDriver)) {
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

    // Ordena por timestamp decrescente (mais recentes primeiro)
    history.sort((a, b) => {
        const dateA = new Date(a.timestamp);
        const dateB = new Date(b.timestamp);
        return dateB.getTime() - dateA.getTime();
    });

    return { success: true, data: history };
}

function createRequest(patrimonio, ocorrencia, local, recipient) {
  if (!patrimonio || !ocorrencia || !local || !recipient) {
    return { success: false, error: "Todos os campos (patrimônio, ocorrência, local, destinatário) são obrigatórios." };
  }
  
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

    // PREVENÇÃO DE DUPLICIDADE: Verifica se já existe uma solicitação PENDENTE para este patrimônio
    if (sheet.getLastRow() >= 2) {
      const data = sheet.getRange(2, COLUMN_INDICES.REQUESTS.PATRIMONIO, sheet.getLastRow() - 1, COLUMN_INDICES.REQUESTS.SITUACAO - COLUMN_INDICES.REQUESTS.PATRIMONIO + 1).getValues();
      const patrimonioStr = patrimonio.toString().trim();
      
      for (let i = 0; i < data.length; i++) {
        const rowPatrimonio = (data[i][0] || '').toString().trim();
        const rowStatus = (data[i][COLUMN_INDICES.REQUESTS.SITUACAO - COLUMN_INDICES.REQUESTS.PATRIMONIO] || '').toString().trim().toLowerCase();
        
        if (rowPatrimonio === patrimonioStr && rowStatus === 'pendente') {
          return { success: false, error: `Já existe uma solicitação pendente para a bicicleta ${patrimonio}.` };
        }
      }
    }

    let finalLocal = local;
    // Se o local não contiver coordenadas, tenta buscar a posição atual da primeira bike
    if (!local.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/)) {
      try {
        const firstBike = patrimonio.toString().split(',')[0].trim();
        const bikeInfo = searchBike(firstBike);
        if (bikeInfo.success && bikeInfo.data.Latitude && bikeInfo.data.Longitude) {
          finalLocal = `${local} (${bikeInfo.data.Latitude};${bikeInfo.data.Longitude})`;
        }
      } catch (e) {
        Logger.log("Erro ao tentar obter coordenadas iniciais para a solicitação: " + e.message);
      }
    }

    const newRow = new Array(sheet.getLastColumn()).fill('');
    newRow[COLUMN_INDICES.REQUESTS.TIMESTAMP - 1] = new Date();
    newRow[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] = patrimonio;
    newRow[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1] = ocorrencia;
    newRow[COLUMN_INDICES.REQUESTS.LOCAL - 1] = finalLocal;
    newRow[COLUMN_INDICES.REQUESTS.SITUACAO - 1] = 'Pendente';
    newRow[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] = recipient;
    
    sheet.appendRow(newRow);
    return { success: true, message: 'Solicitação criada com sucesso.' };
  } finally {
    lock.releaseLock();
  }
}

function declineRequest(requestId, driverName) {
  if (!requestId) {
    return { success: false, error: "ID da solicitação é obrigatório." };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

    const row = parseInt(requestId, 10);
    if (isNaN(row) || row < 2 || row > sheet.getLastRow()) {
       return { success: false, error: `ID de solicitação inválido: ${requestId}` };
    }

    const recipient = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.DESTINATARIO).getValue() || 'Todos').toString().trim().toLowerCase();
    
    if (recipient === 'todos' && driverName) {
      // Se for para todos, adiciona o motorista à lista de quem recusou
      const currentDeclined = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.RECUSADA_POR).getValue() || '').toString();
      const declinedList = currentDeclined.split(',').map(s => s.trim()).filter(Boolean);
      
      if (!declinedList.includes(driverName)) {
        declinedList.push(driverName);
        sheet.getRange(row, COLUMN_INDICES.REQUESTS.RECUSADA_POR).setValue(declinedList.join(', '));
      }
    } else {
      // Se for para um motorista específico ou não tiver nome do motorista, marca como recusada globalmente
      sheet.getRange(row, COLUMN_INDICES.REQUESTS.SITUACAO).setValue('Recusada');
    }

    return { success: true, message: 'Solicitação recusada.' };
  } finally {
    lock.releaseLock();
  }
}

function acceptRequest(requestId, driverName) {
  if (!requestId || !driverName) {
    return { success: false, error: "ID da solicitação e nome do motorista são obrigatórios." };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

    const row = parseInt(requestId, 10);
    if (isNaN(row) || row < 2 || row > sheet.getLastRow()) {
       return { success: false, error: `ID de solicitação inválido: ${requestId}` };
    }

    const currentStatus = (sheet.getRange(row, COLUMN_INDICES.REQUESTS.SITUACAO).getValue() || 'Pendente').toString().trim().toLowerCase();
    if (currentStatus !== 'pendente') {
      return { success: false, error: 'Esta solicitação já foi processada (aceita, recusada ou cancelada).' };
    }

    sheet.getRange(row, COLUMN_INDICES.REQUESTS.ACEITA_POR).setValue(driverName);
    sheet.getRange(row, COLUMN_INDICES.REQUESTS.ACEITA_DATA).setValue(new Date());
    sheet.getRange(row, COLUMN_INDICES.REQUESTS.SITUACAO).setValue('Aceita');

    return { success: true, message: 'Solicitação aceita.' };
  } finally {
    lock.releaseLock();
  }
}

function getStations() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'stations_list';
  const cached = cache.get(cacheKey);
  if (cached) {
    return { success: true, data: JSON.parse(cached) };
  }

  try {
    const activeSS = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = activeSS.getSheetByName(STATIONS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${STATIONS_SHEET_NAME}" não encontrada.`);
    
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { success: true, data: [] };
    
    // Tenta detectar se a primeira linha é cabeçalho ou dado
    const firstRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const startRow = (typeof firstRow[0] === 'string' && isNaN(Number(firstRow[0]))) ? 2 : 1;
    const numRows = lastRow - (startRow - 1);
    
    if (numRows <= 0) return { success: true, data: [] };
    
    const data = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();
    
    // Busca dados de ocupação da aba REPOR para mesclar
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
      const nameKey = name.toString().trim().toLowerCase();
      return {
        Id: row[COLUMN_INDICES.STATIONS.ID - 1],
        Numb: row[COLUMN_INDICES.STATIONS.NUMB - 1],
        Name: name,
        Address: row[COLUMN_INDICES.STATIONS.ADDRESS - 1],
        Reference: row[COLUMN_INDICES.STATIONS.REFERENCE - 1],
        Latitude: parseCoordinate(row[COLUMN_INDICES.STATIONS.LATITUDE - 1]),
        Longitude: parseCoordinate(row[COLUMN_INDICES.STATIONS.LONGITUDE - 1]),
        Area: row[COLUMN_INDICES.STATIONS.AREA - 1],
        Occupancy: occupancyMap[nameKey] || 'N/A'
      };
    }).filter(s => s.Name && !isNaN(s.Latitude) && !isNaN(s.Longitude));
    
    if (stations.length > 0) {
      cache.put(cacheKey, JSON.stringify(stations), 300); // 5 minutos
    }

    return { success: true, data: stations };
  } catch (e) {
    return { success: false, error: "Erro ao buscar estações: " + e.message };
  }
}

function getMotoristas(providedData) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'motoristas_list';
  
  if (!providedData) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }
  }

  let data = providedData;
  if (!data) {
    const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${ACCESS_SHEET_NAME}" não encontrada.`);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, data: [] };
    data = sheet.getRange(2, 1, lastRow - 1, COLUMN_INDICES.ACCESS.CATEGORIA).getValues();
  } else {
    // Se os dados foram providos, removemos o cabeçalho se ele estiver lá
    if (data.length > 0 && (data[0][0] === 'Usuário' || data[0][0] === 'USUARIO')) {
      data = data.slice(1);
    }
  }

  const motoristas = data
    .filter(row => {
      const cat = (row[COLUMN_INDICES.ACCESS.CATEGORIA - 1] || '').toString().toUpperCase();
      return cat === 'MOTORISTA';
    })
    .map(row => row[COLUMN_INDICES.ACCESS.USUARIO - 1])
    .filter(Boolean);
  
  // Cache por 10 minutos se não foi provido externamente (se foi provido, o chamador pode cachear se quiser)
  if (!providedData && motoristas.length > 0) {
    cache.put(cacheKey, JSON.stringify(motoristas), 600);
  }
  
  return { success: true, data: motoristas };
}

function saveDailySummary(summaryData) {
  try {
    let sheet = ss.getSheetByName(DAILY_SUMMARY_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(DAILY_SUMMARY_SHEET_NAME);
      sheet.appendRow([
        'Data', 'Motorista', 'Placa(s)', 'KM Total', 'Bateria Baixa', 'Manut. Bicicleta', 'Manut. Locker', 'Solicitado Recolha',
        'Remanejadas (Estação)', 'Ocorrências', 'Não Encontradas', 'Vandalizadas', 'Início', 'Fim', 'Observações'
      ]);
      sheet.getRange(1, 1, 1, 15).setFontWeight('bold').setBackground('#f3f3f3');
      sheet.setFrozenRows(1);
    }

    const row = [
      new Date(),
      summaryData.driverName,
      summaryData.plates,
      summaryData.totalKm,
      summaryData.bateriaCount,
      summaryData.manutBikeCount,
      summaryData.manutLockerCount,
      summaryData.solicitadoRecolhaCount || 0,
      summaryData.remanejadasCount,
      summaryData.ocorrenciasCount,
      summaryData.naoEncontradasCount,
      summaryData.vandalizadasCount,
      summaryData.startTime,
      summaryData.endTime,
      summaryData.obs || ''
    ];

    sheet.appendRow(row);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function logReport(rowData, kmFinal, plate) {
  if (!Array.isArray(rowData) || rowData.length === 0) {
    return { success: false, error: "Dados do relatório inválidos ou ausentes." };
  }
  
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // Timeout maior para relatórios
  try {
    const sheet = ss.getSheetByName(REPORT_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${REPORT_SHEET_NAME}" não encontrada.`);

    // Prevenção de duplicidade robusta: verifica se já existe um registro idêntico nos últimos minutos
    // O usuário solicitou que o app exclua a linha da segunda informação duplicada (mesmo local, mesma estação, diferença de minutos)
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      // Verificamos as últimas 100 linhas para garantir que pegamos duplicatas mesmo com tráfego intenso
      const numRowsToCheck = Math.min(lastRow - 1, 100);
      const lastData = sheet.getRange(lastRow - numRowsToCheck + 1, 1, numRowsToCheck, sheet.getLastColumn()).getValues();
      const now = new Date();
      
      const patrimonio = (rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
      const status = (rowData[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
      const observacao = (rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
      const localidade = (rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim();
      const motorista = (rowData[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();

      for (let i = lastData.length - 1; i >= 0; i--) {
        const row = lastData[i];
        const rowTimestamp = new Date(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
        const rowPatrimonio = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
        const rowStatus = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
        const rowObservacao = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
        const rowLocalidade = (row[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim();
        const rowMotorista = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();

        // Critérios de duplicidade: mesma bike, mesmo status e mesmo motorista
        const isSameBikeAndStatus = rowPatrimonio === patrimonio && rowStatus === status;
        const isSameMotorista = rowMotorista === motorista;
        
        if (isSameBikeAndStatus && isSameMotorista) {
          const diffMinutes = Math.abs(now.getTime() - rowTimestamp.getTime()) / (1000 * 60);
          
          // Se for a mesma bike, mesmo status e mesmo motorista em menos de 10 minutos, 
          // consideramos duplicata mesmo que o local ou observação variem ligeiramente
          // (ex: uma com GPS e outra sem, ou uma com observação automática e outra manual)
          if (diffMinutes < 10) {
            console.log(`Duplicidade detectada para bike ${patrimonio}. Ignorando nova entrada.`);
            return { success: true, message: "Registro duplicado detectado e ignorado." };
          }
        }
      }
    }

    // Registra o relatório
    sheet.appendRow(rowData);

    // Verifica divergências e notifica ADMs
    try {
      checkDivergences(rowData);
    } catch (e) {
      console.error("Erro ao verificar divergências:", e);
    }

    // Lógica para "Não encontrada"
    const patrimonio = rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1];
    const status = (rowData[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
    const observacao = (rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
    const motorista = (rowData[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
    
    // Atualização de KM Final se fornecido
    if (kmFinal !== undefined && (plate || motorista)) {
      let plateToUpdate = plate;
      
      // Se não veio a placa do frontend, tenta buscar na planilha de acesso
      if (!plateToUpdate && motorista) {
        const accessSheet = ss.getSheetByName(ACCESS_SHEET_NAME);
        if (accessSheet) {
          const lastRowAccess = accessSheet.getLastRow();
          if (lastRowAccess >= 2) {
            // OTIMIZAÇÃO: Usa TextFinder para encontrar o motorista de forma eficiente
            const userCol = COLUMN_INDICES.ACCESS.USUARIO;
            const range = accessSheet.getRange(2, userCol, lastRowAccess - 1, 1);
            const textFinder = range.createTextFinder(String(motorista).trim()).matchEntireCell(true);
            const foundCell = textFinder.findNext();
            if (foundCell) {
              plateToUpdate = accessSheet.getRange(foundCell.getRow(), COLUMN_INDICES.ACCESS.PLACA).getValue();
            }
          }
        }
      }
      
      if (plateToUpdate) {
        updateVehicleKm(plateToUpdate, undefined, kmFinal);
      }
    }

    // Sincroniza com a aba de Solicitações para o histórico
    syncWithRequests(patrimonio, status, observacao, motorista);

    const statusLower = status.toLowerCase();
    if (statusLower === 'não encontrada' || statusLower === 'nao encontrada') {
      updateAlertsSheet(patrimonio);
      updateOcorrenciaSheet(rowData);
    } else if (statusLower === 'vandalizada') {
      updateVandalizedSheet(patrimonio, rowData);
      updateVandalismoSheet(rowData);
    } else {
      // Se a bike for registrada com qualquer outro status, ela foi "encontrada"
      resolveAlert(patrimonio, motorista || 'Sistema');
      resolveVandalized(patrimonio, motorista || 'Sistema');
    }

    // Limpeza de duplicatas recentes (garantia extra)
    try {
      cleanupRecentDuplicates();
    } catch (e) {
      console.error("Erro na limpeza de duplicatas:", e);
    }

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Alimenta a aba Ocorrencia com bikes não encontradas.
 */
function updateOcorrenciaSheet(rowData) {
  const sheet = ss.getSheetByName(OCORRENCIA_SHEET_NAME);
  if (!sheet) return;
  sheet.appendRow(rowData);
}

/**
 * Alimenta a aba Vandalismo com as colunas A, B, C, D.
 */
function updateVandalismoSheet(rowData) {
  const sheet = ss.getSheetByName(VANDALISMO_SHEET_NAME);
  if (!sheet) return;
  
  // Colunas A, B, C, D: Timestamp, Patrimonio, Observação, Localidade
  const newRow = [
    rowData[COLUMN_INDICES.REPORTS.TIMESTAMP - 1],
    rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1],
    rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1],
    rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1]
  ];
  sheet.appendRow(newRow);
}

/**
 * Sincroniza as ações do motorista com a aba de Solicitações.
 * Garante que todas as notificações (pendentes ou novas ações) apareçam no histórico.
 */
function syncWithRequests(patrimonio, status, observacao, motorista) {
  const sheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  const motoristaLower = (motorista || '').toString().toLowerCase();
  const patrimonioStr = (patrimonio || '').toString();

  // 1. Tenta encontrar uma solicitação "Aceita" para finalizar
  if (data.length > 1) {
    // Percorre de trás para frente para encontrar a solicitação mais recente
    for (let i = data.length - 1; i >= 1; i--) {
      const rowPatrimonioRaw = (data[i][COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '').toString();
      const rowPatrimonios = rowPatrimonioRaw.split(',').map(s => s.trim());
      const rowStatus = (data[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').toString().toLowerCase();
      const rowAceitaPor = (data[i][COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().toLowerCase();

      // Verifica se o patrimônio está na lista (pode ser um único ou vários separados por vírgula)
      if (rowPatrimonios.includes(patrimonioStr) && rowStatus === 'aceita' && rowAceitaPor === motoristaLower) {
        const row = i + 1;
        sheet.getRange(row, COLUMN_INDICES.REQUESTS.SITUACAO).setValue('Finalizada');
        return; // Encontrou e atualizou, não precisa continuar nem criar nova linha
      }
    }
  }
  
  // REMOVIDO: O bloco que criava uma nova linha na aba Solicitacao se 'found' fosse falso.
  // Agora a aba Solicitacao conterá apenas as notificações que foram explicitamente enviadas para lá.
}

/**
 * Atualiza a planilha de alertas para bikes não encontradas.
 */
function updateAlertsSheet(patrimonio) {
  const sheet = ss.getSheetByName(ALERTS_SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  let foundRow = -1;
  let currentSituacao = '';

  for (let i = 1; i < data.length; i++) {
    const situacao = data[i][COLUMN_INDICES.ALERTS.SITUACAO - 1];
    if (data[i][COLUMN_INDICES.ALERTS.PATRIMONIO - 1].toString() === patrimonio.toString() && 
        (situacao === 'Pendente' || situacao === 'Localizada')) {
      foundRow = i + 1;
      currentSituacao = situacao;
      break;
    }
  }

  const now = new Date();
  if (foundRow === -1) {
    // Nova entrada
    const newRow = new Array(sheet.getLastColumn()).fill('');
    newRow[COLUMN_INDICES.ALERTS.PATRIMONIO - 1] = patrimonio;
    newRow[COLUMN_INDICES.ALERTS.CHECK1 - 1] = now;
    newRow[COLUMN_INDICES.ALERTS.SITUACAO - 1] = 'Pendente';
    sheet.appendRow(newRow);
  } else {
    // Se estava 'Localizada' mas sumiu de novo, volta para 'Pendente'
    if (currentSituacao === 'Localizada') {
      sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.SITUACAO).setValue('Pendente');
    }

    // Atualiza checks existentes
    const check1 = sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK1).getValue();
    const check2 = sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK2).getValue();
    const check3 = sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK3).getValue();

    if (!check1) {
      sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK1).setValue(now);
    } else if (!check2) {
      sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK2).setValue(now);
    } else if (!check3) {
      sheet.getRange(foundRow, COLUMN_INDICES.ALERTS.CHECK3).setValue(now);
      // Notifica todos ADMs
      createRequest(patrimonio, "ALERTA CRÍTICO: Bike não encontrada por 3 vezes consecutivas.", "Verificar Alertas", "Todos");
    }
  }
}

/**
 * Marca um alerta como resolvido se a bike for encontrada.
 */
function resolveAlert(patrimonio, motorista) {
  const sheet = ss.getSheetByName(ALERTS_SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][COLUMN_INDICES.ALERTS.PATRIMONIO - 1].toString() === patrimonio.toString() && 
        data[i][COLUMN_INDICES.ALERTS.SITUACAO - 1] === 'Pendente') {
      const row = i + 1;
      // Em vez de finalizar, marca como 'Localizada' para habilitar o botão no App
      sheet.getRange(row, COLUMN_INDICES.ALERTS.SITUACAO).setValue('Localizada');
      sheet.getRange(row, COLUMN_INDICES.ALERTS.ENCONTRADA_POR).setValue(motorista);
      sheet.getRange(row, COLUMN_INDICES.ALERTS.DATA_ENCONTRADA).setValue(new Date());
      break;
    }
  }
}

/**
 * Helper para garantir que uma aba existe, criando-a se necessário.
 */
function getOrCreateSheet(activeSS, sheetName, headers) {
  let sheet = activeSS.getSheetByName(sheetName);
  if (!sheet) {
    sheet = activeSS.insertSheet(sheetName);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    }
  }
  return sheet;
}

function getAlerts() {
  try {
    const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    // Tenta pegar ou criar a aba Alertas
    const alertsSheet = getOrCreateSheet(ss, ALERTS_SHEET_NAME, 
      ['Patrimônio', 'Check 1', 'Check 2', 'Check 3', 'Situação', 'Encontrada Por', 'Data Encontrada']);
    
    if (!reportSheet) return { success: true, data: [] };
    
    // 1. Pega dados do Relatório (Timestamp, Patrimonio, Status)
    const lastRowReport = reportSheet.getLastRow();
    const reportData = lastRowReport > 1 ? 
      reportSheet.getRange(2, 1, lastRowReport - 1, 3).getValues() : [];
    
    // 2. Pega dados de Alertas já confirmados para não repetir
    const confirmedAlerts = {};
    const lastRowAlertsInitial = alertsSheet.getLastRow();
    if (lastRowAlertsInitial > 1) {
      const alertsData = alertsSheet.getRange(2, 1, lastRowAlertsInitial - 1, COLUMN_INDICES.ALERTS.DATA_ENCONTRADA).getValues();
      alertsData.forEach((row) => {
        const patrimonio = (row[COLUMN_INDICES.ALERTS.PATRIMONIO - 1] || '').toString();
        const situacao = row[COLUMN_INDICES.ALERTS.SITUACAO - 1];
        const dataEncontrada = row[COLUMN_INDICES.ALERTS.DATA_ENCONTRADA - 1];
        if ((situacao === 'Encontrada' || situacao === 'RECUPERADA') && dataEncontrada) {
          const date = new Date(dataEncontrada).getTime();
          if (!confirmedAlerts[patrimonio] || date > confirmedAlerts[patrimonio]) {
            confirmedAlerts[patrimonio] = date;
          }
        }
      });
    }

    // 3. Processa o Relatório para identificar bikes em alerta
    const bikeHistory = {}; 
    const sortedReports = [...reportData].sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime());
    
    sortedReports.forEach(row => {
      const timestamp = new Date(row[0]);
      const patrimonio = (row[1] || '').toString();
      const status = (row[2] || '').toString().trim().toLowerCase();
      const isMissing = status === 'não encontrada' || status === 'nao encontrada';
      const isNotAttended = status === 'não atendida' || status === 'nao atendida';
      
      // Se for "não atendida", ignoramos este registro para a lógica de alertas
      if (isNotAttended) return;
      
      if (confirmedAlerts[patrimonio] && confirmedAlerts[patrimonio] >= timestamp.getTime()) return;
      
      if (!bikeHistory[patrimonio]) {
        bikeHistory[patrimonio] = { 
          patrimonio, 
          checks: [], 
          situacao: isMissing ? 'Pendente' : 'Localizada'
        };
      }
      
      const history = bikeHistory[patrimonio];

      if (isMissing) {
        if (history.checks.length < 3) {
          history.checks.push(timestamp);
        }
      }
    });

    // 4. Sincroniza com a aba Alertas
    const currentAlertsData = alertsSheet.getDataRange().getValues();
    Object.values(bikeHistory).filter(h => h.checks.length > 0).forEach(alert => {
      let rowIndex = -1;
      for (let i = 1; i < currentAlertsData.length; i++) {
        const rowPatrimonio = currentAlertsData[i][0].toString();
        const rowSituacao = currentAlertsData[i][4];
        // Só atualiza se for a mesma bike e NÃO estiver resolvida
        if (rowPatrimonio === alert.patrimonio && rowSituacao !== 'Encontrada' && rowSituacao !== 'RECUPERADA') {
          rowIndex = i + 1;
          break;
        }
      }

      const lastCol = alertsSheet.getLastColumn() || 7;
      if (rowIndex === -1) {
        const newRow = new Array(lastCol).fill('');
        newRow[0] = alert.patrimonio;
        newRow[1] = alert.checks[0] || '';
        newRow[2] = alert.checks[1] || '';
        newRow[3] = alert.checks[2] || '';
        newRow[4] = alert.situacao;
        alertsSheet.appendRow(newRow);
      } else {
        alertsSheet.getRange(rowIndex, 2, 1, 4).setValues([[
          alert.checks[0] || '',
          alert.checks[1] || '',
          alert.checks[2] || '',
          alert.situacao
        ]]);
      }
    });

    // 5. Retorna os dados finais da aba Alertas
    const lastRowAlertsFinal = alertsSheet.getLastRow();
    if (lastRowAlertsFinal < 2) return { success: true, data: [] };

    const finalData = alertsSheet.getRange(2, 1, lastRowAlertsFinal - 1, alertsSheet.getLastColumn()).getValues();
    const alerts = finalData.map((row, index) => {
      const situacao = row[4];
      if (situacao === 'Pendente' || situacao === 'Localizada') {
        return {
          id: index + 2,
          patrimonio: row[0],
          check1: row[1],
          check2: row[2],
          check3: row[3],
          situacao: situacao
        };
      }
      return null;
    }).filter(Boolean);

    return { success: true, data: alerts };
  } catch (e) {
    return { success: false, error: "Erro ao sincronizar alertas: " + e.message };
  }
}

function confirmBikeFound(alertId, driverName) {
  try {
    const activeSS = SpreadsheetApp.openById(SPREADSHEET_ID);
    const alertsSheet = activeSS.getSheetByName(ALERTS_SHEET_NAME);
    if (!alertsSheet) return { success: false, error: "Planilha de alertas não encontrada." };

    const row = parseInt(alertId, 10);
    if (isNaN(row) || row < 2) return { success: false, error: "ID de alerta inválido." };

    const patrimonio = alertsSheet.getRange(row, COLUMN_INDICES.ALERTS.PATRIMONIO).getValue();

    // Atualiza aba Alertas
    alertsSheet.getRange(row, COLUMN_INDICES.ALERTS.SITUACAO).setValue('RECUPERADA');
    alertsSheet.getRange(row, COLUMN_INDICES.ALERTS.ENCONTRADA_POR).setValue(driverName);
    alertsSheet.getRange(row, COLUMN_INDICES.ALERTS.DATA_ENCONTRADA).setValue(new Date());

    // Alimenta aba Relatorio com a informação "RECUPERADA"
    const reportSheet = activeSS.getSheetByName(REPORT_SHEET_NAME);
    if (reportSheet) {
      const newReportRow = new Array(reportSheet.getLastColumn()).fill('');
      newReportRow[COLUMN_INDICES.REPORTS.TIMESTAMP - 1] = new Date();
      newReportRow[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] = patrimonio;
      newReportRow[COLUMN_INDICES.REPORTS.STATUS - 1] = 'RECUPERADA';
      newReportRow[COLUMN_INDICES.REPORTS.MOTORISTA - 1] = driverName;
      newReportRow[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] = 'Bike recuperada via sistema de alertas';
      reportSheet.appendRow(newReportRow);
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: "Erro ao confirmar bike: " + e.message };
  }
}

/**
 * Atualiza a planilha de vandalizadas.
 */
function updateVandalizedSheet(patrimonio, rowData) {
  const sheet = ss.getSheetByName(VANDALIZED_SHEET_NAME);
  if (!sheet) return;

  // Verifica se já existe uma entrada pendente para esta bike
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1].toString() === patrimonio.toString() && 
        data[i][COLUMN_INDICES.VANDALIZED.SITUACAO - 1] === 'Pendente') {
      return; // Já existe um alerta pendente
    }
  }

  const newRow = new Array(sheet.getLastColumn()).fill('');
  newRow[COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1] = patrimonio;
  newRow[COLUMN_INDICES.VANDALIZED.DATA - 1] = new Date();
  newRow[COLUMN_INDICES.VANDALIZED.DEFEITO - 1] = rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || 'Vandalismo reportado';
  newRow[COLUMN_INDICES.VANDALIZED.LOCAL - 1] = rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || 'N/A';
  newRow[COLUMN_INDICES.VANDALIZED.SITUACAO - 1] = 'Pendente';
  sheet.appendRow(newRow);
}

function resolveVandalized(patrimonio, motorista) {
  const sheet = ss.getSheetByName(VANDALIZED_SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1].toString() === patrimonio.toString() && 
        data[i][COLUMN_INDICES.VANDALIZED.SITUACAO - 1] === 'Pendente') {
      const row = i + 1;
      sheet.getRange(row, COLUMN_INDICES.VANDALIZED.SITUACAO).setValue('Encontrada');
      sheet.getRange(row, COLUMN_INDICES.VANDALIZED.ENCONTRADA_POR).setValue(motorista);
      sheet.getRange(row, COLUMN_INDICES.VANDALIZED.DATA_ENCONTRADA).setValue(new Date());
      break;
    }
  }
}

function getVandalized() {
  try {
    const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    const vandalizedSheet = getOrCreateSheet(ss, VANDALIZED_SHEET_NAME,
      ['Patrimônio', 'Data', 'Defeito', 'Local', 'Situação', 'Encontrada Por', 'Data Encontrada']);
    
    if (!reportSheet) return { success: true, data: [] };

    // 1. Pega dados do Relatório
    const lastRowReport = reportSheet.getLastRow();
    const reportData = lastRowReport > 1 ? 
      reportSheet.getRange(2, 1, lastRowReport - 1, reportSheet.getLastColumn()).getValues() : [];

    // 2. Pega dados de Vandalizadas já confirmadas para não repetir
    const confirmedVandalized = {};
    const lastRowVandalizedInitial = vandalizedSheet.getLastRow();
    if (lastRowVandalizedInitial > 1) {
      const vandalizedData = vandalizedSheet.getRange(2, 1, lastRowVandalizedInitial - 1, COLUMN_INDICES.VANDALIZED.DATA_ENCONTRADA).getValues();
      vandalizedData.forEach((row) => {
        const patrimonio = (row[COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1] || '').toString();
        const situacao = row[COLUMN_INDICES.VANDALIZED.SITUACAO - 1];
        const dataEncontrada = row[COLUMN_INDICES.VANDALIZED.DATA_ENCONTRADA - 1];
        if (situacao === 'Encontrada' && dataEncontrada) {
          const date = new Date(dataEncontrada).getTime();
          if (!confirmedVandalized[patrimonio] || date > confirmedVandalized[patrimonio]) {
            confirmedVandalized[patrimonio] = date;
          }
        }
      });
    }

    // 3. Processa o Relatório para identificar bikes vandalizadas
    const vandalizedHistory = {};
    const sortedReports = [...reportData].sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime());

    sortedReports.forEach(row => {
      const timestamp = new Date(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      const patrimonio = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString();
      const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim().toLowerCase();
      const isVandalized = status === 'vandalizada';
      
      if (confirmedVandalized[patrimonio] && confirmedVandalized[patrimonio] >= timestamp.getTime()) return;
      
      if (!vandalizedHistory[patrimonio]) {
        if (isVandalized) {
          vandalizedHistory[patrimonio] = {
            patrimonio,
            data: timestamp,
            defeito: row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || 'Vandalismo reportado',
            local: row[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || 'N/A',
            situacao: 'Pendente'
          };
        }
      }
    });

    // 4. Sincroniza com a aba Vandalizadas
    const currentVandalizedData = vandalizedSheet.getDataRange().getValues();
    Object.values(vandalizedHistory).forEach(v => {
      let rowIndex = -1;
      for (let i = 1; i < currentVandalizedData.length; i++) {
        const rowPatrimonio = currentVandalizedData[i][0].toString();
        const rowSituacao = currentVandalizedData[i][4];
        if (rowPatrimonio === v.patrimonio && rowSituacao !== 'Encontrada') {
          rowIndex = i + 1;
          break;
        }
      }

      const lastCol = vandalizedSheet.getLastColumn() || 7;
      if (rowIndex === -1) {
        const newRow = new Array(lastCol).fill('');
        newRow[COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1] = v.patrimonio;
        newRow[COLUMN_INDICES.VANDALIZED.DATA - 1] = v.data;
        newRow[COLUMN_INDICES.VANDALIZED.DEFEITO - 1] = v.defeito;
        newRow[COLUMN_INDICES.VANDALIZED.LOCAL - 1] = v.local;
        newRow[COLUMN_INDICES.VANDALIZED.SITUACAO - 1] = v.situacao;
        vandalizedSheet.appendRow(newRow);
      }
    });

    // 5. Retorna os dados finais da aba Vandalizadas
    const lastRowVandalizedFinal = vandalizedSheet.getLastRow();
    if (lastRowVandalizedFinal < 2) return { success: true, data: [] };

    const finalData = vandalizedSheet.getRange(2, 1, lastRowVandalizedFinal - 1, vandalizedSheet.getLastColumn()).getValues();
    const vandalized = finalData.map((row, index) => {
      if (row[COLUMN_INDICES.VANDALIZED.SITUACAO - 1] === 'Pendente') {
        return {
          id: index + 2,
          patrimonio: row[COLUMN_INDICES.VANDALIZED.PATRIMONIO - 1],
          data: row[COLUMN_INDICES.VANDALIZED.DATA - 1],
          defeito: row[COLUMN_INDICES.VANDALIZED.DEFEITO - 1],
          local: row[COLUMN_INDICES.VANDALIZED.LOCAL - 1],
          situacao: row[COLUMN_INDICES.VANDALIZED.SITUACAO - 1]
        };
      }
      return null;
    }).filter(Boolean);

    return { success: true, data: vandalized };
  } catch (e) {
    return { success: false, error: "Erro ao sincronizar vandalizadas: " + e.message };
  }
}

function confirmVandalizedFound(alertId, driverName) {
  try {
    const activeSS = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = activeSS.getSheetByName(VANDALIZED_SHEET_NAME);
    if (!sheet) return { success: false, error: "Planilha de vandalizadas não encontrada." };

    const row = parseInt(alertId, 10);
    if (isNaN(row) || row < 2) return { success: false, error: "ID de alerta inválido." };

    sheet.getRange(row, COLUMN_INDICES.VANDALIZED.SITUACAO).setValue('Encontrada');
    sheet.getRange(row, COLUMN_INDICES.VANDALIZED.ENCONTRADA_POR).setValue(driverName);
    sheet.getRange(row, COLUMN_INDICES.VANDALIZED.DATA_ENCONTRADA).setValue(new Date());

    return { success: true };
  } catch (e) {
    return { success: false, error: "Erro ao confirmar vandalizada: " + e.message };
  }
}

function updateBikeAssignment(bikeNumber, driverName) {
  const sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${STATE_SHEET_NAME}" não encontrada.`);
  if (sheet.getLastRow() < 2) return { success: true };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  
  // Para cada motorista, verifica se a bike está na sua lista de recolhidas
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const currentRowDriver = row[COLUMN_INDICES.STATE.MOTORISTA - 1];
    let collectedBikes = (row[COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    const bikeIndex = collectedBikes.indexOf(bikeNumber.toString());

    if (currentRowDriver.toLowerCase() === (driverName || '').toLowerCase()) {
      // É o motorista atual, adiciona a bike se não estiver lá
      if (bikeIndex === -1) {
        collectedBikes.push(bikeNumber.toString());
        sheet.getRange(i + 2, COLUMN_INDICES.STATE.RECOLHIDAS).setValue(collectedBikes.join(', '));
      }
    } else {
      // Não é o motorista atual, remove a bike se estiver lá
      if (bikeIndex !== -1) {
        collectedBikes.splice(bikeIndex, 1);
        sheet.getRange(i + 2, COLUMN_INDICES.STATE.RECOLHIDAS).setValue(collectedBikes.join(', '));
      }
    }
  }

  return { success: true, message: "Atribuição atualizada." };
}

function getAllPatrimonioNumbers() {
  const sheet = ss.getSheetByName(BIKES_SHEET_NAME);
  if (!sheet) throw new Error('Planilha "Bicicletas" não encontrada.');
  if (sheet.getLastRow() < 2) return { success: true, data: [] };

  const patrimonioColumn = sheet.getRange(2, COLUMN_INDICES.BIKES.PATRIMONIO, sheet.getLastRow() - 1, 1);
  const numbers = patrimonioColumn.getValues().flat().filter(String);
  return { success: true, data: numbers };
}


function clearDriverRoute(driverName) {
    if (!driverName) {
        return { success: false, error: 'Nome do motorista é obrigatório.' };
    }
    try {
        const requestSheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
        if (!requestSheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

        const data = requestSheet.getRange(2, 1, requestSheet.getLastRow() - 1, requestSheet.getLastColumn()).getValues();
        const driverTrimmedLower = (driverName || '').toString().trim().toLowerCase();
        let changesMade = false;

        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            const acceptedBy = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim().toLowerCase();
            const status = (row[COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').toString().trim().toLowerCase();

            if (acceptedBy === driverTrimmedLower && status === 'aceita') {
                // Altera o status para 'Cancelada' para que a fórmula na aba 'Dados' não puxe mais esta solicitação.
                requestSheet.getRange(i + 2, COLUMN_INDICES.REQUESTS.SITUACAO).setValue('Cancelada');
                changesMade = true;
            }
        }

        if (changesMade) {
            return { success: true, message: 'Roteiro cancelado com sucesso.' };
        } else {
            // Se não encontrou nenhuma solicitação 'Aceita' para este motorista, considera sucesso pois o roteiro já está limpo.
            return { success: true, message: 'Nenhuma rota ativa encontrada para cancelar.' };
        }
    } catch (e) {
        return { success: false, error: `Falha crítica ao tentar cancelar o roteiro: ${e.message}` };
    }
}



function getDriverState(driverName, providedSheet) {
  const sheet = providedSheet || ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet) throw new Error(`Planilha "${STATE_SHEET_NAME}" não encontrada.`);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, data: { routeBikes: [], collectedBikes: [] } };

  const driverCol = COLUMN_INDICES.STATE.MOTORISTA;
  const driverColumnRange = sheet.getRange(2, driverCol, lastRow - 1, 1);
  const textFinder = driverColumnRange.createTextFinder(String(driverName).trim()).matchEntireCell(true);
  const foundCell = textFinder.findNext();

  if (foundCell) {
    const rowIndex = foundCell.getRow();
    const lastCol = sheet.getLastColumn();
    const rowData = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
    
    const routeBikes = (rowData[COLUMN_INDICES.STATE.ROTEIRO - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    const collectedBikes = (rowData[COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    
    return { success: true, data: { routeBikes, collectedBikes } };
  }

  // Se o motorista não for encontrado, retorna estado vazio.
  return { success: true, data: { routeBikes: [], collectedBikes: [] } };
}

function finalizeRouteBike(request) {
  try {
    const { driverName, bikeNumber, finalStatus, finalObservation } = request;
    
    // 1. Busca o estado atual do servidor para ser a fonte da verdade
    const stateResult = getDriverState(driverName);
    let routeBikes = stateResult.success ? stateResult.data.routeBikes : [];
    let collectedBikes = stateResult.success ? stateResult.data.collectedBikes : [];
    
    const bikeResult = searchBike(bikeNumber);
    if (!bikeResult.success) throw new Error(`Bicicleta ${bikeNumber} não encontrada.`);
    const bikeDetails = bikeResult.data;
    
    // 2. Atualiza as listas de forma autoritativa no servidor
    routeBikes = routeBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    
    if (finalStatus === 'Recolhida') {
      // Adiciona às recolhidas se não estiver lá
      if (!collectedBikes.map(String).includes(String(bikeNumber))) {
        collectedBikes.push(bikeNumber);
      }
    }
    
    // 3. SÓ LOGA NO RELATÓRIO SE NÃO FOR RECOLHIDA
    // O usuário solicitou que a recolha não gere entrada automática no relatório
    if (finalStatus !== 'Recolhida') {
      const rowData = [
        formatDateTime(new Date()), bikeNumber, finalStatus, finalObservation, driverName,
        bikeDetails['Status'], bikeDetails['Bateria'], bikeDetails['Trava'], bikeDetails['Localidade']
      ];
      logReport(rowData);
    }
    
    // 4. Salva o novo estado
    updateDriverState(driverName, routeBikes, collectedBikes);
    
    return { success: true };
  } catch (error) {
    console.error("Erro em finalizeRouteBike:", error);
    return { success: false, error: error.message };
  }
}

function finalizeCollectedBike(request) {
  try {
    const { driverName, bikeNumber, finalStatus, finalObservation } = request;
    
    // 1. Busca o estado atual do servidor para ser a fonte da verdade
    const stateResult = getDriverState(driverName);
    let routeBikes = stateResult.success ? stateResult.data.routeBikes : [];
    let collectedBikes = stateResult.success ? stateResult.data.collectedBikes : [];
    
    const bikeResult = searchBike(bikeNumber);
    if (!bikeResult.success) throw new Error(`Bicicleta ${bikeNumber} não encontrada.`);
    const bikeDetails = bikeResult.data;
    
    // 2. Remove das recolhidas de forma autoritativa no servidor
    collectedBikes = collectedBikes.filter(b => String(b).trim() !== String(bikeNumber).trim());
    
    // 3. Log the report (Ação final: Estação, Filial, etc)
    const rowData = [
      formatDateTime(new Date()), bikeNumber, finalStatus, finalObservation, driverName,
      bikeDetails['Status'], bikeDetails['Bateria'], bikeDetails['Trava'], bikeDetails['Localidade']
    ];
    
    logReport(rowData);
    updateDriverState(driverName, routeBikes, collectedBikes);
    
    return { success: true };
  } catch (error) {
    console.error("Erro em finalizeCollectedBike:", error);
    return { success: false, error: error.message };
  }
}

function updateDriverState(driverName, routeBikes, collectedBikes) {
  const lock = LockService.getScriptLock();
  try {
    // Tenta obter o lock por até 5 segundos
    if (!lock.tryLock(5000)) {
       console.warn("Não foi possível obter o lock para updateDriverState. Continuando sem lock para evitar lentidão extrema.");
    }
    
    const sheet = ss.getSheetByName(STATE_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${STATE_SHEET_NAME}" não encontrada.`);

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      // Se a planilha estiver vazia, adiciona o primeiro motorista
      const newRow = new Array(sheet.getLastColumn() || 4).fill('');
      newRow[COLUMN_INDICES.STATE.MOTORISTA - 1] = driverName;
      newRow[COLUMN_INDICES.STATE.ROTEIRO - 1] = Array.isArray(routeBikes) ? routeBikes.join(', ') : '';
      newRow[COLUMN_INDICES.STATE.RECOLHIDAS - 1] = Array.isArray(collectedBikes) ? collectedBikes.join(', ') : '';
      sheet.appendRow(newRow);
      return { success: true };
    }

    const allData = sheet.getDataRange().getValues();
    const headers = allData[0];
    const dataRows = allData.slice(1);
    
    const driverColIdx = COLUMN_INDICES.STATE.MOTORISTA - 1;
    const routeColIdx = COLUMN_INDICES.STATE.ROTEIRO - 1;
    const collectedColIdx = COLUMN_INDICES.STATE.RECOLHIDAS - 1;
    
    const routeString = Array.isArray(routeBikes) ? [...new Set(routeBikes.map(b => String(b).trim()))].filter(Boolean).join(', ') : '';
    const collectedString = Array.isArray(collectedBikes) ? [...new Set(collectedBikes.map(b => String(b).trim()))].filter(Boolean).join(', ') : '';
    const bikesToClean = Array.isArray(collectedBikes) ? collectedBikes.map(b => String(b).trim()).filter(Boolean) : [];

    let driverFound = false;
    let changed = false;

    for (let i = 0; i < dataRows.length; i++) {
      const currentDriver = String(dataRows[i][driverColIdx]).trim();
      
      if (currentDriver.toLowerCase() === String(driverName).trim().toLowerCase()) {
        // Atualiza o motorista atual
        dataRows[i][routeColIdx] = routeString;
        dataRows[i][collectedColIdx] = collectedString;
        driverFound = true;
        changed = true;
      } else if (bikesToClean.length > 0) {
        // GARANTIA DE UNICIDADE: Remove as bikes recolhidas de qualquer outro motorista
        let otherRoute = String(dataRows[i][routeColIdx] || '').split(',').map(s => s.trim()).filter(Boolean);
        let otherCollected = String(dataRows[i][collectedColIdx] || '').split(',').map(s => s.trim()).filter(Boolean);
        
        let rowChanged = false;
        bikesToClean.forEach(bike => {
          const rIdx = otherRoute.indexOf(bike);
          if (rIdx !== -1) {
            otherRoute.splice(rIdx, 1);
            rowChanged = true;
          }
          const cIdx = otherCollected.indexOf(bike);
          if (cIdx !== -1) {
            otherCollected.splice(cIdx, 1);
            rowChanged = true;
          }
        });
        
        if (rowChanged) {
          dataRows[i][routeColIdx] = otherRoute.join(', ');
          dataRows[i][collectedColIdx] = otherCollected.join(', ');
          changed = true;
        }
      }
    }

    if (!driverFound) {
      const newRow = new Array(headers.length).fill('');
      newRow[driverColIdx] = driverName;
      newRow[routeColIdx] = routeString;
      newRow[collectedColIdx] = collectedString;
      sheet.appendRow(newRow);
    } else if (changed) {
      // Grava tudo de volta em uma única operação se houve mudanças
      sheet.getRange(2, 1, dataRows.length, headers.length).setValues(dataRows);
    }

    return { success: true };
  } catch (e) {
    console.error("Erro em updateDriverState:", e);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}


function getDailyReportData(driverName, timeRange = 'day') {
    const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    if (!reportSheet) throw new Error(`Planilha "${REPORT_SHEET_NAME}" não encontrada.`);
    const requestSheet = ss.getSheetByName(REQUESTS_SHEET_NAME);
    if (!requestSheet) throw new Error(`Planilha "${REQUESTS_SHEET_NAME}" não encontrada.`);

    // Configuração de data baseada no timeRange
    const filterDate = new Date();
    filterDate.setHours(0, 0, 0, 0);
    
    if (timeRange === 'week') {
      const day = filterDate.getDay();
      const diff = filterDate.getDate() - day + (day === 0 ? -6 : 1);
      filterDate.setDate(diff);
    } else if (timeRange === 'month') {
      filterDate.setDate(1);
    }

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Get station names for comparison
    const stationSheet = ss.getSheetByName(STATIONS_SHEET_NAME);
    const stationNames = [];
    if (stationSheet && stationSheet.getLastRow() > 1) {
      const stationData = stationSheet.getRange(2, COLUMN_INDICES.STATIONS.NAME, stationSheet.getLastRow() - 1, 1).getValues();
      stationData.forEach(row => {
        if (row[0]) {
          const name = row[0].toString().trim().toLowerCase();
          if (!name.includes('filial')) {
            stationNames.push(name);
          }
        }
      });
    }

    const report = {
        recolhidas: [],
        remanejadas: [],
        estacoes: {}, // { stationName: count }
        ocorrencias: [],
        naoEncontrada: [],
        naoAtendida: [],
        vandalizadas: [],
        totalKmRodado: 0,
        platesUsed: new Set(),
        startTime: null,
        endTime: null,
        counts: {
          bateriaBaixa: 0,
          manutencaoBicicleta: 0,
          manutencaoLocker: 0,
          solicitadoRecolha: 0
        }
    };

    // Estrutura para calcular KM por sessão (INICIO -> FIM)
    const sessions = {}; // { plate: [ { inicio: KM, fim: KM } ] }

    // Processa a aba Relatorio
    const lastRowReport = reportSheet.getLastRow();
    if (lastRowReport > 1) {
        const lastColReport = reportSheet.getLastColumn();
        const reportData = reportSheet.getRange(2, 1, lastRowReport - 1, lastColReport).getValues();
        reportData.forEach(row => {
            const timestamp = new Date(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
            const motorista = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();

            if (motorista.toLowerCase() === driverName.toLowerCase() && timestamp >= filterDate && timestamp <= todayEnd) {
                if (!report.startTime || timestamp < report.startTime) report.startTime = timestamp;
                if (!report.endTime || timestamp > report.endTime) report.endTime = timestamp;
                const patrimonio = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
                const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
                const statusLower = status.toLowerCase();
                const observacao = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();

                // Lógica de KM
                if (status === 'INICIO_TURNO') {
                  const km = parseFloat(observacao) || 0;
                  if (!sessions[patrimonio]) sessions[patrimonio] = [];
                  sessions[patrimonio].push({ inicio: km, fim: null });
                  report.platesUsed.add(patrimonio);
                } else if (status === 'FIM_TURNO') {
                  const km = parseFloat(observacao.replace('KM Final: ', '')) || 0;
                  if (sessions[patrimonio]) {
                    // Procura a última sessão sem fim para esta placa
                    for (let i = sessions[patrimonio].length - 1; i >= 0; i--) {
                      if (sessions[patrimonio][i].fim === null) {
                        sessions[patrimonio][i].fim = km;
                        break;
                      }
                    }
                  }
                  report.platesUsed.add(patrimonio);
                }

                if (statusLower.includes('filial') || statusLower === 'vandalizada') {
                    report.recolhidas.push(patrimonio);
                    if (statusLower === 'vandalizada') {
                        report.vandalizadas.push(patrimonio);
                    }
                    
                    // Contabiliza sub-status da Filial baseado na observação
                    const obsLower = observacao.toLowerCase();
                    if (obsLower.includes('bateria baixa')) {
                        report.counts.bateriaBaixa++;
                    } else if (obsLower.includes('manutenção bicicleta') || obsLower.includes('manutencao bicicleta')) {
                        report.counts.manutencaoBicicleta++;
                    } else if (obsLower.includes('manutenção locker') || obsLower.includes('manutencao locker')) {
                        report.counts.manutencaoLocker++;
                    } else if (obsLower.includes('solicitado recolha')) {
                        report.counts.solicitadoRecolha++;
                    }
                } else if (statusLower === 'estação' || statusLower === 'estacao') {
                    report.remanejadas.push(patrimonio);
                    const stationName = (observacao || 'Estação').toString().trim();
                    report.estacoes[stationName] = (report.estacoes[stationName] || 0) + 1;
                } else if (statusLower === 'não encontrada' || statusLower === 'nao encontrada') {
                    report.naoEncontrada.push(patrimonio);
                } else if (statusLower === 'não atendida' || statusLower === 'nao atendida') {
                    report.naoAtendida.push(patrimonio);
                }
            }
        });
    }

    // Calcula total de KM rodado somando todas as sessões completas
    Object.keys(sessions).forEach(plate => {
      sessions[plate].forEach(session => {
        if (session.inicio !== null && session.fim !== null) {
          const diff = session.fim - session.inicio;
          if (diff > 0) {
            report.totalKmRodado += diff;
          }
        }
      });
    });

    // Processa a aba Solicitacao para Ocorrências (apenas para a lista de ocorrências, os contadores agora vêm do Relatório)
    if (requestSheet.getLastRow() > 1) {
        const requestData = requestSheet.getRange(2, 1, requestSheet.getLastRow() - 1, requestSheet.getLastColumn()).getValues();
        requestData.forEach(row => {
            const acceptedBy = (row[COLUMN_INDICES.REQUESTS.ACEITA_POR - 1] || '').toString().trim();
            const acceptedDate = row[COLUMN_INDICES.REQUESTS.ACEITA_DATA - 1];
            const local = (row[COLUMN_INDICES.REQUESTS.LOCAL - 1] || '').toString().trim();

            if ((acceptedBy || '').toString().trim().toLowerCase() === (driverName || '').toString().trim().toLowerCase() && acceptedDate) {
                const timestamp = new Date(acceptedDate);
                if (timestamp >= filterDate && timestamp <= todayEnd) {
                    const patrimonio = (row[COLUMN_INDICES.REQUESTS.PATRIMONIO - 1] || '').toString().trim();
                    const ocorrencia = (row[COLUMN_INDICES.REQUESTS.OCORRENCIA - 1] || '').toString().trim();

                    if (!local.toLowerCase().includes('roteiro')) {
                        report.ocorrencias.push(`${patrimonio}: ${ocorrencia}`);
                    }
                }
            }
        });
    }

    report.platesUsed = Array.from(report.platesUsed);

    return { success: true, data: report };
}

function getRouteDetails(driverName, bikeNumbers, providedBikesSheet, providedRequestsSheet) {
  if (!bikeNumbers || bikeNumbers.length === 0) return { success: true, data: {} };
  
  const bikesSheet = providedBikesSheet || ss.getSheetByName(BIKES_SHEET_NAME);
  const requestsSheet = providedRequestsSheet || ss.getSheetByName(REQUESTS_SHEET_NAME);
  
  if (!bikesSheet || !requestsSheet) throw new Error("Planilhas não encontradas.");

  const bikesData = bikesSheet.getDataRange().getValues();
  const requestsData = requestsSheet.getDataRange().getValues();
  
  const bikeNumberSet = new Set(bikeNumbers.map(String));
  const result = {};

  // Get current data from BIKES sheet
  bikesData.forEach((row, idx) => {
    if (idx === 0) return;
    const patrimonio = String(row[COLUMN_INDICES.BIKES.PATRIMONIO - 1]).trim();
    if (bikeNumberSet.has(patrimonio)) {
      result[patrimonio] = {
        bikeNumber: patrimonio,
        currentLat: parseCoordinate(row[COLUMN_INDICES.BIKES.LATITUDE - 1]),
        currentLng: parseCoordinate(row[COLUMN_INDICES.BIKES.LONGITUDE - 1]),
        battery: row[COLUMN_INDICES.BIKES.BATERIA - 1],
        initialLat: null,
        initialLng: null
      };
    }
  });

  // Get initial data from REQUESTS sheet
  // We look for the most recent 'Aceita' request for each bike by this driver
  for (let i = requestsData.length - 1; i >= 1; i--) {
    const patrimonioRaw = String(requestsData[i][COLUMN_INDICES.REQUESTS.PATRIMONIO - 1]).trim();
    const acceptedBy = String(requestsData[i][COLUMN_INDICES.REQUESTS.ACEITA_POR - 1]).trim().toLowerCase();
    const situacao = String(requestsData[i][COLUMN_INDICES.REQUESTS.SITUACAO - 1]).trim().toLowerCase();
    
    // Trata casos onde há múltiplas bikes na mesma solicitação (separadas por vírgula)
    const rowBikes = patrimonioRaw.split(',').map(s => s.trim()).filter(Boolean);
    
    rowBikes.forEach(patrimonio => {
      if (bikeNumberSet.has(patrimonio) && acceptedBy === driverName.toLowerCase() && situacao === 'aceita') {
        if (result[patrimonio] && result[patrimonio].initialLat === null) {
          const local = String(requestsData[i][COLUMN_INDICES.REQUESTS.LOCAL - 1]);
          const coordsMatch = local.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
          if (coordsMatch) {
            result[patrimonio].initialLat = parseCoordinate(coordsMatch[1]);
            result[patrimonio].initialLng = parseCoordinate(coordsMatch[2]);
          }
        }
      }
    });
  }

  return { success: true, data: result };
}

function getSchedule(driverName) {
  try {
    const sheet = ss.getSheetByName('Escala');
    if (!sheet) return { success: false, error: 'Aba "Escala" não encontrada.' };
    
    const range = sheet.getDataRange();
    const values = range.getValues(); // Use display values for exact text from spreadsheet
    if (values.length < 2) return { success: true, data: {} };
    
    const headers = values[0];
    const driverColumnIndex = headers.findIndex(h => h.toString().trim().toLowerCase() === 'motorista');
    if (driverColumnIndex === -1) return { success: false, error: 'Coluna "Motorista" não encontrada na aba Escala.' };
    
    const schedule = {};
    const driverNameLower = (driverName || '').trim().toLowerCase();
    
    for (let i = 1; i < values.length; i++) {
      const rowDriver = (values[i][driverColumnIndex] || '').trim().toLowerCase();
      if (rowDriver === driverNameLower) {
        for (let j = 0; j < headers.length; j++) {
          if (j === driverColumnIndex) continue;
          
          let header = headers[j].toString().trim();
          if (header) {
            let val1 = (values[i][j] || '').toString().trim();
            // Check if next column belongs to this day (empty header)
            let val2 = (j + 1 < headers.length && !headers[j+1].toString().trim()) ? (values[i][j+1] || '').toString().trim() : '';
            
            // Clean up common time formats if they have seconds (e.g. 08:00:00 -> 08:00)
            const cleanTime = (t) => {
              if (!t) return '';
              // Match HH:MM:SS and convert to HH:MM
              const timeMatch = t.match(/^(\d{1,2}:\d{2}):\d{2}$/);
              if (timeMatch) return timeMatch[1];
              return t;
            };

            val1 = cleanTime(val1);
            val2 = cleanTime(val2);
            
            let combined = val1;
            if (val2 && val2 !== val1) {
              combined += ' - ' + val2;
            }
            
            if (combined) {
              schedule[header] = combined;
            }
          }
        }
        break;
      }
    }
    
    return { success: true, data: schedule };
  } catch (error) {
    return { success: false, error: 'Erro ao buscar escala: ' + error.message };
  }
}

function getBikeStatuses(providedStateSheet, providedReportSheet) {
  try {
    const stateSheet = providedStateSheet || ss.getSheetByName(STATE_SHEET_NAME);
    const reportSheet = providedReportSheet || ss.getSheetByName(REPORT_SHEET_NAME);
    const conflicts = {};
    const now = new Date().getTime();
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

    // 1. Check Routes and Possession in STATE sheet
    if (stateSheet) {
      const stateData = stateSheet.getDataRange().getValues();
      for (let i = 1; i < stateData.length; i++) {
        const driver = stateData[i][COLUMN_INDICES.STATE.MOTORISTA - 1];
        if (!driver) continue;
        
        const routeStr = (stateData[i][COLUMN_INDICES.STATE.ROTEIRO - 1] || '').toString();
        const collectedStr = (stateData[i][COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString();
        
        const routeBikes = routeStr.split(',').map(s => s.trim()).filter(Boolean);
        const collectedBikes = collectedStr.split(',').map(s => s.trim()).filter(Boolean);

        routeBikes.forEach(bike => {
          if (!conflicts[bike]) conflicts[bike] = { drivers: [], status: '', recentAction: '' };
          if (!conflicts[bike].drivers.includes(driver)) {
            conflicts[bike].drivers.push(driver);
          }
        });

        collectedBikes.forEach(bike => {
          if (!conflicts[bike]) conflicts[bike] = { drivers: [], status: '', recentAction: '' };
          const driverLabel = driver + " (Em Posse)";
          if (!conflicts[bike].drivers.includes(driverLabel)) {
             conflicts[bike].drivers.push(driverLabel);
          }
        });
      }
    }

    // 2. Check Relatorio for recent actions and system status
    if (reportSheet) {
      const lastRow = reportSheet.getLastRow();
      if (lastRow > 1) {
        const numRows = Math.min(lastRow - 1, 300);
        const lastCol = reportSheet.getLastColumn();
        const reportData = reportSheet.getRange(lastRow - numRows + 1, 1, numRows, lastCol).getValues();
        
        for (let i = reportData.length - 1; i >= 0; i--) {
          const row = reportData[i];
          const timestamp = new Date(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]).getTime();
          const bike = row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1].toString();
          const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().toUpperCase();
          const motorista = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString();
          const systemStatus = (row[COLUMN_INDICES.REPORTS.STATUS_SISTEMA - 1] || '').toString().toUpperCase();
          
          if (!conflicts[bike]) conflicts[bike] = { drivers: [], status: '', recentAction: '' };
          
          if (!conflicts[bike].status && ['VANDALIZADA', 'MANUTENÇÃO', 'ROUBADA'].includes(systemStatus)) {
            conflicts[bike].status = systemStatus;
          }

          if (!conflicts[bike].recentAction && (now - timestamp < FOUR_HOURS_MS)) {
             if (status.includes('FILIAL') || status === 'ESTAÇÃO' || status === 'ESTACAO') {
                conflicts[bike].recentAction = `${motorista} (${status})`;
             }
          }
        }
      }
    }

    return { success: true, data: conflicts };
  } catch (error) {
    return { success: false, error: 'Erro ao buscar status das bikes: ' + error.message };
  }
}

function getReporData() {
  try {
    const sheet = ss.getSheetByName(REPOR_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Aba "Repor" não encontrada.' };
    
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return { success: true, data: [] };
    
    const lastCol = sheet.getLastColumn();
    const allValues = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    
    // Detectar se a primeira linha é cabeçalho
    const firstRow = allValues[0];
    const isHeader = isNaN(Number(firstRow[0])) && firstRow[1] && isNaN(Number(firstRow[1]));
    
    let headers = [];
    let startIdx = 0;
    
    if (isHeader) {
      headers = firstRow.map(h => (h || '').toString().trim());
      startIdx = 1;
    } else {
      // Cabeçalhos padrão baseados na imagem do usuário
      headers = ['ID', 'Estação', 'Ocupação', 'Porcentagem'];
      // Preencher o restante se houver mais colunas
      for (let i = 4; i < lastCol; i++) headers.push(`Coluna ${i + 1}`);
      startIdx = 0;
    }
    
    const data = [];
    for (let i = startIdx; i < allValues.length; i++) {
      const rowObj = {};
      let hasContent = false;
      headers.forEach((header, index) => {
        const key = header || `Coluna ${index + 1}`;
        const val = allValues[i][index];
        rowObj[key] = val;
        if (val && (val || '').toString().trim() !== "") hasContent = true;
      });
      if (hasContent) data.push(rowObj);
    }
    
    return { success: true, data: data };
  } catch (error) {
    return { success: false, error: 'Erro ao buscar dados de reposição: ' + error.message };
  }
}

function getChangeStatusData(timeRange = '24h', providedSheets = null) {
  try {
    const reportSheet = providedSheets ? providedSheets.report : ss.getSheetByName(REPORT_SHEET_NAME);
    const stationSheet = providedSheets ? providedSheets.stations : ss.getSheetByName(STATIONS_SHEET_NAME);
    const bikeSheet = providedSheets ? providedSheets.bikes : ss.getSheetByName(BIKES_SHEET_NAME);
    
    if (!reportSheet) return { success: true, data: { vandalizadas: [], filial: [] } };

    // 1. Get station names to exclude
    const stationNames = [];
    if (stationSheet && stationSheet.getLastRow() > 1) {
      const stationData = stationSheet.getRange(2, COLUMN_INDICES.STATIONS.NAME, stationSheet.getLastRow() - 1, 1).getValues();
      stationData.forEach(row => {
        if (row[0]) stationNames.push(row[0].toString().trim().toLowerCase());
      });
    }

    // 2. Get current bike statuses from Bicicletas sheet
    const bikeStatuses = {};
    if (bikeSheet && bikeSheet.getLastRow() > 1) {
      const bikeData = bikeSheet.getRange(2, 1, bikeSheet.getLastRow() - 1, bikeSheet.getLastColumn()).getValues();
      bikeData.forEach(row => {
        const patrimonio = (row[COLUMN_INDICES.BIKES.PATRIMONIO - 1] || '').toString().trim().replace(/^0+/, '');
        const status = (row[COLUMN_INDICES.BIKES.STATUS - 1] || '').toString().trim();
        if (patrimonio) bikeStatuses[patrimonio] = status;
      });
    }

    // 3. Calculate cutoff date
    const now = new Date();
    const cutoffDate = new Date();
    if (timeRange === '48h') {
      cutoffDate.setHours(now.getHours() - 48);
    } else if (timeRange === '72h') {
      cutoffDate.setHours(now.getHours() - 72);
    } else if (timeRange === 'week') {
      cutoffDate.setDate(now.getDate() - 7);
    } else {
      cutoffDate.setHours(now.getHours() - 24);
    }

    // 4. Get report data
    const lastRow = reportSheet.getLastRow();
    if (lastRow < 2) return { success: true, data: { vandalizadas: [], filial: [] } };
    
    const data = reportSheet.getRange(2, 1, lastRow - 1, reportSheet.getLastColumn()).getValues();
    
    // Track the MOST RECENT report for each bike
    const lastReports = {};

    data.forEach(row => {
      const timestamp = new Date(row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      if (isNaN(timestamp.getTime()) || timestamp < cutoffDate) return;

      let patrimonio = (row[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim().replace(/^0+/, '');
      if (!patrimonio) return;

      const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
      const statusLower = status.toLowerCase();
      const observacao = (row[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
      const observacaoLower = observacao.toLowerCase();

      // Se o status for "ESTAÇÃO", o nome da estação está na observação
      const effectiveStatus = (statusLower === 'estação' || statusLower === 'estacao') ? observacaoLower : statusLower;

      // Update if this report is newer than what we have
      if (!lastReports[patrimonio] || timestamp > lastReports[patrimonio].timestamp) {
        lastReports[patrimonio] = {
          timestamp: timestamp,
          status: effectiveStatus
        };
      }
    });

    const vandalizadas = new Set();
    const filial = new Set();

    Object.keys(lastReports).forEach(patrimonio => {
      const lastReport = lastReports[patrimonio];
      const currentStatus = bikeStatuses[patrimonio] || '';
      
      // Se o último relatório for Manutenção ou Ativo, ignoramos (já processado)
      if (lastReport.status === 'manutenção' || lastReport.status === 'manutencao' || lastReport.status === 'ativo') {
        return;
      }

      // Exclude station names
      if (stationNames.includes(lastReport.status)) return;
      
      // Exclude "Não encontrada"
      if (lastReport.status === 'não encontrada' || lastReport.status === 'nao encontrada') return;

      if (lastReport.status === 'vandalizada') {
        if (currentStatus !== 'Vandalizada' && currentStatus !== 'Manutenção') {
          vandalizadas.add(patrimonio);
        }
      } else if (lastReport.status.includes('filial')) {
        if (currentStatus !== 'Manutenção') {
          filial.add(patrimonio);
        }
      }
    });

    return { 
      success: true, 
      data: { 
        vandalizadas: Array.from(vandalizadas).sort((a, b) => parseInt(a) - parseInt(b)), 
        filial: Array.from(filial).sort((a, b) => parseInt(a) - parseInt(b))
      } 
    };
  } catch (e) {
    return { success: false, error: "Erro ao buscar dados de status: " + e.message };
  }
}

function switchVehicle(driverName, plate, kmInicial) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
    if (!sheet) throw new Error(`Planilha "${ACCESS_SHEET_NAME}" não encontrada.`);

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, error: 'Nenhum usuário cadastrado.' };

    const dataRange = sheet.getRange(2, 1, lastRow - 1, 1);
    const values = dataRange.getValues();

    let foundRowIndex = -1;
    for (let i = 0; i < values.length; i++) {
      if (values[i][0].toString().trim().toLowerCase() === driverName.toLowerCase()) {
        foundRowIndex = i;
        break;
      }
    }
    
    if (foundRowIndex === -1) {
      return { success: false, error: `Motorista "${driverName}" não encontrado.` };
    }

    const rowIndexInSheet = foundRowIndex + 2; 

    // REMOVIDO: Validação estrita de KM Inicial contra o último KM Final registrado.
    // O motorista deve digitar o que vê no painel.
    
    // Atualiza o KM na linha do VEÍCULO (independente do motorista)
    updateVehicleKm(plate, kmInicial, undefined);

    // Registra INICIO_TURNO na aba de Relatórios para histórico e soma de KM
    const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
    if (reportSheet) {
      const now = new Date();
      const timestamp = formatDateTime(now);
      // Colunas: Timestamp, Patrimonio(Placa), Status(INICIO_TURNO), Observacao(KM), Motorista
      reportSheet.appendRow([timestamp, plate, 'INICIO_TURNO', kmInicial, driverName]);
    }

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function getVehicleKmFinal(plate) {
  const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
  if (!sheet) return null;
  
  let vehicleRowIndex = -1;
  const plateUpper = plate.toString().trim().toUpperCase();
  
  if (plateUpper === 'SYS4J63') {
    vehicleRowIndex = 2;
  } else if (plateUpper === 'TEG7C35') {
    vehicleRowIndex = 3;
  } else if (plateUpper === 'TEMA047') {
    vehicleRowIndex = 4;
  } else {
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const plates = sheet.getRange(2, COLUMN_INDICES.ACCESS.PLACA, lastRow - 1, 1).getValues();
      for (let i = 0; i < plates.length; i++) {
        if (plates[i][0].toString().trim().toUpperCase() === plateUpper) {
          const userVal = sheet.getRange(i + 2, COLUMN_INDICES.ACCESS.USUARIO).getValue();
          if (!userVal || userVal.toString().trim() === "") {
            vehicleRowIndex = i + 2;
            break;
          }
        }
      }
    }
  }
  
  if (vehicleRowIndex !== -1) {
    return sheet.getRange(vehicleRowIndex, COLUMN_INDICES.ACCESS.KM_FINAL).getValue();
  }
  return null;
}

function updateVehicleKm(plate, kmInicial, kmFinal) {
  const sheet = ss.getSheetByName(ACCESS_SHEET_NAME);
  if (!sheet) return;
  
  let vehicleRowIndex = -1;
  const plateUpper = plate.toString().trim().toUpperCase();
  
  // Mapeamento de linhas fixas para placas específicas (conforme solicitado pelo usuário)
  if (plateUpper === 'SYS4J63') {
    vehicleRowIndex = 2;
  } else if (plateUpper === 'TEG7C35') {
    vehicleRowIndex = 3;
  } else if (plateUpper === 'TEMA047') {
    vehicleRowIndex = 4;
  } else {
    // Fallback para busca dinâmica se não for uma das placas fixas
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const plates = sheet.getRange(2, COLUMN_INDICES.ACCESS.PLACA, lastRow - 1, 1).getValues();
      for (let i = 0; i < plates.length; i++) {
        const p = plates[i][0].toString().trim().toUpperCase();
        if (p === plateUpper) {
          // Verifica se a coluna A (USUARIO) está vazia para garantir que é a linha do veículo
          const userVal = sheet.getRange(i + 2, COLUMN_INDICES.ACCESS.USUARIO).getValue();
          if (!userVal || userVal.toString().trim() === "") {
            vehicleRowIndex = i + 2;
            break;
          }
        }
      }
    }
  }
  
  if (vehicleRowIndex !== -1) {
    if (kmInicial !== undefined) {
      sheet.getRange(vehicleRowIndex, COLUMN_INDICES.ACCESS.KM_INICIAL).setValue(kmInicial);
    }
    
    if (kmFinal !== undefined) {
      sheet.getRange(vehicleRowIndex, COLUMN_INDICES.ACCESS.KM_FINAL).setValue(kmFinal);
      
      // Calcula diferença se ambos existirem
      const currentKmInicial = sheet.getRange(vehicleRowIndex, COLUMN_INDICES.ACCESS.KM_INICIAL).getValue();
      if (currentKmInicial !== '' && kmFinal !== '') {
        const diff = parseFloat(kmFinal) - parseFloat(currentKmInicial);
        sheet.getRange(vehicleRowIndex, COLUMN_INDICES.ACCESS.KM_DIFERENCA).setValue(diff);
      }
    } else {
      // Se estamos iniciando, limpamos o KM Final e a Diferença
      sheet.getRange(vehicleRowIndex, COLUMN_INDICES.ACCESS.KM_FINAL).setValue('');
      sheet.getRange(vehicleRowIndex, COLUMN_INDICES.ACCESS.KM_DIFERENCA).setValue('');
    }
  }
}

function getDriversSummary(timeRange = 'day', providedSheets = null) {
  try {
    const accessSheet = providedSheets ? providedSheets.access : ss.getSheetByName(ACCESS_SHEET_NAME);
    const reportSheet = providedSheets ? providedSheets.report : ss.getSheetByName(REPORT_SHEET_NAME);
    const stateSheet = providedSheets ? providedSheets.state : ss.getSheetByName(STATE_SHEET_NAME);
    const requestsSheet = providedSheets ? providedSheets.requests : ss.getSheetByName(REQUESTS_SHEET_NAME);
    const stationSheet = providedSheets ? providedSheets.stations : ss.getSheetByName(STATIONS_SHEET_NAME);

    if (!accessSheet || !reportSheet || !stateSheet || !requestsSheet) {
      throw new Error('Uma ou mais planilhas necessárias não foram encontradas.');
    }

    // 1. Get all drivers
    const lastRowAccess = accessSheet.getLastRow();
    if (lastRowAccess < 2) return { success: true, data: [] };
    
    const lastColAccess = accessSheet.getLastColumn();
    const driversData = accessSheet.getRange(2, 1, lastRowAccess - 1, lastColAccess).getValues();
    const drivers = [...new Set(driversData
      .filter(row => (row[COLUMN_INDICES.ACCESS.CATEGORIA - 1] || '').toString().toUpperCase().includes('MOTORISTA'))
      .map(row => row[COLUMN_INDICES.ACCESS.USUARIO - 1].toString().trim()))];

    // 2. Calculate date filter
    const now = new Date();
    const filterDate = new Date();
    filterDate.setHours(0, 0, 0, 0);

    if (timeRange === 'week') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
      filterDate.setDate(diff);
    } else if (timeRange === 'month') {
      filterDate.setDate(1); // First day of month
    }

    // 2.5 Get station names for comparison
    const stationNames = [];
    if (stationSheet && stationSheet.getLastRow() > 1) {
      const stationData = stationSheet.getRange(2, COLUMN_INDICES.STATIONS.NAME, stationSheet.getLastRow() - 1, 1).getValues();
      stationData.forEach(row => {
        if (row[0]) {
          const name = row[0].toString().trim().toLowerCase();
          // Não considerar como estação se o nome contiver "filial"
          if (!name.includes('filial')) {
            stationNames.push(name);
          }
        }
      });
    }

    const lastRowReport = reportSheet.getLastRow();
    const reportsData = lastRowReport > 1 ? reportSheet.getRange(2, 1, lastRowReport - 1, reportSheet.getLastColumn()).getValues() : [];
    
    const stats = {};
    drivers.forEach(d => {
      stats[d] = { recolhidas: 0, remanejada: 0, naoEncontrada: 0, naoAtendida: 0 };
    });

    reportsData.forEach(row => {
      const rowDate = row[COLUMN_INDICES.REPORTS.TIMESTAMP - 1];
      if (!rowDate) return;
      
      const timestamp = new Date(rowDate);
      if (isNaN(timestamp.getTime())) return;

      if (timestamp >= filterDate) {
        const driver = (row[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
        const status = (row[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
        const statusLower = status.toLowerCase();
        
        // Busca a chave do motorista ignorando case
        const driverKey = Object.keys(stats).find(k => k.toLowerCase() === driver.toLowerCase());

        if (driverKey) {
          if (statusLower.includes('filial') || statusLower === 'vandalizada') {
            stats[driverKey].recolhidas++;
          } else if (statusLower === 'estação' || statusLower === 'estacao') {
            stats[driverKey].remanejada++;
          } else if (statusLower === 'não encontrada' || statusLower === 'nao encontrada') {
            stats[driverKey].naoEncontrada++;
          } else if (statusLower === 'não atendida' || statusLower === 'nao atendida') {
            stats[driverKey].naoAtendida++;
          }
        }
      }
    });

    // 3. Get real-time state (route and collected)
    const lastRowState = stateSheet.getLastRow();
    const lastColState = stateSheet.getLastColumn();
    const stateData = stateSheet.getRange(2, 1, lastRowState - 1, lastColState).getValues();
    const realTime = {};
    stateData.forEach(row => {
      const driver = row[COLUMN_INDICES.STATE.MOTORISTA - 1];
      if (drivers.includes(driver)) {
        realTime[driver] = {
          route: (row[COLUMN_INDICES.STATE.ROTEIRO - 1] || '').toString().split(',').map(s => s.trim()).filter(s => s),
          collected: (row[COLUMN_INDICES.STATE.RECOLHIDAS - 1] || '').toString().split(',').map(s => s.trim()).filter(s => s)
        };
      }
    });

    // 4. Get pending requests count
    const lastRowRequests = requestsSheet.getLastRow();
    const lastColRequests = requestsSheet.getLastColumn();
    const requestsData = requestsSheet.getRange(2, 1, lastRowRequests - 1, lastColRequests).getValues();
    const pendingCounts = {};
    drivers.forEach(d => pendingCounts[d] = 0);

    requestsData.forEach(row => {
      const status = (row[COLUMN_INDICES.REQUESTS.SITUACAO - 1] || '').toLowerCase();
      if (status === 'pendente') {
        const recipient = (row[COLUMN_INDICES.REQUESTS.DESTINATARIO - 1] || '').toString().trim().toLowerCase();
        const declinedBy = (row[COLUMN_INDICES.REQUESTS.RECUSADA_POR - 1] || '').toString().split(',').map(s => s.trim().toLowerCase());
        
        drivers.forEach(d => {
          const dLower = d.toLowerCase();
          if ((recipient === 'todos' || recipient === dLower) && !declinedBy.includes(dLower)) {
            pendingCounts[d]++;
          }
        });
      }
    });

    // Combine everything
    const summary = drivers.map(d => ({
      name: d,
      stats: stats[d],
      realTime: realTime[d] || { route: [], collected: [] },
      pendingRequests: pendingCounts[d]
    }));

    return { success: true, data: summary };
  } catch (error) {
    return { success: false, error: 'Erro ao gerar resumo dos motoristas: ' + error.message };
  }
}

function checkDivergences(rowData) {
  const patrimonio = rowData[COLUMN_INDICES.REPORTS.PATRIMONIO - 1];
  const status = (rowData[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
  const observacao = (rowData[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
  const motorista = (rowData[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
  const statusSistema = (rowData[COLUMN_INDICES.REPORTS.STATUS_SISTEMA - 1] || '').toString().trim();
  const bateriaRaw = rowData[COLUMN_INDICES.REPORTS.BATERIA - 1];
  const bVal = parseFloat(String(bateriaRaw).replace('%', '').replace(',', '.')) || 0;
  // Se o valor for <= 1, assumimos que é decimal (ex: 0.95 -> 95%, 1 -> 100%)
  // Se for > 1, assumimos que já é o percentual inteiro (ex: 95 -> 95%)
  const bateria = bVal <= 1 ? Math.round(bVal * 100) : Math.round(bVal);
  const localidade = (rowData[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim();

  const filiais = ['Filial', 'Serttel Filial SJC', 'Serttel Filial 1'];
  const isFilial = filiais.some(f => localidade.toLowerCase().includes(f.toLowerCase()));

  // 1. Filial Battery Discrepancy
  if (isFilial && bateria > 70) {
    const isException = observacao.toLowerCase().includes('manutenção') || 
                        observacao.toLowerCase().includes('manutencao') || 
                        observacao.toLowerCase().includes('solicitação') ||
                        observacao.toLowerCase().includes('solicitacao');
    if (!isException) {
      addDivergenceNotification(`Bike ${patrimonio}: Bateria alta na Filial (${bateria}%).`, motorista, patrimonio);
    }
  }

  if (!isFilial && bateria <= 50 && localidade !== '' && !localidade.toLowerCase().includes('fora da estação')) {
     addDivergenceNotification(`Bike ${patrimonio}: Bateria baixa em ${localidade} (${bateria}%).`, motorista, patrimonio);
  }

  // 2. Station Status
  const isStation = !isFilial && localidade !== '' && !localidade.toLowerCase().includes('fora da estação');
  if (isStation && statusSistema.toLowerCase() !== 'ativo') {
    addDivergenceNotification(`Bike ${patrimonio}: Status ${statusSistema} em ${localidade}.`, motorista, patrimonio);
  }
  
  if (localidade.toLowerCase().includes('fora da estação') && statusSistema.toLowerCase() !== 'ativo') {
    addDivergenceNotification(`Bike ${patrimonio}: Status ${statusSistema} (Fora da Estação).`, motorista, patrimonio);
  }

  // 3. Location Divergence (Column D vs Column I)
  const stations = getStations().data || [];
  const stationNames = stations.map(s => s.name);
  const obsLower = (observacao || '').toString().toLowerCase().trim();
  const locLower = (localidade || '').toString().toLowerCase().trim();

  const filialTerms = ['filial', 'serttel filial sjc'];
  const isObsFilial = filialTerms.some(term => obsLower.includes(term.toLowerCase()));
  const isLocFilial = filialTerms.some(term => locLower.includes(term.toLowerCase()));

  if (isObsFilial) {
    if (!isLocFilial) {
      addDivergenceNotification(`Divergência: Informado Filial, mas sistema indica ${localidade}`, motorista, patrimonio);
    }
  } else {
    const mentionedStation = stationNames.find(name => {
      const n = name.toLowerCase();
      return n.length > 3 && obsLower.includes(n);
    });

    if (mentionedStation) {
      if (!locLower.includes(mentionedStation.toLowerCase())) {
        addDivergenceNotification(`Divergência: Informado ${mentionedStation}, mas sistema indica ${localidade}`, motorista, patrimonio);
      }
    }
  }

  // 4. Duplicity
  const reportSheet = ss.getSheetByName(REPORT_SHEET_NAME);
  if (reportSheet) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastRow = reportSheet.getLastRow();
    if (lastRow > 1) {
      // Check last 200 rows for speed
      const startRow = Math.max(2, lastRow - 200);
      const numRows = lastRow - startRow + 1;
      const data = reportSheet.getRange(startRow, 1, numRows, 5).getValues();
      
      const duplicate = data.find(row => {
        if (!row[0]) return false;
        const rowDate = new Date(row[0]);
        rowDate.setHours(0, 0, 0, 0);
        return rowDate.getTime() === today.getTime() && 
               row[1].toString() === patrimonio.toString() && 
               row[2].toString().trim() === status &&
               row[0].toString() !== rowData[0].toString(); // Not the same entry
      });
      
      if (duplicate) {
        addAlertToAdms(`⚠️ DUPLICIDADE: Bike ${patrimonio} registrada como ${status} mais de uma vez hoje pelo motorista ${motorista}.`);
      }
    }
  }
}

function addDivergenceNotification(messageBase, driverName, patrimonio) {
  const accessSheet = ss.getSheetByName(ACCESS_SHEET_NAME);
  if (!accessSheet) return;

  // 1. Log to Divergencia sheet
  logDivergence(driverName, patrimonio, messageBase);

  // 2. Notify users via Notificacoes sheet
  const accessData = accessSheet.getDataRange().getValues();
  const adms = accessData
    .filter(row => (row[COLUMN_INDICES.ACCESS.CATEGORIA - 1] || '').toString().toUpperCase().includes('ADM'))
    .map(row => row[0]);

  const admMessage = `⚠️ DIVERGÊNCIA (${driverName}): ${messageBase}`;
  const driverMessage = `⚠️ ATENÇÃO: Identificamos uma inconsistência no seu relatório da bike ${patrimonio}. Por favor, verifique: ${messageBase}`;

  const notificationsMap = {};
  adms.forEach(admName => {
    notificationsMap[admName] = admMessage;
  });

  if (driverName) {
    notificationsMap[driverName] = driverMessage;
  }

  batchAddNotifications(notificationsMap);
}

function batchAddNotifications(notificationsMap) {
  let sheet = ss.getSheetByName(NOTIFICATIONS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(NOTIFICATIONS_SHEET_NAME);
    sheet.appendRow(['Usuário', 'Notificações (JSON)']);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#f3f3f3');
    sheet.setFrozenRows(1);
  }

  const data = sheet.getDataRange().getValues();
  const userRows = {};
  for (let i = 1; i < data.length; i++) {
    userRows[data[i][0]] = i + 1;
  }

  Object.keys(notificationsMap).forEach(userName => {
    const message = notificationsMap[userName];
    const rowIndex = userRows[userName];
    const notification = {
      msg: message,
      time: new Date().toISOString(),
      id: Utilities.getUuid()
    };

    if (!rowIndex) {
      sheet.appendRow([userName, JSON.stringify([notification])]);
    } else {
      let currentNotifs = [];
      try {
        const cellVal = sheet.getRange(rowIndex, COLUMN_INDICES.NOTIFICATIONS.JSON).getValue();
        currentNotifs = JSON.parse(cellVal || '[]');
      } catch (e) {
        currentNotifs = [];
      }
      
      const isDuplicate = currentNotifs.some(n => n.msg === message && (new Date().getTime() - new Date(n.time).getTime() < 60000));
      if (!isDuplicate) {
        currentNotifs.unshift(notification);
        if (currentNotifs.length > 50) currentNotifs = currentNotifs.slice(0, 50);
        sheet.getRange(rowIndex, COLUMN_INDICES.NOTIFICATIONS.JSON).setValue(JSON.stringify(currentNotifs));
      }
    }
  });
}

function logDivergence(driverName, patrimonio, message) {
  let sheet = ss.getSheetByName(DIVERGENCE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DIVERGENCE_SHEET_NAME);
    sheet.appendRow(['Data/Hora', 'Motorista', 'Patrimônio', 'Mensagem']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#f3f3f3');
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([new Date(), driverName, patrimonio, message]);
}

function appendNotificationToUser(userName, message) {
  const notificationsMap = {};
  notificationsMap[userName] = message;
  batchAddNotifications(notificationsMap);
}

function getAdminAlerts(adminName) {
  try {
    const sheet = ss.getSheetByName(NOTIFICATIONS_SHEET_NAME);
    if (!sheet) return { success: true, alerts: [] };
    
    const data = sheet.getDataRange().getValues();
    const adminNameLower = (adminName || '').toString().trim().toLowerCase();
    
    for (let i = 1; i < data.length; i++) {
      if ((data[i][0] || '').toString().trim().toLowerCase() === adminNameLower) {
        try {
          return { success: true, alerts: JSON.parse(data[i][COLUMN_INDICES.NOTIFICATIONS.JSON - 1] || '[]') };
        } catch (e) {
          return { success: true, alerts: [] };
        }
      }
    }
    return { success: true, alerts: [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function clearAdminAlerts(adminName) {
  try {
    const sheet = ss.getSheetByName(NOTIFICATIONS_SHEET_NAME);
    if (!sheet) return { success: true };
    
    const data = sheet.getDataRange().getValues();
    const adminNameLower = (adminName || '').toString().trim().toLowerCase();
    
    for (let i = 1; i < data.length; i++) {
      if ((data[i][0] || '').toString().trim().toLowerCase() === adminNameLower) {
        sheet.getRange(i + 1, COLUMN_INDICES.NOTIFICATIONS.JSON).setValue('[]');
        SpreadsheetApp.flush(); // Garante que a alteração foi gravada imediatamente
        return { success: true };
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Remove duplicatas recentes da aba de relatórios.
 * Verifica as últimas 100 linhas e exclui a segunda ocorrência de registros idênticos em curto intervalo.
 */
function cleanupRecentDuplicates() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = ss.getSheetByName(REPORT_SHEET_NAME);
    if (!sheet) return 0;
    
    const lastRow = sheet.getLastRow();
    if (lastRow < 3) return 0;
    
    // Aumentamos para 200 linhas para garantir que pegamos duplicatas mais antigas se necessário
    const numRows = Math.min(lastRow - 1, 200);
    const startRow = lastRow - numRows + 1;
    const data = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();
    const rowsToDelete = [];
    
    for (let i = data.length - 1; i >= 1; i--) {
      const current = data[i];
      const currentTimestamp = new Date(current[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
      const currentPatrimonio = (current[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
      const currentStatus = (current[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
      const currentObservacao = (current[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
      const currentLocalidade = (current[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim();
      const currentMotorista = (current[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
      
      if (!currentPatrimonio || isNaN(currentTimestamp.getTime())) continue;

      for (let j = i - 1; j >= 0; j--) {
        const prev = data[j];
        const prevTimestamp = new Date(prev[COLUMN_INDICES.REPORTS.TIMESTAMP - 1]);
        const prevPatrimonio = (prev[COLUMN_INDICES.REPORTS.PATRIMONIO - 1] || '').toString().trim();
        const prevStatus = (prev[COLUMN_INDICES.REPORTS.STATUS - 1] || '').toString().trim();
        const prevObservacao = (prev[COLUMN_INDICES.REPORTS.OBSERVACAO - 1] || '').toString().trim();
        const prevLocalidade = (prev[COLUMN_INDICES.REPORTS.LOCALIDADE - 1] || '').toString().trim();
        const prevMotorista = (prev[COLUMN_INDICES.REPORTS.MOTORISTA - 1] || '').toString().trim();
        
        const sameBike = (currentPatrimonio === prevPatrimonio);
        const sameStatus = (currentStatus === prevStatus);
        const sameDriver = (currentMotorista === prevMotorista);
        const samePlace = (currentObservacao === prevObservacao || currentLocalidade === prevLocalidade || 
                           (currentObservacao === prevLocalidade && currentObservacao !== "") || 
                           (currentLocalidade === prevObservacao && currentLocalidade !== ""));
        
        if (sameBike && sameStatus && samePlace && sameDriver) {
          const diffMinutes = Math.abs(currentTimestamp.getTime() - prevTimestamp.getTime()) / (1000 * 60);
          // Se for em menos de 10 minutos, consideramos duplicata
          if (diffMinutes < 10) {
            rowsToDelete.push(startRow + i);
            console.log(`Marcando linha ${startRow + i} para exclusão (duplicata de ${startRow + j})`);
            break;
          }
        }
      }
    }
    
    // Remove duplicatas da lista para não tentar excluir a mesma linha duas vezes
    const uniqueRowsToDelete = [...new Set(rowsToDelete)].sort((a, b) => b - a);
    
    uniqueRowsToDelete.forEach(row => {
      try {
        sheet.deleteRow(row);
      } catch (e) {
        console.error(`Erro ao excluir linha ${row}:`, e);
      }
    });
    
    if (uniqueRowsToDelete.length > 0) {
      SpreadsheetApp.flush();
    }
    
    return uniqueRowsToDelete.length;
  } finally {
    lock.releaseLock();
  }
}
