
import React from 'react';
import { XIcon } from './icons';

interface DestinationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (observation: string) => void;
  type: 'Estação' | 'Filial' | 'Vandalizada';
  bikeNumber: string;
  stationName?: string;
  isLoading: boolean;
  onRecalculate?: () => void;
}

const DestinationModal: React.FC<DestinationModalProps> = ({ 
  isOpen, 
  onClose, 
  onConfirm, 
  type, 
  bikeNumber, 
  stationName,
  isLoading,
  onRecalculate
}) => {
  if (!isOpen) return null;

  const filialOptions = [
    "Bateria baixa", 
    "Manutenção Locker", 
    "Manutenção Bicicleta", 
    "Solicitado Recolha"
  ];

  const vandalizedOptions = [
    "Quadro pintado", 
    "pneu solto", 
    "sem pezinho", 
    "sem cesto/placa solar", 
    "Sem Locker", 
    "Sem identificação"
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-[60] animate-fade-in">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="p-4 border-b flex justify-between items-center bg-gray-50">
          <h2 className="text-lg font-bold text-gray-800">
            Destino: {type}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
            <XIcon className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="p-6">
          <p className="text-sm text-gray-600 mb-4">
            Bicicleta: <span className="font-mono font-bold text-gray-900">{bikeNumber}</span>
          </p>

          {type === 'Estação' && (
            <div className="space-y-4">
              <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg flex justify-between items-center">
                <p className="text-sm text-blue-800">
                  Estação detectada: <br />
                  <strong className="text-base">{stationName || 'Buscando localização...'}</strong>
                </p>
                {onRecalculate && (
                  <button 
                    onClick={onRecalculate}
                    disabled={isLoading}
                    className="p-2 text-blue-600 hover:bg-blue-100 rounded-full transition-colors"
                    title="Recalcular localização"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className={`w-5 h-5 ${stationName === 'Buscando...' ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={onClose}
                  disabled={isLoading}
                  className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => onConfirm(stationName || 'Fora da Estação')}
                  disabled={isLoading || !stationName}
                  className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 shadow-md transition-colors disabled:bg-gray-400"
                >
                  {isLoading ? 'Processando...' : 'Confirmar'}
                </button>
              </div>
            </div>
          )}

          {type === 'Filial' && (
            <div className="grid grid-cols-1 gap-2">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Selecione o motivo:</p>
              {filialOptions.map(option => (
                <button
                  key={option}
                  onClick={() => onConfirm(option)}
                  disabled={isLoading}
                  className="w-full text-left p-3 border rounded-lg hover:bg-green-50 hover:border-green-200 transition-all text-sm font-medium text-gray-700 flex justify-between items-center group"
                >
                  {option}
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity text-green-500">→</span>
                </button>
              ))}
              <button
                onClick={onClose}
                className="mt-4 w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Cancelar
              </button>
            </div>
          )}

          {type === 'Vandalizada' && (
            <div className="grid grid-cols-1 gap-2">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Selecione o dano:</p>
              {vandalizedOptions.map(option => (
                <button
                  key={option}
                  onClick={() => onConfirm(option)}
                  disabled={isLoading}
                  className="w-full text-left p-3 border rounded-lg hover:bg-red-50 hover:border-red-200 transition-all text-sm font-medium text-gray-700 flex justify-between items-center group"
                >
                  {option}
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity text-red-500">→</span>
                </button>
              ))}
              <button
                onClick={onClose}
                className="mt-4 w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Cancelar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DestinationModal;
