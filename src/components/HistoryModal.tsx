
import React from 'react';
import { XIcon, CalendarIcon, AlertIcon, MapIcon } from './icons';

interface RequestHistoryItem {
  id: number;
  timestamp: string;
  bikeNumber: string;
  reason: string;
  location: string;
  acceptedBy: string;
  acceptedDate: string;
  status: string;
  recipient: string;
  declinedBy: string;
}

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  history: RequestHistoryItem[];
  isLoading: boolean;
  driverName: string;
}

const HistoryModal: React.FC<HistoryModalProps> = ({ isOpen, onClose, history, isLoading, driverName }) => {
  if (!isOpen) return null;

  const renderLocationWithMap = (location: string) => {
    if (!location) return null;
    
    const coordsMatch = location.match(/(-?\d+[.,]\d+)\s*[,;]\s*(-?\d+[.,]\d+)/);
    
    if (coordsMatch) {
        const lat = coordsMatch[1].replace(',', '.');
        const lng = coordsMatch[2].replace(',', '.');
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        
        return (
            <div className="flex items-center gap-2">
                <span className="text-[11px]"><span className="text-gray-400 font-bold uppercase text-[9px]">Local:</span> <span className="text-gray-700 font-medium">{location}</span></span>
                <a 
                    href={mapsUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-1 py-0.5 bg-blue-50 text-blue-600 rounded border border-blue-100 text-[8px] font-bold hover:bg-blue-100 transition-colors"
                    title="Abrir no Google Maps"
                >
                    <MapIcon className="w-2.5 h-2.5" />
                    Mapa
                </a>
            </div>
        );
    }
    
    return <p><span className="text-gray-400 font-bold uppercase text-[9px]">Local:</span> <span className="text-gray-700 font-medium">{location}</span></p>;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-[70] animate-fade-in">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-4 py-3 border-b flex justify-between items-center bg-gray-50">
          <div className="flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 text-blue-600" />
            <h2 className="text-base font-bold text-gray-800">Histórico de Notificações</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
            <XIcon className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        <div className="p-3 overflow-y-auto flex-1 bg-gray-50">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-8">
              <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mb-3"></div>
              <p className="text-xs text-gray-500 font-medium">Carregando histórico...</p>
            </div>
          ) : history.length > 0 ? (
            <div className="space-y-2">
              {history.map((item) => {
                const acceptedBy = item.acceptedBy || '';
                const declinedBy = item.declinedBy || '';
                const status = item.status || '';
                const dName = driverName || '';

                const isAcceptedByMe = acceptedBy.toLowerCase() === dName.toLowerCase();
                const isDeclinedByMe = declinedBy.toLowerCase().includes(dName.toLowerCase());
                const statusLower = status.toLowerCase();
                
                let statusColor = "bg-gray-100 text-gray-600";
                if (statusLower === 'pendente') statusColor = "bg-yellow-100 text-yellow-700";
                if (statusLower === 'aceita') statusColor = "bg-blue-100 text-blue-700";
                if (statusLower === 'recusada') statusColor = "bg-red-100 text-red-700";
                if (statusLower === 'finalizada') statusColor = "bg-green-100 text-green-700";

                return (
                  <div key={item.id} className="bg-white p-3 rounded-lg border shadow-sm">
                    <div className="flex justify-between items-center mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-black text-sm text-gray-900">{item.bikeNumber}</span>
                        <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${statusColor}`}>
                          {item.status}
                        </span>
                      </div>
                      <span className="text-[9px] text-gray-400 font-bold">{item.timestamp}</span>
                    </div>
                    
                    <div className="grid grid-cols-1 gap-0.5 text-[11px] leading-tight">
                      <p><span className="text-gray-400 font-bold uppercase text-[9px]">Motivo:</span> <span className="text-gray-700 font-medium">{item.reason}</span></p>
                      {renderLocationWithMap(item.location)}
                      <div className="flex justify-between items-end">
                        <p><span className="text-gray-400 font-bold uppercase text-[9px]">Dest:</span> <span className="text-gray-700 font-medium">{item.recipient}</span></p>
                        {item.acceptedBy && (
                          <p><span className="text-gray-400 font-bold uppercase text-[9px]">Aceita por:</span> <span className={`font-bold ${isAcceptedByMe ? 'text-blue-600' : 'text-gray-700'}`}>{item.acceptedBy}</span></p>
                        )}
                      </div>
                      {item.declinedBy && (
                        <p className="mt-1 pt-1 border-t border-dashed"><span className="text-gray-400 font-bold uppercase text-[9px]">Recusada por:</span> <span className={`text-[10px] ${isDeclinedByMe ? 'text-red-600 font-bold' : 'text-gray-500'}`}>{item.declinedBy}</span></p>
                      )}
                    </div>

                    {(isAcceptedByMe || isDeclinedByMe) && (
                      <div className="mt-2 pt-1.5 border-t flex items-center gap-2">
                        {isAcceptedByMe ? (
                           <span className="text-[9px] font-black text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 uppercase">VOCÊ ACEITOU</span>
                        ) : (
                           <span className="text-[9px] font-black text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-100 uppercase">VOCÊ RECUSOU</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <AlertIcon className="w-10 h-10 text-gray-300 mb-3" />
              <p className="text-sm text-gray-500 font-medium">Nenhuma notificação encontrada.</p>
            </div>
          )}
        </div>
        
        <div className="px-4 py-3 border-t bg-gray-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-gray-800 text-white rounded-lg text-xs font-bold hover:bg-gray-900 transition-colors shadow-sm"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};

export default HistoryModal;
