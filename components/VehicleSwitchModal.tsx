
import React, { useState, useEffect } from 'react';
import { apiCall } from '../api';
import { XIcon } from './icons';

interface VehicleSwitchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSwitch: (plate: string, kmInicial: number) => void;
  driverName: string;
}

const VehicleSwitchModal: React.FC<VehicleSwitchModalProps> = ({ isOpen, onClose, onSwitch, driverName }) => {
  const [plate, setPlate] = useState('');
  const [kmInicial, setKmInicial] = useState('');
  const [plates, setPlates] = useState<{ plate: string, lastKmFinal: number }[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingPlates, setIsLoadingPlates] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPlates = async () => {
    setIsLoadingPlates(true);
    try {
      const result = await apiCall({ action: 'getVehiclePlates' });
      if (result.success) {
        setPlates(result.data);
      }
    } catch (err) {
      console.error("Failed to fetch plates:", err);
    } finally {
      setIsLoadingPlates(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchPlates();
      setPlate('');
      setKmInicial('');
      setError(null);
    }
  }, [isOpen]);

  const handlePlateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedPlate = e.target.value;
    setPlate(selectedPlate);
    // REMOVIDO: O app não deve sugerir o KM correto nem manter preenchido.
    setKmInicial('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plate || !kmInicial) return;

    setIsLoading(true);
    setError(null);

    try {
      // Re-utilizamos a lógica de login para validar o KM e registrar o INICIO_TURNO
      // No backend, handleLogin já faz tudo o que precisamos se passarmos os dados corretos.
      // Mas para não deslogar o usuário, podemos criar uma ação específica ou apenas validar aqui.
      // O usuário quer que o app SOLICITE a nova placa e KM.
      // Vou usar uma ação 'switchVehicle' no backend para ser mais limpo.
      
      const result = await apiCall({
        action: 'switchVehicle',
        driverName: driverName,
        plate: plate,
        kmInicial: parseFloat(kmInicial)
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
          <h2 className="text-lg font-bold">Trocar Veículo</h2>
          <button onClick={onClose} className="p-1 hover:bg-blue-700 rounded-full transition-colors">
            <XIcon className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-gray-600 mb-4">
            Informe os dados do novo veículo para iniciar uma nova sessão de trabalho.
          </p>

          <div>
            <label htmlFor="modal-plate" className="block text-sm font-medium text-gray-700 mb-1">
              Nova Placa
            </label>
            <select
              id="modal-plate"
              value={plate}
              onChange={handlePlateChange}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              required
              disabled={isLoadingPlates || isLoading}
            >
              <option value="">Selecione a placa</option>
              {plates.map((p) => (
                <option key={p.plate} value={p.plate}>
                  {p.plate}
                </option>
              ))}
            </select>
            {isLoadingPlates && <p className="text-[10px] text-blue-500 mt-1">Carregando placas...</p>}
          </div>

          <div>
            <label htmlFor="modal-km" className="block text-sm font-medium text-gray-700 mb-1">
              KM Inicial do Novo Veículo
            </label>
            <input
              type="number"
              id="modal-km"
              value={kmInicial}
              onChange={(e) => setKmInicial(e.target.value)}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              placeholder="KM do odômetro"
              required
              disabled={isLoading}
            />
          </div>

          {error && (
            <div className="p-3 bg-red-100 text-red-700 rounded-md text-sm">
              {error}
            </div>
          )}

          <div className="pt-4 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 px-4 border border-gray-300 rounded-md text-gray-700 font-medium hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isLoading || !plate || !kmInicial}
              className="flex-1 py-3 px-4 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:bg-gray-400 transition-colors flex justify-center items-center"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                'Confirmar Troca'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default VehicleSwitchModal;
