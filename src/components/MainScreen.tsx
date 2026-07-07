import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { BicycleData, PickupRequest, DriverLocation } from '../types';
import {
  LogoutIcon, PlusIcon, PlusPlusIcon, MapIcon, SheetIcon, SearchIcon,
  AlertIcon, CalendarIcon, CarIcon, XIcon, BicycleIcon, MovingIcon,
  UserIcon, AlertTriangleIcon, QrCodeIcon, TrailerIcon, SwitchIcon,
  DatabaseIcon, CheckCircleIcon, DocumentTextIcon, HistoryIcon,
  SteeringWheelIcon, SirenIcon, ZapIcon, EditIcon, TrashIcon
} from './icons';
import { 
  Settings, Battery, Lock, Map as LucideMap, 
  WifiOff, AlertCircle, RefreshCw, ChevronUp, ChevronDown, ChevronLeft, 
  ChevronRight, Circle, Play, Locate, Wrench, Loader2, TrendingUp, ExternalLink,
  Package, Plus, Minus, Inbox
} from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { auth, db } from '../firebase';

import {
  collection, onSnapshot, doc, updateDoc, addDoc, getDocs, deleteDoc,
  serverTimestamp, setDoc, query, where, limit, getDocFromServer, getDoc,
  Timestamp
} from 'firebase/firestore';
import ScheduleModal from './ScheduleModal';
import ReporModal from './ReporModal';
import MechanicRepairModal from './MechanicRepairModal';
import MechanicSelectionModal from './MechanicSelectionModal';
import TrailerSelectionModal from './TrailerSelectionModal';
import DriverSelectionModal from './DriverSelectionModal';
import RequestModal from './RequestModal';
import ReportModal from './ReportModal';
import RouteModal from './RouteModal';
import DestinationModal from './DestinationModal';
import HistoryModal from './HistoryModal';
import VehicleSwitchModal from './VehicleSwitchModal';
import EditDriverModal from './EditDriverModal';
import FirebaseReportModal from './FirebaseReportModal';
import { AnalyticalDashboard } from './AnalyticalDashboard';
import { apiCall, apiGetCall, clearCache } from '../api';
import { User } from '../types';


// =================================================================
// REGRA DE SINCRONIZAÇÃO
//
// Ação do motorista no app:
//   1. Atualiza estado local imediatamente (otimista)
//   2. Grava no Firebase (fonte de verdade em tempo real)
//   3. Envia para Sheets em paralelo (não bloqueia o motorista)
//   4. Registra lastDriverActionAt = Date.now()
//
// Sync periódico do Sheets (a cada 10s):
//   - SÓ aplica driverState do Sheets se NÃO houver ação recente do motorista
//   - "Recente" = menos de DRIVER_ACTION_GRACE_MS milissegundos
//   - Se o ADM editou a planilha E não há ação recente, aplica normalmente
//
// Listener Firestore:
//   - Sempre aplica se não há operação ativa (isUpdatingStateRef)
//   - Ignora updates com flag sheetsSync=true (vieram do próprio sync — evita loop)
// =================================================================

// Janela de proteção após ação do motorista (ms).
// Durante esse período, o sync do Sheets não sobrescreve o estado local.
const DRIVER_ACTION_GRACE_MS = 300000; // 300 segundos (5 minutos) — margem maior para latência do Sheets e evitar retorno de bikes finalizadas

interface MainScreenProps {
  driverName: string;
  category: string;
  plate?: string;
  kmInicial?: number;
  onLogout: () => void;
  onShowMap: () => void;
  onUpdateUser: (updates: Partial<User>) => void;
}

const ZoneButton = ({ id, icon, label, config, setConfig }: { id: string, icon: React.ReactNode, label: string, config: any, setConfig: any }) => (
  <button
    onClick={() => setConfig((prev: any) => ({ ...prev, selectedZone: id }))}
    className={`flex flex-col items-center justify-center h-8 w-8 rounded-md border transition-all ${
      config.selectedZone === id 
        ? 'bg-blue-600 text-white border-blue-600 shadow-sm' 
        : 'bg-gray-50 text-gray-400 border-gray-100 hover:bg-gray-100'
    }`}
  >
    <div className="scale-90">{icon}</div>
    <span className="text-[7px] font-bold leading-none mt-0.5">{label}</span>
  </button>
);

// =================================================================
// HELPERS
// =================================================================
const normalizeCoord = (coord: number): number => {
  if (isNaN(coord) || coord === null) return coord;
  let val = coord;
  if (Math.abs(val) > 180) {
    while (Math.abs(val) > 180) val /= 10;
  }
  
  // Auto-healing para erros comuns de digitação em planilhas (esquecer o sinal de menos)
  // No Brasil (região de operação no Sudeste/SP):
  // Latitudes positivas entre 15 e 35 convertidas para negativas
  // Longitudes positivas entre 35 e 75 convertidas para negativas
  if (val > 15 && val < 35) {
    val = -val;
  } else if (val > 35 && val < 75) {
    val = -val;
  }
  return val;
};

const normalizeForSearch = (name: string) => {
  if (!name) return '';
  return String(name).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
};

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = (normalizeCoord(lat2) - normalizeCoord(lat1)) * (Math.PI / 180);
  const dLon = (normalizeCoord(lon2) - normalizeCoord(lon1)) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(normalizeCoord(lat1) * Math.PI / 180)
    * Math.cos(normalizeCoord(lat2) * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getDistanceInMeters = (lat1: number, lon1: number, lat2: number, lon2: number) =>
  calculateDistance(lat1, lon1, lat2, lon2) * 1000;

const STATUS_COLORS: Record<string, { bg: string; border: string; textLabel: string; textVal: string }> = {
  blue: {
    bg: 'bg-sky-50/70',
    border: 'border-sky-200/50',
    textLabel: 'text-sky-600 font-bold',
    textVal: 'text-sky-800 font-black'
  },
  green: {
    bg: 'bg-emerald-50/70',
    border: 'border-emerald-200/50',
    textLabel: 'text-emerald-600 font-bold',
    textVal: 'text-emerald-900 font-black'
  },
  indigo: {
    bg: 'bg-violet-50/70',
    border: 'border-violet-200/50',
    textLabel: 'text-violet-600 font-bold',
    textVal: 'text-violet-800 font-black'
  },
  red: {
    bg: 'bg-rose-50/70',
    border: 'border-rose-200/50',
    textLabel: 'text-rose-600 font-bold',
    textVal: 'text-rose-800 font-black'
  },
  orange: {
    bg: 'bg-amber-50/70',
    border: 'border-amber-200/50',
    textLabel: 'text-amber-600 font-bold',
    textVal: 'text-amber-800 font-black'
  }
};

const QUADRANT_COLORS: Record<string, string> = {
  blue: 'bg-blue-600 hover:bg-blue-700',
  orange: 'bg-orange-600 hover:bg-orange-700',
  purple: 'bg-purple-600 hover:bg-purple-700',
};

// =================================================================
// FIREBASE ERROR HANDLING & UTILS
// =================================================================
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
};

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("[Firebase] Conexão com Firestore verificada com sucesso.");
  } catch (error: any) {
    console.error("[Firebase] Falha na conexão de teste:", error.code, error.message);
    if (error.message?.includes('the client is offline') || error.code === 'unavailable') {
      console.error("Verifique a configuração do Firebase (apiKey, projectId) e se o Firestore está habilitado.");
    }
  }
}
testConnection();

// =================================================================
// COMPONENTE PRINCIPAL
// =================================================================

// Helper: data local no formato YYYY-MM-DD (evita problema de fuso UTC)
const localDateStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

const normalizeName = (name: string) => {
  if (!name) return '';
  return name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
};

const AUTHORIZED_MECHANICS_NORMALIZED = ["KAUAN", "JOÃO", "FELIPE", "ANDRÉ", "RAFAEL"];

// =================================================================
// COMPONENTE PRINCIPAL
// =================================================================

const MainScreen: React.FC<MainScreenProps> = ({
  driverName, category, plate, kmInicial, onLogout, onShowMap, onUpdateUser
}) => {
  // Move as declarações de papel para o topo absoluto do componente
  const normalizedCategory = useMemo(() => (category || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''), [category]);
  const isAdm = useMemo(() => normalizedCategory.includes('ADM'), [normalizedCategory]);
  const isMecanica = useMemo(() => normalizedCategory.includes('MECANICA') || normalizedCategory.includes('MECANICO'), [normalizedCategory]);
  const isTecnica  = useMemo(() => normalizedCategory.includes('TECNICA') || normalizedCategory.includes('TECNICO'), [normalizedCategory]);
  const trailerBatteryLimit = isMecanica ? 80 : 85;

  // Helper para calculo de data de inicio do dia (usado em listeners)
  const getStartOfDayTs = useCallback(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Timestamp.fromDate(d);
  }, []);

  // --- UI State ---
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncAlert, setSyncAlert] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsWarning, setGpsWarning] = useState<string | null>(null);
  const gpsBypassRef = useRef(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncFailCountRef = useRef(0); // só exibe erro após 3 falhas consecutivas
  const [lastSyncTime, setLastSyncTime] = useState(new Date().toLocaleTimeString());
  const [backendVersion, setBackendVersion] = useState<string | null>(null);

  // --- ADM Edit Mechanic Bikes State ---
  const [editingMechanic, setEditingMechanic] = useState<string | null>(null);
  const [editingStatusChoice, setEditingStatusChoice] = useState<'Em Manutenção' | 'Reserva'>('Em Manutenção');
  const [newBikeNumber, setNewBikeNumber] = useState('');
  const [isAdminBikeAdding, setIsAdminBikeAdding] = useState(false);
  const [adminBikeActionLoading, setAdminBikeActionLoading] = useState<string | null>(null);

  // --- Almoxarifado (Warehouse Stock Control) State ---
  const [isAlmoxarifadoOpen, setIsAlmoxarifadoOpen] = useState(false);
  const [almoxarifadoItems, setAlmoxarifadoItems] = useState<any[]>([]);
  const [almoxarifadoSearch, setAlmoxarifadoSearch] = useState('');
  const [isAddingNewItem, setIsAddingNewItem] = useState(false);
  const [newItemCodigo, setNewItemCodigo] = useState('');
  const [newItemDescricao, setNewItemDescricao] = useState('');
  const [newItemFornecedor, setNewItemFornecedor] = useState('');
  const [newItemQuantidade, setNewItemQuantidade] = useState<number | ''>('');
  const [newItemQtdMinima, setNewItemQtdMinima] = useState<number | ''>('');
  const [isSubmittingNewItem, setIsSubmittingNewItem] = useState(false);

  // Stock movement state
  const [movingItem, setMovingItem] = useState<any | null>(null);
  const [movementTipo, setMovementTipo] = useState<'entrada' | 'retirada'>('retirada');
  const [movementQuantidade, setMovementQuantidade] = useState<number | ''>('');
  const [movementUsuario, setMovementUsuario] = useState('');
  const [movementData, setMovementData] = useState(() => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });
  const [isSubmittingMovement, setIsSubmittingMovement] = useState(false);

  // Item history view state
  const [viewingHistoryItem, setViewingHistoryItem] = useState<any | null>(null);


  // --- Dados principais ---
  const [routeBikes, setRouteBikes] = useState<string[]>([]);
  const [collectedBikes, setCollectedBikes] = useState<string[]>([]);
  const routeBikesRef = useRef<string[]>([]);
  const collectedBikesRef = useRef<string[]>([]);

  useEffect(() => {
    routeBikesRef.current = routeBikes;
  }, [routeBikes]);

  useEffect(() => {
    collectedBikesRef.current = collectedBikes;
  }, [collectedBikes]);
  const [routeBikesDetails, setRouteBikesDetails] = useState<Record<string, any>>({});
  const [collectedBikesDetails, setCollectedBikesDetails] = useState<Record<string, any>>({});
  const [pendingRequests, setPendingRequests] = useState<PickupRequest[]>([]);
  const [stations, setStations] = useState<any[]>([]);
  const [motoristas, setMotoristas] = useState<string[]>([]);
  const [driverLocations, setDriverLocations] = useState<DriverLocation[]>([]);
  const [bikeConflicts, setBikeConflicts] = useState<Record<string, any>>({});
  const [currentDriverLocation, setCurrentDriverLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [routeDistances, setRouteDistances] = useState<Record<string, { distance: string, duration: string, value: number, isRoad?: boolean, directDistanceM?: number, legM?: number, legS?: number }>>({});
  const lastOptimizedBikesSetRef = useRef<string>('');
  const lastRouteCalculatedGpsRef = useRef<{ lat: number, lng: number } | null>(null);

  // --- Modais ---
  const [isRequestModalOpen, setRequestModalOpen] = useState(false);
  const [prefilledBikeNumber, setPrefilledBikeNumber] = useState<string | undefined>(undefined);
  const [isRouteModalOpen, setRouteModalOpen] = useState(false);
  const [isTrailerModalOpen, setTrailerModalOpen] = useState(false);
  const [isReportModalOpen, setReportModalOpen] = useState(false);
  const [isVehicleModalOpen, setIsVehicleModalOpen] = useState(false);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [isForceReloading, setIsForceReloading] = useState(false);
  const [isReporModalOpen, setIsReporModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isEditDriverModalOpen, setIsEditDriverModalOpen] = useState(false);
  const [showAnalyticalDashboard, setShowAnalyticalDashboard] = useState(false);
  const [isFirebaseReportOpen, setIsFirebaseReportOpen] = useState(false);
  const [isNotFoundConfirmOpen, setIsNotFoundConfirmOpen] = useState(false);
  const [isMechanicRepairModalOpen, setIsMechanicRepairModalOpen] = useState(false);
  const [technicaList, setTechnicaList] = useState<any[]>([]);
  const [isTechnicaLoading, setIsTechnicaLoading] = useState(false);
  const [technicaReceiptModal, setTechnicaReceiptModal] = useState<{ bikeNumber: string; originalMechanic: string } | null>(null);
  const [technicaRepairModal, setTechnicaRepairModal] = useState<{ bike: any } | null>(null);
  const [technicaRepairSelected, setTechnicaRepairSelected] = useState<Set<string>>(new Set());

  // Locker Vandalized states
  const [lockerVandalizedModal, setLockerVandalizedModal] = useState<{ bike: any } | null>(null);
  const [lockerVandalizedIssue, setLockerVandalizedIssue] = useState<string>('');
  const [lockerVandalizedBikeCondition, setLockerVandalizedBikeCondition] = useState<'BOA' | 'RUIM' | null>(null);
  const [lockerVandalizedBikeRoom, setLockerVandalizedBikeRoom] = useState<string>('');
  const [lockerVandalizedLockerBox, setLockerVandalizedLockerBox] = useState<string>('');
  const TECNICA_TECHNICIANS = ['Diego', 'Jhonatan'];
  const TECNICA_REPAIR_OPTIONS = [
    'CARCAÇA FRONTAL', 'CARCAÇA TRASEIRA', 'TRAVA', 'MOTOR TRAVADO',
    'SENSORES', 'ALTO FALANTE', 'CABO DE ENERGIA', 'BATERIA',
    'ATUALIZAÇÃO DE SOFTWARE', 'RESET DO LOCKER', 'PROTEÇÃO COMPLETA', 'QRCODE'
  ];
  const [isMechanicSelectionModalOpen, setIsMechanicSelectionModalOpen] = useState(false);
  const [isTrailerSelectionModalOpen, setIsTrailerSelectionModalOpen] = useState(false);
  const [isDriverSelectionModalOpen, setIsDriverSelectionModalOpen] = useState(false);
  const [selectedActionForAssignment, setSelectedActionForAssignment] = useState<any>(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [destinationModal, setDestinationModal] = useState<{
    isOpen: boolean; bikeNumber: string;
    type: 'Estação' | 'Filial' | 'Vandalizada'; stationName?: string;
  }>({ isOpen: false, bikeNumber: '', type: 'Estação' });

  // --- Dados ADM ---
  const [driversSummary, setDriversSummary] = useState<any[]>([]);
  const [trailersHistory, setTrailersHistory] = useState<any[]>([]);
  const [firebaseTimelineEvents, setFirebaseTimelineEvents] = useState<Record<string, Array<{tsMs: number, type: string, bikeNumber?: string}>>>({});
  const [timelineModal, setTimelineModal] = useState<{driver: string, events: any[], clusters: any[], startMs: number, endMs: number} | null>(null);
  const [timelineDate, setTimelineDate] = useState<string>(localDateStr()); // YYYY-MM-DD
  const [summaryTimeRange, setSummaryTimeRange] = useState<'day' | 'week' | 'month' | '-1' | '-7'>('day');
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [activeQuadrant, setActiveQuadrant] = useState<'summary' | 'alerts' | 'vandalized' | 'status' | 'mechanics' | 'technica' | 'bike_search' | 'boletim'>('summary');
  const [bikeSearchTerm, setBikeSearchTerm] = useState('');
  const [bikeSearchLimit, setBikeSearchLimit] = useState<5|10|15>(5);
  const [bikeSearchResult, setBikeSearchResult] = useState<any[]>([]);
  const [isBikeSearchLoading, setIsBikeSearchLoading] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [alertsVersion, setAlertsVersion] = useState<string>('');
  const [isAlertsLoading, setIsAlertsLoading] = useState(false);
  const [vandalizedBikes, setVandalizedBikes] = useState<any[]>([]);
  const [isVandalizedLoading, setIsVandalizedLoading] = useState(false);
  const [statusTimeRange] = useState<'24h' | '48h' | '72h' | 'week'>('24h');
  const [pendingActions, setPendingActions] = useState<any[]>([]);
  const [isPendingActionsLoading, setIsPendingActionsLoading] = useState(false);

  // --- Route Generation ---
  const [isRouteConfigOpen, setIsRouteConfigOpen] = useState(false);
  const [routeConfig, setRouteConfig] = useState({
    locationSource: 'gps' as 'gps' | 'zone',
    selectedZone: 'central' as 'norte' | 'leste' | 'sul' | 'oeste' | 'central',
    filters: {
      lowBattery: true,
      openLock: true,
      outOfStation: true,
      offline: false,
      wrongStatus: true
    }
  });

  const ZONES = useMemo(() => ({
    norte:   { lat: -23.4462, lng: -46.6333, label: 'ZONA NORTE' },
    leste:   { lat: -23.5433, lng: -46.5333, label: 'ZONA LESTE' },
    sul:     { lat: -23.6433, lng: -46.6333, label: 'ZONA SUL' },
    oeste:   { lat: -23.5433, lng: -46.7333, label: 'ZONA OESTE' },
    central: { lat: -23.5433, lng: -46.6333, label: 'ZONA CENTRAL' }
  }), []);

  const [editingDriver, setEditingDriver] = useState<any>(null);

  // --- Dados auxiliares ---
  const [mechanicsList, setMechanicsList] = useState<any[]>([]);
  const [sheetsMechanicsList, setSheetsMechanicsList] = useState<any[]>([]);
  const [mechanicsLiveDetails, setMechanicsLiveDetails] = useState<Record<string, any>>({});
  const [fbMechanicsFlow, setFbMechanicsFlow] = useState<any[]>([]);
  const [fbTechnicalFlow, setFbTechnicalFlow] = useState<any[]>([]);
  const [selectedMechanicBike, setSelectedMechanicBike] = useState<any>(null);
  const [selectedBikesForTrailer, setSelectedBikesForTrailer] = useState<string[]>([]);
  const [reporData, setReporData] = useState<any[]>([]);
  const [isReporLoading, setIsReporLoading] = useState(false);
  const [userSchedule, setUserSchedule] = useState<Record<string, string>>({});
  const [isScheduleLoading, setIsScheduleLoading] = useState(false);
  const [requestsHistory, setRequestsHistory] = useState<any[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [processingBikes, setProcessingBikes] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [searchedBike, setSearchedBike] = useState<BicycleData | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [mechanicSearchTerm, setMechanicSearchTerm] = useState('');
  const [activeMechanicCategory, setActiveMechanicCategory] = useState<string | null>(null);
  const [activeTechnicaCategory, setActiveTechnicaCategory] = useState<string | null>(null);
  const [selectedMechanicFilter, setSelectedMechanicFilter] = useState<string>('Todos');
  const [selectedBatteryFilter, setSelectedBatteryFilter] = useState<'asc' | 'desc' | 'Todos'>('Todos');
  const [mechanicSummaryPeriod, setMechanicSummaryPeriod] = useState<'diario'|'semanal'|'mensal'>('diario');
  const [productionDrillDown, setProductionDrillDown] = useState<{ mechanic: string; type: 'man' | 'res'; bikes: string[] } | null>(null);
  const [isMechanicHistoryOpen, setIsMechanicHistoryOpen] = useState(false);
  const [mechanicHistory, setMechanicHistory] = useState<any[]>([]);
  const [isMechanicHistoryLoading, setIsMechanicHistoryLoading] = useState(false);
  const [mechanicHistoryFilter, setMechanicHistoryFilter] = useState({ mechanic: 'Todos', date: '' });
  const [dynamicMechanics, setDynamicMechanics] = useState<string[]>(["KAUAN", "JOÃO", "FELIPE", "ANDRÉ", "RAFAEL"]);
  const [isTechnicaHistoryOpen, setIsTechnicaHistoryOpen] = useState(false);
  const [technicaHistory, setTechnicaHistory] = useState<any[]>([]);
  const [isTechnicaHistoryLoading, setIsTechnicaHistoryLoading] = useState(false);
  const [technicaHistoryFilter, setTechnicaHistoryFilter] = useState({ technician: 'Todos', date: '' });
  const [bikeFoundModal, setBikeFoundModal] = useState<{ isOpen: boolean, bikePat: string } | null>(null);
  const [mechanicNotFoundModal, setMechanicNotFoundModal] = useState<{ isOpen: boolean, bikePat: string } | null>(null);
  const [isTechnicalConfirmOpen, setIsTechnicalConfirmOpen] = useState<{ isOpen: boolean, bikePat: string, mechanicName?: string } | null>(null);
  const [manualMechanicModal, setManualMechanicModal] = useState<{ isOpen: boolean; bikePat: string; targetStatus: string }>({ isOpen: false, bikePat: '', targetStatus: '' });
  const [manualMechanicName, setManualMechanicName] = useState('');
  const [removeAlertModal, setRemoveAlertModal] = useState<{
    isOpen: boolean;
    alert: any;
    reason: string;
    removerName: string;
  }>({
    isOpen: false,
    alert: null,
    reason: '',
    removerName: '',
  });
  const [isVandalizedConfirmOpen, setIsVandalizedConfirmOpen] = useState<{ isOpen: boolean, bikePat: string } | null>(null);
  const [vandalizedSelected, setVandalizedSelected] = useState<Set<string>>(new Set());
  const [vandalizedRoom, setVandalizedRoom] = useState<string>('');
  const VANDALIZED_OPTIONS = [
    'Quadro Vandalizado', 'Pezinho Quebrado',
    'Cesto/Placa Quebrada', 'Ferradura Vandalizada',
    'Rodas Vandalizadas', 'Guidão Quebrado',
    'Garfo Danificado', 'Locker Danificado',
    'Sem Locker',
  ];
  const VANDALIZED_ROOMS = ['SALA 2', 'SALA 3', 'SALA 4'];
  const [isZerarListaConfirmOpen, setIsZerarListaConfirmOpen] = useState(false);
  const [trailerQrModal, setTrailerQrModal] = useState<{
    isOpen: boolean;
    trailerName: string;
    expectedBikes: { patrimonio: string; bateria: number | undefined; ultimaInfo?: string }[];
    confirmedBikes: Set<string>;
    batteryFailed: string | null; // patrimônio da bike com bateria insuficiente
    scannerActive: boolean;
    lastScanned: string | null;
    lastError: string | null;
  } | null>(null);
  const trailerScannerRef = useRef<Html5Qrcode | null>(null);
  const scannerStartPromise = useRef<Promise<any> | null>(null);
  const trailerScannerStartPromise = useRef<Promise<any> | null>(null);
  const isScannerBusy = useRef(false);
  const recentlyHandledBikesRef = useRef<Map<string, number>>(new Map()); // patrimonio -> timestamp
  const [isLimparListaConfirmOpen, setIsLimparListaConfirmOpen] = useState(false);
  const [removeFromTrailerConfirm, setRemoveFromTrailerConfirm] = useState<{ patrimonio: string; trailerName: string } | null>(null);

  // --- Refs ---
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const searchCacheRef = useRef<Record<string, BicycleData>>({});
  const searchResultRef = useRef<HTMLDivElement>(null);
  const processingBikesRef = useRef<Set<string>>(new Set());

  const markBikeHandled = useCallback((bikeNumber: string) => {
    const now = Date.now();
    const bikeId = String(bikeNumber);
    recentlyHandledBikesRef.current.set(bikeId, now);
    // Persiste no localStorage
    try {
      const metaKey = `driver_meta_${normalizeName(driverName)}`;
      const meta = JSON.parse(localStorage.getItem(metaKey) || '{}');
      if (!meta.recentlyHandled) meta.recentlyHandled = {};
      meta.recentlyHandled[bikeId] = now;
      
      // Limpeza de itens antigos (> 15 min) para não explodir o localStorage
      const fifteenMinAgo = now - 900000;
      Object.keys(meta.recentlyHandled).forEach(id => {
        if (meta.recentlyHandled[id] < fifteenMinAgo) delete meta.recentlyHandled[id];
      });
      
      localStorage.setItem(metaKey, JSON.stringify(meta));
    } catch {}
  }, [driverName]);

  // Ref para refreshAll — evita dependência circular com persistDriverState
  const refreshAllRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!db || (activeQuadrant !== 'mechanics' && !isTecnica && !isMecanica)) return;
    
    // Filtramos apenas por status ativos para reduzir leituras
    const activeStatuses = ['Alterar Status', 'Não encontrada', 'Aguardando Manutenção', 'Em Manutenção', 'Reserva', 'Aguardando Técnica', 'Em Técnica'];
    const q = query(collection(db, 'mechanics_flow'), where('status', 'in', activeStatuses));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const flow = snapshot.docs.map(doc => ({
        ...doc.data(),
        patrimonio: doc.id
      }));
      setFbMechanicsFlow(flow);
    }, (error) => {
      console.error('Error listening to mechanics_flow:', error);
    });
    return () => unsubscribe();
  }, [activeQuadrant, isTecnica, isMecanica]);

  useEffect(() => {
    if (!db || (activeQuadrant !== 'technica' && !isTecnica)) return;
    
    setIsTechnicaLoading(true);
    // Filtramos por status ativos na técnica
    const technicalStatuses = ['Aguardando Técnica', 'Em Técnica', 'Aguardando Manutenção'];
    const q = query(collection(db, 'technical_flow'), where('status', 'in', technicalStatuses));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const flow = snapshot.docs.map(doc => ({
        ...doc.data(),
        patrimonio: doc.id
      }));
      setFbTechnicalFlow(flow);
      setIsTechnicaLoading(false);
    }, (error) => {
      console.error('Error listening to technical_flow:', error);
      setIsTechnicaLoading(false);
    });
    return () => unsubscribe();
  }, [activeQuadrant, isTecnica]);

  const mergeMechanicsList = useCallback((serverBikes: any[], fbFlow: any[]) => {
    const now = Date.now();
    const activeStatuses = ['Alterar Status', 'Não encontrada', 'Aguardando Manutenção', 'Em Manutenção', 'Reserva', 'Aguardando Técnica', 'Em Técnica'];
    const validMechanicsStatuses = activeStatuses;
    
    // Identifica as bikes que estão em validação de carretinha ou alteração de status em lote para ocultá-las da visualização ativa e evitar loopings
    const bikesInPendingActions = new Set(
      pendingActions
        .filter(a => a.type === 'trailer_validation' || a.type === 'alterar_status_lote')
        .flatMap(a => a.bikes || [])
        .map(p => String(p).trim().replace(/^0+/, ''))
    );

    // Ordem de precedência de status da mecânica (Normalizada)
    const statusOrder: Record<string, number> = {
      'ALTERAR STATUS': 1,
      'NAO ENCONTRADA': 1,
      'AGUARDANDO MANUTENCAO': 2,
      'EM MANUTENCAO': 3,
      'RESERVA': 4,
      'REMANEJADA': 5,
      'ESTACAO': 6,
      'FILIAL': 6,
      'EM ROTA': 6,
      'PENDENTE': 6,
      'ATIVA': 6,
      'LANCADA': 6,
      'ESTOQUE': 6,
      'DISPONIVEL': 6
    };
    
    const fbMap: Record<string, any> = {};
    fbFlow.forEach(b => {
      fbMap[String(b.patrimonio)] = b;
    });
    const result: any[] = [];

    // 1. Processa bikes do servidor (Sheets)
    serverBikes.forEach(sBike => {
      const pat = String(sBike.patrimonio);
      const fbBike = fbMap[pat];
      const live = mechanicsLiveDetails[pat];

      if (!fbBike) {
        // Não está no Firebase, adiciona se for status válido
        if (validMechanicsStatuses.includes(sBike.status)) {
          result.push({
            ...sBike,
            bateria: live?.['Bateria'] !== undefined ? live['Bateria'] : sBike.bateria,
            carregamento: live?.['Carregando'] !== undefined ? live['Carregando'] : sBike.carregamento
          });
        }
      } else {
        // Está no Firebase. 
        const fbStatus = fbBike.status || '';
        const sStatus = sBike.status || '';
        
        // EXCEÇÃO: Se o servidor (Sheets) diz 'Aguardando Manutenção' e o Firebase ainda diz 'Alterar Status',
        // o servidor prevalece, pois a bike já teve seu status mestre alterado para Manutenção na aba Bicicletas.
        const isMasterMaintenance = sStatus === 'Aguardando Manutenção' && fbStatus === 'Alterar Status';

        // v85.55: Se o status do servidor (Sheets) é mais avançado no fluxo de mecânica do que o do Firebase,
        // o status do servidor deve prevalecer para evitar que dados antigos do Firebase fiquem presos (stale)
        // e façam a bike retornar para estados anteriores (ex: se o servidor já está como 'Reserva' mas o Firebase diz 'Alterar Status').
        const normSStatus = normalizeForSearch(sStatus);
        const normFbStatus = normalizeForSearch(fbStatus);
        const isServerNewer = (statusOrder[normSStatus] || 0) > (statusOrder[normFbStatus] || 0);

        if (isServerNewer) {
          // Limpeza assíncrona em background do documento stale no Firestore
          (async () => {
            try {
              const { deleteDoc: _deleteDoc, doc: _doc } = await import('firebase/firestore');
              await _deleteDoc(_doc(db, 'mechanics_flow', pat));
              await _deleteDoc(_doc(db, 'technical_flow', pat));
            } catch (err) {
              console.warn('[Firebase] Cleanup of stale mechanics_flow/technical_flow document failed for', pat, err);
            }
          })();
        }

        // Prioridade 1: Se o status do Firebase for ATIVO, ele prevalece sobre o servidor (exceto para o caso mestre ou se o servidor for mais atual).
        if (activeStatuses.includes(fbStatus) && !isMasterMaintenance && !isServerNewer) {
          result.push({
            ...fbBike,
            // Prioridade para bateria e carregamento LIVE, depois servidor (Sheets), depois Firebase
            bateria: live?.['Bateria'] !== undefined ? live['Bateria'] : (sBike.bateria !== undefined ? sBike.bateria : fbBike.bateria),
            carregamento: live?.['Carregando'] !== undefined ? live['Carregando'] : (sBike.carregamento !== undefined ? sBike.carregamento : fbBike.carregamento),
            dataEntrada: fbBike.dataEntrada?.toDate?.() || fbBike.dataEntrada || new Date(),
            dataSaida: fbBike.dataSaida?.toDate?.() || fbBike.dataSaida || null,
          });
        } 
        // Prioridade 2: Se o status do Firebase NÃO for ativo ou se for a exceção de Manutenção/Servidor mais recente
        else if (isMasterMaintenance || isServerNewer || sStatus === 'Alterar Status' || validMechanicsStatuses.includes(sStatus)) {
          result.push({
            ...sBike,
            bateria: live?.['Bateria'] !== undefined ? live['Bateria'] : sBike.bateria,
            carregamento: live?.['Carregando'] !== undefined ? live['Carregando'] : sBike.carregamento
          });
        }
      }
    });

    // 2. Adiciona bikes do Firebase que NÃO estão no servidor (ex: inserção manual recente no app)
    const serverPatrimonios = new Set(serverBikes.map(b => String(b.patrimonio)));
    fbFlow.forEach(fbBike => {
      const pat = String(fbBike.patrimonio);
      const live = mechanicsLiveDetails[pat];
      
      const liveStatus = String(live?.status || live?.statusSistema || fbBike.status || '').trim();
      const normLiveStatus = normalizeForSearch(liveStatus);
      const isLiveSystemExit = normLiveStatus && (statusOrder[normLiveStatus] || 0) >= 5;

      if (isLiveSystemExit) {
        // Limpeza assíncrona em background do documento stale no Firestore
        (async () => {
          try {
            const { deleteDoc: _deleteDoc, doc: _doc } = await import('firebase/firestore');
            await _deleteDoc(_doc(db, 'mechanics_flow', pat));
            await _deleteDoc(_doc(db, 'technical_flow', pat));
          } catch (err) {
            console.warn('[Firebase] Cleanup of exited fbBike document failed for', pat, err);
          }
        })();
        return; // Pula essa bike! Não adiciona à lista
      }

      if (!serverPatrimonios.has(pat) && activeStatuses.includes(fbBike.status)) {
        result.push({
          ...fbBike,
          bateria: live?.['Bateria'] !== undefined ? live['Bateria'] : fbBike.bateria,
          carregamento: live?.['Carregando'] !== undefined ? live['Carregando'] : fbBike.carregamento,
          dataEntrada: fbBike.dataEntrada?.toDate?.() || fbBike.dataEntrada || new Date(),
          dataSaida: fbBike.dataSaida?.toDate?.() || fbBike.dataSaida || null,
        });
      }
    });

    // 3. Aplica proteção otimista e injeção de bikes ausentes que estão sob proteção
    const finalPats = new Set(result.map(b => String(b.patrimonio)));
    
    // Injeção de bikes protegidas que sumiram do resultado (ex: finalizadas mas ainda não sincronizadas no Sheets ou movidas para Reserva)
    Object.entries(mechanicOptimisticRef.current).forEach(([pat, prot]) => {
      if (prot.expiresAt > now && !finalPats.has(pat)) {
        const protFields = { ...prot };
        delete (protFields as any).expiresAt;
        
        const statusToUse = protFields.status || (isTecnica ? 'Em Técnica' : 'Reserva');
        if (validMechanicsStatuses.includes(statusToUse)) {
          result.push({
            patrimonio: pat,
            status: statusToUse,
            mecanico: driverName,
            dataEntrada: new Date(),
            ...protFields
          } as any);
          finalPats.add(pat);
        }
      }
    });

    return result.map(bike => {
      const pat = String(bike.patrimonio);
      const live = mechanicsLiveDetails[pat];
      
      const enrichedBike = {
        ...bike,
        bateria: live?.['Bateria'] !== undefined ? live['Bateria'] : (bike.bateria !== undefined ? bike.bateria : live?.bateria),
        carregamento: live?.['Carregando'] !== undefined ? live['Carregando'] : (bike.carregamento !== undefined ? bike.carregamento : live?.carregamento),
        trava: live?.['Trava'] !== undefined ? live['Trava'] : (bike.trava !== undefined ? bike.trava : (bike.Trava !== undefined ? bike.Trava : live?.trava)),
      };

      const protected_ = mechanicOptimisticRef.current[pat];
      if (protected_ && protected_.expiresAt > now) {
        const protectedFields = { ...protected_ };
        delete (protectedFields as any).expiresAt;
        return { ...enrichedBike, ...protectedFields };
      }
      return enrichedBike;
    }).filter(b => {
      const pat = String(b.patrimonio).trim().replace(/^0+/, '');
      return validMechanicsStatuses.includes(b.status) && !bikesInPendingActions.has(pat);
    });
  }, [mechanicsLiveDetails, isTecnica, driverName, pendingActions]);

  useEffect(() => {
    setMechanicsList(mergeMechanicsList(sheetsMechanicsList, fbMechanicsFlow));
  }, [sheetsMechanicsList, fbMechanicsFlow, mergeMechanicsList]);

  useEffect(() => {
    setTechnicaList(fbTechnicalFlow.map(b => ({
      ...b,
      dataEntrada: b.dataEntrada?.toDate?.() || b.dataEntrada || new Date(),
    })));
  }, [fbTechnicalFlow]);

  // IDs de notificações já processadas nesta sessão (aceitas ou recusadas).
  // Garante que nunca reapareçam mesmo que o sync devolva dados antigos.
  const processedRequestIds = useRef<Set<string>>(new Set());

  // =================================================================
  // REFS DE CONTROLE DE SINCRONIZAÇÃO
  //
  // isUpdatingStateRef: true enquanto uma operação do motorista está
  //   em andamento. Bloqueia qualquer sync externo.
  //
  // lastDriverActionAt: timestamp da última ação do motorista.
  //   O sync do Sheets só aplica se (now - lastDriverActionAt) > GRACE.
  // =================================================================
  const isUpdatingStateRef = useRef(false);
  const lastDriverActionAt = useRef<number>(0);
  const lastFirebaseUpdateAt = useRef<number>(0);
  const lastLocationRef = useRef<{ lat: number, lng: number } | null>(null);
  const syncCountRef = useRef<number>(0);

  // =================================================================
  // HELPERS DE ESTADO
  // =================================================================

  /**
   * Marca que o motorista acabou de executar uma ação.
   * Durante DRIVER_ACTION_GRACE_MS, o sync do Sheets não sobrescreve.
   */
  const markDriverAction = useCallback(() => {
    const now = Date.now();
    lastDriverActionAt.current = now;
    // Persiste no localStorage para durar após reloads
    try {
      const metaKey = `driver_meta_${normalizeName(driverName)}`;
      const meta = JSON.parse(localStorage.getItem(metaKey) || '{}');
      meta.lastDriverActionAt = now;
      localStorage.setItem(metaKey, JSON.stringify(meta));
    } catch {}
  }, [driverName]);

  /**
   * Verifica se o sync do Sheets pode sobrescrever o estado local.
   * Retorna false se houver uma ação recente do motorista.
   */
  const canSheetsOverride = useCallback(() => {
    const elapsed = Date.now() - lastDriverActionAt.current;
    return elapsed > DRIVER_ACTION_GRACE_MS;
  }, []);

  /**
   * Aplica estado vindo do Sheets, respeitando a janela de proteção.
   * Também espelha no Firebase com flag sheetsSync=true.
   */
  const applyStateFromSheets = useCallback((sheetsRoute: string[], sheetsCollected: string[]) => {
    if (isUpdatingStateRef.current) return; // operação ativa — não mexe
    if (!canSheetsOverride()) return;       // ação recente do motorista — protege

    const now = Date.now();
    const PROTECTION_WINDOW = 300000; // 5 minutos

    const newCollectedRaw = [...new Set(sheetsCollected.map(String).filter(Boolean))];
    const newRouteRaw = [...new Set(sheetsRoute.map(String).filter(Boolean))];

    // Reconciliação: Protege bikes que foram manipuladas recentemente, mesmo que não estejam no Sheets ainda
    const handledRecently = Array.from(recentlyHandledBikesRef.current.entries())
      .filter(([, ts]) => now - ts < PROTECTION_WINDOW)
      .map(([id]) => id);
    
    // Se a bike foi "Recolhida" recentemente mas não está no Sheets, mantém ela na Posse
    const protectedCollected = handledRecently.filter(id => collectedBikesRef.current.includes(id) && !newCollectedRaw.includes(id));
    const finalCollected = [...new Set([...newCollectedRaw, ...protectedCollected])];

    // Se a bike foi colocada "Em Rota" recentemente mas não está no Sheets, mantém ela na Rota
    const protectedRoute = handledRecently.filter(id => routeBikesRef.current.includes(id) && !newRouteRaw.includes(id) && !finalCollected.includes(id));
    const finalRoute = [...new Set([...newRouteRaw, ...protectedRoute])].filter(b => !finalCollected.includes(b));

    const sanitizedRoute = finalRoute.filter(b => !processingBikesRef.current.has(b));
    const sanitizedCollected = finalCollected.filter(b => !processingBikesRef.current.has(b));

    setRouteBikes(prev => {
      const prevStr = [...prev].sort().join(',');
      const nextStr = [...sanitizedRoute].sort().join(',');
      return prevStr === nextStr ? prev : sanitizedRoute;
    });

    setCollectedBikes(prev => {
      const prevStr = [...prev].sort().join(',');
      const nextStr = [...sanitizedCollected].sort().join(',');
      
      if (prevStr !== nextStr) {
        const added = sanitizedCollected.filter(id => !prev.includes(id));
        added.forEach(id => {
          // Só registra se não for uma bike que já tínhamos localmente (evita duplicatas na timeline)
          const lastHandledAt = recentlyHandledBikesRef.current.get(id);
          if (!lastHandledAt || (now - lastHandledAt > 10000)) {
            addDoc(collection(db, 'timeline_events'), {
              driverName,
              bikeNumber: id,
              type: 'em_posse',
              timestamp: serverTimestamp(),
              date: localDateStr(),
              observacao: 'Sync: Atribuído via Planilha'
            }).catch(e => console.warn('[Timeline] Erro no sync Posse:', e));
          }
        });
      }

      return prevStr === nextStr ? prev : sanitizedCollected;
    });

    // Espelha no Firebase APENAS se o estado mudou
    const prevRouteStr = [...routeBikesRef.current].sort().join(',');
    const prevCollStr  = [...collectedBikesRef.current].sort().join(',');
    const nextRouteStr = [...sanitizedRoute].sort().join(',');
    const nextCollStr  = [...sanitizedCollected].sort().join(',');
    if (prevRouteStr !== nextRouteStr || prevCollStr !== nextCollStr) {
      setDoc(doc(db, 'users', normalizeName(driverName)), {
        routeBikes: sanitizedRoute,
        collectedBikes: sanitizedCollected,
        lastUpdate: serverTimestamp(),
        sheetsSync: true,
      }, { merge: true }).catch(() => {});
    }
  }, [driverName, canSheetsOverride]);

  /**
   * Grava o estado do motorista no Firebase e envia para Sheets em paralelo.
   * Após Sheets confirmar, dispara sync imediato via ref (sem dependência circular).
   */
  const persistDriverState = useCallback(async (
    newRoute: string[],
    newCollected: string[]
  ) => {
    const dedupRoute = [...new Set(newRoute.map(String))];
    const dedupCollected = [...new Set(newCollected.map(String))];

    // 1. Firebase — não-bloqueante (permissões podem variar)
    setDoc(doc(db, 'users', normalizeName(driverName)), {
      routeBikes: dedupRoute,
      collectedBikes: dedupCollected,
      lastUpdate: serverTimestamp(),
      sheetsSync: false,
    }, { merge: true }).catch(e => console.warn('[Firebase] users write:', e.code));

    // 2. Local Cache Update — essencial para evitar bikes retornando após reload/crash
    const cacheKey = `cached_main_data_${driverName}_${category}_${localDateStr()}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const d = JSON.parse(cached);
        if (!d.driverState) d.driverState = {};
        d.driverState.routeBikes = dedupRoute;
        d.driverState.collectedBikes = dedupCollected;
        localStorage.setItem(cacheKey, JSON.stringify(d));
      } catch (e) { console.warn('[Cache] Erro ao atualizar cache local:', e); }
    }

    // 3. Sheets em paralelo — fonte de verdade para estado
    return apiCall({
      action: 'updateDriverState',
      driverName,
      routeBikes: dedupRoute,
      collectedBikes: dedupCollected,
    }, 1, true).then(() => {
      setTimeout(() => refreshAllRef.current?.(true), 0);
    }).catch(e => {
      console.warn('[Sheets] updateDriverState falhou:', e);
      throw e;
    });
  }, [driverName, category]);

  const fetchBikeDetailsForReport = async (bikeNumber: string, timeoutMs = 5000) => {
    // Tenta usar dados locais se disponíveis (evita API call extra se já pesquisou)
    const cachedDetails = searchCacheRef.current[bikeNumber];
    const localDetails = collectedBikesDetails[bikeNumber] || routeBikesDetails[bikeNumber] || (searchedBike && String(searchedBike['Patrimônio']) === String(bikeNumber) ? searchedBike : null) || cachedDetails;
    
    if (localDetails && (localDetails.statusSistema || localDetails['Status'])) {
      return {
        statusSistema: localDetails.statusSistema || localDetails['Status'] || '',
        bateria: localDetails.bateria || (localDetails['Bateria'] ? `${localDetails['Bateria']}%` : ''),
        trava: localDetails.trava || localDetails['Trava'] || '',
        localidade: localDetails.localidade || localDetails['Localidade'] || ''
      };
    }

    // Se não tem local, tenta buscar com timeout para não travar o relatório
    const networkFetch = (async () => {
      try {
        const res = await apiCall({ action: 'search', bikeNumber, driverName }, 0, true); // 0 retries para ser rápido
        if (res.success && res.data) {
          return {
            statusSistema: res.data['Status'] || '',
            bateria: res.data['Bateria'] ? `${res.data['Bateria']}%` : '',
            trava: res.data['Trava'] || '',
            localidade: res.data['Localidade'] || ''
          };
        }
      } catch (e) {
        console.warn(`[Report] Network fetch failed for bike ${bikeNumber}:`, e);
      }
      return { statusSistema: '', bateria: '', trava: '', localidade: '' };
    })();

    return await Promise.race([
      networkFetch,
      new Promise(resolve => setTimeout(() => resolve({ statusSistema: '', bateria: '', trava: '', localidade: '' }), timeoutMs))
    ]) as any;
  };

  // Remove bikes do roteiro se elas atingirem o limite de boletim
  useEffect(() => {
    if (alerts.length > 0 && routeBikes.length > 0) {
      const boletimPats = new Set(
        alerts
          .filter(a => a.check1 && a.check2 && a.check3)
          .map(a => (a.patrimonio?.toString().trim() || a.id?.toString().trim()))
      );
      const filtered = routeBikes.filter(id => !boletimPats.has(id.toString().trim()));
      if (filtered.length !== routeBikes.length) {
        console.log('[Alerts] Removendo bikes com limite de boletim do roteiro:', routeBikes.length - filtered.length);
        setRouteBikes(filtered);
      }
    }
  }, [alerts, routeBikes]);

  // =================================================================
  // NOTIFICAÇÕES
  // =================================================================
  useEffect(() => {
    if (successMessage) {
      const t = setTimeout(() => setSuccessMessage(null), 5000);
      return () => clearTimeout(t);
    }
  }, [successMessage]);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (searchedBike && searchResultRef.current) {
      searchResultRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [searchedBike]);

  const showNotification = (title: string, body: string) => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, icon: '/favicon.ico' }); } catch { }
    }
  };

  // =================================================================
  // FIRESTORE LISTENERS
  // =================================================================
  useEffect(() => {
    if (!driverName) return () => {};

    const nowTs = Timestamp.now();
    const startOfDayTs = getStartOfDayTs();

    // Pedidos pendentes — Firebase usado APENAS para notificação push de novos pedidos para motoristas
    // O estado real de pendingRequests vem exclusivamente do Sheets via sync.
    // Filtramos apenas por 'pendente' e criados após o boot do app para economizar leituras.
    let unsubRequests = () => {};
    if (!isAdm && driverName) {
      const qRequests = query(
        collection(db, 'requests'), 
        where('status', '==', 'pendente'),
        where('timestamp', '>=', nowTs),
        limit(10) // Otimização: limita número de leituras
      );
      unsubRequests = onSnapshot(qRequests, (snapshot) => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            const d = change.doc.data();
            if (d.recipient === driverName || d.recipient === 'Todos') {
              showNotification('Novo Pedido', 'Você tem uma nova solicitação pendente.');
            }
          }
        });
      }, err => console.warn('Listener requests notify:', err));
    }

    // Estado do motorista — Listener em tempo real para motoristas (Background Sync)
    let unsubUser = () => {};
    if (!isAdm && driverName) {
      unsubUser = onSnapshot(doc(db, 'users', normalizeName(driverName)), (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        
        // Se estamos no meio de uma atualização local, ignoramos o Firebase para evitar flickering
        if (isUpdatingStateRef.current) return;

        // Proteção contra dados de dias anteriores
        const lastUpdate = data.lastUpdate?.toDate?.() || new Date(0);
        const lastUpdateStr = `${lastUpdate.getFullYear()}-${String(lastUpdate.getMonth()+1).padStart(2,'0')}-${String(lastUpdate.getDate()).padStart(2,'0')}`;
        const today = localDateStr();
        
        if (lastUpdateStr !== today && (data.routeBikes?.length > 0 || data.collectedBikes?.length > 0)) {
          console.log('[FirebaseSync] Ignorando estado de roteiro antigo:', lastUpdateStr);
          return;
        }

        // v85.45: Adiciona proteção contra bikes que somem por sync atrasado do Sheets para o Firebase
        const now = Date.now();
        const PROTECTION_WINDOW = 300000; // 5 minutos
        const fbRoute = (data.routeBikes || []).map(String);
        const fbCollected = (data.collectedBikes || []).map(String);

        // Reconciliação: Se o Firebase diz que a bike sumiu, mas nós a manipulamos recentemente, mantemos a versão local
        const handledRecently = Array.from(recentlyHandledBikesRef.current.entries())
          .filter(([, ts]) => now - ts < PROTECTION_WINDOW)
          .map(([id]) => id);

        const protectedRoute = handledRecently.filter(id => routeBikesRef.current.includes(id) && !fbRoute.includes(id) && !fbCollected.includes(id));
        const finalRoute = [...new Set([...fbRoute, ...protectedRoute])];

        const protectedCollected = handledRecently.filter(id => collectedBikesRef.current.includes(id) && !fbCollected.includes(id));
        const finalCollected = [...new Set([...fbCollected, ...protectedCollected])];

        lastFirebaseUpdateAt.current = lastUpdate.getTime();

        // Atualiza UI apenas se houver mudança real
        setRouteBikes(prev => {
          const prevStr = [...prev].sort().join(',');
          const nextStr = [...finalRoute].sort().join(',');
          if (prevStr !== nextStr) {
            routeBikesRef.current = finalRoute;
            return finalRoute;
          }
          return prev;
        });

        setCollectedBikes(prev => {
          const prevStr = [...prev].sort().join(',');
          const nextStr = [...finalCollected].sort().join(',');
          if (prevStr !== nextStr) {
            collectedBikesRef.current = finalCollected;
            return finalCollected;
          }
          return prev;
        });
      }, err => console.error('Listener usuário:', err));
    }

    // Listener de force_reload — APENAS para motoristas (ADM pode forçar atualização de todos)
    // Filtramos por tipo e tempo para evitar ler o histórico completo de notificações
    let unsubReload = () => {};
    if (!isAdm && driverName) {
      const qReload = query(
        collection(db, 'notifications'), 
        where('type', '==', 'force_reload'),
        where('timestamp', '>=', nowTs)
      );
      unsubReload = onSnapshot(qReload, snapshot => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            console.log('[ForceReload] Recarregando por comando do ADM...');
            setTimeout(() => window.location.reload(), 1500);
          }
        });
      }, err => console.error('Listener force_reload:', err));
    }

    // Alertas (ADM)
    const unsubNotifications = () => {};
    // Removido listener do Firebase para alertas pois o Sheets é o source of truth para os checks
    // e o listener estava sobrescrevendo os dados com informações incompletas.

    // Listener de timeline_events (para ADM na aba Summary ou Motoristas — enriquece a timeline)
    let unsubTimeline = () => {};
    if ((isAdm && activeQuadrant === 'summary') || (!isAdm && driverName)) {
      setFirebaseTimelineEvents({}); // limpa ao trocar de data
      // Otimização de Leituras (Server-Side Filter):
      // Se for ADM, escuta todos os eventos do dia. Se for motorista, escuta APENAS os seus próprios eventos.
      // Isso reduz drasticamente as leituras do Firestore no dia a dia.
      const q = isAdm 
        ? query(collection(db, 'timeline_events'), where('date', '==', timelineDate))
        : query(collection(db, 'timeline_events'), where('date', '==', timelineDate), where('driverName', '==', driverName));
      unsubTimeline = onSnapshot(q, snapshot => {
        const byDriver: Record<string, Array<{tsMs: number, type: string, bikeNumber?: string}>> = {};
        snapshot.forEach(d => {
          const data = d.data();
          const driver = data.driverName;
          if (!driver) return;
          // Se for motorista comum, só aceita os seus próprios eventos de forma case-insensitive/acentuação
          if (!isAdm && normalizeName(driver) !== normalizeName(driverName)) {
            return;
          }
          // serverTimestamp() pode ser null na primeira escrita (pendingWrite)
          // Nesse caso usa o timestamp local do documento como fallback
          const ts = data.timestamp?.toDate?.()
            || (d.metadata.hasPendingWrites ? new Date() : null);
          if (!ts) return;
          if (!byDriver[driver]) byDriver[driver] = [];
          byDriver[driver].push({
            tsMs: ts.getTime(),
            type: data.type || 'em_posse',
            bikeNumber: data.bikeNumber || '',
            observacao: data.observacao || '',
            isOccurrence: !!data.isOccurrence
          });
        });
        // Preserva eventos anteriores — mescla com novos
        setFirebaseTimelineEvents(prev => {
          const merged = { ...prev };
          Object.entries(byDriver).forEach(([drv, events]) => {
            merged[drv] = events;
          });
          return merged;
        });
      }, err => console.error('Listener timeline:', err));
    }

    // Listener de posições dos motoristas em tempo real (ADM - APENAS quando o RequestModal está aberto)
    let unsubLocations = () => {};
    if (isAdm && isRequestModalOpen) {
      // Janela 2h → 45min — menos docs na carga inicial
      const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000);
      const qLocs = query(
        collection(db, 'locations'),
        where('timestamp', '>=', Timestamp.fromDate(fortyFiveMinAgo)),
        limit(20)
      );
      unsubLocations = onSnapshot(qLocs, snapshot => {
        const firebaseLocations: any[] = [];
        snapshot.forEach(d => {
          const data = d.data();
          if (!data.latitude || !data.longitude) return;
          const ts = data.timestamp?.toDate?.()?.getTime() || 0;
          const ageMs = Date.now() - ts;
          if (ageMs > 2 * 60 * 60 * 1000) return;
          firebaseLocations.push({
            driverName: data.driverName || d.id,
            latitude: data.latitude,
            longitude: data.longitude,
            timestamp: data.timestamp?.toDate?.()?.toISOString() || new Date().toISOString(),
            stale: ageMs > 10 * 60 * 1000,
            source: 'firebase',
          });
        });

        // Só atualiza se Firebase trouxe dados — senão mantém o que está (do Sheets)
        if (firebaseLocations.length > 0) {
          setDriverLocations(prev => {
            // Firebase atualiza posições existentes; Sheets preenche quem não está no Firebase
            const firebaseNames = new Set(firebaseLocations.map((l: any) => l.driverName));
            const sheetsOnly = prev.filter(l => !firebaseNames.has(l.driverName));
            return [...firebaseLocations, ...sheetsOnly.map(l => ({ ...l, stale: true }))];
          });
        }
      }, err => console.error('Listener locations:', err));
    }

    // Listener de ações pendentes (ADM, Mecânica e Técnica para fins de filtragem preventiva)
    let unsubPending = () => {};
    if (isAdm || isMecanica || isTecnica) {
      setIsPendingActionsLoading(true);
      const qPending = query(
        collection(db, 'pending_actions'), 
        where('status', '==', 'pending'),
        where('timestamp', '>=', startOfDayTs),
        limit(50) // Otimização: evita ler centenas de ações passadas
      );
      unsubPending = onSnapshot(qPending, snapshot => {
        const actions: any[] = [];
        snapshot.forEach(d => {
          const data = d.data();
          if (data.status === 'pending') {
            actions.push({ id: d.id, ...data });
          }
        });
        setPendingActions(actions.sort((a, b) => {
          const tsA = a.timestamp?.toMillis?.() || 0;
          const tsB = b.timestamp?.toMillis?.() || 0;
          return tsB - tsA;
        }));
        setIsPendingActionsLoading(false);
      }, err => {
        console.error('Listener pending_actions:', err);
        setIsPendingActionsLoading(false);
      });
    }

    // Listener de Relatórios em Tempo Real para Contadores do Resumo
    // Atualiza os contadores de Recolhidas, Remanejadas e Não Encontradas instantaneamente
    // Otimização: para ADM, desabilitamos o listener em tempo real de TODOS os reports
    // pois consome muitas leituras (50k/dia fácil). O ADM usa os dados do Sheets Sync (15s).
    // Mantemos o listener apenas para o próprio motorista ver seus dados instantâneos.
    // Listener reports REMOVIDO — stats via Sheets sync (12s) é suficiente
    // Economiza: ~30 leituras iniciais + 1 leitura por finalização
    const unsubReports = () => {};

    return () => { unsubRequests(); unsubUser(); unsubNotifications(); unsubTimeline(); unsubReload(); unsubLocations(); unsubPending(); unsubReports(); };
  }, [driverName, isAdm, isMecanica, isTecnica, timelineDate, getStartOfDayTs, activeQuadrant, isRequestModalOpen]);

  const routeBikesTenKey = useMemo(() => {
    return routeBikes.slice(0, 10).sort().join(',');
  }, [routeBikes]);

  // Listener em tempo real para as bikes na rota (Agilidade Máxima)
  // Se uma bike na rota for recolhida por outro motorista, ela sai da lista imediatamente
  useEffect(() => {
    if (!driverName || routeBikes.length === 0) return () => {};
    
    let unsubBikes = () => {};
    try {
      const bikesToListen = routeBikes.slice(0, 10); // Reduzido 30→10 para economizar leituras
      const qBikes = query(collection(db, 'bikes'), where('__name__', 'in', bikesToListen));
      unsubBikes = onSnapshot(qBikes, (snapshot) => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'modified') {
            const bikeData = change.doc.data();
            const bikeId = change.doc.id;
            // Se a bike mudou de status ou responsável, removemos da rota se não for mais nossa
            if (bikeData.status === 'Recolhida' && bikeData.responsavel !== driverName) {
              console.log(`[Agilidade] Bike ${bikeId} recolhida por outro motorista. Removendo da rota.`);
              setRouteBikes(prev => {
                if (prev.includes(bikeId)) {
                  return prev.filter(id => id !== bikeId);
                }
                return prev;
              });
            }
          }
        });
      }, err => console.warn('Listener bikes rota:', err));
    } catch (e) {
      console.warn('[Firebase] Erro ao iniciar listener de bikes:', e);
    }
    
    return () => unsubBikes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverName, routeBikesTenKey]); // routeBikesTenKey garante estabilidade, evitando re-inscrições desnecessárias

  // --- Real-time listener for Almoxarifado items ---
  // Otimização: só assina enquanto o modal de Almoxarifado está aberto, e só
  // para quem realmente usa (ADM/Mecânica). Antes rodava sem filtro,
  // sem limite e para as 13 sessões o dia inteiro — qualquer escrita na coleção
  // forçava um re-fetch da coleção inteira em todo mundo. Isso sozinho respondia
  // por boa parte do pico de 118k leituras/dia.
  useEffect(() => {
    // Mesmo gate de papel do botão que abre o modal (linha ~6774: isMecanica || isAdm)
    if (!db || !isAlmoxarifadoOpen || !(isAdm || isMecanica)) return () => {};
    let unsubscribe = () => {};
    try {
      const q = query(collection(db, 'almoxarifado'));
      unsubscribe = onSnapshot(q, (snapshot) => {
        const items: any[] = [];
        snapshot.forEach((docSnap) => {
          items.push({ id: docSnap.id, ...docSnap.data() });
        });
        setAlmoxarifadoItems(items);
      }, (err) => {
        console.error('[Almoxarifado] Listener error:', err);
      });
    } catch (e) {
      console.warn('[Almoxarifado] Subscription setup failed:', e);
    }
    return () => unsubscribe();
  }, [isAlmoxarifadoOpen, isAdm, isMecanica]);

  // =================================================================
  // GARANTIA DE UNICIDADE
  // Uma bike nunca pode estar em roteiro E recolhidas ao mesmo tempo
  // =================================================================
  useEffect(() => {
    const collectedSet = new Set(collectedBikes.map(String));
    if (routeBikes.some(b => collectedSet.has(String(b)))) {
      setRouteBikes(prev => {
        const filtered = prev.filter(b => !collectedSet.has(String(b)));
        return filtered.length !== prev.length ? filtered : prev;
      });
    }
  }, [routeBikes, collectedBikes]);

  // =================================================================
  // FORMATADORES
  // =================================================================
  const formatDateTime = (date: Date) => {
    const p = (n: number) => n.toString().padStart(2, '0');
    return `${p(date.getDate())}/${p(date.getMonth()+1)}/${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  };

  const formatBattery = (value: any) => {
    if (value === undefined || value === null || value === '') return '';
    const num = parseFloat(String(value).replace('%', '').replace(',', '.'));
    if (isNaN(num)) return value;
    return num <= 1 ? Math.round(num * 100) : Math.round(num);
  };

  const formatCoordinate = (coord: any): string => {
    if (coord === undefined || coord === null || coord === '') return '';
    const num = typeof coord === 'number' ? coord : parseFloat(String(coord).replace(',', '.'));
    if (isNaN(num)) return String(coord);
    return normalizeCoord(num).toString();
  };

  const formatLastInfo = (dateString: any) => {
    if (!dateString || typeof dateString !== 'string') return { text: 'N/A', color: 'text-gray-800' };
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return { text: dateString, color: 'text-gray-800' };
    const diffHours = (new Date().getTime() - date.getTime()) / (1000 * 60 * 60);
    return {
      text: formatDateTime(date),
      color: diffHours > 24 ? 'text-red-600' : diffHours > 1 ? 'text-yellow-600' : 'text-green-600'
    };
  };

  const renderConflictIcon = (bike: string) => {
    const conflict = bikeConflicts[bike];
    if (!conflict) return null;
    const othersRoute = conflict.drivers?.filter((d: string) => d !== driverName && !d.includes('(Em Posse)')) || [];
    const othersPosse = conflict.drivers?.filter((d: string) => d !== driverName && d.includes('(Em Posse)')) || [];
    const hasStatus = conflict.status && ['VANDALIZADA','MANUTENÇÃO','ROUBADA'].includes(conflict.status);
    const hasRecent = conflict.recentAction && !conflict.recentAction.startsWith(driverName);
    if (!othersRoute.length && !othersPosse.length && !hasStatus && !hasRecent) return null;
    const msgs = [
      othersRoute.length > 0 && `No roteiro de: ${othersRoute.join(', ')}`,
      othersPosse.length > 0 && `Em posse de: ${othersPosse.join(', ')}`,
      hasStatus && `Status Crítico: ${conflict.status}`,
      hasRecent && `Ação Recente: ${conflict.recentAction}`,
    ].filter(Boolean);
    return (
      <div className="group relative">
        <AlertIcon className="w-5 h-5 text-red-500" />
        <div className="absolute bottom-full mb-2 w-max max-w-[200px] px-2 py-1 bg-gray-800 text-white text-[10px] rounded-md opacity-0 group-hover:opacity-100 z-50 pointer-events-none shadow-lg">
          {msgs.map((m, i) => <p key={i}>{m as string}</p>)}
        </div>
      </div>
    );
  };

  const renderLocationWithMap = (location: string) => {
    if (!location) return null;
    const match = location.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
    if (match) {
      const lat = match[1].replace(',', '.'), lng = match[2].replace(',', '.');
      return (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-sm font-semibold text-gray-700">Local:</span>
          <a href={`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-2 py-1 bg-blue-50 text-blue-600 rounded border border-blue-100 text-[10px] font-bold hover:bg-blue-100">
            <MapIcon className="w-3 h-3" /> Ver no Mapa
          </a>
        </div>
      );
    }
    return <p className="text-sm text-gray-700 break-all"><span className="font-semibold">Local:</span> {location}</p>;
  };

  // =================================================================
  // MEMOS
  // =================================================================
  const sortedRouteBikes = useMemo(() => {
    return [...routeBikes].sort((a, b) => {
      const detailsA = routeBikesDetails[a] || collectedBikesDetails[a] || searchCacheRef.current[a];
      const detailsB = routeBikesDetails[b] || collectedBikesDetails[b] || searchCacheRef.current[b];

      // Pega a distância direta em metros da rota se calculada, caso contrário calcula Haversine na hora
      const distA = routeDistances[a]?.directDistanceM !== undefined 
        ? routeDistances[a].directDistanceM 
        : (currentDriverLocation && detailsA?.currentLat && detailsA?.currentLng
          ? calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, detailsA.currentLat, detailsA.currentLng) * 1000
          : Infinity);

      const distB = routeDistances[b]?.directDistanceM !== undefined 
        ? routeDistances[b].directDistanceM 
        : (currentDriverLocation && detailsB?.currentLat && detailsB?.currentLng
          ? calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, detailsB.currentLat, detailsB.currentLng) * 1000
          : Infinity);

      if (distA === distB) return 0;
      return distA - distB;
    });
  }, [routeBikes, routeDistances, currentDriverLocation, routeBikesDetails, collectedBikesDetails]);

  const totalRouteSummary = useMemo(() => {
    let totalMDistance = 0;
    let totalMins = 0;
    let count = 0;

    sortedRouteBikes.forEach(bike => {
      const rd = routeDistances[bike];
      if (rd) {
        // rd.value represents the cumulative distance up to this point
        // To get the total distance of the whole route, we can just look closely or sum leg segments.
        // Wait, since 'value' stores the cumulative distance, the last item's 'value' is actually the total cumulative distance!
        // But to be completely safe against missing elements or sparse lists, we can also sum their values if they represent legs, 
        // or take the maximum of the cumulative values!
        // Yes, taking the maximum of the cumulative values represents the total trajectory length.
        if (rd.value && rd.value > totalMDistance) {
          totalMDistance = rd.value;
        }
        
        if (rd.durationS !== undefined) {
          totalMins += Math.round(rd.durationS / 60);
        } else {
          const match = rd.duration.match(/\d+/);
          if (match) {
            totalMins += parseInt(match[0], 10);
          }
        }
        count++;
      }
    });

    if (totalMDistance === 0 || count === 0) return null;

    const totalKm = totalMDistance / 1000;
    return {
      distance: totalKm < 1 ? `${totalMDistance.toFixed(0)}m` : `${totalKm.toFixed(1)}km`,
      duration: `~${totalMins} min`,
      count
    };
  }, [sortedRouteBikes, routeDistances]);

  const sortedCollectedBikes = useMemo(() => {
    return [...collectedBikes].sort((a, b) => {
      const nA = parseInt(a, 10) || 0, nB = parseInt(b, 10) || 0;
      if (nA !== nB) return nA - nB;
      return (collectedBikesDetails[b]?.battery ?? 0) - (collectedBikesDetails[a]?.battery ?? 0);
    });
  }, [collectedBikes, collectedBikesDetails]);

  const allActiveBikes = useMemo(() => {
    const bikes = new Set<string>();
    driversSummary.forEach(d => {
      (d.realTime?.route || []).forEach((b: string) => bikes.add(String(b).trim()));
      (d.realTime?.collected || []).forEach((b: string) => bikes.add(String(b).trim()));
    });
    return bikes;
  }, [driversSummary]);

  // =================================================================
  // AÇÕES DO MOTORISTA
  //
  // PADRÃO para toda ação:
  //   1. Marca operação ativa
  //   2. Atualiza estado local (otimista)
  //   3. Grava no Firebase + Sheets via persistDriverState()
  //   4. Registra markDriverAction()
  //   5. Libera operação
  // =================================================================

  const handleStatusUpdate = async (status: string) => {
    if (!searchedBike) return;
    const bikeNumber = String(searchedBike['Patrimônio']);
    if (processingBikesRef.current.has(bikeNumber)) return;

    processingBikesRef.current.add(bikeNumber);
    setProcessingBikes(new Set(processingBikesRef.current));
    isUpdatingStateRef.current = true;
    setIsLoading(true);

    let hasLaunchedBackground = false;

    try {
      // Usa estado local — protegido por isUpdatingStateRef=true, nenhum sync externo altera durante a operação
      // Usa refs para garantir o estado mais recente mesmo em cliques rápidos
      const currentRoute = routeBikesRef.current;
      const currentCollected = collectedBikesRef.current;
      
      let newRoute: string[] = [...currentRoute];
      let newCollected: string[] = [...currentCollected];

      if (status === 'Recolhida') {
        // Impede recolha de bikes em alerta que atingiram o limite de boletim
        const alertForBike = alerts.find(a => (a.patrimonio?.toString().trim() || a.id?.toString().trim()) === bikeNumber);
        if (alertForBike && alertForBike.check1 && alertForBike.check2 && alertForBike.check3) {
          alert(`Atenção! A bicicleta ${bikeNumber} atingiu o limite para Boletim e não pode ser recolhida.`);
          return;
        }

        if (currentCollected.includes(bikeNumber)) {
          alert(`Você já está em posse da bicicleta ${bikeNumber}.`);
          return;
        }

        newCollected = [...new Set([...newCollected, bikeNumber])];
        newRoute = newRoute.filter(b => String(b) !== bikeNumber);

        // 1. Atualiza UI e Refs imediatamente
        const isOcc = !!routeBikesDetails[bikeNumber]?.ocorrencia || !!searchedBike?.ocorrencia;
        setCollectedBikes(newCollected);
        setRouteBikes(newRoute);
        collectedBikesRef.current = newCollected;
        routeBikesRef.current = newRoute;
        
        // Protege contra sync do Sheets
        markBikeHandled(bikeNumber);
        
        setCollectedBikesDetails(prev => ({
          ...prev,
          [bikeNumber]: { 
            ...(routeBikesDetails[bikeNumber] || searchedBike || {}), 
            ocorrencia: isOcc 
          }
        }));

        setSearchedBike(null);
        setSearchTerm('');

        // 2. Registra ação antes das chamadas ao Sheets
        markDriverAction();

        // 3. Firebase + Sheets — fire-and-forget (não bloqueiam a UI)
        setDoc(doc(db, 'bikes', bikeNumber), {
          status: 'Recolhida', responsavel: driverName, ultimaAtualizacao: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('[Firebase] bikes write:', err.code));

        // Feedback imediato
        setSuccessMessage(`Bicicleta ${bikeNumber} recolhida!`);
        setIsLoading(false);
        hasLaunchedBackground = true;

        // Background
        (async () => {
          try {
            const timelinePromise = addDoc(collection(db, 'timeline_events'), {
              driverName, bikeNumber, type: 'em_posse',
              timestamp: serverTimestamp(),
              date: localDateStr(),
              isOccurrence: isOcc
            }).catch(err => console.warn('[Timeline] Erro:', err.code, err.message));

            const persistPromise = persistDriverState(newRoute, newCollected);

            await Promise.all([timelinePromise, persistPromise]);
          } catch (e) {
            console.error(`[Background] Erro ao processar recolha da bike ${bikeNumber}:`, e);
          } finally {
            isUpdatingStateRef.current = false;
            processingBikesRef.current.delete(bikeNumber);
            setProcessingBikes(new Set(processingBikesRef.current));
          }
        })();
        return; // Sai da função handleStatusUpdate
      }

      else if (status === 'Não encontrada') {
        newRoute = newRoute.filter(b => String(b) !== bikeNumber);

        // 1. Atualiza UI e Refs imediatamente
        setRouteBikes(newRoute);
        routeBikesRef.current = newRoute;
        
        // Protege contra sync do Sheets
        markBikeHandled(bikeNumber);

        setSearchedBike(null);
        setSearchTerm('');

        // 2. Registra ação antes das chamadas ao Sheets
        markDriverAction();

        // 3. Firebase + Sheets — fire-and-forget (não bloqueiam a UI)
        setDoc(doc(db, 'bikes', bikeNumber), {
          status: 'Não encontrada', responsavel: null, ultimaAtualizacao: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('[Firebase] bikes write:', err.code));

        // Feedback imediato de sucesso
        setSuccessMessage(`Bicicleta ${bikeNumber} marcada como não encontrada.`);
        setIsLoading(false);
        hasLaunchedBackground = true;

        // Processamento em background
        (async () => {
          try {
            // Inicia a busca de detalhes sem bloquear o registro
            const bikeDetailsPromise = fetchBikeDetailsForReport(bikeNumber, 3000);
            
            const firebaseBikesPromise = setDoc(doc(db, 'bikes', bikeNumber), {
              status: 'Não encontrada', responsavel: null, ultimaAtualizacao: serverTimestamp()
            }, { merge: true }).catch(err => console.warn('[Firebase] bikes write:', err.code));

            const timelinePromise = Promise.resolve(); // nao_encontrada vem do Sheets

            const sheetsPromise = apiCall({
              action: 'finalizeCollectedBike', driverName, bikeNumber,
              finalStatus: 'Não encontrada', finalObservation: 'Bicicleta não encontrada no local'
            }, 1, true).catch(e => console.warn('[Sheets] finalizeCollectedBike failed:', e));

            const persistPromise = persistDriverState(newRoute, newCollected);

            const reportPromise = (async () => {
              const bikeDetails = await bikeDetailsPromise;
              return addDoc(collection(db, 'reports'), {
                patrimonio: bikeNumber,
                motorista: driverName,
                status: 'Não encontrada',
                observacao: 'Bicicleta não encontrada no local',
                timestamp: serverTimestamp(),
                date: localDateStr(),
                type: 'Finalização',
                statusSistema: bikeDetails?.statusSistema || '',
                bateria: bikeDetails?.bateria || '',
                trava: bikeDetails?.trava || '',
                localidade: bikeDetails?.localidade || ''
              });
            })().catch(e => console.warn('[Firebase] reports write failed:', e));

            await Promise.all([firebaseBikesPromise, timelinePromise, sheetsPromise, persistPromise, reportPromise]);
          } catch (e) {
            console.error(`[Background] Erro ao processar bike ${bikeNumber}:`, e);
          } finally {
            processingBikesRef.current.delete(bikeNumber);
            setProcessingBikes(new Set(processingBikesRef.current));
            isUpdatingStateRef.current = false;
          }
        })();
        return; // Sai da função handleStatusUpdate pois o processamento agora é async
      }

    } catch (err: any) {
      console.error('Erro ao atualizar status:', err);
      setError('Erro ao atualizar status: ' + err.message);
    } finally {
      if (!hasLaunchedBackground) {
        isUpdatingStateRef.current = false;
        setIsLoading(false);
        processingBikesRef.current.delete(bikeNumber);
        setProcessingBikes(new Set(processingBikesRef.current));
      }
    }
  };

  const handleNaoAtendidaClick = async (bikeNumberInput: string | number, silent = false) => {
    const bikeNumber = String(bikeNumberInput);
    isUpdatingStateRef.current = true;
    if (!silent) setIsLoading(true);
    try {
      // Usa estado local — protegido por isUpdatingStateRef=true
      // Usa refs para garantir o estado mais recente mesmo em cliques rápidos
      const currentRoute = routeBikesRef.current;
      const currentCollected = collectedBikesRef.current;
      
      const newRoute = currentRoute.filter((b: string) => String(b) !== bikeNumber);
      const newCollected = [...currentCollected];

      // 1. Atualiza UI e Refs imediatamente
      setRouteBikes(newRoute);
      routeBikesRef.current = newRoute;

      // Protege contra sync do Sheets
      markBikeHandled(bikeNumber);

      // 2. Registra ação antes das chamadas ao Sheets
      markDriverAction();

      // 3. Firebase + Sheets — fire-and-forget
      setDoc(doc(db, 'bikes', bikeNumber), {
        status: 'Pendente', responsavel: null, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));

      // Feedback imediato
      if (!silent) setSuccessMessage(`Bicicleta ${bikeNumber} marcada como não atendida.`);
      if (!silent) setIsLoading(false);

      // Background
      (async () => {
        try {
          await persistDriverState(newRoute, newCollected);
        } finally {
          isUpdatingStateRef.current = false;
        }
      })();
    } catch (err: any) {
      console.error('Erro não atendida:', err);
      if (!silent) setError(`Erro ao processar bike ${bikeNumber}: ${err.message}`);
      isUpdatingStateRef.current = false;
      if (!silent) setIsLoading(false);
    }
  };

  const executeCollectedBikeAction = async (bikeNumberInput: string | number, status: string, observation: string) => {
    const bikeNumber = String(bikeNumberInput);
    if (processingBikesRef.current.has(bikeNumber)) return;
    if (!collectedBikes.map(String).includes(bikeNumber)) {
      alert(`A bicicleta ${bikeNumber} não está mais em sua posse.`);
      setDestinationModal(prev => ({ ...prev, isOpen: false }));
      return;
    }

    setDestinationModal(prev => ({ ...prev, isOpen: false }));
    isUpdatingStateRef.current = true;
    processingBikesRef.current.add(bikeNumber);
    setProcessingBikes(new Set(processingBikesRef.current));
    setIsLoading(true);

    // 1. Calcula novo estado com base no estado local já protegido por isUpdatingStateRef
    //    Usa refs para evitar stale closures em ações rápidas
    const currentCollected = collectedBikesRef.current;
    const currentRoute = routeBikesRef.current;
    
    const newCollected = currentCollected.filter(b => String(b) !== bikeNumber);
    const newRoute = currentRoute;

    // 2. Update local state (optimistic) and Refs
    setCollectedBikes(newCollected);
    collectedBikesRef.current = newCollected;
    routeBikesRef.current = newRoute;
    
    // Marca como manipulada recentemente para o sync ignorá-la por 2 minutos
    markBikeHandled(bikeNumber);

    const finalStatus = status === 'Enviada para Estação' ? 'Estação'
      : status === 'Enviada para Filial' ? 'Filial'
      : status;

    // 3. Registra ação ANTES das chamadas ao Sheets — protege contra sync que devolveria a bike
    markDriverAction();

    let finalObservation = observation;
    // Se a bike era uma ocorrência/solicitação, garante que o termo apareça na observação para o dashboard analítico
    const isOccurrence = !!collectedBikesDetails[bikeNumber]?.ocorrencia || !!routeBikesDetails[bikeNumber]?.ocorrencia;
    if (isOccurrence && !finalObservation.toLowerCase().includes('solicitado recolha')) {
      finalObservation = `Solicitado Recolha - ${finalObservation}`;
    }

        // 4. Execução em paralelo e não-bloqueante para agilidade total
        //    O motorista recebe o feedback de sucesso IMEDIATAMENTE após o estado local ser atualizado.
        setSuccessMessage(`Bicicleta ${bikeNumber} finalizada!`);
        setIsLoading(false);

        // Processamento em background
        (async () => {
          try {
            // Inicia a busca de detalhes sem bloquear os registros principais
            const bikeDetailsPromise = fetchBikeDetailsForReport(bikeNumber, 3000); // Timeout agressivo de 3s
            
            const firebaseBikesPromise = setDoc(doc(db, 'bikes', bikeNumber), {
              status: finalStatus, responsavel: null,
              observacao: finalObservation, ultimaAtualizacao: serverTimestamp()
            }, { merge: true }).catch(e => console.warn('[Firebase] bikes write failed:', e));

            const sheetsPromise = apiCall({
              action: 'finalizeCollectedBike', driverName, bikeNumber,
              finalStatus, finalObservation: finalObservation
            }, 3, false).catch(e => {
              console.error('[Sheets] finalizeCollectedBike FAILED definitively:', e);
              setSyncAlert(`Falha ao registrar bike ${bikeNumber} no Sheets após várias tentativas. Verifique sua conexão.`);
            });

            const timelinePromise = Promise.resolve(); // estacao/filial vêm do Sheets

            const persistPromise = persistDriverState(newRoute, newCollected);

            const deleteMechanicsFlowPromise = deleteDoc(doc(db, 'mechanics_flow', bikeNumber))
              .catch(e => console.warn('[Firebase] delete mechanics_flow failed:', e));
            const deleteTechnicalFlowPromise = deleteDoc(doc(db, 'technical_flow', bikeNumber))
              .catch(e => console.warn('[Firebase] delete technical_flow failed:', e));

            // Inicia o relatório em background - aguarda detalhes mas não trava os outros Promise.all
            const reportPromise = (async () => {
              const bikeDetails = await bikeDetailsPromise;
              return addDoc(collection(db, 'reports'), {
                patrimonio: bikeNumber,
                motorista: driverName,
                status: finalStatus,
                observacao: finalObservation,
                timestamp: serverTimestamp(),
                date: localDateStr(),
                type: 'Finalização',
                statusSistema: bikeDetails?.statusSistema || '',
                bateria: bikeDetails?.bateria || '',
                trava: bikeDetails?.trava || '',
                localidade: bikeDetails?.localidade || ''
              });
            })().catch(e => console.error('[Firebase] CRITICAL: reports write failed:', e));

            const notificationsPromise = (async () => {
              if (finalStatus !== 'Estação') return;
              const bikeDetails = await bikeDetailsPromise;
              if (!bikeDetails) return;

              const st = String(bikeDetails.statusSistema || '').trim().toUpperCase();
              const isNotActive = st !== 'ATIVO';
              const isLowBattery = bikeDetails.bateria !== undefined && bikeDetails.bateria !== '' && Number(bikeDetails.bateria) < 50;

              if (isNotActive || isLowBattery) {
                const reasons = [];
                if (isNotActive) reasons.push(`Status: ${bikeDetails.statusSistema}`);
                if (isLowBattery) reasons.push(`Bateria: ${bikeDetails.bateria}%`);

                const title = 'Entrega Irregular em Estação';
                const message = `Bike ${bikeNumber} entregue na estação. Motivo: ${reasons.join(' | ')}`;
                
                // Notifica ADM
                apiCall({
                  action: 'sendNotification',
                  recipient: 'ADM',
                  type: 'alerta_estacao',
                  title,
                  message,
                  bikes: [bikeNumber]
                }, 1, true).catch(() => {});

                // Notifica Motorista
                apiCall({
                  action: 'sendNotification',
                  recipient: driverName,
                  type: 'alerta_estacao',
                  title: 'Atenção: Entrega Irregular',
                  message,
                  bikes: [bikeNumber]
                }, 1, true).catch(() => {});
              }
            })().catch(e => console.warn('[Notifications] push failed:', e));

            await Promise.all([
              firebaseBikesPromise,
              sheetsPromise,
              timelinePromise,
              persistPromise,
              reportPromise,
              notificationsPromise,
              deleteMechanicsFlowPromise,
              deleteTechnicalFlowPromise
            ]);
          } catch (e) {
            console.error(`[Background] Erro ao processar bike ${bikeNumber}:`, e);
          } finally {
            isUpdatingStateRef.current = false;
            processingBikesRef.current.delete(bikeNumber);
            setProcessingBikes(new Set(processingBikesRef.current));
          }
        })();
  };

  // =================================================================
  // SOLICITAÇÕES
  // =================================================================
  const handleAcceptRequest = async (requestId: string, bikeNumbers: string, reason: string = '', title: string = '') => {
    if (isLoading) return;
    const bikesToAdd = String(bikeNumbers || '').split(',').map(s => s.trim()).filter(Boolean);
    const alreadyInPosse = bikesToAdd.filter(b => collectedBikes.includes(b));
    if (alreadyInPosse.length > 0) { alert(`Bikes já em sua posse: ${alreadyInPosse.join(', ')}`); return; }

    const lowerReason = (reason || '').toLowerCase();
    const lowerTitle = (title || '').toLowerCase();
    // v85.51: Verifica o padrão exato de colchetes '[carretinha]' para distinguir transferências reais de carretinha dos pedidos padrão
    const isTrailer = lowerReason.includes('[carretinha]') || lowerTitle.includes('[carretinha]');
    // v85.32: isRoute identifica apenas roteiros automáticos massivos do Sheets. 
    // Solicitações manuais ou via App de uma única bike (recolhas) são tratadas como Ocorrência.
    const isRoute = lowerTitle.includes('roteiro gerado') || lowerReason.includes('roteiro gerado');
    const isPickupRequest = !isTrailer && !isRoute;

    isUpdatingStateRef.current = true;
    setIsLoading(true);

    // Remove da lista IMEDIATAMENTE — antes de qualquer chamada async
    const normalizedReqId = String(requestId).trim();
    processedRequestIds.current.add(normalizedReqId);
    setPendingRequests(prev => prev.filter(r => String(r.id).trim() !== normalizedReqId));
    
    // Marca as bikes como manipuladas recentemente para evitar que o sync as remova do roteiro
    bikesToAdd.forEach(id => markBikeHandled(id));

    try {
      // IDs numéricos vêm do Sheets — não existem no Firestore.
      const isFirestoreId = String(requestId).length > 10 && isNaN(Number(requestId));
      if (isFirestoreId) {
        updateDoc(doc(db, 'requests', String(requestId)), {
          status: 'ACEITO', driverName, acceptedAt: serverTimestamp()
        }).catch(e => console.warn('[Firebase] requests update:', e.code));
      }

      // Usa estado local — protegido por isUpdatingStateRef=true
      // Usa refs para garantir o estado mais recente mesmo em cliques rápidos
      const currentRoute = routeBikesRef.current;
      const currentCollected = collectedBikesRef.current;
      
      let newRoute: string[] = [...currentRoute];
      let newCollected: string[] = [...currentCollected];

      if (isTrailer) {
        newCollected = [...new Set([...newCollected, ...bikesToAdd])];
        newRoute = newRoute.filter(b => !bikesToAdd.includes(String(b)));
        setCollectedBikes(newCollected);
        setRouteBikes(newRoute);
        collectedBikesRef.current = newCollected;
        routeBikesRef.current = newRoute;

        setCollectedBikesDetails(prev => {
          const next = { ...prev };
          bikesToAdd.forEach(id => {
            const existing = next[id] || {};
            const searchCached = searchCacheRef.current[id] || {};
            // v85.32: Garante inicialização e marca como ocorrência se for pedido direto
            next[id] = { 
              ...existing, 
              ...searchCached,
              ocorrencia: !!existing.ocorrencia || isPickupRequest 
            };
            
            if (title) {
              const m = title.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
              if (m) {
                const lat = parseFloat(m[1].replace(',', '.'));
                const lng = parseFloat(m[2].replace(',', '.'));
                // v85.32: Inicializa coordenadas para histórico se disponíveis
                next[id].initialLat = lat;
                next[id].initialLng = lng;
                next[id].currentLat = lat;
                next[id].currentLng = lng;
              }
            }
          });
          return next;
        });

        // Firebase não-bloqueante
        bikesToAdd.forEach(id => {
          setDoc(doc(db, 'bikes', id), {
            status: 'Recolhida', 
            responsavel: driverName, 
            carretinha: null,
            trailerStatus: null,
            ultimaAtualizacao: serverTimestamp()
          }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));
        });
      } else {
        newRoute = [...new Set([...newRoute, ...bikesToAdd])];
        newCollected = newCollected.filter(b => !bikesToAdd.includes(String(b)));
        
        setRouteBikes(newRoute);
        setCollectedBikes(newCollected);
        routeBikesRef.current = newRoute;
        collectedBikesRef.current = newCollected;

        setRouteBikesDetails(prev => {
          const next = { ...prev };
          bikesToAdd.forEach(id => {
            const existing = next[id] || {};
            const searchCached = searchCacheRef.current[id] || {};
            // v85.32: Garante inicialização correta e marca como ocorrência se for um pedido de recolha
            next[id] = { 
              ...existing, 
              ...searchCached,
              ocorrencia: !!existing.ocorrencia || isPickupRequest 
            };
            
            if (title) {
              const m = title.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
              if (m) {
                const lat = parseFloat(m[1].replace(',', '.'));
                const lng = parseFloat(m[2].replace(',', '.'));
                // v85.32: Sempre inicializa coordenadas se disponíveis para mostrar distância no roteiro
                next[id].initialLat = lat;
                next[id].initialLng = lng;
                next[id].currentLat = lat;
                next[id].currentLng = lng;
              }
            }
          });
          return next;
        });

        // Firebase não-bloqueante
        bikesToAdd.forEach(id => {
          setDoc(doc(db, 'bikes', id), {
            status: 'Em Rota', responsavel: driverName, ultimaAtualizacao: serverTimestamp()
          }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));
        });
      }

      // Feedback imediato e registro da ação
      markDriverAction();
      setSuccessMessage('Pedido aceito!');
      setIsLoading(false);

      // Background
      (async () => {
        try {
          // v85.39: Registra na Linha do Tempo a aceitação da Carretinha (Em Posse de fato)
          if (isTrailer) {
            await Promise.all(bikesToAdd.map(id => 
              addDoc(collection(db, 'timeline_events'), {
                driverName,
                bikeNumber: id,
                type: 'em_posse',
                timestamp: serverTimestamp(),
                date: localDateStr(),
                observacao: `Aceite: ${title || 'Solicitação'}`
              }).catch(e => console.warn('[Timeline] Erro no aceite:', e))
            ));
          }

          if (isTrailer) {
            await Promise.all([
              // carretinha: não grava no Firebase — aparece via Sheets (tipo nao_atendida)
              persistDriverState(newRoute, newCollected),
              apiCall({ action: 'acceptRequest', requestId, driverName })
            ]);
          } else {
            await Promise.all([
              persistDriverState(newRoute, newCollected),
              apiCall({ action: 'acceptRequest', requestId, driverName })
            ]);
          }
        } catch (e) {
          console.warn('[Background] Erro ao processar aceitação:', e);
        } finally {
          isUpdatingStateRef.current = false;
        }
      })();
    } catch (err: any) {
      console.error('Erro aceitar pedido:', err);
      setError('Erro ao aceitar pedido: ' + err.message);
      isUpdatingStateRef.current = false;
      setIsLoading(false);
    }
  };

  const handleDeclineRequest = async (requestId: string) => {
    if (isLoading) return;
    isUpdatingStateRef.current = true;
    setIsLoading(true);

    // Marca como processado imediatamente — nunca mais aparece na lista
    const normalizedReqId = String(requestId).trim();
    processedRequestIds.current.add(normalizedReqId);
    setPendingRequests(prev => prev.filter(r => String(r.id).trim() !== normalizedReqId));
    try {
      // Feedback imediato
      setSuccessMessage('Pedido recusado.');
      setIsLoading(false);

      // Background
      (async () => {
        try {
          const isFirestoreId = String(requestId).length > 10 && isNaN(Number(requestId));
          if (isFirestoreId) {
            updateDoc(doc(db, 'requests', String(requestId)), {
              status: 'RECUSADO', declinedBy: driverName, declinedAt: serverTimestamp()
            }).catch(e => console.warn('[Firebase] requests decline:', e.code));
          }
          await apiCall({ action: 'declineRequest', requestId, driverName })
            .catch(e => console.warn('[Sheets] declineRequest:', e));
        } finally {
          isUpdatingStateRef.current = false;
        }
      })();
    } catch (err: any) {
      setError('Erro ao recusar pedido: ' + err.message);
      isUpdatingStateRef.current = false;
      setIsLoading(false);
    }
  };

  const handleCreateRequest = async (details: { bikeNumber: string; location: string; reason: string; recipient: string }) => {
    // Impede solicitações para bikes em alerta que atingiram o limite de boletim
    const bikeNum = details.bikeNumber.trim();
    const alertForBike = alerts.find(a => (a.patrimonio?.toString().trim() || a.id?.toString().trim()) === bikeNum);
    
    if (alertForBike && alertForBike.check1 && alertForBike.check2 && alertForBike.check3) {
      alert(`Atenção! A bicicleta ${details.bikeNumber} atingiu o limite para Boletim e não pode receber novas solicitações.`);
      return;
    }

    setIsLoading(true);
    try {
      const result = await apiCall({ 
        action: 'createRequest', 
        patrimonio: details.bikeNumber, 
        ocorrencia: details.reason, 
        local: details.location, 
        recipient: details.recipient 
      });
      if (result.success) { alert('Solicitação criada!'); setRequestModalOpen(false); refreshAll(true); }
      else throw new Error(result.error);
    } catch (err: any) {
      alert(`Erro: ${err.message}`);
    } finally { setIsLoading(false); }
  };

  const handleCreateRoute = async (details: { routeName: string; bikeNumbers: string[]; recipient: string }) => {
    if (!details.bikeNumbers?.length) { alert('Insira ao menos uma bicicleta.'); return; }
    
    // Impede envio de bikes em alerta que atingiram o limite de boletim para o roteiro
    const boletimPats = new Set(
      alerts
        .filter(a => a.check1 && a.check2 && a.check3)
        .map(a => (a.patrimonio?.toString().trim() || a.id?.toString().trim()))
    );
    const blockedBikes = details.bikeNumbers.filter(num => boletimPats.has(num.trim()));
    if (blockedBikes.length > 0) {
      alert(`Atenção! As seguintes bicicletas atingiram o limite para Boletim e não podem ser enviadas para o roteiro:\n\n${blockedBikes.join(', ')}`);
      return;
    }

    setIsLoading(true);
    try {
      const result = await apiCall({
        action: 'createRequest', patrimonio: details.bikeNumbers.join(', '),
        ocorrencia: details.routeName || 'Roteiro', local: 'Criado via Roteiro App',
        recipient: details.recipient || 'Todos'
      });
      if (result.success) { alert('Roteiro enviado!'); setRouteModalOpen(false); refreshAll(true); }
      else throw new Error(result.error);
    } catch (err: any) {
      alert(`Erro: ${err.message}`);
    } finally { setIsLoading(false); }
  };

  const handleCreateTrailer = async (details: { routeName: string; bikeNumbers: string[]; recipient: string }) => {
    if (!details.bikeNumbers?.length) { alert('Insira ao menos uma bicicleta.'); return; }

    // Impede envio de bikes em alerta que atingiram o limite de boletim para a carretinha
    const boletimPats = new Set(
      alerts
        .filter(a => a.check1 && a.check2 && a.check3)
        .map(a => (a.patrimonio?.toString().trim() || a.id?.toString().trim()))
    );
    const blockedBikes = details.bikeNumbers.filter(num => boletimPats.has(num.trim()));
    if (blockedBikes.length > 0) {
      alert(`Atenção! As seguintes bicicletas atingiram o limite para Boletim e não podem ser enviadas para a carretinha:\n\n${blockedBikes.join(', ')}`);
      return;
    }

    setIsLoading(true);
    try {
      const result = await apiCall({
        action: 'createRequest', patrimonio: details.bikeNumbers.join(', '),
        ocorrencia: `[CARRETINHA] ${details.routeName || 'Sem Nome'}`,
        local: 'Criado via Carretinha App', recipient: details.recipient || 'Todos'
      });
      if (result.success) { alert('Carretinha enviada!'); setTrailerModalOpen(false); refreshAll(true); }
      else throw new Error(result.error);
    } catch (err: any) {
      alert(`Erro: ${err.message}`);
    } finally { setIsLoading(false); }
  };

  const mechanicsNames = useMemo(() => {
    const fromList = mechanicsList.filter(b => b.mecanico).map(b => b.mecanico);
    const activeMechs = dynamicMechanics.length > 0 ? dynamicMechanics : AUTHORIZED_MECHANICS_NORMALIZED;
    
    const normalizedSeen = new Set<string>();
    const result: string[] = [];
    
    activeMechs.forEach(m => {
      const norm = normalizeForSearch(m);
      if (norm && !normalizedSeen.has(norm)) {
        normalizedSeen.add(norm);
        result.push(m);
      }
    });
    
    fromList.forEach(m => {
      const norm = normalizeForSearch(m);
      if (norm && !normalizedSeen.has(norm)) {
        normalizedSeen.add(norm);
        result.push(m);
      }
    });

    return result
      .filter(name => {
        const uppercase = name.toUpperCase();
        return uppercase !== 'MECANICA' && uppercase !== 'TODOS' && uppercase !== '—' && uppercase !== '';
      })
      .sort();
  }, [mechanicsList, dynamicMechanics]);

  // =================================================================
  // BUSCA
  // =================================================================
  const handleManualInsert = (bikePat: string, targetStatus: string) => {
    if (targetStatus === 'Em Manutenção') {
      setManualMechanicModal({ isOpen: true, bikePat, targetStatus });
      return;
    }
    processManualInsert(bikePat, '', targetStatus);
  };

  const processManualInsert = async (bikePat: string, mechanicName: string, targetStatus: string) => {
    setIsBikeSearchLoading(true);
    try {
      let finalName = mechanicName || driverName;
      if (targetStatus === 'Reserva') {
        const existingBikeInFlow = mechanicsList.find(b => String(b.patrimonio).trim().replace(/^0+/, '') === String(bikePat).trim().replace(/^0+/, ''));
        if (existingBikeInFlow && existingBikeInFlow.status === 'Em Manutenção' && existingBikeInFlow.mecanico) {
          const existingMecNorm = normalizeForSearch(existingBikeInFlow.mecanico);
          if (existingMecNorm && existingMecNorm !== 'mecanica' && existingMecNorm !== 'mecanico') {
            finalName = existingBikeInFlow.mecanico;
          }
        }
      }

      if (isMecanica || isTecnica) {
        const directStatuses = isTecnica 
          ? ['Aguardando Técnica', 'Em Técnica']
          : ['Alterar Status', 'Reserva', 'Aguardando Manutenção', 'Em Manutenção', 'Não encontrada'];
          
        if (directStatuses.includes(targetStatus)) {
          protectMechanicBike(bikePat, targetStatus);
          
          // Tenta pegar a bateria do resultado da consulta atual se o patrimônio bater
          let currentBattery = undefined;
          if (searchedBike && String(searchedBike['Patrimônio']) === String(bikePat)) {
            currentBattery = formatBattery(searchedBike['Bateria']);
          }

          if (isTecnica) {
            await setDoc(doc(db, 'technical_flow', bikePat), {
              patrimonio: bikePat,
              status: targetStatus,
              dataEntrada: serverTimestamp(),
              [targetStatus === 'Em Técnica' ? 'tecnico' : 'mecanico']: finalName,
              bateria: currentBattery,
              ultimaAtualizacao: serverTimestamp()
            }, { merge: true }).catch(() => {});
          } else {
            await setDoc(doc(db, 'mechanics_flow', bikePat), {
              patrimonio: bikePat,
              status: targetStatus,
              dataEntrada: serverTimestamp(),
              mecanico: finalName,
              tratativa: 'MANUAL',
              bateria: currentBattery,
              ultimaAtualizacao: serverTimestamp()
            }, { merge: true }).catch(() => {});
          }
          
          setSuccessMessage(`Bike ${bikePat} movida para ${targetStatus}.`);
          setSearchedBike(null);
          setSearchTerm('');
          setBikeSearchTerm('');
          setBikeSearchResult([]);
          return;
        }
        // Outros status — envia direto ao ADM como antes
        await addDoc(collection(db, 'pending_actions'), {
          type: 'status_change',
          bikeNumber: bikePat,
          targetStatus,
          mechanicName: driverName,
          status: 'pending',
          timestamp: serverTimestamp()
        });
        setSuccessMessage(`Solicitação de alteração de status para bike ${bikePat} enviada ao ADM.`);
        setBikeSearchTerm('');
        setBikeSearchResult([]);
        return;
      }

      const res = await apiCall({
        action: 'insertBikeMechanics',
        bikeNumber: bikePat,
        mechanicName: finalName,
        targetStatus
      });
      
      if (res.success) {
        setSuccessMessage(`Bike ${bikePat} inserida em ${targetStatus}.`);
        refreshAll(true);
        setBikeSearchTerm('');
        setBikeSearchResult([]);
      } else {
        setError(res.error || 'Erro ao inserir bike.');
      }
    } catch {
      setError('Erro de conexão.');
    } finally {
      setIsBikeSearchLoading(false);
      setManualMechanicModal({ isOpen: false, bikePat: '', targetStatus: '' });
      setManualMechanicName('');
    }
  };

  const handleAdminAddBikeToMechanic = async () => {
    const bikeNum = newBikeNumber.trim().replace(/^0+/, '');
    if (!bikeNum) {
      alert('Por favor, informe o número da bike.');
      return;
    }
    if (!editingMechanic) return;

    setIsAdminBikeAdding(true);
    try {
      // 1. Update in mechanics_flow
      await setDoc(doc(db, 'mechanics_flow', bikeNum), {
        patrimonio: bikeNum,
        status: editingStatusChoice,
        mecanico: editingMechanic,
        dataEntrada: serverTimestamp(),
        ultimaAtualizacao: serverTimestamp()
      }, { merge: true });

      // 2. Update in bikes
      await setDoc(doc(db, 'bikes', bikeNum), {
        status: 'Mecânica',
        responsavel: editingMechanic,
        ultimaAtualizacao: serverTimestamp()
      }, { merge: true });

      // 3. Log report
      await addDoc(collection(db, 'reports'), {
        patrimonio: bikeNum,
        status: editingStatusChoice,
        motorista: editingMechanic,
        observacao: `Adicionada por ADM no perfil de ${editingMechanic}`,
        timestamp: serverTimestamp(),
        type: 'Mecânica'
      });

      // 4. Update optimistic state
      protectMechanicBike(bikeNum, {
        status: editingStatusChoice,
        mecanico: editingMechanic
      });

      setSuccessMessage(`Bike ${bikeNum} adicionada ao mecânico ${editingMechanic} (${editingStatusChoice}).`);
      setNewBikeNumber('');
    } catch (e: any) {
      console.error('[ADM Edit Mechanics] Failed to add bike:', e);
      alert('Erro ao adicionar bike: ' + e.message);
    } finally {
      setIsAdminBikeAdding(false);
    }
  };

  const handleAdminRemoveBikeFromMechanic = async (bikeNum: string, actionType: 'unassign' | 'delete') => {
    if (!editingMechanic) return;
    setAdminBikeActionLoading(bikeNum);
    try {
      if (actionType === 'unassign') {
        // Sets status to 'Aguardando Manutenção' and clears mecanico/responsavel
        await setDoc(doc(db, 'mechanics_flow', bikeNum), {
          status: 'Aguardando Manutenção',
          mecanico: null,
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });

        await setDoc(doc(db, 'bikes', bikeNum), {
          responsavel: null,
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });

        await addDoc(collection(db, 'reports'), {
          patrimonio: bikeNum,
          status: 'Aguardando Manutenção',
          motorista: 'ADM',
          observacao: `Desvinculada do mecânico ${editingMechanic} e retornada para Aguardando Manutenção por ADM`,
          timestamp: serverTimestamp(),
          type: 'Mecânica'
        });

        protectMechanicBike(bikeNum, {
          status: 'Aguardando Manutenção',
          mecanico: null
        });

        setSuccessMessage(`Bike ${bikeNum} retornada para Aguardando Manutenção.`);
      } else {
        // Completely deletes from mechanics_flow
        await deleteDoc(doc(db, 'mechanics_flow', bikeNum));

        await setDoc(doc(db, 'bikes', bikeNum), {
          responsavel: null,
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });

        await addDoc(collection(db, 'reports'), {
          patrimonio: bikeNum,
          status: 'Removida',
          motorista: 'ADM',
          observacao: `Removida do fluxo de oficina por ADM (estava com ${editingMechanic})`,
          timestamp: serverTimestamp(),
          type: 'Mecânica'
        });

        protectMechanicBike(bikeNum, {
          status: 'Removida',
          mecanico: null
        });

        setSuccessMessage(`Bike ${bikeNum} excluída do fluxo de oficina.`);
      }
    } catch (e: any) {
      console.error('[ADM Edit Mechanics] Failed to remove bike:', e);
      alert('Erro ao remover bike: ' + e.message);
    } finally {
      setAdminBikeActionLoading(null);
    }
  };

  // --- Almoxarifado Handlers ---
  const handleAddNewAlmoxarifadoItem = async () => {
    const code = newItemCodigo.trim().toUpperCase();
    const desc = newItemDescricao.trim();
    const supplier = newItemFornecedor.trim();
    const qty = newItemQuantidade === '' ? 0 : Number(newItemQuantidade);
    const minQty = newItemQtdMinima === '' ? 0 : Number(newItemQtdMinima);

    if (!code || !desc || !supplier) {
      alert('Por favor, preencha código, descrição e fornecedor.');
      return;
    }

    if (qty < 0) {
      alert('A quantidade inicial não pode ser negativa.');
      return;
    }

    if (minQty < 0) {
      alert('A quantidade mínima não pode ser negativa.');
      return;
    }

    // Check if code already exists in local list to avoid duplicate codes
    const exists = almoxarifadoItems.some(item => item.codigo.toUpperCase() === code);
    if (exists) {
      alert(`Já existe um item cadastrado com o código ${code}.`);
      return;
    }

    setIsSubmittingNewItem(true);
    try {
      const docId = code; // Using the code directly as Document ID is extremely elegant for uniqueness
      await setDoc(doc(db, 'almoxarifado', docId), {
        codigo: code,
        descricao: desc,
        fornecedor: supplier,
        quantidade: qty,
        qtdMinima: minQty,
        historico: []
      });

      setSuccessMessage(`Item ${desc} (${code}) cadastrado com sucesso.`);
      setNewItemCodigo('');
      setNewItemDescricao('');
      setNewItemFornecedor('');
      setNewItemQuantidade('');
      setNewItemQtdMinima('');
      setIsAddingNewItem(false);
    } catch (e: any) {
      console.error('[Almoxarifado] Error adding item:', e);
      alert('Erro ao cadastrar item: ' + e.message);
    } finally {
      setIsSubmittingNewItem(false);
    }
  };

  const handleUpdateMinStock = async (itemId: string, minQty: number) => {
    if (minQty < 0) {
      alert('A quantidade mínima não pode ser negativa.');
      return;
    }
    try {
      await setDoc(doc(db, 'almoxarifado', itemId), {
        qtdMinima: minQty
      }, { merge: true });
      setSuccessMessage(`Quantidade mínima do item atualizada para ${minQty}.`);
    } catch (e: any) {
      console.error('[Almoxarifado] Error updating minimum stock level:', e);
      alert('Erro ao atualizar quantidade mínima: ' + e.message);
    }
  };

  const handleRegisterStockMovement = async () => {
    if (!movingItem) return;

    const amount = Number(movementQuantidade);
    const user = movementUsuario.trim();
    const dateStr = movementData;

    if (!amount || amount <= 0) {
      alert('A quantidade deve ser um número maior que zero.');
      return;
    }

    if (!user) {
      alert('Por favor, informe quem está consumindo/responsável.');
      return;
    }

    if (!dateStr) {
      alert('Por favor, informe a data.');
      return;
    }

    // If removing (retirada), make sure we have enough stock
    if (movementTipo === 'retirada' && amount > movingItem.quantidade) {
      alert(`Estoque insuficiente! Saldo atual: ${movingItem.quantidade}.`);
      return;
    }

    setIsSubmittingMovement(true);
    try {
      const diff = movementTipo === 'entrada' ? amount : -amount;
      const newQty = movingItem.quantidade + diff;

      // Create new history log
      const newLog = {
        id: Math.random().toString(36).substring(2, 9),
        tipo: movementTipo,
        quantidade: amount,
        usuario: user,
        data: dateStr
      };

      const existingHistory = movingItem.historico || [];
      const updatedHistory = [newLog, ...existingHistory];

      await setDoc(doc(db, 'almoxarifado', movingItem.id), {
        quantidade: newQty,
        historico: updatedHistory
      }, { merge: true });

      setSuccessMessage(`Movimentação registrada com sucesso. Novo saldo: ${newQty}.`);
      setMovingItem(null);
      setMovementQuantidade('');
      setMovementUsuario('');
    } catch (e: any) {
      console.error('[Almoxarifado] Error saving movement:', e);
      alert('Erro ao registrar movimentação: ' + e.message);
    } finally {
      setIsSubmittingMovement(false);
    }
  };

  const handleDeleteAlmoxarifadoItem = async (itemId: string, desc: string) => {
    if (!confirm(`Tem certeza que deseja excluir permanentemente o item "${desc}"?`)) {
      return;
    }
    try {
      await deleteDoc(doc(db, 'almoxarifado', itemId));
      setSuccessMessage(`Item "${desc}" excluído com sucesso.`);
    } catch (e: any) {
      console.error('[Almoxarifado] Error deleting item:', e);
      alert('Erro ao excluir item: ' + e.message);
    }
  };

  const [isBoletimModalOpen, setIsBoletimModalOpen] = useState(false);
  const [boletimSearchTerm, setBoletimSearchTerm] = useState('');
  const [boletimResult, setBoletimResult] = useState<any>(null);
  const [isBoletimLoading, setIsBoletimLoading] = useState(false);
  const [boletimRecords, setBoletimRecords] = useState<any[]>([]);
  const [isBoletimRecordsLoading, setIsBoletimRecordsLoading] = useState(false);
  const [showBoletimForm, setShowBoletimForm] = useState(false);
  const [newBoletim, setNewBoletim] = useState({
    date: new Date().toISOString().split('T')[0],
    boNumber: '',
    author: driverName,
    summary: ''
  });

  const fetchBoletimRecords = async (bikePat: string) => {
    setIsBoletimRecordsLoading(true);
    try {
      const q = query(collection(db, 'boletins'), where('bikeNumber', '==', bikePat));
      const querySnapshot = await getDocs(q);
      const records = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setBoletimRecords(records.sort((a: any, b: any) => b.date.localeCompare(a.date)));
    } catch (err: any) {
      console.error('Erro ao buscar registros de boletim:', err);
    } finally {
      setIsBoletimRecordsLoading(false);
    }
  };

  const handleSaveBoletim = async () => {
    if (!boletimResult?.patrimonio || !newBoletim.boNumber || !newBoletim.date || !newBoletim.author) {
      alert('Preencha todos os campos obrigatórios.');
      return;
    }
    setIsBoletimLoading(true);
    try {
      await addDoc(collection(db, 'boletins'), {
        bikeNumber: boletimResult.patrimonio,
        ...newBoletim,
        timestamp: serverTimestamp()
      });
      alert('Boletim registrado com sucesso!');
      setNewBoletim({
        date: new Date().toISOString().split('T')[0],
        boNumber: '',
        author: driverName,
        summary: ''
      });
      setShowBoletimForm(false);
      fetchBoletimRecords(boletimResult.patrimonio);
    } catch (err: any) {
      alert('Erro ao salvar boletim: ' + err.message);
    } finally {
      setIsBoletimLoading(false);
    }
  };

  const handleBoletimSearch = async () => {
    if (!boletimSearchTerm.trim()) return;
    setIsBoletimLoading(true);
    setBoletimResult(null);
    setBoletimRecords([]);
    try {
      const res = await apiCall({ action: 'getChassiInfo', bikeNumber: boletimSearchTerm.trim() });
      if (res.success) {
        setBoletimResult(res.data);
        fetchBoletimRecords(res.data.patrimonio);
      } else {
        alert(res.error || 'Não encontrado na aba CHASSI.');
      }
    } catch (err: any) {
      alert('Erro ao buscar boletim: ' + err.message);
    } finally {
      setIsBoletimLoading(false);
    }
  };

  const fetchMechanicHistory = async () => {
    setIsMechanicHistoryLoading(true);
    try {
      // Busca reports de Reparo (saída) e Mecânica (entrada) do Firebase com limite de segurança
      const { getDocs: _gd, query: _q, where: _w, collection: _col, limit: _lim } = await import('firebase/firestore');
      const [snapReparo, snapEntrada] = await Promise.all([
        _gd(_q(_col(db, 'reports'), _w('type', '==', 'Reparo'), _lim(150))),
        _gd(_q(_col(db, 'reports'), _w('type', '==', 'Mecânica'), _lim(150))),
      ]);

      // Indexa entradas por bikeNumber — pega a mais recente antes da saída
      const entradas: Record<string, any[]> = {};
      snapEntrada.docs.forEach(d => {
        const rec = d.data();
        const pat = String(rec.patrimonio || rec.bikeNumber || '');
        if (!pat) return;
        if (!entradas[pat]) entradas[pat] = [];
        entradas[pat].push(rec);
      });

      const records = snapReparo.docs.map(d => {
        const data = d.data();
        const rec = { id: d.id, ...data } as any;
        const pat = String(rec.patrimonio || rec.bikeNumber || '');
        const tsOut = rec.timestamp?.toMillis?.() || 0;
        const entradasBike = (entradas[pat] || [])
          .filter(e => (e.dataEntrada?.toMillis?.() || e.timestamp?.toMillis?.() || 0) <= tsOut)
          .sort((a: any, b: any) => (b.dataEntrada?.toMillis?.() || b.timestamp?.toMillis?.() || 0) - (a.dataEntrada?.toMillis?.() || a.timestamp?.toMillis?.() || 0));
        const entrada = entradasBike[0];
        
        // Tratativa: se for um report de reparo, o campo tratamento pode estar em 'observacao' (Relatório normal) ou 'tratativa' (Mecânica)
        const obs = rec.observacao || rec.tratativa || '—';
        const treatment = obs.includes(' — ') ? obs.split(' — ')[1] : obs;

        const rawMecanico = rec.mecanico || rec.motorista || rec.driverName || '—';
        let mecanicoName = String(rawMecanico).trim();
        const mNorm = normalizeForSearch(mecanicoName);
        
        const foundDynamic = dynamicMechanics.find(name => normalizeForSearch(name) === mNorm);
        if (foundDynamic) {
          mecanicoName = foundDynamic;
        } else {
          if (mNorm === 'JOAO') mecanicoName = 'João';
          else if (mNorm === 'ANDRE') mecanicoName = 'André';
          else if (mNorm === 'KAUAN') mecanicoName = 'Kauan';
          else if (mNorm === 'FELIPE') mecanicoName = 'Felipe';
          else if (mNorm === 'RAFAEL') mecanicoName = 'Rafael';
        }

        return {
          ...rec,
          bikeNumber: pat,
          mecanico: mecanicoName,
          treatment: treatment,
          dataEntrada: entrada?.dataEntrada || entrada?.timestamp || null,
          dataSaida: rec.timestamp,
        };
      })
      .filter(r => {
        if (!r.bikeNumber) return false;
        const nameClean = normalizeForSearch(r.mecanico || '');
        return nameClean !== 'MECANICA' && nameClean !== 'TODOS' && nameClean !== '—' && nameClean !== '';
      })
      .sort((a: any, b: any) => (b.dataSaida?.toMillis?.() || 0) - (a.dataSaida?.toMillis?.() || 0));

      setMechanicHistory(records);
    } catch (e) {
      console.error('fetchMechanicHistory:', e);
    } finally {
      setIsMechanicHistoryLoading(false);
    }
  };

  const fetchTechnicaHistory = async () => {
    setIsTechnicaHistoryLoading(true);
    try {
      const { getDocs: _gd, query: _q, where: _w, collection: _col, limit: _lim } = await import('firebase/firestore');
      // Busca registros type Técnica — inclui Aguardando, Recebida, Devolvida com limite de segurança
      const [snapTec, snapMec] = await Promise.all([
        _gd(_q(_col(db, 'reports'), _w('type', '==', 'Técnica'), _lim(150))),
        _gd(_q(_col(db, 'reports'), _w('type', '==', 'Reparo'), _lim(150))),
      ]);

      // Indexa reparos por bike para cruzar com devolução
      const reparos: Record<string, any> = {};
      snapMec.docs.forEach(d => {
        const rec = d.data();
        const pat = String(rec.patrimonio || rec.bikeNumber || '');
        const ts = rec.timestamp?.toMillis?.() || 0;
        if (!reparos[pat] || ts > (reparos[pat].timestamp?.toMillis?.() || 0)) {
          reparos[pat] = rec;
        }
      });

      // Monta histórico a partir dos registros Técnica de saída (Devolvida)
      const devolvidas = snapTec.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .filter(r => (r.status || '').includes('Devolvida') || (r.observacao || '').includes('finalizada') || (r.observation || '').includes('finalizada'));

      // Para cada devolução, busca a entrada (Recebida)
      const entradas: Record<string, any[]> = {};
      snapTec.docs.forEach(d => {
        const rec = d.data();
        if ((rec.status || '').includes('Em Técnica') || (rec.observacao || '').includes('Recebida') || (rec.observation || '').includes('Recebida')) {
          const pat = String(rec.patrimonio || rec.bikeNumber || '');
          if (!entradas[pat]) entradas[pat] = [];
          entradas[pat].push(rec);
        }
      });

      const records = devolvidas.map(rec => {
        const pat = String(rec.patrimonio || rec.bikeNumber || '');
        const tsOut = rec.timestamp?.toMillis?.() || 0;
        const entrada = (entradas[pat] || [])
          .filter(e => (e.timestamp?.toMillis?.() || 0) <= tsOut)
          .sort((a: any, b: any) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0))[0];

        // Parser robusto de observacao para extrair reparos e mecânico original
        let treatment = '—';
        let originalMechanic = '—';
        const obs = rec.observacao || rec.observation || '';
        if (obs) {
          const dashIndex = obs.indexOf(' — ');
          const devIndex = obs.indexOf('. Devolvida para ');
          if (dashIndex !== -1 && devIndex !== -1) {
            treatment = obs.substring(dashIndex + 3, devIndex).trim();
            originalMechanic = obs.substring(devIndex + 17).trim();
          } else if (dashIndex !== -1) {
            treatment = obs.substring(dashIndex + 3).trim();
          } else {
            treatment = obs;
          }
        }

        let techName = rec.motorista || rec.mecanico || rec.driverName || '';
        if ((!techName || techName.toUpperCase() === 'TECNICA' || techName.toUpperCase() === 'TECNICO') && entrada) {
          techName = entrada.motorista || entrada.mecanico || entrada.driverName || '';
        }
        if (!techName || techName.toUpperCase() === 'TECNICA' || techName.toUpperCase() === 'TECNICO') {
          const obs = rec.observacao || rec.observation || '';
          if (/finalizada por Diego/i.test(obs)) {
            techName = 'Diego';
          } else if (/finalizada por Jhonatan/i.test(obs)) {
            techName = 'Jhonatan';
          } else if (entrada) {
            const entObs = entrada.observacao || entrada.observation || '';
            if (/Recebida pela Técnica — Diego/i.test(entObs)) {
              techName = 'Diego';
            } else if (/Recebida pela Técnica — Jhonatan/i.test(entObs)) {
              techName = 'Jhonatan';
            }
          }
        }
        if (techName.toUpperCase() === 'DIEGO') techName = 'Diego';
        if (techName.toUpperCase() === 'JHONATAN') techName = 'Jhonatan';
        if (!techName || techName.toUpperCase() === 'TECNICA' || techName.toUpperCase() === 'TECNICO') {
          techName = '—';
        }

        return {
          ...rec,
          bikeNumber: pat,
          tecnico: techName,
          dataEntrada: entrada?.timestamp || null,
          dataSaida: rec.timestamp,
          treatment: treatment || '—',
          originalMechanic: originalMechanic || '—',
        };
      }).sort((a: any, b: any) => (b.dataSaida?.toMillis?.() || 0) - (a.dataSaida?.toMillis?.() || 0));

      setTechnicaHistory(records);
    } catch (e) {
      console.error('fetchTechnicaHistory:', e);
    } finally {
      setIsTechnicaHistoryLoading(false);
    }
  };

  const handleBikeMovementSearch = async (termOverride?: any) => {
    // Se termOverride for um evento (objeto), ignoramos e usamos bikeSearchTerm
    const isEvent = termOverride && typeof termOverride === 'object' && 'nativeEvent' in termOverride;
    const finalTerm = isEvent ? bikeSearchTerm : (termOverride || bikeSearchTerm);
    
    const term = String(finalTerm || '').trim();
    if (!term) return;
    
    setBikeSearchTerm(term); // Sincroniza o campo de busca
    console.log('[Search] Iniciando busca para:', term);
    setIsBikeSearchLoading(true);
    setBikeSearchResult([]);
    
    try {
      // 1. Busca no Sheets (legado/sincronia)
      let allRecords: any[] = [];
      try {
        const sheetsResult = await apiCall({ action: 'getBikeMovement', bikeNumber: term, limit: bikeSearchLimit });
        if (sheetsResult.success && sheetsResult.data) {
          console.log('[Search] Sheets encontrou:', sheetsResult.data.length);
          allRecords = sheetsResult.data.map((r: any) => ({
            ...r,
            source: 'Sheets',
            timestamp: r.timestamp || r['Data/Hora'] || r.date,
            author: r.motorista || r['Nome do Motorista'] || r.author || '—',
            description: r.status || r.observacao || '—'
          }));
        }
      } catch (err) {
        console.warn('[Search] Erro ao buscar no Sheets:', err);
      }

      // 2. Busca no Firebase
      const termAsNum = parseInt(term);
      const isNum = !isNaN(termAsNum) && /^\d+$/.test(term);

      // Mapeamento de coleções e campos para busca
      const searchConfigs = [
        { col: 'reports', field: 'patrimonio', type: 'Relatório' },
        { col: 'reports', field: 'bikeNumber', type: 'Relatório' },
        { col: 'boletins', field: 'bikeNumber', type: 'Boletim' },
        { col: 'timeline_events', field: 'patrimonio', type: 'Linha do Tempo' },
        { col: 'timeline_events', field: 'bikeNumber', type: 'Linha do Tempo' }
      ];

      const queryPromises: Promise<any>[] = [];
      
      searchConfigs.forEach(config => {
        if (config.useId) {
          // Busca direta pelo ID do documento
          queryPromises.push(getDoc(doc(db, config.col, term)));
        } else {
          // Busca como string
          queryPromises.push(getDocs(query(collection(db, config.col), where(config.field, '==', term), limit(15))));
          // Busca como número se aplicável
          if (isNum) {
            queryPromises.push(getDocs(query(collection(db, config.col), where(config.field, '==', termAsNum), limit(15))));
          }
        }
      });

      const snapshots = await Promise.all(queryPromises);
      console.log('[Search] Firebase results recebidos:', snapshots.length);

      const firebaseRecords: any[] = [];
      const seenIds = new Set();

      const processDoc = (docSnap: any, defaultType: string, collectionName: string) => {
        if (!docSnap.exists()) return null;
        
        // Para coleções de fluxo ou status atual, usamos um ID composto para não serem barrados pelo seenIds
        // se a bike aparecer em múltiplas coleções (ex: bikes e mechanics_flow)
        const docId = collectionName === 'reports' || collectionName === 'timeline_events' || collectionName === 'boletins' 
          ? docSnap.id 
          : `${collectionName}_${docSnap.id}`;

        if (seenIds.has(docId)) return null;
        seenIds.add(docId);
        
        const data = docSnap.data();
        
        let ts = null;
        if (data.timestamp?.toDate) ts = data.timestamp.toDate();
        else if (data.date) ts = new Date(data.date);
        else if (data.timestamp) ts = new Date(data.timestamp);
        else if (data.dataEntrada?.toDate) ts = data.dataEntrada.toDate();
        else if (data.ultimaAtualizacao?.toDate) ts = data.ultimaAtualizacao.toDate();
        else if (data.dataSaida?.toDate) ts = data.dataSaida.toDate();
        else if (data.dataFinalizacao) ts = new Date(data.dataFinalizacao);
        else ts = new Date(); // Fallback para agora se não houver data

        const author = data.motorista || data.author || data.driverName || data.mecanico || data.tecnico || data.responsavel || '—';
        
        // Constrói uma descrição mais rica combinando status e outros campos
        let description = data.observacao || data.observation || data.tratativa || data.treatment || data.summary || data.action || data.motivo || data.reasons || '';
        const status = data.status || '';
        
        if (status && description && status !== description) {
          description = `${status}: ${description}`;
        } else if (status) {
          description = status;
        } else if (!description) {
          description = '—';
        }

        const location = data.localidade || data.room || data.estacao || data.station || '';

        return {
          id: docId,
          ...data,
          source: 'Firebase',
          timestamp: ts,
          author,
          description: location ? `${description} (${location})` : description,
          type: data.type || defaultType,
          origem: collectionName
        };
      };

      let resultIndex = 0;
      searchConfigs.forEach(config => {
        if (config.useId) {
          const docSnap = snapshots[resultIndex++];
          const r = processDoc(docSnap, config.type, config.col);
          if (r) firebaseRecords.push(r);
        } else {
          // Processa snapshot da busca por string
          const snapStr = snapshots[resultIndex++];
          if (snapStr && !snapStr.empty) {
            console.log(`[Search] ${config.col} (string) encontrou ${snapStr.docs.length}`);
            snapStr.docs.forEach((d: any) => {
              const r = processDoc(d, config.type, config.col);
              if (r) firebaseRecords.push(r);
            });
          }

          // Processa snapshot da busca por número
          if (isNum) {
            const snapNum = snapshots[resultIndex++];
            if (snapNum && !snapNum.empty) {
              console.log(`[Search] ${config.col} (number) encontrou ${snapNum.docs.length}`);
              snapNum.docs.forEach((d: any) => {
                const r = processDoc(d, config.type, config.col);
                if (r) firebaseRecords.push(r);
              });
            }
          }
        }
      });

      console.log('[Search] Total Firebase processado:', firebaseRecords.length);

      // Helper robusto para converter qualquer string ou timestamp pt-BR em Date em JS
      const parseMovementDate = (val: any): Date => {
        if (!val) return new Date(0);
        if (val instanceof Date) {
          return isNaN(val.getTime()) ? new Date(0) : val;
        }
        if (val && typeof val === 'object' && typeof val.toDate === 'function') {
          try {
            return val.toDate() || new Date(0);
          } catch {
            return new Date(0);
          }
        }
        const s = String(val).trim();
        if (!s) return new Date(0);
        if (/^\d{9,14}$/.test(s)) {
          const d = new Date(parseInt(s, 10));
          return isNaN(d.getTime()) ? new Date(0) : d;
        }
        if (s.includes('/')) {
          const parts = s.split(/[,\s]+/);
          const dp = parts[0].split('/');
          if (dp.length === 3) {
            const day = dp[0].padStart(2, '0');
            const month = dp[1].padStart(2, '0');
            const year = dp[2];
            let timePart = parts[1] || '';
            if (timePart) {
              const tParts = timePart.split(':');
              const hour = (tParts[0] || '0').padStart(2, '0');
              const min = (tParts[1] || '0').padStart(2, '0');
              const sec = (tParts[2] || '0').split(/[.,]/)[0].padStart(2, '0');
              timePart = `T${hour}:${min}:${sec}`;
            } else {
              timePart = 'T00:00:00';
            }
            const isoStr = `${year}-${month}-${day}${timePart}`;
            const d = new Date(isoStr);
            if (!isNaN(d.getTime())) return d;
          }
        }
        const d = new Date(s);
        return isNaN(d.getTime()) ? new Date(0) : d;
      };

      // Merge, normalização das datas e ordenação (mais recente primeiro)
      const rawMerged = [...allRecords, ...firebaseRecords].map(item => ({
        ...item,
        timestamp: parseMovementDate(item.timestamp)
      })).sort((a, b) => {
        return b.timestamp.getTime() - a.timestamp.getTime();
      });

      // Deduplicação inteligente de eventos repetidos entre Sheets e Firebase
      const deduplicated: any[] = [];
      rawMerged.forEach(item => {
        // Encontra se já existe um evento correspondente na lista de deduplicados
        const matchIndex = deduplicated.findIndex(existing => {
          // 1. Mesmo patrimônio (se disponível)
          const pat1 = String(item.patrimonio || item.bikeNumber || term || '').trim().replace(/^0+/, '');
          const pat2 = String(existing.patrimonio || existing.bikeNumber || term || '').trim().replace(/^0+/, '');
          if (pat1 !== pat2) return false;

          // 2. Intervalo de tempo menor ou igual a 5 minutos (300.000 ms)
          // considerando também as diferenças de fuso horário mais comuns (1h, 3h, 4h, 5h) entre Sheets (local) e Firebase (UTC)
          const t1 = item.timestamp.getTime();
          const t2 = existing.timestamp.getTime();
          if (isNaN(t1) || isNaN(t2)) return false;
          const diff = Math.abs(t1 - t2);
          const isClose = diff < 300000 || 
                          Math.abs(diff - 3600000) < 300000 ||   // 1h (Fuso)
                          Math.abs(diff - 10800000) < 300000 ||  // 3h (Fuso GMT-3 vs UTC)
                          Math.abs(diff - 14400000) < 300000 ||  // 4h (Fuso GMT-4 vs UTC)
                          Math.abs(diff - 18000000) < 300000;    // 5h (Fuso)
          if (!isClose) return false;

          // 3. Mesmo autor (comparação insensível a maiúsculas/minúsculas)
          const auth1 = String(item.author || item.mecanico || item.motorista || '').trim().toUpperCase();
          const auth2 = String(existing.author || existing.mecanico || existing.motorista || '').trim().toUpperCase();
          if (auth1 && auth2 && auth1 !== auth2) return false;

          // 4. Status parecidos
          const st1 = String(item.status || '').trim().toLowerCase();
          const st2 = String(existing.status || '').trim().toLowerCase();
          if (st1 && st2) {
            const match = st1.includes(st2) || st2.includes(st1) || 
                          st1.replace(/[^a-z0-9]/g, '') === st2.replace(/[^a-z0-9]/g, '');
            if (!match) return false;
          }

          return true;
        });

        if (matchIndex >= 0) {
          // Mescla as informações
          const existing = deduplicated[matchIndex];
          // Definir o primário (Firebase tem mais detalhes de tempo/texto)
          const primary = item.source === 'Firebase' ? item : existing;
          const secondary = item.source === 'Firebase' ? existing : item;

          let description = primary.description || '';
          if (secondary.description && secondary.description !== '—' && secondary.description !== primary.description) {
            if (!description || description === '—') {
              description = secondary.description;
            } else {
              const desc1Low = description.toLowerCase();
              const desc2Low = secondary.description.toLowerCase();
              if (!desc1Low.includes(desc2Low) && !desc2Low.includes(desc1Low)) {
                description = `${description} | ${secondary.description}`;
              }
            }
          }

          deduplicated[matchIndex] = {
            ...secondary,
            ...primary,
            description,
            bateria: primary.bateria || secondary.bateria,
            trava: primary.trava || secondary.trava,
            localidade: primary.localidade || secondary.localidade || primary.localFinal || secondary.localFinal,
            localFinal: primary.localFinal || secondary.localFinal || primary.localidade || secondary.localidade,
            trailerName: primary.trailerName || secondary.trailerName,
            treatment: primary.treatment || secondary.treatment,
            observacao: primary.observacao || secondary.observacao
          };
        } else {
          deduplicated.push(item);
        }
      });

      console.log('[Search] Total final merged:', deduplicated.length);
      setBikeSearchResult(deduplicated.slice(0, bikeSearchLimit));
    } catch (e: any) { 
      console.error('handleBikeMovementSearch error:', e);
      alert('Erro ao buscar movimentação: ' + e.message); 
    } finally { 
      setIsBikeSearchLoading(false); 
    }
  };

  const handleSearch = async (bikeToSearch?: string) => {
    const term = (bikeToSearch || searchTerm).trim();
    if (!term) { setSearchedBike(null); setSearchTerm(''); return; }
    if (bikeToSearch) setSearchTerm(bikeToSearch);

    const cached = searchCacheRef.current[term];
    if (cached) {
      setSearchedBike(cached);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      apiCall({ action: 'search', bikeNumber: term, driverName }, 1, true).then(r => {
        if (r.success && r.data) {
          const s = { ...r.data, 'Patrimônio': String(r.data['Patrimônio']) };
          searchCacheRef.current[term] = s;
          setSearchedBike(s);
        }
      }).catch(() => {});
      return;
    }

    setIsSearching(true);
    setError(null);
    try {
      const result = await apiCall({ action: 'search', bikeNumber: term, driverName });
      if (result.success && result.data) {
        const s = { ...result.data, 'Patrimônio': String(result.data['Patrimônio']) };
        setSearchedBike(s);
        searchCacheRef.current[term] = s;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setSearchedBike(null);
        const errorMsg = result.error || 'Bicicleta não encontrada.';
        setError(errorMsg);
        
      }
    } catch (err: any) {
      setSearchedBike(null);
      setError(err.message);
    } finally { setIsSearching(false); }
  };

  // =================================================================
  // ESTAÇÃO / POSIÇÃO
  // =================================================================
  const getCurrentPosition = (): Promise<{ latitude: number; longitude: number }> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ latitude: -23.5433, longitude: -46.6333 });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        err => {
          console.warn("getCurrentPosition warn (falling back to central SP):", err.message);
          resolve({ latitude: -23.5433, longitude: -46.6333 });
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
      );
    });

  const getNearestStation = async (): Promise<string> => {
    try {
      const pos = await getCurrentPosition();
      const closest = stations.reduce((prev, curr) => {
        const dist = getDistanceInMeters(pos.latitude, pos.longitude, curr.Latitude, curr.Longitude);
        return dist < prev.minDistance ? { station: curr, minDistance: dist } : prev;
      }, { station: null as any, minDistance: Infinity });
      return closest.station && closest.minDistance <= 50 ? closest.station.Name : 'Fora da Estação';
    } catch { return 'Fora da Estação'; }
  };

  const handleCollectedBikeAction = (bikeNumber: string, status: string) => {
    if (status === 'Enviada para Estação') {
      let initial = 'Buscando...';
      if (currentDriverLocation) {
        const closest = stations.reduce((prev, curr) => {
          const dist = getDistanceInMeters(currentDriverLocation.lat, currentDriverLocation.lng, curr.Latitude, curr.Longitude);
          return dist < prev.minDistance ? { station: curr, minDistance: dist } : prev;
        }, { station: null as any, minDistance: Infinity });
        initial = closest.station && closest.minDistance <= 50 ? closest.station.Name : 'Fora da Estação';
      }
      setDestinationModal({ isOpen: true, bikeNumber, type: 'Estação', stationName: initial });
      if (initial === 'Buscando...') {
        getNearestStation().then(name =>
          setDestinationModal(prev => prev.isOpen && prev.bikeNumber === bikeNumber ? { ...prev, stationName: name } : prev)
        );
      }
    } else if (status === 'Enviada para Filial') {
      setDestinationModal({ isOpen: true, bikeNumber, type: 'Filial' });
    } else if (status === 'Vandalizada') {
      setDestinationModal({ isOpen: true, bikeNumber, type: 'Vandalizada' });
    }
  };

  const recalculateStation = async () => {
    const bikeNumber = destinationModal.bikeNumber;
    setDestinationModal(prev => ({ ...prev, stationName: 'Buscando...' }));
    const name = await getNearestStation();
    setDestinationModal(prev => prev.isOpen && prev.bikeNumber === bikeNumber ? { ...prev, stationName: name } : prev);
  };

  // =================================================================
  // MECÂNICA
  // =================================================================
  const handleConfirmMechanicsReceipt = (bikeNumber: string) => {
    setSelectedMechanicBike({ patrimonio: bikeNumber });
    setIsMechanicSelectionModalOpen(true);
  };

  // Ref para o ID do documento agregador de "alterar status" do mecânico atual
  const alterarStatusDocRef = useRef<string | null>(null);

  // Ref para proteger atualizações otimistas da mecânica do sync do Sheets
  // Map de patrimônio → { status, expiresAt } — protege por 30s após cada ação
  // Plain object ref — avoids Map constructor issues in this environment
  const mechanicOptimisticRef = useRef<Record<string, any>>({});

  const protectMechanicBike = (patrimonio: string, data: string | Record<string, any>) => {
    const fields = typeof data === 'string' ? { status: data } : data;
    mechanicOptimisticRef.current[String(patrimonio)] = {
      ...fields,
      expiresAt: Date.now() + 120000, // 120s de proteção — cobre latência maior do Apps Script
    };
  };

  const handleAlterarStatus = async (bikeId: string) => {
    // 1. Atualiza estado local imediatamente — bike some de "Alterar Status"
    protectMechanicBike(bikeId, { status: 'Aguardando Manutenção' });
    
    const bike = mechanicsList.find(b => b.patrimonio === bikeId);
    const flowData = {
      status: 'Aguardando Manutenção',
      motorista: bike?.motorista || '',
      observacao: bike?.observacao || '',
      bateria: bike?.bateria || 0,
      carregamento: bike?.carregamento || '',
      dataEntrada: serverTimestamp(),
      patrimonio: bikeId
    };

    if (isMecanica) {
      try {
        // 1. Move no Firebase — fonte de verdade agora
        await setDoc(doc(db, 'mechanics_flow', bikeId), flowData);
        
        try {
          const bikeDetailsPromise = fetchBikeDetailsForReport(bikeId, 3000);
          (async () => {
            const bikeDetails = await bikeDetailsPromise;
            await addDoc(collection(db, 'reports'), {
              patrimonio: bikeId,
              status: 'Aguardando Manutenção',
              motorista: driverName,
              observacao: `Enviada para Aguardando Manutenção por ${driverName}`,
              timestamp: serverTimestamp(),
              type: 'Mecânica',
              statusSistema: bikeDetails?.statusSistema || '',
              bateria: bikeDetails?.bateria || '',
              trava: bikeDetails?.trava || '',
              localidade: bikeDetails?.localidade || ''
            });
          })().catch(e => console.warn('[Firebase] reports write failed:', e));
        } catch (e) {
          console.warn('[Firebase] reports write failed, but continuing:', e);
        }

        // 2. Agrupa num único doc no Firebase — busca doc pendente existente antes de criar novo
        const { arrayUnion, getDocs: _getDocs, query: _query, where: _where } = await import('firebase/firestore');
        
        if (!alterarStatusDocRef.current) {
          try {
            // Busca doc pendente já existente deste mecânico para não criar duplicata
            const existingSnap = await _getDocs(
              _query(
                collection(db, 'pending_actions'),
                _where('type', '==', 'alterar_status_lote'),
                _where('mechanicName', '==', driverName),
                _where('status', '==', 'pending')
              )
            );
            if (!existingSnap.empty) {
              alterarStatusDocRef.current = existingSnap.docs[0].id;
            }
          } catch (e) {
            handleFirestoreError(e, OperationType.LIST, 'pending_actions');
          }
        }

        if (alterarStatusDocRef.current) {
          try {
            // Adiciona bike ao doc existente
            await updateDoc(doc(db, 'pending_actions', alterarStatusDocRef.current), {
              bikes: arrayUnion(bikeId),
              timestamp: serverTimestamp(),
            });
          } catch (e) {
            handleFirestoreError(e, OperationType.UPDATE, `pending_actions/${alterarStatusDocRef.current}`);
          }
        } else {
          try {
            // Cria novo doc agregador
            const docRef = await addDoc(collection(db, 'pending_actions'), {
              type: 'alterar_status_lote',
              bikes: [bikeId],
              mechanicName: driverName,
              status: 'pending',
              timestamp: serverTimestamp(),
            });
            alterarStatusDocRef.current = docRef.id;
          } catch (e) {
            handleFirestoreError(e, OperationType.CREATE, 'pending_actions');
          }
        }

        setSuccessMessage(`Bike ${bikeId} → Aguardando Manutenção.`);
      } catch (e: any) {
        alert('Erro ao enviar solicitação: ' + e.message);
      }
      return;
    }

    // ADM / perfil com acesso direto: move direto no Firebase
    try {
      await setDoc(doc(db, 'mechanics_flow', bikeId), {
        status: 'Aguardando Manutenção',
        ultimaAtualizacao: serverTimestamp()
      }, { merge: true });
    } catch (err: any) {
      console.error('Erro ao mover para Aguardando Manutenção no Firebase:', err);
    }
  };

  const handleMarkAsNotFound = async (bikeId: string) => {
    setIsLoading(true);
    // Optimistic: remove from list immediately
    setMechanicsList(prev => prev.filter(b => b.patrimonio !== bikeId));
    try {
      // 1. Remove do fluxo da mecânica no Firebase
      try {
        await deleteDoc(doc(db, 'mechanics_flow', bikeId));
      } catch (e) {
        console.warn('[Firebase] mechanics_flow delete failed:', e);
      }

      await apiCall({ action: 'markAsNotFound', bikeNumber: bikeId, mechanicName: driverName });
    } catch (err: any) {
      refreshAll(true); // revert on error
      console.error('Erro ao processar:', err);
    } finally {
      setIsLoading(false);
      setMechanicNotFoundModal(null);
    }
  };

  const handleZerarListaStatus = () => {
    setIsZerarListaConfirmOpen(false);
  };

  const handleSendToTechnical = async (bikePat: string, mechanicName?: string) => {
    setIsLoading(true);
    const finalMechanic = mechanicName || (isMecanica ? driverName : null);

    // Otimista — protege e remove da lista Mecânica imediatamente
    protectMechanicBike(bikePat, { status: 'Aguardando Técnica', responsavel: finalMechanic, mecanico: finalMechanic });
    setMechanicsList(prev => prev.filter(b => b.patrimonio !== bikePat));
    try {
      // 1. Remove do fluxo da mecânica se estiver lá
      try {
        await deleteDoc(doc(db, 'mechanics_flow', bikePat));
      } catch (e) {
        console.warn('[Firebase] mechanics_flow delete failed:', e);
      }

      // 2. Adiciona ao fluxo da técnica
      try {
        await setDoc(doc(db, 'technical_flow', bikePat), {
          patrimonio: bikePat,
          status: 'Aguardando Técnica',
          mecanico: finalMechanic,
          dataEntrada: serverTimestamp(),
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.warn('[Firebase] technical_flow write failed:', e);
      }

      // 3. Atualiza status global da bike
      try {
        await setDoc(doc(db, 'bikes', bikePat), {
          status: 'Aguardando Técnica', 
          responsavel: finalMechanic, 
          mecanico: finalMechanic,
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.warn('[Firebase] bikes write failed:', e);
      }

      // 4. Relatório
      (async () => {
        try {
          const bikeDetails = await fetchBikeDetailsForReport(bikePat, 3000);
          await addDoc(collection(db, 'reports'), {
            patrimonio: bikePat,
            status: 'Aguardando Técnica',
            motorista: finalMechanic || driverName,
            observacao: `Enviada para Técnica por ${driverName}`,
            timestamp: serverTimestamp(),
            type: 'Técnica',
            statusSistema: bikeDetails?.['Status'] || bikeDetails?.statusSistema || '',
            bateria: bikeDetails?.['Bateria'] || bikeDetails?.bateria || '',
            trava: bikeDetails?.['Trava'] || bikeDetails?.trava || '',
            localidade: bikeDetails?.['Localidade'] || bikeDetails?.localidade || ''
          });
        } catch (e) {
          console.warn('[Firebase] reports write failed:', e);
        }
      })();
    } catch (err: any) {
      console.error('Erro ao enviar para técnica:', err);
      setError('Erro ao enviar para técnica: ' + err.message);
    } finally {
      setIsLoading(false);
      setIsTechnicalConfirmOpen(null);
    }
  };

  const handleConfirmTechnicaReceipt = (bike: any) => {
    // Abre modal de seleção de técnico — não processa direto
    setTechnicaReceiptModal({ bikeNumber: bike.patrimonio, originalMechanic: bike.mecanico || '' });
  };

  const executeConfirmTechnicaReceipt = async (bikeNumber: string, technicianName: string) => {
    setTechnicaReceiptModal(null);
    setIsLoading(true);
    try {
      // 1. Atualiza no fluxo da técnica
      try {
        await setDoc(doc(db, 'technical_flow', bikeNumber), {
          status: 'Em Técnica',
          tecnico: technicianName,
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.warn('[Firebase] technical_flow update failed:', e);
      }

      // 2. Atualiza status global da bike
      try {
        await setDoc(doc(db, 'bikes', bikeNumber), {
          status: 'Em Técnica', 
          responsavel: technicianName, 
          tecnico: technicianName,
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `bikes/${bikeNumber}`);
      }

      // 3. Relatório
      (async () => {
        try {
          const bikeDetails = await fetchBikeDetailsForReport(bikeNumber, 3000);
          await addDoc(collection(db, 'reports'), {
            patrimonio: bikeNumber,
            status: 'Em Técnica',
            motorista: technicianName,
            observacao: `Recebida pela Técnica — ${technicianName}`,
            timestamp: serverTimestamp(),
            type: 'Técnica',
            statusSistema: bikeDetails?.['Status'] || bikeDetails?.statusSistema || '',
            bateria: bikeDetails?.['Bateria'] || bikeDetails?.bateria || '',
            trava: bikeDetails?.['Trava'] || bikeDetails?.trava || '',
            localidade: bikeDetails?.['Localidade'] || bikeDetails?.localidade || ''
          });
        } catch (e) {
          console.warn('[Firebase] reports write failed:', e);
        }
      })();
    } catch (err: any) {
      setError('Erro: ' + err.message);
    } finally { setIsLoading(false); }
  };

  const handleFinalizeTechnicaRepair = async (bike: any) => {
    setTechnicaRepairModal({ bike });
    setTechnicaRepairSelected(new Set());
    
    // Busca o mecânico original no Firestore para garantir que não usamos dados possivelmente 
    // sobrescritos no Sheets durante o processo técnico
    try {
      const bikeDoc = await getDocFromServer(doc(db, 'bikes', bike.patrimonio));
      if (bikeDoc.exists()) {
        const data = bikeDoc.data();
        if (data.mecanico) {
          setTechnicaRepairModal(prev => prev ? { ...prev, bike: { ...prev.bike, mecanico: data.mecanico } } : null);
        }
      }
    } catch (e) {
      console.warn('[Firebase] Erro ao buscar mecânico original:', e);
    }
  };

  const executeFinalizeTechnicaRepair = async () => {
    if (!technicaRepairModal || technicaRepairSelected.size === 0) return;
    const { bike } = technicaRepairModal;
    const bikeNumber = bike.patrimonio;
    
    const originalMechanic = (bike.mecanico && bike.mecanico !== driverName) ? bike.mecanico : '';
    const treatment = Array.from(technicaRepairSelected).join(', ');
    
    const finalStatus = originalMechanic ? 'Em Manutenção' : 'Aguardando Manutenção';
    const finalResponsavel = originalMechanic || null;

    setTechnicaRepairModal(null);
    setTechnicaRepairSelected(new Set());
    setIsLoading(true);
    try {
      // 1. Remove do fluxo da técnica
      try {
        const { deleteDoc: _deleteDoc } = await import('firebase/firestore');
        await _deleteDoc(doc(db, 'technical_flow', bikeNumber));
      } catch (e) {
        console.warn('[Firebase] technical_flow delete failed:', e);
      }

      // 2. Adiciona de volta ao fluxo da mecânica
      try {
        await setDoc(doc(db, 'mechanics_flow', bikeNumber), {
          patrimonio: bikeNumber,
          status: finalStatus,
          mecanico: finalResponsavel,
          dataEntrada: serverTimestamp(),
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.warn('[Firebase] mechanics_flow write failed:', e);
      }

      // 3. Atualiza status global da bike
      try {
        await setDoc(doc(db, 'bikes', bikeNumber), {
          status: finalStatus, 
          responsavel: finalResponsavel, 
          mecanico: finalResponsavel,
          tecnico: null,
          ultimaAtualizacao: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `bikes/${bikeNumber}`);
      }

      // 4. Relatório
      (async () => {
        try {
          const bikeDetails = await fetchBikeDetailsForReport(bikeNumber, 3000);
          const techName = bike.tecnico || driverName;
          await addDoc(collection(db, 'reports'), {
            patrimonio: bikeNumber,
            status: 'Devolvida da Técnica',
            motorista: techName,
            observacao: `Técnica finalizada por ${techName} — ${treatment}. Devolvida para ${originalMechanic || 'Aguardando Manutenção'}`,
            timestamp: serverTimestamp(),
            type: 'Técnica',
            statusSistema: bikeDetails?.['Status'] || bikeDetails?.statusSistema || '',
            bateria: bikeDetails?.['Bateria'] || bikeDetails?.bateria || '',
            trava: bikeDetails?.['Trava'] || bikeDetails?.trava || '',
            localidade: bikeDetails?.['Localidade'] || bikeDetails?.localidade || ''
          });
        } catch (e) {
          console.warn('[Firebase] reports write failed:', e);
        }
      })();

      setSuccessMessage(`Bike ${bikeNumber} devolvida para ${originalMechanic || 'Mecânica'} — ${finalStatus}.`);
    } catch (err: any) {
      setError('Erro: ' + err.message);
    } finally { setIsLoading(false); }
  };

  const handleOpenLockerVandalizedModal = (bike: any) => {
    setLockerVandalizedModal({ bike });
    setLockerVandalizedIssue('');
    setLockerVandalizedBikeCondition(null);
    setLockerVandalizedBikeRoom('');
    setLockerVandalizedLockerBox('');
  };

  const handleLockerVandalizedSubmit = async () => {
    if (!lockerVandalizedModal) return;
    if (!lockerVandalizedIssue) {
      alert("Por favor, selecione o problema do locker.");
      return;
    }
    if (!lockerVandalizedBikeCondition) {
      alert("Por favor, selecione a condição da bike.");
      return;
    }
    if (!lockerVandalizedBikeRoom) {
      alert("Por favor, selecione o local da bike.");
      return;
    }
    if (!lockerVandalizedLockerBox) {
      alert("Por favor, selecione o local do locker.");
      return;
    }

    const { bike } = lockerVandalizedModal;
    const bikePat = bike.patrimonio;

    setLockerVandalizedModal(null);
    setIsLoading(true);

    const fullDefect = `Locker Vandalizado: ${lockerVandalizedIssue}`;
    const bikeConditionText = lockerVandalizedBikeCondition === 'BOA' ? 'BOA' : 'RUIM';
    const observation = `Locker: ${lockerVandalizedIssue} (Bike ${bikeConditionText}) | Box: ${lockerVandalizedLockerBox} | Sala: ${lockerVandalizedBikeRoom}`;

    try {
      // 1. Remove do fluxo da técnica no Firebase
      try {
        const { deleteDoc: _deleteDoc } = await import('firebase/firestore');
        await _deleteDoc(doc(db, 'technical_flow', bikePat));
      } catch (e) {
        console.warn('[Firebase] technical_flow delete failed:', e);
      }

      // 2. Atualiza a bike no Firebase
      try {
        await setDoc(doc(db, 'bikes', bikePat), { 
          status: 'Vandalizada', 
          responsavel: driverName, 
          observacao: observation,
          localFinal: lockerVandalizedBikeRoom,
          lockerIssue: lockerVandalizedIssue,
          bikeCondition: bikeConditionText,
          lockerLocation: lockerVandalizedLockerBox,
          ultimaAtualizacao: serverTimestamp() 
        }, { merge: true });

        // Adiciona à coleção 'vandalized'
        await setDoc(doc(db, 'vandalized', bikePat), {
          patrimonio: bikePat,
          data: new Date().toISOString(),
          defeito: fullDefect,
          local: lockerVandalizedBikeRoom,
          status: 'pendente',
          responsavel: driverName,
          timestamp: serverTimestamp(),
          condicaoBike: bikeConditionText,
          caixaLocker: lockerVandalizedLockerBox
        });

        // Adiciona ao relatório Firebase
        try {
          const bikeDetails = await fetchBikeDetailsForReport(bikePat, 3000);
          await addDoc(collection(db, 'reports'), {
            patrimonio: bikePat,
            status: 'Vandalizada',
            motorista: driverName,
            observacao: observation,
            timestamp: serverTimestamp(),
            type: 'Técnica',
            statusSistema: bikeDetails?.['Status'] || bikeDetails?.statusSistema || '',
            bateria: bikeDetails?.['Bateria'] || bikeDetails?.bateria || '',
            trava: bikeDetails?.['Trava'] || bikeDetails?.trava || '',
            localidade: bikeDetails?.['Localidade'] || bikeDetails?.localidade || ''
          });
        } catch (e) {
          console.warn('[Firebase] reports write failed:', e);
        }
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `bikes/${bikePat}`);
      }

      // 3. Envia para o Sheets com a observação bem formatada
      apiCall({ 
        action: 'markAsVandalizedNoRecovery', 
        bikeNumber: bikePat, 
        mechanicName: driverName, 
        room: lockerVandalizedBikeRoom, 
        reasons: observation 
      }).catch(e => {
        console.error('[Sheets] markAsVandalizedNoRecovery failed:', e);
        setSyncAlert(`Falha ao registrar locker vandalizado no Sheets. Salvo no Firebase.`);
      });

      setSuccessMessage(`Bike ${bikePat} marcada como Locker Vandalizado na ${lockerVandalizedBikeRoom}.`);
      refreshAll(true);
    } catch (err: any) {
      setError('Erro: ' + err.message);
    } finally {
      setIsLoading(false);
      setLockerVandalizedIssue('');
      setLockerVandalizedBikeCondition(null);
      setLockerVandalizedBikeRoom('');
      setLockerVandalizedLockerBox('');
    }
  };

  const handleMarkAsVandalizedNoRecovery = async (bikePat: string, reasons: string, room: string) => {
    setIsLoading(true);
    const observation = [reasons, room ? `Local: ${room}` : ''].filter(Boolean).join(' | ');
    try {
      // 1. Proteger a bike de ser revertida pelo sync (120s)
      protectMechanicBike(bikePat, { status: 'Vandalizada', localidade: room });
      
      // 2. Atualização otimista — remove da lista imediatamente
      setMechanicsList(prev => prev.filter(b => b.patrimonio !== bikePat));

      try {
        await setDoc(doc(db, 'bikes', bikePat), { 
          status: 'Vandalizada', 
          responsavel: driverName, 
          observacao: observation,
          localFinal: room || null,
          ultimaAtualizacao: serverTimestamp() 
        }, { merge: true });

        // Adiciona à coleção 'vandalized' para visualização do ADM
        await setDoc(doc(db, 'vandalized', bikePat), {
          patrimonio: bikePat,
          data: new Date().toISOString(),
          defeito: reasons,
          local: room || 'Mecânica',
          status: 'pendente',
          responsavel: driverName,
          timestamp: serverTimestamp()
        });

        // Adiciona ao relatório Firebase
        (async () => {
          try {
            const bikeDetails = await fetchBikeDetailsForReport(bikePat, 3000);
            await addDoc(collection(db, 'reports'), {
              patrimonio: bikePat,
              status: 'Vandalizada',
              motorista: driverName,
              observacao: observation,
              timestamp: serverTimestamp(),
              type: 'Mecânica',
              statusSistema: bikeDetails?.['Status'] || bikeDetails?.statusSistema || '',
              bateria: bikeDetails?.['Bateria'] || bikeDetails?.bateria || '',
              trava: bikeDetails?.['Trava'] || bikeDetails?.trava || '',
              localidade: bikeDetails?.['Localidade'] || bikeDetails?.localidade || ''
            });
          } catch (e) {
            console.warn('[Firebase] reports write failed:', e);
          }
        })();
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `bikes/${bikePat}`);
      }

      // 3. Remove do fluxo da mecânica no Firebase
      try {
        await deleteDoc(doc(db, 'mechanics_flow', bikePat));
      } catch (e) {
        console.warn('[Firebase] mechanics_flow delete failed:', e);
      }

      // Envia para o Sheets: tratativa como VANDALIZADA e sala no campo room (Coluna G)
      apiCall({ 
        action: 'markAsVandalizedNoRecovery', 
        bikeNumber: bikePat, 
        mechanicName: driverName, 
        treatment: 'VANDALIZADA', 
        observation: reasons,
        room: room,
        localFinal: room
      }, 1, true).catch(() => {});
      clearCache('getMechanicsList');
      clearCache('sync');

      setSuccessMessage(`Bike ${bikePat} marcada como Vandalizada${room ? ` — ${room}` : ''}.`);
    } catch (err: any) {
      console.error('Erro ao marcar como vandalizada:', err);
    } finally {
      setIsLoading(false);
      setIsVandalizedConfirmOpen(null);
      setVandalizedSelected(new Set());
      setVandalizedRoom('');
    }
  };

  const handleBikeFoundSim = async (bikePat: string) => {
    setBikeFoundModal(null);
    await handleAlterarStatus(bikePat);
  };

  const handleBikeFoundNao = async (bikePat: string) => {
    setBikeFoundModal(null);
    setIsLoading(true);
    try {
      const { deleteDoc: _deleteDoc } = await import('firebase/firestore');
      await _deleteDoc(doc(db, 'mechanics_flow', bikePat));
      refreshAll(true);
    } catch (err: any) {
      console.error('Erro ao excluir bike no Firebase:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMechanicSelectionConfirm = async (mechanicName: string) => {
    setIsLoading(true);
    const bikeNumber = selectedMechanicBike.patrimonio;
    // Atualização otimista
    protectMechanicBike(bikeNumber, {
      status: 'Em Manutenção',
      mecanico: mechanicName,
    });
    setIsMechanicSelectionModalOpen(false);
    try {
      // Atualiza no Firebase mechanics_flow
      await setDoc(doc(db, 'mechanics_flow', bikeNumber), {
        status: 'Em Manutenção',
        mecanico: mechanicName,
        dataEntrada: serverTimestamp()
      }, { merge: true });

      try {
        await setDoc(doc(db, 'bikes', bikeNumber), { status: 'Mecânica', responsavel: mechanicName, ultimaAtualizacao: serverTimestamp() }, { merge: true });
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `bikes/${bikeNumber}`);
      }
      
      (async () => {
        try {
          const bikeDetails = await fetchBikeDetailsForReport(bikeNumber, 3000);
          await addDoc(collection(db, 'reports'), {
            patrimonio: bikeNumber,
            status: 'Em Manutenção',
            motorista: mechanicName,
            observacao: `Iniciada manutenção por ${mechanicName}`,
            timestamp: serverTimestamp(),
            type: 'Mecânica',
            statusSistema: bikeDetails?.['Status'] || bikeDetails?.statusSistema || '',
            bateria: bikeDetails?.['Bateria'] || bikeDetails?.bateria || '',
            trava: bikeDetails?.['Trava'] || bikeDetails?.trava || '',
            localidade: bikeDetails?.['Localidade'] || bikeDetails?.localidade || ''
          });
        } catch (e) {
          console.warn('[Firebase] reports write failed:', e);
        }
      })();
    } catch (err: any) {
      alert('Erro: ' + err.message);
    } finally { setIsLoading(false); }
  };

  const getOrCreateActiveTrailer = async (currentList: any[]): Promise<string> => {
    const activeTrailerGroups: Record<string, any[]> = {};
    currentList.forEach(b => {
      if (b.status === 'Reserva' && b.carretinha && b.carretinha !== 'Sem Carretinha' && !b.trailerStatus) {
        if (!activeTrailerGroups[b.carretinha]) {
          activeTrailerGroups[b.carretinha] = [];
        }
        activeTrailerGroups[b.carretinha].push(b);
      }
    });

    const activeTrailerNames = Object.keys(activeTrailerGroups).sort((a, b) => {
      const numA = parseInt(a.replace(/^\D+/g, ''), 10) || 0;
      const numB = parseInt(b.replace(/^\D+/g, ''), 10) || 0;
      return numA - numB;
    });

    const availableTrailer = activeTrailerNames.find(name => activeTrailerGroups[name].length < 14);

    if (availableTrailer) {
      return availableTrailer;
    }

    let nextNum = 1;
    try {
      const r = await apiCall({ action: 'getNextTrailerNumber' });
      if (r.success) {
        nextNum = r.next;
      }
    } catch (err) {
      console.error('Erro ao buscar próximo número de carretinha:', err);
      const todayStr = localDateStr();
      const lastDate = localStorage.getItem('trailer_seq_date');
      let lastUsed = 0;
      if (lastDate === todayStr) {
        lastUsed = parseInt(localStorage.getItem('trailer_seq_last') || '0');
      } else {
        localStorage.setItem('trailer_seq_date', todayStr);
      }
      nextNum = (lastUsed % 5) + 1;
      localStorage.setItem('trailer_seq_last', nextNum.toString());
    }

    if (nextNum < 1 || nextNum > 5) {
      nextNum = 1;
    }

    return `Carretinha ${nextNum}`;
  };

  const handleFinalizeMechanicsRepair = async (treatment: string) => {
    if (!treatment) { alert('Descreva a tratativa.'); return; }
    setIsLoading(true);
    const bikeNumber = selectedMechanicBike.patrimonio;

    try {
      const targetTrailer = await getOrCreateActiveTrailer(mechanicsList);

      // Mecânico e ADM seguem o mesmo fluxo: move para Reserva.
      // Atualização otimista
      const mechanicName = selectedMechanicBike?.mecanico || driverName;
      protectMechanicBike(bikeNumber, {
        status: 'Reserva',
        mecanico: mechanicName,
        tratativa: treatment,
        dataFinalizacao: new Date().toISOString(),
        carretinha: targetTrailer,
      });
      setIsMechanicRepairModalOpen(false);

      // Atualiza no Firebase mechanics_flow
      await setDoc(doc(db, 'mechanics_flow', bikeNumber), {
        status: 'Reserva',
        tratativa: treatment,
        carretinha: targetTrailer,
        dataSaida: serverTimestamp()
      }, { merge: true });

      try {
        await setDoc(doc(db, 'bikes', bikeNumber), { 
          status: 'Mecânica', 
          responsavel: mechanicName, 
          observacao: treatment, 
          carretinha: targetTrailer,
          ultimaAtualizacao: serverTimestamp() 
        }, { merge: true });
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, `bikes/${bikeNumber}`);
      }

      (async () => {
        try {
          const bikeDetails = await fetchBikeDetailsForReport(bikeNumber, 3000);
          await addDoc(collection(db, 'reports'), {
            patrimonio: bikeNumber,
            status: 'Reserva',
            motorista: mechanicName,
            observacao: `Reparo finalizado por ${mechanicName} — ${treatment} (Alocada automaticamente na ${targetTrailer})`,
            timestamp: serverTimestamp(),
            type: 'Reparo',
            statusSistema: bikeDetails?.['Status'] || bikeDetails?.statusSistema || '',
            bateria: bikeDetails?.['Bateria'] || bikeDetails?.bateria || '',
            trava: bikeDetails?.['Trava'] || bikeDetails?.trava || '',
            localidade: bikeDetails?.['Localidade'] || bikeDetails?.localidade || ''
          });
        } catch (e) {
          console.warn('[Firebase] reports write failed:', e);
        }
      })();

      // Verifique se com essa bike adicionada, a carretinha atingiu 14 bikes
      const currentBikesInThisTrailer = mechanicsList.filter(
        b => b.carretinha === targetTrailer && b.status === 'Reserva' && !b.trailerStatus
      );
      const totalCountWithNewBike = currentBikesInThisTrailer.length + 1;

      setSuccessMessage(`Bike ${bikeNumber} movida para Reserva e alocada automaticamente na ${targetTrailer} (${totalCountWithNewBike}/14).`);

      if (totalCountWithNewBike >= 14) {
        setTimeout(() => {
          handleFinalizeTrailer(targetTrailer);
        }, 800);
      }
    } catch (err: any) {
      alert('Erro: ' + err.message);
    } finally { 
      setIsLoading(false); 
    }
  };

  const handleOrganizeTrailer = async (bikeNumbers: string[], trailerName: string) => {
    if (!trailerName) { alert('Informe o nome da carretinha.'); return; }

    setIsLoading(true);
    try {
      // Enforce 14-bike limit on manual additions/creation
      const existingBikes = mechanicsList.filter(b => b.carretinha === trailerName && b.status === 'Reserva' && !b.trailerStatus);
      if (existingBikes.length + bikeNumbers.length > 14) {
        alert(`A ${trailerName} suporta no máximo 14 bikes. Atualmente possui ${existingBikes.length} bikes. Não é possível adicionar mais ${bikeNumbers.length} bikes.`);
        setIsLoading(false);
        return;
      }

      // Organiza localmente a carretinha
      bikeNumbers.forEach(id => {
        protectMechanicBike(id, { status: 'Reserva', carretinha: trailerName });
      });
      setIsTrailerSelectionModalOpen(false);

      // Atualiza no Firebase mechanics_flow
      await Promise.all(bikeNumbers.map(id => 
        setDoc(doc(db, 'mechanics_flow', id), {
          carretinha: trailerName,
          status: 'Reserva'
        }, { merge: true })
      ));

      await Promise.all(bikeNumbers.map(async (id) => {
        await setDoc(doc(db, 'bikes', id), { 
          carretinha: trailerName, 
          status: 'Reserva', 
          trailerStatus: null, // Reseta status se estiver sendo re-organizada
          ultimaAtualizacao: serverTimestamp() 
        }, { merge: true }).catch(() => {});
      }));

      setSuccessMessage(`Bikes organizadas na ${trailerName}!`);
      
      // Salva no localStorage para evitar duplicidade em cliques rápidos
      const match = trailerName.match(/Carretinha (\d+)/);
      if (match) {
        localStorage.setItem(`trailer_seq_${localDateStr()}`, match[1]);
      }
    } catch (err: any) {
      setError('Erro ao organizar carretinha: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleApproveAction = async (action: any) => {
    setIsLoading(true);
    try {
      if (action.type === 'alterar_status_lote') {
        // Lote de bikes — confirma entrada na mecânica de todas de uma vez
        const bikes: string[] = action.bikes || [];
        await Promise.all(bikes.map(async (bikeId) => {
          try {
            await setDoc(doc(db, 'mechanics_flow', bikeId), {
              status: 'Aguardando Manutenção',
              ultimaAtualizacao: serverTimestamp()
            }, { merge: true });
          } catch (e) {
            console.warn(`[Firebase] update status to Aguardando Manutenção failed for ${bikeId}:`, e);
          }
        }));
      } else if (action.type === 'status_change') {
        if (action.targetStatus === 'Reserva') {
          const targetTrailer = await getOrCreateActiveTrailer(mechanicsList);

          try {
            await setDoc(doc(db, 'bikes', action.bikeNumber), { status: 'Em Estação', responsavel: null, observacao: action.treatment, carretinha: targetTrailer, ultimaAtualizacao: serverTimestamp() }, { merge: true });
          } catch (e) {
            handleFirestoreError(e, OperationType.UPDATE, `bikes/${action.bikeNumber}`);
          }
          
          (async () => {
            try {
              const bikeDetails = await fetchBikeDetailsForReport(action.bikeNumber, 3000);
              await addDoc(collection(db, 'reports'), {
                patrimonio: action.bikeNumber,
                status: 'Reserva',
                motorista: action.mechanicName,
                observacao: `${action.treatment || 'Reparo finalizado'} (Alocada automaticamente na ${targetTrailer})`,
                timestamp: serverTimestamp(),
                type: 'Reparo',
                statusSistema: bikeDetails?.['Status'] || bikeDetails?.statusSistema || '',
                bateria: bikeDetails?.['Bateria'] || bikeDetails?.bateria || '',
                trava: bikeDetails?.['Trava'] || bikeDetails?.trava || '',
                localidade: bikeDetails?.['Localidade'] || bikeDetails?.localidade || ''
              });
            } catch (e) {
              console.warn('[Firebase] reports write failed:', e);
            }
          })();

          try {
            await setDoc(doc(db, 'mechanics_flow', action.bikeNumber), {
              status: 'Reserva',
              mecanico: action.mechanicName,
              tratativa: action.treatment,
              carretinha: targetTrailer,
              ultimaAtualizacao: serverTimestamp()
            }, { merge: true });
          } catch (e) {
            console.warn('[Firebase] finalizeMechanicsRepair flow update failed:', e);
          }

          const currentBikesInThisTrailer = mechanicsList.filter(
            b => b.carretinha === targetTrailer && b.status === 'Reserva' && !b.trailerStatus
          );
          const totalCountWithNewBike = currentBikesInThisTrailer.length + 1;
          if (totalCountWithNewBike >= 14) {
            setTimeout(() => {
              handleFinalizeTrailer(targetTrailer);
            }, 800);
          }
        } else {
          try {
            await setDoc(doc(db, 'mechanics_flow', action.bikeNumber), {
              status: action.targetStatus,
              mecanico: action.mechanicName || '',
              ultimaAtualizacao: serverTimestamp()
            }, { merge: true });
          } catch (e) {
            console.warn('[Firebase] insertBikeMechanics flow update failed:', e);
          }
        }
      } else if (action.type === 'trailer_validation') {
        try {
          await Promise.all(action.bikes.map((id: string) => setDoc(doc(db, 'bikes', id), { 
            carretinha: action.trailerName, 
            trailerStatus: 'approved',
            ultimaAtualizacao: serverTimestamp() 
          }, { merge: true })));
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, `bikes/${action.bikes.join(',')}`);
        }

        const res = await apiCall({ action: 'organizeTrailer', bikeNumbers: action.bikes, trailerName: action.trailerName }, 1, true);
        if (!res.success) throw new Error(res.error || 'Erro ao aprovar carretinha.');

        // v85.45: Auto-finaliza no Sheets também ao aprovar ação da carretinha do mecânico para mudar status para Remanejada
        await apiCall({ action: 'finalizeTrailer', trailerName: action.trailerName }).catch(e => {
          console.warn('Erro ao rodar finalizeTrailer ao aprovar carretinha:', e);
        });

        // v85.30: Para carretinhas, não remove da lista de pendentes até ser enviada para o motorista.
        // Apenas marca como ativada para exibição no card.
        try {
          await updateDoc(doc(db, 'pending_actions', action.id), {
            activatedBy: driverName,
            activatedAt: serverTimestamp()
          });
          setSuccessMessage('Carretinha ativada!');
          refreshAll(true);
          return; // Interrompe aqui para não descer para o update status: 'approved' geral
        } catch (e) {
          handleFirestoreError(e, OperationType.UPDATE, `pending_actions/${action.id}`);
        }
      }

      // v85.31: Suporte a remoção em massa se ids estiver presente
      const idsToMark = action.ids || [action.id];
      await Promise.all(idsToMark.map(id => 
        updateDoc(doc(db, 'pending_actions', id), {
          status: 'approved',
          approvedBy: driverName,
          approvedAt: serverTimestamp()
        })
      ));

      // Reseta ref do lote se era o doc aprovado
      if (action.type === 'alterar_status_lote') {
        idsToMark.forEach(id => {
          if (alterarStatusDocRef.current === id) alterarStatusDocRef.current = null;
        });
      }
      setSuccessMessage('Confirmado! Bikes entram na mecânica.');
      refreshAll(true);
    } catch (err: any) {
      alert('Erro ao aprovar: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAssignTrailerToDriver = async (targetDriverName: string) => {
    if (!selectedActionForAssignment) return;
    setIsLoading(true);
    try {
      const action = selectedActionForAssignment;
      const bikes = action.bikes || [];
      const trailerName = action.trailerName;

      // 1. Atualiza as bikes no Firestore para entrar em posse do motorista
      await Promise.all(bikes.map((id: string) => 
        setDoc(doc(db, 'bikes', id), { 
          status: 'Reserva', // Mantém em reserva até o motorista aceitar
          responsavel: targetDriverName,
          carretinha: trailerName,
          trailerStatus: 'assigned',
          ultimaAtualizacao: serverTimestamp() 
        }, { merge: true })
      ));

      // 2. Cria a notificação para o motorista
      await apiCall({
        action: 'createRequest', 
        patrimonio: bikes.join(', '),
        ocorrencia: `[CARRETINHA] ${trailerName}`,
        local: 'Atribuído via ADM', 
        recipient: targetDriverName
      }, 1, true);

      // 3. Aprova a ação pendente (se não for manual)
      if (!action.id.startsWith('manual_assign_')) {
        await updateDoc(doc(db, 'pending_actions', action.id), {
          status: 'approved',
          approvedBy: driverName, // Nome do ADM logado
          approvedAt: serverTimestamp(),
          assignedTo: targetDriverName
        });
      }

      setSuccessMessage(`Carretinha ${trailerName} enviada para ${targetDriverName}!`);
      setIsDriverSelectionModalOpen(false);
      setSelectedActionForAssignment(null);
      refreshAll(true);
    } catch (err: any) {
      alert('Erro ao atribuir carretinha: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRejectAction = async (actionId: string) => {
    if (!confirm('Deseja rejeitar esta solicitação?')) return;
    setIsLoading(true);
    try {
      await updateDoc(doc(db, 'pending_actions', actionId), {
        status: 'rejected',
        rejectedBy: driverName,
        rejectedAt: serverTimestamp()
      });
      setSuccessMessage('Solicitação rejeitada.');
    } catch (err: any) {
      alert('Erro ao rejeitar: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleForceReload = async () => {
    if (!confirm('Forçar atualização em TODOS os usuários conectados?\nEles serão redirecionados automaticamente em 1-2 segundos.')) return;
    setIsForceReloading(true);
    try {
      await addDoc(collection(db, 'notifications'), {
        type: 'force_reload',
        sentBy: driverName,
        timestamp: serverTimestamp(),
        message: 'Atualização forçada pelo ADM'
      });
      setSuccessMessage('✅ Comando enviado! Todos os usuários serão atualizados.');
    } catch (e: any) {
      setError('Erro ao enviar comando: ' + e.message);
    } finally {
      setIsForceReloading(false);
    }
  };

  const internalStopTrailerScanner = async () => {
    if (trailerScannerStartPromise.current) {
      try { await trailerScannerStartPromise.current; } catch { }
      trailerScannerStartPromise.current = null;
    }

    if (trailerScannerRef.current) {
      const qr = trailerScannerRef.current;
      trailerScannerRef.current = null;
      try { 
        if (qr.isScanning) {
          await qr.stop(); 
          await new Promise(r => setTimeout(r, 200));
        }
        await qr.clear(); 
      } catch (e) {
        console.warn('Error stopping trailer scanner:', e);
      }
    }
    setTrailerQrModal(prev => prev ? { ...prev, scannerActive: false } : null);
  };

  const stopTrailerScanner = async () => {
    try {
      await internalStopTrailerScanner();
    } catch (e) {
      console.warn('Error in stopTrailerScanner:', e);
    }
  };

  const handleScannerSuccess = (text: string) => {
    const match = text.match(/\/download\/(\d+)/);
    const id = match ? match[1] : /^\d+$/.test(text) ? text : null;
    if (id) { 
      if (activeMechanicCategory === 'Reserva') {
        stopScanner();
        setSelectedBikesForTrailer([id]);
        setIsTrailerSelectionModalOpen(true);
      } else {
        setSearchTerm(id); 
        stopScanner(); 
        handleSearch(id); 
      }
    }
  };

  const handleTrailerQrSuccess = (decodedText: string) => {
    // Extrai número do QR: http://www.bikesjc.com.br/home/download/835 → "835"
    const match = decodedText.match(/\/download\/(\d+)/);
    const bikeId = match ? match[1] : (/^\d+$/.test(decodedText.trim()) ? decodedText.trim() : null);
    if (!bikeId) {
      setTrailerQrModal(prev => prev ? { ...prev, lastError: 'QR inválido: ' + decodedText, lastScanned: null } : null);
      return;
    }
    setTrailerQrModal(prev => {
      if (!prev) return null;
      const normalizedId = String(parseFloat(bikeId));
      const found = prev.expectedBikes.find(b => {
        const nb = String(parseFloat(b.patrimonio));
        return nb === normalizedId || b.patrimonio === bikeId;
      });
      if (!found) {
        return { ...prev, lastError: `Bike ${bikeId} não pertence a esta carretinha!`, lastScanned: bikeId, batteryFailed: null };
      }
      if (prev.confirmedBikes.has(found.patrimonio)) {
        return { ...prev, lastError: null, lastScanned: `${bikeId} já confirmada ✓`, batteryFailed: null };
      }
      // Valida bateria ≥ {trailerBatteryLimit}%
      const bateriaVal = found.bateria !== undefined ? Number(found.bateria) : undefined;
      const bateriaPct = bateriaVal !== undefined
        ? (bateriaVal <= 1 && bateriaVal > 0 ? Math.round(bateriaVal * 100) : Math.round(bateriaVal))
        : undefined;
      if (bateriaPct !== undefined && bateriaPct < trailerBatteryLimit) {
        return {
          ...prev,
          lastError: null,
          lastScanned: null,
          batteryFailed: found.patrimonio,
        };
      }
      // Valida comunicação — última info deve ser dentro de 5 minutos
      if (found.ultimaInfo) {
        const lastInfoDate = (() => {
          const s = String(found.ultimaInfo).trim();
          if (s.includes('/')) {
            const parts = s.split(' ');
            const dp = parts[0].split('/');
            if (dp.length === 3) {
              const d = new Date(`${dp[2]}-${dp[1]}-${dp[0]}${parts[1] ? 'T' + parts[1] : ''}`);
              return isNaN(d.getTime()) ? null : d;
            }
          }
          const d = new Date(s);
          return isNaN(d.getTime()) ? null : d;
        })();
        if (lastInfoDate) {
          const diffMin = (Date.now() - lastInfoDate.getTime()) / 60000;
          if (diffMin > 5) {
            return { ...prev, lastError: `Bike ${bikeId} sem comunicação recente (${Math.round(diffMin)} min)!`, lastScanned: bikeId, batteryFailed: null };
          }
        }
      }
      const newConfirmed = new Set(prev.confirmedBikes);
      newConfirmed.add(found.patrimonio);
      return { ...prev, confirmedBikes: newConfirmed, lastScanned: bikeId, lastError: null, batteryFailed: null };
    });
  };

  const startTrailerScanner = async () => {
    if (isScannerBusy.current) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setTrailerQrModal(prev => prev ? { ...prev, lastError: 'Câmera não suportada neste navegador.', scannerActive: false } : null);
      return;
    }

    isScannerBusy.current = true;

    // Para scanner anterior se existir
    if (trailerScannerRef.current) {
      try {
        if (trailerScannerRef.current.isScanning) await trailerScannerRef.current.stop();
        await trailerScannerRef.current.clear();
      } catch {}
      trailerScannerRef.current = null;
    }

    // Mostra área do scanner imediatamente
    setTrailerQrModal(prev => prev ? { ...prev, scannerActive: true, lastError: null } : null);

    // Aguarda DOM renderizar o elemento
    await new Promise(r => setTimeout(r, 600));

    try {
      const el = document.getElementById('qr-trailer-reader');
      if (!el) throw new Error('Elemento qr-trailer-reader não encontrado.');

      // Limpa qualquer estado residual do DOM
      el.innerHTML = '';

      const qr = new Html5Qrcode('qr-trailer-reader');
      trailerScannerRef.current = qr;

      // Tenta sem zoom (mais compatível) — zoom causava tela preta em muitos dispositivos
      await qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => handleTrailerQrSuccess(decodedText),
        () => {}
      );
    } catch (err: any) {
      console.error('Trailer Scanner error:', err);
      // Se falhou, tenta com deviceId direto como fallback
      try {
        const cameras = await Html5Qrcode.getCameras();
        if (cameras.length > 0) {
          const el = document.getElementById('qr-trailer-reader');
          if (el) el.innerHTML = '';
          const qr2 = new Html5Qrcode('qr-trailer-reader');
          trailerScannerRef.current = qr2;
          await qr2.start(
            { deviceId: { exact: cameras[cameras.length - 1].id } },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (decodedText) => handleTrailerQrSuccess(decodedText),
            () => {}
          );
        } else {
          throw err;
        }
      } catch (err2: any) {
        setTrailerQrModal(prev => prev
          ? { ...prev, lastError: 'Não foi possível acessar a câmera: ' + (err2.message || String(err2)), scannerActive: false }
          : null
        );
      }
    } finally {
      isScannerBusy.current = false;
    }
  };

  const handleFinalizeTrailer = async (trailerName: string) => {
    // Abre modal de verificação QR — window.confirm substituído
    const bikesRaw = mechanicsList.filter(b => b.carretinha === trailerName && b.status === 'Reserva');
    if (bikesRaw.length === 0) {
      setError('Nenhuma bike encontrada nesta carretinha.');
      return;
    }

    // Verificar se há bikes com trava aberta ou sem carregar na reserva/carretinha
    const openLockBikes = bikesRaw.filter(b => {
      const lockStr = String(b.trava || '').toLowerCase().trim();
      return lockStr === 'aberta' || lockStr === 'aberto' || lockStr === 'open';
    });

    const notChargingBikes = bikesRaw.filter(b => {
      const chgStr = String(b.carregamento || '').toLowerCase().trim();
      return chgStr === 'não carregando' || chgStr === 'nao carregando' || chgStr === 'não_carregando' || chgStr === 'nao_carregando';
    });

    if (openLockBikes.length > 0 || notChargingBikes.length > 0) {
      let msg = `Não é possível finalizar e fechar a ${trailerName} no momento:\n`;
      if (openLockBikes.length > 0) {
        msg += `\n🔒 Bikes com Trava Aberta: ${openLockBikes.map(b => b.patrimonio).join(', ')}`;
      }
      if (notChargingBikes.length > 0) {
        msg += `\n🔌 Bikes Não Carregando: ${notChargingBikes.map(b => b.patrimonio).join(', ')}`;
      }
      msg += `\n\nPor favor, garanta que todas as travas estejam fechadas e as bikes estejam carregando para prosseguir com a finalização.`;
      alert(msg);
      setError(msg.replace(/\n/g, ' '));
      return;
    }

    const bikeObjects = bikesRaw.map(b => ({
      patrimonio: String(b.patrimonio),
      bateria: b.bateria !== undefined ? Number(b.bateria) : undefined,
      ultimaInfo: b.ultimaInfo || b.ultimaAtualizacao || ''
    }));
    setTrailerQrModal({
      isOpen: true,
      trailerName,
      expectedBikes: bikeObjects,
      confirmedBikes: new Set(),
      batteryFailed: null,
      scannerActive: false,
      lastScanned: null,
      lastError: null,
    });
  };

  const executeTrailerFinalization = async () => {
    if (!trailerQrModal) return;
    const { trailerName, expectedBikes, confirmedBikes } = trailerQrModal;
    if (confirmedBikes.size < expectedBikes.length) return;
    await stopTrailerScanner();
    setTrailerQrModal(null);
    setIsLoading(true);
    const bikeIds = expectedBikes.map(b => b.patrimonio);
    // Protege e mantém status 'Reserva' para continuar exibindo na seção Reserva até aceite do motorista
    bikeIds.forEach(id => {
      protectMechanicBike(id, { trailerStatus: 'finalized' });
    });
    setMechanicsList(prev => prev.map(b =>
      b.carretinha === trailerName ? { ...b, trailerStatus: 'finalized' } : b
    ));
    try {
      // 1. Cria a ação pendente para o ADM validar (SE NÃO FOR ADM)
      // Criamos ANTES de outras operações para garantir que a validação chegue
      if (!isAdm) {
        try {
          await addDoc(collection(db, 'pending_actions'), {
            type: 'trailer_validation',
            trailerName,
            bikes: bikeIds,
            mechanicName: driverName,
            status: 'pending',
            timestamp: serverTimestamp()
          });
        } catch (e) {
          handleFirestoreError(e, OperationType.CREATE, 'pending_actions');
        }
      }

      // 2. Atualiza as bikes no Firestore
      try {
        await Promise.all(bikeIds.map(id => setDoc(doc(db, 'bikes', id), { 
          trailerStatus: 'finalized', 
          ultimaAtualizacao: serverTimestamp() 
        }, { merge: true })));

        // Remove do fluxo da mecânica
        const { deleteDoc: _deleteDoc } = await import('firebase/firestore');
        await Promise.all(bikeIds.map(id => _deleteDoc(doc(db, 'mechanics_flow', id))));
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `bikes/${bikeIds.join(',')}`);
      }

      // 3. Notificações e Logs (não-bloqueantes)
      apiCall({ action: 'finalizeTrailer', trailerName }).catch(e => {
        console.error('[Sheets] finalizeTrailer failed:', e);
        setSyncAlert(`Falha ao registrar carretinha "${trailerName}" no Sheets. Dados salvos no Firebase.`);
      });
      
      const notifyMsg = `🚌 Carretinha "${trailerName}" finalizada por ${driverName}. ${bikeIds.length} bike(s) prontas para remanejamento: ${bikeIds.join(',')}`;

      addDoc(collection(db, 'trailers_history'), {
        trailerName,
        finalizedBy: driverName,
        timestamp: serverTimestamp(),
        date: localDateStr(),
        bikeCount: bikeIds.length
      }).catch(e => console.warn('[Firebase] trailers_history write:', e.code));

      addDoc(collection(db, 'notifications'), {
        type: 'trailer_finalizado',
        message: notifyMsg,
        bikes: bikeIds,
        trailerName,
        mechanic: driverName,
        timestamp: serverTimestamp(),
        recipient: 'ADM'
      }).catch(() => {});

      apiCall({
        action: 'notifyAdmins',
        message: notifyMsg,
        bikes: bikeIds,
        trailerName
      }, 1, true).catch(() => {});

      // Filtra as bikes da carretinha localmente para sumirem da lista imediatamente
      setMechanicsList(prev => prev.filter(b => b.carretinha !== trailerName));

      // Limpa proteção otimista
      bikeIds.forEach(id => {
        delete mechanicOptimisticRef.current[String(id)];
      });
      
      refreshAll(true);
      
      setSuccessMessage(`Carretinha "${trailerName}" finalizada! ADM notificado para remanejamento.`);
    } catch (err: any) {
      setError('Erro: ' + err.message);
      refreshAll(true);
    } finally { setIsLoading(false); }
  };

  const handleUpdateDriverState = async (targetDriver: string, route: string[], collected: string[]) => {
    setIsLoading(true);
    try {
      // Detecta alterções na posse pelo ADM para registro na Linha do Tempo
      if (editingDriver) {
        const currentCollected = (editingDriver.realTime?.collected || []).map(String);
        const newCollected = (collected || []).map(String);
        
        // 1. Detecta bikes removidas
        const removedBikes = currentCollected.filter(b => !newCollected.includes(b));
        removedBikes.forEach(bikeNumber => {
          addDoc(collection(db, 'timeline_events'), {
            driverName: targetDriver,
            bikeNumber,
            type: 'removida_por_adm',
            timestamp: serverTimestamp(),
            date: localDateStr(),
            observacao: `Removido por: ${driverName}`
          }).catch(err => console.warn('[Timeline] Erro ao registrar remoção:', err));
        });

        // 2. Detecta bikes adicionadas (v85.39)
        const addedBikes = newCollected.filter(b => !currentCollected.includes(b));
        addedBikes.forEach(bikeNumber => {
          addDoc(collection(db, 'timeline_events'), {
            driverName: targetDriver,
            bikeNumber,
            type: 'em_posse',
            timestamp: serverTimestamp(),
            date: localDateStr(),
            observacao: `Atribuído por ADM (${driverName})` // v85.50: Deployment Stable Heartbeat
          }).catch(err => console.warn('[Timeline] Erro ao registrar atribuição:', err));
        });
      }

      // Firebase não-bloqueante
      // Só atualiza users — loop de setDoc bikes removido (economiza writes O(n))
      setDoc(doc(db, 'users', normalizeName(targetDriver)), { routeBikes: route, collectedBikes: collected, lastUpdate: serverTimestamp(), sheetsSync: false }, { merge: true }).catch(e => console.warn('[Firebase] users write:', e.code));
      // Sheets — fonte de verdade
      const result = await apiCall({ action: 'updateDriverState', driverName: targetDriver, routeBikes: route, collectedBikes: collected });
      if (result.success) { alert(`Estado de ${targetDriver} atualizado!`); refreshAll(true); setIsEditDriverModalOpen(false); }
      else throw new Error(result.error);
    } catch (err: any) { alert('Erro: ' + err.message); }
    finally { setIsLoading(false); }
  };

  // =================================================================
  // SCANNER QR
  // =================================================================
  const startScanner = async () => {
    if (isScannerBusy.current) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Seu navegador não suporta acesso à câmera.');
      return;
    }
    isScannerBusy.current = true;
    try {
      await internalStopScanner();
      await internalStopTrailerScanner();
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.warn('Error stopping existing scanners:', e);
    }

    setIsScannerOpen(true);
    setTimeout(async () => {
      try {
        const el = document.getElementById('qr-reader');
        if (!el) throw new Error('Elemento do scanner não encontrado no DOM.');
        
        const checkStillOpen = () => {
          let open = false;
          setIsScannerOpen(prev => {
            open = prev;
            return prev;
          });
          return open;
        };

        if (!checkStillOpen()) return;

        const qr = new Html5Qrcode('qr-reader');
        scannerRef.current = qr;

        const startWithRetry = async (withZoom: boolean, retries = 3): Promise<void> => {
          if (!checkStillOpen()) return;
          try {
            const config = withZoom 
              ? { facingMode: 'environment', advanced: [{ zoom: 2.0 }] } as any
              : { facingMode: 'environment' };
            
            const promise = qr.start(
              config,
              { fps: 10, qrbox: { width: 250, height: 250 } },
              (text) => handleScannerSuccess(text),
              () => {}
            );
            scannerStartPromise.current = promise;
            await promise;
            scannerStartPromise.current = null;
          } catch (err: any) {
            scannerStartPromise.current = null;
            if (err?.message?.includes('already under transition') && retries > 0) {
              console.warn('Scanner transition error, retrying...', retries);
              await new Promise(r => setTimeout(r, 500));
              return startWithRetry(withZoom, retries - 1);
            }
            throw err;
          }
        };

        try {
          await startWithRetry(true);
        } catch (err) {
          console.warn('Zoom not supported or start failed, retrying without zoom:', err);
          await startWithRetry(false);
        }
      } catch (err: any) { 
        console.error('Scanner error:', err);
        setError('Não foi possível acessar a câmera: ' + (err.message || String(err))); 
        setIsScannerOpen(false); 
      } finally {
        isScannerBusy.current = false;
      }
    }, 500);
  };

  const internalStopScanner = async () => {
    if (scannerStartPromise.current) {
      try { await scannerStartPromise.current; } catch { }
      scannerStartPromise.current = null;
    }

    if (scannerRef.current) {
      const qr = scannerRef.current;
      scannerRef.current = null;
      try { 
        if (qr.isScanning) {
          await qr.stop(); 
          await new Promise(r => setTimeout(r, 200));
        }
        await qr.clear(); 
      } catch (e) {
        console.warn('Error stopping scanner:', e);
      }
    }
    setIsScannerOpen(false);
  };

  const stopScanner = async () => {
    try {
      await internalStopScanner();
    } catch (e) {
      console.warn('Error in stopScanner:', e);
    }
  };

  useEffect(() => { 
    return () => { 
      internalStopScanner().catch(() => {});
      internalStopTrailerScanner().catch(() => {});
    }; 
  }, []);



  // =================================================================
  // SUMMARY / ALERTAS / SCHEDULE (dados auxiliares)
  // =================================================================
  const fetchSchedule = async () => {
    setIsScheduleLoading(true);
    try {
      const r = await apiCall({ action: 'getSchedule', driverName }, 1, true);
      if (r.success) setUserSchedule(r.data);
    } catch {} finally { setIsScheduleLoading(false); }
  };

  const fetchReporData = async () => {
    setIsReporLoading(true);
    try {
      const r = await apiGetCall('getReporData');
      if (r.success) setReporData(r.data);
      else throw new Error(r.error);
    } catch (err: any) { setError('Erro ao carregar reposição: ' + err.message); }
    finally { setIsReporLoading(false); }
  };

  const fetchRequestsHistory = async () => {
    setIsHistoryLoading(true);
    try {
      const r = await apiCall({ action: 'getRequestsHistory', driverName, category }, 1, true);
      if (r.success) setRequestsHistory(r.data);
    } catch {} finally { setIsHistoryLoading(false); }
  };

  const fetchAlerts = useCallback(async (forceScan = false) => {
    if (!category.includes('ADM')) return;
    setIsAlertsLoading(true);
    try {
      const r = await apiGetCall('getAlerts', forceScan ? { forceScan: 'true' } : {});
      if (r.success) {
        console.log(`Alertas carregados: ${r.data?.length || 0} itens (v${r.version || '?'})`, r.info || '');
        setAlertsVersion(r.version || '');
        const mapped = (r.data || []).map((a: any) => ({
          ...a,
          patrimonio: a.patrimonio || a.id || a.bikeNumber
        }));
        setAlerts(mapped);
        if (r.version) setBackendVersion(r.version);
      } else {
        setError('Erro ao buscar alertas: ' + r.error);
      }
    } catch (err: any) {
      setError('Erro de conexão ao buscar alertas: ' + err.message);
    } finally {
      setIsAlertsLoading(false);
    }
  }, [category]);

  const handleConfirmFound = async (alertId: number) => {
    if (!window.confirm('Confirmar que esta bicicleta foi encontrada?')) return;
    setIsLoading(true);
    // Otimista: remove do estado local imediatamente
    setAlerts(prev => prev.filter(a => (a.id || a.patrimonio) !== alertId));
    try {
      const r = await apiCall({ action: 'confirmBikeFound', alertId, driverName });
      if (r.success) { 
        fetchAlerts(true); 
      }
      else {
        // Reverte se falhar
        fetchAlerts(true);
        throw new Error(r.error); 
      }
    } catch (err: any) { alert('Erro: ' + err.message); }
    finally { setIsLoading(false); }
  };

  const handleConfirmVandalizedFound = async (alertId: number) => {
    if (!window.confirm('Confirmar que esta bicicleta foi encontrada?')) return;
    setIsLoading(true);
    // Otimista: remove do estado local imediatamente
    setVandalizedBikes(prev => prev.filter(b => (b.id || b.patrimonio) !== alertId));
    try {
      const r = await apiCall({ action: 'confirmVandalizedFound', alertId, driverName });
      if (r.success) { 
        refreshAll(true); 
      }
      else {
        refreshAll(true);
        throw new Error(r.error); 
      }
    } catch (err: any) { alert('Erro: ' + err.message); }
    finally { setIsLoading(false); }
  };

  const handleRemoveAlertSubmit = async () => {
    const { alert: alertObj, reason, removerName } = removeAlertModal;
    if (!alertObj) return;
    if (!removerName.trim()) {
      alert('Por favor, informe o nome de quem está removendo.');
      return;
    }
    if (!reason.trim()) {
      alert('Por favor, insira o motivo da remoção.');
      return;
    }

    setIsLoading(true);
    const alertId = alertObj.id;
    const patrimonio = alertObj.patrimonio || alertObj.id;
    setAlerts(prev => prev.filter(a => (a.id || a.patrimonio) !== alertId));
    setRemoveAlertModal(prev => ({ ...prev, isOpen: false }));

    try {
      const r = await apiCall({ 
        action: 'removeBikeFromAlert', 
        alertId, 
        driverName: removerName.trim().toUpperCase(), 
        reason: reason.trim() 
      });

      if (r.success) {
        try {
          await addDoc(collection(db, 'reports'), {
            patrimonio: String(patrimonio),
            status: 'Removida do Alerta',
            motorista: removerName.trim().toUpperCase(),
            observacao: reason.trim(),
            timestamp: serverTimestamp(),
            type: 'Alerta'
          });
        } catch (firebaseErr) {
          console.error('[Firebase] Erro ao gravar remoção em Firebase reports:', firebaseErr);
        }

        setSuccessMessage(`Bike ${patrimonio} removida com sucesso dos alertas.`);
        fetchAlerts(true);
      } else {
        fetchAlerts(true);
        throw new Error(r.error);
      }
    } catch (err: any) {
      alert('Erro ao remover do alerta: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const runDriversSummaryFallback = useCallback(async () => {
    const range = summaryTimeRange;
    try {
      // 1. Obtém a lista de motoristas de forma segura (API ou estado local)
      let drivers: string[] = [];
      if (category.includes('ADM')) {
        try {
          const res = await apiCall({ action: 'getMotoristas' }, 1, true);
          drivers = (res?.data || []).filter((m: string) => m.toUpperCase() !== 'MECANICA');
        } catch (err) {
          console.warn('[Fallback] Falha ao buscar motoristas via API, usando estado local:', err);
          drivers = motoristas.filter((m: string) => m.toUpperCase() !== 'MECANICA');
        }
      } else {
        drivers = [driverName];
      }

      if (drivers.length === 0) {
        console.warn('[Fallback] Nenhum motorista disponível para gerar resumo.');
        return;
      }

      // 2. Busca solicitações pendentes de forma segura
      let allPending: any[] = [];
      try {
        const reqResult = await apiCall({ action: 'getRequests', driverName, category }, 1, true);
        allPending = reqResult.success ? reqResult.data : [];
      } catch (err) {
        console.warn('[Fallback] Falha ao buscar solicitações pendentes:', err);
      }

      // 3. Busca os estados e estatísticas de cada motorista de forma individualizada para evitar que falhas isoladas quebrem tudo
      const summary = await Promise.all(drivers.map(async (d: string) => {
        let stateRes = { success: false, data: { routeBikes: [], collectedBikes: [] } };
        let reportRes = { success: false, data: { recolhidas: [], remanejadas: [], naoEncontrada: [], naoAtendida: [] } };

        try {
          stateRes = await apiCall({ action: 'getDriverState', driverName: d }, 1, true);
        } catch (err) {
          console.warn(`[Fallback] Falha ao carregar estado de ${d}:`, err);
        }

        try {
          reportRes = await apiCall({ action: 'getDailyReportData', driverName: d, timeRange: range }, 1, true);
        } catch (err) {
          console.warn(`[Fallback] Falha ao carregar relatório diário de ${d}:`, err);
        }

        const stats = { recolhidas: 0, remanejada: 0, naoEncontrada: 0, naoAtendida: 0 };
        if (reportRes && reportRes.success && reportRes.data) {
          stats.recolhidas = reportRes.data.recolhidas?.length || 0;
          stats.remanejada = reportRes.data.remanejadas?.length || 0;
          stats.naoEncontrada = reportRes.data.naoEncontrada?.length || 0;
          stats.naoAtendida = reportRes.data.naoAtendida?.length || 0;
        }

        const pendingCount = allPending.filter((r: any) => {
          const rec = (r.recipient || 'Todos').toLowerCase();
          return rec === 'todos' || rec === d.toLowerCase();
        }).length;

        return {
          name: d,
          stats,
          realTime: {
            route: stateRes && stateRes.success ? stateRes.data.routeBikes : [],
            collected: stateRes && stateRes.success ? stateRes.data.collectedBikes : []
          },
          pendingRequests: pendingCount,
          timeline: [],
          timelineWindow: null
        };
      }));

      if (summaryTimeRange === range) {
        setDriversSummary(summary);
      }
    } catch (err) {
      console.error('[Fallback] Erro crítico no resumo dos motoristas:', err);
    }
  }, [summaryTimeRange, category, driverName, motoristas]);

  const fetchDriversSummary = useCallback(async () => {
    const range = summaryTimeRange;
    setIsSummaryLoading(true);
    try {
      const r = await apiCall({ action: 'getDriversSummary', timeRange: range, timelineDate }, 1, true);
      if (r.success && summaryTimeRange === range) {
        const filteredData = (r.data || []).filter((d: any) => d.name?.toUpperCase() !== 'MECANICA');
        setDriversSummary(prev => {
          // Preserva timeline e timelineWindow anteriores se o novo dado não tem eventos
          // (garante que eventos passados não somem entre syncs)
          return filteredData.map((newDriver: any) => {
            const prevDriver = prev.find((p: any) => p.name === newDriver.name);
            const hasNewTimeline = newDriver.timeline && newDriver.timeline.length > 0;
            const hasPrevTimeline = prevDriver?.timeline && prevDriver.timeline.length > 0;
            return {
              ...newDriver,
              timeline: hasNewTimeline ? newDriver.timeline : (hasPrevTimeline ? prevDriver.timeline : []),
              timelineWindow: newDriver.timelineWindow || prevDriver?.timelineWindow || null,
            };
          });
        });
      }
      else if (!r.success) {
        console.warn('[API] getDriversSummary retornou erro, tentando fallback:', r.error);
        await runDriversSummaryFallback();
      }
    } catch (err) {
      console.error('[API] getDriversSummary falhou, tentando fallback:', err);
      await runDriversSummaryFallback();
    }
    finally { setIsSummaryLoading(false); }
  }, [summaryTimeRange, timelineDate, runDriversSummaryFallback]);

  useEffect(() => { fetchDriversSummary(); }, [fetchDriversSummary]);

  const fetchDynamicMechanics = useCallback(async () => {
    try {
      const res = await apiGetCall('getMecanicos');
      if (res.success && Array.isArray(res.data) && res.data.length > 0) {
        const names = res.data
          .map((m: any) => String(m).trim().toUpperCase())
          .filter(Boolean)
          .filter((name: string) => name !== 'CAIO');
        setDynamicMechanics(names);
      }
    } catch (err) {
      console.warn('getMecanicos failed (using default static mechanics list):', err);
    }
  }, []);

  useEffect(() => {
    fetchDynamicMechanics();
  }, [fetchDynamicMechanics]);

  // =================================================================
  // REFRESH ALL
  //
  // ...
  // =================================================================
  const refreshAll = useCallback(async (force = false) => {
    refreshAllRef.current = refreshAll;
    if (!force && (document.visibilityState === 'hidden' || isUpdatingStateRef.current)) return;

    setIsSyncing(true);
    fetchDynamicMechanics().catch(() => {});
    if (isAdm) { setIsSummaryLoading(true); setIsAlertsLoading(true); setIsVandalizedLoading(true); }

    const applyData = (d: any) => {
      if (d.requests) {
        const sheetsRequests = d.requests.filter((r: any) => {
          if (processedRequestIds.current.has(String(r.id).trim())) return false;
          const status = (r.status || r.situacao || '').toString().toLowerCase().trim();
          return !status || status === 'pendente';
        });
        setPendingRequests(prev => {
          const firebaseOnly = prev.filter(r => {
            const id = String(r.id).trim();
            const isFirestoreId = id.length > 10 && isNaN(Number(id));
            if (!isFirestoreId) return false;
            if (processedRequestIds.current.has(id)) return false;
            return !sheetsRequests.find((sr: any) => String(sr.id).trim() === id);
          });
          return [...firebaseOnly, ...sheetsRequests];
        });
      }
      if (d.driverState && !isUpdatingStateRef.current) {
        // Reconciliação Inteligente: Sheets vs Firebase
        // Prioridade total para o Firebase se houver ação recente ou dados mais novos
        const sheetsRoute = d.driverState.routeBikes || [];
        const sheetsCollected = d.driverState.collectedBikes || [];
        
        if (canSheetsOverride()) {
          // Se passou o tempo de carência, aplicamos reconciliação inteligente
          const PROTECTION_WINDOW = 300000; // 5 minutos
          
          // Reconciliação: unimos o que o Sheet tem com o que acabamos de aceitar localmente
          const fromSheets = sheetsRoute.filter(b => {
            const bikeId = String(b).trim();
            if (collectedBikesRef.current.includes(bikeId)) return false;
            const lastHandledAt = recentlyHandledBikesRef.current.get(bikeId);
            if (lastHandledAt && (Date.now() - lastHandledAt < PROTECTION_WINDOW)) return false;
            return true;
          });
          const fromLocalGrace = routeBikesRef.current.filter(b => {
            const bikeId = String(b).trim();
            const lastHandledAt = recentlyHandledBikesRef.current.get(bikeId);
            return lastHandledAt && (Date.now() - lastHandledAt < PROTECTION_WINDOW);
          });
          const reconciledRouteReal = [...new Set([...fromSheets, ...fromLocalGrace])];

          // Mesma lógica para coletadas
          const fromSheetsCollected = sheetsCollected.filter(b => {
            const bikeId = String(b).trim();
            const lastHandledAt = recentlyHandledBikesRef.current.get(bikeId);
            if (lastHandledAt && (Date.now() - lastHandledAt < PROTECTION_WINDOW)) return false;
            return true;
          });
          const fromLocalGraceCollected = collectedBikesRef.current.filter(b => {
            const bikeId = String(b).trim();
            const lastHandledAt = recentlyHandledBikesRef.current.get(bikeId);
            return lastHandledAt && (Date.now() - lastHandledAt < PROTECTION_WINDOW);
          });
          const reconciledCollectedReal = [...new Set([...fromSheetsCollected, ...fromLocalGraceCollected])];

          applyStateFromSheets(reconciledRouteReal, reconciledCollectedReal);
        } else {
          // Se estamos no período de carência, apenas aceitamos NOVAS atribuições do Sheets
          // (bikes que o Sheets enviou mas que não temos no Firebase nem no local)
          const PROTECTION_WINDOW = 300000; // 5 minutos
          const currentAll = new Set([...routeBikesRef.current, ...collectedBikesRef.current]);
          const newAssignments = sheetsRoute.filter(b => {
            const bikeId = String(b).trim();
            // Ignore se já temos ou se processamos agora
            if (currentAll.has(bikeId)) return false;
            if (processingBikesRef.current.has(bikeId)) return false;

            // Proteção extra: ignora se foi FINALIZADA ou REMOVIDA recentemente
            const lastHandledAt = recentlyHandledBikesRef.current.get(bikeId);
            if (lastHandledAt && (Date.now() - lastHandledAt < PROTECTION_WINDOW)) return false;

            return true;
          });
          
          if (newAssignments.length > 0) {
            console.log('[Sync] Novas atribuições detectadas no Sheets:', newAssignments);
            const mergedRoute = [...new Set([...routeBikesRef.current, ...newAssignments])];
            persistDriverState(mergedRoute, collectedBikesRef.current);
          }
        }
      }

      if (d.bikeStatuses) setBikeConflicts(d.bikeStatuses);
      if (d.schedule) setUserSchedule(d.schedule);
      if (d.motoristas) {
        const filteredMotoristas = d.motoristas.filter((m: string) => m.toUpperCase() !== 'MECANICA');
        setMotoristas(filteredMotoristas);
      }
      if (d.mechanicsList) {
        setSheetsMechanicsList(d.mechanicsList);
      }
      /*
      if (d.driverLocations) {
        // ... (removido para economizar quota)
      }
      */
      if (d.driversSummary) {
        const filteredSummary = d.driversSummary.filter((newD: any) => newD.name?.toUpperCase() !== 'MECANICA');
        setDriversSummary(prev => filteredSummary.map((newD: any) => {
          const prevD = prev.find((p: any) => p.name === newD.name);
          const hasNewTL = newD.timeline && newD.timeline.length > 0;
          return {
            ...newD,
            timeline: hasNewTL ? newD.timeline : (prevD?.timeline || []),
            timelineWindow: newD.timelineWindow || prevD?.timelineWindow || null,
          };
        }));
      }

      if (d.bikeDetails) {
        const details = d.bikeDetails;
        const routeD: Record<string, any> = {}, collectedD: Record<string, any> = {};
        (d.driverState?.routeBikes || []).forEach((b: string) => { if (details[b]) routeD[b] = details[b]; });
        (d.driverState?.collectedBikes || []).forEach((b: string) => { if (details[b]) collectedD[b] = details[b]; });
        setRouteBikesDetails(prev => {
          const next = { ...routeD };
          Object.keys(next).forEach(id => {
            if (prev[id]?.initialLat != null) {
              next[id].initialLat = prev[id].initialLat;
              next[id].initialLng = prev[id].initialLng;
            }
          });
          return next;
        });
        setCollectedBikesDetails(collectedD);
      }

      if (isAdm) {
        if (d.alerts) {
          console.log(`Sync Alertas: ${d.alerts.length} itens (v${d.alertsVersion})`);
          setAlertsVersion(d.alertsVersion || '');
          setAlerts((d.alerts || []).map((a: any) => ({
            ...a,
            patrimonio: a.patrimonio || a.id || a.bikeNumber
          })));
        }
        if (d.vandalized) {
          setVandalizedBikes((d.vandalized || []).map((v: any) => ({
            ...v,
            patrimonio: v.patrimonio || v.id || v.bikeNumber
          })));
        }
        if (d.changeStatusData) {
          // changeStatusData is set but not used in UI, keeping it in state if needed for future
          // but removing the unused state for now to satisfy lint
        }
      }
    };

    const today = localDateStr();
    const cacheKey = `cached_main_data_${driverName}_${category}_${today}`;

    try {
      setSyncError(null);
      syncFailCountRef.current = 0; // reset contador de falhas ao iniciar sync com sucesso
      syncCountRef.current++;

      if (isAdm) {
        // ADM: divide em 2 chamadas paralelas para evitar timeout do Apps Script (90s)
        const calls: any[] = [
          apiCall({
            action: 'sync',
            driverName,
            category,
            summaryTimeRange,
            statusTimeRange,
            timelineDate,
            alertsVersion,
            force,
          }, 3, true)
        ];

        // Otimização: Chama Drivers Summary apenas a cada 3 ciclos (~36s) para economizar quota
        if (syncCountRef.current % 3 === 0) {
          calls.push(apiCall({
            action: 'getDriversSummary',
            timeRange: summaryTimeRange,
            timelineDate,
          }, 3, true));
        }

        const [baseResult, summaryResult] = await Promise.allSettled(calls);

        let hasAnySuccess = false;

        if (baseResult.status === 'fulfilled' && baseResult.value?.success) {
          applyData(baseResult.value.data);
          if (baseResult.value.version) setBackendVersion(baseResult.value.version);
          localStorage.setItem(cacheKey, JSON.stringify(baseResult.value.data));
          setLastSyncTime(new Date().toLocaleTimeString());
          hasAnySuccess = true;
        }

        if (summaryResult && summaryResult.status === 'fulfilled' && summaryResult.value?.success) {
          const filteredData = summaryResult.value.data.filter((newD: any) => newD.name?.toUpperCase() !== 'MECANICA');
          setDriversSummary(prev => filteredData.map((newD: any) => {
            const prevD = prev.find((p: any) => p.name === newD.name);
            const hasNewTL = newD.timeline && newD.timeline.length > 0;
            return {
              ...newD,
              timeline: hasNewTL ? newD.timeline : (prevD?.timeline || []),
              timelineWindow: newD.timelineWindow || prevD?.timelineWindow || null,
            };
          }));
          hasAnySuccess = true;
        }

        // Só exibe erro se AMBAS falharam E após 3 tentativas consecutivas
        if (!hasAnySuccess) {
          syncFailCountRef.current += 1;
          if (syncFailCountRef.current >= 3) {
            const errMsg = baseResult.status === 'rejected'
              ? (baseResult.reason?.message || 'Erro de conexão.')
              : (baseResult.value?.error || 'Falha na sincronização.');
            setSyncError(errMsg);
          }
          const cached = localStorage.getItem(cacheKey);
          if (cached) { try { applyData(JSON.parse(cached)); } catch {} }
        } else {
          syncFailCountRef.current = 0;
        }

      } else {
        // MOTORISTA / MECÂNICA / TÉCNICA: sync único e leve
        const result = await apiCall({
          action: 'sync',
          driverName,
          category,
          summaryTimeRange,
          statusTimeRange,
          timelineDate,
          alertsVersion,
        }, 3, true);

        if (result.success && result.data) {
          applyData(result.data);
          localStorage.setItem(cacheKey, JSON.stringify(result.data));
          if (result.version) setBackendVersion(result.version);
          setLastSyncTime(new Date().toLocaleTimeString());
          syncFailCountRef.current = 0;
        } else {
          syncFailCountRef.current += 1;
          if (syncFailCountRef.current >= 3) {
            setSyncError(result.error || 'Falha na sincronização.');
          }
          const cached = localStorage.getItem(cacheKey);
          if (cached) { try { applyData(JSON.parse(cached)); } catch {} }
        }
      }

    } catch (err: any) {
      syncFailCountRef.current += 1;
      if (syncFailCountRef.current >= 3) {
        setSyncError(err.message || 'Erro de conexão.');
      }
      const cached = localStorage.getItem(`cached_main_data_${driverName}_${category}_${localDateStr()}`);
      if (cached) { try { applyData(JSON.parse(cached)); } catch {} }
    } finally {
      setIsSyncing(false);
      if (isAdm) { setIsSummaryLoading(false); setIsAlertsLoading(false); setIsVandalizedLoading(false); }
    }
  }, [driverName, category, summaryTimeRange, statusTimeRange, applyStateFromSheets, isAdm, persistDriverState, timelineDate, alertsVersion, canSheetsOverride, fetchDynamicMechanics]);

  // Busca baterias e travas em tempo real para todas as bikes na mecânica com polling de 15s
  useEffect(() => {
    const fetchLiveDetails = () => {
      const allBikeNumbers = Array.from(new Set([
        ...sheetsMechanicsList.map(b => String(b.patrimonio)),
        ...fbMechanicsFlow.map(b => String(b.patrimonio))
      ])).filter(Boolean);

      if (allBikeNumbers.length > 0) {
        apiCall({ action: 'getBikeDetailsBatch', bikeNumbers: allBikeNumbers }, 1, true).then(res => {
          if (res.success && res.data) {
            setMechanicsLiveDetails(prev => ({ ...prev, ...res.data }));
          }
        }).catch(() => {});
      }
    };

    fetchLiveDetails();
    const interval = setInterval(fetchLiveDetails, 15000);
    return () => clearInterval(interval);
  }, [sheetsMechanicsList, fbMechanicsFlow]);

  useEffect(() => {
    if (isMecanica && activeMechanicCategory === 'Reserva') {
      const fetchTrailersHistory = async () => {
        try {
          const today = localDateStr();
          const { getDocs: _gd, query: _q, where: _w, collection: _col } = await import('firebase/firestore');
          const q = _q(_col(db, 'trailers_history'), _w('date', '==', today));
          const snap = await _gd(q);
          const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          list.sort((a: any, b: any) => {
            const tA = a.timestamp?.toMillis ? a.timestamp.toMillis() : (a.timestamp instanceof Date ? a.timestamp.getTime() : (typeof a.timestamp === 'number' ? a.timestamp : 0));
            const tB = b.timestamp?.toMillis ? b.timestamp.toMillis() : (b.timestamp instanceof Date ? b.timestamp.getTime() : (typeof b.timestamp === 'number' ? b.timestamp : 0));
            return tB - tA;
          });
          setTrailersHistory(list);
        } catch (err) {
          console.error('Erro ao buscar histórico de carretinhas:', err);
        }
      };
      fetchTrailersHistory();
    }
  }, [isMecanica, activeMechanicCategory]);

  // Cache inicial por usuário e categoria e data
  useEffect(() => {
    const today = localDateStr();
    const cacheKey = `cached_main_data_${driverName}_${category}_${today}`;
    const metaKey = `driver_meta_${normalizeName(driverName)}`;

    // 1. Restaura Metadados (Ações Recentes) para manter o período de carência após reload
    try {
      const metaStr = localStorage.getItem(metaKey);
      if (metaStr) {
        const meta = JSON.parse(metaStr);
        if (meta.lastDriverActionAt) {
          lastDriverActionAt.current = meta.lastDriverActionAt;
        }
        if (meta.recentlyHandled) {
          const now = Date.now();
          const fifteenMinAgo = now - 900000;
          Object.entries(meta.recentlyHandled).forEach(([id, ts]) => {
            if ((ts as number) > fifteenMinAgo) {
              recentlyHandledBikesRef.current.set(id, ts as number);
            }
          });
        }
      }
    } catch (e) {
      console.warn('[Session] Erro ao restaurar metadados:', e);
    }
    
    // Limpeza de caches antigos deste usuário
    const prefix = `cached_main_data_${driverName}_${category}_`;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix) && !key.endsWith(today)) {
          localStorage.removeItem(key);
        }
      }
    } catch {}

    const cached = localStorage.getItem(cacheKey);
    if (!cached) return;
    try {
      const d = JSON.parse(cached);
      if (d.requests) {
        const pendingOnly = d.requests.filter((r: any) => {
          if (processedRequestIds.current.has(String(r.id))) return false;
          const status = (r.status || r.situacao || '').toString().toLowerCase().trim();
          return !status || status === 'pendente';
        });
        setPendingRequests(pendingOnly);
      }
      if (d.driverState) { 
        setRouteBikes(d.driverState.routeBikes || []); 
        setCollectedBikes(d.driverState.collectedBikes || []); 
      }
      if (d.bikeDetails) {
        const details = d.bikeDetails;
        const routeD: Record<string, any> = {}, collectedD: Record<string, any> = {};
        (d.driverState?.routeBikes || []).forEach((b: string) => { if (details[b]) routeD[b] = details[b]; });
        (d.driverState?.collectedBikes || []).forEach((b: string) => { if (details[b]) collectedD[b] = details[b]; });
        setRouteBikesDetails(routeD);
        setCollectedBikesDetails(collectedD);
      }
      if (d.bikeStatuses) setBikeConflicts(d.bikeStatuses);
      if (d.schedule) setUserSchedule(d.schedule);
      if (d.motoristas) {
        const filteredMotoristas = d.motoristas.filter((m: string) => m.toUpperCase() !== 'MECANICA');
        setMotoristas(filteredMotoristas);
      }
      if (d.driverLocations) {
        // Sheets serve como base; Firebase atualiza em cima via listener
        setDriverLocations(prev => {
          const fbLocations = prev.filter((l:any) => l.source === 'firebase');
          if (fbLocations.length === 0) {
            // Sem dados Firebase ainda — usa Sheets direto
            return d.driverLocations;
          }
          // Mescla: Firebase tem prioridade, Sheets complementa quem não tem Firebase
          const fbNames = new Set(fbLocations.map((l:any) => l.driverName));
          const sheetsOnly = (d.driverLocations as any[]).filter((l:any) => !fbNames.has(l.driverName));
          return [...fbLocations, ...sheetsOnly.map((l:any) => ({ ...l, stale: true }))];
        });
      }
      if (d.mechanicsList) {
        setSheetsMechanicsList(d.mechanicsList || []);
      }
      if (d.driversSummary) {
        const filteredSummary = d.driversSummary.filter((newD: any) => newD.name?.toUpperCase() !== 'MECANICA');
        setDriversSummary(prev => filteredSummary.map((newD: any) => {
          const prevD = prev.find((p: any) => p.name === newD.name);
          const hasNewTL = newD.timeline && newD.timeline.length > 0;
          return {
            ...newD,
            timeline: hasNewTL ? newD.timeline : (prevD?.timeline || []),
            timelineWindow: newD.timelineWindow || prevD?.timelineWindow || null,
          };
        }));
      }
      if (d.alerts) {
        setAlerts((d.alerts || []).map((a: any) => ({
          ...a,
          patrimonio: a.patrimonio || a.id || a.bikeNumber
        })));
      }
      if (d.vandalized) {
        setVandalizedBikes((d.vandalized || []).map((v: any) => ({
          ...v,
          patrimonio: v.patrimonio || v.id || v.bikeNumber
        })));
      }
      if (d.changeStatusData) {
        // changeStatusData is set but not used in UI
      }
    } catch {}
  }, [category, driverName]);

  // Sync periódico — 4s para reduzir delay percebido
  useEffect(() => {
    refreshAll();
    const fetchSt = async () => {
      try {
        const r = await apiGetCall('getStations');
        if (r.success && r.data) setStations(r.data.map((s: any) => ({ ...s, Latitude: normalizeCoord(s.Latitude), Longitude: normalizeCoord(s.Longitude) })));
      } catch {}
    };
    fetchSt();
    const interval = setInterval(() => {
      refreshAll();
    }, 12000);
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshAll(true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refreshAll]);

  // =================================================================
  // ROTEAMENTO POR CARRO — Google Directions API + Nearest Neighbor
  // Usa Google Maps se VITE_GOOGLE_MAPS_KEY estiver definida,
  // senão usa OSRM (gratuito, sem chave).
  // =================================================================
  const googleMapsDisabledRef = useRef(false);

  const getRoadDistance = useCallback(async (
    rawFromLat: number, rawFromLng: number,
    rawToLat: number, rawToLng: number
  ): Promise<{ distanceM: number, durationS: number, isRoad: boolean }> => {
    const fromLat = normalizeCoord(rawFromLat);
    const fromLng = normalizeCoord(rawFromLng);
    const toLat = normalizeCoord(rawToLat);
    const toLng = normalizeCoord(rawToLng);
    try {
      if (!googleMapsDisabledRef.current) {
        try {
          // Proxy via Apps Script — evita CORS do browser.
          // Usamos silent = true para silenciar erros de console em caso de chave ausente no backend.
          const result = await apiCall({
            action: 'getDirections',
            fromLat, fromLng, toLat, toLng
          }, 1, true);
          if (result.success && result.distanceM) {
            return { distanceM: result.distanceM, durationS: result.durationS, isRoad: true };
          }
        } catch (apiErr: any) {
          const errMsg = apiErr?.message || '';
          if (
            errMsg.includes('Chave') ||
            errMsg.includes('configurada') ||
            errMsg.includes('API key') ||
            errMsg.includes('not configured') ||
            errMsg.includes('Google Maps')
          ) {
            googleMapsDisabledRef.current = true;
            console.warn('[Routing] Chave Google Maps não configurada no backend Google Apps Script. Desativando redirecionamento para prevenir erros de requisição e usando OSRM.');
          } else {
            console.warn('[Routing] Erro inesperado na chamada ao proxy do Google Maps:', apiErr);
          }
        }
      }
      // OSRM gratuito — funciona direto do browser
      const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      if (data.code === 'Ok' && data.routes?.[0]) {
        return { distanceM: data.routes[0].distance, durationS: data.routes[0].duration, isRoad: true };
      }
    } catch (e) {
      console.warn('[Routing] API falhou, usando Haversine:', e);
    }
    // Último fallback: Haversine
    const km = calculateDistance(fromLat, fromLng, toLat, toLng);
    return { distanceM: km * 1000, durationS: km * 180, isRoad: false };
  }, []);

  const buildOptimizedRoute = useCallback(async () => {
    if (!currentDriverLocation || !routeBikes.length) return;

    const bikesWithCoords = routeBikes
      .map(id => ({ id, details: routeBikesDetails[id] }))
      .filter(b => b.details?.currentLat && b.details?.currentLng);

    if (bikesWithCoords.length === 0) return;

    console.log(`[Routing] Otimizando trajeto e calculando distâncias de carro sequenciais para ${bikesWithCoords.length} bikes...`);

    // 1. Otimização Nearest Neighbor para formar uma sequência geograficamente lógica.
    // Começamos na rota a partir da posição do motorista.
    let currentPoint = { lat: currentDriverLocation.lat, lng: currentDriverLocation.lng };
    const unvisited = [...bikesWithCoords];
    const orderedSequence: { bike: any; distanceM: number; durationS: number; isRoad: boolean; legM: number; legS: number }[] = [];

    // Escolhemos o próximo ponto mais próximo via Haversine (heurística rápida) e então
    // calculamos o trajeto real de carro até ele.
    while (unvisited.length > 0) {
      let bestIndex = 0;
      let minHaversine = Infinity;
      for (let i = 0; i < unvisited.length; i++) {
        const bikeLat = unvisited[i].details.currentLat;
        const bikeLng = unvisited[i].details.currentLng;
        const hav = calculateDistance(currentPoint.lat, currentPoint.lng, bikeLat, bikeLng);
        if (hav < minHaversine) {
          minHaversine = hav;
          bestIndex = i;
        }
      }

      const targetBike = unvisited[bestIndex];
      const bikeLat = targetBike.details.currentLat;
      const bikeLng = targetBike.details.currentLng;

      // Chama a distância de estrada de carro entre a posição do motorista e este ponto (todas as bikes consideram apenas a posição do motorista)
      const { distanceM, durationS, isRoad } = await getRoadDistance(
        currentDriverLocation.lat, currentDriverLocation.lng,
        bikeLat, bikeLng
      );

      // Distância de carro para esta perna da sequência (legM/legS)
      let legM = 0;
      let legS = 0;
      if (currentPoint.lat === currentDriverLocation.lat && currentPoint.lng === currentDriverLocation.lng) {
        legM = distanceM;
        legS = durationS;
      } else {
        const legRoad = await getRoadDistance(
          currentPoint.lat, currentPoint.lng,
          bikeLat, bikeLng
        );
        legM = legRoad.distanceM;
        legS = legRoad.durationS;
      }

      orderedSequence.push({
        bike: targetBike,
        distanceM,
        durationS,
        isRoad,
        legM,
        legS
      });

      // Anda para a bicicleta atual
      currentPoint = { lat: bikeLat, lng: bikeLng };
      unvisited.splice(bestIndex, 1);
    }

    // Cria os objetos de distância para o estado routeDistances
    const ordered: string[] = [];
    const newDistances: Record<string, { distance: string, duration: string, value: number, durationS: number, isRoad: boolean, directDistanceM: number, legM: number, legS: number }> = {};
    let cumulativeDistM = 0;

    orderedSequence.forEach(item => {
      ordered.push(item.bike.id);
      cumulativeDistM += item.legM;
      
      const distKm = item.distanceM / 1000;
      const mins = Math.round(item.durationS / 60);

      newDistances[item.bike.id] = {
        distance: distKm < 1 ? `${item.distanceM.toFixed(0)}m` : `${distKm.toFixed(1)}km`,
        duration: `~${mins} min`,
        value: cumulativeDistM, // Valor acumulado para manter a ordenação cronológica lógica
        durationS: item.legS,
        isRoad: item.isRoad,
        directDistanceM: item.distanceM,
        legM: item.legM,
        legS: item.legS
      };
    });

    // Bikes sem coordenadas ficam no final
    const withoutCoords = routeBikes.filter(id => !bikesWithCoords.find(b => b.id === id));
    const newOrder = [...ordered, ...withoutCoords];

    setRouteDistances(prev => ({ ...prev, ...newDistances }));
    
    setRouteBikes(prev => {
      if (prev.join('|') === newOrder.join('|')) return prev;
      return newOrder;
    });
    
    // Atualiza a chave de otimização/reordenamento
    lastOptimizedBikesSetRef.current = [...newOrder].sort().join(',');
    console.log('[Routing] Cálculo de distâncias de trajeto e ordenação sequencial concluídos.');
  }, [currentDriverLocation, routeBikes, routeBikesDetails, getRoadDistance]);

  // Hash de coordenadas para reagir quando as bikes se movem
  const bikesHash = useMemo(() => {
    // Ordenamos para que a ordem da rota não dispare o roteamento (evita loop de reordenação)
    return [...routeBikes].sort().map(id => {
      const d = routeBikesDetails[id];
      return d ? `${d.currentLat},${d.currentLng}` : '';
    }).join('|');
  }, [routeBikes, routeBikesDetails]);

  // Dispara roteamento ao mudar posição ou bikes — com debounce de 3s
  // Só o fazemos se o conjunto de bikes mudou para não ficar reordenando enquanto o motorista dirige
  useEffect(() => {
    if (!currentDriverLocation || !routeBikes.length || !bikesHash) return;
    
    const currentBikesSet = [...routeBikes].sort().join(',');
    if (lastOptimizedBikesSetRef.current === currentBikesSet) {
      // Se o conjunto de bikes é igual, não precisamos disparar buildOptimizedRoute
      return;
    }

    const timer = setTimeout(() => {
      console.log('[Routing] Iniciando otimização por mudança de posição/bikes');
      buildOptimizedRoute();
    }, 3000);
    return () => clearTimeout(timer);
  }, [currentDriverLocation, routeBikes, bikesHash, buildOptimizedRoute]);

  // Reorganiza o roteiro em tempo real com base no GPS do motorista
  // e recalcula as distâncias sequenciais imediatamente.
  useEffect(() => {
    if (!currentDriverLocation || !routeBikes.length) return;

    const currentBikesSet = [...routeBikes].sort().join(',');
    const setHasChanged = lastOptimizedBikesSetRef.current !== currentBikesSet;

    if (setHasChanged) {
      // 1. Separa as bikes com e sem coordenadas
      const bikesWithCoords = routeBikes
        .map(id => ({ id, details: routeBikesDetails[id] }))
        .filter(b => b.details?.currentLat && b.details?.currentLng);

      if (bikesWithCoords.length === 0) return;

      // 2. Calcula a sequência Nearest Neighbor a partir do GPS atual do motorista
      const ordered: string[] = [];
      let currentPoint = { lat: currentDriverLocation.lat, lng: currentDriverLocation.lng };
      const unvisited = [...bikesWithCoords];

      const dists: Record<string, { distance: string, duration: string, value: number, durationS: number, isRoad: boolean }> = {};
      let cumulativeDistM = 0;

      while (unvisited.length > 0) {
        let bestIndex = 0;
        let minDistance = Infinity;
        for (let i = 0; i < unvisited.length; i++) {
          const bikeLat = unvisited[i].details.currentLat!;
          const bikeLng = unvisited[i].details.currentLng!;
          const dist = calculateDistance(currentPoint.lat, currentPoint.lng, bikeLat, bikeLng);
          if (dist < minDistance) {
            minDistance = dist;
            bestIndex = i;
          }
        }

        const nextBikeObj = unvisited[bestIndex];
        const nextBikeId = nextBikeObj.id;
        ordered.push(nextBikeId);

        const bikeLat = nextBikeObj.details.currentLat!;
        const bikeLng = nextBikeObj.details.currentLng!;

        // Calcula a distância direta (Haversine) para esta perna da sequência
        const distKm = calculateDistance(currentPoint.lat, currentPoint.lng, bikeLat, bikeLng);
        const distM = distKm * 1000;
        const durS = distKm * 180; // aprox 20 km/h médio na cidade em segundos
        cumulativeDistM += distM;

        dists[nextBikeId] = {
          distance: distKm < 1 ? `${distM.toFixed(0)}m` : `${distKm.toFixed(1)}km`,
          duration: `~${Math.round(durS / 60)} min`,
          value: cumulativeDistM,
          durationS: durS,
          isRoad: false
        };

        // Avança o ponto de referência para a bike atual
        currentPoint = { lat: bikeLat, lng: bikeLng };
        unvisited.splice(bestIndex, 1);
      }

      const withoutCoords = routeBikes.filter(id => {
        const d = routeBikesDetails[id];
        return !d?.currentLat || !d?.currentLng;
      });

      const newOrder = [...ordered, ...withoutCoords];
      console.log('[Routing] Reorganizando roteiro inicialmente para novo conjunto de bikes:', newOrder);
      
      lastOptimizedBikesSetRef.current = currentBikesSet;
      lastRouteCalculatedGpsRef.current = null; // reseta para que o próximo ciclo calcule rota de carro imediatamente
      setRouteBikes(newOrder);
      setRouteDistances(prev => {
        const next = { ...prev };
        Object.entries(dists).forEach(([id, val]) => {
          next[id] = val;
        });
        return next;
      });
    } else {
      // O conjunto de bikes é idêntico. Mantemos a ordem atual estável para não confundir o motorista.
      // Apenas recalculamos se o motorista se moveu mais de 20 metros desde o último cálculo para não estressar a rede/API
      if (lastRouteCalculatedGpsRef.current) {
        const movedM = getDistanceInMeters(
          currentDriverLocation.lat, currentDriverLocation.lng,
          lastRouteCalculatedGpsRef.current.lat, lastRouteCalculatedGpsRef.current.lng
        );
        if (movedM < 20) {
          return;
        }
      }

      const runRoadUpdates = async () => {
        const dists: Record<string, { distance: string, duration: string, value: number, durationS: number, isRoad: boolean, legM: number, legS: number }> = {};
        let currentPoint = { lat: currentDriverLocation.lat, lng: currentDriverLocation.lng };
        let cumulativeDistM = 0;

        for (let i = 0; i < routeBikes.length; i++) {
          const bikeId = routeBikes[i];
          const details = routeBikesDetails[bikeId];
          if (details?.currentLat && details?.currentLng) {
            const bikeLat = details.currentLat;
            const bikeLng = details.currentLng;

            // 1. Distância de trajeto da posição do motorista até esta bike (direto)
            const { distanceM, durationS, isRoad } = await getRoadDistance(
              currentDriverLocation.lat, currentDriverLocation.lng,
              bikeLat, bikeLng
            );

            // 2. Distância de carro para esta perna da sequência (legM/legS)
            let legM = 0;
            let legS = 0;
            if (currentPoint.lat === currentDriverLocation.lat && currentPoint.lng === currentDriverLocation.lng) {
              legM = distanceM;
              legS = durationS;
            } else {
              // Se já temos gravado no routeDistances e os pontos de origem/destino continuam idênticos, reutilizamos
              const prev = routeDistances[bikeId];
              if (prev && prev.isRoad && prev.legM !== undefined && prev.legS !== undefined) {
                legM = prev.legM;
                legS = prev.legS;
              } else {
                const legRoad = await getRoadDistance(
                  currentPoint.lat, currentPoint.lng,
                  bikeLat, bikeLng
                );
                legM = legRoad.distanceM;
                legS = legRoad.durationS;
              }
            }

            cumulativeDistM += legM;

            const distKm = distanceM / 1000;
            const mins = Math.round(durationS / 60);

            dists[bikeId] = {
              distance: distKm < 1 ? `${distanceM.toFixed(0)}m` : `${distKm.toFixed(1)}km`,
              duration: `~${mins} min`,
              value: cumulativeDistM,
              durationS: legS,
              isRoad,
              legM,
              legS
            };

            // Avança para o próximo ponto
            currentPoint = { lat: bikeLat, lng: bikeLng };
          }
        }

        lastRouteCalculatedGpsRef.current = { lat: currentDriverLocation.lat, lng: currentDriverLocation.lng };

        // Se a ordem for a mesma, atualizamos as distâncias se houver variação relevante para manter o compasso fluido
        setRouteDistances(prev => {
          const next = { ...prev };
          let changed = false;
          Object.entries(dists).forEach(([id, newVal]) => {
            if (
              !prev[id] ||
              prev[id].distance !== newVal.distance ||
              prev[id].duration !== newVal.duration ||
              prev[id].isRoad !== newVal.isRoad ||
              Math.abs((prev[id]?.value || 0) - newVal.value) > 20
            ) {
              next[id] = newVal;
              changed = true;
            }
          });
          return changed ? next : prev;
        });
      };

      runRoadUpdates();
    }
  }, [currentDriverLocation, routeBikes, routeBikesDetails, getRoadDistance, routeDistances]);

  useEffect(() => {
    if (isAdm) {
      console.log('[Init] Admin logado, buscando alertas...');
      fetchAlerts();
    }
  }, [isAdm, fetchAlerts]);

  useEffect(() => {
    if (category.toUpperCase() !== 'MOTORISTA') return;
    if (!navigator.geolocation) { 
      if (!gpsBypassRef.current) setGpsError('Seu navegador não suporta geolocalização.'); 
      return; 
    }

    let lastFirebaseLat = 0, lastFirebaseLng = 0, lastFirebaseTime = 0;
    let lastSheetsLat = 0, lastSheetsLng = 0, lastSheetsTime = 0;
    let lastSuccessTime = Date.now();
    let wakeLock: any = null;
    let watchId: number | null = null;

    const sendLocation = (latitude: number, longitude: number, speed: number | null = null, force = false) => {
      const now = Date.now();
      lastSuccessTime = now;
      
      // 1. FIREBASE: Alta frequência para fluidez no mapa ADM
      const movedFirebase = getDistanceInMeters(latitude, longitude, lastFirebaseLat, lastFirebaseLng);
      const elapsedFirebase = now - lastFirebaseTime;
      
      // Atualiza Firebase se: forçado OU moveu > 25 metros OU passou 30 segundos
      if (force || movedFirebase > 25 || elapsedFirebase > 30000) {
        lastFirebaseLat = latitude;
        lastFirebaseLng = longitude;
        lastFirebaseTime = now;
        
        // Converte m/s para km/h
        const speedKmh = speed !== null ? Math.round(speed * 3.6) : 0;

        setDoc(doc(db, 'locations', driverName), {
          driverName, latitude, longitude,
          timestamp: serverTimestamp(), category,
          status: 'LOGADO',
          speed: speedKmh,
        }, { merge: true }).catch(() => {});
      }

      // 2. SHEETS: Baixa frequência para persistência e economia de quota
      const movedSheets = getDistanceInMeters(latitude, longitude, lastSheetsLat, lastSheetsLng);
      const elapsedSheets = now - lastSheetsTime;
      
      // Atualiza Sheets se: forçado OU moveu > 15 metros OU passou 60 segundos
      if (force || movedSheets > 15 || elapsedSheets > 60000) {
        lastSheetsLat = latitude;
        lastSheetsLng = longitude;
        lastSheetsTime = now;
        
        apiGetCall('updateLocation', {
          driverName,
          latitude: latitude.toFixed(6),
          longitude: longitude.toFixed(6)
        }).catch(() => {});
      }

      setCurrentDriverLocation({ lat: latitude, lng: longitude });
      lastLocationRef.current = { lat: latitude, lng: longitude };
    };

    const getCurrentAndSend = (force = false) => {
      if (gpsBypassRef.current) return;

      // Evita chamadas redundantes se o GPS já estiver reportando atualizações em alta frequência
      const elapsedSinceSuccess = Date.now() - lastSuccessTime;
      if (!force && elapsedSinceSuccess < 45000) {
        return;
      }

      const options = { 
        enableHighAccuracy: true, 
        timeout: 25000, // Tempo de espera maior para evitar falhas frequentes em movimento
        maximumAge: 30000 // Permite posições em cache para resposta sub-segundo confiável
      };

      const onSuccess = ({ coords: { latitude, longitude, speed } }: GeolocationPosition) => {
        setGpsError(null);
        setGpsWarning(null);
        lastSuccessTime = Date.now();
        setCurrentDriverLocation({ lat: latitude, lng: longitude });
        sendLocation(latitude, longitude, speed, force);
      };

      const onError = (err: GeolocationPositionError) => {
        console.warn("GPS Warning:", err.code, err.message);
        
        // Se falhou com alta precisão, tenta novamente com baixa precisão uma vez
        if (options.enableHighAccuracy && err.code !== err.PERMISSION_DENIED) {
          navigator.geolocation.getCurrentPosition(onSuccess, (err2) => {
            console.warn("GPS Fallback Warning:", err2.code, err2.message);
            
            if (!gpsBypassRef.current) {
              const inactiveSecs = Math.round((Date.now() - lastSuccessTime) / 1000);
              const isCriticallyInactive = inactiveSecs > 120; // Histerese de alerta de 2 minutos

              if (err2.code === err2.PERMISSION_DENIED) {
                if (err2.message.toLowerCase().includes('permissions policy')) {
                  setGpsError('O GPS foi bloqueado pela política de segurança do navegador (Iframe). Por favor, abra o aplicativo em uma NOVA ABA para que o GPS funcione corretamente.');
                } else {
                  setGpsError('Acesso ao GPS negado pelo navegador.');
                }
              } else if (err2.code === err2.TIMEOUT) {
                if (!lastLocationRef.current) {
                  console.info("[GPS Fallback] Sem sinal GPS. Usando localização de contingência.");
                  onSuccess({
                    coords: {
                      latitude: -23.5433,
                      longitude: -46.6333,
                      accuracy: 100,
                      altitude: null,
                      altitudeAccuracy: null,
                      heading: null,
                      speed: null
                    },
                    timestamp: Date.now()
                  } as any);
                } else if (lastLocationRef.current && isCriticallyInactive) {
                  setGpsWarning(`A atualização do GPS está instável há ${inactiveSecs}s. Mantendo última posição.`);
                }
              } else if (err2.code === err2.POSITION_UNAVAILABLE) {
                if (!lastLocationRef.current) {
                  console.info("[GPS Fallback] Sinal de GPS indisponível. Usando localização de contingência.");
                  onSuccess({
                    coords: {
                      latitude: -23.5433,
                      longitude: -46.6333,
                      accuracy: 100,
                      altitude: null,
                      altitudeAccuracy: null,
                      heading: null,
                      speed: null
                    },
                    timestamp: Date.now()
                  } as any);
                } else if (lastLocationRef.current && isCriticallyInactive) {
                  setGpsWarning(`Sinal de GPS indisponível há ${inactiveSecs}s. Mantendo última posição conhecida.`);
                }
              }
            }
          }, { ...options, enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
          return;
        }

        if (!gpsBypassRef.current) {
          const inactiveSecs = Math.round((Date.now() - lastSuccessTime) / 1000);
          const isCriticallyInactive = inactiveSecs > 120;

          if (err.code === err.PERMISSION_DENIED) {
            if (err.message.toLowerCase().includes('permissions policy')) {
              setGpsError('O GPS foi bloqueado pela política de segurança do navegador (Iframe). Por favor, abra o aplicativo em uma NOVA ABA para que o GPS funcione corretamente.');
            } else {
              setGpsError('Acesso ao GPS negado pelo navegador. Verifique as permissões no cadeado.');
            }
          } else if (err.code === err.TIMEOUT) {
            if (!lastLocationRef.current) {
              console.info("[GPS Fallback] Sem sinal GPS. Usando localização de contingência.");
              onSuccess({
                coords: {
                  latitude: -23.5433,
                  longitude: -46.6333,
                  accuracy: 100,
                  altitude: null,
                  altitudeAccuracy: null,
                  heading: null,
                  speed: null
                },
                timestamp: Date.now()
              } as any);
            } else if (lastLocationRef.current && isCriticallyInactive) {
              setGpsWarning(`A atualização do GPS está instável há ${inactiveSecs}s. Mantendo última posição conhecida.`);
            }
          } else if (err.code === err.POSITION_UNAVAILABLE) {
            if (!lastLocationRef.current) {
              console.info("[GPS Fallback] Sinal de GPS indisponível. Usando localização de contingência.");
              onSuccess({
                coords: {
                  latitude: -23.5433,
                  longitude: -46.6333,
                  accuracy: 100,
                  altitude: null,
                  altitudeAccuracy: null,
                  heading: null,
                  speed: null
                },
                timestamp: Date.now()
              } as any);
            } else if (lastLocationRef.current && isCriticallyInactive) {
              setGpsWarning(`Sinal de GPS indisponível há ${inactiveSecs}s. Mantendo última posição.`);
            }
          }
        }
      };

      navigator.geolocation.getCurrentPosition(onSuccess, onError, options);
    };

    const startWatch = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (gpsBypassRef.current) return;

      watchId = navigator.geolocation.watchPosition(
        ({ coords: { latitude, longitude, speed } }) => {
          setGpsError(null);
          setGpsWarning(null);
          lastSuccessTime = Date.now();
          setCurrentDriverLocation({ lat: latitude, lng: longitude });
          sendLocation(latitude, longitude, speed);
        },
        err => {
          console.warn("GPS Watch Warning:", err.code);
          
          if (!gpsBypassRef.current) {
            const inactiveSecs = Math.round((Date.now() - lastSuccessTime) / 1000);
            const isCriticallyInactive = inactiveSecs > 120;

            if (err.code === err.PERMISSION_DENIED) {
              if (err.message.toLowerCase().includes('permissions policy')) {
                setGpsError('O GPS foi bloqueado pela política de segurança do navegador (Iframe). Por favor, abra o aplicativo em uma NOVA ABA.');
              } else {
                setGpsError('Acesso ao GPS negado. O aplicativo requer localização ativa.');
              }
            } else if (err.code === err.POSITION_UNAVAILABLE) {
              if (lastLocationRef.current && isCriticallyInactive) {
                setGpsWarning(`Sinal de GPS indisponível há ${inactiveSecs}s. Mantendo posição de forma estável.`);
              } else if (!lastLocationRef.current) {
                setGpsWarning('Sinal de GPS indisponível. Tentando restabelecer conexão...');
              }
            } else if (err.code === err.TIMEOUT) {
              if (lastLocationRef.current && isCriticallyInactive) {
                setGpsWarning(`Sincronização de GPS temporariamente instável há ${inactiveSecs}s.`);
              } else if (!lastLocationRef.current) {
                setGpsWarning('Aguardando sincronização de GPS...');
              }
            }
          }
        },
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 15000 }
      );
    };

    // Wake Lock — mantém tela ativa evitando suspensão do browser
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await (navigator as any).wakeLock.request('screen');
          wakeLock.addEventListener('release', () => {
            // Reaquire se a página ainda está visível
            if (document.visibilityState === 'visible') requestWakeLock();
          });
        }
      } catch {} // silencioso — nem todos os browsers suportam
    };

    // Ao voltar ao foco: reaquire wake lock, reinicia watch e força envio imediato
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
        startWatch();
        getCurrentAndSend(true);
      }
    };

    // Intervalo de segurança a cada 20s — captura posição mesmo se watchPosition parar
    const fallbackInterval = setInterval(() => getCurrentAndSend(), 20000);

    // Inicializa
    requestWakeLock();
    startWatch();
    document.addEventListener('visibilitychange', onVisibility);

    const markOffline = () => {
      // deleteDoc via fetch não funciona no beforeunload — usa setDoc com DESLOGADO
      // O beforeunload não garante async, mas o Firebase SDK tem buffer local
      setDoc(doc(db, 'locations', driverName), {
        status: 'DESLOGADO',
        latitude: null,
        longitude: null,
        timestamp: serverTimestamp(),
      }, { merge: true }).catch(() => {});
    };

    // Detecta fechamento de aba/browser
    window.addEventListener('beforeunload', markOffline);
    window.addEventListener('pagehide', markOffline);

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearInterval(fallbackInterval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', markOffline);
      window.removeEventListener('pagehide', markOffline);
      if (wakeLock) wakeLock.release().catch(() => {});
      // Marca como deslogado no Firebase ao sair (botão logout)
      setDoc(doc(db, 'locations', driverName), {
        status: 'DESLOGADO',
        latitude: null,
        longitude: null,
        timestamp: serverTimestamp(),
      }, { merge: true }).catch(() => {});
    };
  }, [driverName, category]);

  // =================================================================
  // GPS BLOQUEIO
  // =================================================================
  if (gpsError) {
    return (
      <div className="fixed inset-0 bg-white z-[9999] flex flex-col items-center justify-center p-6 text-center">
        <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mb-6">
          <AlertTriangleIcon className="w-10 h-10 text-red-500" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Problema de Localização</h1>
        <p className="text-gray-600 mb-6 max-w-xs font-medium">{gpsError}</p>
        
        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button 
            onClick={() => window.open(window.location.href, '_blank')} 
            className="w-full px-6 py-4 bg-blue-600 text-white rounded-xl font-black text-sm hover:bg-blue-700 active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-blue-200"
          >
            <ExternalLink className="w-5 h-5" />
            ABRIR EM NOVA ABA (SOLUÇÃO)
          </button>
          
          <div className="grid grid-cols-2 gap-2">
            <button 
              onClick={() => window.location.reload()} 
              className="px-4 py-3 bg-white border border-gray-200 text-gray-700 rounded-xl font-bold text-xs hover:bg-gray-50 active:scale-95"
            >
              Recarregar
            </button>
            <button 
              onClick={() => {
                gpsBypassRef.current = true;
                setGpsError(null);
              }} 
              className="px-4 py-3 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs hover:bg-gray-200 active:scale-95"
            >
              Ignorar Erro
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleGenerateRoute = async () => {
    setIsLoading(true);
    try {
      let location = { lat: 0, lng: 0 };
      if (routeConfig.locationSource === 'gps') {
        if (!currentDriverLocation) {
          setError('Localização GPS não disponível. Verifique se o GPS está ativado.');
          setIsLoading(false);
          return;
        }
        location = { lat: currentDriverLocation.lat, lng: currentDriverLocation.lng };
      } else {
        location = ZONES[routeConfig.selectedZone];
      }

      const response = await apiCall({
        action: 'generateDriverRoute',
        driverName,
        location,
        filters: routeConfig.filters,
        maxBikes: 20,
        rangeKm: 2
      });

      if (response.success) {
        setSuccessMessage(response.message || 'Roteiro gerado com sucesso!');
        setIsRouteConfigOpen(false);
        if (refreshAllRef.current) refreshAllRef.current();
        // Dispara otimização imediatamente após gerar roteiro — sem aguardar debounce
        setTimeout(() => buildOptimizedRoute(), 1500);
      } else {
        setError('Erro ao gerar roteiro: ' + response.error);
      }
    } catch {
      setError('Erro de conexão ao gerar roteiro.');
    } finally {
      setIsLoading(false);
    }
  };

  // =================================================================
  // RENDER
  // =================================================================
  return (
    <>
      {/* Status de Sincronização em Segundo Plano (Firebase) */}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col items-end gap-2 pointer-events-none">
        <div className="bg-white/90 backdrop-blur px-3 py-1.5 rounded-full shadow-lg border border-gray-100 flex items-center gap-2 animate-pulse">
          <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"></div>
          <span className="text-[10px] font-bold text-gray-600 tracking-tight uppercase">Firebase Ativo</span>
        </div>
      </div>

      <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg w-full max-w-4xl mx-auto animate-fade-in-down">






      {/* Modal de Confirmação "Zerar Lista" */}
      {isZerarListaConfirmOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                <AlertCircle size={32} className="text-red-600" />
              </div>
              <h2 className="text-xl font-black text-gray-800 uppercase mb-2">Zerar Lista Local?</h2>
              <p className="text-sm text-gray-500 mb-6">
                Isso irá ocultar todas as bikes atuais desta lista e limpar o campo de cópia. Novas bikes registradas aparecerão normalmente.
              </p>
              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  onClick={() => setIsZerarListaConfirmOpen(false)}
                  className="py-3 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleZerarListaStatus}
                  className="py-3 bg-red-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-red-200 hover:bg-red-700 active:scale-95 transition-all"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Verificação QR — Finalizar Carretinha */}
      {trailerQrModal?.isOpen && (() => {
        const { trailerName, expectedBikes, confirmedBikes, scannerActive, lastScanned, lastError, batteryFailed } = trailerQrModal;
        const allConfirmed = confirmedBikes.size >= expectedBikes.length;
        const getBatPct = (b: number | undefined) => b === undefined ? undefined : (b <= 1 && b > 0 ? Math.round(b * 100) : Math.round(b));
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col max-h-[92vh] overflow-hidden">

              {/* Header */}
              <div className="bg-green-700 p-4 text-white flex items-center justify-between flex-shrink-0">
                <div>
                  <p className="text-xs font-bold uppercase opacity-80">Verificação de Segurança</p>
                  <h2 className="text-lg font-black">{trailerName}</h2>
                  <p className="text-[10px] opacity-70 mt-0.5">QR Code + Bateria ≥ {trailerBatteryLimit}% + Comunicação &lt; 5 min</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black">{confirmedBikes.size}<span className="text-sm font-normal opacity-70">/{expectedBikes.length}</span></p>
                  <p className="text-[10px] opacity-70">confirmadas</p>
                </div>
              </div>

              {/* Barra de progresso */}
              <div className="h-1.5 bg-green-100 flex-shrink-0">
                <div className="h-full bg-green-500 transition-all duration-300"
                  style={{ width: `${expectedBikes.length > 0 ? (confirmedBikes.size / expectedBikes.length) * 100 : 0}%` }} />
              </div>

              {/* Scanner */}
              <div className="p-3 flex-shrink-0">
                {scannerActive ? (
                  <div className="relative overflow-hidden rounded-xl bg-black aspect-square w-full border-2 border-green-500 shadow-lg">
                    <div id="qr-trailer-reader" className="w-full h-full" />
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                      <div className="w-44 h-44 border-2 border-green-400/60 rounded-xl" />
                    </div>
                    <button onClick={stopTrailerScanner} className="absolute top-2 right-2 bg-black/60 text-white p-1.5 rounded-full">
                      <XIcon className="w-4 h-4" />
                    </button>
                    <p className="absolute bottom-2 left-0 right-0 text-center text-[10px] text-white bg-black/50 py-1">
                      Aponte para o QR Code da bike
                    </p>
                  </div>
                ) : (
                  <button onClick={startTrailerScanner} disabled={allConfirmed}
                    className="w-full py-3 bg-green-600 text-white font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-green-700 active:scale-95 transition-all disabled:bg-gray-300">
                    <QrCodeIcon className="w-5 h-5" />
                    {allConfirmed ? '✅ Todas confirmadas!' : 'Escanear QR Code'}
                  </button>
                )}

                {/* Feedbacks */}
                {lastScanned && !lastError && !batteryFailed && (
                  <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-lg text-center">
                    <p className="text-xs font-bold text-green-700">✅ Bike {lastScanned} confirmada</p>
                  </div>
                )}
                {batteryFailed && (() => {
                  const bike = expectedBikes.find(b => b.patrimonio === batteryFailed);
                  const pct = bike ? getBatPct(bike.bateria) : undefined;
                  return (
                    <div className="mt-2 p-3 bg-orange-50 border-2 border-orange-400 rounded-lg">
                      <p className="text-xs font-black text-orange-700 text-center">🔋 Bateria insuficiente!</p>
                      <p className="text-[10px] text-orange-600 text-center mt-0.5">
                        Bike <span className="font-black">{batteryFailed}</span>: {pct !== undefined ? `${pct}%` : 'sem dados'} — mínimo exigido: {trailerBatteryLimit}%
                      </p>
                      <p className="text-[9px] text-orange-500 text-center mt-1 italic">Recarregue a bike e tente novamente, ou remova-a da carretinha.</p>
                    </div>
                  );
                })()}
                {lastError && (
                  <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg flex justify-between items-center">
                    <p className="text-xs font-bold text-red-700 flex-1 text-center">⚠️ {lastError}</p>
                    <button 
                      onClick={() => setTrailerQrModal(prev => prev ? { ...prev, lastError: null } : null)}
                      className="text-red-400 hover:text-red-600 flex-shrink-0"
                    >
                      <XIcon className="w-4 h-4"/>
                    </button>
                  </div>
                )}
              </div>

              {/* Lista de bikes */}
              <div className="flex-1 overflow-y-auto px-3 pb-2">
                <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2">
                  Bikes da carretinha ({expectedBikes.length})
                </p>
                <div className="space-y-1.5">
                  {expectedBikes.map(bike => {
                    const ok = confirmedBikes.has(bike.patrimonio);
                    const isBatFail = batteryFailed === bike.patrimonio;
                    const pct = getBatPct(bike.bateria);
                    return (
                      <div key={bike.patrimonio}
                        className={`flex items-center justify-between p-2 rounded-lg border transition-all ${
                          ok ? 'bg-green-50 border-green-300' :
                          isBatFail ? 'bg-orange-50 border-orange-400 ring-1 ring-orange-400' :
                          'bg-gray-50 border-gray-200'}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-base">{ok ? '✅' : isBatFail ? '🔋' : '⏳'}</span>
                          <div>
                            <p className={`text-xs font-black font-mono ${ok ? 'text-green-700' : isBatFail ? 'text-orange-700' : 'text-gray-600'}`}>
                              {bike.patrimonio}
                            </p>
                            {pct !== undefined && (
                              <p className={`text-[9px] font-bold ${pct >= trailerBatteryLimit ? 'text-green-600' : 'text-orange-600'}`}>
                                🔋 {pct}% {pct < trailerBatteryLimit ? '(insuf.)' : ''}
                              </p>
                            )}
                          </div>
                        </div>
                        {/* Botão remover — só aparece se bike ainda não confirmada */}
                        {!ok && (
                          <button
                            onClick={() => setRemoveFromTrailerConfirm({ patrimonio: bike.patrimonio, trailerName })}
                            className="p-1.5 bg-red-50 border border-red-200 text-red-500 rounded-lg hover:bg-red-100 active:scale-95 transition-all flex-shrink-0"
                            title="Remover da carretinha"
                          >
                            <XIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Botões */}
              <div className="p-3 border-t flex gap-2 flex-shrink-0">
                <button onClick={async () => { await stopTrailerScanner(); setTrailerQrModal(null); }}
                  className="flex-1 py-2.5 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase hover:bg-gray-200">
                  Cancelar
                </button>
                <button onClick={executeTrailerFinalization}
                  disabled={!allConfirmed || isLoading}
                  className="flex-1 py-2.5 bg-green-600 text-white rounded-xl font-bold text-xs uppercase shadow-lg hover:bg-green-700 active:scale-95 disabled:bg-gray-300 disabled:shadow-none transition-all">
                  {isLoading ? '...' : `Confirmar (${confirmedBikes.size}/${expectedBikes.length})`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal — Seleção de Técnico (Confirmar Recebimento) */}
      {technicaReceiptModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex flex-col items-center text-center">
              <div className="w-14 h-14 bg-blue-100 rounded-full flex items-center justify-center mb-3">
                <UserIcon className="w-7 h-7 text-blue-600" />
              </div>
              <h2 className="text-lg font-black text-gray-800 uppercase mb-1">Selecionar Técnico</h2>
              <p className="text-sm text-gray-500 mb-5">
                Bike <span className="font-bold text-gray-800">{technicaReceiptModal.bikeNumber}</span> — quem irá realizar a análise?
              </p>
              <div className="flex flex-col gap-3 w-full">
                {TECNICA_TECHNICIANS.map(tech => (
                  <button
                    key={tech}
                    onClick={() => executeConfirmTechnicaReceipt(technicaReceiptModal.bikeNumber, tech)}
                    className="py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 active:scale-95 transition-all shadow-sm"
                  >
                    {tech}
                  </button>
                ))}
                <button
                  onClick={() => setTechnicaReceiptModal(null)}
                  className="py-2.5 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase hover:bg-gray-200 transition-all"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal — Opções de Reparo (Finalizar Reparo Técnica) */}
      {technicaRepairModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col max-h-[90vh] overflow-hidden">
            {/* Header */}
            <div className="bg-orange-600 p-4 text-white flex-shrink-0">
              <p className="text-xs font-bold uppercase opacity-80">Finalizar Reparo</p>
              <h2 className="text-lg font-black">Bike {technicaRepairModal.bike.patrimonio}</h2>
              {technicaRepairModal.bike.mecanico && technicaRepairModal.bike.mecanico !== driverName ? (
                <p className="text-[11px] opacity-80 mt-0.5">
                  Retornará para: <span className="font-bold">{technicaRepairModal.bike.mecanico}</span>
                </p>
              ) : (
                <p className="text-[11px] opacity-80 mt-0.5 italic">
                  Retornará para: Aguardando Manutenção
                </p>
              )}
            </div>
            {/* Lista de opções */}
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">
                Selecione o(s) serviço(s) realizado(s)
              </p>
              <div className="space-y-2">
                {TECNICA_REPAIR_OPTIONS.map(opt => {
                  const selected = technicaRepairSelected.has(opt);
                  return (
                    <button
                      key={opt}
                      onClick={() => setTechnicaRepairSelected(prev => {
                        const next = new Set(prev);
                        if (next.has(opt)) next.delete(opt); else next.add(opt);
                        return next;
                      })}
                      className={`w-full text-left px-4 py-3 rounded-xl border-2 font-bold text-sm transition-all active:scale-95 flex items-center gap-3 ${
                        selected
                          ? 'bg-orange-50 border-orange-400 text-orange-700'
                          : 'bg-white border-gray-200 text-gray-600 hover:border-orange-200'
                      }`}
                    >
                      <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 text-[10px] font-black ${
                        selected ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300'
                      }`}>
                        {selected ? '✓' : ''}
                      </span>
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Rodapé */}
            <div className="p-4 border-t flex-shrink-0 space-y-2">
              {technicaRepairSelected.size > 0 && (
                <p className="text-[10px] text-orange-600 font-bold text-center">
                  {technicaRepairSelected.size} serviço(s) selecionado(s)
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => { setTechnicaRepairModal(null); setTechnicaRepairSelected(new Set()); }}
                  className="flex-1 py-2.5 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase hover:bg-gray-200"
                >
                  Cancelar
                </button>
                <button
                  onClick={executeFinalizeTechnicaRepair}
                  disabled={technicaRepairSelected.size === 0 || isLoading}
                  className="flex-1 py-2.5 bg-orange-600 text-white rounded-xl font-bold text-xs uppercase shadow-lg hover:bg-orange-700 active:scale-95 disabled:bg-gray-300 disabled:shadow-none transition-all"
                >
                  Confirmar Finalização
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal - Locker Vandalizado (Técnica) */}
      {lockerVandalizedModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 animate-fade-in animate-duration-150">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col max-h-[90vh] overflow-hidden animate-scale-in">
            {/* Header */}
            <div className="bg-rose-600 p-4 text-white flex-shrink-0 relative">
              <p className="text-xs font-bold uppercase opacity-80">Locker Vandalizado</p>
              <h2 className="text-xl font-black">{lockerVandalizedModal.bike.patrimonio ? `Bike ${lockerVandalizedModal.bike.patrimonio}` : 'Locker Vandalizado'}</h2>
              <button
                onClick={() => setLockerVandalizedModal(null)}
                className="absolute top-4 right-4 text-white/80 hover:text-white"
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            {/* Form Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Opções de Problema */}
              <div>
                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">
                  Selecione o Problema do Locker
                </label>
                <div className="space-y-1.5">
                  {['Não liga', 'Em curto', 'Chip sem comunicação', 'Software corrompido'].map(opt => {
                    const isSelected = lockerVandalizedIssue === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setLockerVandalizedIssue(opt)}
                        className={`w-full text-left px-3.5 py-2.5 rounded-xl border-2 font-bold text-xs transition-all active:scale-95 flex items-center gap-3 ${
                          isSelected
                            ? 'bg-rose-50 border-rose-400 text-rose-700'
                            : 'bg-white border-gray-200 text-gray-600 hover:border-rose-200'
                        }`}
                      >
                        <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 text-[10px] font-black flex items-center justify-center ${
                          isSelected ? 'bg-rose-500 border-rose-500 text-white' : 'border-gray-300'
                        }`}>
                          {isSelected ? '✓' : ''}
                        </span>
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Condição da Bike */}
              <div>
                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">
                  Condição da Bike
                </label>
                <div className="flex gap-3 bg-gray-50 rounded-xl p-2 border border-gray-100">
                  <button
                    type="button"
                    onClick={() => setLockerVandalizedBikeCondition('BOA')}
                    className={`flex-1 py-1.5 rounded-lg font-bold text-xs uppercase flex items-center justify-center gap-1.5 border-2 transition-all ${
                      lockerVandalizedBikeCondition === 'BOA'
                        ? 'bg-green-100 text-green-700 border-green-400 shadow-sm'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-green-200'
                    }`}
                  >
                    😊 Boa
                  </button>
                  <button
                    type="button"
                    onClick={() => setLockerVandalizedBikeCondition('RUIM')}
                    className={`flex-1 py-1.5 rounded-lg font-bold text-xs uppercase flex items-center justify-center gap-1.5 border-2 transition-all ${
                      lockerVandalizedBikeCondition === 'RUIM'
                        ? 'bg-red-100 text-red-700 border-red-400 shadow-sm'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-red-200'
                    }`}
                  >
                    😔 Ruim
                  </button>
                </div>
              </div>

              {/* Local da Bike */}
              <div>
                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">
                  Local da Bike
                </label>
                <div className="flex gap-2">
                  {['Sala 2', 'Sala 3', 'Sala 4'].map(room => {
                    const isSelected = lockerVandalizedBikeRoom === room;
                    return (
                      <button
                        key={room}
                        type="button"
                        onClick={() => setLockerVandalizedBikeRoom(room)}
                        className={`flex-1 py-1.5 rounded-lg font-black text-xs uppercase border-2 transition-all text-center ${
                          isSelected
                            ? 'bg-blue-100 border-blue-400 text-blue-700 shadow-sm'
                            : 'bg-white border-gray-200 text-gray-500 hover:border-blue-200'
                        }`}
                      >
                        {room}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Local do Locker */}
              <div>
                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">
                  Local do Locker
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {['Caixa 1', 'Caixa 2', 'Caixa 3', 'Caixa 4', 'Caixa 5', 'Caixa 6', 'Caixa 7', 'Caixa 8', 'Caixa 9'].map(box => {
                    const isSelected = lockerVandalizedLockerBox === box;
                    return (
                      <button
                        key={box}
                        type="button"
                        onClick={() => setLockerVandalizedLockerBox(box)}
                        className={`py-1.5 rounded-lg font-bold text-xs border-1.5 transition-all text-center ${
                          isSelected
                            ? 'bg-purple-100 border-purple-400 text-purple-700 shadow-sm'
                            : 'bg-white border-gray-200 text-gray-500 hover:border-purple-250'
                        }`}
                      >
                        {box}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t flex-shrink-0 flex gap-2">
              <button
                type="button"
                onClick={() => setLockerVandalizedModal(null)}
                className="flex-1 py-2.5 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase hover:bg-gray-200"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleLockerVandalizedSubmit}
                disabled={
                  !lockerVandalizedIssue ||
                  !lockerVandalizedBikeCondition ||
                  !lockerVandalizedBikeRoom ||
                  !lockerVandalizedLockerBox ||
                  isLoading
                }
                className="flex-1 py-2.5 bg-rose-600 text-white rounded-xl font-bold text-xs uppercase shadow-lg hover:bg-rose-700 active:scale-95 disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none transition-all"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Confirmação — Remover bike da carretinha */}
      {removeFromTrailerConfirm && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                <XIcon className="w-8 h-8 text-red-600" />
              </div>
              <h2 className="text-xl font-black text-gray-800 uppercase mb-2">Remover da Carretinha?</h2>
              <p className="text-sm text-gray-500 mb-2">
                A bike <span className="font-bold text-gray-800">{removeFromTrailerConfirm.patrimonio}</span> será removida da carretinha e permanecerá na <span className="font-bold text-green-600">Reserva</span>.
              </p>
              <div className="grid grid-cols-2 gap-3 w-full mt-4">
                <button
                  onClick={() => setRemoveFromTrailerConfirm(null)}
                  className="py-3 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all"
                >
                  Cancelar
                </button>
                <button
                  onClick={async () => {
                    const { patrimonio } = removeFromTrailerConfirm;
                    setRemoveFromTrailerConfirm(null);
                    // Remove do modal QR
                    setTrailerQrModal(prev => prev ? {
                      ...prev,
                      expectedBikes: prev.expectedBikes.filter(b => b.patrimonio !== patrimonio),
                      batteryFailed: prev.batteryFailed === patrimonio ? null : prev.batteryFailed,
                      lastError: null,
                    } : null);
                    // Atualiza lista local — mantém na Reserva mas sem carretinha
                    protectMechanicBike(patrimonio, { status: 'Reserva', carretinha: null });
                    
                    try {
                      await setDoc(doc(db, 'mechanics_flow', patrimonio), {
                        carretinha: null,
                        status: 'Reserva'
                      }, { merge: true });
                    } catch (e) {
                      console.warn('[Firebase] removeFromTrailer failed:', e);
                    }
                  }}
                  className="py-3 bg-red-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-red-200 hover:bg-red-700 active:scale-95 transition-all"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Limpar Lista Alterar Status */}
      {isLimparListaConfirmOpen && (() => {
        const bikesToClear = mechanicsList.filter(b => b.status === 'Alterar Status' || b.status === 'Não encontrada');
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mb-4">
                  <XIcon className="w-8 h-8 text-purple-600" />
                </div>
                <h2 className="text-xl font-black text-gray-800 uppercase mb-2">Limpar Lista?</h2>
                <p className="text-sm text-gray-500 mb-6">
                  Remove <span className="font-bold text-gray-800">{bikesToClear.length} bike(s)</span> da lista Alterar Status sem gerar registros. Novas bikes registradas aparecerão normalmente.
                </p>
                <div className="grid grid-cols-2 gap-3 w-full">
                  <button
                    onClick={() => setIsLimparListaConfirmOpen(false)}
                    className="py-3 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={async () => {
                      setIsLimparListaConfirmOpen(false);
                      setIsLoading(true);
                      setError(null);
                      try {
                        const r = await apiCall({
                          action: 'clearAlterarStatus',
                          bikes: bikesToClear.map(b => ({ patrimonio: b.patrimonio, row: b.row }))
                        }, 1, false);
                        if (r.success) {
                          try {
                            const { deleteDoc: _deleteDoc, doc: _doc } = await import('firebase/firestore');
                            await Promise.all(
                              bikesToClear.map(b => 
                                _deleteDoc(_doc(db, 'mechanics_flow', b.patrimonio)).catch(err => 
                                  console.warn(`[Firebase] Delete mechanics_flow failed for ${b.patrimonio}:`, err)
                                )
                              )
                            );
                          } catch (fErr) {
                            console.warn('[Firebase] Import/Promise delete failed during list clear:', fErr);
                          }
                          setMechanicsList(prev => prev.filter(b => b.status !== 'Alterar Status' && b.status !== 'Não encontrada'));
                          setSuccessMessage(`${r.cleared} bike(s) removidas da lista.`);
                        } else {
                          setError(r.error || 'Erro ao limpar lista.');
                        }
                      } catch (e: any) {
                        setError('Erro ao limpar lista: ' + e.message);
                      } finally {
                        setIsLoading(false);
                      }
                    }}
                    className="py-3 bg-purple-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-purple-200 hover:bg-purple-700 active:scale-95 transition-all"
                  >
                    Confirmar
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* HEADER */}
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 pb-4 border-b">
        <div>
          <p className="font-bold text-base text-gray-800">{driverName}</p>
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-600 uppercase tracking-wider">{category}</p>
            <span className={`text-[10px] flex items-center gap-1 cursor-help ${syncError ? 'text-red-500 font-bold' : 'text-gray-400'}`}
              title={syncError || 'Sincronizado'} onClick={() => syncError && alert(syncError)}>
              <span className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-blue-500 animate-pulse' : syncError ? 'bg-red-500' : 'bg-green-500'}`}></span>
              {syncError ? (syncError.includes('sobrecarregado') || syncError.includes('busy') ? 'Servidor Ocupado' : 'Erro Planilha') : lastSyncTime}
            </span>
          </div>
        </div>
        <div className="flex items-center flex-wrap gap-1 mt-4 sm:mt-0">

          {!isMecanica && !isTecnica && <>
            <button onClick={() => { setPrefilledBikeNumber(undefined); setRequestModalOpen(true); }} disabled={isLoading} title="Nova Solicitação" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><PlusIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
            <button onClick={() => setRouteModalOpen(true)} disabled={isLoading} title="Criar Roteiro" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><PlusPlusIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
            {isAdm && <button onClick={onShowMap} disabled={isLoading} title="Mapa" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><MapIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>}
            {isAdm && (
              <button 
                onClick={() => setShowAnalyticalDashboard(true)} 
                title="Dashboard Analítico" 
                className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
              >
                <TrendingUp className="w-6 h-6 sm:w-7 sm:h-7" />
              </button>
            )}
            {isAdm && (
              <button 
                onClick={() => setIsFirebaseReportOpen(true)} 
                title="Relatório Firebase" 
                className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-green-50 hover:text-green-600 transition-colors"
              >
                <SheetIcon className="w-6 h-6 sm:w-7 sm:h-7" />
              </button>
            )}
            {isAdm && (
              <button onClick={handleForceReload} disabled={isForceReloading} title="Forçar atualização em todos os usuários"
                className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-50 relative">
                <svg viewBox="0 0 24 24" className={`w-6 h-6 sm:w-7 sm:h-7 ${isForceReloading ? 'animate-spin text-orange-500' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"/>
                  <polyline points="1 20 1 14 7 14"/>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
              </button>
            )}
            {normalizedCategory.includes('MOTORISTA') && <>
              <button onClick={() => setIsVehicleModalOpen(true)} disabled={isLoading} title="Trocar Veículo" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><SwitchIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
              <button onClick={() => { fetchSchedule(); setIsScheduleModalOpen(true); }} disabled={isLoading} title="Escala" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><CalendarIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
            </>}
            {!isAdm && <>
              <button onClick={() => window.open('https://docs.google.com/forms/d/e/1FAIpQLSdYtWC_KKixt9gWwZG_Q6hyaD2QCvv-_ilOfhtUVJiF5EevSQ/viewform', '_blank')} disabled={isLoading} title="Formulário Veículo" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><CarIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
              <button onClick={() => setReportModalOpen(true)} disabled={isLoading} title="Relatório" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><SheetIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
            </>}
            <button onClick={() => { fetchReporData(); setIsReporModalOpen(true); }} disabled={isLoading} title="Estações Livres" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><BicycleIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
          </>}
          {(isMecanica || isAdm) && (
            <button
              onClick={() => setIsAlmoxarifadoOpen(true)}
              disabled={isLoading}
              title="Almoxarifado"
              className="p-1.5 sm:p-2 rounded-full text-blue-700 bg-blue-50 border border-blue-100 hover:bg-blue-100 active:scale-95 transition-all shadow-sm"
            >
              <Package className="w-6 h-6 sm:w-7 sm:h-7 text-blue-600" />
            </button>
          )}
          <button onClick={onLogout} disabled={isLoading} title="Sair" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-red-600 disabled:opacity-50"><LogoutIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
        </div>
      </header>
      
      {syncAlert && (
        <div className="mx-4 mt-2 p-3 bg-red-100 border-2 border-red-200 rounded-xl flex items-center gap-3 animate-pulse">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-black text-red-800 leading-tight">ERRO DE SINCRONIZAÇÃO</p>
            <p className="text-[10px] text-red-600 font-bold">{syncAlert}</p>
          </div>
          <button onClick={() => setSyncAlert(null)} className="p-1 hover:bg-red-200 rounded-full">
            <XIcon className="w-4 h-4 text-red-600" />
          </button>
        </div>
      )}

      <main>
        {/* RESUMO MOTORISTA */}
        {!isAdm && !isMecanica && !isTecnica && driversSummary.length > 0 && (
          <div className="mb-4 p-3 border rounded-lg bg-gray-50 shadow-sm">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-sm font-bold text-gray-700 uppercase flex items-center gap-2"><SheetIcon className="w-4 h-4 text-blue-600"/>Resumo</h2>
              <div className="flex bg-white border rounded-md p-0.5 shadow-sm">
                {(['-1','-7','day','week','month'] as const).map((r, i) => (
                  <button key={`period-driver-${r}-${i}`} onClick={() => setSummaryTimeRange(r)}
                    className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded ${summaryTimeRange === r ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
                    {r === '-1' ? '-1' : r === '-7' ? '-7' : r === 'day' ? 'Dia' : r === 'week' ? 'Semana' : 'Mês'}
                  </button>
                ))}
              </div>
            </div>
            {driversSummary.filter(d => d.name.toLowerCase() === driverName.toLowerCase()).map((driver, i) => {
              const recolhidas = driver.stats?.recolhidas || 0;
              const remanejada = driver.stats?.remanejada || 0;
              const naoEncontrada = driver.stats?.naoEncontrada || 0;
              const total = recolhidas + remanejada;

              return (
                <div key={`driver-resume-${driver.name}-${i}`} className="space-y-4">
                  {/* Grid de Estatísticas */}
                  <div className="grid grid-cols-5 gap-2">
                    {[
                      { label: 'Notif.', value: driver.pendingRequests, c: 'blue' },
                      { label: 'Recolh.', value: recolhidas, c: 'green' },
                      { label: 'Remanej.', value: remanejada, c: 'indigo' },
                      { label: 'Não Enc.', value: naoEncontrada, c: 'red' },
                      { label: 'Total', value: total, c: 'orange' },
                    ].map((item, i) => {
                      const styles = STATUS_COLORS[item.c] || STATUS_COLORS.blue;
                      return (
                        <div key={`stat-${item.label}-${i}`} className={`${styles.bg} p-2 rounded-xl border ${styles.border} text-center shadow-sm hover:scale-105 transition-all duration-200`}>
                          <p className={`text-[8px] ${styles.textLabel} uppercase tracking-wider mb-0.5`}>{item.label}</p>
                          <p className={`text-base font-black ${styles.textVal} leading-none`}>{item.value}</p>
                        </div>
                      );
                    })}
                  </div>

                  {/* Seletor de data da Linha do Tempo */}
                  <div className="flex items-center gap-2 p-2 bg-white border rounded-lg shadow-sm">
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-purple-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    <span className="text-[9px] font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">Linha do Tempo</span>
                    <input
                      type="date"
                      value={timelineDate}
                      max={localDateStr()}
                      onChange={e => {
                        setTimelineDate(e.target.value);
                        setFirebaseTimelineEvents({});
                      }}
                      className="flex-1 text-[10px] font-mono text-purple-700 border-0 bg-transparent focus:outline-none cursor-pointer"
                    />
                    {timelineDate !== localDateStr() && (
                      <button onClick={() => { setTimelineDate(localDateStr()); setFirebaseTimelineEvents({}); }}
                        className="text-[9px] text-purple-500 font-bold hover:text-purple-700 whitespace-nowrap">
                        Hoje
                      </button>
                    )}
                  </div>

                  {/* Linha do tempo de atividade */}
                  <div className="bg-white p-3 rounded-lg border shadow-sm">
                    {(() => {
                      const sheetsEvents = ((driver.timeline || []) as any[]).map(e => ({
                        ...e,
                        type: e.type === 'filial' ? 'recolhida' : e.type
                      }));
                      // fbEvents: 'em_posse' e 'removida_por_adm' — eventos exclusivos Firebase
                      // Estação/Recolhida/Não encontrada vêm do Sheets com isOccurrence correto via occLookup
                      const getFbEventsForDriverName = (nm: string) => {
                        const lowNm = normalizeName(nm);
                        const key = Object.keys(firebaseTimelineEvents).find(k => normalizeName(k) === lowNm);
                        return key ? firebaseTimelineEvents[key] : [];
                      };
                      const fbEvents = (getFbEventsForDriverName(driver.name))
                        .filter((e: any) => e.type === 'em_posse' || e.type === 'removida_por_adm')
                        .map((e: any) => ({
                          tsMs: e.tsMs, hour: new Date(e.tsMs).getHours(),
                          min: new Date(e.tsMs).getMinutes(),
                          type: e.type,
                          bikeNumber: e.bikeNumber,
                          observacao: e.observacao || '',
                          isOccurrence: !!e.isOccurrence
                        }));
                      const merged = [...sheetsEvents];
                      fbEvents.forEach((fe: any) => {
                        // Dedup por bike + janela de 2min
                        const isDup = sheetsEvents.some((se: any) => se.bikeNumber === fe.bikeNumber && Math.abs(se.tsMs - fe.tsMs) < 2 * 60 * 1000);
                        if (!isDup) merged.push(fe);
                      });
                      const events = merged.sort((a, b) => a.tsMs - b.tsMs);

                      const window = driver.timelineWindow as {startMs: number, endMs: number} | null;
                      let startMs = window?.startMs;
                      let endMs   = window?.endMs;
                      if (fbEvents.length > 0) {
                        const fbMin = Math.min(...fbEvents.map(e => e.tsMs));
                        const fbMax = Math.max(...fbEvents.map(e => e.tsMs));
                        startMs = startMs ? Math.min(startMs, fbMin) : fbMin;
                        endMs   = endMs   ? Math.max(endMs,   fbMax) : fbMax;
                      }
                      if (!startMs || !endMs) {
                        // Sem dados ainda — mostra linha vazia
                        return (
                          <div className="mb-1">
                            <div className="flex items-center justify-between mb-1.5 pb-1 border-b">
                              <p className="text-[8px] font-black text-gray-400 uppercase tracking-wider">Linha do Tempo</p>
                            </div>
                            <div className="relative h-5 mx-1 mt-1">
                              <div className="absolute top-2 left-0 right-0 h-px bg-gray-200"/>
                              <span className="absolute top-3.5 left-1/2 -translate-x-1/2 text-[7px] text-gray-300 italic">sem registros no período</span>
                            </div>
                          </div>
                        );
                      }

                      const totalMs = endMs - startMs || 1;
                      const toPos = (tsMs: number) => Math.max(0, Math.min(100, (tsMs - startMs!) / totalMs * 100));
                      const fmtTime = (ms: number) => {
                        const d = new Date(ms);
                        return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                      };

                      // Agrupa eventos próximos (mesmo tipo, ±3 minutos) em clusters
                      const CLUSTER_MS = 3 * 60 * 1000;
                      const clusters: Array<{type: string, tsMs: number, bikes: string[], count: number, observacoes: string[], isOccurrence: boolean}> = [];
                      events.forEach(ev => {
                        const last = clusters[clusters.length - 1];
                        if (last && last.type === ev.type && Math.abs(ev.tsMs - last.tsMs) < CLUSTER_MS) {
                          last.count++;
                          if (ev.bikeNumber && !last.bikes.includes(ev.bikeNumber)) last.bikes.push(ev.bikeNumber);
                          if (ev.observacao && !last.observacoes.includes(ev.observacao)) last.observacoes.push(ev.observacao);
                          if (!!(ev as any).isOccurrence && (ev.type === 'em_posse' || ev.type === 'nao_encontrada')) last.isOccurrence = true;
                          last.tsMs = Math.round((last.tsMs * (last.count - 1) + ev.tsMs) / last.count);
                        } else {
                          clusters.push({
                            type: ev.type,
                            tsMs: ev.tsMs,
                            bikes: ev.bikeNumber ? [ev.bikeNumber] : [],
                            observacoes: ev.observacao ? [ev.observacao] : [],
                            count: 1,
                            isOccurrence: !!(ev as any).isOccurrence && (ev.type === 'em_posse' || ev.type === 'nao_encontrada')
                          });
                        }
                      });

                      const dotConfig: Record<string, {bg: string, label: string}> = {
                        em_posse:      { bg: 'bg-green-500',   label: 'Em Posse' },
                        recolhida:     { bg: 'bg-green-700',   label: 'Recolhida (Filial)' },
                        estacao:       { bg: 'bg-indigo-500',  label: 'Estação' },
                        nao_atendida:  { bg: 'bg-yellow-500',  label: 'Não atend.' },
                        nao_encontrada:{ bg: 'bg-red-500',     label: 'Não enc.' },
                        carretinha:    { bg: 'bg-purple-600',  label: 'Carretinha' },
                        removida_por_adm: { bg: 'bg-black',    label: 'Removida por ADM' },
                      };

                      return (
                        <div className="mb-1">
                          <div className="flex items-center justify-between mb-1.5 border-b pb-1">
                            <p className="text-[8px] font-black text-gray-400 uppercase tracking-wider">Histórico de Atividade</p>
                            <button
                              onClick={() => setTimelineModal({ driver: driver.name, events, clusters, startMs: startMs!, endMs: endMs! })}
                              className="text-[8px] text-blue-500 font-bold hover:underline"
                            >⤢ Expandir</button>
                          </div>
                          <div className="relative h-8 mx-1">
                            <div className="absolute top-4 left-0 right-0 h-px bg-gray-900"/>
                            <span className="absolute top-5.5 left-0 text-[7px] text-gray-400 font-mono">{fmtTime(startMs!)}</span>
                            <span className="absolute top-5.5 right-0 text-[7px] text-gray-400 font-mono">{fmtTime(endMs!)}</span>
                            {clusters.map((cl, ci) => {
                              const pos = toPos(cl.tsMs);
                              const cfg = dotConfig[cl.type] || { bg: 'bg-gray-400', label: cl.type };
                              const isMulti = cl.count > 1;
                              return (
                                <div key={ci} className="absolute -translate-x-1/2 top-2.5 flex flex-col items-center"
                                  style={{left: `${pos}%`}}
                                  title={`${cl.isOccurrence ? '[OCORRÊNCIA] ' : ''}${(cl.type === 'carretinha' || cl.type === 'removida_por_adm') && cl.observacoes?.[0] ? cl.observacoes[0] : cfg.label}${cl.type === 'em_posse' && cl.bikes.length > 0 ? ` Bike ${cl.bikes.join(', ')}` : isMulti ? ` (${cl.count} bikes)` : ''} — ${fmtTime(cl.tsMs)}`}
                                >
                                  {cl.isOccurrence && (
                                    <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 flex flex-col items-center animate-pulse">
                                      <span className={`text-[12px] drop-shadow-sm ${cl.type === 'nao_encontrada' ? 'text-red-600' : 'text-yellow-500'}`}>★</span>
                                    </div>
                                  )}
                                  <div className={`rounded-full border-2 shadow-sm flex items-center justify-center ${isMulti ? 'w-4 h-4' : 'w-2.5 h-2.5'} ${cfg.bg} ${cl.isOccurrence ? (cl.type === 'nao_encontrada' ? 'border-red-500 ring-2 ring-red-400/50' : 'border-yellow-400 ring-2 ring-yellow-400/50') : 'border-white'}`}>
                                    {isMulti && !cl.isOccurrence && (
                                      <span className="text-[7px] font-black text-white leading-none">{cl.count}</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex flex-wrap gap-2 mt-4 border-t pt-2">
                            {Object.entries(dotConfig).map(([k, v]) => (
                              <div key={k} className="flex items-center gap-0.5 animate-fade-in">
                                <div className={`w-1.5 h-1.5 rounded-full ${v.bg}`}/>
                                <span className="text-[7px] text-gray-400">{v.label}</span>
                              </div>
                            ))}
                            <div className="flex items-center gap-1 ml-auto">
                              <div className="flex items-center gap-0.5">
                                <span className="text-[10px] text-yellow-500">★</span>
                                <span className="text-[7px] text-gray-400">Ocorrência Recolhida</span>
                              </div>
                              <div className="flex items-center gap-0.5">
                                <span className="text-[10px] text-red-600">★</span>
                                <span className="text-[7px] text-gray-400">Ocorrência Não Encontrada</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* RESUMO DE PRODUÇÃO — acima da busca */}
        {(isMecanica || isTecnica) && (() => {
          const periods = [
            { key: 'diario' as const, label: 'Dia' },
            { key: 'semanal' as const, label: 'Semana' },
            { key: 'mensal' as const, label: 'Mês' },
          ];
          const now = new Date();
          const cutoff = new Date();
          if (mechanicSummaryPeriod === 'semanal') { cutoff.setDate(now.getDate() - 7); cutoff.setHours(0,0,0,0); }
          else if (mechanicSummaryPeriod === 'mensal') { cutoff.setMonth(now.getMonth() - 1); cutoff.setHours(0,0,0,0); }
          else { cutoff.setHours(0,0,0,0); }
          const sourceList = isTecnica ? technicaList : mechanicsList;
          const activeStatuses = isTecnica
            ? ['Em Técnica', 'Aguardando Técnica']
            : ['Em Manutenção', 'Reserva'];
          const byMechanic: Record<string, {manutencao: number, reserva: number, bikesMan: string[], bikesRes: string[]}> = {};
          
          const rawMechs = (!isTecnica
            ? [...AUTHORIZED_MECHANICS_NORMALIZED, ...dynamicMechanics]
            : TECNICA_TECHNICIANS).filter(name => {
              const norm = normalizeForSearch(name);
              return norm !== 'CAIO' && norm !== 'JULIANO';
            });
          
          const seenNorm = new Set<string>();
          const activeMechs: string[] = [];
          rawMechs.forEach(name => {
            const norm = normalizeForSearch(name);
            if (norm && norm !== 'MECANICA' && norm !== 'TODOS' && norm !== '—' && !seenNorm.has(norm)) {
              seenNorm.add(norm);
              activeMechs.push(name);
            }
          });
          
          activeMechs.forEach(mName => {
            byMechanic[mName] = { manutencao: 0, reserva: 0, bikesMan: [], bikesRes: [] };
          });

          sourceList.filter(b => activeStatuses.includes(b.status)).forEach(b => {
            // Técnica: usa responsável (técnico que recebeu) para Em Técnica,
            // e mecanico (origem) para Aguardando Técnica
            const isMainStatus = isTecnica ? b.status === 'Em Técnica' : b.status === 'Em Manutenção';
            const m = isTecnica && isMainStatus
              ? (b.responsavel || b.tecnico || b.mecanico || '—')
              : (b.mecanico || '—');
            const mNorm = normalizeForSearch(m);
            if (mNorm === 'MECANICA' || mNorm === 'TODOS' || mNorm === '—' || mNorm === '') return;
            
            // Only count if it belongs to one of our dynamic/fallback mechanics or technicians (accent-insensitive)
            const exists = activeMechs.some(auth => normalizeForSearch(auth) === mNorm);
            if (!exists) return; // Ignore old/generic names not in active list
            
            const matchedKey = activeMechs.find(auth => normalizeForSearch(auth) === mNorm) || m;
            if (!byMechanic[matchedKey]) {
              byMechanic[matchedKey] = { manutencao: 0, reserva: 0, bikesMan: [], bikesRes: [] };
            }
            
            const targetDateRaw = isMainStatus ? b.dataEntrada : (b.dataSaida || b.dataEntrada);
            let entryDate = null;
            if (targetDateRaw) {
              if (targetDateRaw.toDate) {
                entryDate = targetDateRaw.toDate();
              } else {
                const parsed = new Date(targetDateRaw);
                if (!isNaN(parsed.getTime())) {
                  entryDate = parsed;
                }
              }
            }
            
            if (!entryDate || entryDate >= cutoff) {
              if (isMainStatus) { 
                byMechanic[matchedKey].manutencao++; 
                byMechanic[matchedKey].bikesMan.push(b.patrimonio); 
              } else { 
                byMechanic[matchedKey].reserva++; 
                byMechanic[matchedKey].bikesRes.push(b.patrimonio); 
              }
            }
          });
          const mechs = Object.entries(byMechanic);
          return (
            <>
            <div className="mb-4 p-4 border border-gray-100 rounded-2xl bg-white shadow-md">
              <div className="flex items-center justify-between mb-3.5 pb-2 border-b border-gray-100/80">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-amber-50 rounded-lg text-amber-600">
                    <TrendingUp className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-black text-gray-700 uppercase tracking-wider">Produção de {isTecnica ? 'Técnicos' : 'Mecânicos'}</span>
                </div>
                <div className="flex bg-gray-100 rounded-xl p-0.5 gap-0.5 shadow-inner">
                  {periods.map(p => (
                    <button key={p.key} onClick={() => setMechanicSummaryPeriod(p.key)}
                      className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-lg transition-all duration-200 ${
                        mechanicSummaryPeriod === p.key 
                          ? 'bg-white text-gray-800 shadow-sm font-black' 
                          : 'text-gray-400 hover:text-gray-600'
                      }`}
                    >{p.label}</button>
                  ))}
                </div>
              </div>
              {mechs.length === 0 ? (
                <p className="text-xs text-gray-400 italic text-center py-4">Nenhum dado registrado para o período</p>
              ) : (
                <div className="space-y-2.5">
                  {mechs.map(([name, counts]) => (
                    <div key={name} className="flex items-center gap-3 p-2 rounded-xl bg-gray-50/50 hover:bg-gray-50 transition-colors duration-150 border border-transparent hover:border-gray-100">
                      <span className="text-xs font-bold text-gray-700 uppercase w-20 truncate flex-shrink-0">{name}</span>
                      <div className="flex gap-2 flex-1">
                        <button
                          onClick={() => counts.manutencao > 0 && setProductionDrillDown({ mechanic: name, type: 'man', bikes: counts.bikesMan })}
                          className={`flex flex-col items-center py-1 px-3 bg-amber-50/60 border border-amber-100 rounded-xl flex-1 transition-all ${
                            counts.manutencao > 0 
                              ? 'hover:bg-amber-100 hover:border-amber-200 active:scale-95 shadow-sm cursor-pointer' 
                              : 'opacity-60 cursor-default'
                          }`}
                        >
                          <span className="text-[8px] font-black text-amber-600 uppercase tracking-wide leading-none mb-0.5">{isTecnica ? 'Em Técnica' : 'Em Manut.'}</span>
                          <span className="text-base font-black text-amber-800 leading-tight">{counts.manutencao}</span>
                        </button>
                        <button
                          onClick={() => counts.reserva > 0 && setProductionDrillDown({ mechanic: name, type: 'res', bikes: counts.bikesRes })}
                          className={`flex flex-col items-center py-1 px-3 bg-emerald-50/60 border border-emerald-100 rounded-xl flex-1 transition-all ${
                            counts.reserva > 0 
                              ? 'hover:bg-emerald-100 hover:border-emerald-200 active:scale-95 shadow-sm cursor-pointer' 
                              : 'opacity-60 cursor-default'
                          }`}
                        >
                          <span className="text-[8px] font-black text-emerald-600 uppercase tracking-wide leading-none mb-0.5">{isTecnica ? 'Aguardando' : 'Reserva'}</span>
                          <span className="text-base font-black text-emerald-800 leading-tight">{counts.reserva}</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Popup drill-down bikes da produção */}
            {productionDrillDown && (
              <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/40 p-4" onClick={() => setProductionDrillDown(null)}>
                <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
                  <div className={`p-3 text-white flex items-center justify-between ${productionDrillDown.type === 'man' ? 'bg-orange-500' : 'bg-green-600'}`}>
                    <div>
                      <p className="text-[10px] font-bold uppercase opacity-80">{productionDrillDown.type === 'man' ? (isTecnica ? 'Em Técnica' : 'Em Manutenção') : (isTecnica ? 'Aguardando' : 'Reserva')}</p>
                      <h3 className="text-base font-black">{productionDrillDown.mechanic}</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-2xl font-black">{productionDrillDown.bikes.length}</span>
                      <button onClick={() => setProductionDrillDown(null)} className="p-1 hover:bg-white/20 rounded-full ml-2">
                        <XIcon className="w-4 h-4"/>
                      </button>
                    </div>
                  </div>
                  <div className="p-3 max-h-56 overflow-y-auto">
                    <div className="flex flex-wrap gap-1.5">
                      {productionDrillDown.bikes.map(pat => (
                        <span key={pat} className={`font-mono font-black text-sm px-2.5 py-1 rounded-lg border ${
                          productionDrillDown.type === 'man'
                            ? 'bg-orange-50 border-orange-200 text-orange-700'
                            : 'bg-green-50 border-green-200 text-green-700'
                        }`}>{pat}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            </>
          );
        })()}

        {/* BUSCA */}
        {!isAdm && (
          <div className="mb-4 p-3 border rounded-lg bg-gray-50">
            <h2 className="text-base font-medium text-gray-700 mb-2">Consultar Bicicleta</h2>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-grow">
                  <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    placeholder="Digite o patrimônio..."
                    className="w-full p-1.5 pr-8 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-sm"/>
                  {searchTerm && (
                    <button onClick={() => { setSearchTerm(''); setSearchedBike(null); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><XIcon className="w-4 h-4"/></button>
                  )}
                </div>
                <button onClick={() => isScannerOpen ? stopScanner() : startScanner()}
                  className={`p-1.5 rounded-md border ${isScannerOpen ? 'bg-red-50 border-red-200 text-red-600' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  title={isScannerOpen ? 'Fechar Scanner' : 'QR Code'}>
                  <QrCodeIcon className="w-5 h-5"/>
                </button>
                <button onClick={() => handleSearch()} disabled={isSearching || isScannerOpen}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 active:scale-95 disabled:bg-gray-400 flex items-center gap-2 text-sm">
                  {isSearching ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"/> : <SearchIcon className="w-4 h-4"/>}
                  <span>{isSearching ? 'Buscando...' : 'Consultar'}</span>
                </button>
              </div>
              {isScannerOpen && (
                <div className="relative overflow-hidden rounded-lg bg-black aspect-square max-w-[300px] mx-auto w-full border-2 border-blue-500 shadow-xl">
                  <div id="qr-reader" className="w-full h-full"/>
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center"><div className="w-48 h-48 border-2 border-blue-400/50 rounded-lg"/></div>
                  <button onClick={stopScanner} className="absolute top-2 right-2 bg-black/50 text-white p-1 rounded-full"><XIcon className="w-4 h-4"/></button>
                  <p className="absolute bottom-2 left-0 right-0 text-center text-[10px] text-white bg-black/50 py-1">Aponte para o QR Code</p>
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="text-red-600 bg-red-100 p-3 rounded-md text-sm mb-4 flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
              <XIcon className="w-4 h-4"/>
            </button>
          </div>
        )}
        {successMessage && <div className="text-green-600 bg-green-100 p-3 rounded-md text-sm mb-4">{successMessage}</div>}

        {/* RESULTADO DA BUSCA */}
        {!isAdm && searchedBike && (
          <div ref={searchResultRef} className="p-4 border rounded-lg bg-green-50 animate-fade-in-down relative mb-4">
            <button onClick={() => { setSearchedBike(null); setSearchTerm(''); }} className="absolute top-2 right-2 p-1 text-green-700 hover:bg-green-100 rounded-full"><XIcon className="w-5 h-5"/></button>
            <h3 className="text-lg font-semibold text-green-800 mb-3">Resultado da Consulta</h3>
            {collectedBikes.includes(String(searchedBike['Patrimônio'])) && (
              <div className="mb-3 p-2 bg-yellow-100 border border-yellow-400 text-yellow-800 text-[10px] font-bold rounded flex items-center gap-2">
                <AlertTriangleIcon className="w-4 h-4"/><span>ATENÇÃO: Você já está em posse desta bicicleta.</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <p className="font-semibold text-gray-500 text-xs uppercase">Status</p>
                <p className="text-gray-800 font-medium">{searchedBike['Status']}</p>
              </div>
              <div>
                <p className="font-semibold text-gray-500 text-xs uppercase">Coordenadas</p>
                <a href={`https://www.google.com/maps/search/?api=1&query=${formatCoordinate(searchedBike['Latitude'])},${formatCoordinate(searchedBike['Longitude'])}`}
                  target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium truncate block">
                  {`${formatCoordinate(searchedBike['Latitude'])}, ${formatCoordinate(searchedBike['Longitude'])}`}
                </a>
              </div>
              <div>
                <p className="font-semibold text-gray-500 text-xs uppercase">Localidade</p>
                <p className="text-gray-800 font-medium">{searchedBike['Localidade']}</p>
              </div>
              <div>
                <p className="font-semibold text-gray-500 text-xs uppercase">Trava</p>
                <p className="text-gray-800 font-medium">{searchedBike['Trava']}</p>
              </div>
              <div>
                <p className="font-semibold text-gray-500 text-xs uppercase">Usuário</p>
                <p className="text-gray-800 font-medium">{searchedBike['Usuário']}</p>
              </div>
              <div>
                <p className="font-semibold text-gray-500 text-xs uppercase">Carregamento</p>
                <p className="text-gray-800 font-medium">{searchedBike['Carregamento']}</p>
              </div>
              <div>
                <p className="font-semibold text-gray-500 text-xs uppercase">Bateria</p>
                <div className="flex items-center gap-2">
                  <p className="text-gray-800 font-medium">{formatBattery(searchedBike['Bateria'])}%</p>
                  <span className="text-[10px] font-bold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full uppercase">
                    {searchedBike['Status'] || searchedBike['status'] || searchedBike['statusSistema'] || searchedBike['situacao'] || bikeConflicts[String(searchedBike['Patrimônio'])]?.status || 'N/A'}
                  </span>
                </div>
              </div>
              <div>
                <p className="font-semibold text-gray-500 text-xs uppercase">Última Info</p>
                <p className={`font-medium ${formatLastInfo(searchedBike['Última informação da posição']).color}`}>
                  {formatLastInfo(searchedBike['Última informação da posição']).text}
                </p>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-green-200 grid grid-cols-2 gap-2">
              {!isMecanica && !isTecnica && (
                <>
                  <button onClick={() => handleStatusUpdate('Recolhida')} disabled={isLoading || processingBikes.has(String(searchedBike['Patrimônio']))}
                    className="px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm disabled:bg-gray-400">Recolhida</button>
                  <button onClick={() => setIsNotFoundConfirmOpen(true)} disabled={isLoading || processingBikes.has(String(searchedBike['Patrimônio']))}
                    className="px-3 py-1.5 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm disabled:bg-gray-400">Não Encontrada</button>
                </>
              )}
              
              {isMecanica && (
                <div className="col-span-2 grid grid-cols-2 gap-2 mt-2">
                  <button onClick={() => handleManualInsert(String(searchedBike['Patrimônio']), 'Alterar Status')}
                    className="px-3 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 text-[10px] font-black uppercase shadow-sm transition-colors">
                    Alterar Status
                  </button>
                  <button onClick={() => handleManualInsert(String(searchedBike['Patrimônio']), 'Aguardando Manutenção')}
                    className="px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-[10px] font-black uppercase shadow-sm transition-colors">
                    Aguardando Manutenção
                  </button>
                  <button onClick={() => handleManualInsert(String(searchedBike['Patrimônio']), 'Em Manutenção')}
                    className="px-3 py-2 bg-orange-600 text-white rounded-md hover:bg-orange-700 text-[10px] font-black uppercase shadow-sm transition-colors">
                    Manutenção
                  </button>
                  <button onClick={() => handleManualInsert(String(searchedBike['Patrimônio']), 'Reserva')}
                    className="px-3 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 text-[10px] font-black uppercase shadow-sm transition-colors">
                    Reserva
                  </button>
                </div>
              )}
              {isTecnica && (
                <div className="col-span-2 grid grid-cols-2 gap-2 mt-2">
                  <button onClick={async () => {
                    const pat = String(searchedBike['Patrimônio']);
                    await handleSendToTechnical(pat);
                    setSearchedBike(null);
                    setSearchTerm('');
                    setSuccessMessage(`Bike ${pat} em Aguardando Técnica.`);
                  }} className="px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-[10px] font-black uppercase shadow-sm col-span-2">
                    Aguardando Técnica
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* NOTIFICAÇÕES */}
        <div className="mt-6 p-4 border rounded-lg bg-gray-50">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-lg font-semibold text-gray-700">Notificações Pendentes</h2>
            <button onClick={() => { setIsHistoryModalOpen(true); fetchRequestsHistory(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-xs font-bold text-gray-600 hover:bg-gray-50 hover:text-blue-600 shadow-sm">
              <CalendarIcon className="w-3.5 h-3.5"/>Ver Histórico
            </button>
          </div>
          {(() => {
            // Filtra notificações já processadas nesta sessão E que não sejam mais pendentes
            const visibleRequests = pendingRequests.filter(req => {
              if (processedRequestIds.current.has(String(req.id))) return false;
              const status = (req.status || req.situacao || '').toString().toLowerCase().trim();
              // Só exibe se explicitamente pendente — aceita/finalizada/recusada não aparecem
              if (status && status !== 'pendente') return false;
              return true;
            });
            return visibleRequests.length > 0 ? (
              <ul className="space-y-3">
                {visibleRequests.map((req, i) => (
                <li key={`req-${req.id}-${i}`} className="p-3 bg-white border rounded-md shadow-sm flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-bold text-blue-600">Bicicleta: {req.bikeNumber}</p>
                      {renderConflictIcon(req.bikeNumber)}
                    </div>
                    <p className="text-sm text-gray-700 mb-1"><span className="font-semibold">Motivo:</span> {req.reason}</p>
                    {renderLocationWithMap(req.location)}
                  </div>
                  <div className="flex flex-col gap-4 items-end pt-1">
                    <button onClick={() => handleAcceptRequest(req.id, req.bikeNumber, req.reason, req.location)} disabled={isLoading} className="text-green-600 hover:text-green-700 text-sm font-bold disabled:text-gray-400">Aceitar</button>
                    <button onClick={() => handleDeclineRequest(req.id)} disabled={isLoading} className="text-red-600 hover:text-red-700 text-sm font-bold disabled:text-gray-400">Recusar</button>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-gray-500">Nenhuma notificação pendente.</p>;
          })()}
        </div>

        {/* ÍCONES DE ATALHO MECÂNICA */}
        {isMecanica && (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-6">
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Alterar Status' ? null : 'Alterar Status')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Alterar Status' ? 'bg-purple-600 border-purple-700 text-white' : 'bg-purple-50 border-purple-100 hover:bg-purple-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeMechanicCategory === 'Alterar Status' ? 'bg-white text-purple-600' : 'bg-purple-600 text-white'}`}>
                <PlusPlusIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeMechanicCategory === 'Alterar Status' ? 'text-white' : 'text-purple-800'}`}>Alterar Status</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeMechanicCategory === 'Alterar Status' ? 'text-white' : 'text-purple-600'}`}>
                {mechanicsList.filter(b => b.status === 'Alterar Status' || b.status === 'Não encontrada').length}
              </span>
            </button>
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Aguardando Manutenção' ? null : 'Aguardando Manutenção')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Aguardando Manutenção' ? 'bg-blue-600 border-blue-700 text-white' : 'bg-blue-50 border-blue-100 hover:bg-blue-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeMechanicCategory === 'Aguardando Manutenção' ? 'bg-white text-blue-600' : 'bg-blue-600 text-white'}`}>
                <CarIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeMechanicCategory === 'Aguardando Manutenção' ? 'text-white' : 'text-blue-800'}`}>Aguardando Manutenção</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeMechanicCategory === 'Aguardando Manutenção' ? 'text-white' : 'text-blue-600'}`}>
                {mechanicsList.filter(b => b.status === 'Aguardando Manutenção').length}
              </span>
            </button>
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Em Manutenção' ? null : 'Em Manutenção')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Em Manutenção' ? 'bg-orange-600 border-orange-700 text-white' : 'bg-orange-50 border-orange-100 hover:bg-orange-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeMechanicCategory === 'Em Manutenção' ? 'bg-white text-orange-600' : 'bg-orange-600 text-white'}`}>
                <BicycleIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeMechanicCategory === 'Em Manutenção' ? 'text-white' : 'text-orange-800'}`}>Em Manutenção</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeMechanicCategory === 'Em Manutenção' ? 'text-white' : 'text-orange-600'}`}>
                {mechanicsList.filter(b => b.status === 'Em Manutenção').length}
              </span>
            </button>
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Reserva' ? null : 'Reserva')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Reserva' ? 'bg-green-600 border-green-700 text-white' : 'bg-green-50 border-green-100 hover:bg-green-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeMechanicCategory === 'Reserva' ? 'bg-white text-green-600' : 'bg-green-600 text-white'}`}>
                <TrailerIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeMechanicCategory === 'Reserva' ? 'text-white' : 'text-green-800'}`}>Reserva</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeMechanicCategory === 'Reserva' ? 'text-white' : 'text-green-600'}`}>
                {mechanicsList.filter(b => b.status === 'Reserva').length}
              </span>
            </button>
            {/* Ícone Histórico */}
            <button
              onClick={() => { setIsMechanicHistoryOpen(true); fetchMechanicHistory(); }}
              className="flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 bg-gray-50 border-gray-200 hover:bg-gray-100"
            >
              <div className="p-1.5 rounded-full mb-1 bg-gray-700 text-white">
                <CalendarIcon className="w-4 h-4" />
              </div>
              <span className="text-[8px] font-bold text-center leading-tight h-5 flex items-center text-gray-800">Histórico</span>
              <span className="mt-0.5 text-[10px] font-black text-gray-500">—</span>
            </button>
          </div>
        )}

        {/* MECÂNICA */}
        {isMecanica && activeMechanicCategory && (
          <div className="mt-6 space-y-6">
            {activeMechanicCategory === 'Alterar Status' && (
              <div id="section-alterar-status" className="p-4 border rounded-lg bg-purple-50 shadow-sm scroll-mt-4">
                <div className="space-y-3 mb-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-purple-800 flex items-center gap-2"><PlusPlusIcon className="w-5 h-5"/>Alterar Status</h2>
                    {mechanicsList.filter(b => b.status === 'Alterar Status' || b.status === 'Não encontrada').length > 0 && (
                      <button
                        onClick={() => setIsLimparListaConfirmOpen(true)}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-purple-300 text-purple-700 text-[10px] font-bold rounded-lg hover:bg-purple-100 active:scale-95 transition-all disabled:opacity-50 shadow-sm"
                      >
                        <XIcon className="w-3.5 h-3.5" />
                        Limpar Lista
                      </button>
                    )}
                  </div>
                  
                  {/* Busca */}
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <SearchIcon className="h-4 w-4 text-purple-400" />
                    </div>
                    <input
                      type="text"
                      placeholder="Pesquisar bike pelo número..."
                      value={mechanicSearchTerm}
                      onChange={(e) => setMechanicSearchTerm(e.target.value)}
                      className="block w-full pl-10 pr-3 py-2 border border-purple-200 rounded-xl leading-5 bg-white placeholder-purple-300 focus:outline-none focus:ring-1 focus:ring-purple-500 focus:border-purple-500 sm:text-xs text-sm font-bold shadow-sm"
                    />
                    {mechanicSearchTerm && (
                      <button 
                        onClick={() => setMechanicSearchTerm('')}
                        className="absolute inset-y-0 right-0 pr-3 flex items-center text-purple-400 hover:text-purple-600"
                      >
                        <XIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                {(() => {
                  const bikesInPendingActions = new Set(
                    pendingActions
                      .filter(a => a.type === 'trailer_validation' || a.type === 'alterar_status_lote')
                      .flatMap(a => a.bikes || [])
                      .map(p => String(p).trim().replace(/^0+/, ''))
                  );

                  const items = mechanicsList.filter(b => {
                    return (b.status === 'Alterar Status' || b.status === 'Não encontrada') &&
                           (!mechanicSearchTerm || String(b.patrimonio || '').includes(mechanicSearchTerm));
                  });
                  return items.length > 0 ? (
                    <div className="space-y-2">
                      {items.map((bike, i) => {
                        const isNotFound = bike.status === 'Não encontrada';
                        const pat = String(bike.patrimonio || '').trim().replace(/^0+/, '');
                        const isPending = bikesInPendingActions.has(pat);
                        return (
                          <div key={`mec-alterar-${bike.patrimonio}-${i}`} 
                            className={`flex justify-between items-center p-3 bg-white border rounded-md shadow-sm ${isPending ? 'border-amber-200 bg-amber-50/50' : isNotFound ? 'border-red-400 ring-1 ring-red-400' : ''}`}
                          >
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`font-bold ${isNotFound ? 'text-red-600' : 'text-gray-700'}`}>Bike: {bike.patrimonio}</span>
                              {isNotFound && (
                                <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-[8px] font-black rounded border border-red-200 animate-pulse">
                                  PENDENTE / NÃO ENCONTRADA
                                </span>
                              )}
                              {isPending && (
                                <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 text-[8px] font-black rounded border border-amber-200 uppercase tracking-wider">
                                  Aguardando ADM
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                              {bike.bateria !== undefined && <p className="text-[10px] text-gray-600">Bateria: {formatBattery(bike.bateria)}%</p>}
                              {bike.carregamento === 'Carregando' && <p className="text-[10px] text-green-600 font-bold">⚡ Carregando</p>}
                              {bike.carregamento === 'Não carregando' && <p className="text-[10px] text-red-500 font-bold">🔌 Não carregando</p>}
                            </div>
                            {bike.motorista && <p className="text-[10px] text-blue-700 font-semibold">Motorista: {bike.motorista}</p>}
                            {bike.observacao && <p className="text-[10px] text-orange-600">Motivo: {bike.observacao}</p>}
                            {isNotFound && <p className="text-[10px] text-red-500 italic mt-1">Aguardando localização...</p>}
                          </div>
                          <div className="flex flex-col gap-2 min-w-[124px]">
                            {isPending ? (
                              <div className="text-center bg-amber-50 border border-amber-200 rounded p-1.5">
                                <p className="text-[9px] font-extrabold text-amber-700 uppercase tracking-wider leading-none">Pendente</p>
                                <p className="text-[8px] text-amber-600 mt-1 font-semibold leading-tight">Validação do Administrador</p>
                              </div>
                            ) : !isNotFound ? (
                              <>
                                <button
                                  onClick={() => handleAlterarStatus(bike.patrimonio)}
                                  disabled={isLoading}
                                  className="w-full px-3 py-1.5 bg-purple-600 text-white text-xs font-bold rounded hover:bg-purple-700 active:scale-95 transition-all disabled:opacity-50"
                                >
                                  Alterar Status
                                </button>
                                <button onClick={() => setMechanicNotFoundModal({ isOpen: true, bikePat: bike.patrimonio })} className="w-full px-3 py-1.5 bg-red-500 text-white text-xs font-bold rounded hover:bg-red-600 active:scale-95">Não encontrada</button>
                              </>
                            ) : (
                              <button 
                                onClick={() => setBikeFoundModal({ isOpen: true, bikePat: bike.patrimonio })} 
                                className="w-full px-3 py-2 bg-green-600 text-white text-[10px] font-black uppercase rounded shadow-md hover:bg-green-700 active:scale-95 transition-all"
                              >
                                Bike Localizada
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : <p className="text-sm text-gray-500 italic">Nenhuma bike.</p>;
              })()}
              </div>
            )}

            {activeMechanicCategory === 'Aguardando Manutenção' && (
              <div id="section-aguardando-manutencao" className="p-4 border rounded-lg bg-blue-50 shadow-sm scroll-mt-4">
                <div className="space-y-3 mb-4">
                  <h2 className="text-lg font-bold text-blue-800 flex items-center gap-2"><CarIcon className="w-5 h-5"/>Aguardando Manutenção</h2>
                  
                  {/* Busca */}
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <SearchIcon className="h-4 w-4 text-blue-400" />
                    </div>
                    <input
                      type="text"
                      placeholder="Pesquisar bike pelo número..."
                      value={mechanicSearchTerm}
                      onChange={(e) => setMechanicSearchTerm(e.target.value)}
                      className="block w-full pl-10 pr-3 py-2 border border-blue-200 rounded-xl leading-5 bg-white placeholder-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 sm:text-xs text-sm font-bold shadow-sm"
                    />
                    {mechanicSearchTerm && (
                      <button 
                        onClick={() => setMechanicSearchTerm('')}
                        className="absolute inset-y-0 right-0 pr-3 flex items-center text-blue-400 hover:text-blue-600"
                      >
                        <XIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                {(() => {
                  const items = mechanicsList.filter(b => 
                    b.status === 'Aguardando Manutenção' &&
                    (!mechanicSearchTerm || String(b.patrimonio || '').includes(mechanicSearchTerm))
                  );
                  return items.length > 0 ? (
                    <div className="space-y-2">
                      {items.map((bike, i) => (
                        <div key={`mec-aguardando-${bike.patrimonio}-${i}`} className="flex justify-between items-center p-3 bg-white border rounded-md shadow-sm">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-gray-700">Bike: {bike.patrimonio}</span>
                            </div>
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                              {bike.bateria !== undefined && <p className="text-[10px] text-gray-600">Bateria: {formatBattery(bike.bateria)}%</p>}
                            </div>
                            {bike.motorista && <p className="text-[10px] text-blue-700 font-semibold">Motorista: {bike.motorista}</p>}
                            {bike.observacao && <p className="text-[10px] text-orange-600">Motivo: {bike.observacao}</p>}
                          </div>
                          <div className="flex flex-col gap-2 min-w-[140px]">
                            <div className="flex gap-2">
                              <button onClick={() => handleConfirmMechanicsReceipt(bike.patrimonio)} className="flex-1 px-3 py-1.5 bg-orange-500 text-white text-xs font-bold rounded hover:bg-orange-600 active:scale-95">Manutenção</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-sm text-gray-500 italic">Nenhuma bike.</p>;
                })()}
              </div>
            )}

            {activeMechanicCategory === 'Em Manutenção' && (
              <div id="section-manutencao" className="p-4 border rounded-lg bg-orange-50 shadow-sm scroll-mt-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                  <h2 className="text-lg font-bold text-orange-800 flex items-center gap-2"><BicycleIcon className="w-5 h-5"/>Mecânica - Em Manutenção</h2>
                  
                  {/* Filtros */}
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                      <div className="flex items-center gap-2">
                        <label htmlFor="mechanic-filter" className="text-xs font-bold text-gray-600 w-12">Mecân.:</label>
                        <select 
                          id="mechanic-filter"
                          value={selectedMechanicFilter}
                          onChange={(e) => setSelectedMechanicFilter(e.target.value)}
                          className="text-xs p-1 border rounded bg-white font-semibold text-gray-700 focus:ring-1 focus:ring-orange-500 outline-none"
                        >
                          <option value="Todos">Todos os Mecânicos</option>
                          {Array.from(new Set(mechanicsList.filter(b => b.status === 'Em Manutenção' && b.mecanico).map(b => b.mecanico))).sort().map(name => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-xs font-bold text-gray-600 w-12">Bateria:</label>
                        <button
                          onClick={() => setSelectedBatteryFilter(prev => prev === 'asc' ? 'desc' : prev === 'desc' ? 'Todos' : 'asc')}
                          className={`text-xs px-2 py-1 rounded border font-bold transition-all ${
                            selectedBatteryFilter === 'desc' ? 'bg-orange-500 text-white border-orange-500' :
                            selectedBatteryFilter === 'asc'  ? 'bg-blue-500 text-white border-blue-500' :
                            'bg-white text-gray-500 border-gray-300 hover:border-gray-400'
                          }`}
                        >
                          {selectedBatteryFilter === 'desc' ? '🔋 Maior → Menor' :
                           selectedBatteryFilter === 'asc'   ? '🔋 Menor → Maior' :
                           '🔋 Ordenar'}
                        </button>
                      </div>
                    </div>

                    {/* Busca */}
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <SearchIcon className="h-4 w-4 text-orange-400" />
                      </div>
                      <input
                        type="text"
                        placeholder="Pesquisar bike pelo número..."
                        value={mechanicSearchTerm}
                        onChange={(e) => setMechanicSearchTerm(e.target.value)}
                        className="block w-full pl-10 pr-3 py-1.5 border border-orange-200 rounded-xl leading-5 bg-white placeholder-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500 sm:text-xs text-sm font-bold shadow-sm"
                      />
                      {mechanicSearchTerm && (
                        <button 
                          onClick={() => setMechanicSearchTerm('')}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center text-orange-400 hover:text-orange-600"
                        >
                          <XIcon className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {(() => {
                  const getBatPct = (b: any) => {
                    const raw = b.bateria !== undefined ? Number(b.bateria) : undefined;
                    return raw !== undefined ? (raw <= 1 && raw > 0 ? Math.round(raw * 100) : Math.round(raw)) : -1;
                  };
                  const filteredBikes = mechanicsList
                    .filter(b =>
                      b.status === 'Em Manutenção' &&
                      (selectedMechanicFilter === 'Todos' || b.mecanico === selectedMechanicFilter) &&
                      (!mechanicSearchTerm || String(b.patrimonio || '').includes(mechanicSearchTerm))
                    )
                    .sort((a, b) => {
                      if (selectedBatteryFilter === 'desc') return getBatPct(b) - getBatPct(a);
                      if (selectedBatteryFilter === 'asc')  return getBatPct(a) - getBatPct(b);
                      return 0;
                    });
                  
                  return filteredBikes.length > 0 ? (
                    <div className="space-y-2">
                      {filteredBikes.map((bike, i) => (
                        <div key={`mec-manut-${bike.patrimonio}-${i}`} className="flex justify-between items-center p-3 bg-white border rounded-md shadow-sm">
                          <div>
                            <span className="font-bold text-gray-700">Bike: {bike.patrimonio}</span>
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                              {bike.bateria !== undefined && <p className="text-[10px] text-gray-600">Bateria: {formatBattery(bike.bateria)}%</p>}
                              {bike.carregamento === 'Carregando' && <p className="text-[10px] text-green-600 font-bold">⚡ Carregando</p>}
                              {bike.carregamento === 'Não carregando' && <p className="text-[10px] text-red-500 font-bold">🔌 Não carregando</p>}
                              <p className={`text-[10px] font-bold ${
                                ['aberta', 'aberto', 'open'].includes(String(bike.trava || '').toLowerCase().trim())
                                  ? 'text-orange-500' 
                                  : 'text-gray-500'
                              }`}>
                                🔒 Trava: {['aberta', 'aberto', 'open'].includes(String(bike.trava || '').toLowerCase().trim()) ? 'Aberta' : 'Fechada'}
                              </p>
                            </div>
                            {bike.mecanico && <p className="text-[10px] font-bold text-blue-600">Mecânico: {bike.mecanico}</p>}
                            {bike.motorista && <p className="text-[10px] text-blue-700 font-semibold">Motorista: {bike.motorista}</p>}
                            {bike.observacao && <p className="text-[10px] text-orange-600">Motivo: {bike.observacao}</p>}
                            {bike.tratativa && bike.tratativa !== 'MANUAL' && <p className="text-[10px] text-gray-500 italic">Obs: {bike.tratativa}</p>}
                          </div>
                          <div className="flex flex-col gap-2">
                            <button onClick={() => { setSelectedMechanicBike(bike); setIsMechanicRepairModalOpen(true); }} className="px-3 py-1.5 bg-orange-600 text-white text-xs font-bold rounded hover:bg-orange-700 active:scale-95">Finalizar Reparo</button>
                            <div className="flex gap-2">
                              <button onClick={() => setIsTechnicalConfirmOpen({ isOpen: true, bikePat: bike.patrimonio, mechanicName: bike.mecanico })} className="flex-1 px-2 py-1 bg-blue-600 text-white text-[10px] font-bold rounded hover:bg-blue-700 active:scale-95">Técnica</button>
                              <button onClick={() => setIsVandalizedConfirmOpen({ isOpen: true, bikePat: bike.patrimonio })} className="flex-1 px-2 py-1 bg-red-600 text-white text-[10px] font-bold rounded hover:bg-red-700 active:scale-95">Vandalizada</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-sm text-gray-500 italic">Nenhuma bike encontrada para este filtro.</p>;
                })()}
              </div>
            )}

            {activeMechanicCategory === 'Reserva' && (
              <div id="section-reserva" className="p-4 border rounded-lg bg-green-50 shadow-sm scroll-mt-4">
                <div className="space-y-3 mb-4">
                  <div className="flex justify-between items-center">
                    <h2 className="text-lg font-bold text-green-800 flex items-center gap-2"><TrailerIcon className="w-5 h-5"/>Reserva - Prontas para Remanejamento</h2>
                  </div>
                  
                  {/* Busca */}
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <SearchIcon className="h-4 w-4 text-green-400" />
                    </div>
                    <input
                      type="text"
                      placeholder="Pesquisar bike pelo número..."
                      value={mechanicSearchTerm}
                      onChange={(e) => setMechanicSearchTerm(e.target.value)}
                      className="block w-full pl-10 pr-3 py-2 border border-green-200 rounded-xl leading-5 bg-white placeholder-green-300 focus:outline-none focus:ring-1 focus:ring-green-500 focus:border-green-500 sm:text-xs text-sm font-bold shadow-sm"
                    />
                    {mechanicSearchTerm && (
                      <button 
                        onClick={() => setMechanicSearchTerm('')}
                        className="absolute inset-y-0 right-0 pr-3 flex items-center text-green-400 hover:text-green-600"
                      >
                        <XIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                {(() => {
                  const filteredList = mechanicsList.filter(b => 
                    b.status === 'Reserva' &&
                    (!mechanicSearchTerm || String(b.patrimonio || '').includes(mechanicSearchTerm))
                  );

                  if (filteredList.length === 0) return <p className="text-sm text-gray-500 italic">Nenhuma bike.</p>;

                  const grouped = filteredList.reduce((acc, bike) => {
                    const key = bike.carretinha || 'Sem Carretinha';
                    if (!acc[key]) acc[key] = [];
                    acc[key].push(bike);
                    return acc;
                  }, {} as Record<string, any[]>);

                  // Carretinhas em montagem (sem status ou sem nome)
                  const activeEntries = Object.entries(grouped).filter(([t, b]) =>
                    t === 'Sem Carretinha' || !b[0]?.trailerStatus
                  );
                  // Carretinhas enviadas — finalized, approved ou assigned — aguardando aceite
                  const sentEntries = Object.entries(grouped).filter(([t, b]) =>
                    t !== 'Sem Carretinha' && (['finalized', 'approved', 'assigned'].includes(b[0]?.trailerStatus))
                  );

                  return (
                    <div className="space-y-3">
                      {/* Carretinhas ativas — edição completa */}
                      {activeEntries.map(([trailer, bikes]) => {
                        const isFull = trailer !== 'Sem Carretinha' && (bikes as any[]).length >= 14;
                        return (
                          <div key={trailer} className={`border rounded-xl p-3 shadow-sm transition-all duration-300 ${isFull ? 'border-orange-300 bg-orange-50/20' : 'border-green-200 bg-white'}`}>
                            <div className="flex justify-between items-center mb-2 border-b pb-1.5">
                              <h3 className="font-bold text-green-700 flex items-center gap-2 text-sm">
                                <TrailerIcon className={`w-4 h-4 ${isFull ? 'text-orange-500 animate-pulse' : 'text-green-600'}`}/>
                                {trailer}
                                {isFull && (
                                  <span className="ml-1 text-[9px] bg-orange-500 text-white px-1.5 py-0.5 rounded-full font-black animate-pulse">
                                    🔒 FECHADA (14/14)
                                  </span>
                                )}
                              </h3>
                              {trailer !== 'Sem Carretinha' && (
                                <button onClick={() => handleFinalizeTrailer(trailer)}
                                  className={`text-[10px] px-2.5 py-1 rounded font-bold transition-all ${isFull ? 'bg-orange-500 hover:bg-orange-600 text-white shadow-md shadow-orange-100 animate-bounce' : 'bg-green-600 hover:bg-green-700 text-white'}`}>
                                  {isFull ? '⚡ Conferir & Finalizar' : 'Finalizar Carretinha'}
                                </button>
                              )}
                            </div>
                            <div className="space-y-1">
                              {(bikes as any[]).map((bike, i) => (
                                <div key={`tr-${bike.patrimonio}-${i}`} className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 border rounded-lg text-[11px]">
                                  <span className="font-black text-gray-800 font-mono w-10 flex-shrink-0">{bike.patrimonio}</span>
                                  {bike.mecanico && <span className="text-blue-600 font-bold flex-shrink-0 truncate max-w-[80px]">{bike.mecanico}</span>}
                                  <div className="flex-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] min-w-0">
                                    {bike.carregamento === 'Carregando' ? (
                                      <span className="text-green-600 font-bold flex items-center gap-0.5">⚡ Carregando</span>
                                    ) : (
                                      <span className="text-red-500 font-semibold flex items-center gap-0.5">🔌 Não carregando</span>
                                    )}
                                    <span className={`font-bold flex items-center gap-0.5 ${
                                      ['aberta', 'aberto', 'open'].includes(String(bike.trava || '').toLowerCase().trim())
                                        ? 'text-orange-500' 
                                        : 'text-gray-500'
                                    }`}>
                                      🔒 {['aberta', 'aberto', 'open'].includes(String(bike.trava || '').toLowerCase().trim()) ? 'Trava Aberta' : 'Trava Fechada'}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
                                    {bike.bateria !== undefined && (
                                      <span className={`text-[10px] font-bold ${Number(formatBattery(bike.bateria)) < trailerBatteryLimit ? 'text-red-500' : 'text-gray-500'}`}>🔋{formatBattery(bike.bateria)}%</span>
                                    )}
                                    {trailer !== 'Sem Carretinha' ? (
                                      <button onClick={async () => {
                                        const mechanicName = bike.mecanico || driverName;
                                        protectMechanicBike(bike.patrimonio, { status: 'Em Manutenção', mecanico: mechanicName, carretinha: null, trailerStatus: null });
                                        setDoc(doc(db, 'bikes', bike.patrimonio), { carretinha: null, trailerStatus: null, status: 'Mecânica', responsavel: mechanicName, ultimaAtualizacao: serverTimestamp() }, { merge: true }).catch(() => {});
                                        try {
                                          await setDoc(doc(db, 'mechanics_flow', bike.patrimonio), {
                                            status: 'Em Manutenção',
                                            carretinha: null,
                                            dataEntrada: serverTimestamp()
                                          }, { merge: true });
                                        } catch (e) {
                                          console.warn('[Firebase] removeFromTrailer failed:', e);
                                        }
                                      }} className="p-0.5 bg-red-100 text-red-500 rounded hover:bg-red-200 active:scale-95">
                                        <XIcon className="w-3 h-3"/>
                                      </button>
                                    ) : (
                                      <button onClick={async () => {
                                        const mechanicName = bike.mecanico || driverName;
                                        protectMechanicBike(bike.patrimonio, { status: 'Em Manutenção', mecanico: mechanicName, carretinha: null, trailerStatus: null });
                                        
                                        try {
                                          await setDoc(doc(db, 'mechanics_flow', bike.patrimonio), {
                                            status: 'Em Manutenção',
                                            carretinha: null,
                                            dataEntrada: serverTimestamp()
                                          }, { merge: true });
                                        } catch (e) {
                                          console.warn('[Firebase] deleteMechanicsBike (move to maintenance) failed:', e);
                                        }

                                        setDoc(doc(db, 'bikes', bike.patrimonio), { carretinha: null, trailerStatus: null, status: 'Mecânica', responsavel: mechanicName, ultimaAtualizacao: serverTimestamp() }, { merge: true }).catch(() => {});
                                      }} className="p-0.5 bg-orange-100 text-orange-600 rounded hover:bg-orange-200 active:scale-95" title="Voltar para Manutenção">
                                        <XIcon className="w-3 h-3"/>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                            {trailer === 'Sem Carretinha' && (
                              <div className="mt-3 space-y-2">
                                {/* Se houver uma carretinha ativa (não finalizada e não cheia), permite adicionar a ela */}
                                {activeEntries.filter(([t, b]) => t !== 'Sem Carretinha' && b.length < 14).map(([activeTrailer]) => (
                                  <button
                                    key={`add-to-${activeTrailer}`}
                                    onClick={() => handleOrganizeTrailer((bikes as any[]).map(b => b.patrimonio), activeTrailer)}
                                    className="w-full py-1.5 bg-green-600 text-white text-[10px] font-bold rounded hover:bg-green-700 active:scale-95 transition-all"
                                  >
                                    Adicionar à {activeTrailer}
                                  </button>
                                ))}

                                <button onClick={async () => {
                                  setIsLoading(true);
                                  try {
                                    const r = await apiCall({ action: 'getNextTrailerNumber' });
                                    const next = r.success ? r.next : 1;
                                    handleOrganizeTrailer((bikes as any[]).map(b => b.patrimonio), `Carretinha ${next}`);
                                  } catch (err: any) {
                                    console.error('Erro ao calcular sequência de carretinha:', err);
                                    const todayStr = localDateStr();
                                    const lastDate = localStorage.getItem('trailer_seq_date');
                                    let lastUsed = 0;
                                    if (lastDate === todayStr) {
                                      lastUsed = parseInt(localStorage.getItem('trailer_seq_last') || '0');
                                    } else {
                                      localStorage.setItem('trailer_seq_date', todayStr);
                                    }
                                    const nextLocal = (lastUsed % 5) + 1;
                                    localStorage.setItem('trailer_seq_last', nextLocal.toString());
                                    handleOrganizeTrailer((bikes as any[]).map(b => b.patrimonio), `Carretinha ${nextLocal}`);
                                  } finally {
                                    setIsLoading(false);
                                  }
                                }}
                                  className="w-full py-1.5 bg-blue-600 text-white text-[10px] font-bold rounded hover:bg-blue-700 active:scale-95 transition-all">
                                  Criar Nova Carretinha
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* ── Carretinhas enviadas — resumo até aceite do motorista ── */}
                      {sentEntries.length > 0 && (
                        <div className="border border-dashed border-gray-300 rounded-xl p-3 bg-gray-50">
                          <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-2">
                            Aguardando Aceite do Motorista
                          </p>
                          <div className="space-y-2">
                            {sentEntries.map(([trailer, bikes]) => {
                              const isAssigned = bikes[0]?.trailerStatus === 'assigned';
                              const assignedTo = bikes[0]?.responsavel || bikes[0]?.assignedTo || null;
                              return (
                                <div key={trailer} className={`rounded-lg border p-2.5 ${isAssigned ? 'bg-blue-50 border-blue-200' : 'bg-orange-50 border-orange-200'}`}>
                                  <div className="flex items-center justify-between mb-1.5">
                                    <div className="flex items-center gap-2">
                                      <TrailerIcon className={`w-3.5 h-3.5 ${isAssigned ? 'text-blue-500' : 'text-orange-500'}`}/>
                                      <span className="font-black text-sm text-gray-700">{trailer}</span>
                                      <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase ${isAssigned ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                                        {isAssigned ? `Enviada → ${assignedTo || '?'}` : 'Aguard. ADM'}
                                      </span>
                                      {isAdm && !isAssigned && (
                                        <button
                                          onClick={() => {
                                            setSelectedActionForAssignment({
                                              id: 'manual_assign_' + trailer,
                                              type: 'trailer_validation',
                                              trailerName: trailer,
                                              bikes: (bikes as any[]).map(b => b.patrimonio),
                                              mechanicName: (bikes as any[])[0]?.mecanico || 'Mecânica'
                                            });
                                            setIsDriverSelectionModalOpen(true);
                                          }}
                                          className="p-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors ml-1"
                                          title="Atribuir Motorista"
                                        >
                                          <TrailerIcon className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                    <span className="text-[9px] text-gray-400 font-bold">{bikes.length} bike{bikes.length > 1 ? 's' : ''}</span>
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {(bikes as any[]).map(b => (
                                      <span key={b.patrimonio} className="font-mono text-[10px] font-bold px-1.5 py-0.5 bg-white border rounded text-gray-600">{b.patrimonio}</span>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* ── Histórico de Carretinhas Liberadas (Hoje) ── */}
                      {trailersHistory.length > 0 && (
                        <div className="mt-6 border-t pt-4">
                          <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                            <HistoryIcon className="w-3 h-3" />
                            Histórico de Carretinhas Liberadas (Hoje)
                          </p>
                          <div className="grid grid-cols-1 gap-2">
                            {trailersHistory.map((h) => (
                              <div key={h.id} className="flex items-center justify-between p-2 bg-gray-50 border border-gray-200 rounded-lg">
                                <div className="flex flex-col">
                                  <span className="text-xs font-bold text-gray-700">{h.trailerName}</span>
                                  <span className="text-[9px] text-gray-400 font-medium">
                                    {h.timestamp?.toDate ? h.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''} • {h.finalizedBy}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[10px] font-black text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-100">
                                    {h.bikeCount} bikes
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* ÍCONES DE ATALHO TÉCNICA */}
        {isTecnica && (
          <div className="grid grid-cols-3 gap-2 mb-6 mt-6">
            <button
              onClick={() => setActiveTechnicaCategory(activeTechnicaCategory === 'Aguardando' ? null : 'Aguardando')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeTechnicaCategory === 'Aguardando' ? 'bg-blue-600 border-blue-700 text-white' : 'bg-blue-50 border-blue-100 hover:bg-blue-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeTechnicaCategory === 'Aguardando' ? 'bg-white text-blue-600' : 'bg-blue-600 text-white'}`}>
                <CarIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeTechnicaCategory === 'Aguardando' ? 'text-white' : 'text-blue-800'}`}>Aguardando técnica</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeTechnicaCategory === 'Aguardando' ? 'text-white' : 'text-blue-600'}`}>
                {technicaList.filter(b => b.status === 'Aguardando Técnica').length}
              </span>
            </button>
            <button
              onClick={() => setActiveTechnicaCategory(activeTechnicaCategory === 'EmTecnica' ? null : 'EmTecnica')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeTechnicaCategory === 'EmTecnica' ? 'bg-orange-600 border-orange-700 text-white' : 'bg-orange-50 border-orange-100 hover:bg-orange-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeTechnicaCategory === 'EmTecnica' ? 'bg-white text-orange-600' : 'bg-orange-600 text-white'}`}>
                <BicycleIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeTechnicaCategory === 'EmTecnica' ? 'text-white' : 'text-orange-800'}`}>Em técnica</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeTechnicaCategory === 'EmTecnica' ? 'text-white' : 'text-orange-600'}`}>
                {technicaList.filter(b => b.status === 'Em Técnica').length}
              </span>
            </button>
            {/* Histórico Técnica */}
            <button
              onClick={() => { setIsTechnicaHistoryOpen(true); fetchTechnicaHistory(); }}
              className="flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 bg-gray-50 border-gray-200 hover:bg-gray-100"
            >
              <div className="p-1.5 rounded-full mb-1 bg-gray-700 text-white">
                <CalendarIcon className="w-4 h-4" />
              </div>
              <span className="text-[8px] font-bold text-center leading-tight h-5 flex items-center text-gray-800">Histórico</span>
              <span className="mt-0.5 text-[10px] font-black text-gray-500">—</span>
            </button>
          </div>
        )}

        {/* PERFIL TÉCNICA */}
        {isTecnica && activeTechnicaCategory && (
          <div className="mt-6 space-y-6">

            {/* Aguardando Técnica */}
            {activeTechnicaCategory === 'Aguardando' && (
              <div id="tec-aguardando" className="p-4 border rounded-lg bg-blue-50 shadow-sm scroll-mt-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-bold text-blue-800 flex items-center gap-2">
                    <CarIcon className="w-5 h-5"/>Aguardando Técnica
                  </h2>
                  <span className="text-xs font-bold text-blue-600 bg-blue-100 px-2 py-0.5 rounded-full">
                    {technicaList.filter(b => b.status === 'Aguardando Técnica').length}
                  </span>
                </div>
                {isTechnicaLoading && technicaList.length === 0
                  ? <p className="text-sm text-gray-400 italic">Carregando...</p>
                  : technicaList.filter(b => b.status === 'Aguardando Técnica').length > 0 ? (
                    <div className="space-y-2">
                      {technicaList
                        .filter(b => b.status === 'Aguardando Técnica')
                        .sort((a, b) => String(a.patrimonio).localeCompare(String(b.patrimonio), undefined, { numeric: true }))
                        .map((bike, i) => (
                        <div key={`tec-agu-${bike.patrimonio}-${i}`} className="flex justify-between items-center p-3 bg-white border rounded-md shadow-sm">
                          <div>
                            <p className="font-bold text-gray-700">Bike: {bike.patrimonio}</p>
                            {bike.bateria !== undefined && <p className="text-[10px] text-gray-500">Bateria: {bike.bateria}%</p>}
                            {bike.mecanico && <p className="text-[10px] text-blue-600 font-semibold">Enviado por: {bike.mecanico}</p>}
                            {bike.dataEntrada && <p className="text-[10px] text-gray-400">{new Date(bike.dataEntrada).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</p>}
                          </div>
                          <button
                            onClick={() => handleConfirmTechnicaReceipt(bike)}
                            disabled={isLoading}
                            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700 active:scale-95 disabled:bg-gray-400 transition-colors"
                          >
                            Confirmar Recebimento
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-sm text-gray-500 italic">Nenhuma bike aguardando.</p>}
              </div>
            )}

            {/* Em Técnica */}
            {activeTechnicaCategory === 'EmTecnica' && (
              <div id="tec-em-tecnica" className="p-4 border rounded-lg bg-orange-50 shadow-sm scroll-mt-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-bold text-orange-800 flex items-center gap-2">
                    <BicycleIcon className="w-5 h-5"/>Em Técnica
                  </h2>
                  <span className="text-xs font-bold text-orange-600 bg-orange-100 px-2 py-0.5 rounded-full">
                    {technicaList.filter(b => b.status === 'Em Técnica').length}
                  </span>
                </div>
                {technicaList.filter(b => b.status === 'Em Técnica').length > 0 ? (
                  <div className="space-y-2">
                    {technicaList
                      .filter(b => b.status === 'Em Técnica')
                      .sort((a, b) => String(a.patrimonio).localeCompare(String(b.patrimonio), undefined, { numeric: true }))
                      .map((bike, i) => (
                      <div key={`tec-em-${bike.patrimonio}-${i}`} className="flex justify-between items-center p-3 bg-white border rounded-md shadow-sm">
                        <div>
                          <p className="font-bold text-gray-700">Bike: {bike.patrimonio}</p>
                          {bike.bateria !== undefined && <p className="text-[10px] text-gray-500">Bateria: {bike.bateria}%</p>}
                          {bike.tecnico && <p className="text-[10px] text-orange-600 font-semibold">Técnico: {bike.tecnico}</p>}
                          {bike.mecanico && bike.mecanico !== driverName && <p className="text-[10px] text-blue-600 font-medium">Mecânico Orig.: {bike.mecanico}</p>}
                          {bike.dataEntrada && <p className="text-[10px] text-gray-400">{new Date(bike.dataEntrada).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</p>}
                          {bike.tratativa && bike.tratativa !== 'MANUAL' && <p className="text-[10px] text-gray-500 italic">Obs: {bike.tratativa}</p>}
                        </div>
                        <div className="flex flex-col gap-2 shrink-0">
                          <button
                            onClick={() => handleFinalizeTechnicaRepair(bike)}
                            disabled={isLoading}
                            className="px-3 py-1.5 bg-orange-600 text-white text-xs font-bold rounded hover:bg-orange-700 active:scale-95 disabled:bg-gray-400 transition-colors w-full text-center"
                          >
                            Finalizar Reparo
                          </button>
                          <button
                            onClick={() => handleOpenLockerVandalizedModal(bike)}
                            disabled={isLoading}
                            className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded active:scale-95 disabled:bg-gray-400 transition-colors w-full text-center"
                          >
                            Locker Vandalizado
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-gray-500 italic">Nenhuma bike em técnica.</p>}
              </div>
            )}

          </div>
        )}


        {isAdm && (
          <div className="mt-6 overflow-hidden">
            <div className="flex gap-2 mb-2 px-1">
              {[
                { key: 'summary', icon: <SteeringWheelIcon className="w-5 h-5"/>, color: 'blue', title: 'Resumo' },
                { key: 'alerts', icon: <SirenIcon className="w-5 h-5"/>, color: 'red', title: 'Alertas' },
                { key: 'vandalized', icon: <AlertTriangleIcon className="w-5 h-5"/>, color: 'orange', title: 'Vandalizadas' },
                { key: 'status', icon: (
                  <div className="relative">
                    <PlusPlusIcon className="w-5 h-5"/>
                    {pendingActions.length > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 bg-red-600 text-white text-[8px] font-black px-1 rounded-full border border-white">
                        {pendingActions.length}
                      </span>
                    )}
                  </div>
                ), color: 'blue', title: 'Validação Mecânica' },
                { key: 'mechanics', icon: (
                  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                  </svg>
                ), color: 'orange', title: 'Mecânica' },
                { key: 'technica', icon: <ZapIcon className="w-5 h-5"/>, color: 'blue', title: 'Técnica' },
                { key: 'bike_search', icon: <SearchIcon className="w-5 h-5"/>, color: 'purple', title: 'Busca de Bike' },
                { key: 'boletim', icon: <SheetIcon className="w-5 h-5"/>, color: 'blue', title: 'Boletim' },
              ].map(({ key, icon, color, title }) => (
                <button key={key} onClick={() => setActiveQuadrant(key as any)}
                  title={title}
                  className={`p-2 rounded-full transition-all ${activeQuadrant === key ? `${QUADRANT_COLORS[color] || 'bg-gray-600'} text-white shadow-md` : 'bg-gray-200 text-gray-500 hover:bg-gray-300'}`}>
                  {icon}
                </button>
              ))}
            </div>

            <div className="relative w-full overflow-hidden rounded-lg border bg-gray-50 shadow-inner min-h-[400px]">
              <div className="flex transition-transform duration-500 ease-in-out"
                style={{ transform: `translateX(${
                  activeQuadrant === 'summary' ? '0%' : 
                  activeQuadrant === 'alerts' ? '-100%' : 
                  activeQuadrant === 'vandalized' ? '-200%' : 
                  activeQuadrant === 'status' ? '-300%' : 
                  activeQuadrant === 'mechanics' ? '-400%' : 
                  activeQuadrant === 'technica' ? '-500%' :
                  activeQuadrant === 'bike_search' ? '-600%' : 
                  '-700%'
                })` }}>

                {/* Quadrante 1: Resumo */}
                <div className="w-full flex-shrink-0 p-3">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-base font-bold text-gray-700 flex items-center gap-2">
                      <SheetIcon className={`w-4 h-4 ${isSummaryLoading ? 'animate-pulse text-blue-400' : 'text-blue-600'}`}/>
                      Analítico
                      {backendVersion && <span className="text-[9px] text-gray-400 font-mono ml-2">v{backendVersion}</span>}
                    </h2>
                    <div className="flex bg-white border rounded-md p-0.5 shadow-sm">
                      {(['-1','-7','day','week','month'] as const).map((r, i) => (
                        <button key={`period-adm-${r}-${i}`} onClick={() => setSummaryTimeRange(r)}
                          className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded ${summaryTimeRange === r ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
                          {r === '-1' ? '-1' : r === '-7' ? '-7' : r === 'day' ? 'Dia' : r === 'week' ? 'Sem' : 'Mês'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Seletor de data da Linha do Tempo */}
                  <div className="flex items-center gap-2 mb-3 p-2 bg-white border rounded-lg shadow-sm">
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-purple-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    <span className="text-[9px] font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">Linha do Tempo</span>
                    <input
                      type="date"
                      value={timelineDate}
                      max={localDateStr()}
                      onChange={e => {
                        setTimelineDate(e.target.value);
                        setFirebaseTimelineEvents({});
                      }}
                      className="flex-1 text-[10px] font-mono text-purple-700 border-0 bg-transparent focus:outline-none cursor-pointer"
                    />
                    {timelineDate !== localDateStr() && (
                      <button onClick={() => { setTimelineDate(localDateStr()); setFirebaseTimelineEvents({}); }}
                        className="text-[9px] text-purple-500 font-bold hover:text-purple-700 whitespace-nowrap">
                        Hoje
                      </button>
                    )}
                  </div>
                  {driversSummary.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3">
                      {driversSummary.map((driver, i) => (
                        <div key={`driver-card-${driver.name}-${i}`} className="bg-white p-3 rounded-lg border shadow-sm">
                          <div className="flex justify-between items-center mb-2 border-b pb-1">
                            <h3 className="font-black text-gray-900 text-sm uppercase">{driver.name}</h3>
                            <button onClick={() => { setEditingDriver(driver); setIsEditDriverModalOpen(true); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-full">
                              <SearchIcon className="w-4 h-4"/>
                            </button>
                          </div>

                          {/* Linha do tempo de atividade */}
                          {(() => {
                            const sheetsEvents = ((driver.timeline || []) as any[]).map(e => ({
                              ...e,
                              type: e.type === 'filial' ? 'recolhida' : e.type
                            }));
                            // fbEvents: 'em_posse' e 'removida_por_adm' — eventos exclusivos Firebase
                            // Estação/Recolhida/Não encontrada vêm do Sheets com isOccurrence correto via occLookup
                            const getFbEventsForDriverName = (nm: string) => {
                              const lowNm = normalizeName(nm);
                              const key = Object.keys(firebaseTimelineEvents).find(k => normalizeName(k) === lowNm);
                              return key ? firebaseTimelineEvents[key] : [];
                            };
                            const fbEvents = (getFbEventsForDriverName(driver.name))
                              .filter((e: any) => e.type === 'em_posse' || e.type === 'removida_por_adm')
                              .map((e: any) => ({
                                tsMs: e.tsMs, hour: new Date(e.tsMs).getHours(),
                                min: new Date(e.tsMs).getMinutes(),
                                type: e.type,
                                bikeNumber: e.bikeNumber,
                                observacao: e.observacao || '',
                                isOccurrence: !!e.isOccurrence
                              }));
                            const merged = [...sheetsEvents];
                            fbEvents.forEach((fe: any) => {
                              // Dedup por bike + janela de 2min
                              const isDup = sheetsEvents.some((se: any) => se.bikeNumber === fe.bikeNumber && Math.abs(se.tsMs - fe.tsMs) < 2 * 60 * 1000);
                              if (!isDup) merged.push(fe);
                            });
                            const events = merged.sort((a, b) => a.tsMs - b.tsMs);

                            const window = driver.timelineWindow as {startMs: number, endMs: number} | null;
                            let startMs = window?.startMs;
                            let endMs   = window?.endMs;
                            if (fbEvents.length > 0) {
                              const fbMin = Math.min(...fbEvents.map(e => e.tsMs));
                              const fbMax = Math.max(...fbEvents.map(e => e.tsMs));
                              startMs = startMs ? Math.min(startMs, fbMin) : fbMin;
                              endMs   = endMs   ? Math.max(endMs,   fbMax) : fbMax;
                            }
                            if (!startMs || !endMs) {
                              // Sem dados ainda — mostra linha vazia
                              return (
                                <div className="mb-3">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <p className="text-[8px] font-black text-gray-400 uppercase tracking-wider">Linha do Tempo</p>
                                  </div>
                                  <div className="relative h-5 mx-1">
                                    <div className="absolute top-2 left-0 right-0 h-px bg-gray-200"/>
                                    <span className="absolute top-3.5 left-1/2 -translate-x-1/2 text-[7px] text-gray-300 italic">sem registros no período</span>
                                  </div>
                                </div>
                              );
                            }

                            const totalMs = endMs - startMs || 1;
                            const toPos = (tsMs: number) => Math.max(0, Math.min(100, (tsMs - startMs!) / totalMs * 100));
                            const fmtTime = (ms: number) => {
                              const d = new Date(ms);
                              return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                            };

                            // Agrupa eventos próximos (mesmo tipo, ±3 minutos) em clusters
                            const CLUSTER_MS = 3 * 60 * 1000;
                            const clusters: Array<{type: string, tsMs: number, bikes: string[], count: number, observacoes: string[], isOccurrence: boolean}> = [];
                            events.forEach(ev => {
                              const last = clusters[clusters.length - 1];
                              if (last && last.type === ev.type && Math.abs(ev.tsMs - last.tsMs) < CLUSTER_MS) {
                                last.count++;
                                if (ev.bikeNumber && !last.bikes.includes(ev.bikeNumber)) last.bikes.push(ev.bikeNumber);
                                if (ev.observacao && !last.observacoes.includes(ev.observacao)) last.observacoes.push(ev.observacao);
                                if (!!(ev as any).isOccurrence && (ev.type === 'em_posse' || ev.type === 'nao_encontrada')) last.isOccurrence = true;
                                last.tsMs = Math.round((last.tsMs * (last.count - 1) + ev.tsMs) / last.count);
                              } else {
                                clusters.push({
                                  type: ev.type,
                                  tsMs: ev.tsMs,
                                  bikes: ev.bikeNumber ? [ev.bikeNumber] : [],
                                  observacoes: ev.observacao ? [ev.observacao] : [],
                                  count: 1,
                                  isOccurrence: !!(ev as any).isOccurrence && (ev.type === 'em_posse' || ev.type === 'nao_encontrada')
                                });
                              }
                            });

                            const dotConfig: Record<string, {bg: string, label: string}> = {
                              em_posse:      { bg: 'bg-green-500',   label: 'Em Posse' },
                              recolhida:     { bg: 'bg-green-700',   label: 'Recolhida (Filial)' },
                              estacao:       { bg: 'bg-indigo-500',  label: 'Estação' },
                              nao_atendida:  { bg: 'bg-yellow-500',  label: 'Não atend.' },
                              nao_encontrada:{ bg: 'bg-red-500',     label: 'Não enc.' },
                              carretinha:    { bg: 'bg-purple-600',  label: 'Carretinha' },
                              removida_por_adm: { bg: 'bg-black',    label: 'Removida por ADM' },
                            };

                            return (
                              <div className="mb-3">
                                <div className="flex items-center justify-between mb-1.5">
                                  <p className="text-[8px] font-black text-gray-400 uppercase tracking-wider">Linha do Tempo</p>
                                  <button
                                    onClick={() => setTimelineModal({ driver: driver.name, events, clusters, startMs: startMs!, endMs: endMs! })}
                                    className="text-[8px] text-blue-500 font-bold hover:underline"
                                  >⤢ Expandir</button>
                                </div>
                                <div className="relative h-8 mx-1">
                                  <div className="absolute top-4 left-0 right-0 h-px bg-gray-900"/>
                                  <span className="absolute top-5.5 left-0 text-[7px] text-gray-400 font-mono">{fmtTime(startMs!)}</span>
                                  <span className="absolute top-5.5 right-0 text-[7px] text-gray-400 font-mono">{fmtTime(endMs!)}</span>
                                  {clusters.map((cl, ci) => {
                                    const pos = toPos(cl.tsMs);
                                    const cfg = dotConfig[cl.type] || { bg: 'bg-gray-400', label: cl.type };
                                    const isMulti = cl.count > 1;
                                    return (
                                      <div key={ci} className="absolute -translate-x-1/2 top-2.5 flex flex-col items-center"
                                        style={{left: `${pos}%`}}
                                        title={`${cl.isOccurrence ? '[OCORRÊNCIA] ' : ''}${(cl.type === 'carretinha' || cl.type === 'removida_por_adm') && cl.observacoes?.[0] ? cl.observacoes[0] : cfg.label}${cl.type === 'em_posse' && cl.bikes.length > 0 ? ` Bike ${cl.bikes.join(', ')}` : isMulti ? ` (${cl.count} bikes)` : ''} — ${fmtTime(cl.tsMs)}`}
                                      >
                                        {cl.isOccurrence && (
                                          <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 flex flex-col items-center animate-pulse">
                                            <span className={`text-[12px] drop-shadow-sm ${cl.type === 'nao_encontrada' ? 'text-red-600' : 'text-yellow-500'}`}>★</span>
                                          </div>
                                        )}
                                        <div className={`rounded-full border-2 shadow-sm flex items-center justify-center ${isMulti ? 'w-4 h-4' : 'w-2.5 h-2.5'} ${cfg.bg} ${cl.isOccurrence ? (cl.type === 'nao_encontrada' ? 'border-red-500 ring-2 ring-red-400/50' : 'border-yellow-400 ring-2 ring-yellow-400/50') : 'border-white'}`}>
                                          {isMulti && !cl.isOccurrence && (
                                            <span className="text-[7px] font-black text-white leading-none">{cl.count}</span>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                                <div className="flex flex-wrap gap-2 mt-4">
                                  {Object.entries(dotConfig).map(([k, v]) => (
                                    <div key={k} className="flex items-center gap-0.5">
                                      <div className={`w-1.5 h-1.5 rounded-full ${v.bg}`}/>
                                      <span className="text-[7px] text-gray-400">{v.label}</span>
                                    </div>
                                  ))}
                                  <div className="flex items-center gap-1 ml-auto">
                                    <div className="flex items-center gap-0.5">
                                      <span className="text-[10px] text-yellow-500">★</span>
                                      <span className="text-[7px] text-gray-400">Ocorrência Recolhida</span>
                                    </div>
                                    <div className="flex items-center gap-0.5">
                                      <span className="text-[10px] text-red-600">★</span>
                                      <span className="text-[7px] text-gray-400">Ocorrência Não Encontrada</span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })()}
                          <div className="grid grid-cols-5 gap-2 mb-3">
                            {(() => {
                              const recolhidas = driver.stats?.recolhidas || 0;
                              const remanejada = driver.stats?.remanejada || 0;
                              const naoEncontrada = driver.stats?.naoEncontrada || 0;
                              const total = recolhidas + remanejada;

                              return [
                                { l: 'Notif.', v: driver.pendingRequests, c: 'blue' },
                                { l: 'Recolh.', v: recolhidas, c: 'green' },
                                { l: 'Remanej.', v: remanejada, c: 'indigo' },
                                { l: 'Não Enc.', v: naoEncontrada, c: 'red' },
                                { l: 'Total', v: total, c: 'orange' },
                              ].map((item, i) => {
                                const styles = STATUS_COLORS[item.c] || STATUS_COLORS.blue;
                                return (
                                  <div key={`adm-stat-${item.l}-${i}`} className={`${styles.bg} p-2 rounded-xl border ${styles.border} text-center shadow-sm hover:scale-105 transition-all duration-200`}>
                                    <p className={`text-[8px] ${styles.textLabel} uppercase tracking-wider mb-0.5`}>{item.l}</p>
                                    <p className={`text-base font-black ${styles.textVal} leading-none`}>{item.v}</p>
                                  </div>
                                );
                              });
                            })()}
                          </div>
                          <div className="mb-2">
                            <p className="text-[9px] font-black text-gray-500 uppercase mb-1">Bikes em Posse ({driver.realTime?.collected?.length || 0})</p>
                            {driver.realTime?.collected && driver.realTime.collected.length > 0
                              ? <div className="flex flex-wrap gap-1">{driver.realTime.collected.map((b: string) => <span key={b} className="px-1.5 py-0.5 bg-gray-50 text-gray-700 rounded text-[10px] font-mono border border-gray-200">{b}</span>)}</div>
                              : <p className="text-[9px] text-gray-400 italic">Nenhuma bike recolhida</p>}
                          </div>
                          <div>
                            <p className="text-[9px] font-black text-gray-500 uppercase mb-1">Roteiro Atual ({driver.realTime?.route?.length || 0})</p>
                            {driver.realTime?.route && driver.realTime.route.length > 0
                              ? <div className="flex flex-wrap gap-1">{driver.realTime.route.map((b: string) => <span key={b} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px] font-mono border border-blue-100">{b}</span>)}</div>
                              : <p className="text-[9px] text-gray-400 italic">Roteiro vazio</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-center py-6 bg-white rounded-lg border border-dashed"><p className="text-gray-400 text-xs">{isSummaryLoading ? 'Carregando...' : 'Nenhum motorista disponível'}</p></div>}
                </div>

                {/* Quadrante 2: Alertas */}
                <div className="w-full flex-shrink-0 p-1.5 sm:p-3">
                  <h2 className="text-base font-bold text-gray-700 flex items-center gap-2 mb-4">
                    <AlertIcon className="w-4 h-4 text-red-600"/>
                    Bikes em Alerta
                    <button 
                      onClick={(e) => { e.stopPropagation(); fetchAlerts(true); }}
                      disabled={isAlertsLoading}
                      className="p-1 hover:bg-gray-100 rounded-full transition-colors disabled:opacity-50"
                      title="Atualizar Alertas"
                    >
                      <svg viewBox="0 0 24 24" className={`w-3 h-3 ${isAlertsLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24L21 8"/>
                        <path d="M21 3v5h-5"/>
                      </svg>
                    </button>
                  </h2>
                  <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead><tr className="bg-gray-100 border-b">
                        {['Patrim.','Check 1','Check 2','Check 3','Ação'].map((h, idx) => (
                          <th key={h} className={`p-1 text-[9px] font-black text-gray-600 uppercase text-center ${idx === 0 ? 'text-left w-[1%]' : ''}`}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {alerts.length > 0 ? alerts.map((alert, i) => (
                          <tr key={`alert-${alert.id}-${i}`} className="border-b hover:bg-gray-50">
                            <td className="p-1 font-mono text-[10px] font-bold text-gray-700 whitespace-nowrap w-[1%]">{alert.patrimonio || alert.id}</td>
                            {['check1','check2','check3'].map(c => {
                              const val = alert[c];
                              let displayVal = '-';
                              if (val) {
                                try {
                                  const d = new Date(val);
                                  if (!isNaN(d.getTime())) {
                                    const day = String(d.getDate()).padStart(2, '0');
                                    const month = String(d.getMonth() + 1).padStart(2, '0');
                                    const hours = String(d.getHours()).padStart(2, '0');
                                    const minutes = String(d.getMinutes()).padStart(2, '0');
                                    displayVal = `${day}/${month} ${hours}:${minutes}`;
                                  } else {
                                    displayVal = val.toString();
                                  }
                                } catch {
                                  displayVal = val.toString();
                                }
                              }
                              return (
                                <td key={c} className="p-1 text-center text-[9px] text-gray-600 whitespace-nowrap">
                                  {displayVal}
                                </td>
                              );
                            })}
                            <td className="p-1 text-center">
                              <div className="flex items-center justify-center gap-1.5">
                                {alert.situacao === 'Localizada'
                                  ? <button onClick={() => handleConfirmFound(alert.id)} disabled={isLoading} className="px-1 py-0.5 bg-green-600 text-white text-[8px] font-bold rounded hover:bg-green-700 disabled:bg-gray-400 leading-none">{isLoading ? '...' : 'Confirmar'}</button>
                                  : (alert.check1 && alert.check2 && alert.check3)
                                    ? <span className="text-[9px] text-red-600 font-black uppercase">Boletim</span>
                                    : (
                                      <button 
                                        onClick={() => { 
                                          setPrefilledBikeNumber(alert.patrimonio || alert.id); 
                                          setRequestModalOpen(true); 
                                        }} 
                                        className="px-1.5 py-1 bg-blue-600 text-white text-[8px] font-bold rounded hover:bg-blue-700 active:scale-95 transition-transform"
                                      >
                                        Solicitar
                                      </button>
                                    )}
                                <button
                                  onClick={() => {
                                    setRemoveAlertModal({
                                      isOpen: true,
                                      alert: alert,
                                      reason: '',
                                      removerName: driverName || '',
                                    });
                                  }}
                                  className="w-5 h-5 flex items-center justify-center bg-red-50 hover:bg-red-100 text-red-500 hover:text-red-700 rounded-full transition-colors font-bold text-[10px]"
                                  title="Remover do Alerta"
                                >
                                  ✕
                                </button>
                              </div>
                            </td>
                          </tr>
                        )) : (
                          <tr><td colSpan={5} className="p-4 text-center text-gray-400 text-xs italic">{isAlertsLoading ? 'Buscando alertas...' : 'Nenhuma bike em alerta no momento.'}</td></tr>
                        )}
                      </tbody>
                      {alertsVersion && (
                        <tfoot>
                          <tr className="bg-gray-50 border-t">
                            <td colSpan={5} className="p-1 text-[8px] text-gray-400 text-right italic pr-2">
                              Backend: {alertsVersion}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>

                {/* Quadrante 3: Vandalizadas */}
                <div className="w-full flex-shrink-0 p-1.5 sm:p-3">
                  <h2 className="text-base font-bold text-gray-700 flex items-center gap-2 mb-4"><AlertTriangleIcon className="w-4 h-4 text-orange-600"/>Bikes Vandalizadas</h2>
                  <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead><tr className="bg-gray-100 border-b">
                        {['Patrim.','Data','Defeito','Local','Ação'].map(h => (
                          <th key={h} className="p-1 text-[9px] font-black text-gray-600 uppercase">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {vandalizedBikes.length > 0 ? vandalizedBikes.map((v, i) => (
                          <tr key={`vand-${v.id}-${i}`} className="border-b hover:bg-gray-50">
                            <td className="p-1 font-mono text-[10px] font-bold text-gray-700">{v.patrimonio}</td>
                            <td className="p-1 text-[9px] text-gray-600">{new Date(v.data).toLocaleDateString('pt-BR', {day:'2-digit', month:'2-digit'})}</td>
                            <td className="p-1 text-[9px] text-gray-600 truncate max-w-[60px]">{v.defeito}</td>
                            <td className="p-1 text-[9px] text-gray-600 truncate max-w-[60px]">{v.local}</td>
                            <td className="p-1 text-center">
                              <button onClick={() => handleConfirmVandalizedFound(v.id)} disabled={isLoading} className="px-1 py-0.5 bg-orange-600 text-white text-[8px] font-bold rounded hover:bg-orange-700 disabled:bg-gray-400 leading-none">{isLoading ? '...' : 'Encontrada'}</button>
                            </td>
                          </tr>
                        )) : (
                          <tr><td colSpan={5} className="p-4 text-center text-gray-400 text-xs italic">{isVandalizedLoading ? 'Buscando...' : 'Nenhuma bike vandalizada.'}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Quadrante 4: Validação Mecânica (Status & Carretinhas) */}
                <div className="min-w-full p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                    <div className="flex items-center gap-2">
                      <PlusPlusIcon className="w-5 h-5 text-blue-600"/>
                      <h3 className="text-lg font-bold text-gray-800">Validação Mecânica (Status & Carretinhas)</h3>
                    </div>
                    <div className="flex items-center gap-2 bg-white p-1 rounded-lg border shadow-sm">
                      <span className="text-[10px] font-bold text-gray-400 uppercase ml-2">Pendentes:</span>
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-black rounded-full">
                        {(() => {
                          const statusLoteCount = new Set(pendingActions.filter(a => a.type === 'alterar_status_lote').map(a => a.mechanicName || 'MECANICO')).size;
                          const otherCount = pendingActions.filter(a => a.type !== 'alterar_status_lote').length;
                          return statusLoteCount + otherCount;
                        })()}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {isPendingActionsLoading ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                      </div>
                    ) : pendingActions.length > 0 ? (() => {
                      const statusLoteActions = pendingActions.filter(a => a.type === 'alterar_status_lote');
                      const otherActions = pendingActions.filter(a => a.type !== 'alterar_status_lote');
                      
                      const groupedStatusLote: any[] = [];
                      const mechanicMap: { [key: string]: any } = {};

                      statusLoteActions.forEach(action => {
                        const key = action.mechanicName || 'MECANICO';
                        if (!mechanicMap[key]) {
                          mechanicMap[key] = { 
                            ...action, 
                            bikes: [...(action.bikes || [])], 
                            ids: [action.id],
                            isGrouped: true
                          };
                          groupedStatusLote.push(mechanicMap[key]);
                        } else {
                          // Merge bikes uniquely
                          const newBikes = [...action.bikes || []];
                          const existingBikes = new Set(mechanicMap[key].bikes);
                          newBikes.forEach(b => existingBikes.add(b));
                          mechanicMap[key].bikes = Array.from(existingBikes);
                          mechanicMap[key].ids.push(action.id);
                          // Use the latest timestamp for the grouped action
                          if (action.timestamp?.seconds > (mechanicMap[key].timestamp?.seconds || 0)) {
                            mechanicMap[key].timestamp = action.timestamp;
                          }
                        }
                      });

                      const finalActions = [...otherActions, ...groupedStatusLote].sort((a,b) => {
                        const timeA = a.timestamp?.seconds || 0;
                        const timeB = b.timestamp?.seconds || 0;
                        return timeB - timeA;
                      });

                      return finalActions.map((action) => (
                        <div key={action.id} className="bg-white p-4 rounded-xl border shadow-sm hover:shadow-md transition-shadow">
                          <div className="flex justify-between items-start mb-3">
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`px-2 py-0.5 text-[9px] font-black uppercase rounded ${
                                  action.type === 'alterar_status_lote' ? 'bg-purple-100 text-purple-700' :
                                  action.type === 'status_change' ? 'bg-blue-100 text-blue-700' :
                                  'bg-orange-100 text-orange-700'
                                }`}>
                                  {action.type === 'alterar_status_lote' ? 'Alterar Status — Lote' :
                                   action.type === 'status_change' ? 'Alteração de Status' :
                                   'Validação de Carretinha'}
                                </span>
                                <span className="text-[10px] text-gray-400 font-bold">
                                  {action.timestamp?.toDate?.()?.toLocaleString('pt-BR')}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-black text-gray-800 leading-none">
                                  {action.type === 'alterar_status_lote'
                                    ? `${action.bikes?.length || 0} bike(s) — ${action.mechanicName}`
                                    : action.type === 'status_change'
                                    ? `Bike ${action.bikeNumber}`
                                    : `Carretinha: ${action.trailerName}`}
                                </p>
                                {action.activatedBy && (
                                  <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-[8px] font-black uppercase rounded border border-green-200">
                                    Ativado por: {action.activatedBy}
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-gray-500 font-bold uppercase">
                                Solicitado por: <span className="text-blue-600">{action.mechanicName}</span>
                              </p>
                            </div>
                            {action.type !== 'alterar_status_lote' && (
                              <div className="flex gap-2">
                                {action.type === 'trailer_validation' && (
                                  <button
                                    onClick={() => {
                                      setSelectedActionForAssignment(action);
                                      setIsDriverSelectionModalOpen(true);
                                    }}
                                    disabled={isLoading}
                                    className="p-2 bg-blue-50 text-blue-600 rounded-lg border border-blue-100 hover:bg-blue-100 transition-colors"
                                    title="Enviar para Motorista"
                                  >
                                    <TrailerIcon className="w-5 h-5" />
                                  </button>
                                )}
                                <button
                                  onClick={() => handleApproveAction(action)}
                                  disabled={isLoading || (action.type === 'trailer_validation' && !!action.activatedBy)}
                                  className={`p-2 rounded-lg border transition-colors ${
                                    action.type === 'trailer_validation' && action.activatedBy
                                      ? 'bg-green-600 text-white border-green-700 opacity-50 cursor-not-allowed'
                                      : 'bg-green-50 text-green-600 border-green-100 hover:bg-green-100'
                                  }`}
                                  title={action.type === 'trailer_validation' ? 'Ativado' : 'Aprovar'}
                                >
                                  <CheckCircleIcon className="w-5 h-5" />
                                </button>
                                <button
                                  onClick={() => handleRejectAction(action.id)}
                                  disabled={isLoading}
                                  className="p-2 bg-red-50 text-red-600 rounded-lg border border-red-100 hover:bg-red-100 transition-colors"
                                  title="Rejeitar"
                                >
                                  <XIcon className="w-5 h-5" />
                                </button>
                              </div>
                            )}
                          </div>

                          {action.type === 'alterar_status_lote' ? (
                            // Card especial — layout igual ao campo de cópia do mecânico
                            <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                              <p className="text-[10px] font-black text-blue-700 uppercase mb-2 tracking-wide">
                                Bikes para Alterar Status (Copiar):
                              </p>
                              <div className="flex gap-2 mb-2">
                                <input
                                  readOnly
                                  value={(action.bikes || []).join(',')}
                                  onClick={e => (e.target as HTMLInputElement).select()}
                                  className="flex-1 text-xs font-mono p-2 border border-gray-200 rounded bg-white text-gray-800 cursor-text"
                                />
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText((action.bikes || []).join(','));
                                    setSuccessMessage('Lista copiada!');
                                  }}
                                  className="px-4 py-2 bg-blue-600 text-white text-xs font-black rounded hover:bg-blue-700 active:scale-95 transition-all flex-shrink-0"
                                >
                                  Copiar
                                </button>
                                <button
                                  onClick={() => handleApproveAction(action)}
                                  disabled={isLoading}
                                  className="px-4 py-2 bg-green-600 text-white text-xs font-black rounded hover:bg-green-700 active:scale-95 transition-all flex-shrink-0 flex items-center gap-1"
                                >
                                  {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                  Feito!
                                </button>
                              </div>
                              <p className="text-[9px] text-gray-400 italic">
                                Cole a lista no sistema, altere o status das bikes e clique em Feito! para confirmar.
                              </p>
                            </div>
                          ) : action.type === 'status_change' ? (
                            <div className="bg-gray-50 p-2 rounded border border-dashed">
                              <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Status Pretendido:</p>
                              <span className="px-2 py-0.5 bg-blue-600 text-white text-[10px] font-black rounded uppercase">
                                {action.targetStatus}
                              </span>
                              {action.treatment && (
                                <p className="text-[10px] text-gray-500 mt-2 italic">📝 {action.treatment}</p>
                              )}
                            </div>
                          ) : (
                            <div className="bg-gray-50 p-2 rounded border border-dashed">
                              <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Bikes na Carretinha ({action.bikes?.length}):</p>
                              <p className="text-xs font-mono text-gray-600 break-all leading-relaxed">
                                {action.bikes?.join(',')}
                              </p>
                            </div>
                          )}
                        </div>
                      ))
                    })() : (
                      <div className="py-12 text-center bg-gray-50 rounded-xl border border-dashed">
                        <BicycleIcon className="w-12 h-12 text-gray-200 mx-auto mb-3" />
                        <p className="text-sm text-gray-400 font-bold uppercase">Nenhuma ação pendente no momento</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Quadrante 5: Mecânica */}
                <div className="min-w-full p-3">
                  <h2 className="text-base font-bold text-gray-700 flex items-center gap-2 mb-4">
                    <svg viewBox="0 0 24 24" className="w-4 h-4 text-orange-600" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                    Mecânica
                  </h2>

                  {/* Totais no mesmo estilo dos cards de motorista */}
                  <div className="bg-white p-3 rounded-lg border shadow-sm mb-3">
                    <div className="flex justify-between items-center mb-2 border-b pb-1">
                      <h3 className="font-black text-gray-900 text-sm uppercase">Visão Geral</h3>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-3.5">
                      {[
                        { 
                          l: 'Status', 
                          v: mechanicsList.filter(b => b.status === 'Alterar Status').length, 
                          c: 'red' 
                        },
                        { l: 'Aguardando', v: mechanicsList.filter(b => b.status === 'Aguardando Manutenção').length, c: 'blue' },
                        { l: 'Manutenção', v: mechanicsList.filter(b => b.status === 'Em Manutenção').length, c: 'orange' },
                        { l: 'Reserva', v: mechanicsList.filter(b => b.status === 'Reserva').length, c: 'green' },
                      ].map(item => (
                        <div key={item.l} className={`bg-${item.c}-50 p-1.5 rounded border border-${item.c}-100 text-center`}>
                          <p className={`text-[8px] text-${item.c}-600 font-black uppercase leading-tight`}>{item.l}</p>
                          <p className={`text-sm font-black text-${item.c}-800`}>{item.v}</p>
                        </div>
                      ))}
                    </div>

                    {/* Detalhes de Bateria e Carregamento */}
                    {(() => {
                      const activeWorkshopBikes = mechanicsList.filter(b => 
                        b.status === 'Aguardando Manutenção' || 
                        b.status === 'Em Manutenção' || 
                        b.status === 'Alterar Status'
                      );
                      return (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-gray-100">
                          {/* Bateria: 100%, 95%, 90% */}
                          <div>
                            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                              🔋 Nível de Bateria
                            </p>
                            <div className="grid grid-cols-3 gap-1.5">
                              {[
                                { 
                                  pct: '100%', 
                                  v: activeWorkshopBikes.filter(b => formatBattery(b.bateria) === 100).length, 
                                  bg: 'bg-emerald-50/60 border-emerald-100 text-emerald-800' 
                                },
                                { 
                                  pct: '95%', 
                                  v: activeWorkshopBikes.filter(b => formatBattery(b.bateria) === 95).length, 
                                  bg: 'bg-teal-50/60 border-teal-100 text-teal-800' 
                                },
                                { 
                                  pct: '90%', 
                                  v: activeWorkshopBikes.filter(b => formatBattery(b.bateria) === 90).length, 
                                  bg: 'bg-sky-50/60 border-sky-100 text-sky-800' 
                                }
                              ].map(item => (
                                <div key={item.pct} className={`p-1.5 border rounded-lg text-center ${item.bg}`}>
                                  <p className="text-[8px] font-black uppercase leading-tight mb-0.5">{item.pct}</p>
                                  <p className="text-sm font-black">{item.v}</p>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Carregamento: Carregando e Não Carregando */}
                          <div>
                            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                              🔌 Estado de Carregamento
                            </p>
                            <div className="grid grid-cols-2 gap-1.5">
                              {[
                                { 
                                  l: '⚡ Carregando', 
                                  v: activeWorkshopBikes.filter(b => {
                                    const s = String(b.carregamento || '').trim().toUpperCase();
                                    return (s === 'CARREGANDO' || s.includes('CARREGANDO')) && !s.includes('NÃO') && !s.includes('NAO');
                                  }).length,
                                  bg: 'bg-green-50/60 border-green-100 text-green-800' 
                                },
                                { 
                                  l: '🔌 Não Carregando', 
                                  v: activeWorkshopBikes.filter(b => {
                                    const s = String(b.carregamento || '').trim().toUpperCase();
                                    return s === 'NÃO CARREGANDO' || s === 'NAO CARREGANDO' || s.includes('NAO') || s.includes('NÃO');
                                  }).length,
                                  bg: 'bg-rose-50/60 border-rose-100 text-rose-800' 
                                }
                              ].map(item => (
                                <div key={item.l} className={`p-1.5 border rounded-lg text-center ${item.bg}`}>
                                  <p className="text-[8px] font-black uppercase leading-tight mb-0.5">{item.l}</p>
                                  <p className="text-sm font-black">{item.v}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Carretinhas — ativas e aguardando aceite */}
                  {(() => {
                    const trailerGroups: Record<string, any[]> = {};
                    mechanicsList
                      .filter(b => b.carretinha && b.carretinha !== 'Sem Carretinha' && b.status === 'Reserva')
                      .forEach(b => {
                        if (!trailerGroups[b.carretinha]) trailerGroups[b.carretinha] = [];
                        trailerGroups[b.carretinha].push(b);
                      });
                    const allTrailers = Object.entries(trailerGroups);
                    if (allTrailers.length === 0) return null;
                    const activeT = allTrailers.filter(([, b]) => !b[0]?.trailerStatus);
                    const sentT   = allTrailers.filter(([, b]) => b[0]?.trailerStatus === 'finalized' || b[0]?.trailerStatus === 'assigned');
                    return (
                      <div className="bg-white p-3 rounded-lg border shadow-sm mb-3">
                        <div className="flex justify-between items-center mb-2 border-b pb-1">
                          <h3 className="font-black text-gray-900 text-sm uppercase flex items-center gap-2">
                            <TrailerIcon className="w-4 h-4 text-green-600"/>Carretinhas
                          </h3>
                        </div>
                        {/* Ativas — em montagem */}
                        {activeT.map(([trailerName, bikes]) => (
                          <div key={trailerName} className="mb-2 p-2 bg-green-50 rounded-lg border border-green-200">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-black text-green-700">{trailerName}</span>
                              <span className="text-[8px] font-black px-1.5 py-0.5 rounded uppercase bg-green-100 text-green-700">Em Montagem</span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {bikes.map((b: any) => (
                                <span key={b.patrimonio} className="px-1.5 py-0.5 bg-white border border-green-300 text-green-800 text-[9px] font-black rounded font-mono">
                                  {b.patrimonio}
                                </span>
                              ))}
                            </div>
                            <p className="text-[9px] text-gray-400 mt-1">{bikes.length} bike(s)</p>
                          </div>
                        ))}
                        {/* Enviadas — resumo compacto até aceite */}
                        {sentT.length > 0 && (
                          <div className="border border-dashed border-gray-200 rounded-lg p-2 bg-gray-50">
                            <p className="text-[8px] font-black text-gray-400 uppercase mb-1.5">Aguardando Aceite do Motorista</p>
                            <div className="space-y-1.5">
                              {sentT.map(([trailerName, bikes]) => {
                                const isAssigned = bikes[0]?.trailerStatus === 'assigned';
                                const assignedTo = bikes[0]?.responsavel || bikes[0]?.assignedTo || null;
                                return (
                                  <div key={trailerName} className={`flex items-center gap-2 p-1.5 rounded-lg border ${isAssigned ? 'bg-blue-50 border-blue-200' : 'bg-orange-50 border-orange-200'}`}>
                                    <TrailerIcon className={`w-3.5 h-3.5 flex-shrink-0 ${isAssigned ? 'text-blue-500' : 'text-orange-500'}`}/>
                                    <span className="font-black text-xs text-gray-700 flex-shrink-0">{trailerName}</span>
                                    {isAssigned && assignedTo && (
                                      <span className="text-[10px] text-blue-600 font-bold flex-shrink-0">→ {assignedTo}</span>
                                    )}
                                    <span className={`text-[8px] font-black px-1 py-0.5 rounded ml-auto flex-shrink-0 ${isAssigned ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                                      {isAssigned ? 'Aguard. Aceite' : 'Aguard. ADM'}
                                    </span>
                                    <span className="text-[9px] text-gray-400 flex-shrink-0">{bikes.length}b</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Card por mecânico */}
                  {(() => {
                    const byMechanic: Record<string, {manutencao: number, reserva: number, bikes: string[]}> = {};
                    
                    // Initialize all known mechanics
                    const seenNorm = new Set<string>();
                    const allMechsList: string[] = [];
                    [...AUTHORIZED_MECHANICS_NORMALIZED, ...dynamicMechanics].forEach(name => {
                      const norm = normalizeForSearch(name);
                      if (
                        norm && 
                        norm !== 'CAIO' && 
                        norm !== 'JULIANO' && 
                        norm !== '—' && 
                        norm !== 'MECANICA' && 
                        norm !== 'TODOS' && 
                        !seenNorm.has(norm)
                      ) {
                        seenNorm.add(norm);
                        let finalName = name.toUpperCase().trim();
                        if (norm === 'ANDRE') {
                          finalName = 'ANDRÉ';
                        }
                        allMechsList.push(finalName);
                      }
                    });
                    allMechsList.sort();

                    allMechsList.forEach(m => {
                      byMechanic[m] = { manutencao: 0, reserva: 0, bikes: [] };
                    });

                    mechanicsList.filter(b => b.status === 'Em Manutenção' || b.status === 'Reserva').forEach(b => {
                      const m = b.mecanico || '—';
                      if (m === '—') return;
                      const mNorm = normalizeForSearch(m);
                      if (mNorm === 'MECANICA' || mNorm === 'TODOS' || mNorm === '') return;

                      const foundKey = Object.keys(byMechanic).find(k => normalizeForSearch(k) === mNorm) || m;
                      
                      let finalKey = foundKey;
                      if (normalizeForSearch(finalKey) === 'ANDRE') {
                        finalKey = 'ANDRÉ';
                      }

                      if (!byMechanic[finalKey]) {
                        byMechanic[finalKey] = { manutencao: 0, reserva: 0, bikes: [] };
                      }
                      if (b.status === 'Em Manutenção') byMechanic[finalKey].manutencao++;
                      else byMechanic[finalKey].reserva++;
                      byMechanic[finalKey].bikes.push(b.patrimonio);
                    });

                    const mechs = Object.entries(byMechanic);
                    if (mechs.length === 0) return (
                      <div className="text-center py-6 bg-white rounded-lg border border-dashed">
                        <p className="text-gray-400 text-xs">Nenhum mecânico em atividade</p>
                      </div>
                    );
                    return (
                      <div className="grid grid-cols-1 gap-3">
                        {mechs.map(([name, data]) => (
                          <div key={name} className="bg-white p-3 rounded-lg border shadow-sm">
                            <div className="flex justify-between items-center mb-2 border-b pb-1">
                              <h3 className="font-black text-gray-900 text-sm uppercase">{name}</h3>
                              <button
                                onClick={() => {
                                  setEditingMechanic(name);
                                  setEditingStatusChoice('Em Manutenção');
                                }}
                                className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-black text-blue-600 bg-blue-50 border border-blue-100 hover:bg-blue-100 rounded transition-all uppercase active:scale-95 shadow-sm"
                              >
                                <EditIcon className="w-3 h-3 text-blue-500" />
                                Editar
                              </button>
                            </div>
                            <div className="grid grid-cols-2 gap-1.5 mb-2">
                              {[
                                { l: 'Manutenção', v: data.manutencao, c: 'orange' },
                                { l: 'Reserva', v: data.reserva, c: 'green' },
                              ].map(item => (
                                <div key={item.l} className={`bg-${item.c}-50 p-1.5 rounded border border-${item.c}-100 text-center`}>
                                  <p className={`text-[8px] text-${item.c}-600 font-black uppercase leading-tight`}>{item.l}</p>
                                  <p className={`text-sm font-black text-${item.c}-800`}>{item.v}</p>
                                </div>
                              ))}
                            </div>
                            <div>
                              <p className="text-[9px] font-black text-gray-500 uppercase mb-1">Bikes ({data.bikes.length})</p>
                              <div className="flex flex-wrap gap-1">
                                {mechanicsList.filter(b => (b.status === 'Em Manutenção' || b.status === 'Reserva') && b.mecanico && normalizeForSearch(b.mecanico) === normalizeForSearch(name)).map((b: any) => (
                                  <span key={b.patrimonio} className={`px-2 py-0.5 rounded text-[10px] font-black font-mono ${
                                    b.status === 'Em Manutenção'
                                      ? 'bg-orange-500 text-white'
                                      : 'bg-green-600 text-white'
                                  }`}>{b.patrimonio}</span>
                                ))}
                                {data.bikes.length === 0 && (
                                  <span className="text-[10px] text-gray-400 italic font-medium">Nenhuma bike</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                {/* Quadrante: Técnica */}
                <div className="min-w-full p-3">
                  <h2 className="text-base font-bold text-gray-700 flex items-center gap-2 mb-4">
                    <BicycleIcon className="w-4 h-4 text-blue-600"/>
                    Técnica
                  </h2>

                  {/* Totais Técnica */}
                  <div className="bg-white p-3 rounded-lg border shadow-sm mb-3">
                    <div className="flex justify-between items-center mb-2 border-b pb-1">
                      <h3 className="font-black text-gray-900 text-sm uppercase">Visão Geral Técnica</h3>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { l: 'Aguardando', v: technicaList.filter(b => b.status === 'Aguardando Técnica').length, c: 'blue' },
                        { l: 'Em Técnica', v: technicaList.filter(b => b.status === 'Em Técnica').length, c: 'indigo' },
                      ].map(item => (
                        <div key={item.l} className={`bg-${item.c}-50 p-1.5 rounded border border-${item.c}-100 text-center`}>
                          <p className={`text-[8px] text-${item.c}-600 font-black uppercase leading-tight`}>{item.l}</p>
                          <p className={`text-sm font-black text-${item.c}-800`}>{item.v}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Card por técnico */}
                  {(() => {
                    const byTechnician: Record<string, {emTecnica: number, bikes: string[]}> = {};
                    technicaList.filter(b => b.status === 'Em Técnica').forEach(b => {
                      const t = b.tecnico || '—';
                      if (!byTechnician[t]) byTechnician[t] = { emTecnica: 0, bikes: [] };
                      byTechnician[t].emTecnica++;
                      byTechnician[t].bikes.push(b.patrimonio);
                    });
                    const techs = Object.entries(byTechnician).filter(([name]) => name !== '—');
                    if (techs.length === 0) return (
                      <div className="text-center py-6 bg-white rounded-lg border border-dashed">
                        <p className="text-gray-400 text-xs">Nenhum técnico em atividade</p>
                      </div>
                    );
                    return (
                      <div className="grid grid-cols-1 gap-3">
                        {techs.map(([name, data]) => (
                          <div key={name} className="bg-white p-3 rounded-lg border shadow-sm">
                            <div className="flex justify-between items-center mb-2 border-b pb-1">
                              <h3 className="font-black text-gray-900 text-sm uppercase">{name}</h3>
                            </div>
                            <div className="mb-2">
                              <div className="bg-indigo-50 p-1.5 rounded border border-indigo-100 text-center">
                                <p className="text-[8px] text-indigo-600 font-black uppercase leading-tight">Em Técnica</p>
                                <p className="text-sm font-black text-indigo-800">{data.emTecnica}</p>
                              </div>
                            </div>
                            <div>
                              <p className="text-[9px] font-black text-gray-500 uppercase mb-1">Bikes ({data.bikes.length})</p>
                              <div className="flex flex-wrap gap-1">
                                {technicaList.filter(b => b.status === 'Em Técnica' && b.tecnico === name).map((b: any) => (
                                  <span key={b.patrimonio} className="px-2 py-0.5 rounded text-[10px] font-black font-mono bg-indigo-600 text-white">{b.patrimonio}</span>
                                ))}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                {/* Quadrante 6: Pesquisa de Movimentação de Bike */}
                <div className="min-w-full p-3">
                  <h2 className="text-base font-bold text-gray-700 flex items-center gap-2 mb-4">
                    <SearchIcon className="w-4 h-4 text-purple-600"/>
                    Movimentação de Bike
                  </h2>

                  {/* Campo de busca */}
                  <div className="bg-white p-3 rounded-lg border shadow-sm mb-3">
                    <div className="flex gap-2 mb-3">
                      <input
                        type="text"
                        value={bikeSearchTerm}
                        onChange={e => setBikeSearchTerm(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleBikeMovementSearch()}
                        placeholder="Digite o patrimônio..."
                        className="flex-1 p-1.5 border border-gray-300 rounded-md text-sm focus:ring-purple-500 focus:border-purple-500"
                      />
                      <button
                        onClick={() => handleBikeMovementSearch()}
                        disabled={isBikeSearchLoading || !bikeSearchTerm.trim()}
                        className="px-3 py-1.5 bg-purple-600 text-white text-xs font-bold rounded-md hover:bg-purple-700 disabled:bg-gray-300 flex items-center gap-1"
                      >
                        <SearchIcon className="w-3.5 h-3.5"/>
                        {isBikeSearchLoading ? 'Buscando...' : 'Consultar'}
                      </button>
                    </div>
                    {/* Seletor de limite */}
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-black text-gray-400 uppercase">Exibir últimos</span>
                      <div className="flex bg-gray-100 rounded-full p-0.5 gap-0.5">
                        {([5, 10, 15] as const).map(n => (
                          <button key={n} onClick={() => setBikeSearchLimit(n)}
                            className={`text-[9px] font-black px-2.5 py-0.5 rounded-full transition-all ${bikeSearchLimit === n ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                          >{n} registros</button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Resultados */}
                  {isBikeSearchLoading && (
                    <div className="text-center py-6">
                      <p className="text-xs text-gray-400 animate-pulse">Buscando registros...</p>
                    </div>
                  )}

                  {!isBikeSearchLoading && bikeSearchResult.length > 0 && (
                    <div className="space-y-2">
                      {bikeSearchResult.map((record: any, i: number) => {
                        const statusLow = (record.status || '').toLowerCase();
                        const isAguardandoTecnica = statusLow.includes('aguardando técnica') || statusLow.includes('aguardando tecnica');
                        const isMecanicaRecord = record.origem === 'mecanica' || record.type === 'Mecânica' || record.type === 'Reparo' || isAguardandoTecnica;
                        const isTecnicaRecord  = record.type === 'Técnica' && !isAguardandoTecnica;
                        const isCarretinha     = record.type === 'Carretinha';
                        const isRecolhida   = statusLow === 'recolhida' || statusLow === 'filial';
                        const isEstacao     = statusLow === 'estação' || statusLow === 'estacao' || statusLow === 'em estação';
                        const isVandalizada = statusLow === 'vandalizada';
                        const isNaoEnc      = statusLow.includes('não encontrada') || statusLow.includes('nao encontrada');
                        const isMec         = statusLow.includes('manutenção') || statusLow.includes('manutencao') || statusLow.includes('mecânica') || statusLow.includes('mecanica');
                        // Reserva = saiu da mecânica (type Reparo ou status reserva/remanejada)
                        // Estação = motorista entregou a bike na estação (não deve virar Reserva)
                        const isReserva     = record.type === 'Reparo'
                          || statusLow === 'reserva'
                          || statusLow === 'remanejada'
                          || statusLow.includes('reparo finalizado');
                        const isEstacaoMot  = statusLow === 'em estação' || statusLow === 'estação' || statusLow === 'estacao';
                        const isTec         = statusLow.includes('técnica') || statusLow.includes('tecnica');

                        // Label exibido
                        let displayLabel = record.status;
                        
                        if (isReserva) displayLabel = 'Reserva';
                        else if (isEstacaoMot) displayLabel = 'Estação';
                        else if (statusLow === 'mecânica' || statusLow === 'mecanica') {
                          if (record.type === 'Finalização') displayLabel = 'Alterar Status';
                          else displayLabel = 'Mecânica';
                        }

                        const badgeClass = isRecolhida ? 'bg-green-700 text-white' :
                          isEstacao ? 'bg-indigo-500 text-white' :
                          isVandalizada || isNaoEnc ? 'bg-red-500 text-white' :
                          isMec ? 'bg-orange-500 text-white' :
                          isReserva ? 'bg-green-500 text-white' :
                          isTec ? 'bg-blue-500 text-white' :
                          isCarretinha ? 'bg-purple-500 text-white' :
                          'bg-gray-400 text-white';

                        const borderColor = isCarretinha ? 'border-l-purple-400' :
                          isTecnicaRecord ? 'border-l-blue-400' :
                          isMecanicaRecord ? 'border-l-orange-400' : 'border-l-gray-300';

                        return (
                          <div key={i} className={`bg-white border rounded-lg p-2.5 shadow-sm border-l-4 ${borderColor}`}>
                            <div className="flex items-start justify-between gap-2 mb-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className={`px-2 py-0.5 text-[9px] font-black uppercase rounded ${badgeClass}`}>
                                  {displayLabel}
                                </span>
                                {isMecanicaRecord && (
                                  <span className="px-1.5 py-0.5 text-[8px] font-bold bg-orange-50 text-orange-500 border border-orange-200 rounded">🔧 Mecânica</span>
                                )}
                                {record.source === 'Firebase' && (
                                  <span className="px-1.5 py-0.5 text-[8px] font-bold bg-blue-50 text-blue-500 border border-blue-200 rounded">🔥 Firebase</span>
                                )}
                              </div>
                              <span className="text-[9px] text-gray-800 font-mono font-bold whitespace-nowrap">
                                {record.timestamp instanceof Date 
                                  ? record.timestamp.toLocaleString('pt-BR') 
                                  : String(record.timestamp || '---')}
                              </span>
                            </div>
                            
                            {/* Responsável */}
                            <p className="text-[10px] font-semibold text-gray-700 flex items-center gap-1">
                              {isTecnicaRecord ? '🔬' : isCarretinha ? '🚌' : isMecanicaRecord ? '🔧' : '👤'}{' '}
                              {record.author || record.mecanico || record.motorista || record.driverName || '—'}
                            </p>

                            {/* Descrição / Observação */}
                            <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">
                              📝 {record.description || record.observation || record.observacao || record.summary || '—'}
                            </p>

                            {record.treatment && (
                              <p className="text-[10px] text-gray-500 mt-0.5 italic">🛠 {record.treatment}</p>
                            )}
                            
                            {record.bateria && (() => {
                              const raw = String(record.bateria).replace(',', '.');
                              const num = parseFloat(raw);
                              const pct = !isNaN(num) ? (num <= 1 && num > 0 ? Math.round(num * 100) : Math.round(num)) : null;
                              return pct !== null ? (
                                <p className="text-[10px] text-gray-500 mt-0.5">🔋 {pct}%</p>
                              ) : null;
                            })()}
                            {/* Local final — vandalizada */}
                            {(record.localFinal || record.localidade) && (
                              <p className="text-[10px] text-red-600 font-bold mt-0.5">
                                📍 Local final: {record.localFinal || record.localidade}
                              </p>
                            )}
                            {/* Carretinha */}
                            {record.trailerName && (
                              <p className="text-[10px] text-purple-600 font-bold mt-0.5">🚌 {record.trailerName}</p>
                            )}

                            {/* Botões de Ação Manual (Apenas Perfil Mecânica) */}
                            {isMecanica && (
                              <div className="mt-3 pt-2 border-t border-dashed flex flex-wrap gap-2">
                                <button 
                                  onClick={() => handleManualInsert(bikeSearchTerm.trim(), 'Alterar Status')}
                                  className="px-2 py-1 bg-purple-100 text-purple-700 text-[9px] font-black uppercase rounded border border-purple-200 hover:bg-purple-200 transition-colors"
                                >
                                  Alterar status
                                </button>
                                <button 
                                  onClick={() => handleManualInsert(bikeSearchTerm.trim(), 'Aguardando Manutenção')}
                                  className="px-2 py-1 bg-blue-100 text-blue-700 text-[9px] font-black uppercase rounded border border-blue-200 hover:bg-blue-200 transition-colors"
                                >
                                  Aguardando manutenção
                                </button>
                                <button 
                                  onClick={() => handleManualInsert(bikeSearchTerm.trim(), 'Em Manutenção')}
                                  className="px-2 py-1 bg-orange-100 text-orange-700 text-[9px] font-black uppercase rounded border border-orange-200 hover:bg-orange-200 transition-colors"
                                >
                                  Manutenção
                                </button>
                                <button 
                                  onClick={() => handleManualInsert(bikeSearchTerm.trim(), 'Reserva')}
                                  className="px-2 py-1 bg-green-100 text-green-700 text-[9px] font-black uppercase rounded border border-green-200 hover:bg-green-200 transition-colors"
                                >
                                  Reserva
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!isBikeSearchLoading && bikeSearchTerm && bikeSearchResult.length === 0 && (
                    <div className="text-center py-6 bg-white rounded-lg border border-dashed">
                      <p className="text-gray-400 text-xs">Nenhum registro encontrado para a bike {bikeSearchTerm}</p>
                    </div>
                  )}
                </div>

                {/* Quadrante 7: Boletim (Consulta CHASSI) */}
                <div className="min-w-full p-3">
                  <h2 className="text-base font-bold text-gray-700 flex items-center gap-2 mb-4">
                    <SheetIcon className="w-4 h-4 text-blue-600"/>
                    Boletim de Bike
                  </h2>

                  <div className="bg-white p-4 rounded-xl border shadow-sm space-y-4">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={boletimSearchTerm}
                        onChange={e => setBoletimSearchTerm(e.target.value.toUpperCase())}
                        onKeyDown={e => e.key === 'Enter' && handleBoletimSearch()}
                        placeholder="Nº PATRIMÔNIO"
                        className="flex-1 p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none uppercase"
                      />
                      <button
                        onClick={handleBoletimSearch}
                        disabled={isBoletimLoading || !boletimSearchTerm.trim()}
                        className="px-4 bg-blue-600 text-white rounded-lg font-bold text-xs uppercase hover:bg-blue-700 disabled:bg-gray-200 transition-all flex items-center justify-center min-w-[100px]"
                      >
                        {isBoletimLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Consultar'}
                      </button>
                    </div>

                    {boletimResult ? (
                      <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                        <div className="bg-blue-50/50 rounded-xl p-4 border border-blue-100">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-0.5">
                              <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Patrimônio</p>
                              <p className="text-xs font-black text-blue-700">{boletimResult.patrimonio}</p>
                            </div>
                            <div className="space-y-0.5">
                              <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Chassi</p>
                              <p className="text-xs font-black text-gray-800">{boletimResult.chassi || '---'}</p>
                            </div>
                            <div className="space-y-0.5">
                              <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest">IMEI</p>
                              <p className="text-xs font-black text-gray-800">{boletimResult.imei || '---'}</p>
                            </div>
                            <div className="space-y-0.5">
                              <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Telefone</p>
                              <p className="text-xs font-black text-gray-800">{boletimResult.telefone || '---'}</p>
                            </div>
                            <div className="col-span-2 pt-2 border-t border-blue-100 mt-1">
                              <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest mb-1">Status Atual</p>
                              <div className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${
                                boletimResult.status?.toLowerCase().includes('disponível') ? 'bg-green-100 text-green-700' :
                                boletimResult.status?.toLowerCase().includes('oficina') ? 'bg-orange-100 text-orange-700' :
                                'bg-blue-100 text-blue-700'
                              }`}>
                                {boletimResult.status || 'NÃO INFORMADO'}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Seção de Banco de Dados de Boletins */}
                        <div className="border-t pt-4">
                          <div className="flex justify-between items-center mb-3">
                            <h3 className="text-xs font-black text-gray-700 uppercase tracking-tight flex items-center gap-2">
                              <DatabaseIcon className="w-3.5 h-3.5 text-blue-500" />
                              Histórico de Boletins
                            </h3>
                            <button
                              onClick={() => setShowBoletimForm(!showBoletimForm)}
                              className="px-2 py-1 bg-blue-50 text-blue-600 text-[9px] font-black uppercase rounded border border-blue-100 hover:bg-blue-100 transition-colors"
                            >
                              {showBoletimForm ? 'Cancelar' : 'Registrar B.O.'}
                            </button>
                          </div>

                          {showBoletimForm && (
                            <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 mb-4 space-y-3 animate-in fade-in zoom-in duration-200">
                              <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1">
                                  <label className="text-[8px] font-black text-gray-400 uppercase">Data do B.O.</label>
                                  <input
                                    type="date"
                                    value={newBoletim.date}
                                    onChange={e => setNewBoletim({ ...newBoletim, date: e.target.value })}
                                    className="w-full p-2 bg-white border border-gray-200 rounded text-xs font-bold"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[8px] font-black text-gray-400 uppercase">Número do B.O.</label>
                                  <input
                                    type="text"
                                    value={newBoletim.boNumber}
                                    onChange={e => setNewBoletim({ ...newBoletim, boNumber: e.target.value.toUpperCase() })}
                                    placeholder="Nº DO B.O."
                                    className="w-full p-2 bg-white border border-gray-200 rounded text-xs font-bold uppercase"
                                  />
                                </div>
                              </div>
                              <div className="space-y-1">
                                <label className="text-[8px] font-black text-gray-400 uppercase">Quem Realizou</label>
                                <input
                                  type="text"
                                  value={newBoletim.author}
                                  onChange={e => setNewBoletim({ ...newBoletim, author: e.target.value.toUpperCase() })}
                                  placeholder="NOME DO RESPONSÁVEL"
                                  className="w-full p-2 bg-white border border-gray-200 rounded text-xs font-bold uppercase"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-[8px] font-black text-gray-400 uppercase">Resumo</label>
                                <textarea
                                  value={newBoletim.summary}
                                  onChange={e => setNewBoletim({ ...newBoletim, summary: e.target.value })}
                                  placeholder="BREVE RESUMO DO OCORRIDO..."
                                  className="w-full p-2 bg-white border border-gray-200 rounded text-xs font-bold h-16 resize-none"
                                />
                              </div>
                              <button
                                onClick={handleSaveBoletim}
                                disabled={isBoletimLoading}
                                className="w-full py-2 bg-blue-600 text-white text-[10px] font-black uppercase rounded hover:bg-blue-700 disabled:bg-gray-300 transition-all flex items-center justify-center gap-2"
                              >
                                {isBoletimLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Salvar Registro'}
                              </button>
                            </div>
                          )}

                          <div className="space-y-2">
                            {isBoletimRecordsLoading ? (
                              <div className="flex justify-center py-4">
                                <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                              </div>
                            ) : boletimRecords.length > 0 ? (
                              boletimRecords.map((rec: any) => (
                                <div key={rec.id} className="bg-white border border-gray-100 rounded-lg p-3 shadow-sm">
                                  <div className="flex justify-between items-start mb-1">
                                    <span className="text-[10px] font-black text-blue-600 uppercase">B.O. {rec.boNumber}</span>
                                    <span className="text-[9px] font-bold text-gray-400">{new Date(rec.date + 'T12:00:00').toLocaleDateString('pt-BR')}</span>
                                  </div>
                                  <p className="text-[10px] font-bold text-gray-700 mb-1">👤 {rec.author}</p>
                                  {rec.summary && <p className="text-[10px] text-gray-500 italic">"{rec.summary}"</p>}
                                </div>
                              ))
                            ) : (
                              <div className="text-center py-4 bg-gray-50 rounded-lg border border-dashed">
                                <p className="text-[9px] text-gray-400 uppercase font-bold">Nenhum B.O. registrado para esta bike</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="py-8 text-center border border-dashed rounded-xl">
                        <SheetIcon className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                        <p className="text-[10px] text-gray-400 uppercase font-bold">Aguardando consulta...</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ROTEIRO DE RECOLHAS */}
        {!isAdm && !isMecanica && !isTecnica && (
          <div className="mt-6 p-4 border rounded-lg bg-gray-50">
            {gpsWarning && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg flex items-center gap-2.5 text-xs animate-in slide-in-from-top duration-200">
                <AlertTriangleIcon className="w-4 h-4 text-amber-500 animate-pulse flex-shrink-0" />
                <div className="flex-1">
                  <span className="font-bold">Sinal do GPS:</span> {gpsWarning}
                </div>
                <button 
                  onClick={() => setGpsWarning(null)} 
                  className="text-amber-500 hover:text-amber-700 text-xs font-black uppercase px-1.5 py-0.5 rounded hover:bg-amber-100 transition-colors"
                >
                  Ok
                </button>
              </div>
            )}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-gray-700">Roteiro de Recolhas</h2>
                {sortedRouteBikes.length > 0 && routeDistances[sortedRouteBikes[0]] && (
                  <span className="text-[9px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                    🗺️ Rota otimizada
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {sortedRouteBikes.length > 0 && currentDriverLocation && (
                  <button onClick={() => buildOptimizedRoute()}
                    className="p-1.5 text-gray-400 hover:text-blue-600 rounded-full hover:bg-blue-50"
                    title="Recalcular rota">
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                  </button>
                )}
                <button onClick={() => setIsRouteConfigOpen(true)}
                  className="p-2 text-gray-400 hover:text-blue-600 transition-colors rounded-full hover:bg-blue-50"
                  title="Configurar Roteiro">
                  <Settings size={20}/>
                </button>
              </div>
            </div>
            {sortedRouteBikes.length > 0 && totalRouteSummary && (
              <div className="mb-3 p-3 bg-blue-50 border border-blue-100 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-blue-800 shadow-sm">
                <div className="flex items-center gap-1.5 font-bold text-blue-950">
                  <span>🧭 Resumo do Roteiro ({totalRouteSummary.count} paradas):</span>
                </div>
                <div className="flex items-center gap-4 text-[11px] font-semibold">
                  <span className="flex items-center gap-1">🚗 Trajeto total: <strong className="font-black text-blue-950 text-xs">{totalRouteSummary.distance}</strong></span>
                  <span className="flex items-center gap-1">⏱️ Tempo total: <strong className="font-black text-blue-950 text-xs">{totalRouteSummary.duration}</strong></span>
                </div>
              </div>
            )}
            {sortedRouteBikes.length > 0 ? (
              <ul className="space-y-2">
                {sortedRouteBikes.map((bike) => {
                  const details = routeBikesDetails[bike] || searchCacheRef.current[bike] || collectedBikesDetails[bike];
                  const moved = details?.currentLat && details?.currentLng && details?.initialLat && details?.initialLng
                    ? getDistanceInMeters(details.initialLat, details.initialLng, details.currentLat, details.currentLng) : 0;
                  const dist = currentDriverLocation && details?.currentLat && details?.currentLng
                    ? calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, details.currentLat, details.currentLng) : null;
                  return (
                    <li key={bike} className="p-3 bg-white border rounded-md flex flex-col gap-3">
                      <div className="flex justify-between items-start">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            {details?.ocorrencia ? (
                              <div className="w-12 h-12 rounded-full border-2 border-yellow-500 bg-yellow-50 flex items-center justify-center shadow-sm animate-pulse flex-shrink-0">
                                <p className="font-mono text-gray-900 font-black text-sm">{bike}</p>
                              </div>
                            ) : (
                              <p className="font-mono text-gray-800 font-bold text-lg">{bike}</p>
                            )}
                            <div className="flex items-center gap-1.5">
                              <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 border-blue-500 text-[9px] font-bold text-blue-600 bg-white shadow-sm flex-shrink-0">
                                {details?.battery !== undefined ? `${formatBattery(details.battery)}%` : '??%'}
                              </div>
                              {(() => {
                                const st = details?.status || details?.Status || details?.statusSistema || details?.situacao || bikeConflicts[bike]?.status || 'Em Rota';
                                return (
                                  <span className="text-[10px] font-bold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full uppercase truncate max-w-[100px]" title={String(st)}>
                                    {String(st)}
                                  </span>
                                );
                              })()}
                            </div>
                            {renderConflictIcon(bike)}
                            {moved > 10 && (
                              <div className="flex items-center gap-0.5 text-orange-500 animate-pulse">
                                <MovingIcon className="w-3.5 h-3.5"/>
                                {moved > 100 && <MovingIcon className="w-3.5 h-3.5"/>}
                                <span className="text-[10px] font-bold uppercase ml-1">Movendo ({moved > 1000 ? `${(moved/1000).toFixed(1)}km` : `${moved.toFixed(0)}m`})</span>
                              </div>
                            )}
                          </div>
                          {dist !== null && (
                            <span className="text-[10px] font-bold text-blue-600">
                              {routeDistances[bike] 
                                ? `${routeDistances[bike].distance} · ${routeDistances[bike].duration} (${routeDistances[bike].isRoad ? 'de carro/ruas' : 'linha reta'})` 
                                : `${dist.toFixed(2)} km (calculando trajeto...)`}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2 w-full">
                        <button onClick={() => handleNaoAtendidaClick(bike)} disabled={isLoading || processingBikes.has(bike)}
                          className="flex-1 px-2 py-2 bg-yellow-500 text-white rounded-md hover:bg-yellow-600 active:scale-95 disabled:bg-gray-400 text-[10px] font-bold uppercase">Não Atendida</button>
                        <button onClick={() => handleSearch(bike)} disabled={isLoading || processingBikes.has(bike)}
                          className="flex-1 px-2 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 active:scale-95 disabled:bg-gray-400 text-[10px] font-bold uppercase">Recolher</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="text-sm text-gray-500">Nenhuma bicicleta no seu roteiro no momento.</p>}
          </div>
        )}

        {/* BIKES RECOLHIDAS */}
        {!isAdm && !isMecanica && !isTecnica && (
          <div className="mt-6 p-4 border rounded-lg bg-gray-50">
            <h2 className="text-lg font-semibold text-gray-700 mb-3">Bikes Recolhidas</h2>
            {sortedCollectedBikes.length > 0 ? (
              <ul className="space-y-2">
                {sortedCollectedBikes.map((bike, i) => {
                  const details = collectedBikesDetails[bike] || searchCacheRef.current[bike] || routeBikesDetails[bike];
                  return (
                    <li key={`route-${bike}-${i}`} className="p-3 bg-white border rounded-md flex flex-col sm:flex-row justify-between items-center gap-2">
                      <div className="flex items-center gap-3">
                        <p className="font-mono text-gray-800 font-bold text-lg">{bike}</p>
                        <div className="flex items-center gap-1.5">
                          <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 border-blue-500 text-[9px] font-bold text-blue-600 bg-white shadow-sm flex-shrink-0">
                            {details?.battery !== undefined ? `${formatBattery(details.battery)}%` : '??%'}
                          </div>
                          {(() => {
                            const st = details?.status || details?.Status || details?.statusSistema || details?.situacao || bikeConflicts[bike]?.status || 'Recolhida';
                            return (
                              <span className="text-[10px] font-bold bg-green-100 text-green-700 px-2 py-0.5 rounded-full uppercase truncate max-w-[100px]" title={String(st)}>
                                {String(st)}
                              </span>
                            );
                          })()}
                        </div>
                      </div>
                    <div className="grid grid-cols-3 gap-2 w-full max-w-[240px]">
                      <button onClick={() => handleCollectedBikeAction(bike, 'Enviada para Estação')} disabled={isLoading || processingBikes.has(bike)} className="px-2 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600 active:scale-95 text-xs disabled:bg-gray-400">Estação</button>
                      <button onClick={() => handleCollectedBikeAction(bike, 'Enviada para Filial')} disabled={isLoading || processingBikes.has(bike)} className="px-2 py-1 bg-green-500 text-white rounded-md hover:bg-green-600 active:scale-95 text-xs disabled:bg-gray-400">Filial</button>
                      <button onClick={() => handleCollectedBikeAction(bike, 'Vandalizada')} disabled={isLoading || processingBikes.has(bike)} className="px-2 py-1 bg-red-500 text-white rounded-md hover:bg-red-600 active:scale-95 text-xs disabled:bg-gray-400">Vandalizada</button>
                    </div>
                  </li>
                  );
                })}
              </ul>
            ) : <p className="text-sm text-gray-500">Nenhuma bicicleta recolhida ainda.</p>}
          </div>
        )}
      </main>

      {/* MODAIS */}
      {/* Modal de Configuração de Roteiro */}
      {isRouteConfigOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px]">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-[320px] overflow-hidden animate-in fade-in zoom-in duration-150">
            <div className="p-3 border-b border-gray-100 flex items-center justify-between bg-white text-gray-800">
              <div className="flex items-center gap-2">
                <Settings size={16} className="text-blue-600" />
                <h3 className="text-sm font-bold tracking-tight">Configurar Roteiro</h3>
              </div>
              <button onClick={() => setIsRouteConfigOpen(false)} className="p-1 hover:bg-gray-100 rounded-full transition-colors text-gray-400">
                <XIcon size={18} />
              </button>
            </div>

            <div className="p-3 space-y-4 max-h-[65vh] overflow-y-auto">
              {/* Origem da Localização */}
              <div className="space-y-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Localização</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setRouteConfig(prev => ({ ...prev, locationSource: 'gps' }))}
                    className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg border transition-all text-[11px] ${
                      routeConfig.locationSource === 'gps' 
                        ? 'border-blue-600 bg-blue-50 text-blue-700 font-bold' 
                        : 'border-gray-100 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    <Locate size={12} />
                    <span>GPS Atual</span>
                  </button>
                  <button
                    onClick={() => setRouteConfig(prev => ({ ...prev, locationSource: 'zone' }))}
                    className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg border transition-all text-[11px] ${
                      routeConfig.locationSource === 'zone' 
                        ? 'border-blue-600 bg-blue-50 text-blue-700 font-bold' 
                        : 'border-gray-100 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    <LucideMap size={12} />
                    <span>Por Zona</span>
                  </button>
                </div>
              </div>

              {/* Seleção de Zona (se habilitado) */}
              {routeConfig.locationSource === 'zone' && (
                <div className="space-y-1.5 animate-in slide-in-from-top-1 duration-150">
                  <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest text-center block">Zona</label>
                  <div className="flex justify-center">
                    <div className="grid grid-cols-3 gap-1 w-fit">
                      <div />
                      <ZoneButton id="norte" icon={<ChevronUp size={14} />} label="N" config={routeConfig} setConfig={setRouteConfig} />
                      <div />
                      <ZoneButton id="oeste" icon={<ChevronLeft size={14} />} label="O" config={routeConfig} setConfig={setRouteConfig} />
                      <ZoneButton id="central" icon={<Circle size={14} />} label="C" config={routeConfig} setConfig={setRouteConfig} />
                      <ZoneButton id="leste" icon={<ChevronRight size={14} />} label="L" config={routeConfig} setConfig={setRouteConfig} />
                      <div />
                      <ZoneButton id="sul" icon={<ChevronDown size={14} />} label="S" config={routeConfig} setConfig={setRouteConfig} />
                      <div />
                    </div>
                  </div>
                </div>
              )}

              {/* Filtros de Problemas */}
              <div className="space-y-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Filtros</label>
                <div className="space-y-1">
                  {[
                    { id: 'lowBattery', label: 'Bateria Baixa (<50%)', icon: <Battery size={14} className="text-red-500" /> },
                    { id: 'openLock', label: 'Trava Aberta', icon: <Lock size={14} className="text-orange-500" /> },
                    { id: 'outOfStation', label: 'Fora de Estação', icon: <LucideMap size={14} className="text-purple-500" /> },
                    { id: 'offline', label: 'Offline (>30min)', icon: <WifiOff size={14} className="text-gray-400" /> },
                    { id: 'wrongStatus', label: 'Status Incorreto', icon: <AlertCircle size={14} className="text-yellow-500" /> },
                  ].map((filter) => (
                    <label key={filter.id} className="flex items-center justify-between p-1.5 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors cursor-pointer">
                      <div className="flex items-center gap-2">
                        {filter.icon}
                        <span className="text-[11px] font-medium text-gray-600">{filter.label}</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={(routeConfig.filters as any)[filter.id]}
                        onChange={(e) => setRouteConfig(prev => ({
                          ...prev,
                          filters: { ...prev.filters, [filter.id]: e.target.checked }
                        }))}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 transition-all"
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-3 bg-white border-t border-gray-100">
              <button
                onClick={handleGenerateRoute}
                disabled={isLoading}
                className="w-full bg-blue-600 text-white py-2 rounded-lg font-bold text-xs shadow-md hover:bg-blue-700 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isLoading ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Play size={14} fill="currentColor" />
                )}
                GERAR ROTA
              </button>
              <p className="text-center text-[8px] text-gray-400 mt-1.5 uppercase tracking-widest font-bold">
                Máximo 20 bikes · Raio 3km
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Modal Timeline Expandida */}
      {timelineModal && (() => {
        const { driver, clusters = [], startMs, endMs } = timelineModal;
        const totalMs = endMs - startMs || 1;
        const toPos = (tsMs: number) => Math.max(0, Math.min(100, (tsMs - startMs) / totalMs * 100));
        const fmtTime = (ms: number) => {
          const d = new Date(ms);
          return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        const dotConfig: Record<string, {bg: string, label: string}> = {
          em_posse:       { bg: 'bg-green-500',  label: 'Em Posse' },
          recolhida:      { bg: 'bg-green-700',  label: 'Filial' },
          filial:         { bg: 'bg-green-700',  label: 'Filial' },
          estacao:        { bg: 'bg-indigo-500', label: 'Estação' },
          nao_atendida:   { bg: 'bg-yellow-500', label: 'Não atend.' },
          nao_encontrada: { bg: 'bg-red-500',    label: 'Não encontrada' },
          carretinha:     { bg: 'bg-purple-600', label: 'Carretinha' },
          removida_por_adm: { bg: 'bg-black',    label: 'Removida por ADM' },
        };
        // Marca de hora a cada 30min
        const hourMarks: Array<{ms: number, label: string}> = [];
        const startHour = new Date(startMs);
        startHour.setMinutes(0, 0, 0);
        for (let t = startHour.getTime(); t <= endMs; t += 30 * 60 * 1000) {
          if (t >= startMs) hourMarks.push({ ms: t, label: fmtTime(t) });
        }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setTimelineModal(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-black text-gray-800 uppercase">{driver}</h2>
                  <p className="text-[10px] text-gray-400">{fmtTime(startMs)} → {fmtTime(endMs)}</p>
                </div>
                <button onClick={() => setTimelineModal(null)} className="text-gray-400 hover:text-gray-700 text-xl font-bold">✕</button>
              </div>

              {/* Linha do tempo expandida */}
              <div className="relative mb-8" style={{height: '80px'}}>
                {/* Marcas de hora */}
                {hourMarks.map((m, i) => (
                  <div key={i} className="absolute flex flex-col items-center" style={{left: `${toPos(m.ms)}%`}}>
                    <div className="w-px h-3 bg-gray-200"/>
                    <span className="text-[8px] text-gray-300 mt-0.5 -translate-x-1/2">{m.label}</span>
                  </div>
                ))}
                {/* Linha base */}
                <div className="absolute top-6 left-0 right-0 h-0.5 bg-gray-900 rounded"/>
                {/* Horários extremos */}
                <span className="absolute top-9 left-0 text-[9px] text-gray-600 font-mono font-bold">{fmtTime(startMs)}</span>
                <span className="absolute top-9 right-0 text-[9px] text-gray-600 font-mono font-bold">{fmtTime(endMs)}</span>
                {/* Eventos agrupados */}
                {clusters.map((cl: any, ci: number) => {
                  const pos = toPos(cl.tsMs);
                  const cfg = dotConfig[cl.type] || { bg: 'bg-gray-400', label: cl.type };
                  const isMulti = cl.count > 1;
                  return (
                    <div key={ci} className="absolute -translate-x-1/2 flex flex-col items-center" style={{left: `${pos}%`, top: 0}}>
                      {cl.isOccurrence && (
                        <div className="absolute -top-4 left-1/2 -translate-x-1/2 flex flex-col items-center animate-pulse">
                          <span className={`text-[14px] drop-shadow-sm ${cl.type === 'nao_encontrada' ? 'text-red-600' : 'text-yellow-500'}`}>★</span>
                        </div>
                      )}
                      <div className={`rounded-full border-2 shadow flex items-center justify-center ${isMulti ? 'w-6 h-6' : 'w-4 h-4'} ${cfg.bg} ${cl.isOccurrence ? (cl.type === 'nao_encontrada' ? 'border-red-500 ring-2 ring-red-400/50' : 'border-yellow-400 ring-2 ring-yellow-400/50') : 'border-white'} mt-3`}>
                        {isMulti && !cl.isOccurrence && (
                          <span className="text-[9px] font-black text-white">{cl.count}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Lista detalhada de eventos */}
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {clusters.map((cl: any, ci: number) => {
                  const cfg = dotConfig[cl.type] || { bg: 'bg-gray-400', label: cl.type };
                  return (
                    <div key={ci} className="flex items-start gap-3 p-2.5 bg-gray-50 rounded-lg border">
                      <div className={`w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0 ${cfg.bg}`}/>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black text-gray-700">
                            {(cl.type === 'carretinha' || cl.type === 'removida_por_adm') && cl.observacoes?.[0] ? cl.observacoes[0] : cfg.label}
                          </span>
                          {cl.count > 1 && <span className="text-[9px] bg-gray-200 text-gray-600 px-1.5 rounded-full font-bold">{cl.count} bikes</span>}
                        </div>
                        {cl.bikes && cl.bikes.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {cl.bikes.map((b: string) => (
                              <span key={b} className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                                cl.type === 'em_posse' ? 'bg-green-50 border-green-200 text-green-700' :
                                cl.type === 'recolhida' ? 'bg-green-100 border-green-300 text-green-800' :
                                cl.type === 'estacao' ? 'bg-indigo-50 border-indigo-200 text-indigo-700' :
                                cl.type === 'removida_por_adm' ? 'bg-red-50 border-red-200 text-red-700' :
                                'bg-gray-100 border-gray-200 text-gray-600'
                              }`}>{b}</span>
                            ))}
                          </div>
                        )}
                        {cl.observacoes && cl.observacoes.filter(Boolean).length > 0 && cl.type !== 'em_posse' && cl.type !== 'carretinha' && cl.type !== 'removida_por_adm' && (
                          <p className="text-[8px] text-gray-400 mt-0.5 italic">{cl.observacoes.filter(Boolean).join(' · ')}</p>
                        )}
                      </div>
                      <span className="text-[10px] text-gray-500 font-mono font-bold flex-shrink-0">{fmtTime(cl.tsMs)}</span>
                    </div>
                  );
                })}
              </div>

              {/* Legenda */}
              <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t">
                {Object.entries(dotConfig).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-1">
                    <div className={`w-2 h-2 rounded-full ${v.bg}`}/>
                    <span className="text-[9px] text-gray-500">{v.label}</span>
                  </div>
                ))}
                <div className="flex items-center gap-2 ml-auto">
                  <div className="flex items-center gap-1">
                    <span className="text-[12px] text-yellow-500">★</span>
                    <span className="text-[9px] text-gray-500 font-bold">Ocorrência Recolhida</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[12px] text-red-600">★</span>
                    <span className="text-[9px] text-gray-500 font-bold">Ocorrência Não Encontrada</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <RequestModal 
        isOpen={isRequestModalOpen} 
        onClose={() => setRequestModalOpen(false)} 
        onSubmit={handleCreateRequest} 
        isLoading={isLoading} 
        motoristas={motoristas} 
        driverLocations={driverLocations} 
        error={error} 
        clearError={() => setError(null)}
        initialBikeNumber={prefilledBikeNumber}
      />
      <EditDriverModal isOpen={isEditDriverModalOpen} onClose={() => setIsEditDriverModalOpen(false)} driver={editingDriver} onSave={handleUpdateDriverState} isLoading={isLoading}/>
      <RouteModal isOpen={isRouteModalOpen} onClose={() => setRouteModalOpen(false)} onSubmit={handleCreateRoute} isLoading={isLoading} pendingBikeNumbers={allActiveBikes} motoristas={motoristas} error={error} clearError={() => setError(null)} type="route"/>
      <RouteModal isOpen={isTrailerModalOpen} onClose={() => setTrailerModalOpen(false)} onSubmit={handleCreateTrailer} isLoading={isLoading} pendingBikeNumbers={allActiveBikes} motoristas={motoristas} error={error} clearError={() => setError(null)} type="trailer"/>
      <ReportModal isOpen={isReportModalOpen} onClose={() => setReportModalOpen(false)} driverName={driverName} plate={plate} kmInicial={kmInicial}/>
      <DestinationModal isOpen={destinationModal.isOpen} onClose={() => setDestinationModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={obs => executeCollectedBikeAction(destinationModal.bikeNumber, destinationModal.type === 'Estação' ? 'Enviada para Estação' : destinationModal.type === 'Filial' ? 'Enviada para Filial' : 'Vandalizada', obs)}
        type={destinationModal.type} bikeNumber={destinationModal.bikeNumber} stationName={destinationModal.stationName} isLoading={isLoading} onRecalculate={recalculateStation}/>
      <HistoryModal isOpen={isHistoryModalOpen} onClose={() => setIsHistoryModalOpen(false)} history={requestsHistory} isLoading={isHistoryLoading} driverName={driverName}/>
      {isFirebaseReportOpen && <FirebaseReportModal isOpen={isFirebaseReportOpen} onClose={() => setIsFirebaseReportOpen(false)} />}
      {showAnalyticalDashboard && <AnalyticalDashboard onClose={() => setShowAnalyticalDashboard(false)} apiCall={apiCall} />}
      
      {/* Modal de Seleção de Mecânico para Inserção Manual */}
      {manualMechanicModal.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-orange-600 p-4 text-white">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <Wrench className="w-5 h-5" />
                Associar Mecânico
              </h3>
              <p className="text-xs opacity-90 mt-1">Selecione o mecânico para a bike {manualMechanicModal.bikePat}</p>
            </div>
            
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Mecânicos Recentes</label>
                <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                  {mechanicsNames.map(name => (
                    <button
                      key={name}
                      onClick={() => setManualMechanicName(name)}
                      className={`p-2 text-[10px] font-bold rounded border transition-all ${manualMechanicName === name ? 'bg-orange-100 border-orange-500 text-orange-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:border-gray-300'}`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
              
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Ou digite um novo nome</label>
                <input
                  type="text"
                  value={manualMechanicName}
                  onChange={e => setManualMechanicName(e.target.value.toUpperCase())}
                  placeholder="NOME DO MECÂNICO"
                  className="w-full p-2.5 border border-gray-300 rounded-lg text-sm font-bold focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none uppercase"
                />
              </div>
            </div>
            
            <div className="p-4 bg-gray-50 flex gap-3">
              <button
                onClick={() => {
                  setManualMechanicModal({ isOpen: false, bikePat: '', targetStatus: '' });
                  setManualMechanicName('');
                }}
                className="flex-1 px-4 py-2.5 bg-white border border-gray-300 text-gray-700 text-xs font-bold rounded-lg hover:bg-gray-100 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => processManualInsert(manualMechanicModal.bikePat, manualMechanicName, manualMechanicModal.targetStatus)}
                disabled={!manualMechanicName.trim() || isBikeSearchLoading}
                className="flex-1 px-4 py-2.5 bg-orange-600 text-white text-xs font-bold rounded-lg hover:bg-orange-700 disabled:bg-gray-300 transition-colors flex items-center justify-center gap-2"
              >
                {isBikeSearchLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Remoção de Bike de Alerta */}
      {removeAlertModal.isOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-red-600 p-4 text-white">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
                Remover Bike do Alerta
              </h3>
              <p className="text-xs opacity-90 mt-1">Insira os dados para remover a bike {removeAlertModal.alert?.patrimonio || removeAlertModal.alert?.id} do alerta</p>
            </div>
            
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Quem está removendo?</label>
                <input
                  type="text"
                  value={removeAlertModal.removerName}
                  onChange={e => setRemoveAlertModal(prev => ({ ...prev, removerName: e.target.value.toUpperCase() }))}
                  placeholder="Seu Nome"
                  className="w-full p-2.5 border border-gray-300 rounded-lg text-sm font-bold focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none uppercase"
                />
              </div>
              
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Motivo da remoção</label>
                <textarea
                  value={removeAlertModal.reason}
                  onChange={e => setRemoveAlertModal(prev => ({ ...prev, reason: e.target.value }))}
                  placeholder="Descreva brevemente o motivo da remoção..."
                  rows={3}
                  className="w-full p-2.5 border border-gray-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none resize-none"
                />
              </div>
            </div>
            
            <div className="p-4 bg-gray-50 flex gap-3">
              <button
                onClick={() => setRemoveAlertModal({ isOpen: false, alert: null, reason: '', removerName: '' })}
                className="flex-1 px-4 py-2.5 bg-white border border-gray-300 text-gray-700 text-xs font-bold rounded-lg hover:bg-gray-100 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleRemoveAlertSubmit}
                disabled={!removeAlertModal.removerName.trim() || !removeAlertModal.reason.trim() || isLoading}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 disabled:bg-gray-300 transition-colors flex items-center justify-center gap-2"
              >
                {isLoading ? 'Removendo...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Modal de Confirmação "Não Encontrada" */}
      {isNotFoundConfirmOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                <AlertCircle size={32} className="text-red-600" />
              </div>
              <h2 className="text-xl font-black text-gray-800 uppercase mb-2">Confirmar Ação</h2>
              <p className="text-sm text-gray-500 mb-6">
                Deseja realmente marcar a bicicleta <span className="font-bold text-gray-800">{searchedBike?.['Patrimônio']}</span> como <span className="font-bold text-red-600 uppercase">Não Encontrada</span>?
              </p>
              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  onClick={() => setIsNotFoundConfirmOpen(false)}
                  className="py-3 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    setIsNotFoundConfirmOpen(false);
                    handleStatusUpdate('Não encontrada');
                  }}
                  className="py-3 bg-red-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-red-200 hover:bg-red-700 active:scale-95 transition-all"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação "Bike Localizada" */}
      {bikeFoundModal?.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
                <CheckCircleIcon size={32} className="text-green-600" />
              </div>
              <h2 className="text-xl font-black text-gray-800 uppercase mb-2">Bike Localizada?</h2>
              <p className="text-sm text-gray-500 mb-6">
                A bicicleta <span className="font-bold text-gray-800">{bikeFoundModal.bikePat}</span> foi localizada?
              </p>
              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  onClick={() => handleBikeFoundNao(bikeFoundModal.bikePat)}
                  disabled={isLoading}
                  className="py-3 bg-red-100 text-red-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-red-200 transition-all disabled:opacity-50"
                >
                  Não
                </button>
                <button
                  onClick={() => handleBikeFoundSim(bikeFoundModal.bikePat)}
                  disabled={isLoading}
                  className="py-3 bg-green-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-green-200 hover:bg-green-700 active:scale-95 transition-all disabled:opacity-50"
                >
                  Sim
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação "Não Encontrada" (Mecânica) */}
      {mechanicNotFoundModal?.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                <AlertCircle size={32} className="text-red-600" />
              </div>
              <h2 className="text-xl font-black text-gray-800 uppercase mb-2">Marcar como não encontrada?</h2>
              <p className="text-sm text-gray-500 mb-6">
                Deseja realmente marcar a bicicleta <span className="font-bold text-gray-800">{mechanicNotFoundModal.bikePat}</span> como <span className="font-bold text-red-600 uppercase">Não Encontrada</span>?
              </p>
              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  onClick={() => setMechanicNotFoundModal(null)}
                  disabled={isLoading}
                  className="py-3 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => handleMarkAsNotFound(mechanicNotFoundModal.bikePat)}
                  disabled={isLoading}
                  className="py-3 bg-red-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-red-200 hover:bg-red-700 active:scale-95 transition-all disabled:opacity-50"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação "Enviar para Técnica" */}
      {isTechnicalConfirmOpen?.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
                <Settings size={32} className="text-blue-600" />
              </div>
              <h2 className="text-xl font-black text-gray-800 uppercase mb-2">Enviar para Técnica?</h2>
              <p className="text-sm text-gray-500 mb-6">
                Deseja enviar a bicicleta <span className="font-bold text-gray-800">{isTechnicalConfirmOpen.bikePat}</span> para a <span className="font-bold text-blue-600 uppercase">Técnica</span>?
              </p>
              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  onClick={() => setIsTechnicalConfirmOpen(null)}
                  disabled={isLoading}
                  className="py-3 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => handleSendToTechnical(isTechnicalConfirmOpen.bikePat, isTechnicalConfirmOpen.mechanicName)}
                  disabled={isLoading}
                  className="py-3 bg-blue-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-50"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação "Bike Vandalizada" */}
      {isVandalizedConfirmOpen?.isOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col max-h-[90vh] overflow-hidden">
            {/* Header */}
            <div className="bg-red-600 p-4 text-white flex-shrink-0">
              <p className="text-xs font-bold uppercase opacity-80">Finalizar como Vandalizada</p>
              <h2 className="text-lg font-black">Bike {isVandalizedConfirmOpen.bikePat}</h2>
            </div>

            {/* Opções de dano */}
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">Motivo(s) da vandalização</p>
              <div className="grid grid-cols-2 gap-1.5">
                {VANDALIZED_OPTIONS.map(opt => {
                  const selected = vandalizedSelected.has(opt);
                  return (
                    <button key={opt}
                      onClick={() => setVandalizedSelected(prev => {
                        const next = new Set(prev);
                        if (next.has(opt)) next.delete(opt); else next.add(opt);
                        return next;
                      })}
                      className={`text-left px-2.5 py-2 rounded-lg border-2 font-bold text-xs transition-all active:scale-95 flex items-center gap-2 ${
                        selected ? 'bg-red-50 border-red-400 text-red-700' : 'bg-white border-gray-200 text-gray-500 hover:border-red-200'
                      }`}
                    >
                      <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 text-[9px] font-black ${
                        selected ? 'bg-red-500 border-red-500 text-white' : 'border-gray-300'
                      }`}>{selected ? '✓' : ''}</span>
                      {opt}
                    </button>
                  );
                })}
              </div>

              {/* Destino */}
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mt-4 mb-2">Destino da bike</p>
              <div className="grid grid-cols-3 gap-2">
                {VANDALIZED_ROOMS.map(room => (
                  <button key={room}
                    onClick={() => setVandalizedRoom(prev => prev === room ? '' : room)}
                    className={`py-2.5 rounded-xl border-2 font-black text-xs transition-all active:scale-95 ${
                      vandalizedRoom === room
                        ? 'bg-gray-800 border-gray-800 text-white'
                        : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'
                    }`}
                  >
                    {room}
                  </button>
                ))}
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t flex-shrink-0 space-y-2">
              {(vandalizedSelected.size > 0 || vandalizedRoom) && (
                <p className="text-[10px] text-red-600 font-bold text-center">
                  {vandalizedSelected.size > 0 ? `${vandalizedSelected.size} motivo(s) selecionado(s)` : ''}
                  {vandalizedSelected.size > 0 && vandalizedRoom ? ' · ' : ''}
                  {vandalizedRoom || ''}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setIsVandalizedConfirmOpen(null);
                    setVandalizedSelected(new Set());
                    setVandalizedRoom('');
                  }}
                  className="flex-1 py-2.5 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase hover:bg-gray-200"
                >Cancelar</button>
                <button
                  onClick={() => {
                    const treatment = vandalizedSelected.size > 0
                      ? Array.from(vandalizedSelected).join(', ')
                      : 'Vandalizada sem recuperação';
                    handleMarkAsVandalizedNoRecovery(
                      isVandalizedConfirmOpen!.bikePat,
                      treatment,
                      vandalizedRoom
                    );
                  }}
                  disabled={isLoading}
                  className="flex-1 py-2.5 bg-red-600 text-white rounded-xl font-bold text-xs uppercase shadow-lg hover:bg-red-700 active:scale-95 disabled:bg-gray-300 transition-all"
                >
                  {isLoading ? '...' : 'Confirmar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ScheduleModal isOpen={isScheduleModalOpen} onClose={() => setIsScheduleModalOpen(false)} schedule={userSchedule} driverName={driverName} isLoading={isScheduleLoading}/>
      <VehicleSwitchModal isOpen={isVehicleModalOpen} onClose={() => setIsVehicleModalOpen(false)} onSwitch={(p, km) => onUpdateUser({ plate: p, kmInicial: km })} driverName={driverName} currentPlate={plate}/>
      <ReporModal isOpen={isReporModalOpen} onClose={() => setIsReporModalOpen(false)} data={reporData} isLoading={isReporLoading}/>
      {/* Modal Histórico Técnica */}
      {isTechnicaHistoryOpen && (() => {
        const fmt = (ts: any) => {
          if (!ts) return '—';
          const d = ts.toDate ? ts.toDate() : new Date(ts);
          if (isNaN(d.getTime())) return '—';
          return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        const uniqueTechs = ['Todos', ...Array.from(new Set(technicaHistory.map(r => r.tecnico).filter(Boolean))).sort()];
        const filtered = technicaHistory.filter(r => {
          const ts = r.dataSaida?.toDate ? r.dataSaida.toDate() : new Date(r.dataSaida || 0);
          const recDate = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')}`;
          const matchDate = technicaHistoryFilter.date ? recDate === technicaHistoryFilter.date : true;
          const matchTech = technicaHistoryFilter.technician === 'Todos' || r.tecnico === technicaHistoryFilter.technician;
          return matchDate && matchTech;
        });
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh] overflow-hidden">
              <div className="bg-blue-900 p-4 text-white flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-2">
                  <CalendarIcon className="w-5 h-5"/>
                  <div>
                    <h2 className="text-base font-black">Histórico da Técnica</h2>
                    <p className="text-[10px] opacity-60">Bikes analisadas e devolvidas</p>
                  </div>
                </div>
                <button onClick={() => setIsTechnicaHistoryOpen(false)} className="p-1 hover:bg-white/20 rounded-full">
                  <XIcon className="w-5 h-5"/>
                </button>
              </div>
              <div className="p-3 border-b bg-gray-50 flex gap-2 flex-shrink-0 flex-wrap">
                <div className="flex-1 min-w-[120px]">
                  <label className="text-[9px] font-black text-gray-400 uppercase block mb-1">Técnico</label>
                  <select
                    value={technicaHistoryFilter.technician}
                    onChange={e => setTechnicaHistoryFilter(prev => ({ ...prev, technician: e.target.value }))}
                    className="w-full text-xs p-1.5 border rounded-lg bg-white font-bold text-gray-700 outline-none"
                  >
                    {uniqueTechs.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="flex-1 min-w-[130px]">
                  <label className="text-[9px] font-black text-gray-400 uppercase block mb-1">Data de Saída</label>
                  <input type="date" value={technicaHistoryFilter.date} max={localDateStr()}
                    onChange={e => setTechnicaHistoryFilter(prev => ({ ...prev, date: e.target.value }))}
                    className="w-full text-xs p-1.5 border rounded-lg bg-white font-bold text-gray-700 outline-none"
                  />
                </div>
                <div className="flex items-end gap-1">
                  <button onClick={() => setTechnicaHistoryFilter({ technician: 'Todos', date: localDateStr() })}
                    className="px-2 py-1.5 bg-gray-200 text-gray-600 text-[10px] font-bold rounded-lg hover:bg-gray-300 whitespace-nowrap">Hoje</button>
                  <button onClick={() => setTechnicaHistoryFilter(prev => ({ ...prev, date: '' }))}
                    className="px-2 py-1.5 bg-gray-100 text-gray-500 text-[10px] font-bold rounded-lg hover:bg-gray-200 whitespace-nowrap">Tudo</button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {isTechnicaHistoryLoading ? (
                  <div className="text-center py-10 text-gray-400 text-sm">Carregando...</div>
                ) : filtered.length === 0 ? (
                  <div className="text-center py-10 text-gray-400 text-sm italic">Nenhum registro encontrado.</div>
                ) : (
                  <div className="space-y-1">
                    {/* Header de tabela */}
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-lg text-[9px] font-black text-gray-400 uppercase tracking-wider mb-1 flex-shrink-0">
                      <span className="w-12 flex-shrink-0">Bike</span>
                      <span className="w-16 flex-shrink-0">Técnico</span>
                      <span className="flex-1 min-w-0">Reparo Realizado</span>
                      <span className="w-20 flex-shrink-0 text-center">Entrada</span>
                      <span className="w-4 flex-shrink-0 text-center"></span>
                      <span className="w-20 flex-shrink-0 text-center">Saída</span>
                    </div>
                    {filtered.map((r, i) => (
                      <div key={r.id || i} className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-gray-100 rounded-lg text-[10px]">
                        <span className="font-black text-gray-800 font-mono w-12 flex-shrink-0">{r.bikeNumber}</span>
                        <span className="text-blue-700 font-bold w-16 truncate flex-shrink-0" title={r.tecnico}>{r.tecnico}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-gray-500 truncate" title={r.treatment}>{r.treatment}</p>
                          {r.originalMechanic && r.originalMechanic !== '—' && (
                            <p className="text-orange-500 font-bold text-[8px] truncate" title={`Devolvida para ${r.originalMechanic}`}>
                              → Devolvida para {r.originalMechanic}
                            </p>
                          )}
                        </div>
                        <span className="text-orange-500 font-mono flex-shrink-0 w-20 text-center">{fmt(r.dataEntrada)}</span>
                        <span className="text-gray-300 flex-shrink-0 w-4 text-center">→</span>
                        <span className="text-green-600 font-mono flex-shrink-0 w-20 text-center">{fmt(r.dataSaida)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="p-3 border-t bg-gray-50 flex justify-between items-center flex-shrink-0">
                <span className="text-[10px] text-gray-400 font-bold">{filtered.length} registro(s)</span>
                <button onClick={() => setIsTechnicaHistoryOpen(false)}
                  className="px-4 py-2 bg-blue-900 text-white text-xs font-bold rounded-lg hover:bg-blue-800">Fechar</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal Histórico de Manutenções */}
      {isMechanicHistoryOpen && (() => {
        const fmt = (ts: any) => {
          if (!ts) return '—';
          const d = ts.toDate ? ts.toDate() : new Date(ts);
          if (isNaN(d.getTime())) return '—';
          return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };

        // Mecânicos únicos do histórico
        const uniqueMechanics = ['Todos', ...Array.from(new Set(mechanicHistory.map(r => r.mecanico).filter(Boolean)))
          .filter(name => normalizeForSearch(name) !== 'CAIO')
          .sort()];

        // Filtro por mecânico e data de saída
        const filtered = mechanicHistory.filter(r => {
          const ts = r.dataSaida?.toDate ? r.dataSaida.toDate() : new Date(r.dataSaida || 0);
          const recDate = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')}`;
          const matchDate = mechanicHistoryFilter.date ? recDate === mechanicHistoryFilter.date : true;
          const matchMechanic = mechanicHistoryFilter.mechanic === 'Todos' || r.mecanico === mechanicHistoryFilter.mechanic;
          return matchDate && matchMechanic;
        });

        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh] overflow-hidden">

              {/* Header */}
              <div className="bg-gray-800 p-4 text-white flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-2">
                  <CalendarIcon className="w-5 h-5"/>
                  <div>
                    <h2 className="text-base font-black">Histórico de Manutenções</h2>
                    <p className="text-[10px] opacity-60">Entrada → Saída para reserva</p>
                  </div>
                </div>
                <button onClick={() => setIsMechanicHistoryOpen(false)} className="p-1 hover:bg-white/20 rounded-full">
                  <XIcon className="w-5 h-5"/>
                </button>
              </div>

              {/* Filtros */}
              <div className="p-3 border-b bg-gray-50 flex gap-2 flex-shrink-0 flex-wrap">
                <div className="flex-1 min-w-[120px]">
                  <label className="text-[9px] font-black text-gray-400 uppercase block mb-1">Mecânico</label>
                  <select
                    value={mechanicHistoryFilter.mechanic}
                    onChange={e => setMechanicHistoryFilter(prev => ({ ...prev, mechanic: e.target.value }))}
                    className="w-full text-xs p-1.5 border rounded-lg bg-white font-bold text-gray-700 outline-none"
                  >
                    {uniqueMechanics.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="flex-1 min-w-[130px]">
                  <label className="text-[9px] font-black text-gray-400 uppercase block mb-1">Data de Saída</label>
                  <input
                    type="date"
                    value={mechanicHistoryFilter.date}
                    max={localDateStr()}
                    onChange={e => setMechanicHistoryFilter(prev => ({ ...prev, date: e.target.value }))}
                    className="w-full text-xs p-1.5 border rounded-lg bg-white font-bold text-gray-700 outline-none"
                  />
                </div>
                <div className="flex items-end gap-1">
                  <button
                    onClick={() => setMechanicHistoryFilter({ mechanic: 'Todos', date: localDateStr() })}
                    className="px-2 py-1.5 bg-gray-200 text-gray-600 text-[10px] font-bold rounded-lg hover:bg-gray-300 whitespace-nowrap"
                  >Hoje</button>
                  <button
                    onClick={() => setMechanicHistoryFilter(prev => ({ ...prev, date: '' }))}
                    className="px-2 py-1.5 bg-gray-100 text-gray-500 text-[10px] font-bold rounded-lg hover:bg-gray-200 whitespace-nowrap"
                  >Tudo</button>
                </div>
              </div>

              {/* Lista */}
              <div className="flex-1 overflow-y-auto p-3 flex flex-col">
                {isMechanicHistoryLoading ? (
                  <div className="text-center py-10 text-gray-400 text-sm">Carregando...</div>
                ) : filtered.length === 0 ? (
                  <div className="text-center py-10 text-gray-400 text-sm italic">Nenhum registro encontrado.</div>
                ) : (
                  <div className="space-y-1 flex-1">
                    {/* Cabeçalho da Tabela */}
                    <div className="flex items-center gap-1.5 px-3 py-1 bg-gray-100 rounded-lg text-[9px] font-black text-gray-400 uppercase tracking-wider mb-1 flex-shrink-0">
                      <span className="w-12 flex-shrink-0">Patrimônio</span>
                      <span className="w-20 flex-shrink-0">Mecânico</span>
                      <span className="flex-1 min-w-0">Reparo Realizado</span>
                      <span className="w-22 flex-shrink-0 text-center">Entrada</span>
                      <span className="w-4 flex-shrink-0"></span>
                      <span className="w-22 flex-shrink-0 text-center">Saída</span>
                    </div>

                    <div className="space-y-1 overflow-y-auto">
                      {filtered.map((r, i) => (
                        <div key={r.id || i} className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-100 rounded-lg text-[10px] hover:bg-gray-50/50">
                          <span className="font-black text-gray-800 font-mono w-12 flex-shrink-0">{r.bikeNumber}</span>
                          <span className="text-blue-600 font-bold w-20 truncate flex-shrink-0" title={r.mecanico}>{r.mecanico}</span>
                          <div className="flex-1 min-w-0 flex items-center gap-1">
                            <span className="text-gray-600 truncate" title={r.treatment || '—'}>{r.treatment || '—'}</span>
                            {r.trailerName && (
                              <span className="text-purple-600 font-bold flex-shrink-0 bg-purple-50 px-1 rounded text-[8px] whitespace-nowrap">{r.trailerName}</span>
                            )}
                          </div>
                          <span className="text-orange-500 font-mono w-22 flex-shrink-0 text-center whitespace-nowrap">{fmt(r.dataEntrada)}</span>
                          <span className="text-gray-300 w-4 flex-shrink-0 text-center flex-shrink-0">→</span>
                          <span className="text-green-600 font-mono w-22 flex-shrink-0 text-center whitespace-nowrap">{fmt(r.dataSaida)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="p-3 border-t bg-gray-50 flex justify-between items-center flex-shrink-0">
                <span className="text-[10px] text-gray-400 font-bold">{filtered.length} registro(s)</span>
                <button onClick={() => setIsMechanicHistoryOpen(false)}
                  className="px-4 py-2 bg-gray-800 text-white text-xs font-bold rounded-lg hover:bg-gray-700">
                  Fechar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <MechanicRepairModal isOpen={isMechanicRepairModalOpen} onClose={() => setIsMechanicRepairModalOpen(false)} onConfirm={handleFinalizeMechanicsRepair} isLoading={isLoading} bikeNumber={selectedMechanicBike?.patrimonio || ''}/>
      <MechanicSelectionModal isOpen={isMechanicSelectionModalOpen} onClose={() => setIsMechanicSelectionModalOpen(false)} onConfirm={handleMechanicSelectionConfirm} isLoading={isLoading} bikeNumber={selectedMechanicBike?.patrimonio || ''}/>
      <TrailerSelectionModal isOpen={isTrailerSelectionModalOpen} onClose={() => setIsTrailerSelectionModalOpen(false)}
        onConfirm={name => { handleOrganizeTrailer(selectedBikesForTrailer, name); setIsTrailerSelectionModalOpen(false); }}
        isLoading={isLoading} bikeNumbers={selectedBikesForTrailer}/>

      <DriverSelectionModal 
        isOpen={isDriverSelectionModalOpen} 
        onClose={() => { setIsDriverSelectionModalOpen(false); setSelectedActionForAssignment(null); }}
        onConfirm={handleAssignTrailerToDriver}
        isLoading={isLoading}
        drivers={motoristas.length > 0 ? motoristas.map(m => ({ name: m })) : driversSummary}
      />

      {/* Modal Boletim */}
      {isBoletimModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-gray-50 w-full max-w-2xl max-h-[90vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-white/20 animate-in zoom-in-95 duration-200">
            <div className="p-4 bg-white border-b flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <DocumentTextIcon className="w-5 h-5 text-blue-600" />
                </div>
                <h2 className="text-lg font-black text-gray-900 uppercase tracking-tight">Boletim de Bike</h2>
              </div>
              <button onClick={() => setIsBoletimModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-400">
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="bg-white p-4 rounded-xl border shadow-sm space-y-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={boletimSearchTerm}
                    onChange={e => setBoletimSearchTerm(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === 'Enter' && handleBoletimSearch()}
                    placeholder="Nº PATRIMÔNIO"
                    className="flex-1 p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none uppercase"
                  />
                  <button
                    onClick={handleBoletimSearch}
                    disabled={isBoletimLoading || !boletimSearchTerm.trim()}
                    className="px-4 bg-blue-600 text-white rounded-lg font-bold text-xs uppercase hover:bg-blue-700 disabled:bg-gray-200 transition-all flex items-center justify-center min-w-[100px]"
                  >
                    {isBoletimLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Consultar'}
                  </button>
                </div>

                {boletimResult && (
                  <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="bg-blue-50/50 rounded-xl p-4 border border-blue-100">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-0.5">
                          <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Patrimônio</p>
                          <p className="text-xs font-black text-blue-700">{boletimResult.patrimonio}</p>
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Chassi</p>
                          <p className="text-xs font-black text-gray-800">{boletimResult.chassi || '---'}</p>
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest">IMEI</p>
                          <p className="text-xs font-black text-gray-800">{boletimResult.imei || '---'}</p>
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Telefone</p>
                          <p className="text-xs font-black text-gray-800">{boletimResult.telefone || '---'}</p>
                        </div>
                        <div className="col-span-2 pt-2 border-t border-blue-100 mt-1">
                          <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest mb-1">Status Atual</p>
                          <div className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${
                            boletimResult.status?.toLowerCase().includes('disponível') ? 'bg-green-100 text-green-700' :
                            boletimResult.status?.toLowerCase().includes('oficina') ? 'bg-orange-100 text-orange-700' :
                            'bg-blue-100 text-blue-700'
                          }`}>
                            {boletimResult.status || 'NÃO INFORMADO'}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="border-t pt-4">
                      <div className="flex justify-between items-center mb-3">
                        <h3 className="text-xs font-black text-gray-700 uppercase tracking-tight flex items-center gap-2">
                          <DatabaseIcon className="w-3.5 h-3.5 text-blue-500" />
                          Histórico de Boletins
                        </h3>
                        <button
                          onClick={() => setShowBoletimForm(!showBoletimForm)}
                          className="px-2 py-1 bg-blue-50 text-blue-600 text-[9px] font-black uppercase rounded border border-blue-100 hover:bg-blue-100 transition-colors"
                        >
                          {showBoletimForm ? 'Cancelar' : 'Registrar B.O.'}
                        </button>
                      </div>

                      {showBoletimForm && (
                        <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 mb-4 space-y-3 animate-in fade-in zoom-in duration-200">
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-[8px] font-black text-gray-400 uppercase">Data do B.O.</label>
                              <input
                                type="date"
                                value={newBoletim.date}
                                onChange={e => setNewBoletim({ ...newBoletim, date: e.target.value })}
                                className="w-full p-2 bg-white border border-gray-200 rounded text-xs font-bold"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[8px] font-black text-gray-400 uppercase">Número do B.O.</label>
                              <input
                                type="text"
                                value={newBoletim.boNumber}
                                onChange={e => setNewBoletim({ ...newBoletim, boNumber: e.target.value.toUpperCase() })}
                                placeholder="Nº DO B.O."
                                className="w-full p-2 bg-white border border-gray-200 rounded text-xs font-bold uppercase"
                              />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <label className="text-[8px] font-black text-gray-400 uppercase">Quem Realizou</label>
                            <input
                              type="text"
                              value={newBoletim.author}
                              onChange={e => setNewBoletim({ ...newBoletim, author: e.target.value.toUpperCase() })}
                              placeholder="NOME DO RESPONSÁVEL"
                              className="w-full p-2 bg-white border border-gray-200 rounded text-xs font-bold uppercase"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[8px] font-black text-gray-400 uppercase">Resumo</label>
                            <textarea
                              value={newBoletim.summary}
                              onChange={e => setNewBoletim({ ...newBoletim, summary: e.target.value })}
                              placeholder="BREVE RESUMO DO OCORRIDO..."
                              className="w-full p-2 bg-white border border-gray-200 rounded text-xs font-bold h-16 resize-none"
                            />
                          </div>
                          <button
                            onClick={handleSaveBoletim}
                            disabled={isBoletimLoading}
                            className="w-full py-2 bg-blue-600 text-white text-[10px] font-black uppercase rounded hover:bg-blue-700 disabled:bg-gray-300 transition-all flex items-center justify-center gap-2"
                          >
                            {isBoletimLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Salvar Registro'}
                          </button>
                        </div>
                      )}

                      <div className="space-y-2">
                        {isBoletimRecordsLoading ? (
                          <div className="flex justify-center py-4">
                            <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                          </div>
                        ) : boletimRecords.length > 0 ? (
                          boletimRecords.map((rec: any, idx: number) => (
                            <div key={idx} className="p-3 bg-white rounded-lg border border-gray-100 shadow-sm hover:border-blue-200 transition-colors">
                              <div className="flex justify-between items-start mb-2">
                                <div>
                                  <span className="text-[10px] font-black text-blue-600 uppercase bg-blue-50 px-1.5 py-0.5 rounded">B.O. {rec.boNumber}</span>
                                  <p className="text-[10px] text-gray-400 mt-1">Data: {new Date(rec.date).toLocaleDateString()} • Por: {rec.author}</p>
                                </div>
                              </div>
                              {rec.summary && <p className="text-xs text-gray-600 leading-relaxed bg-gray-50 p-2 rounded italic">"{rec.summary}"</p>}
                            </div>
                          ))
                        ) : (
                          <div className="text-center py-8 bg-gray-50 rounded-xl border border-dashed">
                            <p className="text-gray-400 text-xs italic">Nenhum B.O. registrado para esta bike.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ADM Edit Mechanic Bikes Modal */}
      {editingMechanic && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="p-4 border-b bg-gray-50 flex justify-between items-center flex-shrink-0">
              <div>
                <h2 className="text-lg font-black text-gray-800">Gerenciar Mecânico</h2>
                <p className="text-xs text-blue-600 font-mono uppercase tracking-wider">{editingMechanic}</p>
              </div>
              <button 
                onClick={() => {
                  setEditingMechanic(null);
                  setNewBikeNumber('');
                }} 
                className="p-1.5 hover:bg-gray-200 rounded-full transition-colors"
              >
                <XIcon className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 flex-grow overflow-y-auto space-y-4">
              
              {/* Add Bike Form */}
              <div className="bg-gray-50 p-3 rounded-xl border border-gray-100 space-y-2">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Adicionar Bike para Manutenção</p>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    value={newBikeNumber}
                    onChange={(e) => setNewBikeNumber(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdminAddBikeToMechanic()}
                    placeholder="Nº da bike (ex: 150)"
                    className="flex-grow p-2 border rounded-lg text-xs font-mono font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  
                  {/* Choice Status */}
                  <select
                    value={editingStatusChoice}
                    onChange={(e) => setEditingStatusChoice(e.target.value as any)}
                    className="p-2 border rounded-lg text-xs font-bold bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="Em Manutenção">Manutenção</option>
                    <option value="Reserva">Reserva</option>
                  </select>

                  <button 
                    onClick={handleAdminAddBikeToMechanic}
                    disabled={isAdminBikeAdding}
                    className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center min-w-[36px]"
                  >
                    {isAdminBikeAdding ? (
                      <Loader2 className="w-4 h-4 animate-spin text-white" />
                    ) : (
                      <PlusIcon className="w-4 h-4 text-white" />
                    )}
                  </button>
                </div>
              </div>

              {/* Current Bikes List */}
              <div>
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">Bikes Atuais</p>
                <div className="space-y-2">
                  {(() => {
                    const currentBikes = mechanicsList.filter(
                      b => (b.status === 'Em Manutenção' || b.status === 'Reserva') && 
                           b.mecanico && b.mecanico.toUpperCase() === editingMechanic.toUpperCase()
                    );
                    if (currentBikes.length === 0) {
                      return (
                        <p className="text-center py-6 text-gray-400 text-xs italic bg-gray-50/50 rounded-lg border border-dashed border-gray-200">
                          Nenhuma bike em manutenção com {editingMechanic}.
                        </p>
                      );
                    }
                    return currentBikes.map(b => (
                      <div key={b.patrimonio} className="flex justify-between items-center p-2.5 bg-white border rounded-xl shadow-sm hover:border-gray-300 transition-all">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-black text-gray-800">{b.patrimonio}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${
                            b.status === 'Em Manutenção' ? 'bg-orange-100 text-orange-700 border border-orange-200' : 'bg-green-100 text-green-700 border border-green-200'
                          }`}>
                            {b.status}
                          </span>
                        </div>
                        
                        {/* Remove Actions */}
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleAdminRemoveBikeFromMechanic(b.patrimonio, 'unassign')}
                            disabled={!!adminBikeActionLoading}
                            title="Voltar para Aguardando Manutenção"
                            className="px-2 py-1 text-[9px] font-bold text-blue-600 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-md transition-colors disabled:opacity-50 animate-pulse-subtle"
                          >
                            {adminBikeActionLoading === b.patrimonio ? '...' : 'Liberar / Aguardando'}
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`Excluir totalmente a bike ${b.patrimonio} do fluxo da oficina?`)) {
                                handleAdminRemoveBikeFromMechanic(b.patrimonio, 'delete');
                              }
                            }}
                            disabled={!!adminBikeActionLoading}
                            title="Remover completamente da oficina"
                            className="p-1 text-red-600 hover:bg-red-50 hover:text-red-700 border border-transparent hover:border-red-200 rounded-md transition-colors disabled:opacity-50 animate-pulse-subtle"
                          >
                            <TrashIcon className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>

            </div>

            {/* Footer */}
            <div className="p-4 border-t bg-gray-50 flex-shrink-0">
              <button 
                onClick={() => {
                  setEditingMechanic(null);
                  setNewBikeNumber('');
                }}
                className="w-full py-2.5 bg-gray-200 text-gray-700 rounded-xl text-xs font-black uppercase hover:bg-gray-300 transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Almoxarifado (Warehouse Stock Control) Main Modal */}
      {isAlmoxarifadoOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col h-[85vh]">
            {/* Header */}
            <div className="p-4 sm:p-5 border-b bg-gray-50 flex justify-between items-center flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-blue-100 rounded-xl text-blue-700">
                  <Package className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-lg font-black text-gray-800 uppercase tracking-tight">Controle de Almoxarifado</h2>
                  <p className="text-xs text-gray-500 font-medium">Estoque, Entradas e Saídas da Oficina</p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setIsAlmoxarifadoOpen(false);
                  setIsAddingNewItem(false);
                  setMovingItem(null);
                  setViewingHistoryItem(null);
                }} 
                className="p-1.5 hover:bg-gray-200 rounded-full transition-colors"
              >
                <XIcon className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {/* Subheader Toolbar */}
            <div className="p-4 border-b bg-white flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between flex-shrink-0">
              {/* Search Box */}
              <div className="relative flex-grow max-w-md">
                <input
                  type="text"
                  placeholder="Pesquisar por código, descrição ou fornecedor..."
                  value={almoxarifadoSearch}
                  onChange={(e) => setAlmoxarifadoSearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-xl text-xs font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all shadow-sm"
                />
                <div className="absolute left-3 top-2.5 text-gray-400">
                  <LucideMap className="w-4 h-4" /> {/* Fallback icon, search/magnifier is fine but we can just use LucideMap or similar */}
                </div>
              </div>

              {/* Add Item Button */}
              <button
                onClick={() => setIsAddingNewItem(true)}
                className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-xs font-black uppercase rounded-xl shadow-sm transition-all"
              >
                <Plus className="w-4 h-4 text-white" />
                Cadastrar Item
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="flex-grow overflow-y-auto p-4 sm:p-5 bg-gray-50/50 space-y-4">
              {/* Informative Panel & Alerts */}
              {(() => {
                const lowStock = almoxarifadoItems.filter(item => {
                  const min = item.qtdMinima ?? 0;
                  return item.quantidade <= min;
                });

                const itemStats = almoxarifadoItems.map(item => {
                  const history = item.historico || [];
                  const retiradas = history.filter((h: any) => h.tipo === 'retirada');
                  const totalWithdrawn = retiradas.reduce((sum: number, h: any) => sum + Number(h.quantidade), 0);
                  
                  // Calculate unique months with withdrawals (e.g. YYYY-MM format)
                  const monthsWithWithdrawals = new Set<string>();
                  retiradas.forEach((h: any) => {
                    if (h.data && h.data.length >= 7) {
                      monthsWithWithdrawals.add(h.data.substring(0, 7));
                    }
                  });
                  const monthsCount = monthsWithWithdrawals.size || 1;
                  const avgMonthly = totalWithdrawn / monthsCount;

                  return {
                    id: item.id,
                    codigo: item.codigo,
                    descricao: item.descricao,
                    totalWithdrawn,
                    avgMonthly
                  };
                }).filter(stat => stat.totalWithdrawn > 0)
                  .sort((a, b) => b.avgMonthly - a.avgMonthly);

                return (
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 shadow-md flex flex-col md:flex-row gap-4 text-xs">
                    {/* Alertas / Lembrete de Compra */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-2 font-black text-slate-300 uppercase tracking-wider text-[10px]">
                        <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                        <span>Itens com Estoque Crítico ({lowStock.length})</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                        {lowStock.length === 0 ? (
                          <span className="text-[10px] text-green-400 font-bold bg-green-950/30 px-2 py-0.5 rounded-lg border border-green-900/30">
                            ✓ Todo o estoque regular
                          </span>
                        ) : (
                          lowStock.map(item => (
                            <div key={item.id} className="flex items-center gap-1.5 px-2 py-0.5 bg-red-950/40 text-red-200 rounded-lg text-[10px] border border-red-900/30 font-bold">
                              <span className="font-mono font-black text-red-400 uppercase">{item.codigo}</span>
                              <span className="opacity-40 font-normal">|</span>
                              <span>{item.quantidade} un <span className="opacity-40 font-normal">/</span> mín {item.qtdMinima ?? 0}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="hidden md:block w-px bg-slate-800 self-stretch" />

                    {/* Consumo Médio Mensal */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-2 font-black text-slate-300 uppercase tracking-wider text-[10px]">
                        <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                        <span>Consumo Médio Mensal</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                        {itemStats.length === 0 ? (
                          <span className="text-[10px] text-slate-400 italic bg-slate-850 px-2 py-0.5 rounded-lg border border-slate-800/80">
                            Sem consumo registrado
                          </span>
                        ) : (
                          itemStats.slice(0, 6).map(stat => (
                            <div key={stat.id} className="flex items-center gap-1.5 px-2 py-0.5 bg-blue-950/30 text-blue-200 rounded-lg text-[10px] border border-blue-900/30 font-bold">
                              <span className="font-mono font-black text-blue-400 uppercase">{stat.codigo}</span>
                              <span className="opacity-40 font-normal">|</span>
                              <span>{stat.avgMonthly.toFixed(1)} un/mês</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Main List Table / Grid */}
              {(() => {
                const filtered = almoxarifadoItems.filter(item => {
                  const queryLower = almoxarifadoSearch.toLowerCase().trim();
                  if (!queryLower) return true;
                  return (
                    (item.codigo || '').toLowerCase().includes(queryLower) ||
                    (item.descricao || '').toLowerCase().includes(queryLower) ||
                    (item.fornecedor || '').toLowerCase().includes(queryLower)
                  );
                });

                if (filtered.length === 0) {
                  return (
                    <div className="flex flex-col items-center justify-center py-12 text-center bg-white rounded-2xl border border-dashed border-gray-200 shadow-sm">
                      <Inbox className="w-12 h-12 text-gray-300 mb-2" />
                      <p className="text-gray-500 text-sm font-bold">Nenhum item encontrado</p>
                      <p className="text-gray-400 text-xs mt-1">Experimente mudar o termo de busca ou cadastre um novo item.</p>
                    </div>
                  );
                }

                return (
                  <div className="bg-white rounded-2xl border border-gray-150 shadow-sm overflow-hidden">
                    {/* Desktop Table View */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-gray-50 text-[10px] font-black text-gray-500 uppercase tracking-wider border-b">
                            <th className="py-3.5 px-4 w-28">Código</th>
                            <th className="py-3.5 px-4">Descrição</th>
                            <th className="py-3.5 px-4 w-44">Fornecedor</th>
                            <th className="py-3.5 px-4 w-32 text-center">Quantidade</th>
                            <th className="py-3.5 px-4 w-32 text-center">Mín. Estoque</th>
                            <th className="py-3.5 px-4 w-48 text-right">Ações</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 text-xs font-medium text-gray-700">
                          {filtered.map((item) => (
                            <tr key={item.id} className="hover:bg-gray-50/50 transition-colors">
                              <td className="py-3 px-4 font-mono font-black text-blue-600 uppercase">
                                {item.codigo}
                              </td>
                              <td className="py-3 px-4">
                                <div className="font-bold text-gray-900">{item.descricao}</div>
                              </td>
                              <td className="py-3 px-4 text-gray-500">
                                {item.fornecedor}
                              </td>
                              <td className="py-3 px-4 text-center">
                                <span className={`inline-block px-3 py-1 rounded-full font-black text-xs font-mono ${
                                  item.quantidade <= (item.qtdMinima ?? 0)
                                    ? 'bg-red-100 text-red-700 font-bold' 
                                    : item.quantidade < (item.qtdMinima ?? 0) + 5
                                      ? 'bg-orange-100 text-orange-700' 
                                      : 'bg-green-100 text-green-700'
                                }`}>
                                  {item.quantidade}
                                </span>
                              </td>
                              <td className="py-3 px-4 text-center">
                                <input
                                  type="number"
                                  min="0"
                                  defaultValue={item.qtdMinima ?? 0}
                                  onBlur={async (e) => {
                                    const val = Number(e.target.value);
                                    if (val !== (item.qtdMinima ?? 0)) {
                                      await handleUpdateMinStock(item.id, val);
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      (e.target as HTMLInputElement).blur();
                                    }
                                  }}
                                  className="w-16 p-1 border border-gray-250 rounded-lg text-center text-xs font-black font-mono focus:ring-2 focus:ring-blue-500 outline-none"
                                />
                              </td>
                              <td className="py-3 px-4 text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                  {/* Plus Button */}
                                  <button
                                    onClick={() => {
                                      setMovingItem(item);
                                      setMovementTipo('entrada');
                                      setMovementQuantidade('');
                                      setMovementUsuario('');
                                    }}
                                    title="Dar Entrada"
                                    className="p-1.5 bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 active:scale-95 rounded-lg transition-all shadow-sm"
                                  >
                                    <Plus className="w-4 h-4" />
                                  </button>
 
                                  {/* Minus Button */}
                                  <button
                                    onClick={() => {
                                      setMovingItem(item);
                                      setMovementTipo('retirada');
                                      setMovementQuantidade('');
                                      setMovementUsuario('');
                                    }}
                                    title="Retirar Item"
                                    className="p-1.5 bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100 active:scale-95 rounded-lg transition-all shadow-sm"
                                  >
                                    <Minus className="w-4 h-4" />
                                  </button>
 
                                  {/* History Button */}
                                  <button
                                    onClick={() => setViewingHistoryItem(item)}
                                    className="px-2 py-1.5 text-[10px] font-black uppercase text-blue-600 hover:bg-blue-50 border border-blue-100 hover:border-blue-200 rounded-lg transition-all"
                                  >
                                    Histórico
                                  </button>
 
                                  {/* Trash Button */}
                                  <button
                                    onClick={() => handleDeleteAlmoxarifadoItem(item.id, item.descricao)}
                                    className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-100 rounded-lg transition-all"
                                    title="Excluir item"
                                  >
                                    <TrashIcon className="w-4 h-4" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
 
                    {/* Mobile Card-List View */}
                    <div className="block md:hidden divide-y">
                      {filtered.map((item) => (
                        <div key={item.id} className="p-4 space-y-3">
                          <div className="flex justify-between items-start">
                            <div>
                              <span className="font-mono font-black text-blue-600 uppercase text-xs">{item.codigo}</span>
                              <h4 className="font-bold text-gray-900 text-sm mt-0.5">{item.descricao}</h4>
                              <p className="text-[10px] text-gray-500 font-medium">Fornecedor: {item.fornecedor}</p>
                              
                              <div className="flex items-center gap-1.5 mt-2">
                                <span className="text-[10px] font-black text-gray-500 uppercase">Mín. Estoque:</span>
                                <input
                                  type="number"
                                  min="0"
                                  defaultValue={item.qtdMinima ?? 0}
                                  onBlur={async (e) => {
                                    const val = Number(e.target.value);
                                    if (val !== (item.qtdMinima ?? 0)) {
                                      await handleUpdateMinStock(item.id, val);
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      (e.target as HTMLInputElement).blur();
                                    }
                                  }}
                                  className="w-14 p-0.5 border border-gray-250 rounded text-center text-xs font-black font-mono focus:ring-1 focus:ring-blue-500 outline-none"
                                />
                              </div>
                            </div>
                            <span className={`px-2.5 py-1 rounded-full font-black text-xs font-mono ${
                              item.quantidade <= (item.qtdMinima ?? 0)
                                ? 'bg-red-100 text-red-700' 
                                : item.quantidade < (item.qtdMinima ?? 0) + 5
                                  ? 'bg-orange-100 text-orange-700' 
                                  : 'bg-green-100 text-green-700'
                            }`}>
                              {item.quantidade} un
                            </span>
                          </div>
 
                          <div className="flex items-center justify-between border-t pt-2.5">
                            <button
                              onClick={() => setViewingHistoryItem(item)}
                              className="text-[10px] font-black uppercase text-blue-600 bg-blue-50/50 border border-blue-100 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-all"
                            >
                              Histórico
                            </button>
 
                            <div className="flex items-center gap-1.5">
                              {/* Plus */}
                              <button
                                onClick={() => {
                                  setMovingItem(item);
                                  setMovementTipo('entrada');
                                  setMovementQuantidade('');
                                  setMovementUsuario('');
                                }}
                                className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-[10px] font-black uppercase transition-all shadow-sm"
                              >
                                <Plus className="w-3.5 h-3.5 text-white" />
                                Entrada
                              </button>
 
                              {/* Minus */}
                              <button
                                onClick={() => {
                                  setMovingItem(item);
                                  setMovementTipo('retirada');
                                  setMovementQuantidade('');
                                  setMovementUsuario('');
                                }}
                                className="flex items-center gap-1 px-3 py-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-[10px] font-black uppercase transition-all shadow-sm"
                              >
                                <Minus className="w-3.5 h-3.5 text-white" />
                                Retirada
                              </button>
 
                              {/* Trash */}
                              <button
                                onClick={() => handleDeleteAlmoxarifadoItem(item.id, item.descricao)}
                                className="p-1.5 text-red-500 border border-transparent rounded-lg hover:bg-red-50"
                              >
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Footer */}
            <div className="p-4 sm:p-5 border-t bg-gray-50 flex-shrink-0">
              <button 
                onClick={() => setIsAlmoxarifadoOpen(false)}
                className="w-full py-2.5 bg-gray-200 text-gray-700 rounded-xl text-xs font-black uppercase hover:bg-gray-300 transition-colors shadow-sm"
              >
                Fechar Painel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Almoxarifado: Cadastrar Novo Item Modal */}
      {isAddingNewItem && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="p-4 border-b bg-gray-50 flex justify-between items-center">
              <div>
                <h3 className="text-md font-black text-gray-800 uppercase tracking-tight">Cadastrar Item no Almoxarifado</h3>
                <p className="text-xs text-gray-500 font-medium">Insira as informações básicas para controle de estoque</p>
              </div>
              <button 
                onClick={() => setIsAddingNewItem(false)} 
                className="p-1 hover:bg-gray-200 rounded-full transition-colors"
              >
                <XIcon className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4 space-y-3.5">
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-wider mb-1">Código do Item *</label>
                <input
                  type="text"
                  placeholder="Ex: PARAFUSO-M8, CORREIA-120"
                  value={newItemCodigo}
                  onChange={(e) => setNewItemCodigo(e.target.value)}
                  className="w-full p-2.5 border rounded-xl text-xs font-bold uppercase focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-wider mb-1">Descrição / Nome do Item *</label>
                <input
                  type="text"
                  placeholder="Ex: Parafuso Sextavado M8x20mm"
                  value={newItemDescricao}
                  onChange={(e) => setNewItemDescricao(e.target.value)}
                  className="w-full p-2.5 border rounded-xl text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-wider mb-1">Fornecedor *</label>
                <input
                  type="text"
                  placeholder="Ex: Parafusos LTDA ou Distribuidor X"
                  value={newItemFornecedor}
                  onChange={(e) => setNewItemFornecedor(e.target.value)}
                  className="w-full p-2.5 border rounded-xl text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-wider mb-1">Quantidade Inicial</label>
                <input
                  type="number"
                  min="0"
                  placeholder="Ex: 50"
                  value={newItemQuantidade}
                  onChange={(e) => setNewItemQuantidade(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full p-2.5 border rounded-xl text-xs font-black font-mono focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-wider mb-1">Quantidade Mínima de Estoque</label>
                <input
                  type="number"
                  min="0"
                  placeholder="Ex: 5"
                  value={newItemQtdMinima}
                  onChange={(e) => setNewItemQtdMinima(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full p-2.5 border rounded-xl text-xs font-black font-mono focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
            </div>

            <div className="p-4 border-t bg-gray-50 flex gap-2">
              <button
                onClick={() => setIsAddingNewItem(false)}
                className="flex-1 py-2 bg-gray-200 text-gray-700 rounded-xl text-xs font-black uppercase hover:bg-gray-300 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleAddNewAlmoxarifadoItem}
                disabled={isSubmittingNewItem}
                className="flex-1 py-2 bg-blue-600 text-white rounded-xl text-xs font-black uppercase hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {isSubmittingNewItem ? (
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                ) : (
                  'Salvar Cadastro'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Almoxarifado: Movimentação (Entrada/Retirada) Modal */}
      {movingItem && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="p-4 border-b bg-gray-50 flex justify-between items-center">
              <div>
                <h3 className="text-md font-black text-gray-800 uppercase tracking-tight flex items-center gap-1.5">
                  {movementTipo === 'entrada' ? (
                    <span className="text-green-600 font-black">Registrar Entrada</span>
                  ) : (
                    <span className="text-orange-600 font-black">Registrar Retirada / Saída</span>
                  )}
                </h3>
                <p className="text-xs text-gray-500 font-mono mt-0.5 uppercase tracking-wide">
                  Item: {movingItem.descricao} ({movingItem.codigo})
                </p>
              </div>
              <button 
                onClick={() => setMovingItem(null)} 
                className="p-1 hover:bg-gray-200 rounded-full transition-colors"
              >
                <XIcon className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Actual Stock info */}
              <div className="bg-blue-50/50 p-2.5 rounded-xl border border-blue-100 flex justify-between items-center text-xs">
                <span className="font-bold text-blue-800">Saldo Atual em Estoque:</span>
                <span className="font-mono font-black text-blue-700 text-sm">{movingItem.quantidade} un</span>
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-wider mb-1">Quantidade *</label>
                <input
                  type="number"
                  min="1"
                  placeholder="Ex: 5"
                  value={movementQuantidade}
                  onChange={(e) => setMovementQuantidade(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full p-2.5 border rounded-xl text-xs font-black font-mono focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-wider mb-1">
                  {movementTipo === 'entrada' ? 'Responsável pela Entrada *' : 'Nome de quem está consumindo *'}
                </label>
                <input
                  type="text"
                  placeholder="Ex: Kauan, João, Rafael..."
                  value={movementUsuario}
                  onChange={(e) => setMovementUsuario(e.target.value)}
                  className="w-full p-2.5 border rounded-xl text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-wider mb-1">Data da Retirada/Entrada *</label>
                <input
                  type="date"
                  value={movementData}
                  onChange={(e) => setMovementData(e.target.value)}
                  className="w-full p-2.5 border rounded-xl text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
            </div>

            <div className="p-4 border-t bg-gray-50 flex gap-2">
              <button
                onClick={() => setMovingItem(null)}
                className="flex-1 py-2 bg-gray-200 text-gray-700 rounded-xl text-xs font-black uppercase hover:bg-gray-300 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleRegisterStockMovement}
                disabled={isSubmittingMovement}
                className={`flex-1 py-2 text-white rounded-xl text-xs font-black uppercase transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 ${
                  movementTipo === 'entrada' ? 'bg-green-600 hover:bg-green-700' : 'bg-orange-500 hover:bg-orange-600'
                }`}
              >
                {isSubmittingMovement ? (
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                ) : (
                  'Salvar Movimentação'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Almoxarifado: Histórico do Item Modal */}
      {viewingHistoryItem && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col h-[70vh]">
            <div className="p-4 border-b bg-gray-50 flex justify-between items-center flex-shrink-0">
              <div>
                <h3 className="text-md font-black text-gray-800 uppercase tracking-tight">Histórico de Movimentações</h3>
                <p className="text-xs text-gray-500 font-mono mt-0.5 uppercase tracking-wide">
                  Item: {viewingHistoryItem.descricao} ({viewingHistoryItem.codigo})
                </p>
              </div>
              <button 
                onClick={() => setViewingHistoryItem(null)} 
                className="p-1 hover:bg-gray-200 rounded-full transition-colors"
              >
                <XIcon className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {/* Scrollable Logs */}
            <div className="flex-grow overflow-y-auto p-4 space-y-3 bg-gray-50/50">
              {(!viewingHistoryItem.historico || viewingHistoryItem.historico.length === 0) ? (
                <div className="text-center py-12 bg-white rounded-xl border border-dashed border-gray-200">
                  <p className="text-xs text-gray-400 font-medium italic">Nenhuma movimentação registrada para este item.</p>
                </div>
              ) : (
                viewingHistoryItem.historico.map((log: any) => (
                  <div key={log.id} className="bg-white p-3.5 rounded-xl border border-gray-150 shadow-sm flex justify-between items-center gap-4">
                    <div className="flex items-center gap-3">
                      <div className={`p-1.5 rounded-full ${
                        log.tipo === 'entrada' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                      }`}>
                        {log.tipo === 'entrada' ? <Plus className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-xs text-gray-900 capitalize">{log.tipo}</span>
                          <span className={`text-[10px] font-black font-mono px-1.5 py-0.5 rounded ${
                            log.tipo === 'entrada' ? 'bg-green-50 text-green-700' : 'bg-orange-50 text-orange-700'
                          }`}>
                            {log.tipo === 'entrada' ? '+' : '-'}{log.quantidade} un
                          </span>
                        </div>
                        <p className="text-[10px] text-gray-500 font-medium mt-0.5">
                          Responsável/Consumidor: <strong className="text-gray-700 font-bold">{log.usuario}</strong>
                        </p>
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <span className="text-[10px] font-mono font-black text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
                        {log.data ? log.data.split('-').reverse().join('/') : '—'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="p-4 border-t bg-gray-50 flex-shrink-0">
              <button
                onClick={() => setViewingHistoryItem(null)}
                className="w-full py-2.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-xl text-xs font-black uppercase transition-colors"
              >
                Voltar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
};

export default MainScreen;