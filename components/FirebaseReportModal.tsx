import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  orderBy, 
  limit, 
  onSnapshot, 
  deleteDoc, 
  doc, 
  setDoc,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { db } from '../firebase';
import { FirebaseReport } from '../types';
import { apiCall } from '../api';

// Helper: data local no formato YYYY-MM-DD
const localDateStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

import { 
  XIcon, 
  PlusIcon, 
  TrashIcon, 
  SheetIcon,
  SearchIcon,
  RefreshIcon,
  EditIcon,
  CheckIcon
} from './icons';

interface FirebaseReportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const FirebaseReportModal: React.FC<FirebaseReportModalProps> = ({ isOpen, onClose }) => {
  const [reports, setReports] = useState<FirebaseReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Partial<FirebaseReport>>({});
  
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Filters state
  const [filterDriver, setFilterDriver] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  
  // Form state for adding new report
  const [newReport, setNewReport] = useState<Partial<FirebaseReport>>({
    patrimonio: '',
    status: '',
    observacao: '',
    motorista: '',
    type: 'Manual'
  });

  useEffect(() => {
    if (!isOpen) return;

    setIsLoading(true);
    // ✅ Otimizado: Só busca relatórios de HOJE por padrão para economizar leituras
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const q = query(
      collection(db, 'reports'), 
      where('timestamp', '>=', Timestamp.fromDate(startOfDay)),
      orderBy('timestamp', 'desc'), 
      limit(500)
    );
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const reportsData = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : data.timestamp
        } as FirebaseReport;
      });
      setReports(reportsData);
      setIsLoading(false);
    }, (error) => {
      console.error("Error fetching reports:", error);
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, [isOpen]);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Deseja realmente excluir este registro?')) return;
    try {
      await deleteDoc(doc(db, 'reports', id));
    } catch (error) {
      console.error("Error deleting report:", error);
      alert("Erro ao excluir registro.");
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReport.patrimonio || !newReport.status || !newReport.motorista) {
      alert("Preencha os campos obrigatórios (Patrimônio, Status, Motorista).");
      return;
    }

    setIsLoading(true);
    try {
      // Fetch current bike info from Sheets to populate missing fields
      const bikeRes = await apiCall({ action: 'searchBike', bikeNumber: newReport.patrimonio });
      const bikeData = bikeRes.success ? bikeRes.data : {};

      const deterministicId = `${newReport.patrimonio}_${localDateStr()}_${Date.now()}`;
      
      await setDoc(doc(db, 'reports', deterministicId), {
        ...newReport,
        statusSistema: newReport.statusSistema || bikeData['Status'] || '',
        bateria: bikeData['Bateria'] || '',
        trava: bikeData['Trava'] || '',
        localidade: newReport.localidade || bikeData['Localidade'] || '',
        timestamp: serverTimestamp(),
        type: newReport.type || 'Manual'
      }, { merge: true });

      // Sync to Sheets
      apiCall({
        action: 'logReport',
        rowData: [
          new Date().toISOString(),
          newReport.patrimonio,
          newReport.status,
          newReport.observacao || '',
          newReport.motorista,
          newReport.statusSistema || bikeData['Status'] || '',
          bikeData['Bateria'] || '',
          bikeData['Trava'] || '',
          newReport.localidade || bikeData['Localidade'] || ''
        ]
      }, 1, true).catch(err => console.warn('[Sheets] Manual report sync failed:', err));

      setNewReport({
        patrimonio: '',
        status: '',
        observacao: '',
        motorista: '',
        type: 'Manual'
      });
      setIsAdding(false);
    } catch (error) {
      console.error("Error adding report:", error);
      alert("Erro ao adicionar registro.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartEdit = (report: FirebaseReport) => {
    setEditingId(report.id || null);
    setEditData({ ...report });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditData({});
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setIsLoading(true);
    try {
      const docRef = doc(db, 'reports', editingId);
      const updatePayload = { ...editData };
      delete updatePayload.id;
      
      await setDoc(docRef, updatePayload, { merge: true });
      setEditingId(null);
      setEditData({});
    } catch (error) {
      console.error("Error updating report:", error);
      alert("Erro ao atualizar registro.");
    } finally {
      setIsLoading(false);
    }
  };

  // =================================================================
  // OTIMIZADO v85.6: usa getSheetsReportsToday em vez de exportAllData
  // Custo: ~300 leituras/clique (antes: ~22.000 leituras/clique)
  // =================================================================
  const handleSyncWithSheets = async () => {
    if (!window.confirm('Deseja comparar os dados do Firebase com a Planilha e sincronizar registros faltantes de HOJE?')) return;

    setIsSyncing(true);
    try {
      // ✅ NOVO: endpoint específico que lê só as últimas 300 linhas do Relatório
      // ❌ ANTIGO: apiCall({ action: 'exportAllData' }) — lia TODA a planilha (~22.000 leituras)
      const res = await apiCall({
        action: 'getSheetsReportsToday',
        category: 'ADM',
      });

      if (!res.success || !res.data) throw new Error(res.error || 'Falha ao buscar dados da planilha.');

      const todaySheetsReports: Array<{
        timestamp: string;
        patrimonio: string;
        status: string;
        observacao: string;
        motorista: string;
        statusSistema: string;
        bateria: string;
        trava: string;
        localidade: string;
      }> = res.data;

      console.log(`[Sync] Encontrados ${todaySheetsReports.length} registros hoje na planilha.`);

      // Prepara set de chaves já existentes no Firebase (registros de hoje)
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const existingIds = new Set(
        reports
          .filter(r => {
            const rDate = r.timestamp instanceof Date
              ? r.timestamp
              : (r.timestamp as any)?.toDate?.() || new Date();
            const rd = new Date(rDate);
            rd.setHours(0, 0, 0, 0);
            return rd.getTime() === today.getTime();
          })
          .map(r =>
            `${String(r.patrimonio || r.bikeNumber)}_${String(r.motorista || r.driverName)}_${(r.status || '').toUpperCase()}`
          )
      );

      let addedCount = 0;
      const batchSize = 5;

      for (let i = 0; i < todaySheetsReports.length; i += batchSize) {
        const chunk = todaySheetsReports.slice(i, i + batchSize);
        await Promise.all(
          chunk.map(async sr => {
            const pat      = sr.patrimonio;
            const status   = (sr.status || '').toUpperCase();
            const motorista = sr.motorista;

            if (!pat || !motorista) return;

            const key = `${pat}_${motorista}_${status}`;
            if (existingIds.has(key)) return;

            try {
              const deterministicId = `sync_${pat}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
              const finalDate: any = sr.timestamp ? new Date(sr.timestamp) : serverTimestamp();

              await setDoc(doc(db, 'reports', deterministicId), {
                patrimonio:    pat,
                status:        sr.status,
                observacao:    sr.observacao,
                motorista:     motorista,
                statusSistema: sr.statusSistema,
                bateria:       sr.bateria,
                trava:         sr.trava,
                localidade:    sr.localidade,
                timestamp:     finalDate,
                type:          'Sincronizado',
              }, { merge: true });

              addedCount++;
              existingIds.add(key);
            } catch (e) {
              console.error(`[Sync] Falha ao adicionar bike ${pat}:`, e);
            }
          })
        );
      }

      if (addedCount > 0) {
        alert(`Sincronização concluída! ${addedCount} novos registros adicionados ao Firebase.`);
      } else {
        alert('Sincronização concluída! Todos os registros da planilha já existem no Firebase.');
      }

    } catch (error: any) {
      console.error('Sync error:', error);
      alert('Erro durante a sincronização: ' + error.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const filteredReports = reports.filter(r => {
    const p = (r.patrimonio || r.bikeNumber || '').toLowerCase();
    const m = (r.motorista || r.driverName || '').toLowerCase();
    const s = (r.status || '').toLowerCase();
    const o = (r.observacao || r.observation || '').toLowerCase();
    const l = (r.localidade || '').toLowerCase();
    const st = (r.statusSistema || '').toLowerCase();
    const type = (r.type || '').toLowerCase();
    
    const matchesSearch = p.includes(searchTerm.toLowerCase()) ||
           m.includes(searchTerm.toLowerCase()) ||
           s.includes(searchTerm.toLowerCase()) ||
           o.includes(searchTerm.toLowerCase()) ||
           l.includes(searchTerm.toLowerCase()) ||
           st.includes(searchTerm.toLowerCase()) ||
           type.includes(searchTerm.toLowerCase());

    const matchesDriver = !filterDriver || m === filterDriver.toLowerCase();
    
    const displayStatus = (r.status || '').toUpperCase() === 'FILIAL' ? 'RECOLHIDA' : (r.status || '').toUpperCase();
    const matchesStatus = !filterStatus || displayStatus === filterStatus.toUpperCase();
    
    let matchesDate = true;
    if (r.timestamp instanceof Date) {
      const reportDate = new Date(r.timestamp);
      reportDate.setHours(0, 0, 0, 0);
      
      if (filterStartDate) {
        const start = new Date(filterStartDate);
        start.setHours(0, 0, 0, 0);
        if (reportDate < start) matchesDate = false;
      }
      
      if (filterEndDate) {
        const end = new Date(filterEndDate);
        end.setHours(0, 0, 0, 0);
        if (reportDate > end) matchesDate = false;
      }
    }

    const statusLow = (r.status || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const typeLow = (r.type || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const motoristaLow = (r.motorista || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    const isAllowedStatus = statusLow.includes('recolhida') || 
                           statusLow.includes('vandalizada') || 
                           statusLow.includes('estacao') ||
                           statusLow.includes('filial') ||
                           statusLow.includes('nao encontrada');
    
    const isMecanica = motoristaLow.includes('mecanica') || typeLow.includes('mecanica');
    const isTrailerLogistics = statusLow.includes('carretinha') || typeLow === 'logistica';
    const isIntermediate = typeLow === 'recolhida' || typeLow === 'nao atendida';

    if (!isAllowedStatus || isMecanica || isTrailerLogistics || isIntermediate) return false;

    return matchesSearch && matchesDriver && matchesStatus && matchesDate;
  });

  const allowedReports = reports.filter(r => {
    const statusLow = (r.status || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const typeLow = (r.type || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const motoristaLow = (r.motorista || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const isAllowedStatus = statusLow.includes('recolhida') || 
                           statusLow.includes('vandalizada') || 
                           statusLow.includes('estacao') ||
                           statusLow.includes('filial') ||
                           statusLow.includes('nao encontrada');
    
    const isMecanica = motoristaLow.includes('mecanica') || typeLow.includes('mecanica');
    const isTrailerLogistics = statusLow.includes('carretinha') || typeLow === 'logistica';
    const isIntermediate = typeLow === 'recolhida' || typeLow === 'nao atendida';
    
    return isAllowedStatus && !isMecanica && !isTrailerLogistics && !isIntermediate;
  });

  const uniqueDrivers = Array.from(new Set(allowedReports.map(r => r.motorista || r.driverName).filter(Boolean))).sort();
  const uniqueStatuses = Array.from(new Set(allowedReports.map(r => 
    (r.status || '').toUpperCase() === 'FILIAL' ? 'RECOLHIDA' : (r.status || '').toUpperCase()
  ).filter(Boolean))).sort();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[100] animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-7xl flex flex-col max-h-[95vh] overflow-hidden animate-scale-in">
        
        {/* Header */}
        <div className="p-4 border-b bg-gray-50 relative">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <SheetIcon className="w-6 h-6 text-green-600" />
              <h2 className="text-xl font-black text-gray-800 uppercase tracking-tight">Relatório Firebase</h2>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
              <XIcon className="w-6 h-6 text-gray-500" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input 
                type="text" 
                placeholder="Buscar patrimônio..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none w-48"
              />
            </div>
            
            <select 
              value={filterDriver}
              onChange={(e) => setFilterDriver(e.target.value)}
              className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none max-w-[150px]"
            >
              <option value="">Todos Motoristas</option>
              {uniqueDrivers.map(d => <option key={d} value={d}>{d}</option>)}
            </select>

            <select 
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none max-w-[150px]"
            >
              <option value="">Todos Status</option>
              {uniqueStatuses.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-2 py-1">
              <input 
                type="date" 
                value={filterStartDate}
                onChange={(e) => setFilterStartDate(e.target.value)}
                className="text-xs outline-none bg-transparent"
                title="Data Inicial"
              />
              <span className="text-gray-400 text-xs">até</span>
              <input 
                type="date" 
                value={filterEndDate}
                onChange={(e) => setFilterEndDate(e.target.value)}
                className="text-xs outline-none bg-transparent"
                title="Data Final"
              />
            </div>

            {(filterDriver || filterStatus || filterStartDate || filterEndDate || searchTerm) && (
              <button 
                onClick={() => {
                  setFilterDriver('');
                  setFilterStatus('');
                  setFilterStartDate('');
                  setFilterEndDate('');
                  setSearchTerm('');
                }}
                className="text-[10px] font-bold text-red-500 hover:text-red-700 uppercase tracking-tighter px-2"
              >
                Limpar Filtros
              </button>
            )}

            <div className="flex-1"></div>

            <button 
              onClick={() => setIsAdding(!isAdding)}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-bold hover:bg-green-700 transition-all active:scale-95"
            >
              <PlusIcon className="w-4 h-4" />
              Novo Registro
            </button>

            <button 
              onClick={handleSyncWithSheets}
              disabled={isSyncing || isLoading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all active:scale-95 disabled:bg-gray-400"
              title="Sincronizar com a Planilha (otimizado - ~300 leituras)"
            >
              {isSyncing ? <RefreshIcon className="w-4 h-4 animate-spin" /> : <RefreshIcon className="w-4 h-4" />}
              Sincronizar Contador
            </button>
          </div>
        </div>

        {/* Add Form */}
        {isAdding && (
          <form onSubmit={handleAdd} className="p-4 bg-green-50 border-b grid grid-cols-1 sm:grid-cols-3 md:grid-cols-6 gap-3 animate-slide-down">
            <input 
              type="text" 
              placeholder="Patrimônio" 
              value={newReport.patrimonio}
              onChange={e => setNewReport({...newReport, patrimonio: e.target.value.toUpperCase()})}
              className="p-2 border border-green-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500"
              required
            />
            <input 
              type="text" 
              placeholder="Status" 
              value={newReport.status}
              onChange={e => setNewReport({...newReport, status: e.target.value})}
              className="p-2 border border-green-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500"
              required
            />
            <input 
              type="text" 
              placeholder="Motorista" 
              value={newReport.motorista}
              onChange={e => setNewReport({...newReport, motorista: e.target.value.toUpperCase()})}
              className="p-2 border border-green-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500"
              required
            />
            <input 
              type="text" 
              placeholder="Localidade" 
              value={newReport.localidade}
              onChange={e => setNewReport({...newReport, localidade: e.target.value})}
              className="p-2 border border-green-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500"
            />
            <input 
              type="text" 
              placeholder="Status Sistema" 
              value={newReport.statusSistema}
              onChange={e => setNewReport({...newReport, statusSistema: e.target.value})}
              className="p-2 border border-green-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500"
            />
            <input 
              type="text" 
              placeholder="Observação" 
              value={newReport.observacao}
              onChange={e => setNewReport({...newReport, observacao: e.target.value})}
              className="p-2 border border-green-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500"
            />
            <div className="flex gap-2 sm:col-span-3 md:col-span-6 justify-end">
              <button type="button" onClick={() => setIsAdding(false)} className="px-6 py-2 bg-gray-200 text-gray-600 font-bold rounded-lg text-sm hover:bg-gray-300 transition-all">
                Cancelar
              </button>
              <button type="submit" className="px-8 py-2 bg-green-600 text-white font-bold rounded-lg text-sm hover:bg-green-700 transition-all">
                Salvar Registro
              </button>
            </div>
          </form>
        )}

        {/* Table Content */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <RefreshIcon className="w-10 h-10 text-green-500 animate-spin" />
              <p className="text-gray-500 font-medium">Carregando dados do Firebase...</p>
            </div>
          ) : filteredReports.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-400">
              <SheetIcon className="w-16 h-16 mb-2 opacity-20" />
              <p>Nenhum registro encontrado.</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse min-w-[1500px]">
              <thead className="sticky top-0 bg-gray-100 z-10 shadow-sm">
                <tr>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b sticky left-0 bg-gray-100 z-20 w-20 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">Ações</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Data/Hora</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Patrimônio</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Status</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Motorista</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Tipo</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Carretinha</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Status Sistema</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Bateria</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Trava</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Localidade</th>
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b">Observação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredReports.map((report) => {
                  const isEditing = editingId === report.id;
                  
                  return (
                    <tr key={report.id} className={`hover:bg-gray-50 transition-colors group ${isEditing ? 'bg-blue-50/50' : ''}`}>
                      <td className={`p-3 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] ${isEditing ? 'bg-blue-50' : 'bg-white group-hover:bg-gray-50'}`}>
                        <div className="flex items-center gap-1">
                          {isEditing ? (
                            <>
                              <button 
                                onClick={handleSaveEdit}
                                className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg transition-all"
                                title="Salvar"
                              >
                                <CheckIcon className="w-4 h-4" />
                              </button>
                              <button 
                                onClick={handleCancelEdit}
                                className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg transition-all"
                                title="Cancelar"
                              >
                                <XIcon className="w-4 h-4" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button 
                                onClick={() => handleStartEdit(report)}
                                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                                title="Editar"
                              >
                                <EditIcon className="w-4 h-4" />
                              </button>
                              <button 
                                onClick={() => report.id && handleDelete(report.id)}
                                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                                title="Excluir"
                              >
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-[11px] text-gray-500 whitespace-nowrap">
                        {report.timestamp instanceof Date ? report.timestamp.toLocaleString('pt-BR') : '---'}
                      </td>
                      <td className="p-3 text-sm font-bold text-gray-900">
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.patrimonio || editData.bikeNumber || ''} 
                            onChange={e => setEditData({...editData, patrimonio: e.target.value.toUpperCase(), bikeNumber: e.target.value.toUpperCase()})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.patrimonio || report.bikeNumber || '---'
                        )}
                      </td>
                      <td className="p-3">
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.status || ''} 
                            onChange={e => setEditData({...editData, status: e.target.value})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase whitespace-nowrap ${
                            (report.status || '').toLowerCase().includes('recolhida') || (report.status || '').toLowerCase().includes('filial') ? 'bg-orange-100 text-orange-700' :
                            (report.status || '').toLowerCase().includes('manutenção') || (report.status || '').toLowerCase().includes('manutencao') ? 'bg-blue-100 text-blue-700' :
                            (report.status || '').toLowerCase().includes('vandalizada') ? 'bg-red-100 text-red-700' :
                            (report.status || '').toLowerCase().includes('estação') || (report.status || '').toLowerCase().includes('estacao') ? 'bg-green-100 text-green-700' :
                            (report.status || '').toLowerCase().includes('nao encontrada') ? 'bg-gray-200 text-gray-800' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {(report.status || '').toUpperCase() === 'FILIAL' ? 'RECOLHIDA' : (report.status || '---')}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-xs font-medium text-gray-700">
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.motorista || editData.driverName || ''} 
                            onChange={e => setEditData({...editData, motorista: e.target.value.toUpperCase(), driverName: e.target.value.toUpperCase()})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.motorista || report.driverName || '---'
                        )}
                      </td>
                      <td className="p-3 text-[10px] text-gray-400 font-bold uppercase">
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.type || ''} 
                            onChange={e => setEditData({...editData, type: e.target.value})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.type || '---'
                        )}
                      </td>
                      <td className="p-3 text-xs text-blue-600 font-bold">
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.carretinha || ''} 
                            onChange={e => setEditData({...editData, carretinha: e.target.value})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.carretinha || '---'
                        )}
                      </td>
                      <td className="p-3 text-xs text-gray-500">
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.statusSistema || ''} 
                            onChange={e => setEditData({...editData, statusSistema: e.target.value})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.statusSistema || '---'
                        )}
                      </td>
                      <td className="p-3 text-xs text-gray-500">
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.bateria || ''} 
                            onChange={e => setEditData({...editData, bateria: e.target.value})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.bateria || '---'
                        )}
                      </td>
                      <td className="p-3 text-xs text-gray-500">
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.trava || ''} 
                            onChange={e => setEditData({...editData, trava: e.target.value})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.trava || '---'
                        )}
                      </td>
                      <td className="p-3 text-xs text-gray-500 max-w-[150px] truncate" title={report.localidade}>
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.localidade || ''} 
                            onChange={e => setEditData({...editData, localidade: e.target.value})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.localidade || '---'
                        )}
                      </td>
                      <td className="p-3 text-xs text-gray-500 max-w-[200px] truncate" title={report.observacao || report.observation}>
                        {isEditing ? (
                          <input 
                            type="text" 
                            value={editData.observacao || editData.observation || ''} 
                            onChange={e => setEditData({...editData, observacao: e.target.value, observation: e.target.value})}
                            className="w-full p-1 border rounded text-xs"
                          />
                        ) : (
                          report.observacao || report.observation || '---'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 bg-gray-50 border-t flex justify-between items-center text-[10px] text-gray-400 font-medium">
          <p>Exibindo {filteredReports.length} registros (Filtrado: Recolhidas, Vandalizadas e Estação)</p>
          <div className="flex items-center gap-3">
            <p>Fonte: Firebase Firestore (Coleção: reports)</p>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block animate-pulse"></span>
              FIREBASE ATIVO
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FirebaseReportModal;