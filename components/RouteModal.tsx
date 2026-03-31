import React, { useState, useEffect, useRef } from 'react';
import { PlusPlusIcon, QrCodeIcon, XIcon, TrailerIcon } from './icons';
import { Html5Qrcode } from 'html5-qrcode';

interface RouteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (details: { routeName: string; bikeNumbers: string[]; recipient: string; }) => void;
  isLoading: boolean;
  pendingBikeNumbers: Set<string>;
  motoristas: string[];
  error: string | null;
  clearError: () => void;
  type?: 'route' | 'trailer';
}

function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => { ref.current = value; });
  return ref.current;
}

const RouteModal: React.FC<RouteModalProps> = ({
  isOpen, onClose, onSubmit, isLoading,
  pendingBikeNumbers, motoristas, error, clearError,
  type = 'route'
}) => {
  const [routeName, setRouteName] = useState('');
  const [bikeListText, setBikeListText] = useState('');
  const [recipient, setRecipient] = useState('Todos');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const prevIsOpen = usePrevious(isOpen);

  const stopScanner = async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); scannerRef.current = null; }
      catch (err) { console.error("Erro ao parar scanner:", err); }
    }
    setIsScannerOpen(false);
  };

  useEffect(() => {
    if (!isOpen && prevIsOpen) {
      setRouteName(''); setBikeListText(''); setRecipient('Todos'); stopScanner();
    }
  }, [isOpen, prevIsOpen]);

  const startScanner = async () => {
    setIsScannerOpen(true);
    setTimeout(async () => {
      try {
        const scanner = new Html5Qrcode("route-qr-reader");
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            const bikeNum = decodedText.replace(/\D/g, '');
            if (bikeNum) {
              setBikeListText(prev => {
                const current = prev.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean);
                return !current.includes(bikeNum) ? (prev ? `${prev}, ${bikeNum}` : bikeNum) : prev;
              });
              if (navigator.vibrate) navigator.vibrate(100);
            }
          },
          () => {}
        );
      } catch (err) { console.error("Erro ao iniciar scanner:", err); setIsScannerOpen(false); }
    }, 100);
  };

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedBikes = bikeListText.trim();
    const trimmedRoute = routeName.trim();
    if (!trimmedBikes || !trimmedRoute) { alert('Por favor, preencha o nome e a lista de bicicletas.'); return; }
    const numbers = [...new Set(trimmedBikes.split(/[\s,;\n]+/).map(n => n.trim()).filter(Boolean))];
    if (numbers.length === 0) { alert('Nenhum número de bicicleta válido encontrado.'); return; }
    const conflictingBikes = numbers.filter(num => {
      try { return pendingBikeNumbers && typeof pendingBikeNumbers.has === 'function' && pendingBikeNumbers.has(num); }
      catch { return false; }
    });
    if (conflictingBikes.length > 0) {
      const proceed = window.confirm(
        `Atenção! As seguintes bicicletas já constam em outras solicitações pendentes:\n\n${conflictingBikes.join(', ')}\n\nDeseja continuar e criar a ${type === 'trailer' ? 'carretinha' : 'rota'} mesmo assim?`
      );
      if (!proceed) return;
    }
    onSubmit({ routeName: trimmedRoute, bikeNumbers: numbers, recipient: recipient || 'Todos' });
  };

  const canSubmit = bikeListText.trim().length > 0 && routeName.trim().length > 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white p-6 rounded-xl shadow-lg w-full max-w-sm relative max-h-[90vh] overflow-y-auto">
        <div className="flex flex-col items-center mb-4">
          {type === 'trailer' ? <TrailerIcon className="w-12 h-12 text-blue-600" /> : <PlusPlusIcon className="w-12 h-12 text-blue-600" />}
          <h2 className="text-xl font-bold text-gray-800 mt-2 text-center">
            {type === 'trailer' ? 'Enviar Carretinha para Motorista' : 'Enviar Roteiro para Motorista'}
          </h2>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="route-name" className="block text-sm font-medium text-gray-700">
              {type === 'trailer' ? 'Nome da Carretinha' : 'Nome da Rota'}
            </label>
            <input id="route-name" type="text" value={routeName}
              onChange={e => { if (error) clearError(); setRouteName(e.target.value); }}
              className="mt-1 block w-full p-3 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
              placeholder={type === 'trailer' ? "Ex: Carretinha Centro" : "Ex: Rota Copacabana"} required />
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label htmlFor="route-bike-list" className="block text-sm font-medium text-gray-700">Números das Bicicletas</label>
              <button type="button" onClick={isScannerOpen ? stopScanner : startScanner}
                className={`flex items-center gap-1 text-xs font-bold px-2 py-1 rounded ${isScannerOpen ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'}`}>
                {isScannerOpen ? <><XIcon className="w-3 h-3"/> Fechar Scanner</> : <><QrCodeIcon className="w-3 h-3"/> Escanear QR</>}
              </button>
            </div>
            {isScannerOpen && (
              <div className="mb-3 border-2 border-blue-500 rounded-lg overflow-hidden bg-black">
                <div id="route-qr-reader" className="w-full"></div>
              </div>
            )}
            <p className="text-xs text-gray-500 mb-2">Cole ou digite os números, separados por espaço, vírgula ou quebra de linha.</p>
            <textarea id="route-bike-list" value={bikeListText}
              onChange={e => { if (error) clearError(); setBikeListText(e.target.value); }}
              rows={4} className="mt-1 block w-full p-3 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
              placeholder="580, 581, 582..." required />
          </div>
          <div>
            <label htmlFor="route-recipient" className="block text-sm font-medium text-gray-700">Notificar Motorista</label>
            <select id="route-recipient" value={recipient}
              onChange={e => { if (error) clearError(); setRecipient(e.target.value); }}
              className="mt-1 block w-full p-3 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 bg-white">
              <option value="Todos">Todos</option>
              {motoristas.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          {error && <div className="text-red-600 bg-red-100 p-3 rounded-md text-sm my-2 text-center">{error}</div>}
          <div className="flex items-center gap-3 pt-2">
            <button type="button" onClick={onClose} disabled={isLoading}
              className="w-full flex justify-center py-3 px-4 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50">
              Cancelar
            </button>
            <button type="submit" disabled={!canSubmit || isLoading}
              className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400">
              {isLoading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div> : 'Enviar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default RouteModal;