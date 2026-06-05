import React, { useState, useEffect, useCallback } from 'react';
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

// =================================================================
// FirebaseReportModal — v2 (fonte: Sheets)
// Substituiu o listener onSnapshot(collection 'reports') pelo
// endpoint getSheetsReportsToday do Code.gs.
// Motivo: banco Firebase anterior compartilhava quota com AI Studio.
// Novo banco (movebikes) começa vazio — Sheets é a fonte de verdade.
// Custo: 0 leituras Firestore por abertura (era ~300).
// =================================================================
const FirebaseReportModal: React.FC<FirebaseReportModalProps> = ({ isOpen, onClose }) => {
  const [reports, setReports] = useState<FirebaseReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(localDateStr());

  // Filters
  const [filterDriver, setFilterDriver] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');

  // Form state
  const [newReport, setNewReport] = useState<Partial<FirebaseReport>>({
    patrimonio: '', status: '', observacao: '', motorista: '', type: 'Manual'
  });

  // =================================================================
  // Busca dados do Sheets via getSheetsReportsToday
  // Suporta qualquer data — não só hoje
  // =================================================================
  const fetchFromSheets = useCallback(async (date?: string) => {
    setIsLoading(true);
    try {
      const res = await apiCall({
        action: 'getSheetsReportsToday',
        category: 'ADM',
        date: date || selectedDate,
      }, 1, true);

      if (!res.success || !res.data) throw new Error(res.error || 'Falha ao buscar dados.');

      const mapped: FirebaseReport[] = (res.data as any[]).map((r, i) => ({
        id: `sheets_${i}_${r.patrimonio}_${r.motorista}`,
        patrimonio: r.patrimonio,
        bikeNumber: r.patrimonio,
        status: r.status,
        observacao: r.observacao,
        motorista: r.motorista,
        driverName: r.motorista,
        statusSistema: r.statusSistema,
        bateria: r.bateria,
        trava: r.trava,
        localidade: r.localidade,
        timestamp: r.timestamp ? new Date(r.timestamp) : new Date(),
        type: 'Sheets',
      }));

      setReports(mapped);
    } catch (e: any) {
      console.error('[RelatórioSheets] Erro:', e.message);
    } finally {
      setIsLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    if (!isOpen) return;
    fetchFromSheets(selectedDate);
  }, [isOpen, selectedDate, fetchFromSheets]);

  // =================================================================
  // Adicionar registro manual — ainda grava no Sheets via logReport
  // =================================================================
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReport.patrimonio || !newReport.status || !newReport.motorista) {
      alert('Preencha os campos obrigatórios (Patrimônio, Status, Motorista).');
      return;
    }
    setIsLoading(true);
    try {
      const bikeRes = await apiCall({ action: 'searchBike', bikeNumber: newReport.patrimonio });
      const bikeData = bikeRes.success ? bikeRes.data : {};

      await apiCall({
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
          newReport.localidade || bikeData['Localidade'] || '',
        ]
      }, 1, true);

      setNewReport({ patrimonio: '', status: '', observacao: '', motorista: '', type: 'Manual' });
      setIsAdding(false);
      await fetchFromSheets(selectedDate);
    } catch (err: any) {
      console.error(err);
      alert('Erro ao adicionar registro.');
    } finally {
      setIsLoading(false);
    }
  };

  // Edição e exclusão desabilitadas para registros do Sheets
  // (somente registros manuais podem ser editados futuramente)
  const handleStartEdit = (report: FirebaseReport) => {
    if (report.type === 'Sheets') {
      alert('Registros do Sheets não podem ser editados aqui. Edite diretamente na planilha.');
      return;
    }
    setEditingId(report.id || null);
  };

  const handleCancelEdit = () => { setEditingId(null); };

  const handleSaveEdit = async () => {
    alert('Edição de registros será implementada em breve.');
    setEditingId(null);
  };

  const handleDelete = async () => {
    alert('Exclusão de registros do Sheets deve ser feita diretamente na planilha.');
  };



  // =================================================================
  // Filtros
  // =================================================================
  const allowedReports = reports.filter(r => {
    const statusLow = (r.status || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const typeLow = (r.type || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const motoristaLow = (r.motorista || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isAllowed = statusLow.includes('recolhida') || statusLow.includes('vandalizada') ||
      statusLow.includes('estacao') || statusLow.includes('filial') || statusLow.includes('nao encontrada');
    const isMecanica = motoristaLow.includes('mecanica') || typeLow.includes('mecanica');
    const isTrailer = statusLow.includes('carretinha') || typeLow === 'logistica';
    return isAllowed && !isMecanica && !isTrailer;
  });

  const filteredReports = allowedReports.filter(r => {
    const p = (r.patrimonio || r.bikeNumber || '').toLowerCase();
    const m = (r.motorista || r.driverName || '').toLowerCase();
    const s = (r.status || '').toLowerCase();
    const o = (r.observacao || '').toLowerCase();
    const matchesSearch = !searchTerm ||
      p.includes(searchTerm.toLowerCase()) || m.includes(searchTerm.toLowerCase()) ||
      s.includes(searchTerm.toLowerCase()) || o.includes(searchTerm.toLowerCase());
    const matchesDriver = !filterDriver || m === filterDriver.toLowerCase();
    const displayStatus = (r.status || '').toUpperCase() === 'FILIAL' ? 'RECOLHIDA' : (r.status || '').toUpperCase();
    const matchesStatus = !filterStatus || displayStatus === filterStatus.toUpperCase();
    let matchesDate = true;
    if (r.timestamp instanceof Date) {
      const rd = new Date(r.timestamp); rd.setHours(0, 0, 0, 0);
      if (filterStartDate) { const s = new Date(filterStartDate); s.setHours(0,0,0,0); if (rd < s) matchesDate = false; }
      if (filterEndDate)   { const e = new Date(filterEndDate);   e.setHours(0,0,0,0); if (rd > e) matchesDate = false; }
    }
    return matchesSearch && matchesDriver && matchesStatus && matchesDate;
  });

  const uniqueDrivers = Array.from(new Set(allowedReports.map(r => r.motorista || r.driverName).filter(Boolean))).sort() as string[];
  const uniqueStatuses = Array.from(new Set(allowedReports.map(r =>
    (r.status || '').toUpperCase() === 'FILIAL' ? 'RECOLHIDA' : (r.status || '').toUpperCase()
  ).filter(Boolean))).sort() as string[];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[100] animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-7xl flex flex-col max-h-[95vh] overflow-hidden animate-scale-in">

        {/* Header */}
        <div className="p-4 border-b bg-gray-50">
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
            {/* Seletor de data */}
            <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
              <span className="text-xs text-gray-500 font-medium">Data:</span>
              <input
                type="date"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value || localDateStr())}
                className="text-xs outline-none bg-transparent"
              />
            </div>

            <div className="relative">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Buscar patrimônio..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none w-48"
              />
            </div>

            <select value={filterDriver} onChange={e => setFilterDriver(e.target.value)}
              className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none max-w-[150px]">
              <option value="">Todos Motoristas</option>
              {uniqueDrivers.map(d => <option key={d} value={d}>{d}</option>)}
            </select>

            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none max-w-[150px]">
              <option value="">Todos Status</option>
              {uniqueStatuses.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-2 py-1">
              <input type="date" value={filterStartDate} onChange={e => setFilterStartDate(e.target.value)}
                className="text-xs outline-none bg-transparent" title="Data Inicial" />
              <span className="text-gray-400 text-xs">até</span>
              <input type="date" value={filterEndDate} onChange={e => setFilterEndDate(e.target.value)}
                className="text-xs outline-none bg-transparent" title="Data Final" />
            </div>

            {(filterDriver || filterStatus || filterStartDate || filterEndDate || searchTerm) && (
              <button onClick={() => { setFilterDriver(''); setFilterStatus(''); setFilterStartDate(''); setFilterEndDate(''); setSearchTerm(''); }}
                className="text-[10px] font-bold text-red-500 hover:text-red-700 uppercase tracking-tighter px-2">
                Limpar Filtros
              </button>
            )}

            <div className="flex-1" />

            <button onClick={() => setIsAdding(!isAdding)}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-bold hover:bg-green-700 transition-all active:scale-95">
              <PlusIcon className="w-4 h-4" />
              Novo Registro
            </button>


          </div>
        </div>

        {/* Add Form */}
        {isAdding && (
          <form onSubmit={handleAdd} className="p-4 bg-green-50 border-b grid grid-cols-1 sm:grid-cols-3 md:grid-cols-6 gap-3 animate-slide-down">
            {[
              { ph: 'Patrimônio', key: 'patrimonio', upper: true },
              { ph: 'Status', key: 'status', upper: false },
              { ph: 'Motorista', key: 'motorista', upper: true },
              { ph: 'Localidade', key: 'localidade', upper: false },
              { ph: 'Status Sistema', key: 'statusSistema', upper: false },
              { ph: 'Observação', key: 'observacao', upper: false },
            ].map(({ ph, key, upper }) => (
              <input key={key} type="text" placeholder={ph} required={['patrimonio','status','motorista'].includes(key)}
                value={(newReport as any)[key] || ''}
                onChange={e => setNewReport({ ...newReport, [key]: upper ? e.target.value.toUpperCase() : e.target.value })}
                className="p-2 border border-green-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-green-500" />
            ))}
            <div className="flex gap-2 sm:col-span-3 md:col-span-6 justify-end">
              <button type="button" onClick={() => setIsAdding(false)}
                className="px-6 py-2 bg-gray-200 text-gray-600 font-bold rounded-lg text-sm hover:bg-gray-300">Cancelar</button>
              <button type="submit"
                className="px-8 py-2 bg-green-600 text-white font-bold rounded-lg text-sm hover:bg-green-700">Salvar Registro</button>
            </div>
          </form>
        )}

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <RefreshIcon className="w-10 h-10 text-green-500 animate-spin" />
              <p className="text-gray-500 font-medium">Carregando dados da planilha...</p>
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
                  {['Ações','Data/Hora','Patrimônio','Status','Motorista','Tipo','Carretinha','Status Sistema','Bateria','Trava','Localidade','Observação'].map(h => (
                    <th key={h} className={`p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b ${h === 'Ações' ? 'sticky left-0 bg-gray-100 z-20 w-20 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]' : ''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredReports.map(report => {
                  const isEditing = editingId === report.id;
                  return (
                    <tr key={report.id} className={`hover:bg-gray-50 transition-colors group ${isEditing ? 'bg-blue-50/50' : ''}`}>
                      <td className={`p-3 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] ${isEditing ? 'bg-blue-50' : 'bg-white group-hover:bg-gray-50'}`}>
                        <div className="flex items-center gap-1">
                          {isEditing ? (
                            <>
                              <button onClick={handleSaveEdit} className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg" title="Salvar"><CheckIcon className="w-4 h-4" /></button>
                              <button onClick={handleCancelEdit} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg" title="Cancelar"><XIcon className="w-4 h-4" /></button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => handleStartEdit(report)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg" title="Editar"><EditIcon className="w-4 h-4" /></button>
                              <button onClick={handleDelete} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Excluir"><TrashIcon className="w-4 h-4" /></button>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-[11px] text-gray-500 whitespace-nowrap">
                        {report.timestamp instanceof Date ? report.timestamp.toLocaleString('pt-BR') : '---'}
                      </td>
                      <td className="p-3 text-sm font-bold text-gray-900">{report.patrimonio || report.bikeNumber || '---'}</td>
                      <td className="p-3">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase whitespace-nowrap ${
                          (report.status||'').toLowerCase().includes('recolhida')||(report.status||'').toLowerCase().includes('filial') ? 'bg-orange-100 text-orange-700' :
                          (report.status||'').toLowerCase().includes('vandalizada') ? 'bg-red-100 text-red-700' :
                          (report.status||'').toLowerCase().includes('estacao')||(report.status||'').toLowerCase().includes('estação') ? 'bg-green-100 text-green-700' :
                          (report.status||'').toLowerCase().includes('nao encontrada') ? 'bg-gray-200 text-gray-800' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {(report.status||'').toUpperCase()==='FILIAL' ? 'RECOLHIDA' : (report.status||'---')}
                        </span>
                      </td>
                      <td className="p-3 text-xs font-medium text-gray-700">{report.motorista || report.driverName || '---'}</td>
                      <td className="p-3 text-[10px] text-gray-400 font-bold uppercase">{report.type || '---'}</td>
                      <td className="p-3 text-xs text-blue-600 font-bold">{(report as any).carretinha || '---'}</td>
                      <td className="p-3 text-xs text-gray-500">{report.statusSistema || '---'}</td>
                      <td className="p-3 text-xs text-gray-500">{report.bateria || '---'}</td>
                      <td className="p-3 text-xs text-gray-500">{report.trava || '---'}</td>
                      <td className="p-3 text-xs text-gray-500 max-w-[150px] truncate" title={report.localidade}>{report.localidade || '---'}</td>
                      <td className="p-3 text-xs text-gray-500 max-w-[200px] truncate" title={report.observacao}>{report.observacao || '---'}</td>
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
            <p>Fonte: Google Sheets (via API)</p>
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