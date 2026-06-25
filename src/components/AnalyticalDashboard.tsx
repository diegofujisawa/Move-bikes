import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer 
} from 'recharts';
import { 
  Bike, ArrowLeft, Download, RefreshCw, AlertCircle, Wrench, Clock, Users, TrendingUp
} from 'lucide-react';
import { db } from '../firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';

interface DashboardData {
  driver: string;
  recolhidas: number;
  remanejadas: number;
  totalBikes: number;
  solicitacoesRecebidas: number;
  solicitacoesAtendidas: number;
  percOcorrencia: number;
}

interface MaintenanceStats {
  name: string;
  hoje: number;
  ontem: number;
  semanaAtual: number;
  semanaAnterior: number;
  mesAtual: number;
  mesAnterior: number;
  totalTimeMs: number;
  timeCount: number;
}

interface AnalyticalDashboardProps {
  onClose: () => void;
  apiCall: (payload: Record<string, any>, retries?: number, silent?: boolean) => Promise<any>;
}

const normalizeForSearch = (name: string) => {
  return String(name).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
};

const formatDuration = (ms: number) => {
  if (!ms || isNaN(ms) || ms <= 0) return '—';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
};

export const AnalyticalDashboard: React.FC<AnalyticalDashboardProps> = ({ onClose, apiCall }) => {
  const [activeTab, setActiveTab] = useState<'drivers' | 'maintenance'>('drivers');
  
  // Tab 1: Drivers State
  const [timeRange, setTimeRange] = useState<string>('day');
  const [data, setData] = useState<DashboardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tab 2: Maintenance State
  const [maintLoading, setMaintLoading] = useState(true);
  const [maintError, setMaintError] = useState<string | null>(null);
  const [mechanicsData, setMechanicsData] = useState<MaintenanceStats[]>([]);
  const [techniciansData, setTechniciansData] = useState<MaintenanceStats[]>([]);

  const timeRanges = [
    { key: 'day', label: 'Hoje' },
    { key: '-1', label: 'Ontem' },
    { key: 'week', label: 'Semana Atual' },
    { key: '-7', label: 'Semana Anterior' },
    { key: 'month', label: 'Mês Atual' },
    { key: '-30', label: 'Mês Anterior' },
  ];

  // Fetch Drivers Data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiCall({ action: 'getAnalyticalDashboardData', timeRange });
      if (response.success) {
        setData(response.data);
      } else {
        setError(response.error || 'Erro ao carregar dados do dashboard.');
      }
    } catch (err: any) {
      setError(err.message || 'Falha na comunicação com o servidor.');
    } finally {
      setLoading(false);
    }
  }, [apiCall, timeRange]);

  // Fetch Maintenance Data (Mechanics & Technicians)
  const fetchMaintenanceData = useCallback(async () => {
    setMaintLoading(true);
    setMaintError(null);
    try {
      const [snapReparo, snapEntrada, snapTec] = await Promise.all([
        getDocs(query(collection(db, 'reports'), where('type', '==', 'Reparo'))),
        getDocs(query(collection(db, 'reports'), where('type', '==', 'Mecânica'))),
        getDocs(query(collection(db, 'reports'), where('type', '==', 'Técnica'))),
      ]);

      // --- PROCESS MECHANICS ENTRADAS & REPAROS ---
      const entries: Record<string, any[]> = {};
      snapEntrada.docs.forEach(d => {
        const rec = d.data();
        const pat = String(rec.patrimonio || rec.bikeNumber || '');
        if (!pat) return;
        if (!entries[pat]) entries[pat] = [];
        entries[pat].push(rec);
      });

      const parsedMechanicRecords = snapReparo.docs.map(d => {
        const data = d.data();
        const rec = { id: d.id, ...data } as any;
        const pat = String(rec.patrimonio || rec.bikeNumber || '');
        const tsOut = rec.timestamp?.toMillis?.() || (rec.timestamp?.seconds ? rec.timestamp.seconds * 1000 : 0) || 0;
        
        const entriesBike = (entries[pat] || [])
          .filter(e => {
            const entryTs = e.dataEntrada?.toMillis?.() || (e.dataEntrada?.seconds ? e.dataEntrada.seconds * 1000 : 0) || e.timestamp?.toMillis?.() || (e.timestamp?.seconds ? e.timestamp.seconds * 1000 : 0) || 0;
            return entryTs <= tsOut;
          })
          .sort((a: any, b: any) => {
            const aTs = a.dataEntrada?.toMillis?.() || (a.dataEntrada?.seconds ? a.dataEntrada.seconds * 1000 : 0) || a.timestamp?.toMillis?.() || (a.timestamp?.seconds ? a.timestamp.seconds * 1000 : 0) || 0;
            const bTs = b.dataEntrada?.toMillis?.() || (b.dataEntrada?.seconds ? b.dataEntrada.seconds * 1000 : 0) || b.timestamp?.toMillis?.() || (b.timestamp?.seconds ? b.timestamp.seconds * 1000 : 0) || 0;
            return bTs - aTs;
          });
        const entrada = entriesBike[0];

        const obs = rec.observacao || rec.tratativa || '—';
        const treatment = obs.includes(' — ') ? obs.split(' — ')[1] : obs;

        const rawMecanico = rec.mecanico || rec.motorista || rec.driverName || '—';
        let mecanicoName = String(rawMecanico).trim();
        const mNorm = normalizeForSearch(mecanicoName);
        
        if (mNorm === 'JOAO') mecanicoName = 'João';
        else if (mNorm === 'ANDRE') mecanicoName = 'André';
        else if (mNorm === 'KAUAN') mecanicoName = 'Kauan';
        else if (mNorm === 'FELIPE') mecanicoName = 'Felipe';
        else if (mNorm === 'RAFAEL') mecanicoName = 'Rafael';

        return {
          ...rec,
          bikeNumber: pat,
          mecanico: mecanicoName,
          mNorm,
          treatment,
          dataEntrada: entrada?.dataEntrada || entrada?.timestamp || null,
          dataSaida: rec.timestamp,
        };
      }).filter(r => r.mNorm && r.mNorm !== 'MECANICA' && r.mNorm !== 'TODOS' && r.mNorm !== '—' && r.mNorm !== '' && r.mNorm !== 'CAIO');

      // --- PROCESS TECHNICIAN DEVOLVIDAS & ENTRADAS ---
      const devolvidas = snapTec.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .filter(r => (r.status || '').includes('Devolvida') || (r.observacao || '').includes('finalizada') || (r.observation || '').includes('finalizada'));

      const tecEntradas: Record<string, any[]> = {};
      snapTec.docs.forEach(d => {
        const rec = d.data();
        if ((rec.status || '').includes('Em Técnica') || (rec.observacao || '').includes('Recebida') || (rec.observation || '').includes('Recebida')) {
          const pat = String(rec.patrimonio || rec.bikeNumber || '');
          if (!tecEntradas[pat]) tecEntradas[pat] = [];
          tecEntradas[pat].push(rec);
        }
      });

      const parsedTechnicianRecords = devolvidas.map(rec => {
        const pat = String(rec.patrimonio || rec.bikeNumber || '');
        const tsOut = rec.timestamp?.toMillis?.() || (rec.timestamp?.seconds ? rec.timestamp.seconds * 1000 : 0) || 0;
        const entrada = (tecEntradas[pat] || [])
          .filter(e => {
            const entTs = e.timestamp?.toMillis?.() || (e.timestamp?.seconds ? e.timestamp.seconds * 1000 : 0) || 0;
            return entTs <= tsOut;
          })
          .sort((a: any, b: any) => {
            const aTs = a.timestamp?.toMillis?.() || (a.timestamp?.seconds ? a.timestamp.seconds * 1000 : 0) || 0;
            const bTs = b.timestamp?.toMillis?.() || (b.timestamp?.seconds ? b.timestamp.seconds * 1000 : 0) || 0;
            return bTs - aTs;
          })[0];

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
        
        const techNorm = normalizeForSearch(techName);
        if (techNorm === 'DIEGO') techName = 'Diego';
        else if (techNorm === 'JHONATAN') techName = 'Jhonatan';
        else if (!techName || techNorm === 'TECNICA' || techNorm === 'TECNICO') {
          techName = '—';
        }

        return {
          ...rec,
          bikeNumber: pat,
          tecnico: techName,
          techNorm,
          dataEntrada: entrada?.timestamp || null,
          dataSaida: rec.timestamp,
          treatment: treatment || '—',
          originalMechanic: originalMechanic || '—',
        };
      }).filter(r => r.techNorm && r.techNorm !== 'TECNICA' && r.techNorm !== 'TECNICO' && r.techNorm !== '—' && r.techNorm !== '' && r.techNorm !== 'JULIANO');

      // --- STATISTICS PREPARATION ---
      const defaultMechanics = ['Kauan', 'João', 'Felipe', 'André', 'Rafael'];
      const defaultTechnicians = ['Diego', 'Jhonatan'];

      const mechStats: Record<string, MaintenanceStats> = {};
      defaultMechanics.forEach(name => {
        mechStats[name] = { name, hoje: 0, ontem: 0, semanaAtual: 0, semanaAnterior: 0, mesAtual: 0, mesAnterior: 0, totalTimeMs: 0, timeCount: 0 };
      });

      const techStats: Record<string, MaintenanceStats> = {};
      defaultTechnicians.forEach(name => {
        techStats[name] = { name, hoje: 0, ontem: 0, semanaAtual: 0, semanaAnterior: 0, mesAtual: 0, mesAnterior: 0, totalTimeMs: 0, timeCount: 0 };
      });

      // Date boundaries setup
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      const startOfYesterday = new Date(startOfToday);
      startOfYesterday.setDate(startOfYesterday.getDate() - 1);
      const endOfYesterday = new Date(startOfYesterday.getFullYear(), startOfYesterday.getMonth(), startOfYesterday.getDate(), 23, 59, 59, 999);

      const currentDayOfWeek = now.getDay(); 
      const startOfCurrentWeek = new Date(startOfToday);
      startOfCurrentWeek.setDate(startOfCurrentWeek.getDate() - currentDayOfWeek);

      const startOfPreviousWeek = new Date(startOfCurrentWeek);
      startOfPreviousWeek.setDate(startOfPreviousWeek.getDate() - 7);
      const endOfPreviousWeek = new Date(startOfCurrentWeek);
      endOfPreviousWeek.setMilliseconds(endOfPreviousWeek.getMilliseconds() - 1);

      const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      endOfPreviousMonth.setMilliseconds(endOfPreviousMonth.getMilliseconds() - 1);

      const getRecordPeriods = (timestamp: any) => {
        if (!timestamp) return null;
        const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        const time = date.getTime();

        return {
          isCurrentDay: time >= startOfToday.getTime() && time <= endOfToday.getTime(),
          isPreviousDay: time >= startOfYesterday.getTime() && time <= endOfYesterday.getTime(),
          isCurrentWeek: time >= startOfCurrentWeek.getTime() && time <= now.getTime(),
          isPreviousWeek: time >= startOfPreviousWeek.getTime() && time <= endOfPreviousWeek.getTime(),
          isCurrentMonth: time >= startOfCurrentMonth.getTime() && time <= now.getTime(),
          isPreviousMonth: time >= startOfPreviousMonth.getTime() && time <= endOfPreviousMonth.getTime(),
        };
      };

      // Fill Mechanics
      parsedMechanicRecords.forEach(rec => {
        const mName = rec.mecanico;
        const periods = getRecordPeriods(rec.dataSaida);
        if (!periods) return;

        let stats = mechStats[mName];
        if (!stats) {
          stats = { name: mName, hoje: 0, ontem: 0, semanaAtual: 0, semanaAnterior: 0, mesAtual: 0, mesAnterior: 0, totalTimeMs: 0, timeCount: 0 };
          mechStats[mName] = stats;
        }

        if (periods.isCurrentDay) stats.hoje++;
        if (periods.isPreviousDay) stats.ontem++;
        if (periods.isCurrentWeek) stats.semanaAtual++;
        if (periods.isPreviousWeek) stats.semanaAnterior++;
        if (periods.isCurrentMonth) stats.mesAtual++;
        if (periods.isPreviousMonth) stats.mesAnterior++;

        if (rec.dataEntrada && rec.dataSaida) {
          const startMs = rec.dataEntrada.toDate ? rec.dataEntrada.toDate().getTime() : new Date(rec.dataEntrada).getTime();
          const endMs = rec.dataSaida.toDate ? rec.dataSaida.toDate().getTime() : new Date(rec.dataSaida).getTime();
          const diff = endMs - startMs;
          if (diff > 0 && diff < 86400000 * 7) { 
            stats.totalTimeMs += diff;
            stats.timeCount++;
          }
        }
      });

      // Fill Technicians
      parsedTechnicianRecords.forEach(rec => {
        const tName = rec.tecnico;
        const periods = getRecordPeriods(rec.dataSaida);
        if (!periods) return;

        let stats = techStats[tName];
        if (!stats) {
          stats = { name: tName, hoje: 0, ontem: 0, semanaAtual: 0, semanaAnterior: 0, mesAtual: 0, mesAnterior: 0, totalTimeMs: 0, timeCount: 0 };
          techStats[tName] = stats;
        }

        if (periods.isCurrentDay) stats.hoje++;
        if (periods.isPreviousDay) stats.ontem++;
        if (periods.isCurrentWeek) stats.semanaAtual++;
        if (periods.isPreviousWeek) stats.semanaAnterior++;
        if (periods.isCurrentMonth) stats.mesAtual++;
        if (periods.isPreviousMonth) stats.mesAnterior++;

        if (rec.dataEntrada && rec.dataSaida) {
          const startMs = rec.dataEntrada.toDate ? rec.dataEntrada.toDate().getTime() : new Date(rec.dataEntrada).getTime();
          const endMs = rec.dataSaida.toDate ? rec.dataSaida.toDate().getTime() : new Date(rec.dataSaida).getTime();
          const diff = endMs - startMs;
          if (diff > 0 && diff < 86400000 * 7) { 
            stats.totalTimeMs += diff;
            stats.timeCount++;
          }
        }
      });

      setMechanicsData(Object.values(mechStats).filter(m => normalizeForSearch(m.name) !== 'CAIO').sort((a, b) => b.mesAtual - a.mesAtual));
      setTechniciansData(Object.values(techStats).filter(t => normalizeForSearch(t.name) !== 'JULIANO').sort((a, b) => b.mesAtual - a.mesAtual));

    } catch (err: any) {
      console.error('fetchMaintenanceData error:', err);
      setMaintError(err.message || 'Erro ao carregar dados de manutenção.');
    } finally {
      setMaintLoading(false);
    }
  }, []);

  // Compute Aggregated Totals for Tab 2
  const maintTotals = useMemo(() => {
    const totals = {
      mech: { hoje: 0, ontem: 0, semanaAtual: 0, semanaAnterior: 0, mesAtual: 0, mesAnterior: 0, totalTime: 0, countTime: 0 },
      tech: { hoje: 0, ontem: 0, semanaAtual: 0, semanaAnterior: 0, mesAtual: 0, mesAnterior: 0, totalTime: 0, countTime: 0 },
      combined: { hoje: 0, ontem: 0, semanaAtual: 0, semanaAnterior: 0, mesAtual: 0, mesAnterior: 0, totalTime: 0, countTime: 0 }
    };

    mechanicsData.forEach(m => {
      totals.mech.hoje += m.hoje;
      totals.mech.ontem += m.ontem;
      totals.mech.semanaAtual += m.semanaAtual;
      totals.mech.semanaAnterior += m.semanaAnterior;
      totals.mech.mesAtual += m.mesAtual;
      totals.mech.mesAnterior += m.mesAnterior;
      totals.mech.totalTime += m.totalTimeMs;
      totals.mech.countTime += m.timeCount;
    });

    techniciansData.forEach(t => {
      totals.tech.hoje += t.hoje;
      totals.tech.ontem += t.ontem;
      totals.tech.semanaAtual += t.semanaAtual;
      totals.tech.semanaAnterior += t.semanaAnterior;
      totals.tech.mesAtual += t.mesAtual;
      totals.tech.mesAnterior += t.mesAnterior;
      totals.tech.totalTime += t.totalTimeMs;
      totals.tech.countTime += t.timeCount;
    });

    totals.combined.hoje = totals.mech.hoje + totals.tech.hoje;
    totals.combined.ontem = totals.mech.ontem + totals.tech.ontem;
    totals.combined.semanaAtual = totals.mech.semanaAtual + totals.tech.semanaAtual;
    totals.combined.semanaAnterior = totals.mech.semanaAnterior + totals.tech.semanaAnterior;
    totals.combined.mesAtual = totals.mech.mesAtual + totals.tech.mesAtual;
    totals.combined.mesAnterior = totals.mech.mesAnterior + totals.tech.mesAnterior;
    totals.combined.totalTime = totals.mech.totalTime + totals.tech.totalTime;
    totals.combined.countTime = totals.mech.countTime + totals.tech.countTime;

    return totals;
  }, [mechanicsData, techniciansData]);

  useEffect(() => {
    fetchData();
    fetchMaintenanceData();
  }, [fetchData, fetchMaintenanceData]);

  const reloadAll = () => {
    fetchData();
    fetchMaintenanceData();
  };

  // CSV Export for Drivers (Tab 1)
  const exportDriversCSV = () => {
    const headers = ['Motorista', 'Recolhidas', 'Remanejadas', 'Total', 'Solicitacoes', 'Atendidas', 'PercSucesso'];
    const rows = data.map(r => [
      r.driver,
      r.recolhidas,
      r.remanejadas,
      r.totalBikes,
      r.solicitacoesRecebidas,
      r.solicitacoesAtendidas,
      `${r.percOcorrencia.toFixed(1)}%`
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `desempenho_motoristas_${timeRange}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // CSV Export for Maintenance (Tab 2)
  const exportMaintenanceCSV = (type: 'mecanicos' | 'tecnicos') => {
    const headers = ['Nome', 'Hoje', 'Ontem', 'Semana Atual', 'Semana Anterior', 'Mes Atual', 'Mes Anterior', 'Tempo Medio'];
    const dataset = type === 'mecanicos' ? mechanicsData : techniciansData;
    const rows = dataset.map(r => [
      r.name,
      r.hoje,
      r.ontem,
      r.semanaAtual,
      r.semanaAnterior,
      r.mesAtual,
      r.mesAnterior,
      formatDuration(r.totalTimeMs / (r.timeCount || 1))
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `desempenho_${type}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const totalRecolhidas = data.reduce((acc, curr) => acc + curr.recolhidas, 0);
  const totalRemanejadas = data.reduce((acc, curr) => acc + curr.remanejadas, 0);
  const totalSolicitacoes = data.reduce((acc, curr) => acc + curr.solicitacoesRecebidas, 0);
  const totalAtendidas = data.reduce((acc, curr) => acc + curr.solicitacoesAtendidas, 0);

  return (
    <div className="fixed inset-0 bg-gray-50 z-50 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <button 
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
            id="btn_back_dashboard"
          >
            <ArrowLeft className="w-6 h-6 text-gray-600" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Dashboard Analítico</h1>
            <p className="text-xs text-gray-500">Métricas gerais de operação, logística e oficina</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button 
            onClick={reloadAll}
            className="p-2 hover:bg-gray-100 rounded-full text-gray-500 transition-colors"
            disabled={loading || maintLoading}
            title="Atualizar dados"
            id="btn_refresh_dashboard"
          >
            <RefreshCw className={`w-5 h-5 ${(loading || maintLoading) ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Tabs Selector */}
      <div className="bg-white border-b px-4 sm:px-6 flex gap-6 z-10">
        <button
          onClick={() => setActiveTab('drivers')}
          className={`py-3 text-sm font-bold border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'drivers'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-200'
          }`}
          id="tab_drivers"
        >
          <span className="p-1 rounded bg-blue-50 text-blue-600 text-[10px]">🚗</span>
          Motoristas
        </button>
        <button
          onClick={() => setActiveTab('maintenance')}
          className={`py-3 text-sm font-bold border-b-2 transition-all flex items-center gap-2 ${
            activeTab === 'maintenance'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-200'
          }`}
          id="tab_maintenance"
        >
          <span className="p-1 rounded bg-blue-50 text-blue-600 text-[10px]">🔧</span>
          Mecânica & Técnica
        </button>
      </div>

      {/* Content Area */}
      <main className="flex-1 overflow-y-auto p-4 lg:p-8">
        
        {/* TAB 1: DRIVERS DASHBOARD */}
        {activeTab === 'drivers' && (
          <>
            <div className="max-w-7xl mx-auto mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <h2 className="text-lg font-bold text-gray-800">Desempenho dos Motoristas</h2>
              <div className="bg-gray-100 p-1 rounded-lg flex gap-1 overflow-x-auto max-w-[300px] sm:max-w-none no-scrollbar">
                {timeRanges.map((range) => (
                  <button
                    key={range.key}
                    onClick={() => setTimeRange(range.key)}
                    className={`px-3 py-1 text-[10px] sm:text-xs font-semibold rounded-md transition-all whitespace-nowrap ${
                      timeRange === range.key 
                        ? 'bg-white text-blue-600 shadow-sm' 
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            </div>

            {error ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
                <h3 className="text-lg font-semibold text-gray-900">Ops! Algo deu errado</h3>
                <p className="text-gray-500 max-w-xs">{error}</p>
                <button 
                  onClick={fetchData}
                  className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Tentar novamente
                </button>
              </div>
            ) : loading && data.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64">
                <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500 animate-pulse font-medium">Carregando análises dos motoristas...</p>
              </div>
            ) : (
              <div className="max-w-7xl mx-auto space-y-6">
                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <SummaryCard 
                    title="Bikes Recolhidas" 
                    value={totalRecolhidas} 
                    icon={<Bike className="w-6 h-6 text-blue-600" />}
                    color="blue"
                  />
                  <SummaryCard 
                    title="Bikes Remanejadas" 
                    value={totalRemanejadas} 
                    icon={<Bike className="w-6 h-6 text-cyan-600" />}
                    color="cyan"
                  />
                  <SummaryCard 
                    title="Solicitações Recebidas" 
                    value={totalSolicitacoes} 
                    icon={<AlertCircle className="w-6 h-6 text-amber-600" />}
                    color="amber"
                  />
                  <SummaryCard 
                    title="Solicitações Atendidas" 
                    value={totalAtendidas} 
                    icon={<AlertCircle className="w-6 h-6 text-green-600" />}
                    color="green"
                  />
                </div>

                {/* Charts Grid */}
                <div className="grid grid-cols-1 gap-6">
                  <ChartContainer title="Bikes por Motorista (Recolhidas vs Remanejadas)">
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="driver" tick={{fontSize: 12}} />
                        <YAxis />
                        <Tooltip 
                          contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        />
                        <Legend />
                        <Bar dataKey="recolhidas" name="Recolhidas" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="remanejadas" name="Remanejadas" fill="#06b6d4" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartContainer>
                </div>

                {/* Detailed Table */}
                <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                  <div className="px-6 py-4 border-b flex items-center justify-between">
                    <h3 className="font-bold text-gray-900">Detalhamento por Motorista</h3>
                    <button 
                      onClick={exportDriversCSV}
                      className="text-blue-600 text-sm font-semibold hover:underline flex items-center gap-1"
                      id="btn_export_drivers"
                    >
                      <Download className="w-4 h-4" /> Exportar CSV
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                        <tr>
                          <th className="px-6 py-3 font-semibold">Motorista</th>
                          <th className="px-6 py-3 font-semibold text-center">Recolhidas</th>
                          <th className="px-6 py-3 font-semibold text-center">Remanejadas</th>
                          <th className="px-6 py-3 font-semibold text-center bg-gray-100 text-blue-800">SOMA</th>
                          <th className="px-6 py-3 font-semibold text-center">Solicitações</th>
                          <th className="px-6 py-3 font-semibold text-center">Atendidas</th>
                          <th className="px-6 py-3 font-semibold text-center flex items-center justify-center gap-1">
                            % Sucesso
                            <div className="group relative">
                              <AlertCircle className="w-3 h-3 text-gray-400 cursor-help" />
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-gray-800 text-white text-[10px] rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20">
                                Calculado como: (Solicitações Atendidas / Solicitações Recebidas) * 100. 
                                Considera apenas as bikes enviadas via "Solicitar Recolha".
                              </div>
                            </div>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {data.map((row, idx) => (
                          <tr key={idx} className="hover:bg-gray-50 transition-colors">
                            <td className="px-6 py-4 font-medium text-gray-900">{row.driver}</td>
                            <td className="px-6 py-4 text-center text-gray-600">{row.recolhidas}</td>
                            <td className="px-6 py-4 text-center text-gray-600">{row.remanejadas}</td>
                            <td className="px-6 py-4 text-center font-black text-blue-700 bg-blue-50/50">{row.totalBikes}</td>
                            <td className="px-6 py-4 text-center text-gray-600 font-bold">{row.solicitacoesRecebidas}</td>
                            <td className="px-6 py-4 text-center text-green-600 font-bold">{row.solicitacoesAtendidas}</td>
                            <td className="px-6 py-4 text-center">
                              <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                                row.percOcorrencia > 80 ? 'bg-green-100 text-green-700' : 
                                row.percOcorrencia > 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                              }`}>
                                {row.percOcorrencia.toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      {/* Footer for totals */}
                      <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                        <tr className="font-black text-gray-900 italic">
                          <td className="px-6 py-4">TOTAL GERAL</td>
                          <td className="px-6 py-4 text-center">{totalRecolhidas}</td>
                          <td className="px-6 py-4 text-center">{totalRemanejadas}</td>
                          <td className="px-6 py-4 text-center bg-blue-100 text-blue-900 border-x border-blue-200">{totalRecolhidas + totalRemanejadas}</td>
                          <td className="px-6 py-4 text-center">{totalSolicitacoes}</td>
                          <td className="px-6 py-4 text-center text-green-600">{totalAtendidas}</td>
                          <td className="px-6 py-4 text-center">
                            <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                              (totalAtendidas / (totalSolicitacoes || 1) * 100) > 80 ? 'bg-green-100 text-green-700' : 
                              (totalAtendidas / (totalSolicitacoes || 1) * 100) > 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                            }`}>
                              {(totalSolicitacoes > 0 ? (totalAtendidas / totalSolicitacoes * 100) : 0).toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* TAB 2: MAINTENANCE DASHBOARD (MECÂNICA & TÉCNICA) */}
        {activeTab === 'maintenance' && (
          <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-800">Desempenho da Oficina e Técnica</h2>
                <p className="text-xs text-gray-500">Mapeamento de reparos realizados pelos mecânicos e técnicos de bancada</p>
              </div>
            </div>

            {maintError ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
                <h3 className="text-lg font-semibold text-gray-900">Ops! Algo deu errado</h3>
                <p className="text-gray-500 max-w-xs">{maintError}</p>
                <button 
                  onClick={fetchMaintenanceData}
                  className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Tentar novamente
                </button>
              </div>
            ) : maintLoading ? (
              <div className="flex flex-col items-center justify-center h-64">
                <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500 animate-pulse font-medium">Carregando métricas de manutenção...</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* General Summary Period Cards */}
                <div className="bg-white rounded-xl border p-6 shadow-sm">
                  <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2 text-sm sm:text-base">
                    <TrendingUp className="w-5 h-5 text-blue-600" /> Resumo Geral de Manutenção por Período
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="bg-slate-50 p-4 rounded-lg border border-slate-100 flex flex-col justify-between">
                      <span className="text-xs text-gray-500 font-bold uppercase tracking-wider">Reparos Hoje</span>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="text-2xl font-black text-gray-900">{maintTotals.combined.hoje}</span>
                        <span className="text-xs text-gray-500">Ontem: {maintTotals.combined.ontem}</span>
                      </div>
                    </div>
                    <div className="bg-slate-50 p-4 rounded-lg border border-slate-100 flex flex-col justify-between">
                      <span className="text-xs text-gray-500 font-bold uppercase tracking-wider">Reparos Semana Atual</span>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="text-2xl font-black text-gray-900">{maintTotals.combined.semanaAtual}</span>
                        <span className="text-xs text-gray-500">Anterior: {maintTotals.combined.semanaAnterior}</span>
                      </div>
                    </div>
                    <div className="bg-slate-50 p-4 rounded-lg border border-slate-100 flex flex-col justify-between">
                      <span className="text-xs text-gray-500 font-bold uppercase tracking-wider">Reparos Mês Atual</span>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="text-2xl font-black text-gray-900">{maintTotals.combined.mesAtual}</span>
                        <span className="text-xs text-gray-500">Anterior: {maintTotals.combined.mesAnterior}</span>
                      </div>
                    </div>
                    <div className="bg-blue-50/50 p-4 rounded-lg border border-blue-100 flex flex-col justify-between">
                      <span className="text-xs text-blue-800 font-bold uppercase tracking-wider flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" /> Tempo Médio de Setup
                      </span>
                      <div className="mt-2 flex flex-col">
                        <span className="text-lg font-black text-blue-900">
                          {formatDuration(maintTotals.combined.totalTime / (maintTotals.combined.countTime || 1))}
                        </span>
                        <span className="text-[10px] text-blue-700/80 font-medium mt-1">
                          Mecânica: {formatDuration(maintTotals.mech.totalTime / (maintTotals.mech.countTime || 1))} | Técnica: {formatDuration(maintTotals.tech.totalTime / (maintTotals.tech.countTime || 1))}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Side by Side Comparative Tables */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  
                  {/* Mechanics Column */}
                  <div className="bg-white rounded-xl shadow-sm border overflow-hidden flex flex-col justify-between">
                    <div>
                      <div className="px-6 py-4 border-b flex items-center justify-between bg-slate-50/50">
                        <div className="flex items-center gap-2">
                          <Wrench className="w-5 h-5 text-amber-600" />
                          <h3 className="font-bold text-gray-900">Mecânicos — Desempenho</h3>
                        </div>
                        <button 
                          onClick={() => exportMaintenanceCSV('mecanicos')}
                          className="text-blue-600 text-xs font-semibold hover:underline flex items-center gap-1"
                          id="btn_export_mecanicos"
                        >
                          <Download className="w-3.5 h-3.5" /> Exportar CSV
                        </button>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs sm:text-sm">
                          <thead className="bg-gray-50 text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider">
                            <tr>
                              <th className="px-4 py-3 font-bold">Mecânico</th>
                              <th className="px-4 py-3 font-bold text-center">Hoje</th>
                              <th className="px-4 py-3 font-bold text-center">Semana</th>
                              <th className="px-4 py-3 font-bold text-center">Mês</th>
                              <th className="px-4 py-3 font-bold text-center">Tempo Médio</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {mechanicsData.map((row, idx) => (
                              <tr key={idx} className="hover:bg-gray-50 transition-colors">
                                <td className="px-4 py-4 font-bold text-gray-900">{row.name}</td>
                                <td className="px-4 py-4 text-center">
                                  <div className="flex flex-col items-center justify-center">
                                    <span className="font-black text-gray-900">{row.hoje}</span>
                                    <span className="text-[10px] text-gray-500 font-medium">Ontem: {row.ontem}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-4 text-center">
                                  <div className="flex flex-col items-center justify-center">
                                    <span className="font-black text-gray-900">{row.semanaAtual}</span>
                                    <span className="text-[10px] text-gray-500 font-medium">Ant: {row.semanaAnterior}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-4 text-center">
                                  <div className="flex flex-col items-center justify-center">
                                    <span className="font-black text-gray-900">{row.mesAtual}</span>
                                    <span className="text-[10px] text-gray-500 font-medium">Ant: {row.mesAnterior}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-4 text-center font-semibold text-gray-600">
                                  {formatDuration(row.totalTimeMs / (row.timeCount || 1))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    
                    {/* Footer for Mechanics Totals */}
                    <div className="bg-slate-50 px-6 py-4 border-t-2 border-gray-200 grid grid-cols-5 text-center text-xs font-black text-gray-900 italic">
                      <div className="text-left">TOTAL GERAL</div>
                      <div>
                        <div>{maintTotals.mech.hoje}</div>
                        <div className="text-[9px] text-gray-500 font-normal">Ontem: {maintTotals.mech.ontem}</div>
                      </div>
                      <div>
                        <div>{maintTotals.mech.semanaAtual}</div>
                        <div className="text-[9px] text-gray-500 font-normal">Ant: {maintTotals.mech.semanaAnterior}</div>
                      </div>
                      <div>
                        <div>{maintTotals.mech.mesAtual}</div>
                        <div className="text-[9px] text-gray-500 font-normal">Ant: {maintTotals.mech.mesAnterior}</div>
                      </div>
                      <div className="font-semibold text-blue-700">
                        {formatDuration(maintTotals.mech.totalTime / (maintTotals.mech.countTime || 1))}
                      </div>
                    </div>
                  </div>

                  {/* Technicians Column */}
                  <div className="bg-white rounded-xl shadow-sm border overflow-hidden flex flex-col justify-between">
                    <div>
                      <div className="px-6 py-4 border-b flex items-center justify-between bg-slate-50/50">
                        <div className="flex items-center gap-2">
                          <Users className="w-5 h-5 text-blue-600" />
                          <h3 className="font-bold text-gray-900">Técnicos — Desempenho</h3>
                        </div>
                        <button 
                          onClick={() => exportMaintenanceCSV('tecnicos')}
                          className="text-blue-600 text-xs font-semibold hover:underline flex items-center gap-1"
                          id="btn_export_tecnicos"
                        >
                          <Download className="w-3.5 h-3.5" /> Exportar CSV
                        </button>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs sm:text-sm">
                          <thead className="bg-gray-50 text-gray-500 text-[10px] sm:text-xs uppercase tracking-wider">
                            <tr>
                              <th className="px-4 py-3 font-bold">Técnico</th>
                              <th className="px-4 py-3 font-bold text-center">Hoje</th>
                              <th className="px-4 py-3 font-bold text-center">Semana</th>
                              <th className="px-4 py-3 font-bold text-center">Mês</th>
                              <th className="px-4 py-3 font-bold text-center">Tempo Médio</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {techniciansData.map((row, idx) => (
                              <tr key={idx} className="hover:bg-gray-50 transition-colors">
                                <td className="px-4 py-4 font-bold text-gray-900">{row.name}</td>
                                <td className="px-4 py-4 text-center">
                                  <div className="flex flex-col items-center justify-center">
                                    <span className="font-black text-gray-900">{row.hoje}</span>
                                    <span className="text-[10px] text-gray-500 font-medium">Ontem: {row.ontem}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-4 text-center">
                                  <div className="flex flex-col items-center justify-center">
                                    <span className="font-black text-gray-900">{row.semanaAtual}</span>
                                    <span className="text-[10px] text-gray-500 font-medium">Ant: {row.semanaAnterior}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-4 text-center">
                                  <div className="flex flex-col items-center justify-center">
                                    <span className="font-black text-gray-900">{row.mesAtual}</span>
                                    <span className="text-[10px] text-gray-500 font-medium">Ant: {row.mesAnterior}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-4 text-center font-semibold text-gray-600">
                                  {formatDuration(row.totalTimeMs / (row.timeCount || 1))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    
                    {/* Footer for Technicians Totals */}
                    <div className="bg-slate-50 px-6 py-4 border-t-2 border-gray-200 grid grid-cols-5 text-center text-xs font-black text-gray-900 italic">
                      <div className="text-left">TOTAL GERAL</div>
                      <div>
                        <div>{maintTotals.tech.hoje}</div>
                        <div className="text-[9px] text-gray-500 font-normal">Ontem: {maintTotals.tech.ontem}</div>
                      </div>
                      <div>
                        <div>{maintTotals.tech.semanaAtual}</div>
                        <div className="text-[9px] text-gray-500 font-normal">Ant: {maintTotals.tech.semanaAnterior}</div>
                      </div>
                      <div>
                        <div>{maintTotals.tech.mesAtual}</div>
                        <div className="text-[9px] text-gray-500 font-normal">Ant: {maintTotals.tech.mesAnterior}</div>
                      </div>
                      <div className="font-semibold text-blue-700">
                        {formatDuration(maintTotals.tech.totalTime / (maintTotals.tech.countTime || 1))}
                      </div>
                    </div>
                  </div>

                </div>

                {/* Monthly Maintenance Chart */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <ChartContainer title="Comparativo Mês Atual vs Anterior (Mecânicos)">
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={mechanicsData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="name" tick={{fontSize: 11}} />
                        <YAxis />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="mesAtual" name="Mês Atual" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="mesAnterior" name="Mês Anterior" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartContainer>

                  <ChartContainer title="Comparativo Mês Atual vs Anterior (Técnicos)">
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={techniciansData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="name" tick={{fontSize: 11}} />
                        <YAxis />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="mesAtual" name="Mês Atual" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="mesAnterior" name="Mês Anterior" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartContainer>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

const SummaryCard = ({ title, value, icon, color }: { title: string, value: string | number, icon: React.ReactNode, color: string }) => {
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-50',
    green: 'bg-green-50',
    amber: 'bg-amber-50',
    purple: 'bg-purple-50',
    cyan: 'bg-cyan-50',
    indigo: 'bg-indigo-50'
  };

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border flex items-center gap-4">
      <div className={`p-3 rounded-lg ${colorClasses[color] || 'bg-gray-50'}`}>
        {icon}
      </div>
      <div>
        <p className="text-sm text-gray-500 font-medium">{title}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
      </div>
    </div>
  );
};

const ChartContainer = ({ title, children }: { title: string, children: React.ReactNode }) => (
  <div className="bg-white p-6 rounded-xl shadow-sm border">
    <h3 className="font-bold text-gray-900 mb-6">{title}</h3>
    {children}
  </div>
);
