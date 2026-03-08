
import React, { useState, useEffect, useRef } from 'react';
import { BicycleIcon } from './icons';
import { DriverLocation } from '../types';

interface RequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (details: { bikeNumber: string; location: string; reason: string; recipient: string; }) => void;
  isLoading: boolean;
  motoristas: string[];
  driverLocations: DriverLocation[];
  error: string | null;
  clearError: () => void;
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
    ;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

// Hook customizado para obter o valor anterior de uma prop ou estado.
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

const RequestModal: React.FC<RequestModalProps> = ({ isOpen, onClose, onSubmit, isLoading, motoristas, driverLocations, error, clearError }) => {
  const [bikeNumber, setBikeNumber] = useState('');
  const [location, setLocation] = useState('');
  const [reason, setReason] = useState('');
  const [recipient, setRecipient] = useState('Todos');
  const [bikeCoords, setBikeCoords] = useState<{ lat: number, lng: number } | null>(null);

  const prevIsOpen = usePrevious(isOpen);

  const [driverDistances, setDriverDistances] = useState<Record<string, string>>({});

  // Efeito para calcular distâncias via Haversine (Gratuito)
  useEffect(() => {
    if (!bikeCoords || driverLocations.length === 0) return;

    const newDistances: Record<string, string> = {};
    driverLocations.forEach(loc => {
      const distKm = calculateDistance(bikeCoords.lat, bikeCoords.lng, loc.latitude, loc.longitude);
      newDistances[loc.driverName] = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
    });
    setDriverDistances(newDistances);
  }, [bikeCoords, driverLocations]);

  // Efeito para extrair coordenadas da localização digitada manualmente
  useEffect(() => {
    const parseCoord = (val: any) => {
      if (val === undefined || val === null || val === '') return NaN;
      if (typeof val === 'number') return val;
      let s = String(val).trim().replace(',', '.');
      s = s.replace(/[–—]/g, '-');
      const cleaned = s.replace(/[^\d.-]/g, '');
      return parseFloat(cleaned);
    };

    // Tenta encontrar um padrão de coordenadas (lat, lng) na string de localização
    // Exemplo: "-23.191823, -45.892125"
    const coordsMatch = location.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
    
    if (coordsMatch) {
      const lat = parseCoord(coordsMatch[1]);
      const lng = parseCoord(coordsMatch[2]);
      
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        setBikeCoords({ lat, lng });
      } else {
        setBikeCoords(null);
      }
    } else {
      // Tenta um fallback mais simples se não houver vírgula/ponto-e-vírgula claro
      const parts = location.split(/\s+/).filter(p => p.length > 5);
      if (parts.length >= 2) {
        const lat = parseCoord(parts[0]);
        const lng = parseCoord(parts[1]);
        if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) > 1 && Math.abs(lng) > 1) {
          setBikeCoords({ lat, lng });
          return;
        }
      }
      setBikeCoords(null);
    }
  }, [location]);

  // Efeito para limpar o formulário sempre que o modal for fechado.
  // Isso garante que ele esteja sempre limpo ao ser reaberto e previne erros de estado.
  useEffect(() => {
    if (!isOpen && prevIsOpen) {
      setBikeNumber('');
      setLocation('');
      setReason('');
      setRecipient('Todos');
    }
  }, [isOpen, prevIsOpen]);


  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bikeNumber.trim() || !location.trim() || !reason.trim()) return;

    onSubmit({
      bikeNumber: bikeNumber.trim(),
      location: location.trim(),
      reason: reason.trim(),
      recipient: recipient,
    });
  };
  
  const canSubmit = bikeNumber.trim() && location.trim() && reason.trim();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white p-6 rounded-xl shadow-lg w-full max-w-sm relative">
        <div className="flex flex-col items-center mb-4">
          <BicycleIcon className="w-12 h-12 text-blue-600" />
          <h2 className="text-xl font-bold text-gray-800 mt-2">Solicitar Recolha</h2>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="request-bike-number" className="block text-sm font-medium text-gray-700">Número da Bicicleta</label>
            <div className="relative">
              <input 
                id="request-bike-number" 
                type="text" 
                value={bikeNumber} 
                onChange={(e) => { 
                  if (error) clearError(); 
                  setBikeNumber(e.target.value); 
                }} 
                className="mt-1 block w-full p-3 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500" 
                placeholder="Ex: 580" 
                required 
              />
            </div>
          </div>
          <div>
            <label htmlFor="request-location" className="block text-sm font-medium text-gray-700">Localização da Recolha (GPS)</label>
            <input id="request-location" type="text" value={location} onChange={(e) => { if (error) clearError(); setLocation(e.target.value); }} className="mt-1 block w-full p-3 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500" placeholder="Cole aqui as coordenadas (ex: -23.1, -45.8)" required />
          </div>
          <div>
            <label htmlFor="request-reason" className="block text-sm font-medium text-gray-700">Motivo da Solicitação</label>
            <textarea id="request-reason" value={reason} onChange={(e) => { if (error) clearError(); setReason(e.target.value); }} rows={2} className="mt-1 block w-full p-3 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500" placeholder="Ex: Pneu furado" required />
          </div>
          <div>
            <label htmlFor="request-recipient" className="block text-sm font-medium text-gray-700">Notificar Motorista</label>
            <div className="relative">
              <select 
                id="request-recipient"
                value={recipient}
                onChange={(e) => {
                  if (error) clearError();
                  setRecipient(e.target.value);
                }}
                className="mt-1 block w-full p-3 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 bg-white"
              >
                <option value="Todos">Todos (Geral)</option>
                {motoristas && motoristas.length > 0 ? (
                  motoristas.map(name => {
                    let distanceText = '';
                    if (bikeCoords) {
                      const driverLoc = driverLocations.find(loc => loc.driverName === name);
                      if (driverLoc) {
                        const dist = driverDistances[name];
                        if (dist) {
                          distanceText = ` (${dist})`;
                        } else {
                          // Fallback para distância linear enquanto carrega ou se falhar
                          const linearDist = calculateDistance(bikeCoords.lat, bikeCoords.lng, driverLoc.latitude, driverLoc.longitude);
                          distanceText = ` (~${linearDist.toFixed(2)} km)`;
                        }
                      } else {
                        distanceText = ' (Sem GPS)';
                      }
                    }
                    return (
                      <option key={name} value={name}>
                        {name}{distanceText}
                      </option>
                    );
                  })
                ) : (
                  <option disabled>Nenhum motorista encontrado</option>
                )}
              </select>
            </div>
            {bikeCoords && (
              <p className="text-[10px] text-blue-600 mt-1 italic">
                * Distâncias calculadas com base no GPS digitado.
              </p>
            )}
          </div>
          {error && (
            <div className="text-red-600 bg-red-100 p-3 rounded-md text-sm my-2 text-center">
              {error}
            </div>
          )}
          <div className="flex items-center gap-3 pt-2">
            <button
                type="button"
                onClick={onClose}
                disabled={isLoading}
                className="w-full flex justify-center py-3 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-400 disabled:opacity-50"
            >
                Cancelar
            </button>
            <button
                type="submit"
                disabled={isLoading || !canSubmit}
                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400"
            >
                {isLoading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div> : 'Enviar Solicitação'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default RequestModal;
