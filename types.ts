
export enum BikeStatus {
  Recolhida = 'Recolhida',
  NaoEncontrada = 'Não encontrada',
  NaoAtendida = 'Não atendida',
}

export enum FinalStatus {
  RemanejadaEstacao = 'Remanejada para Estação',
  RemanejadaFilial = 'Remanejada para Filial',
  Vandalizada = 'Vandalizada',
}

export interface User {
  name: string;
  category: string; 
  plate?: string;
  kmInicial?: number;
  kmFinal?: number;
}

export interface BicycleData {
  'Patrimônio': string;
  'Status': string;
  'Localidade': string;
  'Usuário': string;
  'Bateria': string;
  'Trava': string;
  'Carregamento': string;
  'Última informação da posição': string;
  'Latitude': number;
  'Longitude': number;
  [key: string]: any; 
}

/**
 * A estrutura do payload foi alterada para um método mais robusto.
 * Em vez de chaves baseadas nos nomes das colunas, enviamos um array 'rowData'
 * com os valores na ordem exata das colunas da planilha.
 * Isso evita problemas com caracteres especiais ou nomes de colunas.
 */
export interface ReportPayload {
  action: 'logReport';
  rowData: (string | null)[];
}

export interface PickupRequest {
  id: number; // ID único da solicitação (linha da planilha)
  bikeNumber: string;
  timestamp: string;
  status: string; 
  location: string; 
  reason: string; 
  acceptedBy?: string; 
  recipient?: string; 
  bikeData?: BicycleData; 
}

export interface DailyActivity {
  date: string;
  remanejadasEstacao: { bikeId: string; station: string; region: string }[];
  remanejadasFilial: string[];
  vandalizadas: string[];
  naoEncontradas: string[];
  ocorrencias: { bikeId: string; obs: string }[];
}

export interface Station {
  name: string;
  latitude: number;
  longitude: number;
  region: string;
  Occupancy?: string;
}

export interface DriverLocation {
    driverName: string;
    latitude: number;
    longitude: number;
    timestamp: string;
}