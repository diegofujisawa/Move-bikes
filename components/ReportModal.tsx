
import React, { useState, useEffect } from 'react';
import { DocumentTextIcon } from './icons';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  driverName: string;
  plate?: string;
  kmInicial?: number;
}

import { apiCall } from '../api';

const ReportModal: React.FC<ReportModalProps> = ({ isOpen, onClose, driverName, plate, kmInicial }) => {
  const [reportText, setReportText] = useState('Gerando relatório...');
  const [copyButtonText, setCopyButtonText] = useState('Copiar');
  const [kmFinal, setKmFinal] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reportData, setReportData] = useState<any>(null);

  const generateReportText = (data: any, finalKmStr: string) => {
    if (!data) return 'Gerando relatório...';
    
    const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });

    const formatList = (list?: string[]) => (list && list.length > 0) ? list.join(', ') : 'Nenhuma';
    const formatMultilineList = (list?: string[]) => (list && list.length > 0) ? list.join('\n') : 'Nenhuma';

    // Calcula KM rodado total (incluindo a sessão atual se o KM Final foi digitado)
    let totalKm = data.totalKmRodado || 0;
    const kmFinalNum = parseFloat(finalKmStr) || 0;
    if (kmFinalNum > 0 && kmInicial !== undefined) {
      const currentDiff = kmFinalNum - kmInicial;
      if (currentDiff > 0) {
        totalKm += currentDiff;
      }
    }

    const plates = Array.from(new Set([...(data.platesUsed || [])]));
    const platesStr = plates.length > 0 ? plates.join(' / ') : 'N/A';

    const formatTime = (dateStr: string | null) => {
      if (!dateStr) return '--:--';
      const d = new Date(dateStr);
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    };

    const report = `📋 *RELATÓRIO DIÁRIO DE JORNADA*
📅 *Data:* ${today}
👤 *Motorista:* ${driverName}
🚗 *Veículo (Placa):* ${platesStr}
🛣️ *KM Total Rodado:* ${totalKm.toFixed(1)} km
⏰ *Horário:* ${formatTime(data.startTime)} às ${formatTime(data.endTime)}

---
📊 *RESUMO DE ATIVIDADES*
🏢 *Filial:*
  🔋 Bateria Baixa: ${data.counts?.bateriaBaixa || 0}
  🚲 Manutenção Bicicleta: ${data.counts?.manutencaoBicicleta || 0}
  🔒 Manutenção Locker: ${data.counts?.manutencaoLocker || 0}
  📋 Solicitado Recolha: ${data.counts?.solicitadoRecolha || 0}
🚉 *Bikes Remanejadas (Estação):* ${data.remanejadas?.length || 0}
⚠️ *Ocorrências Atendidas:* ${data.ocorrencias?.length || 0}
🔍 *Bikes Não Encontradas:* ${data.naoEncontrada?.length || 0}
❌ *Bikes Vandalizadas:* ${data.vandalizadas?.length || 0}

---
📝 *DETALHAMENTO*
✅ *Recolhidas (Filial):* ${formatList(data.recolhidas)}
✅ *Remanejadas (Estação):* ${formatList(data.remanejadas)}
📍 *Estações Abastecidas:*
${Object.entries(data.estacoes || {}).map(([name, count]) => `• ${name}: ${count} bike(s)`).join('\n') || 'Nenhuma'}

⚠️ *Ocorrências:* ${formatMultilineList(data.ocorrencias)}
❌ *Vandalizadas:* ${formatList(data.vandalizadas)}

---
💬 *OBSERVAÇÕES:*
`;
    return report.trim();
  };

  const fetchAndGenerateReport = async () => {
    setReportText('Gerando relatório...');
    try {
      const result = await apiCall({ action: 'getDailyReportData', driverName });
      if (result.success && result.data) {
        setReportData(result.data);
        setReportText(generateReportText(result.data, kmFinal));
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
  }, [isOpen]);

  useEffect(() => {
    if (reportData) {
      setReportText(generateReportText(reportData, kmFinal));
    }
  }, [kmFinal, reportData]);

  if (!isOpen) return null;

  const copyToClipboard = async (text: string) => {
    try {
      // Tenta usar a API moderna primeiro
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      throw new Error('Clipboard API not available');
    } catch (err) {
      console.warn('Falha ao copiar com navigator.clipboard, tentando fallback:', err);
      try {
        // Fallback usando elemento temporário
        const textArea = document.createElement("textarea");
        textArea.value = text;
        
        // Garante que o elemento não seja visível mas esteja no DOM
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
      } catch (fallbackErr) {
        console.error('Erro no fallback de cópia:', fallbackErr);
        return false;
      }
    }
  };

  const handleCopy = async () => {
    if (!kmFinal) {
      alert("Por favor, insira o KM Final antes de copiar o relatório.");
      return;
    }

    const kmFinalNum = parseFloat(kmFinal) || 0;
    if (kmInicial !== undefined && kmFinalNum < kmInicial) {
      alert(`O KM Final (${kmFinalNum}) não pode ser menor que o KM Inicial (${kmInicial}). Por favor, verifique o odômetro.`);
      return;
    }

    // Tenta copiar IMEDIATAMENTE para garantir que o contexto de clique do usuário seja preservado.
    // Muitos navegadores bloqueiam a cópia se ela ocorrer após um 'await' de rede longo.
    const textToCopy = generateReportText(reportData, kmFinal);
    const copied = await copyToClipboard(textToCopy);
    
    if (copied) {
      setCopyButtonText('Copiado!');
    } else {
      console.error("Falha ao copiar automaticamente.");
    }

    setIsSubmitting(true);
    try {
      // 1. Calcula KM total final
      let totalKm = reportData?.totalKmRodado || 0;
      if (kmFinalNum > 0 && kmInicial !== undefined) {
        const currentDiff = kmFinalNum - kmInicial;
        if (currentDiff > 0) totalKm += currentDiff;
      }

      // 2. Salva o resumo diário na nova aba
      await apiCall({
        action: 'saveDailySummary',
        summaryData: {
          driverName,
          plates: reportData?.platesUsed?.join(' / ') || 'N/A',
          totalKm,
          bateriaCount: reportData?.counts?.bateriaBaixa || 0,
          manutBikeCount: reportData?.counts?.manutencaoBicicleta || 0,
          manutLockerCount: reportData?.counts?.manutencaoLocker || 0,
          solicitadoRecolhaCount: reportData?.counts?.solicitadoRecolha || 0,
          remanejadasCount: reportData?.remanejadas?.length || 0,
          ocorrenciasCount: reportData?.ocorrencias?.length || 0,
          naoEncontradasCount: reportData?.naoEncontrada?.length || 0,
          vandalizadasCount: reportData?.vandalizadas?.length || 0,
          startTime: reportData?.startTime,
          endTime: new Date().toISOString(),
          obs: ''
        }
      });

      // 3. Registra o FIM_TURNO no servidor
      const result = await apiCall({ 
        action: 'logReport', 
        rowData: [new Date().toISOString(), 'SISTEMA', 'FIM_TURNO', `KM Final: ${kmFinal}`, driverName],
        kmFinal: parseFloat(kmFinal),
        plate: plate
      });

      if (result.success) {
        if (!copied) {
          alert("O relatório foi salvo e o KM Final registrado, mas não foi possível copiar automaticamente devido a restrições do navegador. Por favor, selecione o texto abaixo e copie manualmente.");
        }
        
        setTimeout(() => {
          setCopyButtonText('Copiar');
          alert("Relatório salvo e KM Final registrado com sucesso!");
          onClose();
        }, 1500);
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