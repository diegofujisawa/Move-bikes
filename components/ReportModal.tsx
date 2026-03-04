
import React, { useState, useEffect } from 'react';
import { DailyActivity } from '../types';
import { DocumentTextIcon } from './icons';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  driverName: string;
  kmInicial?: number;
  activity: DailyActivity;
}

import { apiCall } from '../api';

const ReportModal: React.FC<ReportModalProps> = ({ isOpen, onClose, driverName, kmInicial }) => {
  const [reportText, setReportText] = useState('Gerando relatório...');
  const [copyButtonText, setCopyButtonText] = useState('Copiar');
  const [kmFinal, setKmFinal] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchAndGenerateReport = async () => {
    setReportText('Gerando relatório...');
    try {
      const result = await apiCall({ action: 'getDailyReportData', driverName });
      if (result.success && result.data) {
        const data = result.data;
        const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });

        const formatList = (list?: string[]) => (list && list.length > 0) ? list.join(', ') : 'Nenhuma';
        const formatMultilineList = (list?: string[]) => (list && list.length > 0) ? list.join('\n') : 'Nenhuma';

        const kmFinalNum = parseFloat(kmFinal) || 0;
        const kmRodado = kmInicial !== undefined ? (kmFinalNum - kmInicial).toFixed(1) : 'N/A';

        const report = `Plantão ${driverName}
   ${today}
   🚗 *KM Inicial:* ${kmInicial ?? 'N/A'}
   🏁 *KM Final:* ${kmFinal || 'Pendente'}
   🛣️ *KM Rodado:* ${kmRodado}

 ☑️ *Recolhidas e Remanejadas*
${formatList(data.remanejadas)}

 ☑️  *Remanejadas da filial*
${formatList(data.recolhidas)}

 ☑️ *Estações* 
${formatMultilineList(data.estacoes)}

 ☑️ *Ocorrência* 
${formatMultilineList(data.ocorrencias)}

 ☑️ *Não encontrada* 
${formatList(data.naoEncontrada)}

 ☑️ *Vandalizadas*
${formatList(data.vandalizadas)}

 ☑️ *Revisão*     
${formatList(data.revisao)}

 ☑️ *Locker* 
0

 ☑️  *OBS*
`;
        setReportText(report.trim());
      } else {
        setReportText(`Erro ao gerar relatório: ${result.error || 'Erro desconhecido.'}`);
      }
    } catch (err: any) {
      setReportText(`Erro de comunicação: ${err.message}`);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchAndGenerateReport();
      setCopyButtonText('Copiar');
    }
  }, [isOpen, driverName, kmFinal]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    if (!kmFinal) {
      alert("Por favor, insira o KM Final antes de copiar o relatório.");
      return;
    }

    setIsSubmitting(true);
    try {
      // Atualiza o KM Final no servidor antes de permitir a cópia
      // O logReport no backend agora aceita kmFinal
      // No entanto, o logReport é chamado para cada ação. 
      // Aqui precisamos de uma ação específica para finalizar o turno ou apenas atualizar o KM.
      // Vou usar uma ação genérica ou reaproveitar logReport com dados vazios se necessário.
      // Na verdade, o logReport é para cada bike.
      // Vamos criar uma ação 'updateKmFinal' ou similar.
      // Mas o usuário disse: "será necessário digitar o KM final no campo de Gerar relatorio, para poder liberar o botão de copiar."
      
      // Vamos apenas enviar o KM final para o servidor.
      const result = await apiCall({ 
        action: 'logReport', 
        rowData: [new Date().toISOString(), 'SISTEMA', 'FIM_TURNO', `KM Final: ${kmFinal}`, driverName],
        kmFinal: parseFloat(kmFinal)
      });

      if (result.success) {
        navigator.clipboard.writeText(reportText);
        setCopyButtonText('Copiado!');
        setTimeout(() => setCopyButtonText('Copiar'), 2000);
      } else {
        alert("Erro ao salvar KM Final: " + result.error);
      }
    } catch (err: any) {
      alert("Erro de comunicação: " + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white p-6 rounded-xl shadow-lg w-full max-w-lg relative max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 text-2xl font-bold">&times;</button>
        <div className="flex items-center mb-4">
          <DocumentTextIcon className="w-8 h-8 text-blue-600" />
          <h2 className="text-xl font-bold text-gray-800 ml-2">Relatório do Dia</h2>
        </div>

        <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
          <label htmlFor="kmFinal" className="block text-sm font-bold text-blue-800 mb-1">
            KM Final do Veículo
          </label>
          <input
            type="number"
            id="kmFinal"
            value={kmFinal}
            onChange={(e) => setKmFinal(e.target.value)}
            placeholder="Digite o KM final do odômetro"
            className="w-full p-2 border border-blue-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-sm"
          />
          <p className="text-[10px] text-blue-600 mt-1 italic">Obrigatório para liberar a cópia do relatório.</p>
        </div>

        <textarea
          readOnly
          value={reportText}
          className="w-full h-64 p-3 border border-gray-300 rounded-md bg-gray-50 font-mono text-sm whitespace-pre-wrap"
        />
        <button
          onClick={handleCopy}
          disabled={!kmFinal || isSubmitting}
          className="mt-4 w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {isSubmitting ? 'Salvando...' : copyButtonText}
        </button>
      </div>
    </div>
  );
};

export default ReportModal;