import React from 'react';
import { XIcon } from './icons';

interface ScheduleModalProps {
    isOpen: boolean;
    onClose: () => void;
    schedule: Record<string, string>;
    driverName: string;
    isLoading?: boolean;
}

const ScheduleModal: React.FC<ScheduleModalProps> = ({ isOpen, onClose, schedule, driverName, isLoading }) => {
    if (!isOpen) return null;

    const getDayOrder = (day: string): number => {
        const upper = day.trim().toUpperCase();
        if (upper.includes('DOMINGO')) return 7;
        if (upper.includes('SEGUNDA')) return 1;
        if (upper.includes('TERÇA') || upper.includes('TERCA')) return 2;
        if (upper.includes('QUARTA')) return 3;
        if (upper.includes('QUINTA')) return 4;
        if (upper.includes('SEXTA')) return 5;
        if (upper.includes('SABADO') || upper.includes('SÁBADO')) return 6;
        return 99;
    };

    // Ordenar as datas (assumindo formato DD/MM/YYYY ou nomes de dias da semana)
    const sortedDates = Object.keys(schedule).sort((a, b) => {
        const orderA = getDayOrder(a);
        const orderB = getDayOrder(b);

        // Se ambos forem dias da semana conhecidos
        if (orderA !== 99 && orderB !== 99) {
            return orderA - orderB;
        }

        // Tentar ordenar por data DD/MM/YYYY
        const partsA = a.split('/');
        const partsB = b.split('/');
        
        if (partsA.length >= 2 && partsB.length >= 2) {
            try {
                const dayA = parseInt(partsA[0], 10);
                const monthA = parseInt(partsA[1], 10) - 1;
                const yearA = partsA.length === 3 ? parseInt(partsA[2], 10) : new Date().getFullYear();
                
                const dayB = parseInt(partsB[0], 10);
                const monthB = parseInt(partsB[1], 10) - 1;
                const yearB = partsB.length === 3 ? parseInt(partsB[2], 10) : new Date().getFullYear();

                const dateA = new Date(yearA, monthA, dayA);
                const dateB = new Date(yearB, monthB, dayB);
                
                if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime())) {
                    return dateA.getTime() - dateB.getTime();
                }
            } catch {
                // Fallback to string compare
            }
        }
        
        // Se um for dia da semana e outro data, prioriza o que vier primeiro na lógica de negócio
        // Aqui vamos apenas usar localeCompare como último recurso
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in-up border border-gray-100">
                <div className="p-5 border-b flex justify-between items-center bg-gradient-to-r from-blue-600 to-blue-700 text-white">
                    <div>
                        <h2 className="text-xl font-bold tracking-tight">Escala de Trabalho</h2>
                        <p className="text-blue-100 text-xs mt-0.5">{driverName}</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/20 rounded-full transition-all active:scale-90">
                        <XIcon className="w-6 h-6" />
                    </button>
                </div>
                
                <div className="p-0 max-h-[65vh] overflow-y-auto bg-gray-50">
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center py-20">
                            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                            <p className="text-gray-500 text-sm font-medium">Buscando sua escala...</p>
                        </div>
                    ) : sortedDates.length > 0 ? (
                        <div className="divide-y divide-gray-100">
                            {sortedDates.map(date => {
                                const status = schedule[date] || '';
                                const isFolga = status.toLowerCase().includes('folga');
                                
                                // Limpa o texto para exibir apenas o horário se houver prefixos como "Entrada:" ou "Saída:"
                                let cleanStatus = status
                                    .replace(/Entrada[:\s]*/gi, '')
                                    .replace(/Saída[:\s]*/gi, '')
                                    .replace(/Saida[:\s]*/gi, '')
                                    .trim();
                                
                                // Se o status parecer uma data longa do JS (comum vindo do Sheets/Excel)
                                // Ex: Sat Dec 30 1899 14:00:00 GMT... - Sat Dec 30 1899 22:00:00 GMT...
                                if (cleanStatus.includes('1899') || cleanStatus.includes('GMT')) {
                                    const timeMatches = cleanStatus.match(/(\d{2}:\d{2})/g);
                                    if (timeMatches && timeMatches.length >= 2) {
                                        // Pega o primeiro e o último horário encontrado
                                        cleanStatus = `${timeMatches[0]} às ${timeMatches[timeMatches.length - 1]}`;
                                    } else if (timeMatches && timeMatches.length === 1) {
                                        cleanStatus = timeMatches[0];
                                    }
                                }
                                
                                return (
                                    <div key={date} className="flex justify-between items-center p-4 bg-white hover:bg-blue-50/30 transition-colors">
                                        <div className="flex flex-col">
                                            <span className="text-sm font-bold text-gray-900">{date}</span>
                                        </div>
                                        <div className={`px-4 py-2 rounded-xl text-sm font-black shadow-sm border tracking-tighter ${
                                            isFolga 
                                            ? 'bg-emerald-50 text-emerald-700 border-emerald-100' 
                                            : 'bg-blue-50 text-blue-700 border-blue-100'
                                        }`}>
                                            {cleanStatus}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
                            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                                <XIcon className="w-8 h-8 text-gray-300" />
                            </div>
                            <p className="text-gray-500 font-medium">Nenhuma escala encontrada.</p>
                            <p className="text-gray-400 text-xs mt-1">Sua escala será exibida aqui assim que for atualizada no sistema.</p>
                        </div>
                    )}
                </div>
                
                <div className="p-5 border-t bg-white flex justify-center">
                    <button 
                        onClick={onClose}
                        className="w-full py-3 bg-gray-900 text-white rounded-xl hover:bg-black active:scale-[0.98] transition-all font-bold text-sm shadow-lg shadow-gray-200"
                    >
                        Entendido
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ScheduleModal;
