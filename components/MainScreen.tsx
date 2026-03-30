import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { BicycleData, PickupRequest, DriverLocation } from '../types';
import {
  LogoutIcon, PlusIcon, PlusPlusIcon, MapIcon, SheetIcon, SearchIcon,
  AlertIcon, CalendarIcon, CarIcon, XIcon, BicycleIcon, MovingIcon,
  UserIcon, AlertTriangleIcon, QrCodeIcon, SwitchIcon,
  RefreshIcon, DatabaseIcon, CheckCircleIcon, DocumentTextIcon
} from './icons';
import { 
  Settings, Battery, Lock, Map as MapIconLucide, 
  WifiOff, AlertCircle, RefreshCw, ChevronUp, ChevronDown, ChevronLeft, 
  ChevronRight, Circle, Play, Locate, Map, Wrench, Loader2
} from 'lucide-react';
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode';
import { auth, db } from '../firebase';
import { signInWithPopup, GoogleAuthProvider, signInAnonymously } from 'firebase/auth';
import {
  collection, onSnapshot, doc, updateDoc, addDoc, getDocs,
  serverTimestamp, setDoc, query, where
} from 'firebase/firestore';
import ScheduleModal from './ScheduleModal';
import ReporModal from './ReporModal';
import MechanicRepairModal from './MechanicRepairModal';
import MechanicSelectionModal from './MechanicSelectionModal';
import DriverSelectionModal from './DriverSelectionModal';
import RequestModal from './RequestModal';
import ReportModal from './ReportModal';
import RouteModal from './RouteModal';
import DestinationModal from './DestinationModal';
import HistoryModal from './HistoryModal';
import VehicleSwitchModal from './VehicleSwitchModal';
import EditDriverModal from './EditDriverModal';
import { apiCall, apiGetCall } from '../api';
import { User } from '../types';
import { migrateDataToFirebase } from '../migrationService';

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
const DRIVER_ACTION_GRACE_MS = 20000; // 20 segundos — cobre latência do Apps Script em fire-and-forget

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
  if (coord >= -180 && coord <= 180) return coord;
  let val = coord;
  while (Math.abs(val) > 180) val /= 10;
  return val;
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

// =================================================================
// COMPONENTE PRINCIPAL
// =================================================================

// Helper: data local no formato YYYY-MM-DD (evita problema de fuso UTC)
const localDateStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

// =================================================================
// --- ADMIN ALERTS COMPONENT (inline) ---
// =================================================================
const AdminAlerts: React.FC<{adminName: string, isOpen: boolean, onClose: () => void}> = ({ adminName, isOpen, onClose }) => {
  const [admAlerts, setAdmAlerts] = React.useState<any[]>([]);
  const [admLoading, setAdmLoading] = React.useState(false);
  const fetchAdmAlerts = async () => {
    if (!adminName) return;
    setAdmLoading(true);
    try { const r = await apiCall({ action: 'getAdminAlerts', adminName }); if (r.success) setAdmAlerts(r.alerts || []); }
    catch {} finally { setAdmLoading(false); }
  };
  const clearAdmAlerts = async () => {
    if (!confirm('Confirmar leitura de todos os alertas?')) return;
    setAdmLoading(true);
    try { const r = await apiCall({ action: 'clearAdminAlerts', adminName }); if (r.success) setAdmAlerts([]); }
    catch {} finally { setAdmLoading(false); }
  };
  React.useEffect(() => {
    if (isOpen) { fetchAdmAlerts(); const t = setInterval(fetchAdmAlerts, 10000); return () => clearInterval(t); }
  }, [isOpen, adminName]);
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[80vh]">
        <div className="p-4 border-b flex items-center justify-between bg-red-50">
          <div className="flex items-center gap-2 text-red-700">
            <AlertTriangleIcon className="w-6 h-6"/>
            <h2 className="text-lg font-bold">Alertas e Notificações</h2>
          </div>
          <div className="flex gap-2">
            {admAlerts.length > 0 && <button onClick={clearAdmAlerts} disabled={admLoading} className="p-2 text-gray-500 hover:text-red-600" title="Limpar alertas"><svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>}
            <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-700"><XIcon className="w-6 h-6"/></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {admLoading && admAlerts.length === 0 ? <div className="text-center py-8 text-gray-400">Carregando...</div>
          : admAlerts.length === 0 ? <div className="text-center py-12 text-gray-500 italic">Nenhum alerta no momento.</div>
          : admAlerts.map((a: any) => (
            <div key={a.id} className="p-3 bg-red-50 border-l-4 border-red-500 rounded-r-lg">
              <p className="text-red-900 font-medium text-xs">{a.msg}</p>
              <p className="text-[10px] text-red-400 mt-1">{new Date(a.time).toLocaleString('pt-BR', {hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'})}</p>
            </div>
          ))}
        </div>
        <div className="p-4 border-t bg-gray-50 flex justify-end">
          <button onClick={onClose} className="px-6 py-2 bg-white border border-gray-300 rounded-xl text-gray-700 hover:bg-gray-100">Fechar</button>
        </div>
      </div>
    </div>
  );
};

const MainScreen: React.FC<MainScreenProps> = ({
  driverName, category, plate, kmInicial, onLogout, onShowMap, onUpdateUser
}) => {
  // --- UI State ---
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncFailCountRef = useRef(0); // só exibe erro após 3 falhas consecutivas
  const [lastSyncTime, setLastSyncTime] = useState(new Date().toLocaleTimeString());
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState<{ text: string, type: 'success' | 'error' | 'info' } | null>(null);

  // --- Dados principais ---
  const [routeBikes, setRouteBikes] = useState<string[]>([]);
  const [collectedBikes, setCollectedBikes] = useState<string[]>([]);
  const [routeBikesDetails, setRouteBikesDetails] = useState<Record<string, any>>({});
  const [collectedBikesDetails, setCollectedBikesDetails] = useState<Record<string, any>>({});
  const [pendingRequests, setPendingRequests] = useState<PickupRequest[]>([]);
  const [stations, setStations] = useState<any[]>([]);
  const [motoristas, setMotoristas] = useState<string[]>([]);
  const [driverLocations, setDriverLocations] = useState<DriverLocation[]>([]);
  const [bikeConflicts, setBikeConflicts] = useState<Record<string, any>>({});
  const [currentDriverLocation, setCurrentDriverLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [routeDistances, setRouteDistances] = useState<Record<string, { distance: string, duration: string, value: number, isRoad?: boolean }>>({});

  // --- Modais ---
  const [isRequestModalOpen, setRequestModalOpen] = useState(false);
  const [isRouteModalOpen, setRouteModalOpen] = useState(false);
  const [isReportModalOpen, setReportModalOpen] = useState(false);
  const [isVehicleModalOpen, setIsVehicleModalOpen] = useState(false);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [isAdminAlertsOpen, setIsAdminAlertsOpen] = useState(false);
  const [isForceReloading, setIsForceReloading] = useState(false);
  const [isReporModalOpen, setIsReporModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isEditDriverModalOpen, setIsEditDriverModalOpen] = useState(false);
  const [isNotFoundConfirmOpen, setIsNotFoundConfirmOpen] = useState(false);
  const [isMechanicRepairModalOpen, setIsMechanicRepairModalOpen] = useState(false);
  const [technicaList, setTechnicaList] = useState<any[]>([]);
  const [isTechnicaLoading, setIsTechnicaLoading] = useState(false);
  const [technicaReceiptModal, setTechnicaReceiptModal] = useState<{ bikeNumber: string; originalMechanic: string } | null>(null);
  const [technicaRepairModal, setTechnicaRepairModal] = useState<{ bike: any } | null>(null);
  const [technicaRepairSelected, setTechnicaRepairSelected] = useState<Set<string>>(new Set());
  const TECNICA_TECHNICIANS = ['Diego', 'Juliano'];
  const TECNICA_REPAIR_OPTIONS = [
    'CARCAÇA FRONTAL', 'CARCAÇA TRASEIRA', 'TRAVA', 'MOTOR TRAVADO',
    'SENSORES', 'ALTO FALANTE', 'CABO DE ENERGIA', 'BATERIA',
    'ATUALIZAÇÃO DE SOFTWARE', 'RESET DO LOCKER', 'PROTEÇÃO COMPLETA', 'QRCODE'
  ];
  const [isMechanicSelectionModalOpen, setIsMechanicSelectionModalOpen] = useState(false);
  const [isDriverSelectionModalOpen, setIsDriverSelectionModalOpen] = useState(false);
  const [selectedActionForAssignment, setSelectedActionForAssignment] = useState<any>(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [destinationModal, setDestinationModal] = useState<{
    isOpen: boolean; bikeNumber: string;
    type: 'Estação' | 'Filial' | 'Vandalizada'; stationName?: string;
  }>({ isOpen: false, bikeNumber: '', type: 'Estação' });

  // --- Dados ADM ---
  const [driversSummary, setDriversSummary] = useState<any[]>([]);
  const [firebaseTimelineEvents, setFirebaseTimelineEvents] = useState<Record<string, Array<{tsMs: number, type: string, bikeNumber?: string}>>>({});
  const [timelineModal, setTimelineModal] = useState<{driver: string, events: any[], startMs: number, endMs: number} | null>(null);
  const [timelineDate, setTimelineDate] = useState<string>(localDateStr()); // YYYY-MM-DD
  const [summaryTimeRange, setSummaryTimeRange] = useState<'day' | 'week' | 'month' | '-1' | '-7'>('day');
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [activeQuadrant, setActiveQuadrant] = useState<'summary' | 'alerts' | 'vandalized' | 'status' | 'mechanics' | 'bike_search' | 'boletim'>('summary');
  const [bikeSearchTerm, setBikeSearchTerm] = useState('');
  const [bikeSearchLimit, setBikeSearchLimit] = useState<5|10|15>(5);
  const [bikeSearchResult, setBikeSearchResult] = useState<any[]>([]);
  const [isBikeSearchLoading, setIsBikeSearchLoading] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [isAlertsLoading, setIsAlertsLoading] = useState(false);
  const [vandalizedBikes, setVandalizedBikes] = useState<any[]>([]);
  const [isVandalizedLoading, setIsVandalizedLoading] = useState(false);
  const [statusTimeRange] = useState<'24h' | '48h' | '72h' | 'week'>('24h');
  const [alertCount, setAlertCount] = useState(0);
  const [hasNewAlerts, setHasNewAlerts] = useState(false);
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

  const lastViewedAlertCountRef = useRef<number>(0);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('lastViewedAlertCount');
      if (saved) lastViewedAlertCountRef.current = parseInt(saved, 10);
    } catch {}
  }, []);
  const [editingDriver, setEditingDriver] = useState<any>(null);

  // --- Dados auxiliares ---
  const [mechanicsList, setMechanicsList] = useState<any[]>([]);
  const [selectedMechanicBike, setSelectedMechanicBike] = useState<any>(null);
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
  const [activeMechanicCategory, setActiveMechanicCategory] = useState<string | null>(null);
  const [activeTechnicaCategory, setActiveTechnicaCategory] = useState<string | null>(null);
  const [selectedMechanicFilter, setSelectedMechanicFilter] = useState<string>('Todos');
  const [mechanicSummaryPeriod, setMechanicSummaryPeriod] = useState<'diario'|'semanal'|'mensal'>('diario');
  const [bikeFoundModal, setBikeFoundModal] = useState<{ isOpen: boolean, bikePat: string } | null>(null);
  const [mechanicNotFoundModal, setMechanicNotFoundModal] = useState<{ isOpen: boolean, bikePat: string } | null>(null);
  const [isTechnicalConfirmOpen, setIsTechnicalConfirmOpen] = useState<{ isOpen: boolean, bikePat: string, mechanicName?: string } | null>(null);
  const [manualMechanicModal, setManualMechanicModal] = useState<{ isOpen: boolean; bikePat: string; targetStatus: string }>({ isOpen: false, bikePat: '', targetStatus: '' });
  const [manualMechanicName, setManualMechanicName] = useState('');
  const [isVandalizedConfirmOpen, setIsVandalizedConfirmOpen] = useState<{ isOpen: boolean, bikePat: string } | null>(null);
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
    cameras: { id: string; label: string }[];
    currentCameraIndex: number;
  } | null>(null);
  const [scannerCameras, setScannerCameras] = useState<{ id: string; label: string }[]>([]);
  const [currentScannerCameraIndex, setCurrentScannerCameraIndex] = useState(0);
  const trailerScannerRef = useRef<Html5Qrcode | null>(null);
  const scannerStartPromise = useRef<Promise<any> | null>(null);
  const trailerScannerStartPromise = useRef<Promise<any> | null>(null);
  const scannerTransitionPromise = useRef<Promise<any>>(Promise.resolve());
  const isScannerBusy = useRef(false);
  const [isLimparListaConfirmOpen, setIsLimparListaConfirmOpen] = useState(false);
  const [removeFromTrailerConfirm, setRemoveFromTrailerConfirm] = useState<{ patrimonio: string; trailerName: string } | null>(null);

  // --- Refs ---
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const searchResultRef = useRef<HTMLDivElement>(null);
  const processingBikesRef = useRef<Set<string>>(new Set());
  // Ref para refreshAll — evita dependência circular com persistDriverState
  const refreshAllRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
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
  const lastLocationRef = useRef<{ lat: number, lng: number } | null>(null);

  const normalizedCategory = category.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const isAdm = normalizedCategory.includes('ADM');
  const isMecanica = normalizedCategory.includes('MECANICA') || normalizedCategory.includes('MECANICO');
  const isTecnica  = normalizedCategory.includes('TECNICA') || normalizedCategory.includes('TECNICO');

  // =================================================================
  // HELPERS DE ESTADO
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
      providerInfo: any[];
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

  /**
   * Abre localização no Google Maps — compatível com WebView APK e browser
   * No WebView Android usa intent:// que abre o app Maps diretamente
   * No browser normal usa o link web padrão
   */
  const openMaps = (lat: string | number, lng: string | number) => {
    const latStr = String(lat).replace(',', '.');
    const lngStr = String(lng).replace(',', '.');
    
    // Antes de sair, garante que o NoSleep e WakeLock estão ativos
    // e força um envio de posição
    const forceUpdate = (window as any).__forceGpsUpdate;
    if (typeof forceUpdate === 'function') forceUpdate();

    const isWebView = /wv|WebView/i.test(navigator.userAgent) ||
      (navigator.userAgent.includes('Android') && !navigator.userAgent.includes('Chrome/'));
    
    if (isWebView) {
      window.location.href = `intent://maps.google.com/maps?q=${latStr},${lngStr}#Intent;scheme=https;package=com.google.android.apps.maps;end`;
    } else {
      window.open(`https://www.google.com/maps/search/?api=1&query=${latStr},${lngStr}`, '_blank', 'noopener,noreferrer');
    }
  };

  /**
   * Marca que o motorista acabou de executar uma ação.
   * Durante DRIVER_ACTION_GRACE_MS, o sync do Sheets não sobrescreve.
   */
  const markDriverAction = () => {
    lastDriverActionAt.current = Date.now();
  };

  /**
   * Verifica se o sync do Sheets pode sobrescrever o estado local.
   * Retorna false se houver uma ação recente do motorista.
   */
  const canSheetsOverride = () => {
    const elapsed = Date.now() - lastDriverActionAt.current;
    return elapsed > DRIVER_ACTION_GRACE_MS;
  };

  /**
   * Aplica estado vindo do Sheets, respeitando a janela de proteção.
   * Também espelha no Firebase com flag sheetsSync=true.
   */
  const applyStateFromSheets = useCallback((sheetsRoute: string[], sheetsCollected: string[]) => {
    if (isUpdatingStateRef.current) return; // operação ativa — não mexe
    if (!canSheetsOverride()) return;       // ação recente do motorista — protege

    const newCollected = [...new Set(sheetsCollected.map(String))];
    const newRoute = [...new Set(sheetsRoute.map(String))].filter(b => !newCollected.includes(b));
    const finalRoute = newRoute.filter(b => !processingBikesRef.current.has(b));
    const finalCollected = newCollected.filter(b => !processingBikesRef.current.has(b));

    setRouteBikes(prev => {
      const prevStr = [...prev].sort().join(',');
      const nextStr = [...finalRoute].sort().join(',');
      return prevStr === nextStr ? prev : finalRoute;
    });

    setCollectedBikes(prev => {
      const prevStr = [...prev].sort().join(',');
      const nextStr = [...finalCollected].sort().join(',');
      return prevStr === nextStr ? prev : finalCollected;
    });

    // Espelha no Firebase silenciosamente — flag sheetsSync=true evita loop
    setDoc(doc(db, 'users', normalizeName(driverName)), {
      routeBikes: finalRoute,
      collectedBikes: finalCollected,
      lastUpdate: serverTimestamp(),
      sheetsSync: true,
    }, { merge: true }).catch(() => {});
  }, [driverName]);

  /**
   * Grava o estado do motorista no Firebase e envia para Sheets em paralelo.
   * Após Sheets confirmar, dispara sync imediato via ref (sem dependência circular).
   */
  const normalizeName = (name: string) => {
    if (!name) return '';
    return name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  };

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

    // 2. Sheets em paralelo — fonte de verdade para estado
    apiCall({
      action: 'updateDriverState',
      driverName,
      routeBikes: dedupRoute,
      collectedBikes: dedupCollected,
    }, 1, true).then(() => {
      setTimeout(() => refreshAllRef.current?.(true), 0);
    }).catch(e => console.warn('[Sheets] updateDriverState falhou:', e));
  }, [driverName]);

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

    // Pedidos pendentes — Firebase usado APENAS para notificação push de novos pedidos
    // O estado real de pendingRequests vem exclusivamente do Sheets via sync
    const unsubRequests = onSnapshot(collection(db, 'requests'), (snapshot) => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const d = change.doc.data();
          const status = (d.status || '').toString().toLowerCase();
          if (status === 'pendente' && (d.recipient === driverName || d.recipient === 'Todos')) {
            showNotification('Novo Pedido', 'Você tem uma nova solicitação pendente.');
          }
        }
      });
    }, err => handleFirestoreError(err, OperationType.GET, 'requests'));

    // Estado do motorista
    const unsubUser = onSnapshot(doc(db, 'users', normalizeName(driverName)), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.sheetsSync === true) return;
      if (isUpdatingStateRef.current) return;

      // Proteção contra dados de dias anteriores
      const lastUpdate = data.lastUpdate?.toDate?.() || new Date(0);
      const lastUpdateStr = `${lastUpdate.getFullYear()}-${String(lastUpdate.getMonth()+1).padStart(2,'0')}-${String(lastUpdate.getDate()).padStart(2,'0')}`;
      const today = localDateStr();
      
      // Se o dado no Firebase é de outro dia, e o motorista está no dia de hoje, ignora o estado antigo
      // Isso evita que o roteiro de ontem carregue "do nada" ao abrir o app hoje
      if (lastUpdateStr !== today && (data.routeBikes?.length > 0 || data.collectedBikes?.length > 0)) {
        console.log('[FirebaseSync] Ignorando estado de roteiro antigo:', lastUpdateStr);
        return;
      }

      setRouteBikes(data.routeBikes || []);
      setCollectedBikes(data.collectedBikes || []);
    }, err => console.error('Listener usuário:', err));

    // Listener de force_reload — ADM pode forçar atualização de todos os usuários
    // Sem where() para evitar necessidade de índice composto no Firestore
    const unsubReload = onSnapshot(collection(db, 'notifications'), snapshot => {
      if (isAdm) return; // ADM não recarrega
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const data = change.doc.data();
          if (data.type !== 'force_reload') return; // filtra no cliente
          const ts = data.timestamp?.toDate?.()?.getTime() || 0;
          const now = Date.now();
          // Só recarrega se a notificação foi criada nos últimos 10 segundos
          if (now - ts < 10000) {
            console.log('[ForceReload] Recarregando por comando do ADM...');
            setTimeout(() => window.location.reload(), 1500);
          }
        }
      });
    }, err => console.error('Listener force_reload:', err));

    // Alertas (ADM)
    let unsubAlerts = () => {};
    const unsubNotifications = () => {};
    if (isAdm) {
      unsubAlerts = onSnapshot(collection(db, 'alerts'), snapshot => {
        const updated: any[] = [];
        snapshot.forEach(doc => {
          const d = doc.data();
          // Só conta alertas pendentes/não resolvidos
          const status = (d.status || d.situacao || '').toString().toLowerCase();
          if (!status || status === 'pending' || status === 'pendente') {
            updated.push({ id: doc.id, ...d });
          }
        });
        setAlerts(updated);
        // Não atualiza alertCount aqui — será feito pelo sync do Sheets
        // para evitar contagem duplicada
      }, err => console.error('Listener alertas:', err));

    }

    // Listener de timeline_events (para ADM — enriquece a timeline dos motoristas)
    let unsubTimeline = () => {};
    if (isAdm) {
      setFirebaseTimelineEvents({}); // limpa ao trocar de data
      // Filtra pela data selecionada no servidor para maior eficiência
      const q = query(collection(db, 'timeline_events'), where('date', '==', timelineDate));
      unsubTimeline = onSnapshot(q, snapshot => {
        const byDriver: Record<string, Array<{tsMs: number, type: string, bikeNumber?: string}>> = {};
        snapshot.forEach(d => {
          const data = d.data();
          const driver = data.driverName;
          if (!driver) return;
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
            observacao: data.observacao || ''
          });
        });
        // Preserva eventos anteriores — mescla com novos
        setFirebaseTimelineEvents(prev => {
          const merged = { ...prev };
          Object.entries(byDriver).forEach(([driver, events]) => {
            merged[driver] = events;
          });
          return merged;
        });
      }, err => console.error('Listener timeline:', err));
    }

    // Listener de posições dos motoristas em tempo real (ADM)
    let unsubLocations = () => {};
    if (isAdm) {
      unsubLocations = onSnapshot(collection(db, 'locations'), snapshot => {
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

    // Listener de ações pendentes (ADM)
    let unsubPending = () => {};
    if (isAdm && auth.currentUser) {
      setIsPendingActionsLoading(true);
      unsubPending = onSnapshot(collection(db, 'pending_actions'), snapshot => {
        const actions: any[] = [];
        // Mapa para consolidar lotes por mecânico (pega o doc mais recente de cada)
        const loteByMechanic: Record<string, any> = {};
        snapshot.forEach(d => {
          const data = d.data();
          if (data.status !== 'pending' && data.status !== 'assigned') return;
          if (data.type === 'alterar_status_lote') {
            const key = data.mechanicName || 'desconhecido';
            const existing = loteByMechanic[key];
            const ts = data.timestamp?.toMillis?.() || 0;
            if (!existing || ts > (existing.timestamp?.toMillis?.() || 0)) {
              loteByMechanic[key] = { id: d.id, ...data };
            }
          } else {
            actions.push({ id: d.id, ...data });
          }
        });
        // Adiciona lotes consolidados
        Object.values(loteByMechanic).forEach(lote => actions.push(lote));
        setPendingActions(actions.sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0)));
        setIsPendingActionsLoading(false);
      }, err => {
        handleFirestoreError(err, OperationType.GET, 'pending_actions');
        setIsPendingActionsLoading(false);
      });
    }

    return () => { unsubRequests(); unsubAlerts(); unsubUser(); unsubNotifications(); unsubTimeline(); unsubReload(); unsubLocations(); unsubPending(); };
  }, [driverName, isAdm, timelineDate]);

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
          <button onClick={() => openMaps(lat, lng)}
            className="flex items-center gap-1.5 px-2 py-1 bg-blue-50 text-blue-600 rounded border border-blue-100 text-[10px] font-bold hover:bg-blue-100">
            <MapIcon className="w-3 h-3" /> Ver no Mapa
          </button>
        </div>
      );
    }
    return <p className="text-sm text-gray-700 break-all"><span className="font-semibold">Local:</span> {location}</p>;
  };

  // =================================================================
  // MEMOS
  // =================================================================
  const sortedRouteBikes = useMemo(() => {
    if (!routeBikes.length) return routeBikes;

    // 1. Se Nearest Neighbor já rodou para TODAS as bikes → ordem já otimizada, respeita
    const isFullyOptimized = routeBikes.length > 0 && routeBikes.every(id => routeDistances[id]?.isRoad);
    if (isFullyOptimized) return routeBikes;

    // 2. Ordena pelo menor valor disponível: distância de estrada (value em metros) ou Haversine
    return [...routeBikes].sort((a, b) => {
      const rdA = routeDistances[a], rdB = routeDistances[b];
      // Se ambos têm distância calculada (estrada ou Haversine), usa value
      if (rdA?.value !== undefined && rdB?.value !== undefined) return rdA.value - rdB.value;
      if (rdA?.value !== undefined) return -1;
      if (rdB?.value !== undefined) return 1;
      // Fallback: Haversine com coordenadas das bikes
      if (!currentDriverLocation) return 0;
      const dA = routeBikesDetails[a], dB = routeBikesDetails[b];
      if (!dA?.currentLat || !dA?.currentLng) return 1;
      if (!dB?.currentLat || !dB?.currentLng) return -1;
      return calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, dA.currentLat, dA.currentLng)
           - calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, dB.currentLat, dB.currentLng);
    });
  }, [routeBikes, routeBikesDetails, currentDriverLocation, routeDistances]);

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
      (d.realTime.route || []).forEach((b: string) => bikes.add(String(b).trim()));
      (d.realTime.collected || []).forEach((b: string) => bikes.add(String(b).trim()));
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

    try {
      // Usa estado local — protegido por isUpdatingStateRef=true, nenhum sync externo altera durante a operação
      let newRoute: string[] = [...routeBikes];
      let newCollected: string[] = [...collectedBikes];

      if (status === 'Recolhida') {
        if (collectedBikes.includes(bikeNumber)) {
          alert(`Você já está em posse da bicicleta ${bikeNumber}.`);
          return;
        }

        newCollected = [...new Set([...newCollected, bikeNumber])];
        newRoute = newRoute.filter(b => String(b) !== bikeNumber);

        // 1. Atualiza UI imediatamente
        setCollectedBikes(newCollected);
        setRouteBikes(newRoute);
        setSearchedBike(null);
        setSearchTerm('');

        // 2. Registra ação antes das chamadas ao Sheets
        markDriverAction();

        // 3. Firebase + Sheets — fire-and-forget (não bloqueiam a UI)
        setDoc(doc(db, 'bikes', bikeNumber), {
          status: 'Recolhida', responsavel: driverName, ultimaAtualizacao: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('[Firebase] bikes write:', err.code));

        addDoc(collection(db, 'timeline_events'), {
          driverName, bikeNumber, type: 'em_posse',
          timestamp: serverTimestamp(),
          date: localDateStr()
        }).catch(err => console.warn('[Timeline] Erro:', err.code, err.message));

        persistDriverState(newRoute, newCollected);

        setSuccessMessage(`Bicicleta ${bikeNumber} recolhida!`);

      } else if (status === 'Não encontrada') {
        newRoute = newRoute.filter(b => String(b) !== bikeNumber);

        // 1. Atualiza UI imediatamente
        setRouteBikes(newRoute);
        setSearchedBike(null);
        setSearchTerm('');

        // 2. Registra ação antes das chamadas ao Sheets
        markDriverAction();

        // 3. Firebase + Sheets — fire-and-forget (não bloqueiam a UI)
        setDoc(doc(db, 'bikes', bikeNumber), {
          status: 'Não encontrada', responsavel: null, ultimaAtualizacao: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('[Firebase] bikes write:', err.code));

        addDoc(collection(db, 'reports'), {
          driverName, bikeNumber, status: 'Não encontrada', timestamp: serverTimestamp(), observation: ''
        }).catch(err => console.warn('[Firebase] reports write:', err.code));

        persistDriverState(newRoute, newCollected);

        apiCall({
          action: 'finalizeRouteBike', driverName, bikeNumber,
          finalStatus: 'Não encontrada', finalObservation: ''
        }, 1, true).catch(e => console.warn('[Sheets] finalizeRouteBike:', e));

        setSuccessMessage(`Bicicleta ${bikeNumber} marcada como não encontrada.`);
      }

    } catch (err: any) {
      console.error('Erro ao atualizar status:', err);
      setError('Erro ao atualizar status: ' + err.message);
    } finally {
      isUpdatingStateRef.current = false;
      setIsLoading(false);
      processingBikesRef.current.delete(bikeNumber);
      setProcessingBikes(new Set(processingBikesRef.current));
    }
  };

  const handleNaoAtendidaClick = async (bikeNumberInput: string | number, silent = false) => {
    const bikeNumber = String(bikeNumberInput);
    isUpdatingStateRef.current = true;
    if (!silent) setIsLoading(true);
    try {
      // Usa estado local — protegido por isUpdatingStateRef=true
      const newRoute = routeBikes.filter((b: string) => String(b) !== bikeNumber);
      const newCollected = [...collectedBikes];

      // 1. Atualiza UI imediatamente
      setRouteBikes(newRoute);

      // 2. Registra ação antes das chamadas ao Sheets
      markDriverAction();

      // 3. Firebase + Sheets — fire-and-forget
      setDoc(doc(db, 'bikes', bikeNumber), {
        status: 'Pendente', responsavel: null, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));

      addDoc(collection(db, 'reports'), {
        driverName, bikeNumber, status: 'Não atendida', timestamp: serverTimestamp(), observation: ''
      }).catch(e => console.warn('[Firebase] reports write:', e.code));

      persistDriverState(newRoute, newCollected);

      apiCall({
        action: 'finalizeRouteBike', driverName, bikeNumber,
        finalStatus: 'Não atendida', finalObservation: ''
      }, 1, true).catch(e => console.warn('[Sheets] finalizeRouteBike:', e));

      if (!silent) setSuccessMessage(`Bicicleta ${bikeNumber} marcada como não atendida.`);
    } catch (err: any) {
      console.error('Erro não atendida:', err);
      if (!silent) setError(`Erro ao processar bike ${bikeNumber}: ${err.message}`);
    } finally {
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

    // 1. Remove da UI imediatamente — motorista não espera o Sheets
    setCollectedBikes(prev => prev.filter(b => String(b) !== bikeNumber));

    // 2. Calcula novo estado com base no estado local já protegido por isUpdatingStateRef
    //    (não precisa consultar o Sheets — nenhum sync externo altera o estado enquanto
    //     isUpdatingStateRef = true)
    const newCollected = collectedBikes.filter(b => String(b) !== bikeNumber);
    const newRoute = routeBikes;

    const finalStatus = status === 'Enviada para Estação' ? 'Estação'
      : status === 'Enviada para Filial' ? 'Filial'
      : status;

    // 3. Registra ação ANTES das chamadas ao Sheets — protege contra sync que devolveria a bike
    markDriverAction();

    try {
      // 4. Firebase — não-bloqueante (resposta imediata ao motorista)
      setDoc(doc(db, 'bikes', bikeNumber), {
        status: finalStatus, responsavel: null,
        observacao: observation, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));

      addDoc(collection(db, 'reports'), {
        driverName, bikeNumber, status: finalStatus,
        observation, timestamp: serverTimestamp()
      }).catch(e => console.warn('[Firebase] reports write:', e.code));

      // 5. Sheets — fire-and-forget em paralelo (não bloqueia a UI)
      //    updateDriverState remove a bike do estado persistido
      //    finalizeCollectedBike grava o relatório e aciona addToMechanics se necessário
      persistDriverState(newRoute, newCollected);

      apiCall({
        action: 'finalizeCollectedBike', driverName, bikeNumber,
        finalStatus, finalObservation: observation
      }, 1, true).catch(e => console.warn('[Sheets] finalizeCollectedBike:', e));

      setSuccessMessage(`Bicicleta ${bikeNumber} finalizada!`);
    } catch (err: any) {
      console.error(`Erro bike ${bikeNumber}:`, err);
      setError(`Erro ao processar bike ${bikeNumber}: ${err.message}`);
      // Reverte atualização otimista em caso de erro síncrono
      setCollectedBikes(prev => [...new Set([...prev, bikeNumber])]);
    } finally {
      isUpdatingStateRef.current = false;
      setIsLoading(false);
      processingBikesRef.current.delete(bikeNumber);
      setProcessingBikes(new Set(processingBikesRef.current));
    }
  };

  // =================================================================
  // SOLICITAÇÕES
  // =================================================================
  const handleAcceptRequest = async (requestId: string, bikeNumbers: string, reason: string = '', title: string = '') => {
    if (isLoading) return;
    const bikesToAdd = String(bikeNumbers || '').split(',').map(s => s.trim()).filter(Boolean);
    const alreadyInPosse = bikesToAdd.filter(b => collectedBikes.includes(b));
    if (alreadyInPosse.length > 0) { alert(`Bikes já em sua posse: ${alreadyInPosse.join(', ')}`); return; }

    const isTrailer = (reason || '').toUpperCase().includes('CARRETINHA') || (title || '').toUpperCase().includes('CARRETINHA');
    isUpdatingStateRef.current = true;
    setIsLoading(true);

    // Remove da lista IMEDIATAMENTE — antes de qualquer chamada async
    processedRequestIds.current.add(String(requestId));
    setPendingRequests(prev => prev.filter(r => String(r.id) !== String(requestId)));

    try {
      // IDs numéricos vêm do Sheets — não existem no Firestore.
      const isFirestoreId = String(requestId).length > 10 && isNaN(Number(requestId));
      if (isFirestoreId) {
        updateDoc(doc(db, 'requests', String(requestId)), {
          status: 'ACEITO', driverName, acceptedAt: serverTimestamp()
        }).catch(e => console.warn('[Firebase] requests update:', e.code));
      }

      // Lê estado atual do Sheets (fonte de verdade) em vez do Firebase
      const stateResult = await apiCall({ action: 'getDriverState', driverName }, 1, true);
      let newRoute: string[] = stateResult.success ? (stateResult.data?.routeBikes || []) : routeBikes;
      let newCollected: string[] = stateResult.success ? (stateResult.data?.collectedBikes || []) : collectedBikes;

      if (isTrailer) {
        newCollected = [...new Set([...newCollected, ...bikesToAdd])];
        newRoute = newRoute.filter(b => !bikesToAdd.includes(String(b)));
        setCollectedBikes(newCollected);
        setRouteBikes(newRoute);
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

        // Atualiza status da ação pendente para 'approved' (remove do ADM)
        const q = query(collection(db, 'pending_actions'), 
          where('type', '==', 'trailer_validation'),
          where('status', '==', 'assigned'),
          where('assignedTo', '==', driverName)
        );
        getDocs(q).then(snap => {
          snap.forEach(d => {
            const data = d.data();
            // Se pelo menos uma bike da carretinha bater com o que o motorista aceitou
            if (data.bikes?.some((b: string) => bikesToAdd.includes(b))) {
              updateDoc(d.ref, { 
                status: 'approved', 
                acceptedAt: serverTimestamp(),
                finalAcceptedBy: driverName 
              }).catch(() => {});
            }
          });
        }).catch(() => {});
        // Registra apenas na timeline (Relatório removido conforme solicitação)
        bikesToAdd.forEach(id => {
          addDoc(collection(db, 'timeline_events'), {
            driverName, bikeNumber: id, 
            type: 'carretinha',
            observacao: title || 'Carretinha',
            timestamp: serverTimestamp(),
            date: localDateStr()
          }).catch(() => {});
        });
      } else {
        newRoute = [...new Set([...newRoute, ...bikesToAdd])];
        newCollected = newCollected.filter(b => !bikesToAdd.includes(String(b)));
        setRouteBikes(newRoute);
        setCollectedBikes(newCollected);
        // Firebase não-bloqueante
        bikesToAdd.forEach(id => {
          setDoc(doc(db, 'bikes', id), {
            status: 'Em Rota', responsavel: driverName, ultimaAtualizacao: serverTimestamp()
          }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));
        });
      }

      await persistDriverState(newRoute, newCollected);

      // Sheets
      apiCall({ action: 'acceptRequest', requestId, driverName }, 1, true)
        .catch(e => console.warn('[Sheets] acceptRequest:', e));

      markDriverAction();
      setSuccessMessage('Pedido aceito!');
    } catch (err: any) {
      console.error('Erro aceitar pedido:', err);
      setError('Erro ao aceitar pedido: ' + err.message);
    } finally {
      isUpdatingStateRef.current = false;
      setIsLoading(false);
    }
  };

  const handleDeclineRequest = async (requestId: string) => {
    if (isLoading) return;
    isUpdatingStateRef.current = true;
    setIsLoading(true);

    // Marca como processado imediatamente — nunca mais aparece na lista
    processedRequestIds.current.add(String(requestId));
    setPendingRequests(prev => prev.filter(r => String(r.id) !== String(requestId)));
    try {
      const isFirestoreId = String(requestId).length > 10 && isNaN(Number(requestId));
      if (isFirestoreId) {
        updateDoc(doc(db, 'requests', String(requestId)), {
          status: 'RECUSADO', declinedBy: driverName, declinedAt: serverTimestamp()
        }).catch(e => console.warn('[Firebase] requests decline:', e.code));
      }
      apiCall({ action: 'declineRequest', requestId, driverName }, 1, true)
        .catch(e => console.warn('[Sheets] declineRequest:', e));
      setSuccessMessage('Pedido recusado.');
    } catch (err: any) {
      setError('Erro ao recusar pedido: ' + err.message);
    } finally {
      isUpdatingStateRef.current = false;
      setIsLoading(false);
    }
  };

  const handleCreateRequest = async (details: { bikeNumber: string; location: string; reason: string; recipient: string }) => {
    setIsLoading(true);
    try {
      const result = await apiCall({ action: 'createRequest', patrimonio: details.bikeNumber, ocorrencia: details.reason, local: details.location, recipient: details.recipient }, 1, true);
      if (result.success) { alert('Solicitação criada!'); setRequestModalOpen(false); refreshAll(true); }
      else throw new Error(result.error);
    } catch (err: any) {
      alert(`Erro: ${err.message}`);
    } finally { setIsLoading(false); }
  };

  const handleCreateRoute = async (details: { routeName: string; bikeNumbers: string[]; recipient: string }) => {
    if (!details.bikeNumbers?.length) { alert('Insira ao menos uma bicicleta.'); return; }
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

  const mechanicsNames = useMemo(() => {
    return Array.from(new Set(mechanicsList.filter(b => b.mecanico).map(b => b.mecanico))).sort();
  }, [mechanicsList]);

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
      if (isMecanica) {
        const directStatuses = ['Alterar Status', 'Reserva', 'Aguardando Manutenção', 'Em Manutenção'];
        if (directStatuses.includes(targetStatus)) {
          // Move no backend imediatamente — evita que o refreshAll reverta o estado
          protectMechanicBike(bikePat, targetStatus);

          const finalMechanicName = mechanicName || driverName;
          const jaExiste = mechanicsList.some(b => b.patrimonio === bikePat);
          if (jaExiste) {
            setMechanicsList(prev => prev.map(b => 
              b.patrimonio === bikePat ? { ...b, status: targetStatus, mecanico: finalMechanicName } : b
            ));
          } else {
            setMechanicsList(prev => [...prev, {
              patrimonio: bikePat,
              status: targetStatus,
              dataEntrada: new Date(),
              mecanico: finalMechanicName,
              tratativa: 'MANUAL',
              manual: true,
            }]);
          }
          // Persiste no backend
          await apiCall({ action: 'insertBikeMechanics', bikeNumber: bikePat, mechanicName: finalMechanicName, targetStatus }, 1, true).catch(() => {});
          
          setSuccessMessage(
            targetStatus === 'Alterar Status' ? `Bike ${bikePat} adicionada em Alterar Status.` :
            targetStatus === 'Reserva' ? `Bike ${bikePat} movida para Reserva.` :
            targetStatus === 'Aguardando Manutenção' ? `Bike ${bikePat} em Aguardando Manutenção.` :
            `Bike ${bikePat} em Manutenção.`
          );
          
          setSearchedBike(null);
          setSearchTerm('');
          setBikeSearchTerm('');
          setBikeSearchResult([]);
          return;
        }
        // Outros status — envia direto ao ADM como antes
        try {
          await addDoc(collection(db, 'pending_actions'), {
            type: 'status_change',
            bikeNumber: bikePat,
            targetStatus,
            mechanicName: driverName,
            status: 'pending',
            timestamp: serverTimestamp()
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, 'pending_actions');
        }
        setSuccessMessage(`Solicitação de alteração de status para bike ${bikePat} enviada ao ADM.`);
        setBikeSearchTerm('');
        setBikeSearchResult([]);
        return;
      }

      const res = await apiCall({
        action: 'insertBikeMechanics',
        bikeNumber: bikePat,
        mechanicName,
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

  const handleBikeMovementSearch = async () => {
    if (!bikeSearchTerm.trim()) return;
    setIsBikeSearchLoading(true);
    setBikeSearchResult([]);
    try {
      const result = await apiCall({ action: 'getBikeMovement', bikeNumber: bikeSearchTerm.trim(), limit: bikeSearchLimit });
      if (result.success) setBikeSearchResult(result.data || []);
      else alert('Bike não encontrada: ' + result.error);
    } catch (e: any) { alert('Erro: ' + e.message); }
    finally { setIsBikeSearchLoading(false); }
  };

  const handleSearch = async (bikeToSearch?: string) => {
    const term = (bikeToSearch || searchTerm).trim();
    if (!term) { setSearchedBike(null); setSearchTerm(''); return; }
    if (bikeToSearch) setSearchTerm(bikeToSearch);

    setIsSearching(true);
    setError(null);
    try {
      const result = await apiCall({ action: 'search', bikeNumber: term });
      if (result.success && result.data) {
        const s = { ...result.data, 'Patrimônio': String(result.data['Patrimônio']) };
        setSearchedBike(s);
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
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('Geolocalização não suportada.')); return; }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        err => reject(new Error(err.message)),
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 3000 }
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
  // Map de patrimônio → { ..., expiresAt } — protege por 30s após cada ação
  // Plain object ref — avoids Map constructor issues in this environment
  const mechanicOptimisticRef = useRef<Record<string, any>>({});

  const protectMechanicBike = (patrimonio: string, data: any) => {
    const dataObj = typeof data === 'string' ? { status: data } : data;
    mechanicOptimisticRef.current[String(patrimonio)] = {
      ...dataObj,
      expiresAt: Date.now() + 30000, // 30s de proteção
    };
  };

  const handleAlterarStatus = async (bikeId: string) => {
    // 1. Atualiza estado local imediatamente — bike some de "Alterar Status"
    protectMechanicBike(bikeId, { status: 'Aguardando Manutenção' });
    setMechanicsList(prev => prev.map(b =>
      String(b.patrimonio) === String(bikeId) ? { ...b, status: 'Aguardando Manutenção' } : b
    ));

    if (isMecanica) {
      try {
        // 1. Move no backend imediatamente — evita que o refreshAll reverta o estado
        await apiCall({ action: 'moveToAguardandoManutencao', bikeNumber: bikeId }, 1, true).catch(() => {});

        // 2. Agrupa num único doc no Firebase — busca doc pendente existente antes de criar novo
        const { arrayUnion, getDocs: _getDocs, query: _query, where: _where } = await import('firebase/firestore');
        
        if (!alterarStatusDocRef.current) {
          // Busca doc pendente já existente deste mecânico para não criar duplicata
          try {
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
          } catch (err) {
            handleFirestoreError(err, OperationType.GET, 'pending_actions');
          }
        }

        if (alterarStatusDocRef.current) {
          // Adiciona bike ao doc existente
          try {
            await updateDoc(doc(db, 'pending_actions', alterarStatusDocRef.current), {
              bikes: arrayUnion(bikeId),
              timestamp: serverTimestamp(),
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.WRITE, 'pending_actions');
          }
        } else {
          // Cria novo doc agregador
          try {
            const docRef = await addDoc(collection(db, 'pending_actions'), {
              type: 'alterar_status_lote',
              bikes: [bikeId],
              mechanicName: driverName,
              status: 'pending',
              timestamp: serverTimestamp(),
            });
            alterarStatusDocRef.current = docRef.id;
          } catch (err) {
            handleFirestoreError(err, OperationType.WRITE, 'pending_actions');
          }
        }

        setSuccessMessage(`Bike ${bikeId} → Aguardando Manutenção.`);
      } catch (e: any) {
        alert('Erro ao enviar solicitação: ' + e.message);
        // Reverte atualização otimista em caso de erro
        setMechanicsList(prev => prev.map(b =>
          b.patrimonio === bikeId ? { ...b, status: 'Alterar Status' } : b
        ));
      }
      return;
    }

    // ADM / perfil com acesso direto: move direto no backend
    try {
      await apiCall({ action: 'moveToAguardandoManutencao', bikeNumber: bikeId }, 1, true);
    } catch (err: any) {
      console.error('Erro ao mover para Aguardando Manutenção:', err);
      setMechanicsList(prev => prev.map(b =>
        b.patrimonio === bikeId ? { ...b, status: 'Alterar Status' } : b
      ));
    }
  };

  const handleMarkAsNotFound = async (bikeId: string) => {
    setIsLoading(true);
    // Optimistic: remove from list immediately
    setMechanicsList(prev => prev.filter(b => b.patrimonio !== bikeId));
    try {
      await apiCall({ action: 'markAsNotFound', bikeNumber: bikeId, mechanicName: driverName }, 1, true);
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
    // Otimista — remove da lista Mecânica imediatamente
    setMechanicsList(prev => prev.filter(b => b.patrimonio !== bikePat));
    try {
      const finalMechanic = mechanicName || driverName;
      // Firebase não-bloqueante
      setDoc(doc(db, 'bikes', bikePat), {
        status: 'Aguardando Técnica', responsavel: finalMechanic, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase] bikes:', e.code));
      // Backend — grava na aba Mecânica com status Aguardando Técnica
      await apiCall({ action: 'sendToTechnical', bikeNumber: bikePat, mechanicName: finalMechanic }, 1, false);
    } catch (err: any) {
      console.error('Erro ao enviar para técnica:', err);
      setError('Erro ao enviar para técnica: ' + err.message);
    } finally {
      setIsLoading(false);
      setIsTechnicalConfirmOpen(null);
    }
  };

  const fetchTechnicaList = async () => {
    setIsTechnicaLoading(true);
    try {
      const r = await apiCall({ action: 'getTechnicaList' }, 1, false);
      if (r.success) setTechnicaList(r.data || []);
    } catch (e: any) { console.warn('[getTechnicaList]', e.message); }
    finally { setIsTechnicaLoading(false); }
  };

  const handleConfirmTechnicaReceipt = (bike: any) => {
    // Abre modal de seleção de técnico — não processa direto
    setTechnicaReceiptModal({ bikeNumber: bike.patrimonio, originalMechanic: bike.mecanico || '' });
  };

  const executeConfirmTechnicaReceipt = async (bikeNumber: string, technicianName: string) => {
    setTechnicaReceiptModal(null);
    setIsLoading(true);
    setTechnicaList(prev => prev.map(b =>
      b.patrimonio === bikeNumber ? { ...b, status: 'Em Técnica', mecanico: technicianName } : b
    ));
    try {
      setDoc(doc(db, 'bikes', bikeNumber), {
        status: 'Em Técnica', responsavel: technicianName, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase]', e.code));
      await apiCall({ action: 'confirmTechnicaReceipt', bikeNumber, technicianName }, 1, false);
    } catch (err: any) {
      setError('Erro: ' + err.message);
      fetchTechnicaList();
    } finally { setIsLoading(false); }
  };

  const handleFinalizeTechnicaRepair = (bike: any) => {
    setTechnicaRepairModal({ bike });
    setTechnicaRepairSelected(new Set());
  };

  const executeFinalizeTechnicaRepair = async () => {
    if (!technicaRepairModal || technicaRepairSelected.size === 0) return;
    const { bike } = technicaRepairModal;
    const bikeNumber = bike.patrimonio;
    const originalMechanic = bike.mecanico || '';
    const treatment = Array.from(technicaRepairSelected).join(', ');
    setTechnicaRepairModal(null);
    setTechnicaRepairSelected(new Set());
    setIsLoading(true);
    setTechnicaList(prev => prev.filter(b => b.patrimonio !== bikeNumber));
    try {
      setDoc(doc(db, 'bikes', bikeNumber), {
        status: 'Em Manutenção', responsavel: originalMechanic || null, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase]', e.code));
      await apiCall({
        action: 'finalizeTechnicaRepair', bikeNumber,
        technicianName: driverName, treatment, originalMechanic
      }, 1, false);
      setSuccessMessage(`Bike ${bikeNumber} devolvida para ${originalMechanic || 'Mecânica'} — Em Manutenção.`);
    } catch (err: any) {
      setError('Erro: ' + err.message);
      fetchTechnicaList();
    } finally { setIsLoading(false); }
  };

  const handleMarkAsVandalizedNoRecovery = async (bikePat: string) => {
    setIsLoading(true);
    try {
      setMechanicsList(prev => prev.filter(b => b.patrimonio !== bikePat));
      const treatment = 'Vandalizada sem recuperação';
      await updateDoc(doc(db, 'bikes', bikePat), { 
        status: 'Vandalizada', 
        responsavel: null, 
        observacao: treatment, 
        ultimaAtualizacao: serverTimestamp() 
      });
      await addDoc(collection(db, 'reports'), { 
        bikeNumber: bikePat, 
        status: 'Vandalizada', 
        driverName, 
        treatment, 
        timestamp: serverTimestamp(), 
        type: 'Vandalizada' 
      });
      await apiCall({ action: 'markAsVandalizedNoRecovery', bikeNumber: bikePat, mechanicName: driverName, treatment }, 1, true);
      refreshAll(true);
    } catch (err: any) {
      console.error('Erro ao marcar como vandalizada:', err);
    } finally {
      setIsLoading(false);
      setIsVandalizedConfirmOpen(null);
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
      await apiCall({ action: 'deleteMechanicsBike', bikeNumber: bikePat }, 1, true);
      refreshAll(true);
    } catch (err: any) {
      console.error('Erro ao excluir bike:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMechanicSelectionConfirm = async (mechanicName: string) => {
    setIsLoading(true);
    const bikeNumber = selectedMechanicBike.patrimonio;
    // Atualização otimista — remove da lista imediatamente
    protectMechanicBike(bikeNumber, { status: 'Em Manutenção', mecanico: mechanicName });
    setMechanicsList(prev => prev.map(b =>
      String(b.patrimonio) === String(bikeNumber) ? { ...b, status: 'Em Manutenção', mecanico: mechanicName } : b
    ));
    setIsMechanicSelectionModalOpen(false);
    try {
      updateDoc(doc(db, 'bikes', bikeNumber), { status: 'Mecânica', responsavel: mechanicName, ultimaAtualizacao: serverTimestamp() }).catch(e => console.warn('[Firebase] bikes write:', e.code));
      addDoc(collection(db, 'reports'), { bikeNumber, status: 'Mecânica', driverName, mechanicName, timestamp: serverTimestamp(), type: 'Mecânica' }).catch(e => console.warn('[Firebase] reports write:', e.code));
      apiCall({ action: 'confirmMechanicsReceipt', bikeNumber, mechanicName }, 1, true).catch(() => {});
    } catch (err: any) {
      alert('Erro: ' + err.message);
    } finally { setIsLoading(false); }
  };

  const handleFinalizeMechanicsRepair = async (treatment: string) => {
    if (!treatment) { alert('Descreva a tratativa.'); return; }
    setIsLoading(true);
    const bikeNumber = selectedMechanicBike.patrimonio;

    // Mecânico e ADM seguem o mesmo fluxo: move para Reserva.
    // A notificação ao ADM só ocorre ao FINALIZAR A CARRETINHA (após QR + bateria + comunicação).
    // Atualização otimista
    protectMechanicBike(bikeNumber, { status: 'Reserva', tratativa: treatment });
    setMechanicsList(prev => prev.map(b =>
      String(b.patrimonio) === String(bikeNumber) ? { ...b, status: 'Reserva', tratativa: treatment } : b
    ));
    setIsMechanicRepairModalOpen(false);
    try {
      updateDoc(doc(db, 'bikes', bikeNumber), { status: 'Em Estação', responsavel: null, observacao: treatment, ultimaAtualizacao: serverTimestamp() }).catch(e => console.warn('[Firebase] bikes write:', e.code));
      addDoc(collection(db, 'reports'), { bikeNumber, status: 'Em Estação', driverName, treatment, timestamp: serverTimestamp(), type: 'Reparo' }).catch(e => console.warn('[Firebase] reports write:', e.code));
      apiCall({ action: 'finalizeMechanicsRepair', bikeNumber, mechanicName: driverName, treatment }, 1, true).catch(() => {});
      setSuccessMessage(`Bike ${bikeNumber} movida para Reserva. Organize em uma carretinha para finalizar.`);
    } catch (err: any) {
      alert('Erro: ' + err.message);
    } finally { setIsLoading(false); }
  };

  const handleOrganizeTrailer = async (bikeNumbers: string[], trailerName: string) => {
    if (!trailerName) { alert('Informe o nome da carretinha.'); return; }

    setIsLoading(true);
    try {
      // Organiza localmente a carretinha
      setMechanicsList(prev => prev.map(b =>
        bikeNumbers.includes(b.patrimonio) ? { ...b, carretinha: trailerName, status: 'Reserva' } : b
      ));
      setIsTrailerSelectionModalOpen(false);

      // Persiste no backend
      apiCall({ action: 'organizeTrailer', bikeNumbers, trailerName }, 1, true).catch(() => {});
      await Promise.all(bikeNumbers.map(id =>
        updateDoc(doc(db, 'bikes', id), { 
          carretinha: trailerName, 
          status: 'Reserva', 
          trailerStatus: null, // Reseta status se estiver sendo re-organizada
          ultimaAtualizacao: serverTimestamp() 
        }, { merge: true }).catch(() => {})
      ));

      setSuccessMessage(`Bikes organizadas na ${trailerName}!`);
      refreshAll(true);
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
        await Promise.all(bikes.map(bikeId =>
          apiCall({ action: 'moveToAguardandoManutencao', bikeNumber: bikeId }, 1, true).catch(() => {})
        ));
      } else if (action.type === 'status_change') {
        if (action.targetStatus === 'Reserva') {
          updateDoc(doc(db, 'bikes', action.bikeNumber), { status: 'Em Estação', responsavel: null, observacao: action.treatment, ultimaAtualizacao: serverTimestamp() }).catch(() => {});
          addDoc(collection(db, 'reports'), { bikeNumber: action.bikeNumber, status: 'Em Estação', driverName: action.mechanicName, treatment: action.treatment, timestamp: serverTimestamp(), type: 'Reparo' }).catch(() => {});
          const res = await apiCall({ action: 'finalizeMechanicsRepair', bikeNumber: action.bikeNumber, mechanicName: action.mechanicName, treatment: action.treatment }, 1, true);
          if (!res.success) throw new Error(res.error || 'Erro ao aprovar reparo.');
        } else {
          const res = await apiCall({
            action: 'insertBikeMechanics',
            bikeNumber: action.bikeNumber,
            mechanicName: action.mechanicName || '',
            targetStatus: action.targetStatus
          });
          if (!res.success) throw new Error(res.error || 'Erro ao aprovar status.');
        }
      } else if (action.type === 'trailer_validation') {
        await Promise.all(action.bikes.map((id: string) => updateDoc(doc(db, 'bikes', id), { 
          carretinha: action.trailerName, 
          trailerStatus: 'approved',
          ultimaAtualizacao: serverTimestamp() 
        })));
        const res = await apiCall({ action: 'organizeTrailer', bikeNumbers: action.bikes, trailerName: action.trailerName }, 1, true);
        if (!res.success) throw new Error(res.error || 'Erro ao aprovar carretinha.');
      }

      try {
        await updateDoc(doc(db, 'pending_actions', action.id), {
          status: 'approved',
          approvedBy: driverName,
          approvedAt: serverTimestamp()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'pending_actions');
      }
      // Reseta ref do lote se era o doc aprovado
      if (action.type === 'alterar_status_lote' && alterarStatusDocRef.current === action.id) {
        alterarStatusDocRef.current = null;
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
        updateDoc(doc(db, 'bikes', id), { 
          status: 'Reserva', // Mantém em reserva até o motorista aceitar
          responsavel: targetDriverName,
          carretinha: trailerName,
          trailerStatus: 'assigned',
          ultimaAtualizacao: serverTimestamp() 
        })
      ));

      // 2. Cria a notificação para o motorista
      await apiCall({
        action: 'createRequest', 
        patrimonio: bikes.join(', '),
        ocorrencia: `[CARRETINHA] ${trailerName}`,
        local: 'Atribuído via ADM', 
        recipient: targetDriverName
      }, 1, true);

      // 3. Aprova a ação pendente (mas mantém visível como 'assigned')
      try {
        await updateDoc(doc(db, 'pending_actions', action.id), {
          status: 'assigned',
          approvedBy: driverName, // Nome do ADM logado
          approvedAt: serverTimestamp(),
          assignedTo: targetDriverName
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'pending_actions');
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
      try {
        await updateDoc(doc(db, 'pending_actions', actionId), {
          status: 'rejected',
          rejectedBy: driverName,
          rejectedAt: serverTimestamp()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'pending_actions');
      }
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
    return withScannerTransition(async () => {
      if (trailerScannerStartPromise.current) {
        try { await trailerScannerStartPromise.current; } catch { }
        trailerScannerStartPromise.current = null;
      }

      if (trailerScannerRef.current) {
        const qr = trailerScannerRef.current;
        trailerScannerRef.current = null;
        try { 
          if (qr.getState() === Html5QrcodeScannerState.SCANNING || qr.getState() === Html5QrcodeScannerState.PAUSED) {
            await qr.stop(); 
            await new Promise(r => setTimeout(r, 300));
          }
          await qr.clear(); 
        } catch (e) {
          console.warn('Error stopping trailer scanner:', e);
        }
      }
      setTrailerQrModal(prev => prev ? { ...prev, scannerActive: false } : null);
    });
  };

  const withScannerTransition = async (fn: () => Promise<any>) => {
    const nextPromise = scannerTransitionPromise.current.then(async () => {
      try {
        return await fn();
      } catch (e) {
        console.warn('Scanner transition error:', e);
        throw e;
      }
    });
    scannerTransitionPromise.current = nextPromise;
    return nextPromise;
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
      // Valida bateria ≥ 85%
      const bateriaVal = found.bateria !== undefined ? Number(found.bateria) : undefined;
      const bateriaPct = bateriaVal !== undefined
        ? (bateriaVal <= 1 && bateriaVal > 0 ? Math.round(bateriaVal * 100) : Math.round(bateriaVal))
        : undefined;
      if (bateriaPct !== undefined && bateriaPct < 85) {
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
      setTrailerQrModal(prev => prev ? { ...prev, lastError: 'Seu navegador não suporta acesso à câmera.', scannerActive: false } : null);
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
      await withScannerTransition(async () => {
        try {
          const el = document.getElementById('qr-trailer-reader');
          if (!el) throw new Error('Elemento do scanner não encontrado no DOM.');
          
          const checkStillActive = () => {
            let active = false;
            setTrailerQrModal(prev => {
              if (prev && prev.scannerActive) active = true;
              return prev;
            });
            return active;
          };

          if (!checkStillActive()) return;

          const qr = new Html5Qrcode('qr-trailer-reader');
          trailerScannerRef.current = qr;
          
          const startWithRetry = async (withZoom: boolean, retries = 5): Promise<void> => {
            if (!checkStillActive()) return;
            try {
              let cameras = scannerCameras;
              if (cameras.length === 0) {
                try {
                  const devices = await Html5Qrcode.getCameras();
                  if (devices && devices.length > 0) {
                    cameras = devices.map(d => ({ id: d.id, label: d.label }));
                    setScannerCameras(cameras);
                  }
                } catch (e) {
                  console.warn('Error getting cameras:', e);
                }
              }

              const config = cameras.length > 0 
                ? { deviceId: { exact: cameras[currentScannerCameraIndex % cameras.length].id } }
                : { facingMode: 'environment' };
              
              const promise = qr.start(
                config,
                { fps: 10, qrbox: 200, aspectRatio: 1.0 },
                (decodedText) => handleTrailerQrSuccess(decodedText),
                () => {}
              );
              trailerScannerStartPromise.current = promise;
              await promise;
              trailerScannerStartPromise.current = null;
            } catch (err: any) {
              trailerScannerStartPromise.current = null;
              if (err?.message?.includes('already under transition') && retries > 0) {
                console.warn('Trailer Scanner transition error, retrying...', retries);
                await new Promise(r => setTimeout(r, 800));
                return startWithRetry(withZoom, retries - 1);
              }
              throw err;
            }
          };

          try {
            await startWithRetry(false);
          } catch (err) {
            console.warn('Start failed:', err);
            throw err;
          }
        } catch (err: any) {
          console.error('Trailer Scanner error:', err);
          setTrailerQrModal(prev => prev ? { ...prev, lastError: 'Não foi possível acessar a câmera: ' + (err.message || String(err)), scannerActive: false } : null);
        } finally {
          isScannerBusy.current = false;
        }
      });
    }, 600);
  };

  const handleFinalizeTrailer = async (trailerName: string) => {
    // Abre modal de verificação QR — window.confirm substituído
    const bikesRaw = mechanicsList.filter(b => b.carretinha === trailerName && b.status === 'Reserva');
    if (bikesRaw.length === 0) {
      setError('Nenhuma bike encontrada nesta carretinha.');
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
    // Mantém status 'Reserva' para continuar exibindo na seção Reserva até aceite do motorista
    setMechanicsList(prev => prev.map(b =>
      b.carretinha === trailerName ? { ...b, trailerStatus: 'finalized' } : b
    ));
    try {
      // Não limpa carretinha aqui; define trailerStatus como 'finalized'
      await Promise.all(bikeIds.map(id => setDoc(doc(db, 'bikes', id), { 
        trailerStatus: 'finalized', 
        ultimaAtualizacao: serverTimestamp() 
      }, { merge: true })));
      apiCall({ action: 'finalizeTrailer', trailerName }, 1, true).catch(() => {});
      // Notifica ADM para alterar status das bikes — só ocorre aqui, após QR + bateria + comunicação
      const notifyMsg = `🚌 Carretinha "${trailerName}" finalizada por ${driverName}. ${bikeIds.length} bike(s) prontas para remanejamento: ${bikeIds.join(',')}`;
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

      // Se não for ADM, envia para Validação Mecânica (pending_actions)
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
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, 'pending_actions');
        }
      }

      setSuccessMessage(`Carretinha "${trailerName}" finalizada! ADM notificado para remanejamento.`);
    } catch (err: any) {
      setError('Erro: ' + err.message);
      refreshAll(true);
    } finally { setIsLoading(false); }
  };

  const handleUpdateDriverState = async (targetDriver: string, route: string[], collected: string[]) => {
    setIsLoading(true);
    try {
      // Firebase não-bloqueante
      setDoc(doc(db, 'users', normalizeName(targetDriver)), { routeBikes: route, collectedBikes: collected, lastUpdate: serverTimestamp(), sheetsSync: false }, { merge: true }).catch(e => console.warn('[Firebase] users write:', e.code));
      route.forEach(id => setDoc(doc(db, 'bikes', id), { status: 'Em Rota', responsavel: targetDriver, ultimaAtualizacao: serverTimestamp() }, { merge: true }).catch(() => {}));
      collected.forEach(id => setDoc(doc(db, 'bikes', id), { status: 'Recolhida', responsavel: targetDriver, ultimaAtualizacao: serverTimestamp() }, { merge: true }).catch(() => {}));
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
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn('Error stopping existing scanners:', e);
    }

    setIsScannerOpen(true);
    setTimeout(async () => {
      await withScannerTransition(async () => {
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

          const startWithRetry = async (withZoom: boolean, retries = 5): Promise<void> => {
            if (!checkStillOpen()) return;
            try {
              let cameras = scannerCameras;
              if (cameras.length === 0) {
                try {
                  const devices = await Html5Qrcode.getCameras();
                  if (devices && devices.length > 0) {
                    cameras = devices.map(d => ({ id: d.id, label: d.label }));
                    setScannerCameras(cameras);
                  }
                } catch (e) {
                  console.warn('Error getting cameras:', e);
                }
              }

              const config = cameras.length > 0 
                ? { deviceId: { exact: cameras[currentScannerCameraIndex % cameras.length].id } }
                : { facingMode: 'environment' };
              
              const promise = qr.start(
                config,
                { fps: 10, qrbox: 250, aspectRatio: 1.0 },
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
                await new Promise(r => setTimeout(r, 800));
                return startWithRetry(withZoom, retries - 1);
              }
              throw err;
            }
          };

          try {
            await startWithRetry(false);
          } catch (err) {
            console.warn('Start failed:', err);
            throw err;
          }
        } catch (err: any) { 
          console.error('Scanner error:', err);
          setError('Não foi possível acessar a câmera: ' + (err.message || String(err))); 
          setIsScannerOpen(false); 
        } finally {
          isScannerBusy.current = false;
        }
      });
    }, 600);
  };

  const internalStopScanner = async () => {
    return withScannerTransition(async () => {
      if (scannerStartPromise.current) {
        try { await scannerStartPromise.current; } catch { }
        scannerStartPromise.current = null;
      }

      if (scannerRef.current) {
        const qr = scannerRef.current;
        scannerRef.current = null;
        try { 
          if (qr.getState() === Html5QrcodeScannerState.SCANNING || qr.getState() === Html5QrcodeScannerState.PAUSED) {
            await qr.stop(); 
            await new Promise(r => setTimeout(r, 300));
          }
          await qr.clear(); 
        } catch (e) {
          console.warn('Error stopping scanner:', e);
        }
      }
      setIsScannerOpen(false);
    });
  };

  const switchCamera = async () => {
    if (scannerCameras.length <= 1) return;
    setCurrentScannerCameraIndex(prev => (prev + 1) % scannerCameras.length);
    // Restart scanner
    if (isScannerOpen) {
      await stopScanner();
      setTimeout(() => startScanner(), 500);
    }
  };

  const switchTrailerCamera = async () => {
    if (scannerCameras.length <= 1) return;
    setCurrentScannerCameraIndex(prev => (prev + 1) % scannerCameras.length);
    // Restart scanner
    if (trailerQrModal?.scannerActive) {
      await internalStopTrailerScanner();
      setTimeout(() => startTrailerScanner(), 500);
    }
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

  const [isMigrationConfirmOpen, setIsMigrationConfirmOpen] = useState(false);

  // =================================================================
  // MIGRAÇÃO
  // =================================================================
  const handleMigrate = async () => {
    console.log('[Migration] handleMigrate triggered. User:', auth.currentUser?.email, 'Category:', category);
    setIsMigrationConfirmOpen(false);
    
    setMigrationMessage({ text: 'Autenticando...', type: 'info' });
    setIsMigrating(true);
    try {
      if (!auth.currentUser) {
        console.log('[Migration] No user found, attempting sign in...');
        try {
          await signInWithPopup(auth, new GoogleAuthProvider());
        } catch (popupErr: any) {
          console.warn('[Migration] Google Sign-In failed, trying anonymous...', popupErr);
          await signInAnonymously(auth);
        }
        // Aguarda 2 segundos para o token ser propagado para o Firestore
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      console.log('[Migration] Starting data export and migration...');
      setMigrationMessage({ text: 'Migrando dados (isso pode demorar)...', type: 'info' });
      const result = await migrateDataToFirebase(category);
      
      console.log('[Migration] Result:', result);
      const userEmail = auth.currentUser?.email || 'Nenhum usuário logado';
      setMigrationMessage(result.success
        ? { text: `Migração concluída! Total: ${result.total} registros.`, type: 'success' }
        : { text: `Erro (${userEmail}): ` + result.error, type: 'error' });
    } catch (err: any) {
      console.error('[Migration] Catch error:', err);
      const userEmail = auth.currentUser?.email || 'Nenhum usuário logado';
      setMigrationMessage({ text: `Erro (${userEmail}): ` + err.message, type: 'error' });
    } finally {
      setIsMigrating(false);
      setTimeout(() => setMigrationMessage(null), 15000);
    }
  };

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

  const fetchAlerts = async () => {
    if (!category.includes('ADM')) return;
    setIsAlertsLoading(true);
    try {
      const r = await apiGetCall('getAlerts');
      if (r.success) { setAlerts(r.data); if (r.version) setBackendVersion(r.version); }
    } catch {} finally { setIsAlertsLoading(false); }
  };

  const handleConfirmFound = async (alertId: number) => {
    if (!window.confirm('Confirmar que esta bicicleta foi encontrada?')) return;
    setIsLoading(true);
    try {
      const r = await apiCall({ action: 'confirmBikeFound', alertId, driverName });
      if (r.success) { fetchAlerts(); alert('Bicicleta marcada como encontrada!'); }
      else throw new Error(r.error);
    } catch (err: any) { alert('Erro: ' + err.message); }
    finally { setIsLoading(false); }
  };

  const handleConfirmVandalizedFound = async (alertId: number) => {
    if (!window.confirm('Confirmar que esta bicicleta foi encontrada?')) return;
    setIsLoading(true);
    try {
      const r = await apiCall({ action: 'confirmVandalizedFound', alertId, driverName });
      if (r.success) { refreshAll(true); alert('Bicicleta vandalizada marcada como encontrada!'); }
      else throw new Error(r.error);
    } catch (err: any) { alert('Erro: ' + err.message); }
    finally { setIsLoading(false); }
  };

  const fetchDriversSummary = async () => {
    const range = summaryTimeRange;
    setIsSummaryLoading(true);
    try {
      const r = await apiCall({ action: 'getDriversSummary', timeRange: range, timelineDate }, 1, true);
      if (r.success && summaryTimeRange === range) {
        const filteredData = r.data.filter((d: any) => d.name?.toUpperCase() !== 'MECANICA');
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
      else if (!r.success) await runDriversSummaryFallback();
    } catch { await runDriversSummaryFallback(); }
    finally { setIsSummaryLoading(false); }
  };

  useEffect(() => { fetchDriversSummary(); }, [summaryTimeRange, timelineDate]);

  const runDriversSummaryFallback = async () => {
    const range = summaryTimeRange;
    try {
      const drivers: string[] = category.includes('ADM')
        ? ((await apiCall({ action: 'getMotoristas' })).data || []).filter((m: string) => m.toUpperCase() !== 'MECANICA')
        : [driverName];
      const reqResult = await apiCall({ action: 'getRequests', driverName, category }, 1, true);
      const allPending = reqResult.success ? reqResult.data : [];
      const summary = await Promise.all(drivers.map(async (d: string) => {
        const [stateRes, reportRes] = await Promise.all([
          apiCall({ action: 'getDriverState', driverName: d }),
          apiCall({ action: 'getDailyReportData', driverName: d, timeRange: range })
        ]);
        const stats = { recolhidas: 0, remanejada: 0, naoEncontrada: 0, naoAtendida: 0 };
        if (reportRes.success) {
          stats.recolhidas = reportRes.data.recolhidas?.length || 0;
          stats.remanejada = reportRes.data.remanejadas?.length || 0;
          stats.naoEncontrada = reportRes.data.naoEncontrada?.length || 0;
          stats.naoAtendida = reportRes.data.naoAtendida?.length || 0;
        }
        const pendingCount = allPending.filter((r: any) => {
          const rec = (r.recipient || 'Todos').toLowerCase();
          return rec === 'todos' || rec === d.toLowerCase();
        }).length;
        return { name: d, stats, realTime: { route: stateRes.success ? stateRes.data.routeBikes : [], collected: stateRes.success ? stateRes.data.collectedBikes : [] }, pendingRequests: pendingCount };
      }));
      if (summaryTimeRange === range) setDriversSummary(summary);
    } catch (err) { console.error('Fallback summary:', err); }
  };

  // =================================================================
  // REFRESH ALL
  //
  // Aplica dados do Sheets exceto driverState, que só é aplicado
  // se não houver ação recente do motorista (canSheetsOverride).
  // =================================================================
  const refreshAll = useCallback(async (force = false) => {
    refreshAllRef.current = refreshAll;
    if (!force && (document.visibilityState === 'hidden' || isUpdatingStateRef.current)) return;

    setIsSyncing(true);
    if (isAdm) { setIsSummaryLoading(true); setIsAlertsLoading(true); setIsVandalizedLoading(true); }

    const applyData = (d: any) => {
      if (d.requests) {
        const sheetsRequests = d.requests.filter((r: any) => {
          if (processedRequestIds.current.has(String(r.id))) return false;
          const status = (r.status || r.situacao || '').toString().toLowerCase().trim();
          return !status || status === 'pendente';
        });
        setPendingRequests(prev => {
          const firebaseOnly = prev.filter(r => {
            const id = String(r.id);
            const isFirestoreId = id.length > 10 && isNaN(Number(id));
            if (!isFirestoreId) return false;
            if (processedRequestIds.current.has(id)) return false;
            return !sheetsRequests.find((sr: any) => String(sr.id) === id);
          });
          return [...firebaseOnly, ...sheetsRequests];
        });
      }
      if (d.driverState && !isUpdatingStateRef.current && canSheetsOverride()) {
        applyStateFromSheets(
          d.driverState.routeBikes || [],
          d.driverState.collectedBikes || []
        );
      }

      if (d.bikeStatuses) setBikeConflicts(d.bikeStatuses);
      if (d.schedule) setUserSchedule(d.schedule);
      if (d.motoristas) {
        const filteredMotoristas = d.motoristas.filter((m: string) => m.toUpperCase() !== 'MECANICA');
        setMotoristas(filteredMotoristas);
      }
      if (d.driverLocations) {
        setDriverLocations(prev => {
          const fbLocations = prev.filter((l:any) => l.source === 'firebase');
          if (fbLocations.length === 0) {
            return d.driverLocations;
          }
          const fbNames = new Set(fbLocations.map((l:any) => l.driverName));
          const sheetsOnly = (d.driverLocations as any[]).filter((l:any) => !fbNames.has(l.driverName));
          return [...fbLocations, ...sheetsOnly.map((l:any) => ({ ...l, stale: true }))];
        });
      }
      if (d.mechanicsList) {
        setMechanicsList(() => {
          const now = Date.now();
          // Remove entradas expiradas do mapa de proteção
          Object.keys(mechanicOptimisticRef.current).forEach(k => {
            const v = mechanicOptimisticRef.current[k];
            if (v.expiresAt < now) delete mechanicOptimisticRef.current[k];
          });
          
          // Mescla: bikes protegidas mantêm o status local; demais usam o servidor
          const serverBikes = d.mechanicsList.map((serverBike: any) => {
            const protected_ = mechanicOptimisticRef.current[String(serverBike.patrimonio)];
            if (protected_ && protected_.expiresAt > now) {
              const protectedData = { ...protected_ };
              delete protectedData.expiresAt;
              return { ...serverBike, ...protectedData };
            }
            return serverBike;
          });

          // Se não há proteções ativas, usa lista do servidor diretamente
          if (Object.keys(mechanicOptimisticRef.current).length === 0) return serverBikes;

          // Adiciona bikes que estão protegidas mas não vieram na lista do servidor
          const serverPats = new Set(d.mechanicsList.map((b: any) => String(b.patrimonio)));
          const missingProtected = Object.keys(mechanicOptimisticRef.current)
            .filter(pat => !serverPats.has(pat) && mechanicOptimisticRef.current[pat].expiresAt > now)
            .map(pat => {
              const protectedData = { ...mechanicOptimisticRef.current[pat] };
              delete protectedData.expiresAt;
              return { patrimonio: pat, ...protectedData };
            });

          return [...serverBikes, ...missingProtected];
        });
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
        if (d.alerts) setAlerts(d.alerts);
        if (d.vandalized) setVandalizedBikes(d.vandalized);
        if (d.changeStatusData) setChangeStatusData(d.changeStatusData);
        if (d.adminAlerts) {
          const n = d.adminAlerts.length;
          setAlertCount(n);
          if (n > lastViewedAlertCountRef.current) {
            setHasNewAlerts(true);
          }
        }
      }
    };

    const today = localDateStr();
    const cacheKey = `cached_main_data_${driverName}_${category}_${today}`;

    try {
      setSyncError(null);
      syncFailCountRef.current = 0; // reset contador de falhas ao iniciar sync com sucesso

      if (isAdm) {
        // ADM: divide em 2 chamadas paralelas para evitar timeout do Apps Script (90s)
        const [baseResult, summaryResult] = await Promise.allSettled([
          apiCall({
            action: 'sync',
            driverName,
            category,
            summaryTimeRange,
            statusTimeRange,
            timelineDate,
          }, 3, true),
          apiCall({
            action: 'getDriversSummary',
            timeRange: summaryTimeRange,
            timelineDate,
          }, 3, true),
        ]);

        let hasAnySuccess = false;

        if (baseResult.status === 'fulfilled' && baseResult.value?.success) {
          applyData(baseResult.value.data);
          if (baseResult.value.version) setBackendVersion(baseResult.value.version);
          localStorage.setItem(cacheKey, JSON.stringify(baseResult.value.data));
          setLastSyncTime(new Date().toLocaleTimeString());
          hasAnySuccess = true;
        }

        if (summaryResult.status === 'fulfilled' && summaryResult.value?.success) {
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
  }, [driverName, category, summaryTimeRange, statusTimeRange, applyStateFromSheets, isAdm]);

  // Cache inicial por usuário e categoria e data
  useEffect(() => {
    const today = localDateStr();
    const cacheKey = `cached_main_data_${driverName}_${category}_${today}`;
    
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
      if (d.driverState) { setRouteBikes(d.driverState.routeBikes || []); setCollectedBikes(d.driverState.collectedBikes || []); }
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
        setMechanicsList(() => {
          const now = Date.now();
          // Remove entradas expiradas do mapa de proteção
          Object.keys(mechanicOptimisticRef.current).forEach(k => {
            const v = mechanicOptimisticRef.current[k];
            if (v.expiresAt < now) delete mechanicOptimisticRef.current[k];
          });
          
          // Mescla: bikes protegidas mantêm o status local; demais usam o servidor
          const serverBikes = d.mechanicsList.map((serverBike: any) => {
            const protected_ = mechanicOptimisticRef.current[String(serverBike.patrimonio)];
            if (protected_ && protected_.expiresAt > now) {
              const protectedData = { ...protected_ };
              delete protectedData.expiresAt;
              return { ...serverBike, ...protectedData };
            }
            return serverBike;
          });

          // Se não há proteções ativas, usa lista do servidor diretamente
          if (Object.keys(mechanicOptimisticRef.current).length === 0) return serverBikes;

          // Adiciona bikes que estão protegidas mas não vieram na lista do servidor
          const serverPats = new Set(d.mechanicsList.map((b: any) => String(b.patrimonio)));
          const missingProtected = Object.keys(mechanicOptimisticRef.current)
            .filter(pat => !serverPats.has(pat) && mechanicOptimisticRef.current[pat].expiresAt > now)
            .map(pat => {
              const protectedData = { ...mechanicOptimisticRef.current[pat] };
              delete protectedData.expiresAt;
              return { patrimonio: pat, ...protectedData };
            });

          return [...serverBikes, ...missingProtected];
        });
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
      if (d.alerts) setAlerts(d.alerts);
      if (d.vandalized) setVandalizedBikes(d.vandalized);
      if (d.changeStatusData) setChangeStatusData(d.changeStatusData);
    } catch {}
  }, []);

  // Sync periódico — 4s para reduzir delay percebido
  useEffect(() => {
    refreshAll();
    if (isTecnica) fetchTechnicaList();
    const fetchSt = async () => {
      try {
        const r = await apiGetCall('getStations');
        if (r.success && r.data) setStations(r.data.map((s: any) => ({ ...s, Latitude: normalizeCoord(s.Latitude), Longitude: normalizeCoord(s.Longitude) })));
      } catch {}
    };
    fetchSt();
    const interval = setInterval(() => {
      refreshAll();
      if (isTecnica) fetchTechnicaList();
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
  const GOOGLE_MAPS_KEY = (typeof import.meta !== 'undefined' && ((import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || (import.meta as any).env?.VITE_GOOGLE_MAPS_KEY)) || '';

  const getRoadDistance = useCallback(async (
    fromLat: number, fromLng: number,
    toLat: number, toLng: number
  ): Promise<{ distanceM: number, durationS: number }> => {
    try {
      if (GOOGLE_MAPS_KEY) {
        // Proxy via Apps Script — evita CORS do browser
        const result = await apiCall({
          action: 'getDirections',
          fromLat, fromLng, toLat, toLng
        }, 1, false);
        if (result.success && result.distanceM) {
          return { distanceM: result.distanceM, durationS: result.durationS };
        }
      }
      // OSRM gratuito — funciona direto do browser
      const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      if (data.code === 'Ok' && data.routes?.[0]) {
        return { distanceM: data.routes[0].distance, durationS: data.routes[0].duration };
      }
    } catch (e) {
      console.warn('[Routing] API falhou, usando Haversine:', e);
    }
    // Último fallback: Haversine
    const km = calculateDistance(fromLat, fromLng, toLat, toLng);
    return { distanceM: km * 1000, durationS: km * 180 };
  }, [GOOGLE_MAPS_KEY]);

  const buildOptimizedRoute = useCallback(async () => {
    if (!currentDriverLocation || !routeBikes.length) return;

    const bikesWithCoords = routeBikes
      .map(id => ({ id, details: routeBikesDetails[id] }))
      .filter(b => b.details?.currentLat && b.details?.currentLng);

    if (bikesWithCoords.length === 0) return;

    console.log(`[Routing] Otimizando rota para ${bikesWithCoords.length} bikes...`);

    // Nearest Neighbor partindo da posição do motorista
    let currentLat = currentDriverLocation.lat;
    let currentLng = currentDriverLocation.lng;
    const remaining = [...bikesWithCoords];
    const ordered: string[] = [];
    const newDistances: Record<string, { distance: string, duration: string, value: number, isRoad: boolean }> = {};

    while (remaining.length > 0) {
      // Calcula distância de carro de onde estou para cada bike restante
      const distances = await Promise.all(
        remaining.map(async b => {
          const { distanceM, durationS } = await getRoadDistance(
            currentLat, currentLng,
            b.details.currentLat, b.details.currentLng
          );
          return { bike: b, distanceM, durationS };
        })
      );

      // Pega a mais próxima
      distances.sort((a, b) => a.distanceM - b.distanceM);
      const nearest = distances[0];
      ordered.push(nearest.bike.id);

      const distKm = nearest.distanceM / 1000;
      const mins = Math.round(nearest.durationS / 60);
      newDistances[nearest.bike.id] = {
        distance: distKm < 1 ? `${nearest.distanceM.toFixed(0)}m` : `${distKm.toFixed(1)}km`,
        duration: `~${mins} min`,
        value: nearest.distanceM,
        isRoad: true
      };

      // Avança para a posição dessa bike
      currentLat = nearest.bike.details.currentLat;
      currentLng = nearest.bike.details.currentLng;
      remaining.splice(remaining.indexOf(nearest.bike), 1);
    }

    // Bikes sem coordenadas ficam no final
    const withoutCoords = routeBikes.filter(id => !bikesWithCoords.find(b => b.id === id));
    setRouteDistances(prev => ({ ...prev, ...newDistances }));
    // Reordena routeBikes na ordem otimizada
    setRouteBikes([...ordered, ...withoutCoords]);
    console.log('[Routing] Rota otimizada concluída.');
  }, [currentDriverLocation, routeBikes, routeBikesDetails, getRoadDistance]);

  // Hash de coordenadas para reagir quando as bikes se movem
  const bikesHash = useMemo(() => {
    return routeBikes.map(id => {
      const d = routeBikesDetails[id];
      return d ? `${d.currentLat},${d.currentLng}` : '';
    }).join('|');
  }, [routeBikes, routeBikesDetails]);

  // Dispara roteamento ao mudar posição ou bikes — com debounce de 3s
  useEffect(() => {
    if (!currentDriverLocation || !routeBikes.length) return;
    
    const timer = setTimeout(() => {
      if (bikesHash) console.log('[Routing] Iniciando otimização por mudança de posição/bikes');
      buildOptimizedRoute();
    }, 3000);
    return () => clearTimeout(timer);
  }, [currentDriverLocation?.lat, currentDriverLocation?.lng, routeBikes.length, bikesHash]);

  // Distâncias Haversine — mantido como display inicial antes do roteamento carregar
  useEffect(() => {
    if (!currentDriverLocation || !routeBikes.length) return;
    const dists: Record<string, any> = {};
    routeBikes.forEach(id => {
      const d = routeBikesDetails[id];
      // Sempre calcula Haversine como base de ordenação — sobrescrito pelo Nearest Neighbor quando disponível
      if (d?.currentLat && d?.currentLng && !routeDistances[id]?.isRoad) {
        const km = calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, d.currentLat, d.currentLng);
        dists[id] = { 
          distance: km < 1 ? `${(km*1000).toFixed(0)}m` : `${km.toFixed(1)}km`, 
          duration: `~${Math.round(km*3)} min`, 
          value: km*1000,
          isRoad: false 
        };
      }
    });
    if (Object.keys(dists).length > 0) setRouteDistances(prev => ({ ...prev, ...dists }));
  }, [currentDriverLocation, routeBikes, routeBikesDetails]);

  // GPS — máxima persistência, mesmo em background
  useEffect(() => {
    if (category.toUpperCase() !== 'MOTORISTA') return;
    if (!navigator.geolocation) { setGpsError('Seu navegador não suporta geolocalização.'); return; }

    let lastFirebaseLat = 0, lastFirebaseLng = 0, lastFirebaseTime = 0;
    let lastSheetsLat = 0, lastSheetsLng = 0, lastSheetsTime = 0;
    const locationBuffer: { latitude: number, longitude: number, timestamp: number }[] = [];
    let wakeLock: any = null;
    let watchId: number | null = null;
    let audioCtx: AudioContext | null = null;
    let silentSource: AudioBufferSourceNode | null = null;
    let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
    let worker: Worker | null = null;

    // Web Locks API — impede que o browser suspenda a aba por inatividade
    const requestWebLock = async () => {
      if ('locks' in navigator) {
        try {
          await (navigator as any).locks.request('gps_keepalive', { mode: 'exclusive' }, async () => {
            // Mantém o lock para sempre enquanto o app estiver rodando
            await new Promise(() => {}); 
          });
        } catch {}
      }
    };
    requestWebLock();

    // NoSleep — mantém app ativo no Samsung Internet e outros browsers Android
    // Usa video element invisível em loop (método mais compatível com Samsung)
    // + AudioContext como fallback para outros browsers
    let noSleepVideo: HTMLVideoElement | null = null;

    const startNoSleep = () => {
      try {
        // Método 1: Video element (Samsung Internet, Chrome Android)
        if (!noSleepVideo) {
          noSleepVideo = document.createElement('video');
          noSleepVideo.setAttribute('playsinline', '');
          noSleepVideo.setAttribute('muted', '');
          noSleepVideo.muted = true;
          noSleepVideo.loop = true;
          noSleepVideo.style.cssText = 'position:fixed;top:-1px;left:-1px;width:1px;height:1px;opacity:0;pointer-events:none;';
          // MP4 de 1 pixel de silêncio codificado em base64
          const src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAs1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE0MiByMjQ3OSBkZDc5YTYxIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxNCAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiBjaHJlYWRzPTYgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAABZWxpYnJhcnkAAAAMYXZjMQMAAAA=';
          noSleepVideo.src = src;
          document.body.appendChild(noSleepVideo);
        }
        noSleepVideo.play().catch(() => {});

        // Método 2: AudioContext como camada extra
        if (!audioCtx || audioCtx.state === 'closed') {
          try {
            audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
            silentSource = audioCtx.createBufferSource();
            silentSource.buffer = buffer;
            silentSource.loop = true;
            silentSource.connect(audioCtx.destination);
            silentSource.start(0);
          } catch {}
        }
        console.log('[GPS] NoSleep ativo (video + audio)');
      } catch (e) {
        console.warn('[GPS] NoSleep erro:', e);
      }
    };

    // Web Worker para Heartbeat — browsers suspendem setInterval em background (pode cair para 1 min)
    // O Web Worker roda em thread separada e é menos suscetível a throttling agressivo
    const startWorkerHeartbeat = () => {
      try {
        const workerCode = `
          let interval;
          self.onmessage = (e) => {
            if (e.data === 'start') {
              if (interval) clearInterval(interval);
              interval = setInterval(() => self.postMessage('tick'), 3000);
            } else if (e.data === 'stop') {
              clearInterval(interval);
            }
          };
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = () => {
          // Sempre que o worker "ticar", forçamos uma atualização de posição
          getCurrentAndSend();
          // E um beacon de rede
          fetch(window.location.href, { method: 'HEAD', cache: 'no-store' }).catch(() => {});
        };
        worker.postMessage('start');
        console.log('[GPS] Web Worker Heartbeat ativo');
      } catch (e) {
        console.warn('[GPS] Falha ao iniciar Web Worker:', e);
      }
    };

    const startSilentAudio = () => {
      startNoSleep();
      startWorkerHeartbeat();
      requestWebLock();
    };

    const stopSilentAudio = () => {
      try {
        silentSource?.stop();
        audioCtx?.close();
        audioCtx = null;
        silentSource = null;
      } catch {}
      try {
        if (noSleepVideo) {
          noSleepVideo.pause();
          noSleepVideo.remove();
          noSleepVideo = null;
        }
      } catch {}
      try {
        if (worker) {
          worker.postMessage('stop');
          worker.terminate();
          worker = null;
        }
      } catch {}
    };

    const sendLocation = (latitude: number, longitude: number, speed: number | null = null, force = false) => {
      const now = Date.now();
      
      // 1. FIREBASE: Alta frequência para fluidez no mapa ADM
      const movedFirebase = getDistanceInMeters(latitude, longitude, lastFirebaseLat, lastFirebaseLng);
      const elapsedFirebase = now - lastFirebaseTime;
      
      // Atualiza Firebase: sempre que passou 3s, ou moveu >1m, ou forçado
      // Sem checar movimento — garante heartbeat mesmo parado
      if (force || elapsedFirebase > 3000 || movedFirebase > 1) {
        lastFirebaseLat = latitude;
        lastFirebaseLng = longitude;
        lastFirebaseTime = now;
        
        // Mantém buffer das últimas 15 posições para preencher buracos de conexão no mapa ADM
        locationBuffer.push({ latitude, longitude, timestamp: now });
        if (locationBuffer.length > 15) locationBuffer.shift();

        // Converte m/s para km/h
        const speedKmh = speed !== null ? Math.round(speed * 3.6) : 0;

        setDoc(doc(db, 'locations', driverName), {
          driverName, latitude, longitude,
          timestamp: serverTimestamp(), 
          deviceTimestamp: now,
          pathBuffer: locationBuffer, // Envia o rastro recente para o AdminMap reconstruir se houver falha
          lastHeartbeat: serverTimestamp(), // Heartbeat para o Admin saber que o app está vivo
          category,
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

    // Atualiza o watchdog sempre que chega posição
    const sendLocationWithWatchdog = (lat: number, lng: number, spd: number | null = null, force = false) => {
      lastWatchTs = Date.now();
      sendLocation(lat, lng, spd, force);
    };

    const getCurrentAndSend = (force = false) => {
      navigator.geolocation.getCurrentPosition(
        ({ coords: { latitude, longitude, speed } }) => {
          setGpsError(null);
          setCurrentDriverLocation({ lat: latitude, lng: longitude });
          sendLocationWithWatchdog(latitude, longitude, speed, force);
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    };

    const startWatch = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = navigator.geolocation.watchPosition(
        ({ coords: { latitude, longitude, speed } }) => {
          setGpsError(null);
          setCurrentDriverLocation({ lat: latitude, lng: longitude });
          sendLocationWithWatchdog(latitude, longitude, speed);
        },
        err => {
          if (err.code === err.PERMISSION_DENIED)
            setGpsError('Acesso ao GPS negado. O aplicativo requer localização ativa.');
          else {
            console.warn('[GPS] watchPosition erro, reiniciando:', err.code);
            setTimeout(() => startWatch(), 2000);
          }
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
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
        // Retoma AudioContext se suspenso pelo browser (comum no iOS)
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        if (!audioCtx || audioCtx.state === 'closed') startSilentAudio();
        startWatch();
        getCurrentAndSend(true);
      }
    };

    // =============================================================
    // KEEPALIVE MULTI-CAMADA — garante GPS ativo mesmo em background
    // Camada 1: fallback GPS a cada 3s
    const fallbackInterval = setInterval(() => getCurrentAndSend(), 3000);

    // Camada 2: network beacon a cada 2s via fetch para HEAD no próprio app
    // O Android não suspende apps com atividade de rede ativa
    // Adicionamos um timestamp para evitar cache agressivo de proxies
    keepaliveInterval = setInterval(() => {
      fetch(`${window.location.href}?t=${Date.now()}`, { method: 'HEAD', cache: 'no-store', mode: 'no-cors' }).catch(() => {});
    }, 2000);

    // Camada 3: watchPosition com auto-restart agressivo
    // Se não receber posição por 8s, reinicia o watch
    let lastWatchTs = Date.now();
    const watchdogInterval = setInterval(() => {
      if (Date.now() - lastWatchTs > 8000) {
        console.warn('[GPS] Watchdog: watchPosition silencioso por 8s, reiniciando...');
        startWatch();
        getCurrentAndSend(true);
        lastWatchTs = Date.now();
      }
    }, 4000);

    // Camada 4: Monitoramento do AudioContext (essencial para iOS/Safari)
    const audioMonitorInterval = setInterval(() => {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    }, 5000);

    // pageshow: dispara quando volta de outra aba/app (inclui bfcache)
    const onPageShow = () => {
      requestWakeLock();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      if (!audioCtx || audioCtx.state === 'closed') startSilentAudio();
      startWatch();
      getCurrentAndSend(true);
    };

    // focus: volta quando o usuário retorna ao app
    const onFocus = () => {
      requestWakeLock();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      if (!audioCtx || audioCtx.state === 'closed') startSilentAudio();
      startWatch();
      getCurrentAndSend(true);
    };

    // Exponha o force update globalmente para o openMaps
    (window as any).__forceGpsUpdate = () => getCurrentAndSend(true);

    // Inicializa
    requestWakeLock();
    startSilentAudio();
    startWatch();
    getCurrentAndSend(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);

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
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      clearInterval(watchdogInterval);
      clearInterval(audioMonitorInterval);
      if (worker) {
        worker.postMessage('stop');
        worker.terminate();
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('beforeunload', markOffline);
      window.removeEventListener('pagehide', markOffline);
      if (wakeLock) wakeLock.release().catch(() => {});
      stopSilentAudio();
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
        <AlertTriangleIcon className="w-16 h-16 text-red-500 mb-4" />
        <h1 className="text-2xl font-bold text-gray-900 mb-2">GPS Obrigatório</h1>
        <p className="text-gray-600 mb-6 max-w-xs">{gpsError}<br /><br />O Move Bikes requer localização ativa.</p>
        <button onClick={() => window.location.reload()} className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 active:scale-95">Tentar Novamente</button>
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
    <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg w-full max-w-4xl mx-auto animate-fade-in-down">
      {migrationMessage && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[10000] p-4 rounded-lg shadow-2xl border flex items-center gap-3 ${
          migrationMessage.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
          migrationMessage.type === 'error'   ? 'bg-red-50 border-red-200 text-red-800' :
                                                'bg-blue-50 border-blue-200 text-blue-800'}`}>
          {migrationMessage.type === 'success' ? <CheckCircleIcon className="w-5 h-5" /> :
           migrationMessage.type === 'error'   ? <AlertTriangleIcon className="w-5 h-5" /> :
                                                 <RefreshIcon className="w-5 h-5 animate-spin" />}
          <p className="text-sm font-medium">{migrationMessage.text}</p>
          <button onClick={() => setMigrationMessage(null)} className="ml-2 opacity-50 hover:opacity-100"><XIcon className="w-4 h-4" /></button>
        </div>
      )}



      {/* Modal de Confirmação Migração */}
      {isMigrationConfirmOpen && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mb-4">
                <DatabaseIcon className="w-8 h-8 text-orange-600" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Migrar para Firebase</h3>
              <p className="text-gray-600 mb-6">
                Deseja iniciar a migração de todas as abas da planilha para o Firebase? 
                Isso pode levar alguns minutos e estabelecerá o Firebase como fonte de dados.
              </p>
              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  onClick={() => setIsMigrationConfirmOpen(false)}
                  className="py-3 bg-gray-100 text-gray-700 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleMigrate}
                  className="py-3 bg-orange-600 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-orange-200 hover:bg-orange-700 active:scale-95 transition-all"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
                  <p className="text-[10px] opacity-70 mt-0.5">QR Code + Bateria ≥ 85% + Comunicação &lt; 5 min</p>
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
                    <div id="qr-trailer-reader" className="w-full h-full bg-black" />
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                      <div className="w-44 h-44 border-2 border-green-400/60 rounded-xl" />
                    </div>
                    <div className="absolute top-2 right-2 flex gap-2">
                      {scannerCameras.length > 1 && (
                        <button onClick={switchTrailerCamera} className="bg-black/60 text-white p-1.5 rounded-full hover:bg-black/80 transition-colors">
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      )}
                      <button onClick={stopTrailerScanner} className="bg-black/60 text-white p-1.5 rounded-full hover:bg-black/80 transition-colors">
                        <XIcon className="w-4 h-4" />
                      </button>
                    </div>
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
                        Bike <span className="font-black">{batteryFailed}</span>: {pct !== undefined ? `${pct}%` : 'sem dados'} — mínimo exigido: 85%
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
                              <p className={`text-[9px] font-bold ${pct >= 85 ? 'text-green-600' : 'text-orange-600'}`}>
                                🔋 {pct}% {pct < 85 ? '(insuf.)' : ''}
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
              {technicaRepairModal.bike.mecanico && (
                <p className="text-[11px] opacity-80 mt-0.5">
                  Retornará para: <span className="font-bold">{technicaRepairModal.bike.mecanico}</span>
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
                A bike <span className="font-bold text-gray-800">{removeFromTrailerConfirm.patrimonio}</span> será removida da carretinha e voltará para <span className="font-bold text-orange-600">Em Manutenção</span> com o mecânico designado.
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
                    // Atualiza lista local — volta para Em Manutenção sem carretinha
                    setMechanicsList(prev => prev.map(b =>
                      b.patrimonio === patrimonio
                        ? { ...b, status: 'Em Manutenção', carretinha: null, dataFinalizacao: '' }
                        : b
                    ));
                    // Backend
                    try {
                      await apiCall({ action: 'removeFromTrailer', bikeNumber: patrimonio }, 1, false);
                    } catch (e: any) {
                      console.warn('[removeFromTrailer]', e.message);
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
          {isAdm && (
            <button onClick={() => setIsMigrationConfirmOpen(true)} disabled={isMigrating} title="Migrar para Firebase"
              className={`p-1.5 sm:p-2 rounded-full transition-colors ${isMigrating ? 'text-orange-500 animate-spin' : 'text-gray-500 hover:bg-gray-100 hover:text-orange-600'}`}>
              <DatabaseIcon className="w-6 h-6 sm:w-7 sm:h-7" />
            </button>
          )}
          {!isMecanica && !isTecnica && <>
            <button onClick={() => setRequestModalOpen(true)} disabled={isLoading} title="Nova Solicitação" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><PlusIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
            <button onClick={() => setRouteModalOpen(true)} disabled={isLoading} title="Criar Roteiro" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><PlusPlusIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
            <button onClick={() => {
              setIsAdminAlertsOpen(true);
              setHasNewAlerts(false);
              lastViewedAlertCountRef.current = alertCount;
              try { localStorage.setItem('lastViewedAlertCount', String(alertCount)); } catch {}
            }} disabled={isLoading} title="Alertas"
              className={`p-1.5 sm:p-2 rounded-full relative disabled:opacity-50 ${hasNewAlerts && alertCount > 0 ? 'text-red-600 bg-red-50 animate-pulse' : 'text-gray-500 hover:bg-gray-100 hover:text-red-600'}`}>
              <AlertTriangleIcon className={`w-6 h-6 sm:w-7 sm:h-7 ${hasNewAlerts && alertCount > 0 ? 'animate-bounce' : ''}`}/>
              {alertCount > 0 && <span className="absolute top-0 right-0 bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full border-2 border-white">{alertCount}</span>}
            </button>
            {isAdm && <button onClick={onShowMap} disabled={isLoading} title="Mapa" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><MapIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>}
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
          <button onClick={onLogout} disabled={isLoading} title="Sair" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-red-600 disabled:opacity-50"><LogoutIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
        </div>
      </header>

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
            {driversSummary.filter(d => d.name.toLowerCase() === driverName.toLowerCase()).map((driver, i) => (
              <div key={`driver-resume-${driver.name}-${i}`} className="grid grid-cols-5 gap-1.5">
                {[
                  { label: 'Notif.', value: driver.pendingRequests, c: 'blue' },
                  { label: 'Recolh.', value: driver.stats.recolhidas, c: 'green' },
                  { label: 'Remanej.', value: driver.stats.remanejada, c: 'indigo' },
                  { label: 'Não Enc.', value: driver.stats.naoEncontrada, c: 'red' },
                  { label: 'Não Atend.', value: driver.stats.naoAtendida || 0, c: 'orange' },
                ].map((item, i) => (
                  <div key={`stat-${item.label}-${i}`} className={`bg-${item.c}-50 p-1.5 rounded border border-${item.c}-100 text-center`}>
                    <p className={`text-[8px] text-${item.c}-600 font-black uppercase leading-tight`}>{item.label}</p>
                    <p className={`text-sm font-black text-${item.c}-800`}>{item.value}</p>
                  </div>
                ))}
              </div>
            ))}
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
          const byMechanic: Record<string, {manutencao: number, reserva: number}> = {};
          sourceList.filter(b => activeStatuses.includes(b.status)).forEach(b => {
            const m = b.mecanico || '—';
            if (!byMechanic[m]) byMechanic[m] = { manutencao: 0, reserva: 0 };
            const entryDate = b.dataEntrada ? new Date(b.dataEntrada) : null;
            if (!entryDate || entryDate >= cutoff) {
              const isMainStatus = isTecnica ? b.status === 'Em Técnica' : b.status === 'Em Manutenção';
              if (isMainStatus) byMechanic[m].manutencao++;
              else byMechanic[m].reserva++;
            }
          });
          const mechs = Object.entries(byMechanic);
          return (
            <div className="mb-3 px-3 py-2 border rounded-lg bg-white shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-black text-gray-600 uppercase tracking-widest">Produção</span>
                <div className="flex bg-gray-100 rounded-full p-0.5 gap-0.5">
                  {periods.map(p => (
                    <button key={p.key} onClick={() => setMechanicSummaryPeriod(p.key)}
                      className={`text-[8px] font-bold px-2 py-0.5 rounded-full transition-all ${mechanicSummaryPeriod === p.key ? 'bg-white text-gray-700 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                    >{p.label}</button>
                  ))}
                </div>
              </div>
              {mechs.length === 0 ? (
                <p className="text-[9px] text-gray-400 italic text-center py-1">Sem dados</p>
              ) : (
                <div className="space-y-1.5">
                  {mechs.map(([name, counts]) => (
                    <div key={name} className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-gray-500 uppercase w-16 truncate flex-shrink-0">{name}</span>
                      <div className="flex gap-1.5 flex-1">
                        <div className="flex flex-col items-center py-0.5 px-2 bg-orange-50 border border-orange-100 rounded-md flex-1">
                          <span className="text-[7px] font-bold text-orange-400 uppercase leading-none">{isTecnica ? 'Téc' : 'Man'}</span>
                          <span className="text-sm font-black text-orange-500 leading-tight">{counts.manutencao}</span>
                        </div>
                        <div className="flex flex-col items-center py-0.5 px-2 bg-green-50 border border-green-100 rounded-md flex-1">
                          <span className="text-[7px] font-bold text-green-500 uppercase leading-none">{isTecnica ? 'Agu' : 'Res'}</span>
                          <span className="text-sm font-black text-green-600 leading-tight">{counts.reserva}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
                  <div id="qr-reader" className="w-full h-full bg-black"/>
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center"><div className="w-48 h-48 border-2 border-blue-400/50 rounded-lg"/></div>
                  <div className="absolute top-2 right-2 flex gap-2">
                    {scannerCameras.length > 1 && (
                      <button onClick={switchCamera} className="bg-black/50 text-white p-1.5 rounded-full hover:bg-black/70 transition-colors">
                        <RefreshCw className="w-4 h-4"/>
                      </button>
                    )}
                    <button onClick={stopScanner} className="bg-black/50 text-white p-1.5 rounded-full hover:bg-black/70 transition-colors">
                      <XIcon className="w-4 h-4"/>
                    </button>
                  </div>
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
                <button onClick={() => openMaps(searchedBike['Latitude'], searchedBike['Longitude'])}
                  className="text-blue-600 hover:underline font-medium truncate block text-left">
                  {`${formatCoordinate(searchedBike['Latitude'])}, ${formatCoordinate(searchedBike['Longitude'])}`}
                </button>
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
                <p className="text-gray-800 font-medium">{formatBattery(searchedBike['Bateria'])}%</p>
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
                    setIsLoading(true);
                    try {
                      await apiCall({ action: 'sendToTechnical', bikeNumber: pat, mechanicName: driverName }, 1, false);
                      await fetchTechnicaList();
                      setSearchedBike(null); setSearchTerm('');
                      setSuccessMessage(`Bike ${pat} em Aguardando Técnica.`);
                    } catch(e: any) { setError(e.message); }
                    finally { setIsLoading(false); }
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
                    <button onClick={() => handleAcceptRequest(req.id, req.bikeNumber, req.reason, req.title)} disabled={isLoading} className="text-green-600 hover:text-green-700 text-sm font-bold disabled:text-gray-400">Aceitar</button>
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Alterar status' ? null : 'Alterar status')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Alterar status' ? 'bg-purple-600 border-purple-700 text-white' : 'bg-purple-50 border-purple-100 hover:bg-purple-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeMechanicCategory === 'Alterar status' ? 'bg-white text-purple-600' : 'bg-purple-600 text-white'}`}>
                <PlusPlusIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeMechanicCategory === 'Alterar status' ? 'text-white' : 'text-purple-800'}`}>Alterar status</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeMechanicCategory === 'Alterar status' ? 'text-white' : 'text-purple-600'}`}>
                {mechanicsList.filter(b => b.status === 'Alterar Status' || b.status === 'Não encontrada').length}
              </span>
            </button>
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Aguardando manutenção' ? null : 'Aguardando manutenção')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Aguardando manutenção' ? 'bg-blue-600 border-blue-700 text-white' : 'bg-blue-50 border-blue-100 hover:bg-blue-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeMechanicCategory === 'Aguardando manutenção' ? 'bg-white text-blue-600' : 'bg-blue-600 text-white'}`}>
                <CarIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeMechanicCategory === 'Aguardando manutenção' ? 'text-white' : 'text-blue-800'}`}>Aguardando manutenção</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeMechanicCategory === 'Aguardando manutenção' ? 'text-white' : 'text-blue-600'}`}>
                {mechanicsList.filter(b => b.status === 'Aguardando Manutenção').length}
              </span>
            </button>
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Manutenção' ? null : 'Manutenção')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Manutenção' ? 'bg-orange-600 border-orange-700 text-white' : 'bg-orange-50 border-orange-100 hover:bg-orange-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeMechanicCategory === 'Manutenção' ? 'bg-white text-orange-600' : 'bg-orange-600 text-white'}`}>
                <BicycleIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeMechanicCategory === 'Manutenção' ? 'text-white' : 'text-orange-800'}`}>Em manutenção</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeMechanicCategory === 'Manutenção' ? 'text-white' : 'text-orange-600'}`}>
                {mechanicsList.filter(b => b.status === 'Em Manutenção').length}
              </span>
            </button>
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Reserva' ? null : 'Reserva')}
              className={`flex flex-col items-center justify-center p-2 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Reserva' ? 'bg-green-600 border-green-700 text-white' : 'bg-green-50 border-green-100 hover:bg-green-100'}`}
            >
              <div className={`p-1.5 rounded-full mb-1 ${activeMechanicCategory === 'Reserva' ? 'bg-white text-green-600' : 'bg-green-600 text-white'}`}>
                <CarIcon className="w-4 h-4" />
              </div>
              <span className={`text-[8px] font-bold text-center leading-tight h-5 flex items-center ${activeMechanicCategory === 'Reserva' ? 'text-white' : 'text-green-800'}`}>Reserva</span>
              <span className={`mt-0.5 text-[10px] font-black ${activeMechanicCategory === 'Reserva' ? 'text-white' : 'text-green-600'}`}>
                {mechanicsList.filter(b => b.status === 'Reserva').length}
              </span>
            </button>
          </div>
        )}

        {/* MECÂNICA */}
        {isMecanica && activeMechanicCategory && (
          <div className="mt-6 space-y-6">
            {activeMechanicCategory === 'Alterar status' && (
              <div id="section-alterar-status" className="p-4 border rounded-lg bg-purple-50 shadow-sm scroll-mt-4">
                <div className="flex items-center justify-between mb-3">
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
                {mechanicsList.filter(b => b.status === 'Alterar Status' || b.status === 'Não encontrada').length > 0 ? (
                  <div className="space-y-2">
                    {mechanicsList.filter(b => b.status === 'Alterar Status' || b.status === 'Não encontrada').map((bike, i) => {
                      const isNotFound = bike.status === 'Não encontrada';
                      return (
                        <div key={`mec-alterar-${bike.patrimonio}-${i}`} 
                          className={`flex justify-between items-center p-3 bg-white border rounded-md shadow-sm ${isNotFound ? 'border-red-400 ring-1 ring-red-400' : ''}`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className={`font-bold ${isNotFound ? 'text-red-600' : 'text-gray-700'}`}>Bike: {bike.patrimonio}</span>
                              {isNotFound && (
                                <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-[8px] font-black rounded border border-red-200 animate-pulse">
                                  PENDENTE / NÃO ENCONTRADA
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                              {bike.bateria !== undefined && <p className="text-[10px] text-gray-600">Bateria: {bike.bateria}%</p>}
                              {bike.carregamento === 'Carregando' && <p className="text-[10px] text-green-600 font-bold">⚡ Carregando</p>}
                              {bike.carregamento === 'Não carregando' && <p className="text-[10px] text-red-500 font-bold">🔌 Não carregando</p>}
                            </div>
                            {bike.motorista && <p className="text-[10px] text-blue-700 font-semibold">Motorista: {bike.motorista}</p>}
                            {bike.observacao && <p className="text-[10px] text-orange-600">Motivo: {bike.observacao}</p>}
                            {isNotFound && <p className="text-[10px] text-red-500 italic mt-1">Aguardando localização...</p>}
                          </div>
                          <div className="flex flex-col gap-2 min-w-[100px]">
                            {!isNotFound ? (
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
                ) : <p className="text-sm text-gray-500 italic">Nenhuma bike.</p>}
              </div>
            )}

            {activeMechanicCategory === 'Aguardando manutenção' && (
              <div id="section-aguardando-manutencao" className="p-4 border rounded-lg bg-blue-50 shadow-sm scroll-mt-4">
                <h2 className="text-lg font-bold text-blue-800 mb-3 flex items-center gap-2"><CarIcon className="w-5 h-5"/>Aguardando Manutenção</h2>
                {mechanicsList.filter(b => b.status === 'Aguardando Manutenção').length > 0 ? (
                  <div className="space-y-2">
                    {mechanicsList.filter(b => b.status === 'Aguardando Manutenção').map((bike, i) => (
                      <div key={`mec-aguardando-${bike.patrimonio}-${i}`} className="flex justify-between items-center p-3 bg-white border rounded-md shadow-sm">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-gray-700">Bike: {bike.patrimonio}</span>
                          </div>
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                            {bike.bateria !== undefined && <p className="text-[10px] text-gray-600">Bateria: {bike.bateria}%</p>}
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
                ) : <p className="text-sm text-gray-500 italic">Nenhuma bike.</p>}
              </div>
            )}

            {activeMechanicCategory === 'Manutenção' && (
              <div id="section-manutencao" className="p-4 border rounded-lg bg-orange-50 shadow-sm scroll-mt-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                  <h2 className="text-lg font-bold text-orange-800 flex items-center gap-2"><BicycleIcon className="w-5 h-5"/>Mecânica - Em Manutenção</h2>
                  
                  {/* Filtro por Mecânico */}
                  <div className="flex items-center gap-2">
                    <label htmlFor="mechanic-filter" className="text-xs font-bold text-gray-600">Filtrar:</label>
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
                </div>

                {(() => {
                  const filteredBikes = mechanicsList.filter(b => 
                    b.status === 'Em Manutenção' && 
                    (selectedMechanicFilter === 'Todos' || b.mecanico === selectedMechanicFilter)
                  );
                  
                  return filteredBikes.length > 0 ? (
                    <div className="space-y-2">
                      {filteredBikes.map((bike, i) => (
                        <div key={`mec-manut-${bike.patrimonio}-${i}`} className="flex justify-between items-center p-3 bg-white border rounded-md shadow-sm">
                          <div>
                            <span className="font-bold text-gray-700">Bike: {bike.patrimonio}</span>
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                              {bike.bateria !== undefined && <p className="text-[10px] text-gray-600">Bateria: {bike.bateria}%</p>}
                              {bike.carregamento === 'Carregando' && <p className="text-[10px] text-green-600 font-bold">⚡ Carregando</p>}
                              {bike.carregamento === 'Não carregando' && <p className="text-[10px] text-red-500 font-bold">🔌 Não carregando</p>}
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
                <div className="flex justify-between items-center mb-3">
                  <h2 className="text-lg font-bold text-green-800 flex items-center gap-2"><CarIcon className="w-5 h-5"/>Reserva - Prontas para Remanejamento</h2>
                  <button 
                    onClick={() => {
                      // Abre scanner para qualquer bike na reserva (Sem Carretinha ou não)
                      startScanner(); // Usa o scanner geral, mas vamos tratar o sucesso
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-bold hover:bg-green-700 shadow-sm transition-all active:scale-95"
                  >
                    <QrCodeIcon className="w-4 h-4"/>Escanear para Carretinha
                  </button>
                </div>
                {mechanicsList.filter(b => b.status === 'Reserva').length > 0 ? (
                  <div className="space-y-4">
                    {Object.entries(
                      mechanicsList.filter(b => b.status === 'Reserva').reduce((acc, bike) => {
                        const key = bike.carretinha || 'Sem Carretinha';
                        if (!acc[key]) acc[key] = [];
                        acc[key].push(bike);
                        return acc;
                      }, {} as Record<string, any[]>)
                    ).map(([trailer, bikes]) => (
                      <div key={trailer} className="border border-green-200 rounded-md bg-white p-3 shadow-sm">
                        <div className="flex justify-between items-center mb-2 border-b pb-1">
                          <div className="flex flex-col">
                            <h3 className="font-bold text-green-700 flex items-center gap-2"><CarIcon className="w-4 h-4"/>{trailer}</h3>
                            {trailer !== 'Sem Carretinha' && bikes[0]?.trailerStatus === 'finalized' && (
                              <span className="text-[8px] font-bold text-orange-600 uppercase">Aguardando Validação ADM</span>
                            )}
                            {trailer !== 'Sem Carretinha' && bikes[0]?.trailerStatus === 'assigned' && (
                              <span className="text-[8px] font-bold text-blue-600 uppercase">Aguardando Aceite Motorista</span>
                            )}
                          </div>
                          {trailer !== 'Sem Carretinha' && (
                            <div className="flex gap-1">
                              {(!bikes[0]?.trailerStatus || bikes[0]?.trailerStatus === 'finalized') && (
                                <button 
                                  onClick={() => handleFinalizeTrailer(trailer)} 
                                  className={`text-[10px] px-2 py-0.5 rounded font-bold transition-all ${bikes[0]?.trailerStatus === 'finalized' ? 'bg-orange-500 hover:bg-orange-600' : 'bg-green-600 hover:bg-green-700'} text-white`}
                                >
                                  {bikes[0]?.trailerStatus === 'finalized' ? 'Re-Finalizar' : 'Finalizar Carretinha'}
                                </button>
                              )}
                              {bikes[0]?.trailerStatus === 'finalized' && (
                                <button 
                                  onClick={() => {
                                    // Permite editar: remove status finalized para permitir alteração
                                    bikes.forEach(b => {
                                      updateDoc(doc(db, 'bikes', b.patrimonio), { trailerStatus: null, ultimaAtualizacao: serverTimestamp() }).catch(() => {});
                                    });
                                    alert('Carretinha aberta para edição!');
                                    refreshAll(true);
                                  }}
                                  className="text-[10px] bg-blue-500 text-white px-2 py-0.5 rounded font-bold hover:bg-blue-600"
                                >
                                  Editar
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {(bikes as any[]).map((bike, i) => (
                            <div key={`trailer-${bike.patrimonio}-${i}`} className="relative text-xs p-1.5 bg-gray-50 border rounded text-center font-medium text-gray-700 flex flex-col items-center gap-0.5">
                              {trailer !== 'Sem Carretinha' && (!bike.trailerStatus) && (
                                <button 
                                  onClick={async () => {
                                    if (window.confirm(`Remover bike ${bike.patrimonio} da ${trailer}?`)) {
                                      await updateDoc(doc(db, 'bikes', bike.patrimonio), { carretinha: null, trailerStatus: null, ultimaAtualizacao: serverTimestamp() });
                                      refreshAll(true);
                                    }
                                  }}
                                  className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 shadow-sm hover:bg-red-600 z-10"
                                >
                                  <XIcon className="w-2.5 h-2.5" />
                                </button>
                              )}
                              <span className="font-bold">{bike.patrimonio}</span>
                              <div className="flex flex-col items-center scale-90 origin-top">
                                {bike.bateria !== undefined && <span className="text-[8px] text-gray-500">{bike.bateria}%</span>}
                                {bike.carregamento === 'Carregando' && <span className="text-[8px] text-green-600 font-bold">⚡</span>}
                                {bike.carregamento === 'Não carregando' && <span className="text-[8px] text-red-500 font-bold">🔌</span>}
                              </div>
                              {bike.mecanico && <span className="text-[7px] text-blue-600 truncate max-w-full">{bike.mecanico}</span>}
                            </div>
                          ))}
                        </div>
                        {trailer === 'Sem Carretinha' && (
                          <button onClick={() => {
                            // Calcula próximo número de carretinha (1→2→3→4→1...)
                            const MAX_TRAILERS = 4;
                            const usedNumbers = mechanicsList
                              .filter(b => b.carretinha && b.carretinha !== 'Sem Carretinha')
                              .map(b => {
                                const m = String(b.carretinha).match(/(\d+)$/);
                                return m ? parseInt(m[1]) : 0;
                              })
                              .filter(n => n > 0);
                            let next = 1;
                            for (let i = 1; i <= MAX_TRAILERS; i++) {
                              if (!usedNumbers.includes(i)) { next = i; break; }
                            }
                            // Se todos ocupados, reutiliza o 1
                            const nextName = `Carretinha ${next}`;
                            // Passa direto para handleOrganizeTrailer sem abrir modal de nome
                            handleOrganizeTrailer((bikes as any[]).map(b => b.patrimonio), nextName);
                          }}
                            className="mt-3 w-full py-1.5 bg-blue-600 text-white text-[10px] font-bold rounded hover:bg-blue-700">
                            Organizar em Carretinha
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-gray-500 italic">Nenhuma bike na reserva.</p>}
              </div>
            )}
          </div>
        )}

        {/* ÍCONES DE ATALHO TÉCNICA */}
        {isTecnica && (
          <div className="grid grid-cols-2 gap-2 mb-6 mt-6">
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
                      {technicaList.filter(b => b.status === 'Aguardando Técnica').map((bike, i) => (
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
                    {technicaList.filter(b => b.status === 'Em Técnica').map((bike, i) => (
                      <div key={`tec-em-${bike.patrimonio}-${i}`} className="flex justify-between items-center p-3 bg-white border rounded-md shadow-sm">
                        <div>
                          <p className="font-bold text-gray-700">Bike: {bike.patrimonio}</p>
                          {bike.bateria !== undefined && <p className="text-[10px] text-gray-500">Bateria: {bike.bateria}%</p>}
                          {bike.mecanico && <p className="text-[10px] text-orange-600 font-semibold">Técnico: {bike.mecanico}</p>}
                          {bike.dataEntrada && <p className="text-[10px] text-gray-400">{new Date(bike.dataEntrada).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</p>}
                          {bike.tratativa && bike.tratativa !== 'MANUAL' && <p className="text-[10px] text-gray-500 italic">Obs: {bike.tratativa}</p>}
                        </div>
                        <button
                          onClick={() => handleFinalizeTechnicaRepair(bike)}
                          disabled={isLoading}
                          className="px-3 py-1.5 bg-orange-600 text-white text-xs font-bold rounded hover:bg-orange-700 active:scale-95 disabled:bg-gray-400 transition-colors"
                        >
                          Finalizar Reparo
                        </button>
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
                { key: 'summary', icon: <UserIcon className="w-5 h-5"/>, color: 'blue', title: 'Resumo' },
                { key: 'alerts', icon: <AlertIcon className="w-5 h-5"/>, color: 'red', title: 'Alertas' },
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
                { key: 'bike_search', icon: <SearchIcon className="w-5 h-5"/>, color: 'purple', title: 'Busca de Bike' },
                { key: 'boletim', icon: <SheetIcon className="w-5 h-5"/>, color: 'blue', title: 'Boletim' },
              ].map(({ key, icon, color, title }) => (
                <button key={key} onClick={() => setActiveQuadrant(key as any)}
                  title={title}
                  className={`p-2 rounded-full transition-all ${activeQuadrant === key ? `bg-${color}-600 text-white shadow-md` : 'bg-gray-200 text-gray-500'}`}>
                  {icon}
                </button>
              ))}
            </div>

            <div className="relative w-full overflow-hidden rounded-lg border bg-gray-50 shadow-inner min-h-[400px]">
              <div className="flex transition-transform duration-500 ease-in-out"
                style={{ transform: `translateX(${activeQuadrant === 'summary' ? '0%' : activeQuadrant === 'alerts' ? '-100%' : activeQuadrant === 'vandalized' ? '-200%' : activeQuadrant === 'status' ? '-300%' : activeQuadrant === 'mechanics' ? '-400%' : activeQuadrant === 'bike_search' ? '-500%' : '-600%'})` }}>

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
                            const sheetsEvents = (driver.timeline || []) as Array<{tsMs: number, hour: number, min: number, type: string, bikeNumber?: string}>;
                            // Eventos Firebase (em_posse) disponíveis para a data selecionada
                            const fbEvents = (firebaseTimelineEvents[driver.name] || []).map((e: any) => ({
                              tsMs: e.tsMs, hour: new Date(e.tsMs).getHours(),
                              min: new Date(e.tsMs).getMinutes(), type: e.type, bikeNumber: e.bikeNumber
                            }));
                            const merged = [...sheetsEvents];
                            fbEvents.forEach(fe => {
                              const isDup = sheetsEvents.some(se => se.type === fe.type && Math.abs(se.tsMs - fe.tsMs) < 2 * 60 * 1000);
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
                            const clusters: Array<{type: string, tsMs: number, bikes: string[], count: number, observacoes: string[]}> = [];
                            events.forEach(ev => {
                              const last = clusters[clusters.length - 1];
                              if (last && last.type === ev.type && Math.abs(ev.tsMs - last.tsMs) < CLUSTER_MS) {
                                last.count++;
                                if (ev.bikeNumber && !last.bikes.includes(ev.bikeNumber)) last.bikes.push(ev.bikeNumber);
                                if (ev.observacao && !last.observacoes.includes(ev.observacao)) last.observacoes.push(ev.observacao);
                                last.tsMs = Math.round((last.tsMs * (last.count - 1) + ev.tsMs) / last.count);
                              } else {
                                clusters.push({
                                  type: ev.type,
                                  tsMs: ev.tsMs,
                                  bikes: ev.bikeNumber ? [ev.bikeNumber] : [],
                                  observacoes: ev.observacao ? [ev.observacao] : [],
                                  count: 1
                                });
                              }
                            });

                            const dotConfig: Record<string, {bg: string, label: string}> = {
                              em_posse:      { bg: 'bg-green-500',   label: 'Em Posse' },
                              recolhida:     { bg: 'bg-green-700',   label: 'Recolhida (Filial)' },
                              estacao:       { bg: 'bg-indigo-500',  label: 'Estação' },
                              filial:        { bg: 'bg-blue-500',    label: 'Filial' },
                              nao_atendida:  { bg: 'bg-yellow-500',  label: 'Não atend.' },
                              nao_encontrada:{ bg: 'bg-red-500',     label: 'Não enc.' },
                              carretinha:    { bg: 'bg-purple-600',  label: 'Carretinha' },
                            };

                            return (
                              <div className="mb-3">
                                <div className="flex items-center justify-between mb-1.5">
                                  <p className="text-[8px] font-black text-gray-400 uppercase tracking-wider">Linha do Tempo</p>
                                  <button
                                    onClick={() => setTimelineModal({ driver: driver.name, events: clusters, startMs: startMs!, endMs: endMs! })}
                                    className="text-[8px] text-blue-500 font-bold hover:underline"
                                  >⤢ Expandir</button>
                                </div>
                                <div className="relative h-5 mx-1">
                                  <div className="absolute top-2 left-0 right-0 h-px bg-gray-900"/>
                                  <span className="absolute top-3.5 left-0 text-[7px] text-gray-400 font-mono">{fmtTime(startMs!)}</span>
                                  <span className="absolute top-3.5 right-0 text-[7px] text-gray-400 font-mono">{fmtTime(endMs!)}</span>
                                  {clusters.map((cl, ci) => {
                                    const pos = toPos(cl.tsMs);
                                    const cfg = dotConfig[cl.type] || { bg: 'bg-gray-400', label: cl.type };
                                    const isMulti = cl.count > 1;
                                    return (
                                      <div key={ci} className="absolute -translate-x-1/2 top-0.5 flex flex-col items-center"
                                        style={{left: `${pos}%`}}
                                        title={`${cl.type === 'carretinha' && cl.observacoes?.[0] ? cl.observacoes[0] : cfg.label}${cl.type === 'em_posse' && cl.bikes.length > 0 ? ` Bike ${cl.bikes.join(', ')}` : isMulti ? ` (${cl.count} bikes)` : ''} — ${fmtTime(cl.tsMs)}`}
                                      >
                                        <div className={`rounded-full border-2 border-white shadow-sm flex items-center justify-center ${isMulti ? 'w-4 h-4' : 'w-2.5 h-2.5'} ${cfg.bg}`}>
                                          {isMulti && <span className="text-[7px] font-black text-white leading-none">{cl.count}</span>}
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
                                </div>
                              </div>
                            );
                          })()}
                          <div className="grid grid-cols-5 gap-1.5 mb-3">
                            {[
                              { l: 'Notif.', v: driver.pendingRequests, c: 'blue' },
                              { l: 'Recolh.', v: driver.stats.recolhidas, c: 'green' },
                              { l: 'Remanej.', v: driver.stats.remanejada, c: 'indigo' },
                              { l: 'Não Enc.', v: driver.stats.naoEncontrada, c: 'red' },
                              { l: 'Não Atend.', v: driver.stats.naoAtendida || 0, c: 'orange' },
                            ].map((item, i) => (
                              <div key={`adm-stat-${item.l}-${i}`} className={`bg-${item.c}-50 p-1.5 rounded border border-${item.c}-100 text-center`}>
                                <p className={`text-[8px] text-${item.c}-600 font-black uppercase leading-tight`}>{item.l}</p>
                                <p className={`text-sm font-black text-${item.c}-800`}>{item.v}</p>
                              </div>
                            ))}
                          </div>
                          <div className="mb-2">
                            <p className="text-[9px] font-black text-gray-500 uppercase mb-1">Bikes em Posse ({driver.realTime.collected.length})</p>
                            {driver.realTime.collected.length > 0
                              ? <div className="flex flex-wrap gap-1">{driver.realTime.collected.map((b: string) => <span key={b} className="px-1.5 py-0.5 bg-gray-50 text-gray-700 rounded text-[10px] font-mono border border-gray-200">{b}</span>)}</div>
                              : <p className="text-[9px] text-gray-400 italic">Nenhuma bike recolhida</p>}
                          </div>
                          <div>
                            <p className="text-[9px] font-black text-gray-500 uppercase mb-1">Roteiro Atual ({driver.realTime.route.length})</p>
                            {driver.realTime.route.length > 0
                              ? <div className="flex flex-wrap gap-1">{driver.realTime.route.map((b: string) => <span key={b} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px] font-mono border border-blue-100">{b}</span>)}</div>
                              : <p className="text-[9px] text-gray-400 italic">Roteiro vazio</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-center py-6 bg-white rounded-lg border border-dashed"><p className="text-gray-400 text-xs">Carregando...</p></div>}
                </div>

                {/* Quadrante 2: Alertas */}
                <div className="w-full flex-shrink-0 p-3">
                  <h2 className="text-base font-bold text-gray-700 flex items-center gap-2 mb-4"><AlertIcon className="w-4 h-4 text-red-600"/>Bikes em Alerta</h2>
                  <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
                    <table className="w-full text-left border-collapse">
                      <thead><tr className="bg-gray-100 border-b">
                        {['Patrimônio','Check 1','Check 2','Check 3','Ação'].map(h => (
                          <th key={h} className="p-2 text-[10px] font-black text-gray-600 uppercase text-center first:text-left">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {alerts.length > 0 ? alerts.map((alert, i) => (
                          <tr key={`alert-${alert.id}-${i}`} className="border-b hover:bg-gray-50">
                            <td className="p-2 font-mono text-xs font-bold text-gray-700">{alert.patrimonio}</td>
                            {['check1','check2','check3'].map(c => (
                              <td key={c} className="p-2 text-center"><input type="checkbox" checked={!!alert[c]} readOnly className="w-4 h-4 rounded border-gray-300"/></td>
                            ))}
                            <td className="p-2 text-center">
                              {alert.situacao === 'Localizada'
                                ? <button onClick={() => handleConfirmFound(alert.id)} disabled={isLoading} className="px-2 py-1 bg-green-600 text-white text-[10px] font-bold rounded hover:bg-green-700 disabled:bg-gray-400">{isLoading ? '...' : 'Confirmar'}</button>
                                : <span className="text-[10px] text-gray-400 italic">Pendente</span>}
                            </td>
                          </tr>
                        )) : (
                          <tr><td colSpan={5} className="p-4 text-center text-gray-400 text-xs italic">{isAlertsLoading ? 'Buscando...' : 'Nenhuma bike em alerta.'}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Quadrante 3: Vandalizadas */}
                <div className="w-full flex-shrink-0 p-3">
                  <h2 className="text-base font-bold text-gray-700 flex items-center gap-2 mb-4"><AlertTriangleIcon className="w-4 h-4 text-orange-600"/>Bikes Vandalizadas</h2>
                  <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[500px]">
                      <thead><tr className="bg-gray-100 border-b">
                        {['Patrimônio','Data','Defeito','Local','Ação'].map(h => (
                          <th key={h} className="p-2 text-[10px] font-black text-gray-600 uppercase">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {vandalizedBikes.length > 0 ? vandalizedBikes.map((v, i) => (
                          <tr key={`vand-${v.id}-${i}`} className="border-b hover:bg-gray-50">
                            <td className="p-2 font-mono text-xs font-bold text-gray-700">{v.patrimonio}</td>
                            <td className="p-2 text-[10px] text-gray-600">{new Date(v.data).toLocaleDateString()}</td>
                            <td className="p-2 text-[10px] text-gray-600">{v.defeito}</td>
                            <td className="p-2 text-[10px] text-gray-600">{v.local}</td>
                            <td className="p-2 text-center">
                              <button onClick={() => handleConfirmVandalizedFound(v.id)} disabled={isLoading} className="px-2 py-1 bg-orange-600 text-white text-[10px] font-bold rounded hover:bg-orange-700 disabled:bg-gray-400">{isLoading ? '...' : 'Encontrada'}</button>
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
                        {pendingActions.length}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {isPendingActionsLoading ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                      </div>
                    ) : pendingActions.length > 0 ? (
                      pendingActions.map((action) => (
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
                              <p className="text-sm font-black text-gray-800">
                                {action.type === 'alterar_status_lote'
                                  ? `${action.bikes?.length || 0} bike(s) — ${action.mechanicName}`
                                  : action.type === 'status_change'
                                  ? `Bike ${action.bikeNumber}`
                                  : `Carretinha: ${action.trailerName}`}
                              </p>
                              <p className="text-[10px] text-gray-500 font-bold uppercase">
                                Solicitado por: <span className="text-blue-600">{action.mechanicName}</span>
                              </p>
                            </div>
                            {action.status === 'assigned' ? (
                              <div className="flex items-center gap-2">
                                <span className="px-2 py-1 bg-orange-100 text-orange-700 text-[10px] font-black uppercase rounded border border-orange-200 animate-pulse">
                                  Aguardando Aceite: {action.assignedTo}
                                </span>
                                <button
                                  onClick={() => handleRejectAction(action.id)}
                                  disabled={isLoading}
                                  className="p-2 bg-red-50 text-red-600 rounded-lg border border-red-100 hover:bg-red-100 transition-colors"
                                  title="Cancelar Envio"
                                >
                                  <XIcon className="w-5 h-5" />
                                </button>
                              </div>
                            ) : action.type !== 'alterar_status_lote' && (
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
                                    <CarIcon className="w-5 h-5" />
                                  </button>
                                )}
                                <button
                                  onClick={() => handleApproveAction(action)}
                                  disabled={isLoading}
                                  className="p-2 bg-green-50 text-green-600 rounded-lg border border-green-100 hover:bg-green-100 transition-colors"
                                  title="Aprovar"
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
                    ) : (
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
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { l: 'Alterar status', v: mechanicsList.filter(b => b.status === 'Alterar Status' || b.status === 'Não encontrada').length, c: 'purple' },
                        { l: 'Aguardando', v: mechanicsList.filter(b => b.status === 'Aguardando Confirmação').length, c: 'blue' },
                        { l: 'Manutenção', v: mechanicsList.filter(b => b.status === 'Em Manutenção').length, c: 'orange' },
                        { l: 'Reserva', v: mechanicsList.filter(b => b.status === 'Reserva').length, c: 'green' },
                      ].map(item => (
                        <div key={item.l} className={`bg-${item.c}-50 p-1.5 rounded border border-${item.c}-100 text-center`}>
                          <p className={`text-[8px] text-${item.c}-600 font-black uppercase leading-tight`}>{item.l}</p>
                          <p className={`text-sm font-black text-${item.c}-800`}>{item.v}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Card por mecânico */}
                  {(() => {
                    const byMechanic: Record<string, {manutencao: number, reserva: number, bikes: string[]}> = {};
                    mechanicsList.filter(b => b.status === 'Em Manutenção' || b.status === 'Reserva').forEach(b => {
                      const m = b.mecanico || '—';
                      if (!byMechanic[m]) byMechanic[m] = { manutencao: 0, reserva: 0, bikes: [] };
                      if (b.status === 'Em Manutenção') byMechanic[m].manutencao++;
                      else byMechanic[m].reserva++;
                      byMechanic[m].bikes.push(b.patrimonio);
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
                                {mechanicsList.filter(b => (b.status === 'Em Manutenção' || b.status === 'Reserva') && b.mecanico === name).map((b: any) => (
                                  <span key={b.patrimonio} className={`px-2 py-0.5 rounded text-[10px] font-black font-mono ${
                                    b.status === 'Em Manutenção'
                                      ? 'bg-orange-500 text-white'
                                      : 'bg-green-600 text-white'
                                  }`}>{b.patrimonio}</span>
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
                        onClick={handleBikeMovementSearch}
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
                        const isMecanicaRecord = record.origem === 'mecanica';
                        const isRecolhida   = statusLow === 'recolhida' || statusLow === 'filial';
                        const isEstacao     = statusLow === 'estação' || statusLow === 'estacao';
                        const isVandalizada = statusLow === 'vandalizada';
                        const isNaoEnc      = statusLow.includes('não encontrada') || statusLow.includes('nao encontrada');
                        const isMec         = statusLow.includes('manutenção') || statusLow.includes('manutencao') || statusLow === 'em manutenção';
                        const isReserva     = statusLow === 'reserva' || statusLow.includes('reparo finalizado');
                        const isRemanejada  = statusLow === 'remanejada';

                        const badgeClass = isRecolhida ? 'bg-green-700 text-white' :
                          isEstacao ? 'bg-indigo-500 text-white' :
                          isVandalizada || isNaoEnc ? 'bg-red-500 text-white' :
                          isMec ? 'bg-orange-500 text-white' :
                          isReserva ? 'bg-green-500 text-white' :
                          isRemanejada ? 'bg-teal-500 text-white' :
                          'bg-gray-400 text-white';

                        return (
                          <div key={i} className={`bg-white border rounded-lg p-2.5 shadow-sm ${isMecanicaRecord ? 'border-l-4 border-l-orange-400' : 'border-l-4 border-l-blue-300'}`}>
                            <div className="flex items-start justify-between gap-2 mb-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className={`px-2 py-0.5 text-[9px] font-black uppercase rounded ${badgeClass}`}>
                                  {record.status}
                                </span>
                                {isMecanicaRecord && (
                                  <span className="px-1.5 py-0.5 text-[8px] font-bold bg-orange-50 text-orange-500 border border-orange-200 rounded">🔧 Mecânica</span>
                                )}
                              </div>
                              <span className="text-[9px] text-gray-800 font-mono font-bold whitespace-nowrap">{record.timestamp}</span>
                            </div>
                            {record.motorista && (
                              <p className="text-[10px] font-semibold text-gray-700">
                                {isMecanicaRecord ? '🔧' : '👤'} {record.motorista}
                              </p>
                            )}
                            {record.observacao && (
                              <p className="text-[10px] text-gray-500 mt-0.5">📝 {record.observacao}</p>
                            )}
                            {record.bateria && (() => {
                              // Converte 0.3 → 30%, 0.8 → 80%, já 80% fica 80%
                              const raw = String(record.bateria).replace(',', '.');
                              const num = parseFloat(raw);
                              const pct = !isNaN(num) ? (num <= 1 && num > 0 ? Math.round(num * 100) : Math.round(num)) : null;
                              return pct !== null ? (
                                <p className="text-[10px] text-gray-500 mt-0.5">🔋 {pct}%</p>
                              ) : null;
                            })()}
                            {record.localidade && (
                              <p className="text-[10px] text-gray-400 mt-0.5">📍 {record.localidade}</p>
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
            {sortedRouteBikes.length > 0 ? (
              <ul className="space-y-2">
                {sortedRouteBikes.map(bike => {
                  const details = routeBikesDetails[bike];
                  const moved = details?.currentLat && details?.currentLng && details?.initialLat && details?.initialLng
                    ? getDistanceInMeters(details.initialLat, details.initialLng, details.currentLat, details.currentLng) : 0;
                  const dist = currentDriverLocation && details?.currentLat && details?.currentLng
                    ? calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, details.currentLat, details.currentLng) : null;
                  return (
                    <li key={bike} className="p-3 bg-white border rounded-md flex flex-col gap-3">
                      <div className="flex justify-between items-start">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <p className="font-mono text-gray-800 font-bold text-lg">{bike}</p>
                            {details?.battery !== undefined && (
                              <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 border-blue-500 text-[9px] font-bold text-blue-600 bg-white shadow-sm">{formatBattery(details.battery)}%</div>
                            )}
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
                              {routeDistances[bike] ? `${routeDistances[bike].distance} · ${routeDistances[bike].duration}` : `${dist.toFixed(2)} km`}
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
                {sortedCollectedBikes.map((bike, i) => (
                  <li key={`route-${bike}-${i}`} className="p-3 bg-white border rounded-md flex flex-col sm:flex-row justify-between items-center gap-2">
                    <div className="flex items-center gap-3">
                      <p className="font-mono text-gray-800 font-bold text-lg">{bike}</p>
                      {collectedBikesDetails[bike]?.battery !== undefined && (
                        <div className="flex items-center justify-center w-10 h-10 rounded-full border-2 border-blue-500 text-[10px] font-bold text-blue-600 bg-white shadow-sm">{formatBattery(collectedBikesDetails[bike].battery)}%</div>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 w-full max-w-[240px]">
                      <button onClick={() => handleCollectedBikeAction(bike, 'Enviada para Estação')} disabled={isLoading || processingBikes.has(bike)} className="px-2 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600 active:scale-95 text-xs disabled:bg-gray-400">Estação</button>
                      <button onClick={() => handleCollectedBikeAction(bike, 'Enviada para Filial')} disabled={isLoading || processingBikes.has(bike)} className="px-2 py-1 bg-green-500 text-white rounded-md hover:bg-green-600 active:scale-95 text-xs disabled:bg-gray-400">Filial</button>
                      <button onClick={() => handleCollectedBikeAction(bike, 'Vandalizada')} disabled={isLoading || processingBikes.has(bike)} className="px-2 py-1 bg-red-500 text-white rounded-md hover:bg-red-600 active:scale-95 text-xs disabled:bg-gray-400">Vandalizada</button>
                    </div>
                  </li>
                ))}
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
                    <Map size={12} />
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
                    { id: 'outOfStation', label: 'Fora de Estação', icon: <MapIconLucide size={14} className="text-purple-500" /> },
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
        const { driver, events, startMs, endMs } = timelineModal;
        const totalMs = endMs - startMs || 1;
        const toPos = (tsMs: number) => Math.max(0, Math.min(100, (tsMs - startMs) / totalMs * 100));
        const fmtTime = (ms: number) => {
          const d = new Date(ms);
          return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        const dotConfig: Record<string, {bg: string, label: string}> = {
          em_posse:       { bg: 'bg-green-500',  label: 'Em Posse' },
          recolhida:      { bg: 'bg-green-700',  label: 'Recolhida (Filial)' },
          estacao:        { bg: 'bg-indigo-500', label: 'Estação' },
          filial:         { bg: 'bg-blue-500',   label: 'Filial' },
          nao_atendida:   { bg: 'bg-yellow-500', label: 'Não atend.' },
          nao_encontrada: { bg: 'bg-red-500',    label: 'Não enc.' },
          carretinha:     { bg: 'bg-purple-600', label: 'Carretinha' },
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
              <div className="relative mb-6" style={{height: '60px'}}>
                {/* Marcas de hora */}
                {hourMarks.map((m, i) => (
                  <div key={i} className="absolute flex flex-col items-center" style={{left: `${toPos(m.ms)}%`}}>
                    <div className="w-px h-3 bg-gray-200"/>
                    <span className="text-[8px] text-gray-300 mt-0.5 -translate-x-1/2">{m.label}</span>
                  </div>
                ))}
                {/* Linha base */}
                <div className="absolute top-3 left-0 right-0 h-0.5 bg-gray-900 rounded"/>
                {/* Horários extremos */}
                <span className="absolute top-6 left-0 text-[9px] text-gray-600 font-mono font-bold">{fmtTime(startMs)}</span>
                <span className="absolute top-6 right-0 text-[9px] text-gray-600 font-mono font-bold">{fmtTime(endMs)}</span>
                {/* Eventos agrupados */}
                {events.map((cl: any, ci: number) => {
                  const pos = toPos(cl.tsMs);
                  const cfg = dotConfig[cl.type] || { bg: 'bg-gray-400', label: cl.type };
                  const isMulti = cl.count > 1;
                  return (
                    <div key={ci} className="absolute -translate-x-1/2 flex flex-col items-center" style={{left: `${pos}%`, top: 0}}>
                      <div className={`rounded-full border-2 border-white shadow flex items-center justify-center ${isMulti ? 'w-6 h-6' : 'w-4 h-4'} ${cfg.bg}`}>
                        {isMulti && <span className="text-[9px] font-black text-white">{cl.count}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Lista detalhada de eventos */}
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {events.map((cl: any, ci: number) => {
                  const cfg = dotConfig[cl.type] || { bg: 'bg-gray-400', label: cl.type };
                  return (
                    <div key={ci} className="flex items-start gap-3 p-2.5 bg-gray-50 rounded-lg border">
                      <div className={`w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0 ${cfg.bg}`}/>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black text-gray-700">
                            {cl.type === 'carretinha' && cl.observacoes?.[0] ? cl.observacoes[0] : cfg.label}
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
                                cl.type === 'filial' ? 'bg-blue-50 border-blue-200 text-blue-700' :
                                'bg-gray-100 border-gray-200 text-gray-600'
                              }`}>{b}</span>
                            ))}
                          </div>
                        )}
                        {cl.observacoes && cl.observacoes.filter(Boolean).length > 0 && cl.type !== 'em_posse' && (
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
              </div>
            </div>
          </div>
        );
      })()}

      <RequestModal isOpen={isRequestModalOpen} onClose={() => setRequestModalOpen(false)} onSubmit={handleCreateRequest} isLoading={isLoading} motoristas={motoristas} driverLocations={driverLocations} error={error} clearError={() => setError(null)}/>
      <EditDriverModal isOpen={isEditDriverModalOpen} onClose={() => setIsEditDriverModalOpen(false)} driver={editingDriver} onSave={handleUpdateDriverState} isLoading={isLoading}/>
      <RouteModal isOpen={isRouteModalOpen} onClose={() => setRouteModalOpen(false)} onSubmit={handleCreateRoute} isLoading={isLoading} pendingBikeNumbers={allActiveBikes} motoristas={motoristas} error={error} clearError={() => setError(null)} type="route"/>
      <ReportModal isOpen={isReportModalOpen} onClose={() => setReportModalOpen(false)} driverName={driverName} plate={plate} kmInicial={kmInicial}/>
      <DestinationModal isOpen={destinationModal.isOpen} onClose={() => setDestinationModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={obs => executeCollectedBikeAction(destinationModal.bikeNumber, destinationModal.type === 'Estação' ? 'Enviada para Estação' : destinationModal.type === 'Filial' ? 'Enviada para Filial' : 'Vandalizada', obs)}
        type={destinationModal.type} bikeNumber={destinationModal.bikeNumber} stationName={destinationModal.stationName} isLoading={isLoading} onRecalculate={recalculateStation}/>
      <HistoryModal isOpen={isHistoryModalOpen} onClose={() => setIsHistoryModalOpen(false)} history={requestsHistory} isLoading={isHistoryLoading} driverName={driverName}/>
      
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
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-scale-in">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                <AlertTriangleIcon size={32} className="text-red-600" />
              </div>
              <h2 className="text-xl font-black text-gray-800 uppercase mb-2">Bike Vandalizada?</h2>
              <p className="text-sm text-gray-500 mb-6">
                Marcar a bicicleta <span className="font-bold text-gray-800">{isVandalizedConfirmOpen.bikePat}</span> como <span className="font-bold text-red-600 uppercase">Vandalizada sem recuperação</span>?
              </p>
              <div className="grid grid-cols-2 gap-3 w-full">
                <button
                  onClick={() => setIsVandalizedConfirmOpen(null)}
                  disabled={isLoading}
                  className="py-3 bg-gray-100 text-gray-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => handleMarkAsVandalizedNoRecovery(isVandalizedConfirmOpen.bikePat)}
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

      <ScheduleModal isOpen={isScheduleModalOpen} onClose={() => setIsScheduleModalOpen(false)} schedule={userSchedule} driverName={driverName} isLoading={isScheduleLoading}/>
      <VehicleSwitchModal isOpen={isVehicleModalOpen} onClose={() => setIsVehicleModalOpen(false)} onSwitch={(p, km) => onUpdateUser({ plate: p, kmInicial: km })} driverName={driverName} currentPlate={plate}/>
      <AdminAlerts isOpen={isAdminAlertsOpen} onClose={() => setIsAdminAlertsOpen(false)} adminName={driverName}/>
      <ReporModal isOpen={isReporModalOpen} onClose={() => setIsReporModalOpen(false)} data={reporData} isLoading={isReporLoading}/>
      <MechanicRepairModal isOpen={isMechanicRepairModalOpen} onClose={() => setIsMechanicRepairModalOpen(false)} onConfirm={handleFinalizeMechanicsRepair} isLoading={isLoading} bikeNumber={selectedMechanicBike?.patrimonio || ''}/>
      <MechanicSelectionModal isOpen={isMechanicSelectionModalOpen} onClose={() => setIsMechanicSelectionModalOpen(false)} onConfirm={handleMechanicSelectionConfirm} isLoading={isLoading} bikeNumber={selectedMechanicBike?.patrimonio || ''}/>

      <DriverSelectionModal 
        isOpen={isDriverSelectionModalOpen} 
        onClose={() => { setIsDriverSelectionModalOpen(false); setSelectedActionForAssignment(null); }}
        onConfirm={handleAssignTrailerToDriver}
        isLoading={isLoading}
        drivers={driversSummary}
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
    </div>
  );
};

export default MainScreen;