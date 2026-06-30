import React from 'react';
import { XIcon } from './icons';

interface MechanicRepairModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (treatment: string) => void;
    isLoading: boolean;
    bikeNumber: string;
}

const MechanicRepairModal: React.FC<MechanicRepairModalProps> = ({ isOpen, onClose, onConfirm, isLoading, bikeNumber }) => {
    const repairOptions = [
        "Ajuste e aperto", "Placa", "Cesto", "Banco", "Rodas",
        "Guidão", "Quadro", "Adesivos", "Identificação",
        "Pedal", "Carregamento", "Limpeza",
        "Instalação de Locker", "Troca de Cabo de Freio",
        "Troca Cabo Energia", "Corrente", "Paralamas", "Apoio/Descanso"
    ];

    const [selectedOptions, setSelectedOptions] = React.useState<string[]>([]);

    // Reseta seleções toda vez que o modal abre
    React.useEffect(() => {
        if (isOpen) {
            setSelectedOptions([]);
        }
    }, [isOpen]);

    const toggleOption = (option: string) => {
        setSelectedOptions(prev =>
            prev.includes(option)
                ? prev.filter(o => o !== option)
                : [...prev, option]
        );
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50 animate-fade-in">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
                <div className="bg-orange-600 p-4 flex justify-between items-center text-white">
                    <h2 className="font-bold text-lg">Finalizar Reparo - Bike {bikeNumber}</h2>
                    <button onClick={onClose} className="p-1 hover:bg-orange-700 rounded-full transition-colors">
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-bold text-gray-700 mb-3 uppercase">O que foi reparado?</label>
                        <div className="grid grid-cols-2 gap-2 max-h-[320px] overflow-y-auto pr-2 custom-scrollbar">
                            {repairOptions.map(option => (
                                <button
                                    key={option}
                                    onClick={() => toggleOption(option)}
                                    className={`flex items-center gap-2 p-2 rounded border text-left transition-all ${
                                        selectedOptions.includes(option)
                                            ? 'border-orange-500 bg-orange-50 text-orange-700'
                                            : 'border-gray-200 hover:border-gray-300 text-gray-600'
                                    }`}
                                >
                                    <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${
                                        selectedOptions.includes(option) ? 'bg-orange-500 border-orange-500' : 'bg-white border-gray-300'
                                    }`}>
                                        {selectedOptions.includes(option) && (
                                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                            </svg>
                                        )}
                                    </div>
                                    <span className="text-xs font-medium">{option}</span>
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-gray-500 mt-2 italic">Selecione todas as opções que se aplicam.</p>
                    </div>
                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={onClose}
                            disabled={isLoading}
                            className="flex-1 py-2.5 border border-gray-300 rounded-md text-sm font-bold text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            Cancelar
                        </button>
                        <button
                            onClick={() => onConfirm(selectedOptions.join(', '))}
                            disabled={isLoading || selectedOptions.length === 0}
                            className="flex-1 py-2.5 bg-orange-600 text-white rounded-md text-sm font-bold hover:bg-orange-700 transition-colors shadow-md disabled:bg-gray-400 flex items-center justify-center gap-2"
                        >
                            {isLoading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
                            Finalizar e Enviar para Reserva
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MechanicRepairModal;