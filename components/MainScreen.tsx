
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { BicycleData, PickupRequest, DriverLocation } from '../types';
import { LogoutIcon, PlusIcon, PlusPlusIcon, MapIcon, SheetIcon, SearchIcon, AlertIcon, CalendarIcon, CarIcon, XIcon, BicycleIcon, MovingIcon, UserIcon, AlertTriangleIcon, RefreshIcon, QrCodeIcon, TrailerIcon } from './icons';
import { Html5Qrcode } from 'html5-qrcode';
import ScheduleModal from './ScheduleModal';
import ReporModal from './ReporModal';
import RequestModal from './RequestModal';
import ReportModal from './ReportModal';
import RouteModal from './RouteModal';
import DestinationModal from './DestinationModal';
import HistoryModal from './HistoryModal';
import VehicleSwitchModal from './VehicleSwitchModal';
import EditDriverModal from './EditDriverModal';
import AdminAlerts from './AdminAlerts';
import { apiCall, apiGetCall } from '../api';
import { User } from '../types';

interface MainScreenProps {
  driverName: string;
  category: string;
  plate?: string;
  kmInicial?: number;
  onLogout: () => void;
  onShowMap: () => void; // Prop para mostrar o mapa
  onUpdateUser: (updates: Partial<User>) => void;
}

const normalizeCoord = (coord: number): number => {
    if (isNaN(coord) || coord === null) return coord;
    let val = coord;
    // Se o valor for muito grande (ex: -23550000), provavelmente está sem o ponto decimal
    // Coordenadas válidas estão entre -180 e 180.
    if (Math.abs(val) > 1000) {
        while (Math.abs(val) > 180) {
            val /= 10;
        }
    }
    return val;
};

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const nLat1 = normalizeCoord(lat1);
    const nLon1 = normalizeCoord(lon1);
    const nLat2 = normalizeCoord(lat2);
    const nLon2 = normalizeCoord(lon2);

    const R = 6371; // Radius of the earth in km
    const dLat = (nLat2 - nLat1) * (Math.PI / 180);
    const dLon = (nLon2 - nLon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(nLat1 * (Math.PI / 180)) * Math.cos(nLat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2)
        ;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
};

const MainScreen: React.FC<MainScreenProps> = ({ driverName, category, plate, kmInicial, onLogout, onShowMap, onUpdateUser }) => {
    const [gpsError, setGpsError] = useState<string | null>(null);
    const [routeDistances, setRouteDistances] = useState<Record<string, { distance: string, duration: string, value: number }>>({});
    const [motoristas, setMotoristas] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    
    const [error, setError] = useState<string | null>(null);
    
    const [isRequestModalOpen, setRequestModalOpen] = useState(false);
    const [isRouteModalOpen, setRouteModalOpen] = useState(false);
    const [isTrailerModalOpen, setTrailerModalOpen] = useState(false);
    const [isReportModalOpen, setReportModalOpen] = useState(false);
    const [isVehicleModalOpen, setIsVehicleModalOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [searchedBike, setSearchedBike] = useState<BicycleData | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [pendingRequests, setPendingRequests] = useState<PickupRequest[]>([]);
    const [routeBikes, setRouteBikes] = useState<string[]>([]);
    const [routeBikesDetails, setRouteBikesDetails] = useState<Record<string, any>>({});
    const [currentDriverLocation, setCurrentDriverLocation] = useState<{lat: number, lng: number} | null>(null);
    const [collectedBikes, setCollectedBikes] = useState<string[]>([]);
    const [collectedBikesDetails, setCollectedBikesDetails] = useState<Record<string, any>>({});
    const [stations, setStations] = useState<any[]>([]);
    const [bikeConflicts, setBikeConflicts] = useState<Record<string, any>>({});
    const [driverLocations, setDriverLocations] = useState<DriverLocation[]>([]);

    const renderConflictIcon = (bike: string) => {
        const conflict = bikeConflicts[bike];
        if (!conflict) return null;

        const othersInRoute = conflict.drivers?.filter((d: string) => d !== driverName && !d.includes('(Em Posse)')) || [];
        const othersInPossession = conflict.drivers?.filter((d: string) => d !== driverName && d.includes('(Em Posse)')) || [];
        const hasStatusConflict = conflict.status && ['VANDALIZADA', 'MANUTENÇÃO', 'ROUBADA'].includes(conflict.status);
        const hasRecentAction = conflict.recentAction && !conflict.recentAction.startsWith(driverName);

        if (othersInRoute.length === 0 && othersInPossession.length === 0 && !hasStatusConflict && !hasRecentAction) {
            return null;
        }

        const messages = [];
        if (othersInRoute.length > 0) messages.push(`No roteiro de: ${othersInRoute.join(', ')}`);
        if (othersInPossession.length > 0) messages.push(`Em posse de: ${othersInPossession.join(', ')}`);
        if (hasStatusConflict) messages.push(`Status Crítico: ${conflict.status}`);
        if (hasRecentAction) messages.push(`Ação Recente: ${conflict.recentAction}`);

        return (
            <div className="group relative">
                <AlertIcon className="w-5 h-5 text-red-500" />
                <div className="absolute bottom-full mb-2 w-max max-w-[200px] px-2 py-1 bg-gray-800 text-white text-[10px] rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none shadow-lg">
                    {messages.map((m, i) => <p key={i}>{m}</p>)}
                </div>
            </div>
        );
    };

    const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
    const [isAdminAlertsOpen, setIsAdminAlertsOpen] = useState(false);
    const [alertCount, setAlertCount] = useState(0);
    const [hasNewAlerts, setHasNewAlerts] = useState(false);
    const [lastViewedAlertCount, setLastViewedAlertCount] = useState(0);
    const [isReporModalOpen, setIsReporModalOpen] = useState(false);
    const [reporData, setReporData] = useState<any[]>([]);
    const [isReporLoading, setIsReporLoading] = useState(false);
    const [driversSummary, setDriversSummary] = useState<any[]>([]);
    const [summaryTimeRange, setSummaryTimeRange] = useState<'day' | 'week' | 'month'>('day');
    const [isSummaryLoading, setIsSummaryLoading] = useState(false);
    const [activeQuadrant, setActiveQuadrant] = useState<'summary' | 'alerts' | 'vandalized' | 'status'>('summary');
    const [alerts, setAlerts] = useState<any[]>([]);
    const [isAlertsLoading, setIsAlertsLoading] = useState(false);
    const [vandalizedBikes, setVandalizedBikes] = useState<any[]>([]);
    const [isVandalizedLoading, setIsVandalizedLoading] = useState(false);
    const [isStatusLoading, setIsStatusLoading] = useState(false);
    const [changeStatusData, setChangeStatusData] = useState<{ vandalizadas: string[], filial: string[] }>({ vandalizadas: [], filial: [] });
    const [statusTimeRange, setStatusTimeRange] = useState<'24h' | '48h' | '72h' | 'week'>('24h');
    const [backendVersion, setBackendVersion] = useState<string | null>(null);
    const [userSchedule, setUserSchedule] = useState<Record<string, string>>({});
    const [destinationModal, setDestinationModal] = useState<{
        isOpen: boolean;
        bikeNumber: string;
        type: 'Estação' | 'Filial' | 'Vandalizada';
        stationName?: string;
    }>({ isOpen: false, bikeNumber: '', type: 'Estação' });
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
    const [isEditDriverModalOpen, setIsEditDriverModalOpen] = useState(false);
    const [editingDriver, setEditingDriver] = useState<any>(null);
    const [requestsHistory, setRequestsHistory] = useState<any[]>([]);
    const [isHistoryLoading, setIsHistoryLoading] = useState(false);
    const [processingBikes, setProcessingBikes] = useState<Set<string>>(new Set());
    const isUpdatingStateRef = useRef(false);
    const lastLocationUpdateRef = useRef<number>(0);
    const lastLocationRef = useRef<{ lat: number, lng: number } | null>(null);

    const [lastSyncTime, setLastSyncTime] = useState<string>(new Date().toLocaleTimeString());
    const [isSyncing, setIsSyncing] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const scannerRef = useRef<Html5Qrcode | null>(null);

    const fetchAlerts = async () => {
        if (!category.includes('ADM')) return;
        setIsAlertsLoading(true);
        try {
            const result = await apiGetCall('getAlerts');
            if (result.success) {
                setAlerts(result.data);
                if (result.version) setBackendVersion(result.version);
            }
        } catch (err: any) {
            console.error("Erro ao buscar alertas:", err);
            if (err.message && err.message.includes('Ação desconhecida')) {
                alert("BACKEND DESATUALIZADO: O script do Google Apps Script precisa ser reimplantado como 'Nova Implantação' para suportar o sistema de alertas.");
            }
        } finally {
            setIsAlertsLoading(false);
        }
    };

    const handleConfirmFound = async (alertId: number) => {
        if (!window.confirm("Confirmar que esta bicicleta foi encontrada?")) return;
        
        setIsLoading(true);
        try {
            const result = await apiCall({ action: 'confirmBikeFound', alertId, driverName });
            if (result.success) {
                fetchAlerts();
                alert("Bicicleta marcada como encontrada com sucesso!");
            } else {
                throw new Error(result.error);
            }
        } catch (err: any) {
            alert("Erro ao confirmar: " + err.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleConfirmVandalizedFound = async (alertId: number) => {
        if (!window.confirm("Confirmar que esta bicicleta vandalizada foi encontrada?")) return;
        
        setIsLoading(true);
        try {
            const result = await apiCall({ action: 'confirmVandalizedFound', alertId, driverName });
            if (result.success) {
                refreshAll(true);
                alert("Bicicleta vandalizada marcada como encontrada!");
            } else {
                throw new Error(result.error);
            }
        } catch (err: any) {
            alert("Erro ao confirmar: " + err.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleUpdateDriverState = async (targetDriverName: string, routeBikes: string[], collectedBikes: string[]) => {
        setIsLoading(true);
        try {
            const result = await apiCall({
                action: 'updateDriverState',
                driverName: targetDriverName,
                routeBikes,
                collectedBikes
            });
            if (result.success) {
                alert(`Estado do motorista ${targetDriverName} atualizado com sucesso!`);
                refreshAll(true);
                setIsEditDriverModalOpen(false);
            } else {
                throw new Error(result.error || 'Erro ao atualizar estado do motorista');
            }
        } catch (err: any) {
            alert("Erro ao atualizar: " + err.message);
        } finally {
            setIsLoading(false);
        }
    };

    const copyToClipboard = (list: string[]) => {
        const text = list.join(',');
        navigator.clipboard.writeText(text).then(() => {
            alert("Lista copiada para a área de transferência!");
        }).catch(err => {
            console.error('Erro ao copiar:', err);
            alert("Erro ao copiar lista.");
        });
    };

    const fetchSchedule = async () => {
        try {
            const result = await apiCall({ action: 'getSchedule', driverName });
            if (result.success) {
                setUserSchedule(result.data);
            } else {
                console.warn("Aviso na escala:", result.error);
            }
        } catch (err) {
            console.error("Erro ao buscar escala:", err);
        }
    };

    const fetchReporData = async () => {
        setIsReporLoading(true);
        try {
            const result = await apiGetCall('getReporData');
            if (result.success) {
                setReporData(result.data);
            } else {
                throw new Error(result.error);
            }
        } catch (err: any) {
            setError(`Erro ao carregar dados de reposição: ${err.message}`);
        } finally {
            setIsReporLoading(false);
        }
    };

    const [useDriversSummaryFallback, setUseDriversSummaryFallback] = useState(false);

    const fetchDriversSummary = async () => {
        if (!category.includes('ADM')) return;
        
        const currentRange = summaryTimeRange;
        setIsSummaryLoading(true);
        // Se já sabemos que precisamos do fallback, vamos direto para ele
        if (useDriversSummaryFallback) {
            await runDriversSummaryFallback();
            setIsSummaryLoading(false);
            return;
        }

        try {
            const result = await apiCall({ action: 'getDriversSummary', timeRange: currentRange }, 1, true);
            // Verifica se o range ainda é o mesmo antes de atualizar o estado
            if (result.success && summaryTimeRange === currentRange) {
                setDriversSummary(result.data);
            } else if (!result.success) {
                setUseDriversSummaryFallback(true);
                await runDriversSummaryFallback();
            }
        } catch {
            setUseDriversSummaryFallback(true);
            await runDriversSummaryFallback();
        } finally {
            setIsSummaryLoading(false);
        }
    };

    useEffect(() => {
        if (category.includes('ADM')) {
            fetchDriversSummary();
        }
    }, [summaryTimeRange]);

    useEffect(() => {
        // O contador de alertas agora é atualizado via refreshAll (sync)
        // Mantemos apenas o estado inicial aqui se necessário, mas o refreshAll já cuida disso
    }, [driverName, lastViewedAlertCount]);

    const runDriversSummaryFallback = async () => {
        const currentRange = summaryTimeRange;
        console.warn("Executando fallback manual para resumo dos motoristas...");
        try {
            const driversResult = await apiCall({ action: 'getMotoristas' });
            if (!driversResult.success) return;
            const drivers = driversResult.data;

            const requestsResult = await apiCall({ action: 'getRequests', driverName, category });
            const allPending = requestsResult.success ? requestsResult.data : [];

            const summary = await Promise.all(drivers.map(async (d: string) => {
                const [stateRes, reportRes] = await Promise.all([
                    apiCall({ action: 'getDriverState', driverName: d }),
                    apiCall({ action: 'getDailyReportData', driverName: d, timeRange: currentRange })
                ]);

                const stats = { recolhidas: 0, remanejada: 0, naoEncontrada: 0, naoAtendida: 0 };
                if (reportRes.success) {
                    stats.recolhidas = reportRes.data.recolhidas?.length || 0;
                    stats.remanejada = reportRes.data.remanejadas?.length || 0;
                    stats.naoEncontrada = reportRes.data.naoEncontrada?.length || 0;
                    stats.naoAtendida = reportRes.data.naoAtendida?.length || 0;
                }

                const pendingCount = allPending.filter((r: any) => {
                    const recipient = (r.recipient || 'Todos').toLowerCase();
                    const driverNameLower = (d || '').toLowerCase();
                    return recipient === 'todos' || recipient === driverNameLower;
                }).length;

                return {
                    name: d,
                    stats,
                    realTime: {
                        route: stateRes.success ? stateRes.data.routeBikes : [],
                        collected: stateRes.success ? stateRes.data.collectedBikes : []
                    },
                    pendingRequests: pendingCount
                };
            }));
            
            if (summaryTimeRange === currentRange) {
                setDriversSummary(summary);
            }
        } catch (fallbackErr) {
            console.error("Erro no fallback do resumo:", fallbackErr);
        }
    };

    const fetchRequestsHistory = async () => {
        setIsHistoryLoading(true);
        try {
            const result = await apiCall({ action: 'getRequestsHistory', driverName, category });
            if (result.success) {
                setRequestsHistory(result.data);
            }
        } catch (err) {
            console.error("Erro ao buscar histórico:", err);
        } finally {
            setIsHistoryLoading(false);
        }
    };

    const handleOpenHistory = () => {
        setIsHistoryModalOpen(true);
        fetchRequestsHistory();
    };

    const startScanner = async () => {
        setIsScannerOpen(true);
        setTimeout(async () => {
            try {
                const html5QrCode = new Html5Qrcode("qr-reader");
                scannerRef.current = html5QrCode;
                await html5QrCode.start(
                    { facingMode: "environment" },
                    {
                        fps: 10,
                        qrbox: { width: 250, height: 250 }
                    },
                    (decodedText) => {
                        // Exemplo: http://www.bikesjc.com.br/home/download/400
                        const match = decodedText.match(/\/download\/(\d+)/);
                        if (match && match[1]) {
                            const bikeId = match[1];
                            setSearchTerm(bikeId);
                            stopScanner();
                            handleSearch(bikeId);
                        } else {
                            // Se não bater com o padrão, tenta usar o texto puro se for só número
                            if (/^\d+$/.test(decodedText)) {
                                setSearchTerm(decodedText);
                                stopScanner();
                                handleSearch(decodedText);
                            }
                        }
                    },
                    () => {
                        // Erros de leitura ignorados (acontece o tempo todo enquanto busca)
                    }
                );
            } catch (err) {
                console.error("Erro ao iniciar scanner:", err);
                setError("Não foi possível acessar a câmera para ler o QR Code.");
                setIsScannerOpen(false);
            }
        }, 100);
    };

    const stopScanner = async () => {
        if (scannerRef.current) {
            try {
                await scannerRef.current.stop();
                await scannerRef.current.clear();
            } catch (err) {
                console.error("Erro ao parar scanner:", err);
            }
            scannerRef.current = null;
        }
        setIsScannerOpen(false);
    };

    useEffect(() => {
        return () => {
            if (scannerRef.current) {
                scannerRef.current.stop().catch(console.error);
            }
        };
    }, []);

    const handleAcceptRequest = async (requestId: number, bikeNumbers: string, reason: string = '') => {
        const originalPendingRequests = [...pendingRequests];
        const originalRouteBikes = [...routeBikes];
        const originalCollectedBikes = [...collectedBikes];
        
        const bikesToAdd = (bikeNumbers || '').split(',').map(s => s.trim()).filter(Boolean);
        
        // Verifica se alguma bike já está no roteiro ou em posse
        const alreadyInPossession = bikesToAdd.filter(b => collectedBikes.includes(b));
        
        if (alreadyInPossession.length > 0) {
            alert(`As seguintes bikes já estão em sua posse: ${alreadyInPossession.join(', ')}`);
            return;
        }

        const isTrailer = (reason || '').toUpperCase().includes('CARRETINHA');

        setPendingRequests(prev => prev.filter(r => r.id !== requestId));
        
        let newRouteBikes = [...routeBikes];
        let newCollectedBikes = [...collectedBikes];

        if (isTrailer) {
            // Se for carretinha, adiciona diretamente às bikes recolhidas e garante que não estejam no roteiro
            newCollectedBikes = [...new Set([...collectedBikes, ...bikesToAdd])];
            newRouteBikes = routeBikes.filter(b => !bikesToAdd.includes(b));
            setCollectedBikes(newCollectedBikes);
            setRouteBikes(newRouteBikes);
        } else {
            newRouteBikes = [...new Set([...routeBikes, ...bikesToAdd])];
            setRouteBikes(newRouteBikes);
        }

        setIsLoading(true);
        try {
            const result = await apiCall({ action: 'acceptRequest', requestId, driverName });
            if (result.success) {
                // Atualiza o estado do roteiro no servidor
                await apiCall({ action: 'updateDriverState', driverName, routeBikes: newRouteBikes, collectedBikes: newCollectedBikes });
                alert(isTrailer ? 'Carretinha aceita e adicionada às suas bikes recolhidas!' : 'Solicitação aceita e adicionada ao seu roteiro!');
                refreshAll(true);
            } else {
                throw new Error(result.error || 'Falha ao aceitar a solicitação.');
            }
        } catch (err: any) {
            // ROLLBACK em caso de erro
            setPendingRequests(originalPendingRequests);
            setRouteBikes(originalRouteBikes);
            setCollectedBikes(originalCollectedBikes);
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleDeclineRequest = async (requestId: number) => {
        const originalPendingRequests = [...pendingRequests];
        
        // ATUALIZAÇÃO OTIMISTA: Remove da lista imediatamente
        setPendingRequests(prev => prev.filter(r => r.id !== requestId));

        setIsLoading(true);
        try {
            const result = await apiCall({ action: 'declineRequest', requestId, driverName });
            if (result.success) {
                alert('Solicitação recusada.');
                refreshAll(true);
            } else {
                throw new Error(result.error || 'Falha ao recusar a solicitação.');
            }
        } catch (err: any) {
            // ROLLBACK em caso de erro
            setPendingRequests(originalPendingRequests);
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };
    
    const handleCreateRequest = async (details: { bikeNumber: string; location: string; reason: string; recipient: string; }) => {
        setIsLoading(true);
        setError(null);
        try {
            const result = await apiCall({
                action: 'createRequest',
                patrimonio: details.bikeNumber,
                ocorrencia: details.reason,
                local: details.location,
                recipient: details.recipient
            });

            if (result.success) {
                alert('Solicitação enviada com sucesso!');
                setRequestModalOpen(false);
                refreshAll(true);
            } else {
                throw new Error(result.error || 'Falha ao criar a solicitação.');
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };
    
    const handleCreateRoute = async (details: { routeName: string; bikeNumbers: string[]; recipient: string; }) => {
        if (!details.bikeNumbers || details.bikeNumbers.length === 0) {
            alert('Por favor, insira ao menos um número de bicicleta.');
            return;
        }

        setIsLoading(true);
        setError(null);
        try {
            const result = await apiCall({
                action: 'createRequest',
                patrimonio: details.bikeNumbers.join(', '),
                ocorrencia: details.routeName || 'Roteiro sem nome',
                local: 'Criado via Roteiro App',
                recipient: details.recipient || 'Todos'
            });

            if (result.success) {
                alert('Roteiro enviado como solicitação com sucesso!');
                setRouteModalOpen(false);
                refreshAll(true);
            } else {
                throw new Error(result.error || 'Falha ao criar a solicitação de roteiro.');
            }
        } catch (err: any) {
            setError(err.message);
            alert(`Erro ao enviar roteiro: ${err.message}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateTrailer = async (details: { routeName: string; bikeNumbers: string[]; recipient: string; }) => {
        if (!details.bikeNumbers || details.bikeNumbers.length === 0) {
            alert('Por favor, insira ao menos um número de bicicleta.');
            return;
        }
        
        setIsLoading(true);
        setError(null);
        try {
            const result = await apiCall({
                action: 'createRequest',
                patrimonio: details.bikeNumbers.join(', '),
                ocorrencia: `[CARRETINHA] ${details.routeName || 'Sem Nome'}`,
                local: 'Criado via Carretinha App',
                recipient: details.recipient || 'Todos'
            });

            if (result.success) {
                alert('Carretinha enviada como solicitação com sucesso!');
                setTrailerModalOpen(false);
                refreshAll(true);
            } else {
                throw new Error(result.error || 'Falha ao criar a solicitação de carretinha.');
            }
        } catch (err: any) {
            setError(err.message);
            alert(`Erro ao enviar carretinha: ${err.message}`);
        } finally {
            setIsLoading(false);
        }
    };

    const getCurrentPosition = (): Promise<{ latitude: number; longitude: number }> => {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error('Geolocalização não é suportada por este navegador.'));
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    resolve({
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude,
                    });
                },
                (err) => {
                    reject(new Error(`Erro ao obter localização: ${err.message}`));
                },
                { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
            );
        });
    };

    const handleStatusUpdate = async (status: string) => {
        if (!searchedBike) return;
        const bikeNumber = searchedBike['Patrimônio'];
        
        // TRAVA: Impede processamento duplicado
        if (processingBikes.has(bikeNumber)) return;
        
        const originalSearchedBike = searchedBike;
        const originalSearchTerm = searchTerm;
        const originalCollectedBikes = [...collectedBikes];
        const originalRouteBikes = [...routeBikes];

        setProcessingBikes(prev => new Set(prev).add(bikeNumber));

        // ATUALIZAÇÃO OTIMISTA: Limpa a busca e atualiza as listas imediatamente
        setSearchedBike(null);
        setSearchTerm('');
        setError(null);

        if (status === 'Recolhida') {
            if (collectedBikes.includes(bikeNumber)) {
                alert(`Você já está em posse da bicicleta ${bikeNumber}.`);
                setProcessingBikes(prev => {
                    const next = new Set(prev);
                    next.delete(bikeNumber);
                    return next;
                });
                return;
            }
            const newCollectedBikes = [...new Set([...collectedBikes, bikeNumber])];
            const newRouteBikes = routeBikes.filter(b => b !== bikeNumber);
            setCollectedBikes(newCollectedBikes);
            setRouteBikes(newRouteBikes);
            
            // Sincroniza em background
            apiCall({
                action: 'updateDriverState',
                driverName,
                routeBikes: newRouteBikes,
                collectedBikes: newCollectedBikes
            }).then(result => {
                if (!result.success) {
                    setError(`Falha ao sincronizar estado da bike ${bikeNumber}.`);
                    setCollectedBikes(originalCollectedBikes);
                    setRouteBikes(originalRouteBikes);
                }
            }).catch(() => {
                setError(`Erro de conexão ao sincronizar bike ${bikeNumber}.`);
                setCollectedBikes(originalCollectedBikes);
                setRouteBikes(originalRouteBikes);
            }).finally(() => {
                setProcessingBikes(prev => {
                    const next = new Set(prev);
                    next.delete(bikeNumber);
                    return next;
                });
            });
            
            return; 
        }

        setIsLoading(true);
        try {
            // Se o status for "Não encontrada", loga diretamente no relatório e remove do roteiro.
            if (status === 'Não encontrada') {
                const newRouteBikes = routeBikes.filter(b => b !== bikeNumber);
                setRouteBikes(newRouteBikes);

                const reportResult = await apiCall({ 
                    action: 'finalizeRouteBike', 
                    driverName, 
                    bikeNumber, 
                    finalStatus: 'Não encontrada', 
                    finalObservation: '',
                    routeBikes: newRouteBikes,
                    collectedBikes
                });

                if (!reportResult.success) {
                    throw new Error(reportResult.error || 'Falha ao registrar "Não encontrada".');
                }
                alert(`Bicicleta ${bikeNumber} registrada como "Não encontrada".`);
            }
        } catch (err: any) {
            // ROLLBACK em caso de erro
            setSearchedBike(originalSearchedBike);
            setSearchTerm(originalSearchTerm);
            setError(err.message || `Ocorreu um erro ao processar a ação: ${status}`);
        } finally {
            setIsLoading(false);
            setProcessingBikes(prev => {
                const next = new Set(prev);
                next.delete(bikeNumber);
                return next;
            });
        }
    };

    const formatDateTime = (date: Date): string => {
        const pad = (num: number) => num.toString().padStart(2, '0');
        
        const day = pad(date.getDate());
        const month = pad(date.getMonth() + 1); // Mês é 0-indexado
        const year = date.getFullYear();
        
        const hours = pad(date.getHours());
        const minutes = pad(date.getMinutes());
        const seconds = pad(date.getSeconds());
        
        return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
    };

    const sortedCollectedBikes = useMemo(() => {
        return [...collectedBikes].sort((a, b) => {
            const numA = parseInt(a, 10) || 0;
            const numB = parseInt(b, 10) || 0;
            
            if (numA !== numB) return numA - numB;
            
            const batA = collectedBikesDetails[a]?.battery ?? 0;
            const batB = collectedBikesDetails[b]?.battery ?? 0;
            return batB - batA;
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

    const formatBattery = (value: any) => {
        if (value === undefined || value === null || value === '') return '';
        const num = parseFloat(String(value).replace('%', '').replace(',', '.'));
        if (isNaN(num)) return value;
        // Se o valor for <= 1, assumimos que é decimal (ex: 0.95 -> 95%, 1 -> 100%)
        // Se for > 1, assumimos que já é o percentual inteiro (ex: 95 -> 95%)
        return num <= 1 ? Math.round(num * 100) : Math.round(num);
    };

    const formatCoordinate = (coord: any): string => {
        if (typeof coord === 'undefined' || coord === null || coord === '') return '';
        const num = typeof coord === 'number' ? coord : parseFloat(String(coord).replace(',', '.'));
        if (isNaN(num)) return String(coord);

        const normalized = normalizeCoord(num);
        return normalized.toString();
    };

    const formatLastInfo = (dateString: any) => {
        if (!dateString || typeof dateString !== 'string') {
            return { text: 'N/A', color: 'text-gray-800' };
        }

        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            return { text: dateString, color: 'text-gray-800' };
        }

        const formattedDate = formatDateTime(date);

        const now = new Date();
        const diffHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

        let color = 'text-green-600'; 
        if (diffHours > 24) {
            color = 'text-red-600';
        } else if (diffHours > 1) {
            color = 'text-yellow-600';
        }

        return { text: formattedDate, color: color };
    };

    const handleSearch = async (bikeToSearch?: string) => {
        const term = bikeToSearch || searchTerm.trim();
        
        // Se o termo for vazio, limpa a busca
        if (!term) {
            setSearchedBike(null);
            setSearchTerm('');
            return;
        }

        setIsSearching(true);
        setError(null);
        // setSearchedBike(null); // REMOVIDO: Mantém a bike anterior visível para evitar "flicker"
        
        if (bikeToSearch) {
            setSearchTerm(bikeToSearch);
        }

        try {
            const result = await apiCall({ action: 'search', bikeNumber: term });
            if (result.success) {
                setSearchedBike(result.data);
                if (!bikeToSearch) {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
            } else {
                setSearchedBike(null); // Só limpa se der erro
                setError(result.error || 'Erro desconhecido ao buscar.');
            }
        } catch (err: any) {
            setSearchedBike(null);
            setError(err.message || 'Falha na comunicação com o servidor.');
        } finally {
            setIsSearching(false);
        }
    };



    

    

    const handleRecolherClick = async (bikeNumber: string) => {
        if (processingBikes.has(bikeNumber)) return;
        
        setIsLoading(true); 
        setProcessingBikes(prev => new Set(prev).add(bikeNumber));

        // Apenas inicia a consulta, sem remover do roteiro
        handleSearch(bikeNumber); 

        setIsLoading(false);
        setProcessingBikes(prev => {
            const next = new Set(prev);
            next.delete(bikeNumber);
            return next;
        });
    };

    const handleNaoAtendidaClick = async (bikeNumber: string, silent = false) => {
        // Salva o estado original para rollback
        const originalRouteBikes = [...routeBikes];
        isUpdatingStateRef.current = true;
        if (!silent) setIsLoading(true);

        // ATUALIZAÇÃO OTIMISTA: Remove a bike da rota na UI imediatamente
        const newRouteBikes = routeBikes.filter(b => b !== bikeNumber);
        setRouteBikes(newRouteBikes);
        if (!silent) {
            alert(`Bicicleta ${bikeNumber} registrada como "Não atendida".`);
        }

        // Tenta sincronizar com o backend em segundo plano
        try {
            const result = await apiCall({ 
                action: 'finalizeRouteBike', 
                driverName, 
                bikeNumber, 
                finalStatus: 'Não atendida', 
                finalObservation: '',
                routeBikes: newRouteBikes,
                collectedBikes
            });

            if (!result.success) throw new Error(result.error || 'Falha ao registrar no relatório.');

            // Se tudo deu certo, a UI já está correta.

        } catch (err: any) {
            // ROLLBACK: Se qualquer chamada falhar, restaura o estado original
            if (!silent) {
                setError(`Falha ao processar "Não atendida" para a bike ${bikeNumber}. Restaurando.`);
            }
            setRouteBikes(originalRouteBikes);
            if (silent) throw err; // Repassa o erro se estiver no modo silencioso
        } finally {
            isUpdatingStateRef.current = false;
            if (!silent) setIsLoading(false);
        }
    };

    const handleCollectedBikeAction = (bikeNumber: string, status: string) => {
        if (status === 'Enviada para Estação') {
            setDestinationModal({ isOpen: true, bikeNumber, type: 'Estação', stationName: 'Buscando...' });
            
            // Busca localização e estação mais próxima em background para não travar a abertura do modal
            (async () => {
                try {
                    const userLocation = await getCurrentPosition();
                    const closestStation = stations.reduce((prev, curr) => {
                        const dist = getDistanceInMeters(userLocation.latitude, userLocation.longitude, curr.Latitude, curr.Longitude);
                        return (dist < prev.minDistance) ? { station: curr, minDistance: dist } : prev;
                    }, { station: null, minDistance: Infinity });

                    const stationName = (closestStation.station && closestStation.minDistance <= 50) ? closestStation.station.Name : 'Fora da Estação';
                    setDestinationModal(prev => {
                        if (prev.isOpen && prev.bikeNumber === bikeNumber) {
                            return { ...prev, stationName };
                        }
                        return prev;
                    });
                } catch {
                    setDestinationModal(prev => {
                        if (prev.isOpen && prev.bikeNumber === bikeNumber) {
                            return { ...prev, stationName: 'Fora da Estação' };
                        }
                        return prev;
                    });
                }
            })();
        } else if (status === 'Enviada para Filial') {
            setDestinationModal({ isOpen: true, bikeNumber, type: 'Filial' });
        } else if (status === 'Vandalizada') {
            setDestinationModal({ isOpen: true, bikeNumber, type: 'Vandalizada' });
        }
    };

    const executeCollectedBikeAction = async (bikeNumber: string, status: string, observation: string) => {
        if (processingBikes.has(bikeNumber)) return;
        
        // VALIDAÇÃO CRÍTICA: Verifica se a bike ainda está na posse antes de agir
        if (!collectedBikes.includes(bikeNumber)) {
            alert(`Erro: A bicicleta ${bikeNumber} não está mais em sua posse.`);
            setDestinationModal(prev => ({ ...prev, isOpen: false }));
            return;
        }

        setDestinationModal(prev => ({ ...prev, isOpen: false }));
        isUpdatingStateRef.current = true;
        setProcessingBikes(prev => new Set(prev).add(bikeNumber));
        
        // Salva o estado original para rollback
        const originalCollectedBikes = [...collectedBikes];

        // ATUALIZAÇÃO OTIMISTA: Remove a bike da lista na UI imediatamente
        const newCollectedBikes = collectedBikes.filter(b => b !== bikeNumber);
        setCollectedBikes(newCollectedBikes);

        try {
            let finalStatus = status;
            let finalObservation = observation;

            if (status === 'Enviada para Estação') {
                finalStatus = 'ESTAÇÃO'; 
                finalObservation = observation; 
            } else if (status === 'Enviada para Filial') {
                finalStatus = 'Filial';
                finalObservation = observation; 
            } else if (status === 'Vandalizada') {
                finalStatus = 'Vandalizada';
                finalObservation = observation; 
            }

            apiCall({ 
                action: 'finalizeCollectedBike', 
                driverName, 
                bikeNumber, 
                finalStatus, 
                finalObservation,
                routeBikes, 
                collectedBikes: newCollectedBikes 
            }).then(result => {
                if (result.success) {
                    refreshAll(true);
                } else {
                    setError(`Falha ao registrar "${status}" para a bike ${bikeNumber}.`);
                    setCollectedBikes(originalCollectedBikes);
                }
            }).catch(() => {
                setError(`Erro de conexão ao registrar "${status}" para a bike ${bikeNumber}.`);
                setCollectedBikes(originalCollectedBikes);
            }).finally(() => {
                isUpdatingStateRef.current = false;
                setProcessingBikes(prev => {
                    const next = new Set(prev);
                    next.delete(bikeNumber);
                    return next;
                });
            });

        } catch (err: any) {
            console.error(err);
            setError(`Erro ao processar: ${err.message}`);
            setCollectedBikes(originalCollectedBikes);
            isUpdatingStateRef.current = false;
            setProcessingBikes(prev => {
                const next = new Set(prev);
                next.delete(bikeNumber);
                return next;
            });
        }
    };

    // Função para calcular a distância entre duas coordenadas em metros (Haversine)
    const getDistanceInMeters = (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const nLat1 = normalizeCoord(lat1);
        const nLon1 = normalizeCoord(lon1);
        const nLat2 = normalizeCoord(lat2);
        const nLon2 = normalizeCoord(lon2);

        const R = 6371e3; // Raio da Terra em metros
        const φ1 = nLat1 * Math.PI / 180;
        const φ2 = nLat2 * Math.PI / 180;
        const Δφ = (nLat2 - nLat1) * Math.PI / 180;
        const Δλ = (nLon2 - nLon1) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                  Math.cos(φ1) * Math.cos(φ2) *
                  Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c; // Distância em metros
    };



    

    useEffect(() => {
        // Detalhes do roteiro agora são atualizados via refreshAll (sync)
    }, [routeBikes, collectedBikes, driverName]);

    const sortedRouteBikes = useMemo(() => {
        if (!currentDriverLocation || routeBikes.length === 0) return routeBikes;
        
        return [...routeBikes].sort((a, b) => {
            // Se tivermos distâncias do Google Maps, usamos elas para ordenar
            if (routeDistances[a] && routeDistances[b]) {
                return routeDistances[a].value - routeDistances[b].value;
            }

            const detailsA = routeBikesDetails[a];
            const detailsB = routeBikesDetails[b];
            
            if (!detailsA || !detailsB) return 0;
            if (detailsA.currentLat === null || detailsA.currentLng === null) return 1;
            if (detailsB.currentLat === null || detailsB.currentLng === null) return -1;
            
            const distA = calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, detailsA.currentLat, detailsA.currentLng);
            const distB = calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, detailsB.currentLat, detailsB.currentLng);
            
            return distA - distB;
        });
    }, [routeBikes, routeBikesDetails, currentDriverLocation, routeDistances]);

    const fetchStations = async () => {
        try {
            const result = await apiGetCall('getStations');
            if (result.success && result.data) {
                setStations(result.data);
            }
        } catch (err: any) {
            console.error('Erro ao buscar estações:', err.message);
        }
    };

    const refreshAll = React.useCallback(async (force = false) => {
        if (!force && (document.visibilityState === 'hidden' || isUpdatingStateRef.current)) return;
        
        setIsSyncing(true);
        if (category.includes('ADM')) {
            setIsSummaryLoading(true);
            setIsAlertsLoading(true);
            setIsVandalizedLoading(true);
            setIsStatusLoading(true);
        }
        try {
            const result = await apiCall({ 
                action: 'sync', 
                driverName, 
                category, 
                summaryTimeRange, 
                statusTimeRange 
            }, 2); // Aumentado para 2 retries para maior resiliência

            if (result.success && result.data) {
                const d = result.data;
                
                // 1. Requests
                if (d.requests) setPendingRequests(d.requests);
                
                // 2. Driver State
                if (d.driverState && !isUpdatingStateRef.current) {
                    setRouteBikes(d.driverState.routeBikes || []);
                    setCollectedBikes(d.driverState.collectedBikes || []);
                }
                
                // 3. Bike Statuses (Conflicts)
                if (d.bikeStatuses) setBikeConflicts(d.bikeStatuses);
                
                // 4. Schedule
                if (d.schedule) setUserSchedule(d.schedule);
                
                // 5. Motoristas
                if (d.motoristas) setMotoristas(d.motoristas);
                
                // 6. Driver Locations
                if (d.driverLocations) setDriverLocations(d.driverLocations);
                
                // 11. Bike Details (Route and Collected)
                if (d.bikeDetails) {
                    const details = d.bikeDetails;
                    const routeDetails: Record<string, any> = {};
                    const collectedDetails: Record<string, any> = {};
                    
                    (d.driverState?.routeBikes || []).forEach((b: string) => {
                        if (details[b]) routeDetails[b] = details[b];
                    });
                    (d.driverState?.collectedBikes || []).forEach((b: string) => {
                        if (details[b]) collectedDetails[b] = details[b];
                    });
                    
                    setRouteBikesDetails(prev => {
                        const next = { ...routeDetails };
                        Object.keys(next).forEach(id => {
                            if (prev[id] && prev[id].initialLat !== null) {
                                next[id].initialLat = prev[id].initialLat;
                                next[id].initialLng = prev[id].initialLng;
                            }
                        });
                        return next;
                    });
                    setCollectedBikesDetails(collectedDetails);
                }
                
                if (category.includes('ADM')) {
                    // 7. Drivers Summary
                    if (d.driversSummary) setDriversSummary(d.driversSummary);
                    
                    // 8. Alerts
                    if (d.alerts) setAlerts(d.alerts);
                    
                    // 9. Vandalized
                    if (d.vandalized) setVandalizedBikes(d.vandalized);
                    
                    // 10. Change Status Data
                    if (d.changeStatusData) setChangeStatusData(d.changeStatusData);

                    // 12. Admin Alerts
                    if (d.adminAlerts) {
                        const newCount = d.adminAlerts.length;
                        setAlertCount(newCount);
                        if (newCount > lastViewedAlertCount) {
                            setHasNewAlerts(true);
                        }
                    }
                }

                if (result.version) setBackendVersion(result.version);
                setLastSyncTime(new Date().toLocaleTimeString());
            } else {
                setError(result.error || 'Falha na sincronização de dados.');
            }
        } catch (err: any) {
            console.error("Erro na atualização automática:", err);
            // Se o erro for "Ação desconhecida", o backend ainda não foi atualizado
            if (err.message && err.message.includes('Ação desconhecida')) {
                console.warn("Backend não suporta 'sync'. Usando modo legado.");
                // Fallback para o modo antigo se necessário (opcional, mas bom para transição)
            }
        } finally {
            setIsSyncing(false);
            if (category.includes('ADM')) {
                setIsSummaryLoading(false);
                setIsAlertsLoading(false);
                setIsVandalizedLoading(false);
                setIsStatusLoading(false);
            }
        }
    }, [driverName, category, summaryTimeRange, statusTimeRange]);

    useEffect(() => {
        refreshAll();
        fetchStations(); // Estações mudam pouco, busca uma vez

        // ATUALIZAÇÃO: Intervalo aumentado de 3s para 10s para reduzir carga no servidor
        const interval = setInterval(() => refreshAll(), 30000); 

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                refreshAll();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            clearInterval(interval);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [refreshAll]);

    useEffect(() => {
        if (category.toUpperCase() !== 'MOTORISTA') {
            return;
        }

        if (!navigator.geolocation) {
            setGpsError("Seu navegador não suporta geolocalização.");
            return;
        }

        const watchId = navigator.geolocation.watchPosition(
            (position) => {
                const { latitude, longitude } = position.coords;
                setGpsError(null);
                setCurrentDriverLocation({ lat: latitude, lng: longitude });
                
                // OTIMIZAÇÃO: Throttle de 10 segundos E verificação de distância (mínimo 10 metros)
                const now = Date.now();
                const lastPos = lastLocationRef.current;
                
                let shouldUpdate = false;
                if (now - lastLocationUpdateRef.current > 10000) {
                    if (!lastPos) {
                        shouldUpdate = true;
                    } else {
                        // Calcula distância em metros
                        const R = 6371e3; // raio da terra em metros
                        const φ1 = latitude * Math.PI/180;
                        const φ2 = lastPos.lat * Math.PI/180;
                        const Δφ = (lastPos.lat - latitude) * Math.PI/180;
                        const Δλ = (lastPos.lng - longitude) * Math.PI/180;

                        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                                Math.cos(φ1) * Math.cos(φ2) *
                                Math.sin(Δλ/2) * Math.sin(Δλ/2);
                        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                        const distance = R * c;

                        if (distance > 10) { // 10 metros
                            shouldUpdate = true;
                        }
                    }
                }

                if (shouldUpdate) {
                    lastLocationUpdateRef.current = now;
                    lastLocationRef.current = { lat: latitude, lng: longitude };
                    apiGetCall('updateLocation', {
                        driverName,
                        latitude: latitude.toFixed(6),
                        longitude: longitude.toFixed(6)
                    }).catch(err => console.error("Falha ao atualizar a localização:", err));
                }
            },
            (err) => {
                console.warn(`Erro de Geolocalização (${err.code}): ${err.message}`);
                if (err.code === err.PERMISSION_DENIED) {
                    setGpsError("Acesso ao GPS negado. O uso do aplicativo requer localização ativa.");
                } else if (err.code === err.POSITION_UNAVAILABLE) {
                    setGpsError("Informação de localização indisponível. Verifique se o GPS está ligado.");
                } else if (err.code === err.TIMEOUT) {
                    // Timeout não bloqueia o app imediatamente se já tivermos uma posição, 
                    // mas se for persistente pode ser um problema.
                    console.log("Timeout ao obter localização.");
                }
            },
            { 
                enableHighAccuracy: true, 
                timeout: 15000, 
                maximumAge: 0 
            }
        );

        return () => {
            navigator.geolocation.clearWatch(watchId);
        };
    }, [driverName, category]);

    // Efeito para calcular distâncias via Haversine (Gratuito)
    useEffect(() => {
        if (!currentDriverLocation || routeBikes.length === 0) return;

        const newDistances: Record<string, any> = {};
        
        routeBikes.forEach(bikeId => {
            const details = routeBikesDetails[bikeId];
            if (details && details.currentLat !== null && details.currentLng !== null) {
                const distKm = calculateDistance(
                    currentDriverLocation.lat, 
                    currentDriverLocation.lng, 
                    details.currentLat, 
                    details.currentLng
                );
                
                newDistances[bikeId] = {
                    distance: distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`,
                    duration: `~${Math.round(distKm * 3)} min`, // Estimativa simples: 3 min por km
                    value: distKm * 1000
                };
            }
        });
        
        setRouteDistances(newDistances);
    }, [currentDriverLocation, routeBikes, routeBikesDetails]);

    const renderLocationWithMap = (location: string) => {
        if (!location) return null;
        
        // Tenta encontrar um padrão de coordenadas (lat, lng)
        const coordsMatch = location.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
        
        if (coordsMatch) {
            const lat = coordsMatch[1].replace(',', '.');
            const lng = coordsMatch[2].replace(',', '.');
            const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
            
            return (
                <div className="flex flex-col gap-2 mt-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-700">Local:</span>
                        <a 
                            href={mapsUrl} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-2 py-1 bg-blue-50 text-blue-600 rounded border border-blue-100 text-[10px] font-bold hover:bg-blue-100 transition-colors shadow-sm"
                            title="Abrir no Google Maps"
                        >
                            <MapIcon className="w-3 h-3" />
                            Ver no Mapa
                        </a>
                    </div>
                </div>
            );
        }
        
        return <p className="text-sm text-gray-700 break-all"><span className="font-semibold">Local:</span> {location}</p>;
    };


    if (gpsError) {
        return (
            <div className="fixed inset-0 bg-white z-[9999] flex flex-col items-center justify-center p-6 text-center">
                <AlertTriangleIcon className="w-16 h-16 text-red-500 mb-4" />
                <h1 className="text-2xl font-bold text-gray-900 mb-2">GPS Obrigatório</h1>
                <p className="text-gray-600 mb-6 max-w-xs">
                    {gpsError}
                    <br /><br />
                    O Move Bikes requer localização ativa para funcionar. Por favor, ative o GPS e conceda permissão de localização.
                </p>
                <button 
                    onClick={() => window.location.reload()}
                    className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 active:scale-95 transition-all"
                >
                    Tentar Novamente
                </button>
            </div>
        );
    }

    return (
        <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg w-full max-w-4xl mx-auto animate-fade-in-down">
            <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 pb-4 border-b">
                <div className="flex items-center gap-3">
                    <div>
                        <p className="font-bold text-base text-gray-800 leading-tight">{driverName}</p>
                        <div className="flex items-center gap-2">
                            <p className="text-xs text-gray-600 uppercase tracking-wider">{category}</p>
                            <span className="text-[10px] text-gray-400 flex items-center gap-1">
                                <span className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-blue-500 animate-pulse' : 'bg-green-500'}`}></span>
                                {lastSyncTime}
                            </span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center flex-wrap gap-1 mt-4 sm:mt-0">
                    <button onClick={() => setRequestModalOpen(true)} disabled={isLoading} title="Nova Solicitação" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50">
                        <PlusIcon className="w-6 h-6 sm:w-7 sm:h-7"/>
                    </button>
                    <button onClick={() => setRouteModalOpen(true)} disabled={isLoading} title="Criar Roteiro" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50">
                        <PlusPlusIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                    </button>
                    <button onClick={() => setTrailerModalOpen(true)} disabled={isLoading} title="Carretinha" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50">
                        <TrailerIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                    </button>
                    <button 
                        onClick={() => {
                            setIsAdminAlertsOpen(true);
                            setHasNewAlerts(false);
                            setAlertCount(0);
                            setLastViewedAlertCount(alertCount);
                        }} 
                        disabled={isLoading} 
                        title="Alertas de Divergência" 
                        className={`p-1.5 sm:p-2 rounded-full transition-colors relative disabled:opacity-50 ${
                            hasNewAlerts && alertCount > 0 
                                ? 'text-red-600 bg-red-50 animate-pulse' 
                                : 'text-gray-500 hover:bg-gray-100 hover:text-red-600'
                        }`}
                    >
                        <AlertTriangleIcon className={`w-6 h-6 sm:w-7 sm:h-7 ${hasNewAlerts && alertCount > 0 ? 'animate-bounce' : ''}`}/>
                        {alertCount > 0 && (
                            <span className="absolute top-0 right-0 bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full border-2 border-white">
                                {alertCount}
                            </span>
                        )}
                    </button>
                            {category.includes('ADM') && (
                                <button onClick={onShowMap} disabled={isLoading} title="Ver Mapa em Tempo Real" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50">
                                    <MapIcon className="w-6 h-6 sm:w-7 sm:h-7"/>
                                </button>
                            )}
                            {category.toUpperCase() === 'MOTORISTA' && (
                                <button onClick={() => setIsVehicleModalOpen(true)} disabled={isLoading} title="Trocar Veículo" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50">
                                    <RefreshIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                                </button>
                            )}
                            {category.toUpperCase() === 'MOTORISTA' && (
                                <button onClick={() => { fetchSchedule(); setIsScheduleModalOpen(true); }} disabled={isLoading} title="Minha Escala" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50">
                                    <CalendarIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                                </button>
                            )}
                            {!category.includes('ADM') && (
                                <button 
                                    onClick={() => window.open('https://docs.google.com/forms/d/e/1FAIpQLSdYtWC_KKixt9gWwZG_Q6hyaD2QCvv-_ilOfhtUVJiF5EevSQ/viewform', '_blank')} 
                                    disabled={isLoading}
                                    title="Formulário Veículo" 
                                    className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50"
                                >
                                    <CarIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                                </button>
                            )}
                     {!category.includes('ADM') && (
                        <button onClick={() => setReportModalOpen(true)} disabled={isLoading} title="Gerar Relatório" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50">
                            <SheetIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                        </button>
                     )}
                    <button 
                        onClick={() => { fetchReporData(); setIsReporModalOpen(true); }}
                        disabled={isLoading}
                        className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-blue-600 transition-colors disabled:opacity-50"
                        title="Estações Livres"
                    >
                        <BicycleIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                    </button>
                    <button onClick={onLogout} disabled={isLoading} title="Sair" className="p-1.5 sm:p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-red-600 transition-colors disabled:opacity-50">
                        <LogoutIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                    </button>
                </div>
            </header>
            
            <main>
                {!category.includes('ADM') && (
                    <div className="mb-4 p-3 border rounded-lg bg-gray-50">
                        <h2 className="text-base font-medium text-gray-700 mb-2">Consultar Bicicleta</h2>
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center gap-2">
                                <div className="relative flex-grow">
                                    <input 
                                        type="text" 
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        placeholder="Digite o patrimônio..."
                                        className="w-full p-1.5 pr-8 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-sm"
                                    />
                                    {searchTerm && (
                                        <button 
                                            onClick={() => { setSearchTerm(''); handleSearch(''); }}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                                            title="Limpar busca"
                                        >
                                            <XIcon className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                                <button 
                                    onClick={() => isScannerOpen ? stopScanner() : startScanner()}
                                    className={`p-1.5 rounded-md border transition-all ${isScannerOpen ? 'bg-red-50 border-red-200 text-red-600' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                                    title={isScannerOpen ? "Fechar Scanner" : "Ler QR Code"}
                                >
                                    <QrCodeIcon className="w-5 h-5" />
                                </button>
                                <button 
                                    onClick={() => handleSearch()}
                                    disabled={isSearching || isScannerOpen}
                                    className="px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 active:scale-95 transition-all disabled:bg-gray-400 flex items-center gap-2 text-sm"
                                >
                                    {isSearching ? 
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> : 
                                        <SearchIcon className="w-4 h-4" />
                                    }
                                    <span>{isSearching ? 'Buscando...' : 'Consultar'}</span>
                                </button>
                            </div>

                            {isScannerOpen && (
                                <div className="relative overflow-hidden rounded-lg bg-black aspect-square max-w-[300px] mx-auto w-full border-2 border-blue-500 shadow-xl animate-fade-in">
                                    <div id="qr-reader" className="w-full h-full"></div>
                                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                                        <div className="w-48 h-48 border-2 border-blue-400/50 rounded-lg"></div>
                                    </div>
                                    <button 
                                        onClick={stopScanner}
                                        className="absolute top-2 right-2 bg-black/50 text-white p-1 rounded-full hover:bg-black/70"
                                    >
                                        <XIcon className="w-4 h-4" />
                                    </button>
                                    <p className="absolute bottom-2 left-0 right-0 text-center text-[10px] text-white bg-black/50 py-1">
                                        Aponte para o QR Code da bicicleta
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {error && <div className="text-red-600 bg-red-100 p-3 rounded-md text-sm mb-4">{error}</div>}

                {!category.includes('ADM') && searchedBike && (
                    <div className="p-4 border rounded-lg bg-green-50 animate-fade-in-down relative">
                        <button 
                            onClick={() => { setSearchedBike(null); setSearchTerm(''); }}
                            className="absolute top-2 right-2 p-1 text-green-700 hover:bg-green-100 rounded-full transition-colors"
                            title="Fechar consulta"
                        >
                            <XIcon className="w-5 h-5" />
                        </button>
                        <h3 className="text-lg font-semibold text-green-800 mb-3">Resultado da Consulta</h3>
                        
                        {collectedBikes.includes(String(searchedBike['Patrimônio'])) && (
                            <div className="mb-3 p-2 bg-yellow-100 border border-yellow-400 text-yellow-800 text-[10px] font-bold rounded flex items-center gap-2">
                                <AlertTriangleIcon className="w-4 h-4" />
                                <span>ATENÇÃO: Você já está em posse desta bicicleta.</span>
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                            <div>
                                <p className="font-semibold text-gray-500 text-xs uppercase">Status</p>
                                <p className="text-gray-800 font-medium">{searchedBike['Status']}</p>
                            </div>
                            <div>
                                <p className="font-semibold text-gray-500 text-xs uppercase">Coordenadas</p>
                                <a 
                                    href={`https://www.google.com/maps/search/?api=1&query=${formatCoordinate(searchedBike['Latitude'])},${formatCoordinate(searchedBike['Longitude'])}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline font-medium truncate block"
                                >
                                    {`${formatCoordinate(searchedBike['Latitude'])}, ${formatCoordinate(searchedBike['Longitude'])}`}
                                </a>
                            </div>
                            <div>
                                <p className="font-semibold text-gray-500 text-xs uppercase">Bateria</p>
                                <p className="text-gray-800 font-medium">{formatBattery(searchedBike['Bateria'])}%</p>
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
                                <p className="font-semibold text-gray-500 text-xs uppercase">Última Info</p>
                                <p className={`font-medium ${formatLastInfo(searchedBike['Última informação da posição']).color}`}>{formatLastInfo(searchedBike['Última informação da posição']).text}</p>
                            </div>
                        </div>
                        <div className="mt-4 pt-4 border-t border-green-200 grid grid-cols-2 gap-2">
                            <button 
                                onClick={() => handleStatusUpdate('Recolhida')} 
                                disabled={isLoading || isSearching}
                                className="px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm w-full disabled:bg-gray-400"
                            >
                                Recolhida
                            </button>
                            <button 
                                onClick={() => handleStatusUpdate('Não encontrada')} 
                                disabled={isLoading || isSearching}
                                className="px-3 py-1.5 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm w-full disabled:bg-gray-400"
                            >
                                Não Encontrada
                            </button>
                        </div>
                    </div>
                )}

                <div className="mt-6 p-4 border rounded-lg bg-gray-50">
                    <div className="flex justify-between items-center mb-3">
                        <h2 className="text-lg font-semibold text-gray-700">Notificações Pendentes</h2>
                        <button 
                            onClick={handleOpenHistory}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-xs font-bold text-gray-600 hover:bg-gray-50 hover:text-blue-600 transition-all shadow-sm"
                        >
                            <CalendarIcon className="w-3.5 h-3.5" />
                            Ver Histórico
                        </button>
                    </div>
                    {pendingRequests.length > 0 ? (
                        <ul className="space-y-3">
                            {pendingRequests.map(req => (
                                <li key={req.id} className="p-3 bg-white border rounded-md shadow-sm flex justify-between items-start gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            <p className="font-bold text-blue-600">Bicicleta: {req.bikeNumber}</p>
                                            {renderConflictIcon(req.bikeNumber)}
                                        </div>
                                        <p className="text-sm text-gray-700 mb-1"><span className="font-semibold">Motivo:</span> {req.reason}</p>
                                        {renderLocationWithMap(req.location)}
                                    </div>
                                    <div className="flex flex-col gap-4 items-end pt-1">
                                        <button onClick={() => handleAcceptRequest(req.id, req.bikeNumber, req.reason)} disabled={isLoading} className="text-green-600 hover:text-green-700 text-sm font-bold disabled:text-gray-400 transition-colors">Aceitar</button>
                                        <button onClick={() => handleDeclineRequest(req.id)} disabled={isLoading} className="text-red-600 hover:text-red-700 text-sm font-bold disabled:text-gray-400 transition-colors">Recusar</button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-gray-500">Nenhuma notificação pendente no momento.</p>
                    )}
                </div>

                {category.includes('ADM') && (
                    <div className="mt-6 overflow-hidden">
                        <div className="flex justify-between items-center mb-2 px-1">
                            <div className="flex gap-2">
                                <button 
                                    onClick={() => setActiveQuadrant('summary')}
                                    className={`p-2 rounded-full transition-all flex items-center justify-center ${activeQuadrant === 'summary' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-200 text-gray-500'}`}
                                    title="Resumo Motoristas"
                                >
                                    <UserIcon className="w-5 h-5" />
                                </button>
                                <button 
                                    onClick={() => setActiveQuadrant('alerts')}
                                    className={`p-2 rounded-full transition-all flex items-center justify-center ${activeQuadrant === 'alerts' ? 'bg-red-600 text-white shadow-md' : 'bg-gray-200 text-gray-500'}`}
                                    title="Bikes em Alerta"
                                >
                                    <AlertIcon className="w-5 h-5" />
                                </button>
                                <button 
                                    onClick={() => setActiveQuadrant('vandalized')}
                                    className={`p-2 rounded-full transition-all flex items-center justify-center ${activeQuadrant === 'vandalized' ? 'bg-orange-600 text-white shadow-md' : 'bg-gray-200 text-gray-500'}`}
                                    title="Bikes Vandalizadas"
                                >
                                    <AlertTriangleIcon className="w-5 h-5" />
                                </button>
                                <button 
                                    onClick={() => setActiveQuadrant('status')}
                                    className={`p-2 rounded-full transition-all flex items-center justify-center ${activeQuadrant === 'status' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-200 text-gray-500'}`}
                                    title="Alterar status"
                                >
                                    <PlusPlusIcon className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <div className="relative w-full overflow-hidden rounded-lg border bg-gray-50 shadow-inner min-h-[400px]">
                            <div 
                                className="flex transition-transform duration-500 ease-in-out"
                                style={{ transform: `translateX(${activeQuadrant === 'summary' ? '0%' : activeQuadrant === 'alerts' ? '-100%' : activeQuadrant === 'vandalized' ? '-200%' : '-300%'})` }}
                            >
                                {/* Quadrante 1: Resumo Analítico */}
                                <div className="w-full flex-shrink-0 p-3">
                                    <div className="flex flex-col gap-2 mb-4">
                                        <div className="flex justify-between items-start">
                                            <div className="flex flex-col">
                                                <h2 className="text-base font-bold text-gray-700 flex items-center gap-2">
                                                    <SheetIcon className={`w-4 h-4 ${isSummaryLoading ? 'animate-pulse text-blue-400' : 'text-blue-600'}`} />
                                                    Analítico
                                                    {isSummaryLoading && <span className="text-[10px] font-normal text-gray-400 ml-2">(Atualizando...)</span>}
                                                </h2>
                                                {backendVersion && (
                                                    <span className="text-[9px] text-gray-400 font-mono ml-6">Backend: v{backendVersion}</span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex justify-end">
                                            <div className="flex bg-white border rounded-md p-0.5 shadow-sm">
                                                {(['day', 'week', 'month'] as const).map((range) => (
                                                    <button
                                                        key={range}
                                                        onClick={() => setSummaryTimeRange(range)}
                                                        className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded transition-colors ${
                                                            summaryTimeRange === range
                                                                ? 'bg-blue-600 text-white'
                                                                : 'text-gray-500 hover:bg-gray-100'
                                                        }`}
                                                    >
                                                        {range === 'day' ? 'Dia' : range === 'week' ? 'Semana' : 'Mês'}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    {driversSummary.length > 0 ? (
                                        <div className="grid grid-cols-1 gap-3">
                                            {driversSummary.map(driver => (
                                                <div key={driver.name} className="bg-white p-3 rounded-lg border shadow-sm">
                                                    <div className="flex justify-between items-center mb-2 border-b pb-1">
                                                        <h3 className="font-black text-gray-900 text-sm uppercase">
                                                            {driver.name}
                                                        </h3>
                                                        <button 
                                                            onClick={() => { setEditingDriver(driver); setIsEditDriverModalOpen(true); }}
                                                            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-full transition-colors"
                                                            title="Editar bikes do motorista"
                                                        >
                                                            <SearchIcon className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                    <div className="grid grid-cols-5 gap-1.5 mb-3">
                                                        <div className="bg-blue-50 p-1.5 rounded border border-blue-100 text-center">
                                                            <p className="text-[8px] text-blue-600 font-black uppercase leading-tight">Notif.</p>
                                                            <p className="text-sm font-black text-blue-800">{driver.pendingRequests}</p>
                                                        </div>
                                                        <div className="bg-green-50 p-1.5 rounded border border-green-100 text-center">
                                                            <p className="text-[8px] text-green-600 font-black uppercase leading-tight">Recolh.</p>
                                                            <p className="text-sm font-black text-green-800">{driver.stats.recolhidas}</p>
                                                        </div>
                                                        <div className="bg-indigo-50 p-1.5 rounded border border-indigo-100 text-center">
                                                            <p className="text-[8px] text-indigo-600 font-black uppercase leading-tight">Remanej.</p>
                                                            <p className="text-sm font-black text-indigo-800">{driver.stats.remanejada}</p>
                                                        </div>
                                                        <div className="bg-red-50 p-1.5 rounded border border-red-100 text-center">
                                                            <p className="text-[8px] text-red-600 font-black uppercase leading-tight">Não Enc.</p>
                                                            <p className="text-sm font-black text-red-800">{driver.stats.naoEncontrada}</p>
                                                        </div>
                                                        <div className="bg-orange-50 p-1.5 rounded border border-orange-100 text-center">
                                                            <p className="text-[8px] text-orange-600 font-black uppercase leading-tight">Não Atend.</p>
                                                            <p className="text-sm font-black text-orange-800">{driver.stats.naoAtendida || 0}</p>
                                                        </div>
                                                    </div>
                                                    <div className="mb-2">
                                                        <p className="text-[9px] font-black text-gray-500 uppercase mb-1 flex items-center gap-1">
                                                            <BicycleIcon className="w-2.5 h-2.5" />
                                                            Bikes em Posse ({driver.realTime.collected.length})
                                                        </p>
                                                        {driver.realTime.collected.length > 0 ? (
                                                            <div className="flex flex-wrap gap-1">
                                                                {driver.realTime.collected.map((bike: string) => (
                                                                    <span key={bike} className="px-1.5 py-0.5 bg-gray-50 text-gray-700 rounded text-[10px] font-mono border border-gray-200">
                                                                        {bike}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <p className="text-[9px] text-gray-400 italic">Nenhuma bike recolhida</p>
                                                        )}
                                                    </div>
                                                    <div>
                                                        <p className="text-[9px] font-black text-gray-500 uppercase mb-1 flex items-center gap-1">
                                                            <MapIcon className="w-2.5 h-2.5" />
                                                            Roteiro Atual ({driver.realTime.route.length})
                                                        </p>
                                                        {driver.realTime.route.length > 0 ? (
                                                            <div className="flex flex-wrap gap-1">
                                                                {driver.realTime.route.map((bike: string) => (
                                                                    <span key={bike} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px] font-mono border border-blue-100">
                                                                        {bike}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <p className="text-[9px] text-gray-400 italic">Roteiro vazio</p>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-center py-6 bg-white rounded-lg border border-dashed">
                                            <p className="text-gray-400 text-xs">Carregando resumo...</p>
                                        </div>
                                    )}
                                </div>

                                {/* Quadrante 2: Bikes em Alerta */}
                                <div className="w-full flex-shrink-0 p-3">
                                    <div className="flex justify-between items-center mb-4">
                                        <h2 className="text-base font-bold text-gray-700 flex items-center gap-2">
                                            <AlertIcon className="w-4 h-4 text-red-600" />
                                            Bikes em Alerta
                                        </h2>
                                    </div>

                                    <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
                                        <table className="w-full text-left border-collapse">
                                            <thead>
                                                <tr className="bg-gray-100 border-b">
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase">Patrimônio</th>
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase text-center">Check 1</th>
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase text-center">Check 2</th>
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase text-center">Check 3</th>
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase text-center">Ação</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {alerts.length > 0 ? (
                                                    alerts.map((alert) => (
                                                        <tr key={alert.id} className="border-b hover:bg-gray-50 transition-colors">
                                                            <td className="p-2 font-mono text-xs font-bold text-gray-700">{alert.patrimonio}</td>
                                                            <td className="p-2 text-center">
                                                                <input type="checkbox" checked={!!alert.check1} readOnly className="w-4 h-4 text-blue-600 rounded border-gray-300" />
                                                            </td>
                                                            <td className="p-2 text-center">
                                                                <input type="checkbox" checked={!!alert.check2} readOnly className="w-4 h-4 text-blue-600 rounded border-gray-300" />
                                                            </td>
                                                            <td className="p-2 text-center">
                                                                <input type="checkbox" checked={!!alert.check3} readOnly className="w-4 h-4 text-red-600 rounded border-gray-300" />
                                                            </td>
                                                            <td className="p-2 text-center">
                                                                {alert.situacao === 'Localizada' ? (
                                                                    <button 
                                                                        onClick={() => handleConfirmFound(alert.id)}
                                                                        disabled={isLoading}
                                                                        className="px-2 py-1 bg-green-600 text-white text-[10px] font-bold rounded hover:bg-green-700 transition-colors shadow-sm active:scale-95 disabled:bg-gray-400"
                                                                    >
                                                                        {isLoading ? '...' : 'Confirmar'}
                                                                    </button>
                                                                ) : (
                                                                    <span className="text-[10px] text-gray-400 italic">Pendente</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))
                                                ) : (
                                                    <tr>
                                                        <td colSpan={5} className="p-4 text-center text-gray-400 text-xs italic">
                                                            {isAlertsLoading ? 'Buscando alertas...' : 'Nenhuma bike em alerta no momento.'}
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                        <div className="p-4 text-center">
                                            <p className="text-[10px] text-gray-400 italic">Espaço criado para monitoramento de bikes críticas.</p>
                                        </div>
                                    </div>
                                </div>

                                {/* Quadrante 3: Bikes Vandalizadas */}
                                <div className="w-full flex-shrink-0 p-3">
                                    <div className="flex justify-between items-center mb-4">
                                        <h2 className="text-base font-bold text-gray-700 flex items-center gap-2">
                                            <AlertIcon className="w-4 h-4 text-orange-600" />
                                            Bikes Vandalizadas
                                        </h2>
                                    </div>

                                    <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
                                        <table className="w-full text-left border-collapse min-w-[500px]">
                                            <thead>
                                                <tr className="bg-gray-100 border-b">
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase">Patrimônio</th>
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase">Data</th>
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase">Defeito</th>
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase">Local</th>
                                                    <th className="p-2 text-[10px] font-black text-gray-600 uppercase text-center">Ação</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {vandalizedBikes.length > 0 ? (
                                                    vandalizedBikes.map((v) => (
                                                        <tr key={v.id} className="border-b hover:bg-gray-50 transition-colors">
                                                            <td className="p-2 font-mono text-xs font-bold text-gray-700">{v.patrimonio}</td>
                                                            <td className="p-2 text-[10px] text-gray-600">{new Date(v.data).toLocaleDateString()}</td>
                                                            <td className="p-2 text-[10px] text-gray-600">{v.defeito}</td>
                                                            <td className="p-2 text-[10px] text-gray-600">{v.local}</td>
                                                            <td className="p-2 text-center">
                                                                <button 
                                                                    onClick={() => handleConfirmVandalizedFound(v.id)}
                                                                    disabled={isLoading}
                                                                    className="px-2 py-1 bg-orange-600 text-white text-[10px] font-bold rounded hover:bg-orange-700 transition-colors disabled:bg-gray-400"
                                                                >
                                                                    {isLoading ? '...' : 'Encontrada'}
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    ))
                                                ) : (
                                                    <tr>
                                                        <td colSpan={5} className="p-4 text-center text-gray-400 text-xs italic">
                                                            {isVandalizedLoading ? 'Buscando vandalizadas...' : 'Nenhuma bike vandalizada no momento.'}
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                        <div className="p-4 text-center">
                                            <p className="text-[10px] text-gray-400 italic">Lista de bicicletas com danos reportados.</p>
                                        </div>
                                    </div>
                                </div>

                                {/* Quadrante 4: Alterar Status */}
                                <div className="min-w-full p-4">
                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                                        <div className="flex items-center gap-2">
                                            <BicycleIcon className="w-5 h-5 text-blue-600" />
                                            <h3 className="text-lg font-bold text-gray-800">Alterar Status</h3>
                                            {isStatusLoading && <span className="text-[10px] text-blue-500 animate-pulse">Sincronizando...</span>}
                                        </div>
                                        
                                        <div className="flex items-center gap-2 bg-white p-1 rounded-lg border shadow-sm">
                                            <span className="text-[10px] font-bold text-gray-400 uppercase ml-2">Período:</span>
                                            <select 
                                                value={statusTimeRange}
                                                onChange={(e) => setStatusTimeRange(e.target.value as any)}
                                                className="text-xs font-bold text-gray-600 bg-transparent border-none focus:ring-0 cursor-pointer py-1 pr-8"
                                            >
                                                <option value="24h">Últimas 24h</option>
                                                <option value="48h">Últimas 48h</option>
                                                <option value="72h">Últimas 72h</option>
                                                <option value="week">Última Semana</option>
                                            </select>
                                        </div>
                                    </div>
                                    
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {/* Vandalizadas */}
                                        <div className="bg-white p-3 rounded-lg border shadow-sm">
                                            <div className="flex justify-between items-center mb-2">
                                                <h4 className="text-sm font-bold text-orange-700 uppercase tracking-wider">Vandalizadas</h4>
                                                <button 
                                                    onClick={() => copyToClipboard(changeStatusData.vandalizadas)}
                                                    className="px-2 py-1 bg-gray-100 text-gray-600 text-[10px] font-bold rounded hover:bg-gray-200 transition-colors flex items-center gap-1"
                                                >
                                                    <SheetIcon className="w-3 h-3" /> Copiar Lista
                                                </button>
                                            </div>
                                            <div className="max-h-[200px] overflow-y-auto bg-gray-50 rounded p-2 border border-dashed">
                                                {changeStatusData.vandalizadas.length > 0 ? (
                                                    <p className="text-xs font-mono break-all text-gray-600 leading-relaxed">
                                                        {changeStatusData.vandalizadas.join(',')}
                                                    </p>
                                                ) : (
                                                    <p className="text-xs text-gray-400 italic text-center py-4">Nenhuma bike vandalizada.</p>
                                                )}
                                            </div>
                                        </div>
 
                                         {/* Filial */}
                                         <div className="bg-white p-3 rounded-lg border shadow-sm">
                                             <div className="flex justify-between items-center mb-2">
                                                 <h4 className="text-sm font-bold text-blue-700 uppercase tracking-wider">Filial</h4>
                                                 <button 
                                                     onClick={() => copyToClipboard(changeStatusData.filial)}
                                                     className="px-2 py-1 bg-gray-100 text-gray-600 text-[10px] font-bold rounded hover:bg-gray-200 transition-colors flex items-center gap-1"
                                                 >
                                                     <SheetIcon className="w-3 h-3" /> Copiar Lista
                                                 </button>
                                             </div>
                                             <div className="max-h-[200px] overflow-y-auto bg-gray-50 rounded p-2 border border-dashed">
                                                 {changeStatusData.filial.length > 0 ? (
                                                     <p className="text-xs font-mono break-all text-gray-600 leading-relaxed">
                                                        {changeStatusData.filial.join(',')}
                                                     </p>
                                                 ) : (
                                                     <p className="text-xs text-gray-400 italic text-center py-4">Nenhuma bike na filial.</p>
                                                 )}
                                             </div>
                                         </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {!category.includes('ADM') && (
                    <div className="mt-6 p-4 border rounded-lg bg-gray-50">
                        <div className="flex justify-between items-center mb-3">
                            <h2 className="text-lg font-semibold text-gray-700">Roteiro de Recolhas</h2>
                            
                        </div>
                        {routeBikes.length > 0 ? (
                            <ul className="space-y-2">
                                {sortedRouteBikes.map(bike => {
                                    const details = routeBikesDetails[bike];
                                    const movedDistanceMeters = details && details.currentLat && details.initialLat ? 
                                        getDistanceInMeters(details.initialLat, details.initialLng, details.currentLat, details.currentLng) : 0;
                                    
                                    const isMoving = movedDistanceMeters > 10;
                                    
                                    const distance = currentDriverLocation && details && details.currentLat ? 
                                        calculateDistance(currentDriverLocation.lat, currentDriverLocation.lng, details.currentLat, details.currentLng) : null;

                                    return (
                                        <li key={bike} className="p-3 bg-white border rounded-md flex flex-col gap-3">
                                            <div className="flex justify-between items-start">
                                                <div className="flex flex-col">
                                                    <div className="flex items-center gap-2">
                                                        <p className="font-mono text-gray-800 font-bold text-lg">{bike}</p>
                                                        {details?.battery !== undefined && (
                                                            <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 border-blue-500 text-[9px] font-bold text-blue-600 bg-white shadow-sm" title="Bateria">
                                                                {formatBattery(details.battery)}%
                                                            </div>
                                                        )}
                                                        {renderConflictIcon(bike)}
                                                        {isMoving && (
                                                            <div className="flex items-center gap-0.5 text-orange-500 animate-pulse" title={`Bike moveu ${movedDistanceMeters.toFixed(0)}m`}>
                                                                <MovingIcon className="w-3.5 h-3.5" />
                                                                {movedDistanceMeters > 100 && <MovingIcon className="w-3.5 h-3.5" />}
                                                                {movedDistanceMeters > 1000 && <MovingIcon className="w-3.5 h-3.5" />}
                                                                <span className="text-[10px] font-bold uppercase ml-1">
                                                                    Movendo ({movedDistanceMeters > 1000 ? `${(movedDistanceMeters/1000).toFixed(1)}km` : `${movedDistanceMeters.toFixed(0)}m`})
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                    {distance !== null && (
                                                        <div className="flex flex-col items-start">
                                                            <span className="text-[10px] font-bold text-blue-600">
                                                                {routeDistances[bike] ? routeDistances[bike].distance : `${distance.toFixed(2)} km`}
                                                            </span>
                                                            {routeDistances[bike] && (
                                                                <span className="text-[9px] text-gray-500">
                                                                    {routeDistances[bike].duration}
                                                                </span>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex gap-2 w-full">
                                                <button 
                                                    onClick={() => handleNaoAtendidaClick(bike)}
                                                    disabled={isLoading}
                                                    className="flex-1 px-2 py-2 bg-yellow-500 text-white rounded-md hover:bg-yellow-600 active:scale-95 transition-all disabled:bg-gray-400 text-[10px] font-bold uppercase"
                                                >
                                                    Não Atendida
                                                </button>
                                                <button 
                                                    onClick={() => handleRecolherClick(bike)}
                                                    disabled={isLoading}
                                                    className="flex-1 px-2 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 active:scale-95 transition-all disabled:bg-gray-400 text-[10px] font-bold uppercase"
                                                >
                                                    Recolher
                                                </button>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <p className="text-sm text-gray-500">Nenhuma bicicleta no seu roteiro no momento.</p>
                        )}
                    </div>
                )}

                {!category.includes('ADM') && (
                    <div className="mt-6 p-4 border rounded-lg bg-gray-50">
                        <h2 className="text-lg font-semibold text-gray-700 mb-3">Bikes Recolhidas</h2>
                        {sortedCollectedBikes.length > 0 ? (
                            <ul className="space-y-2">
                                {sortedCollectedBikes.map(bike => (
                                    <li key={bike} className="p-3 bg-white border rounded-md flex flex-col sm:flex-row justify-between items-center">
                                        <div className="flex items-center gap-3 mb-2 sm:mb-0">
                                            <p className="font-mono text-gray-800 font-bold text-lg">{bike}</p>
                                            {collectedBikesDetails[bike]?.battery !== undefined && (
                                                <div className="flex items-center justify-center w-10 h-10 rounded-full border-2 border-blue-500 text-[10px] font-bold text-blue-600 bg-white shadow-sm" title="Bateria">
                                                    {formatBattery(collectedBikesDetails[bike].battery)}%
                                                </div>
                                            )}
                                        </div>
                                        <div className="grid grid-cols-3 gap-2 w-full max-w-[240px]">
                                            <button onClick={() => handleCollectedBikeAction(bike, 'Enviada para Estação')} disabled={isLoading} className="px-2 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600 active:scale-95 transition-all text-xs disabled:bg-gray-400">Estação</button>
                                            <button onClick={() => handleCollectedBikeAction(bike, 'Enviada para Filial')} disabled={isLoading} className="px-2 py-1 bg-green-500 text-white rounded-md hover:bg-green-600 active:scale-95 transition-all text-xs disabled:bg-gray-400">Filial</button>
                                            <button onClick={() => handleCollectedBikeAction(bike, 'Vandalizada')} disabled={isLoading} className="px-2 py-1 bg-red-500 text-white rounded-md hover:bg-red-600 active:scale-95 transition-all text-xs disabled:bg-gray-400">Vandalizada</button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-gray-500">Nenhuma bicicleta recolhida ainda.</p>
                        )}
                    </div>
                )}
            </main>
            
            <RequestModal 
                isOpen={isRequestModalOpen}
                onClose={() => setRequestModalOpen(false)}
                onSubmit={handleCreateRequest}
                isLoading={isLoading}
                motoristas={motoristas}
                driverLocations={driverLocations}
                error={error}
                clearError={() => setError(null)}
            />

            <EditDriverModal 
                isOpen={isEditDriverModalOpen}
                onClose={() => setIsEditDriverModalOpen(false)}
                driver={editingDriver}
                onSave={handleUpdateDriverState}
                isLoading={isLoading}
            />

            <RouteModal
                isOpen={isRouteModalOpen}
                onClose={() => setRouteModalOpen(false)}
                onSubmit={handleCreateRoute}
                isLoading={isLoading}
                pendingBikeNumbers={allActiveBikes}
                motoristas={motoristas}
                error={error}
                clearError={() => setError(null)}
                type="route"
            />

            <RouteModal
                isOpen={isTrailerModalOpen}
                onClose={() => setTrailerModalOpen(false)}
                onSubmit={handleCreateTrailer}
                isLoading={isLoading}
                pendingBikeNumbers={allActiveBikes}
                motoristas={motoristas}
                error={error}
                clearError={() => setError(null)}
                type="trailer"
            />
            
            <ReportModal 
                isOpen={isReportModalOpen}
                onClose={() => setReportModalOpen(false)}
                driverName={driverName}
                plate={plate}
                kmInicial={kmInicial}
            />

            <DestinationModal
                isOpen={destinationModal.isOpen}
                onClose={() => setDestinationModal(prev => ({ ...prev, isOpen: false }))}
                onConfirm={(obs) => executeCollectedBikeAction(destinationModal.bikeNumber, destinationModal.type === 'Estação' ? 'Enviada para Estação' : destinationModal.type === 'Filial' ? 'Enviada para Filial' : 'Vandalizada', obs)}
                type={destinationModal.type}
                bikeNumber={destinationModal.bikeNumber}
                stationName={destinationModal.stationName}
                isLoading={isLoading}
            />

            <HistoryModal 
                isOpen={isHistoryModalOpen}
                onClose={() => setIsHistoryModalOpen(false)}
                history={requestsHistory}
                isLoading={isHistoryLoading}
                driverName={driverName}
            />

            <ScheduleModal 
                isOpen={isScheduleModalOpen}
                onClose={() => setIsScheduleModalOpen(false)}
                schedule={userSchedule}
                driverName={driverName}
            />

            <VehicleSwitchModal 
                isOpen={isVehicleModalOpen}
                onClose={() => setIsVehicleModalOpen(false)}
                onSwitch={(plate, km) => onUpdateUser({ plate, kmInicial: km })}
                driverName={driverName}
            />

            <AdminAlerts 
                isOpen={isAdminAlertsOpen}
                onClose={() => setIsAdminAlertsOpen(false)}
                adminName={driverName}
            />

            <ReporModal
                isOpen={isReporModalOpen}
                onClose={() => setIsReporModalOpen(false)}
                data={reporData}
                isLoading={isReporLoading}
            />
        </div>
    );
};

// Fix: Add default export to align with other components and fix import error in App.tsx.
export default MainScreen;