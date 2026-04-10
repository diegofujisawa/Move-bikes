import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  orderBy, 
  limit, 
  onSnapshot, 
  deleteDoc, 
  doc, 
  addDoc, 
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { db } from '../firebase';
import { FirebaseReport } from '../types';
import { 
  XIcon, 
  PlusIcon, 
  TrashIcon, 
  SheetIcon,
  SearchIcon,
  RefreshIcon
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
    const q = query(collection(db, 'reports'), orderBy('timestamp', 'desc'), limit(100));
    
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

    try {
      await addDoc(collection(db, 'reports'), {
        ...newReport,
        timestamp: serverTimestamp(),
        type: newReport.type || 'Manual'
      });
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
    }
  };

  const filteredReports = reports.filter(r => {
    const p = (r.patrimonio || r.bikeNumber || '').toLowerCase();
    const m = (r.motorista || r.driverName || '').toLowerCase();
    const s = (r.status || '').toLowerCase();
    const o = (r.observacao || r.observation || '').toLowerCase();
    const l = (r.localidade || '').toLowerCase();
    const st = (r.statusSistema || '').toLowerCase();
    
    return p.includes(searchTerm.toLowerCase()) ||
           m.includes(searchTerm.toLowerCase()) ||
           s.includes(searchTerm.toLowerCase()) ||
           o.includes(searchTerm.toLowerCase()) ||
           l.includes(searchTerm.toLowerCase()) ||
           st.includes(searchTerm.toLowerCase());
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[100] animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-7xl flex flex-col max-h-[95vh] overflow-hidden animate-scale-in">
        
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-2">
            <SheetIcon className="w-6 h-6 text-green-600" />
            <h2 className="text-xl font-black text-gray-800 uppercase tracking-tight">Relatório Firebase</h2>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input 
                type="text" 
                placeholder="Buscar por patrimônio, motorista, status..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none w-80"
              />
            </div>
            <button 
              onClick={() => setIsAdding(!isAdding)}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-bold hover:bg-green-700 transition-all active:scale-95"
            >
              <PlusIcon className="w-4 h-4" />
              Novo Registro
            </button>
            <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
              <XIcon className="w-6 h-6 text-gray-500" />
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
                  <th className="p-3 text-[10px] font-black text-gray-600 uppercase tracking-wider border-b w-16">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredReports.map((report) => (
                  <tr key={report.id} className="hover:bg-gray-50 transition-colors group">
                    <td className="p-3 text-[11px] text-gray-500 whitespace-nowrap">
                      {report.timestamp instanceof Date ? report.timestamp.toLocaleString('pt-BR') : '---'}
                    </td>
                    <td className="p-3 text-sm font-bold text-gray-900">
                      {report.patrimonio || report.bikeNumber || '---'}
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase whitespace-nowrap ${
                        (report.status || '').toLowerCase().includes('recolhida') ? 'bg-orange-100 text-orange-700' :
                        (report.status || '').toLowerCase().includes('manutenção') ? 'bg-blue-100 text-blue-700' :
                        (report.status || '').toLowerCase().includes('vandalizada') ? 'bg-red-100 text-red-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {report.status || '---'}
                      </span>
                    </td>
                    <td className="p-3 text-xs font-medium text-gray-700">
                      {report.motorista || report.driverName || '---'}
                    </td>
                    <td className="p-3 text-[10px] text-gray-400 font-bold uppercase">
                      {report.type || '---'}
                    </td>
                    <td className="p-3 text-xs text-blue-600 font-bold">
                      {report.carretinha || '---'}
                    </td>
                    <td className="p-3 text-xs text-gray-500">
                      {report.statusSistema || '---'}
                    </td>
                    <td className="p-3 text-xs text-gray-500">
                      {report.bateria || '---'}
                    </td>
                    <td className="p-3 text-xs text-gray-500">
                      {report.trava || '---'}
                    </td>
                    <td className="p-3 text-xs text-gray-500 max-w-[150px] truncate" title={report.localidade}>
                      {report.localidade || '---'}
                    </td>
                    <td className="p-3 text-xs text-gray-500 max-w-[200px] truncate" title={report.observacao || report.observation}>
                      {report.observacao || report.observation || '---'}
                    </td>
                    <td className="p-3 text-right">
                      <button 
                        onClick={() => report.id && handleDelete(report.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                        title="Excluir"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 bg-gray-50 border-t flex justify-between items-center text-[10px] text-gray-400 font-medium">
          <p>Exibindo {filteredReports.length} registros recentes</p>
          <p>Fonte: Firebase Firestore (Coleção: reports)</p>
        </div>
      </div>
    </div>
  );
};

export default FirebaseReportModal;
