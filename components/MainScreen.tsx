import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { BicycleData, PickupRequest, DriverLocation } from '../types';
import {
  LogoutIcon, PlusIcon, PlusPlusIcon, MapIcon, SheetIcon, SearchIcon,
  AlertIcon, CalendarIcon, CarIcon, XIcon, BicycleIcon, MovingIcon,
  UserIcon, AlertTriangleIcon, QrCodeIcon, TrailerIcon, SwitchIcon,
  RefreshIcon, DatabaseIcon, CheckCircleIcon
} from './icons';
import { 
  Settings, Battery, Lock, Map as MapIconLucide, 
  WifiOff, AlertCircle, RefreshCw, ChevronUp, ChevronDown, ChevronLeft, 
  ChevronRight, Circle, Play, Locate, Map
} from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { auth, db } from '../firebase';
import { signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import {
  collection, onSnapshot, doc, updateDoc, addDoc,
  serverTimestamp, setDoc
} from 'firebase/firestore';
import ScheduleModal from './ScheduleModal';
import ReporModal from './ReporModal';
import MechanicRepairModal from './MechanicRepairModal';
import MechanicSelectionModal from './MechanicSelectionModal';
import TrailerSelectionModal from './TrailerSelectionModal';
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
const DRIVER_ACTION_GRACE_MS = 8000; // 8 segundos — cobre latência do Apps Script

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
  const [isTrailerModalOpen, setTrailerModalOpen] = useState(false);
  const [isReportModalOpen, setReportModalOpen] = useState(false);
  const [isVehicleModalOpen, setIsVehicleModalOpen] = useState(false);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
  const [isAdminAlertsOpen, setIsAdminAlertsOpen] = useState(false);
  const [adminNotification, setAdminNotification] = useState<any>(null);
  const [isForceReloading, setIsForceReloading] = useState(false);
  const [isReporModalOpen, setIsReporModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isEditDriverModalOpen, setIsEditDriverModalOpen] = useState(false);
  const [isNotFoundConfirmOpen, setIsNotFoundConfirmOpen] = useState(false);
  const [isMechanicRepairModalOpen, setIsMechanicRepairModalOpen] = useState(false);
  const [isMechanicSelectionModalOpen, setIsMechanicSelectionModalOpen] = useState(false);
  const [isTrailerSelectionModalOpen, setIsTrailerSelectionModalOpen] = useState(false);
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
  const [activeQuadrant, setActiveQuadrant] = useState<'summary' | 'alerts' | 'vandalized' | 'status' | 'mechanics' | 'bike_search'>('summary');
  const [bikeSearchTerm, setBikeSearchTerm] = useState('');
  const [bikeSearchLimit, setBikeSearchLimit] = useState<5|10|15>(5);
  const [bikeSearchResult, setBikeSearchResult] = useState<any[]>([]);
  const [isBikeSearchLoading, setIsBikeSearchLoading] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [isAlertsLoading, setIsAlertsLoading] = useState(false);
  const [vandalizedBikes, setVandalizedBikes] = useState<any[]>([]);
  const [isVandalizedLoading, setIsVandalizedLoading] = useState(false);
  const [changeStatusData, setChangeStatusData] = useState<{ vandalizadas: any[], filial: any[] }>({ vandalizadas: [], filial: [] });
  const [statusTimeRange, setStatusTimeRange] = useState<'24h' | '48h' | '72h' | 'week'>('24h');
  const [alertCount, setAlertCount] = useState(0);
  const [hasNewAlerts, setHasNewAlerts] = useState(false);

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
  const [activeMechanicCategory, setActiveMechanicCategory] = useState<string | null>(null);
  const [mechanicSummaryPeriod, setMechanicSummaryPeriod] = useState<'diario'|'semanal'|'mensal'>('diario');
  const [clickedBikesForStatus, setClickedBikesForStatus] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`status_clicked_${driverName}`);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [formattedBikesForCopy, setFormattedBikesForCopy] = useState<string>(() => {
    try {
      return localStorage.getItem(`status_copy_${driverName}`) || '';
    } catch { return ''; }
  });

  // --- Refs ---
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const searchCacheRef = useRef<Record<string, BicycleData>>({});
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

  // =================================================================
  // HELPERS DE ESTADO
  // =================================================================

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
    if (!driverName) return;

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
    }, err => console.error('Listener requests:', err));

    // Estado do motorista
    const unsubUser = onSnapshot(doc(db, 'users', normalizeName(driverName)), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.sheetsSync === true) return;
      if (isUpdatingStateRef.current) return;
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
    let unsubNotifications = () => {};
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

      // Listener de notificações de carretinha — sem where() para evitar índice composto
      unsubNotifications = onSnapshot(collection(db, 'notifications'), snapshot => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            const data = change.doc.data();
            // Filtra no cliente
            if (data.type !== 'trailer_finalizado' || data.recipient !== 'ADM') return;
            const msg = data.message || `Carretinha finalizada. Bikes: ${(data.bikes || []).join(', ')}`;
            setAdminNotification({ id: change.doc.id, message: msg, bikes: data.bikes || [], trailerName: data.trailerName });
          }
        });
      }, err => console.error('Listener notificações:', err));
    }

    // Listener de timeline_events (para ADM — enriquece a timeline dos motoristas)
    let unsubTimeline = () => {};
    if (isAdm) {
      setFirebaseTimelineEvents({}); // limpa ao trocar de data
      // Sem where() para evitar necessidade de índice — filtra no cliente
      unsubTimeline = onSnapshot(collection(db, 'timeline_events'), snapshot => {
        const byDriver: Record<string, Array<{tsMs: number, type: string, bikeNumber?: string}>> = {};
        snapshot.forEach(d => {
          const data = d.data();
          const driver = data.driverName;
          if (!driver) return;
          // Filtra pela data selecionada no cliente
          if (data.date && data.date !== timelineDate) return;
          // serverTimestamp() pode ser null na primeira escrita (pendingWrite)
          // Nesse caso usa o timestamp local do documento como fallback
          const ts = data.timestamp?.toDate?.()
            || (d.metadata.hasPendingWrites ? new Date() : null);
          if (!ts) return;
          if (!byDriver[driver]) byDriver[driver] = [];
          byDriver[driver].push({
            tsMs: ts.getTime(),
            type: data.type || 'em_posse',
            bikeNumber: data.bikeNumber || ''
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

    return () => { unsubRequests(); unsubAlerts(); unsubUser(); unsubNotifications(); unsubTimeline(); unsubReload(); unsubLocations(); };
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
    // Se já temos distâncias calculadas por carro para TODAS as bikes, a ordem de routeBikes 
    // já está otimizada pelo buildOptimizedRoute (Nearest Neighbor).
    // Caso contrário, ordena por Haversine para garantir que a mais próxima esteja no topo.
    if (!currentDriverLocation || !routeBikes.length) return routeBikes;
    
    const isOptimized = routeBikes.length > 0 && routeBikes.every(id => routeDistances[id]?.isRoad);
    if (isOptimized) return routeBikes;

    // Fallback dinâmico: Haversine enquanto roteamento por estrada não carregou ou se bikes se moveram
    return [...routeBikes].sort((a, b) => {
      const dA = routeBikesDetails[a], dB = routeBikesDetails[b];
      if (!dA || !dB) return 0;
      if (!dA.currentLat || !dA.currentLng) return 1;
      if (!dB.currentLat || !dB.currentLng) return -1;
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
      // Busca estado do Sheets — sem depender do Firebase
      const stateResult = await apiCall({ action: 'getDriverState', driverName }, 1, true);
      let newRoute: string[] = stateResult.success ? (stateResult.data?.routeBikes || []) : routeBikes;
      let newCollected: string[] = stateResult.success ? (stateResult.data?.collectedBikes || []) : collectedBikes;

      if (status === 'Recolhida') {
        if (collectedBikes.includes(bikeNumber)) {
          alert(`Você já está em posse da bicicleta ${bikeNumber}.`);
          return;
        }
        newCollected = [...new Set([...newCollected, bikeNumber])];
        newRoute = newRoute.filter(b => String(b) !== bikeNumber);

        // Atualiza estado local imediatamente
        setCollectedBikes(newCollected);
        setRouteBikes(newRoute);

        // Firebase + Sheets
        await persistDriverState(newRoute, newCollected);

        // Status da bike e evento de timeline — não bloqueantes (permissão pode variar)
        setDoc(doc(db, 'bikes', bikeNumber), {
          status: 'Recolhida', responsavel: driverName, ultimaAtualizacao: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('[Firebase] bikes write:', err.code));

        addDoc(collection(db, 'timeline_events'), {
          driverName, bikeNumber, type: 'em_posse',
          timestamp: serverTimestamp(),
          date: localDateStr()
        }).then(() => {
          console.log('[Timeline] Evento em_posse gravado:', bikeNumber);
        }).catch(err => {
          console.error('[Timeline] Erro:', err.code, err.message);
        });

        setSuccessMessage(`Bicicleta ${bikeNumber} recolhida!`);
        setSearchedBike(null);
        setSearchTerm('');

      } else if (status === 'Não encontrada') {
        newRoute = newRoute.filter(b => String(b) !== bikeNumber);

        setRouteBikes(newRoute);
        await persistDriverState(newRoute, newCollected);

        setDoc(doc(db, 'bikes', bikeNumber), {
          status: 'Não encontrada', responsavel: null, ultimaAtualizacao: serverTimestamp()
        }, { merge: true }).catch(err => console.warn('[Firebase] bikes write:', err.code));

        addDoc(collection(db, 'reports'), {
          driverName, bikeNumber, status: 'Não encontrada', timestamp: serverTimestamp(), observation: ''
        }).catch(err => console.warn('[Firebase] reports write:', err.code));

        await apiCall({
          action: 'finalizeRouteBike', driverName, bikeNumber,
          finalStatus: 'Não encontrada', finalObservation: ''
        }, 1, true).catch(e => console.warn('[Sheets] finalizeRouteBike:', e));

        setSuccessMessage(`Bicicleta ${bikeNumber} marcada como não encontrada.`);
        setSearchedBike(null);
        setSearchTerm('');
      }

      markDriverAction();
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
      const stateResult = await apiCall({ action: 'getDriverState', driverName }, 1, true);
      const newRoute = (stateResult.success ? (stateResult.data?.routeBikes || []) : routeBikes)
        .filter((b: string) => String(b) !== bikeNumber);
      const newCollected = stateResult.success ? (stateResult.data?.collectedBikes || []) : collectedBikes;

      setRouteBikes(newRoute);
      await persistDriverState(newRoute, newCollected);

      setDoc(doc(db, 'bikes', bikeNumber), {
        status: 'Pendente', responsavel: null, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));

      addDoc(collection(db, 'reports'), {
        driverName, bikeNumber, status: 'Não atendida', timestamp: serverTimestamp(), observation: ''
      }).catch(e => console.warn('[Firebase] reports write:', e.code));

      await apiCall({
        action: 'finalizeRouteBike', driverName, bikeNumber,
        finalStatus: 'Não atendida', finalObservation: ''
      }, 1, true).catch(e => console.warn('[Sheets] finalizeRouteBike:', e));

      markDriverAction();
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

    // Atualização otimista imediata
    setCollectedBikes(prev => prev.filter(b => String(b) !== bikeNumber));

    try {
      // Busca estado atual do Sheets (fonte de verdade) — sem depender do Firebase
      const stateResult = await apiCall({ action: 'getDriverState', driverName }, 1, true);
      const newCollected = (stateResult.success ? (stateResult.data?.collectedBikes || []) : collectedBikes)
        .filter((b: string) => String(b) !== bikeNumber);
      const newRoute = stateResult.success ? (stateResult.data?.routeBikes || []) : routeBikes;

      await persistDriverState(newRoute, newCollected);

      const finalStatus = status === 'Enviada para Estação' ? 'Estação'
        : status === 'Enviada para Filial' ? 'Filial'
        : status;

      // Firebase não-bloqueante
      setDoc(doc(db, 'bikes', bikeNumber), {
        status: finalStatus, responsavel: null,
        observacao: observation, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));

      addDoc(collection(db, 'reports'), {
        driverName, bikeNumber, status: finalStatus,
        observation, timestamp: serverTimestamp()
      }).catch(e => console.warn('[Firebase] reports write:', e.code));

      await apiCall({
        action: 'finalizeCollectedBike', driverName, bikeNumber,
        finalStatus, finalObservation: observation
      }, 1, true).catch(e => console.warn('[Sheets] finalizeCollectedBike:', e));

      markDriverAction();
      setSuccessMessage(`Bicicleta ${bikeNumber} finalizada!`);
    } catch (err: any) {
      console.error(`Erro bike ${bikeNumber}:`, err);
      setError(`Erro ao processar bike ${bikeNumber}: ${err.message}`);
      // Reverte atualização otimista em caso de erro
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
  const handleAcceptRequest = async (requestId: string, bikeNumbers: string, reason: string = '') => {
    if (isLoading) return;
    const bikesToAdd = String(bikeNumbers || '').split(',').map(s => s.trim()).filter(Boolean);
    const alreadyInPosse = bikesToAdd.filter(b => collectedBikes.includes(b));
    if (alreadyInPosse.length > 0) { alert(`Bikes já em sua posse: ${alreadyInPosse.join(', ')}`); return; }

    const isTrailer = (reason || '').toUpperCase().includes('CARRETINHA');
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
            status: 'Recolhida', responsavel: driverName, ultimaAtualizacao: serverTimestamp()
          }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));
        });
        // Registra no Relatório e timeline
        bikesToAdd.forEach(id => {
          apiCall({ action: 'logReport', rowData: [
            new Date().toISOString(), id, 'Recolhida', 'Recebida via carretinha', driverName, '', '', '', ''
          ]}, 1, true).catch(() => {});
          addDoc(collection(db, 'timeline_events'), {
            driverName, bikeNumber: id, type: 'recolhida',
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

  const handleCreateTrailer = async (details: { routeName: string; bikeNumbers: string[]; recipient: string }) => {
    if (!details.bikeNumbers?.length) { alert('Insira ao menos uma bicicleta.'); return; }
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

  // =================================================================
  // BUSCA
  // =================================================================
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

    const cached = searchCacheRef.current[term];
    if (cached) {
      setSearchedBike(cached);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      apiCall({ action: 'search', bikeNumber: term }, 1, true).then(r => {
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
      const result = await apiCall({ action: 'search', bikeNumber: term });
      if (result.success && result.data) {
        const s = { ...result.data, 'Patrimônio': String(result.data['Patrimônio']) };
        setSearchedBike(s);
        searchCacheRef.current[term] = s;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setSearchedBike(null);
        setError(result.error || 'Bike não encontrada.');
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

  const handleAlterarStatus = (bikeId: string) => {
    setClickedBikesForStatus(prev => {
      const next = new Set(prev);
      next.add(bikeId);
      try { localStorage.setItem(`status_clicked_${driverName}`, JSON.stringify([...next])); } catch {}
      return next;
    });
    setFormattedBikesForCopy(prev => {
      const bikes = prev ? prev.split(',').map(b => b.trim()).filter(Boolean) : [];
      if (!bikes.includes(bikeId)) bikes.push(bikeId);
      const next = bikes.join(',');
      try { localStorage.setItem(`status_copy_${driverName}`, next); } catch {}
      return next;
    });
  };

  const handleNotFoundMechanic = async (bikeId: string) => {
    if (!window.confirm(`Confirmar que a bicicleta ${bikeId} não foi encontrada?`)) return;
    setIsLoading(true);
    try {
      await apiCall({ action: 'declineMechanicsReceipt', bikeNumber: bikeId, mechanicName: driverName }, 1, true);
      alert('Bicicleta marcada como não encontrada.');
      refreshAll(true);
    } catch (err: any) {
      alert('Erro ao processar: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMechanicSelectionConfirm = async (mechanicName: string) => {
    setIsLoading(true);
    const bikeNumber = selectedMechanicBike.patrimonio;
    // Atualização otimista — remove da lista imediatamente
    setMechanicsList(prev => prev.map(b =>
      b.patrimonio === bikeNumber ? { ...b, status: 'Em Manutenção', mecanico: mechanicName } : b
    ));
    setIsMechanicSelectionModalOpen(false);
    try {
      updateDoc(doc(db, 'bikes', bikeNumber), { status: 'Mecânica', responsavel: mechanicName, ultimaAtualizacao: serverTimestamp() }).catch(e => console.warn('[Firebase] bikes write:', e.code));
      addDoc(collection(db, 'reports'), { bikeNumber, status: 'Mecânica', driverName, mechanicName, timestamp: serverTimestamp(), type: 'Mecânica' }).catch(e => console.warn('[Firebase] reports write:', e.code));
      apiCall({ action: 'confirmMechanicsReceipt', bikeNumber, mechanicName }, 1, true).catch(() => {});
    } catch (err: any) {
      alert('Erro: ' + err.message);
      refreshAll(true);
    } finally { setIsLoading(false); }
  };

  const handleFinalizeMechanicsRepair = async (treatment: string) => {
    if (!treatment) { alert('Descreva a tratativa.'); return; }
    setIsLoading(true);
    const bikeNumber = selectedMechanicBike.patrimonio;
    // Atualização otimista
    setMechanicsList(prev => prev.map(b =>
      b.patrimonio === bikeNumber ? { ...b, status: 'Reserva', tratativa: treatment } : b
    ));
    setIsMechanicRepairModalOpen(false);
    try {
      updateDoc(doc(db, 'bikes', bikeNumber), { status: 'Em Estação', responsavel: null, observacao: treatment, ultimaAtualizacao: serverTimestamp() }).catch(e => console.warn('[Firebase] bikes write:', e.code));
      addDoc(collection(db, 'reports'), { bikeNumber, status: 'Em Estação', driverName, treatment, timestamp: serverTimestamp(), type: 'Reparo' }).catch(e => console.warn('[Firebase] reports write:', e.code));
      apiCall({ action: 'finalizeMechanicsRepair', bikeNumber, mechanicName: driverName, treatment }, 1, true).catch(() => {});
    } catch (err: any) {
      alert('Erro: ' + err.message);
      refreshAll(true);
    } finally { setIsLoading(false); }
  };

  const handleOrganizeTrailer = async (bikeNumbers: string[], trailerName: string) => {
    if (!trailerName) { alert('Informe o nome da carretinha.'); return; }
    setIsLoading(true);
    // Atualização otimista
    setMechanicsList(prev => prev.map(b =>
      bikeNumbers.includes(b.patrimonio) ? { ...b, carretinha: trailerName } : b
    ));
    setIsTrailerSelectionModalOpen(false);
    try {
      await Promise.all(bikeNumbers.map(id => updateDoc(doc(db, 'bikes', id), { carretinha: trailerName, ultimaAtualizacao: serverTimestamp() })));
      apiCall({ action: 'organizeTrailer', bikeNumbers, trailerName }, 1, true).catch(() => {});
    } catch (err: any) {
      alert('Erro: ' + err.message);
      refreshAll(true);
    } finally { setIsLoading(false); }
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

  const handleFinalizeTrailer = async (trailerName: string) => {
    if (!window.confirm(`Finalizar a carretinha "${trailerName}"? Os ADMs serão notificados para alterar o status das bikes.`)) return;
    setIsLoading(true);
    // Atualização otimista — remove bikes da reserva
    setMechanicsList(prev => prev.map(b =>
      b.carretinha === trailerName ? { ...b, status: 'Remanejada' } : b
    ));
    try {
      const bikes = mechanicsList.filter(b => b.carretinha === trailerName && b.status === 'Reserva').map(b => b.patrimonio);
      await Promise.all(bikes.map(id => setDoc(doc(db, 'bikes', id), { carretinha: null, ultimaAtualizacao: serverTimestamp() }, { merge: true })));
      apiCall({ action: 'finalizeTrailer', trailerName }, 1, true).catch(() => {});
      // Envia notificação para todos os ADMs
      await addDoc(collection(db, 'notifications'), {
        type: 'trailer_finalizado',
        message: `🚌 Carretinha "${trailerName}" finalizada por ${driverName}. ${bikes.length} bike(s) prontas para alterar status: ${bikes.join(', ')}`,
        bikes,
        trailerName,
        mechanic: driverName,
        timestamp: serverTimestamp(),
        recipient: 'ADM'
      });
      apiCall({
        action: 'notifyAdmins',
        message: `Carretinha "${trailerName}" finalizada por ${driverName}. Bikes para alterar status: ${bikes.join(', ')}`,
        bikes,
        trailerName
      }, 1, true).catch(() => {});
    } catch (err: any) {
      alert('Erro: ' + err.message);
      refreshAll(true);
    } finally { setIsLoading(false); }
  };

  const handleInsertBike = async (bikeNumber: string, targetStatus: string) => {
    if (processingBikesRef.current.has(bikeNumber)) return;
    processingBikesRef.current.add(bikeNumber);
    setProcessingBikes(new Set(processingBikesRef.current));
    setIsLoading(true);

    try {
      // Firebase não-bloqueante
      setDoc(doc(db, 'bikes', bikeNumber), {
        status: targetStatus, responsavel: driverName, ultimaAtualizacao: serverTimestamp()
      }, { merge: true }).catch(e => console.warn('[Firebase] bikes write:', e.code));

      addDoc(collection(db, 'reports'), {
        driverName, bikeNumber, status: targetStatus,
        timestamp: serverTimestamp(),
        observation: `Inserida em ${targetStatus} via consulta`
      }).catch(e => console.warn('[Firebase] reports write:', e.code));

      // Sheets — fonte de verdade
      await apiCall({ action: 'insertBikeMechanics', driverName, bikeNumber, targetStatus }, 1, true);

      setSuccessMessage(`Bicicleta ${bikeNumber} inserida em ${targetStatus}!`);
      setSearchedBike(null);
      setSearchTerm('');
      refreshAll(true);
    } catch (err: any) {
      console.error('Erro ao inserir bike:', err);
      setError('Erro ao inserir bike: ' + err.message);
    } finally {
      setIsLoading(false);
      processingBikesRef.current.delete(bikeNumber);
      setProcessingBikes(new Set(processingBikesRef.current));
    }
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
    setIsScannerOpen(true);
    setTimeout(async () => {
      try {
        const qr = new Html5Qrcode('qr-reader');
        scannerRef.current = qr;
        await qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 250, height: 250 } },
          (text) => {
            const match = text.match(/\/download\/(\d+)/);
            const id = match ? match[1] : /^\d+$/.test(text) ? text : null;
            if (id) { setSearchTerm(id); stopScanner(); handleSearch(id); }
          }, () => {}
        );
      } catch { setError('Não foi possível acessar a câmera.'); setIsScannerOpen(false); }
    }, 100);
  };

  const stopScanner = async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); await scannerRef.current.clear(); } catch {}
      scannerRef.current = null;
    }
    setIsScannerOpen(false);
  };

  useEffect(() => { return () => { if (scannerRef.current) scannerRef.current.stop().catch(() => {}); }; }, []);

  // =================================================================
  // MIGRAÇÃO
  // =================================================================
  const handleMigrate = async () => {
    setMigrationMessage({ text: 'Autenticando...', type: 'info' });
    setIsMigrating(true);
    try {
      if (!auth.currentUser) await signInWithPopup(auth, new GoogleAuthProvider());
      setMigrationMessage({ text: 'Migrando dados...', type: 'info' });
      const result = await migrateDataToFirebase(category);
      setMigrationMessage(result.success
        ? { text: 'Migração concluída!', type: 'success' }
        : { text: 'Erro: ' + result.error, type: 'error' });
    } catch (err: any) {
      setMigrationMessage({ text: 'Erro: ' + err.message, type: 'error' });
    } finally {
      setIsMigrating(false);
      setTimeout(() => setMigrationMessage(null), 10000);
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
        setDriversSummary(prev => {
          // Preserva timeline e timelineWindow anteriores se o novo dado não tem eventos
          // (garante que eventos passados não somem entre syncs)
          return r.data.map((newDriver: any) => {
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
        ? ((await apiCall({ action: 'getMotoristas' })).data || [])
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

  const copyToClipboard = (list: string[]) => {
    navigator.clipboard.writeText(list.join(',')).then(() => alert('Copiado!')).catch(() => alert('Erro ao copiar.'));
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
          // Mantém requests do Firebase (id alfanumérico) que não estão no Sheets ainda
          const firebaseOnly = prev.filter(r => {
            const id = String(r.id);
            const isFirestoreId = id.length > 10 && isNaN(Number(id));
            if (!isFirestoreId) return false;
            if (processedRequestIds.current.has(id)) return false;
            // Mantém se não foi encontrado nos requests do Sheets
            return !sheetsRequests.find((sr: any) => String(sr.id) === id);
          });
          return [...firebaseOnly, ...sheetsRequests];
        });
        // Não sincroniza/deleta do Firebase durante applyData para evitar loop
      }
      if (d.driverState && !isUpdatingStateRef.current && canSheetsOverride()) {
        applyStateFromSheets(
          d.driverState.routeBikes || [],
          d.driverState.collectedBikes || []
        );
      }

      if (d.bikeStatuses) setBikeConflicts(d.bikeStatuses);
      if (d.schedule) setUserSchedule(d.schedule);
      if (d.motoristas) setMotoristas(d.motoristas);
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
      if (d.mechanicsList) setMechanicsList(d.mechanicsList);
      if (d.driversSummary) {
        setDriversSummary(prev => d.driversSummary.map((newD: any) => {
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
          // Só mostra badge se há alertas novos além do que já foi visto
          if (n > lastViewedAlertCountRef.current) {
            setHasNewAlerts(true);
          }
        }
      }
    };

    try {
      setSyncError(null);
      const result = await apiCall({ action: 'sync', driverName, category, summaryTimeRange, statusTimeRange, timelineDate }, 2, true);
      if (result.success && result.data) {
        applyData(result.data);
        localStorage.setItem('cached_main_data', JSON.stringify(result.data));
        if (result.version) setBackendVersion(result.version);
        setLastSyncTime(new Date().toLocaleTimeString());
      } else {
        setSyncError(result.error || 'Falha na sincronização.');
      }
    } catch (err: any) {
      setSyncError(err.message || 'Erro de conexão.');
      const cached = localStorage.getItem('cached_main_data');
      if (cached) { try { applyData(JSON.parse(cached)); } catch {} }
    } finally {
      setIsSyncing(false);
      if (isAdm) { setIsSummaryLoading(false); setIsAlertsLoading(false); setIsVandalizedLoading(false); }
    }
  }, [driverName, category, summaryTimeRange, statusTimeRange, applyStateFromSheets, isAdm]);

  // Cache inicial
  useEffect(() => {
    const cached = localStorage.getItem('cached_main_data');
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
      if (d.motoristas) setMotoristas(d.motoristas);
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
      if (d.mechanicsList) setMechanicsList(d.mechanicsList);
      if (d.driversSummary) {
        setDriversSummary(prev => d.driversSummary.map((newD: any) => {
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
    const fetchSt = async () => {
      try {
        const r = await apiGetCall('getStations');
        if (r.success && r.data) setStations(r.data.map((s: any) => ({ ...s, Latitude: normalizeCoord(s.Latitude), Longitude: normalizeCoord(s.Longitude) })));
      } catch {}
    };
    fetchSt();
    const interval = setInterval(() => refreshAll(), 4000);
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
      if (d?.currentLat && d?.currentLng && !routeDistances[id]) {
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

    let lastSentLat = 0, lastSentLng = 0, lastSentTime = 0;
    let wakeLock: any = null;
    let watchId: number | null = null;

    const sendLocation = (latitude: number, longitude: number, force = false) => {
      const now = Date.now();
      const movedMeters = getDistanceInMeters(latitude, longitude, lastSentLat, lastSentLng);
      const elapsed = now - lastSentTime;
      if (!force && movedMeters <= 5 && elapsed < 15000) return;

      lastSentLat = latitude;
      lastSentLng = longitude;
      lastSentTime = now;
      lastLocationRef.current = { lat: latitude, lng: longitude };

      // Firebase tempo real — inclui status LOGADO
      setDoc(doc(db, 'locations', driverName), {
        driverName, latitude, longitude,
        timestamp: serverTimestamp(), category,
        status: 'LOGADO',
      }, { merge: true }).catch(() => {});

      // Sheets — persistência
      apiGetCall('updateLocation', {
        driverName,
        latitude: latitude.toFixed(6),
        longitude: longitude.toFixed(6)
      }).catch(() => {});
    };

    const getCurrentAndSend = (force = false) => {
      navigator.geolocation.getCurrentPosition(
        ({ coords: { latitude, longitude } }) => {
          setGpsError(null);
          setCurrentDriverLocation({ lat: latitude, lng: longitude });
          sendLocation(latitude, longitude, force);
        },
        () => {},
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    };

    const startWatch = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = navigator.geolocation.watchPosition(
        ({ coords: { latitude, longitude } }) => {
          setGpsError(null);
          setCurrentDriverLocation({ lat: latitude, lng: longitude });
          sendLocation(latitude, longitude);
        },
        err => {
          if (err.code === err.PERMISSION_DENIED)
            setGpsError('Acesso ao GPS negado. O aplicativo requer localização ativa.');
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
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
        rangeKm: 3
      });

      if (response.success) {
        setSuccessMessage(response.message || 'Roteiro gerado com sucesso!');
        setIsRouteConfigOpen(false);
        if (refreshAllRef.current) refreshAllRef.current();
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

      {/* CAMPO DE CÓPIA PARA MECÂNICO */}
      {isMecanica && formattedBikesForCopy && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg shadow-sm animate-fade-in-down">
          <p className="text-[10px] font-bold text-blue-700 uppercase mb-1">Bikes para Alterar Status (Copiar):</p>
          <div className="flex gap-2">
            <input 
              readOnly 
              value={formattedBikesForCopy} 
              className="flex-1 text-xs font-mono p-2 border rounded bg-white"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button 
              onClick={() => {
                navigator.clipboard.writeText(formattedBikesForCopy);
                alert('Copiado para a área de transferência!');
              }}
              className="px-3 py-1 bg-blue-600 text-white text-[10px] font-bold rounded hover:bg-blue-700"
            >
              Copiar
            </button>
            <button 
              onClick={() => {
                setFormattedBikesForCopy('');
                setClickedBikesForStatus(new Set());
                try { localStorage.removeItem(`status_clicked_${driverName}`); localStorage.removeItem(`status_copy_${driverName}`); } catch {}
              }}
              className="px-3 py-1 bg-gray-200 text-gray-600 text-[10px] font-bold rounded hover:bg-gray-300"
            >
              Limpar
            </button>
          </div>
        </div>
      )}

      {/* HEADER */}
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 pb-4 border-b">
        <div>
          <p className="font-bold text-base text-gray-800">{driverName}</p>
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-600 uppercase tracking-wider">{category}</p>
            <span className={`text-[10px] flex items-center gap-1 cursor-help ${syncError ? 'text-red-500 font-bold' : 'text-gray-400'}`}
              title={syncError || 'Sincronizado'} onClick={() => syncError && alert(syncError)}>
              <span className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-blue-500 animate-pulse' : syncError ? 'bg-red-500' : 'bg-green-500'}`}></span>
              {syncError ? 'Erro Planilha' : lastSyncTime}
            </span>
          </div>
        </div>
        <div className="flex items-center flex-wrap gap-1 mt-4 sm:mt-0">
          {isAdm && (
            <button onClick={handleMigrate} disabled={isMigrating} title="Migrar para Firebase"
              className={`p-1.5 sm:p-2 rounded-full transition-colors ${isMigrating ? 'text-orange-500 animate-spin' : 'text-gray-500 hover:bg-gray-100 hover:text-orange-600'}`}>
              <DatabaseIcon className="w-6 h-6 sm:w-7 sm:h-7" />
            </button>
          )}
          {!isMecanica && <>
            <button onClick={() => setRequestModalOpen(true)} disabled={isLoading} title="Nova Solicitação" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><PlusIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
            <button onClick={() => setRouteModalOpen(true)} disabled={isLoading} title="Criar Roteiro" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><PlusPlusIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
            <button onClick={() => setTrailerModalOpen(true)} disabled={isLoading} title="Carretinha" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"><TrailerIcon className="w-6 h-6 sm:w-7 sm:h-7"/></button>
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
        {!isAdm && !isMecanica && driversSummary.length > 0 && (
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

        {/* RESUMO DE PRODUÇÃO MECÂNICA — acima da busca */}
        {isMecanica && (() => {
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
          const byMechanic: Record<string, {manutencao: number, reserva: number}> = {};
          mechanicsList.filter(b => b.status === 'Em Manutenção' || b.status === 'Reserva').forEach(b => {
            const m = b.mecanico || '—';
            if (!byMechanic[m]) byMechanic[m] = { manutencao: 0, reserva: 0 };
            const entryDate = b.dataEntrada ? new Date(b.dataEntrada) : null;
            if (!entryDate || entryDate >= cutoff) {
              if (b.status === 'Em Manutenção') byMechanic[m].manutencao++;
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
                          <span className="text-[7px] font-bold text-orange-400 uppercase leading-none">Man</span>
                          <span className="text-sm font-black text-orange-500 leading-tight">{counts.manutencao}</span>
                        </div>
                        <div className="flex flex-col items-center py-0.5 px-2 bg-green-50 border border-green-100 rounded-md flex-1">
                          <span className="text-[7px] font-bold text-green-500 uppercase leading-none">Res</span>
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
                  <div id="qr-reader" className="w-full h-full"/>
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center"><div className="w-48 h-48 border-2 border-blue-400/50 rounded-lg"/></div>
                  <button onClick={stopScanner} className="absolute top-2 right-2 bg-black/50 text-white p-1 rounded-full"><XIcon className="w-4 h-4"/></button>
                  <p className="absolute bottom-2 left-0 right-0 text-center text-[10px] text-white bg-black/50 py-1">Aponte para o QR Code</p>
                </div>
              )}
            </div>
          </div>
        )}

        {error && <div className="text-red-600 bg-red-100 p-3 rounded-md text-sm mb-4">{error}</div>}
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
              {!isMecanica && (
                <>
                  <button onClick={() => handleStatusUpdate('Recolhida')} disabled={isLoading || processingBikes.has(String(searchedBike['Patrimônio']))}
                    className="px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm disabled:bg-gray-400">Recolhida</button>
                  <button onClick={() => setIsNotFoundConfirmOpen(true)} disabled={isLoading || processingBikes.has(String(searchedBike['Patrimônio']))}
                    className="px-3 py-1.5 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm disabled:bg-gray-400">Não Encontrada</button>
                </>
              )}
              
              {isMecanica && (
                <>
                  <button onClick={() => handleInsertBike(String(searchedBike['Patrimônio']), 'Aguardando Confirmação')} disabled={isLoading || processingBikes.has(String(searchedBike['Patrimônio']))}
                    className="px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-[10px] font-bold disabled:bg-gray-400">Inserir Filial</button>
                  <button onClick={() => handleInsertBike(String(searchedBike['Patrimônio']), 'Em Manutenção')} disabled={isLoading || processingBikes.has(String(searchedBike['Patrimônio']))}
                    className="px-3 py-1.5 bg-orange-600 text-white rounded-md hover:bg-orange-700 text-[10px] font-bold disabled:bg-gray-400">Inserir Mecânica</button>
                  <button onClick={() => handleInsertBike(String(searchedBike['Patrimônio']), 'Reserva')} disabled={isLoading || processingBikes.has(String(searchedBike['Patrimônio']))}
                    className="col-span-2 px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 text-[10px] font-bold disabled:bg-gray-400">Inserir Reserva</button>
                </>
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
                    <button onClick={() => handleAcceptRequest(req.id, req.bikeNumber, req.reason)} disabled={isLoading} className="text-green-600 hover:text-green-700 text-sm font-bold disabled:text-gray-400">Aceitar</button>
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
          <div className="grid grid-cols-3 gap-3 mb-6">
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Filial' ? null : 'Filial')}
              className={`flex flex-col items-center justify-center p-3 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Filial' ? 'bg-blue-600 border-blue-700 text-white' : 'bg-blue-50 border-blue-100 hover:bg-blue-100'}`}
            >
              <div className={`p-2 rounded-full mb-2 ${activeMechanicCategory === 'Filial' ? 'bg-white text-blue-600' : 'bg-blue-600 text-white'}`}>
                <CarIcon className="w-5 h-5" />
              </div>
              <span className={`text-[9px] font-bold text-center leading-tight h-6 flex items-center ${activeMechanicCategory === 'Filial' ? 'text-white' : 'text-blue-800'}`}>Filial, aguardando confirmação</span>
              <span className={`mt-1 text-xs font-black ${activeMechanicCategory === 'Filial' ? 'text-white' : 'text-blue-600'}`}>
                {mechanicsList.filter(b => b.status === 'Aguardando Confirmação').length}
              </span>
            </button>
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Manutenção' ? null : 'Manutenção')}
              className={`flex flex-col items-center justify-center p-3 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Manutenção' ? 'bg-orange-600 border-orange-700 text-white' : 'bg-orange-50 border-orange-100 hover:bg-orange-100'}`}
            >
              <div className={`p-2 rounded-full mb-2 ${activeMechanicCategory === 'Manutenção' ? 'bg-white text-orange-600' : 'bg-orange-600 text-white'}`}>
                <BicycleIcon className="w-5 h-5" />
              </div>
              <span className={`text-[9px] font-bold text-center leading-tight h-6 flex items-center ${activeMechanicCategory === 'Manutenção' ? 'text-white' : 'text-orange-800'}`}>Em manutenção</span>
              <span className={`mt-1 text-xs font-black ${activeMechanicCategory === 'Manutenção' ? 'text-white' : 'text-orange-600'}`}>
                {mechanicsList.filter(b => b.status === 'Em Manutenção').length}
              </span>
            </button>
            <button 
              onClick={() => setActiveMechanicCategory(activeMechanicCategory === 'Reserva' ? null : 'Reserva')}
              className={`flex flex-col items-center justify-center p-3 border rounded-xl shadow-sm transition-all active:scale-95 ${activeMechanicCategory === 'Reserva' ? 'bg-green-600 border-green-700 text-white' : 'bg-green-50 border-green-100 hover:bg-green-100'}`}
            >
              <div className={`p-2 rounded-full mb-2 ${activeMechanicCategory === 'Reserva' ? 'bg-white text-green-600' : 'bg-green-600 text-white'}`}>
                <TrailerIcon className="w-5 h-5" />
              </div>
              <span className={`text-[9px] font-bold text-center leading-tight h-6 flex items-center ${activeMechanicCategory === 'Reserva' ? 'text-white' : 'text-green-800'}`}>Reserva</span>
              <span className={`mt-1 text-xs font-black ${activeMechanicCategory === 'Reserva' ? 'text-white' : 'text-green-600'}`}>
                {mechanicsList.filter(b => b.status === 'Reserva').length}
              </span>
            </button>
          </div>
        )}

        {/* MECÂNICA */}
        {isMecanica && activeMechanicCategory && (
          <div className="mt-6 space-y-6">
            {activeMechanicCategory === 'Filial' && (
              <div id="section-filial" className="p-4 border rounded-lg bg-blue-50 shadow-sm scroll-mt-4">
                <h2 className="text-lg font-bold text-blue-800 mb-3 flex items-center gap-2"><CarIcon className="w-5 h-5"/>Filial - Aguardando Confirmação</h2>
                {mechanicsList.filter(b => b.status === 'Aguardando Confirmação').length > 0 ? (
                  <div className="space-y-2">
                    {mechanicsList.filter(b => b.status === 'Aguardando Confirmação').map((bike, i) => (
                      <div key={`mec-filial-${bike.patrimonio}-${i}`} className="flex justify-between items-center p-3 bg-white border rounded-md shadow-sm">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-gray-700">Bike: {bike.patrimonio}</span>
                            {bike.manual && (
                              <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-[8px] font-black uppercase rounded border border-purple-200">Manual</span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                            {bike.bateria !== undefined && <p className="text-[10px] text-gray-600">Bateria: {bike.bateria}%</p>}
                            {bike.carregamento === 'Carregando' && (
                              <p className="text-[10px] text-green-600 font-bold">⚡ Carregando</p>
                            )}
                            {bike.carregamento === 'Não carregando' && (
                              <p className="text-[10px] text-red-500 font-bold">🔌 Não carregando</p>
                            )}
                          </div>
                          {bike.motorista && <p className="text-[10px] text-blue-700 font-semibold">Motorista: {bike.motorista}</p>}
                          {bike.observacao && <p className="text-[10px] text-orange-600">Motivo: {bike.observacao}</p>}
                          {bike.mecanico && <p className="text-[10px] font-bold text-blue-600">Mecânico: {bike.mecanico}</p>}
                          {bike.tratativa && <p className="text-[10px] text-gray-500 italic">Obs: {bike.tratativa}</p>}
                        </div>
                        <div className="flex flex-col gap-2 min-w-[140px]">
                          {!clickedBikesForStatus.has(bike.patrimonio) && (
                            <button onClick={() => handleAlterarStatus(bike.patrimonio)} className="w-full px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700 active:scale-95">Status</button>
                          )}
                          <div className="flex gap-2">
                            <button onClick={() => handleConfirmMechanicsReceipt(bike.patrimonio)} className="flex-1 px-3 py-1.5 bg-orange-500 text-white text-xs font-bold rounded hover:bg-orange-600 active:scale-95">Manutenção</button>
                            <button onClick={() => handleNotFoundMechanic(bike.patrimonio)} className="flex-1 px-3 py-1.5 bg-red-500 text-white text-xs font-bold rounded hover:bg-red-600 active:scale-95">Não encontrada</button>
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
                <h2 className="text-lg font-bold text-orange-800 mb-3 flex items-center gap-2"><BicycleIcon className="w-5 h-5"/>Mecânica - Em Manutenção</h2>
                {mechanicsList.filter(b => b.status === 'Em Manutenção').length > 0 ? (
                  <div className="space-y-2">
                    {mechanicsList.filter(b => b.status === 'Em Manutenção').map((bike, i) => (
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
                        <button onClick={() => { setSelectedMechanicBike(bike); setIsMechanicRepairModalOpen(true); }} className="px-3 py-1 bg-orange-600 text-white text-xs font-bold rounded hover:bg-orange-700 active:scale-95">Finalizar Reparo</button>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-gray-500 italic">Nenhuma bike.</p>}
              </div>
            )}

            {activeMechanicCategory === 'Reserva' && (
              <div id="section-reserva" className="p-4 border rounded-lg bg-green-50 shadow-sm scroll-mt-4">
                <h2 className="text-lg font-bold text-green-800 mb-3 flex items-center gap-2"><TrailerIcon className="w-5 h-5"/>Reserva - Prontas para Remanejamento</h2>
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
                          <h3 className="font-bold text-green-700 flex items-center gap-2"><TrailerIcon className="w-4 h-4"/>{trailer}</h3>
                          {trailer !== 'Sem Carretinha' && (
                            <button onClick={() => handleFinalizeTrailer(trailer)} className="text-[10px] bg-green-600 text-white px-2 py-0.5 rounded font-bold hover:bg-green-700">Finalizar Carretinha</button>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {(bikes as any[]).map((bike, i) => (
                            <div key={`trailer-${bike.patrimonio}-${i}`} className="text-xs p-1.5 bg-gray-50 border rounded text-center font-medium text-gray-700 flex flex-col items-center gap-0.5">
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
                          <button onClick={() => { setSelectedBikesForTrailer((bikes as any[]).map(b => b.patrimonio)); setIsTrailerSelectionModalOpen(true); }}
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

        {/* PAINEL ADM */}
        {isAdm && adminNotification && (
          <div className="mx-4 mt-3 p-3 bg-green-50 border border-green-300 rounded-lg shadow-md">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <span className="text-2xl">🚌</span>
                <div>
                  <p className="font-bold text-green-800 text-sm">Carretinha Finalizada!</p>
                  <p className="text-green-700 text-xs mt-0.5">{adminNotification.message}</p>
                </div>
              </div>
              <button onClick={() => setAdminNotification(null)} className="text-green-500 hover:text-green-700 text-lg font-bold flex-shrink-0">✕</button>
            </div>
          </div>
        )}

        {isAdm && (
          <div className="mt-6 overflow-hidden">
            <div className="flex gap-2 mb-2 px-1">
              {[
                { key: 'summary', icon: <UserIcon className="w-5 h-5"/>, color: 'blue' },
                { key: 'alerts', icon: <AlertIcon className="w-5 h-5"/>, color: 'red' },
                { key: 'vandalized', icon: <AlertTriangleIcon className="w-5 h-5"/>, color: 'orange' },
                { key: 'status', icon: <PlusPlusIcon className="w-5 h-5"/>, color: 'blue' },
                { key: 'mechanics', icon: (
                  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                  </svg>
                ), color: 'orange' },
                { key: 'bike_search', icon: <SearchIcon className="w-5 h-5"/>, color: 'purple' },
              ].map(({ key, icon, color }) => (
                <button key={key} onClick={() => setActiveQuadrant(key as any)}
                  className={`p-2 rounded-full transition-all ${activeQuadrant === key ? `bg-${color}-600 text-white shadow-md` : 'bg-gray-200 text-gray-500'}`}>
                  {icon}
                </button>
              ))}
            </div>

            <div className="relative w-full overflow-hidden rounded-lg border bg-gray-50 shadow-inner min-h-[400px]">
              <div className="flex transition-transform duration-500 ease-in-out"
                style={{ transform: `translateX(${activeQuadrant === 'summary' ? '0%' : activeQuadrant === 'alerts' ? '-100%' : activeQuadrant === 'vandalized' ? '-200%' : activeQuadrant === 'status' ? '-300%' : activeQuadrant === 'mechanics' ? '-400%' : '-500%'})` }}>

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
                            const isToday = timelineDate === localDateStr();
                            const sheetsEvents = (driver.timeline || []) as Array<{tsMs: number, hour: number, min: number, type: string, bikeNumber?: string}>;
                            // Eventos Firebase (em_posse) só disponíveis para hoje
                            const fbEvents = isToday ? (firebaseTimelineEvents[driver.name] || []).map((e: any) => ({
                              tsMs: e.tsMs, hour: new Date(e.tsMs).getHours(),
                              min: new Date(e.tsMs).getMinutes(), type: e.type, bikeNumber: e.bikeNumber
                            })) : [];
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
                                        title={`${cfg.label}${cl.type === 'em_posse' && cl.bikes.length > 0 ? ` Bike ${cl.bikes.join(', ')}` : isMulti ? ` (${cl.count} bikes)` : ''} — ${fmtTime(cl.tsMs)}`}
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

                {/* Quadrante 4: Alterar Status */}
                <div className="min-w-full p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                    <div className="flex items-center gap-2"><BicycleIcon className="w-5 h-5 text-blue-600"/><h3 className="text-lg font-bold text-gray-800">Alterar Status</h3></div>
                    <div className="flex items-center gap-2 bg-white p-1 rounded-lg border shadow-sm">
                      <span className="text-[10px] font-bold text-gray-400 uppercase ml-2">Período:</span>
                      <select value={statusTimeRange} onChange={e => setStatusTimeRange(e.target.value as any)} className="text-xs font-bold text-gray-600 bg-transparent border-none focus:ring-0 cursor-pointer py-1 pr-8">
                        <option value="24h">Últimas 24h</option>
                        <option value="48h">Últimas 48h</option>
                        <option value="72h">Últimas 72h</option>
                        <option value="week">Última Semana</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[
                      { key: 'vandalizadas', label: 'Vandalizadas', color: 'orange', data: changeStatusData.vandalizadas },
                      { key: 'filial', label: 'Filial', color: 'blue', data: changeStatusData.filial },
                    ].map(({ key, label, color, data }) => (
                      <div key={key} className="bg-white p-3 rounded-lg border shadow-sm">
                        <div className="flex justify-between items-center mb-2">
                          <h4 className={`text-sm font-bold text-${color}-700 uppercase tracking-wider`}>{label}</h4>
                          <button onClick={() => copyToClipboard(data.map((v: any) => v.patrimonio))} className="px-2 py-1 bg-gray-100 text-gray-600 text-[10px] font-bold rounded hover:bg-gray-200 flex items-center gap-1">
                            <SheetIcon className="w-3 h-3"/> Copiar Lista
                          </button>
                        </div>
                        <div className="max-h-[200px] overflow-y-auto bg-gray-50 rounded p-2 border border-dashed">
                          {data.length > 0
                            ? <p className="text-xs font-mono break-all text-gray-600 leading-relaxed">{data.map((v: any) => v.patrimonio).join(',')}</p>
                            : <p className="text-xs text-gray-400 italic text-center py-4">Nenhuma bike.</p>}
                        </div>
                      </div>
                    ))}
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
                    <div className="grid grid-cols-3 gap-1.5">
                      {[
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
              </div>
            </div>
          </div>
        )}

        {/* ROTEIRO DE RECOLHAS */}
        {!isAdm && !isMecanica && (
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
        {!isAdm && !isMecanica && (
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
                          <span className="text-xs font-black text-gray-700">{cfg.label}</span>
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
      <RouteModal isOpen={isTrailerModalOpen} onClose={() => setTrailerModalOpen(false)} onSubmit={handleCreateTrailer} isLoading={isLoading} pendingBikeNumbers={allActiveBikes} motoristas={motoristas} error={error} clearError={() => setError(null)} type="trailer"/>
      <ReportModal isOpen={isReportModalOpen} onClose={() => setReportModalOpen(false)} driverName={driverName} plate={plate} kmInicial={kmInicial}/>
      <DestinationModal isOpen={destinationModal.isOpen} onClose={() => setDestinationModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={obs => executeCollectedBikeAction(destinationModal.bikeNumber, destinationModal.type === 'Estação' ? 'Enviada para Estação' : destinationModal.type === 'Filial' ? 'Enviada para Filial' : 'Vandalizada', obs)}
        type={destinationModal.type} bikeNumber={destinationModal.bikeNumber} stationName={destinationModal.stationName} isLoading={isLoading} onRecalculate={recalculateStation}/>
      <HistoryModal isOpen={isHistoryModalOpen} onClose={() => setIsHistoryModalOpen(false)} history={requestsHistory} isLoading={isHistoryLoading} driverName={driverName}/>
      
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

      <ScheduleModal isOpen={isScheduleModalOpen} onClose={() => setIsScheduleModalOpen(false)} schedule={userSchedule} driverName={driverName} isLoading={isScheduleLoading}/>
      <VehicleSwitchModal isOpen={isVehicleModalOpen} onClose={() => setIsVehicleModalOpen(false)} onSwitch={(p, km) => onUpdateUser({ plate: p, kmInicial: km })} driverName={driverName}/>
      <AdminAlerts isOpen={isAdminAlertsOpen} onClose={() => setIsAdminAlertsOpen(false)} adminName={driverName}/>
      <ReporModal isOpen={isReporModalOpen} onClose={() => setIsReporModalOpen(false)} data={reporData} isLoading={isReporLoading}/>
      <MechanicRepairModal isOpen={isMechanicRepairModalOpen} onClose={() => setIsMechanicRepairModalOpen(false)} onConfirm={handleFinalizeMechanicsRepair} isLoading={isLoading} bikeNumber={selectedMechanicBike?.patrimonio || ''}/>
      <MechanicSelectionModal isOpen={isMechanicSelectionModalOpen} onClose={() => setIsMechanicSelectionModalOpen(false)} onConfirm={handleMechanicSelectionConfirm} isLoading={isLoading} bikeNumber={selectedMechanicBike?.patrimonio || ''}/>
      <TrailerSelectionModal isOpen={isTrailerSelectionModalOpen} onClose={() => setIsTrailerSelectionModalOpen(false)}
        onConfirm={name => { handleOrganizeTrailer(selectedBikesForTrailer, name); setIsTrailerSelectionModalOpen(false); }}
        isLoading={isLoading} bikeNumbers={selectedBikesForTrailer}/>
    </div>
  );
};

export default MainScreen;