import React, { useState, useEffect, useCallback } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer 
} from 'recharts';
import { 
  Bike, ArrowLeft, 
  Download, RefreshCw, AlertCircle
} from 'lucide-react';

interface DashboardData {
  driver: string;
  recolhidas: number;
  remanejadas: number;
  totalBikes: number;
  solicitacoesRecebidas: number;
  solicitacoesAtendidas: number;
  percOcorrencia: number;
}

interface AnalyticalDashboardProps {
  onClose: () => void;
  apiCall: (action: string, data?: any) => Promise<any>;
}

export const AnalyticalDashboard: React.FC<AnalyticalDashboardProps> = ({ onClose, apiCall }) => {
  const [timeRange, setTimeRange] = useState<string>('day');
  const [data, setData] = useState<DashboardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const timeRanges = [
    { key: 'day', label: 'Hoje' },
    { key: '-1', label: 'Ontem' },
    { key: 'week', label: 'Semana Atual' },
    { key: '-7', label: 'Semana Anterior' },
    { key: 'month', label: 'Mês Atual' },
    { key: '-30', label: 'Mês Anterior' },
  ];

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

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
          >
            <ArrowLeft className="w-6 h-6 text-gray-600" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Dashboard Analítico</h1>
            <p className="text-xs text-gray-500">Análise de desempenho dos motoristas</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="bg-gray-100 p-1 rounded-lg flex gap-1 overflow-x-auto max-w-[300px] sm:max-w-none no-scrollbar">
            {timeRanges.map((range) => (
              <button
                key={range.key}
                onClick={() => setTimeRange(range.key)}
                className={`px-3 py-1 text-[10px] sm:text-xs font-medium rounded-md transition-all whitespace-nowrap ${
                  timeRange === range.key 
                    ? 'bg-white text-blue-600 shadow-sm' 
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
          <button 
            onClick={fetchData}
            className="p-2 hover:bg-gray-100 rounded-full text-gray-500 transition-colors"
            disabled={loading}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-4 lg:p-8">
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
            <p className="text-gray-500 animate-pulse">Carregando análises...</p>
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
              {/* Bikes per Driver */}
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
                <button className="text-blue-600 text-sm font-medium hover:underline flex items-center gap-1">
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
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${
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
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
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
