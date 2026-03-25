import React, { useState, useEffect } from 'react';
import { apiCall } from '../api';
import { XIcon } from './icons';

interface VehicleSwitchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSwitch: (plate: string, kmInicial: number) => void;
  driverName: string;
  currentPlate?: string;
}

const VehicleSwitchModal: React.FC<VehicleSwitchModalProps> = ({ isOpen, onClose, onSwitch, driverName, currentPlate }) => {
  const [kmFinalAtual, setKmFinalAtual] = useState('');
  const [plate, setPlate] = useState('');
  const [kmInicial, setKmInicial] = useState('');
  const [plates, setPlates] = useState<{ plate: string }[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingPlates, setIsLoadingPlates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1); // 1 = km final atual, 2 = novo veículo

  const fetchPlates = async () => {
    setIsLoadingPlates(true);
    try {
      const result = await apiCall({ action: 'getVehiclePlates' });
      if (result.success) setPlates(result.data);
    } catch (err) {
      console.error('Failed to fetch plates:', err);
    } finally {
      setIsLoadingPlates(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchPlates();
      setKmFinalAtual('');
      setPlate('');
      setKmInicial('');
      setError(null);
      setStep(1);
    }
  }, [isOpen]);

  const handleConfirmStep1 = () => {
    if (!kmFinalAtual || parseFloat(kmFinalAtual) <= 0) {
      setError('Informe o KM final do veículo atual.');
      return;
    }
    setError(null);
    setStep(2);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plate || !kmInicial || !kmFinalAtual) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await apiCall({
        action: 'switchVehicle',
        driverName,
        plate,
        kmInicial: parseFloat(kmInicial),
        kmFinalAtual: parseFloat(kmFinalAtual),
        currentPlate: currentPlate || ''
      });

      if (result.success) {
        onSwitch(plate, parseFloat(kmInicial));
        onClose();
      } else {
        setError(result.error || 'Erro ao trocar de veículo.');
      }
    } catch (err: any) {
      setError(err.message || 'Erro de comunicação.');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[1000] backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in-up">
        <div className="bg-blue-600 p-4 flex justify-between items-center text-white">
          <div>
            <h2 className="text-lg font-bold">Trocar Veículo</h2>
            <p className="text-xs opacity-80">Passo {step} de 2</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-blue-700 rounded-full transition-colors">
            <XIcon className="w-6 h-6" />
          </button>
        </div>

        {/* Indicador de progresso */}
        <div className="flex">
          <div className={`h-1 flex-1 transition-colors ${step >= 1 ? 'bg-blue-600' : 'bg-gray-200'}`} />
          <div className={`h-1 flex-1 transition-colors ${step >= 2 ? 'bg-blue-600' : 'bg-gray-200'}`} />
        </div>

        <div className="p-6 space-y-4">
          {step === 1 && (
            <>
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-sm font-bold text-yellow-800 mb-1">
                  🚗 Veículo atual{currentPlate ? `: ${currentPlate}` : ''}
                </p>
                <p className="text-xs text-yellow-700">
                  Registre o KM final do odômetro antes de trocar de veículo.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  KM Final do Veículo Atual
                </label>
                <input
                  type="number"
                  value={kmFinalAtual}
                  onChange={e => setKmFinalAtual(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-lg font-bold"
                  placeholder="KM do odômetro atual"
                  autoFocus
                />
              </div>

              {error && <div className="p-3 bg-red-100 text-red-700 rounded-md text-sm">{error}</div>}

              <div className="pt-2 flex gap-3">
                <button type="button" onClick={onClose}
                  className="flex-1 py-3 px-4 border border-gray-300 rounded-md text-gray-700 font-medium hover:bg-gray-50">
                  Cancelar
                </button>
                <button type="button" onClick={handleConfirmStep1}
                  disabled={!kmFinalAtual}
                  className="flex-1 py-3 px-4 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:bg-gray-400">
                  Próximo →
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm font-bold text-green-800 mb-1">✅ KM Final registrado: {kmFinalAtual} km</p>
                <p className="text-xs text-green-700">Agora informe os dados do novo veículo.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nova Placa</label>
                <select
                  value={plate}
                  onChange={e => setPlate(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  required
                  disabled={isLoadingPlates || isLoading}
                >
                  <option value="">Selecione a placa</option>
                  {plates
                    .filter(p => p.plate !== currentPlate) // oculta o carro atual
                    .map(p => (
                      <option key={p.plate} value={p.plate}>{p.plate}</option>
                    ))}
                </select>
                {isLoadingPlates && <p className="text-[10px] text-blue-500 mt-1">Carregando placas...</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">KM Inicial do Novo Veículo</label>
                <input
                  type="number"
                  value={kmInicial}
                  onChange={e => setKmInicial(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-lg font-bold"
                  placeholder="KM do odômetro"
                  required
                  disabled={isLoading}
                />
              </div>

              {error && <div className="p-3 bg-red-100 text-red-700 rounded-md text-sm">{error}</div>}

              <div className="pt-2 flex gap-3">
                <button type="button" onClick={() => { setStep(1); setError(null); }}
                  className="flex-1 py-3 px-4 border border-gray-300 rounded-md text-gray-700 font-medium hover:bg-gray-50">
                  ← Voltar
                </button>
                <button type="submit"
                  disabled={isLoading || !plate || !kmInicial}
                  className="flex-1 py-3 px-4 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:bg-gray-400 flex justify-center items-center">
                  {isLoading
                    ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : 'Confirmar Troca'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default VehicleSwitchModal;