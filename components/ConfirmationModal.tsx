
import React from 'react';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
  bikeNumber: string | undefined;
  reason?: string;
  isDecline?: boolean;
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({ isOpen, onClose, onConfirm, isLoading, bikeNumber, reason, isDecline = false }) => {
  if (!isOpen) return null;

  const isRoute = bikeNumber?.includes(',');
  
  const title = isDecline 
    ? 'Confirmar Recusa' 
    : (isRoute ? 'Confirmar Roteiro' : 'Confirmar Recolha');
  
  const confirmationText = isDecline
    ? <>Tem certeza que deseja recusar a solicitação para <strong className="text-gray-800">{isRoute ? reason : bikeNumber}</strong>? Ela será removida da lista de pendentes.</>
    : (isRoute 
        ? <>Aceitar o roteiro <strong className="text-gray-800">{reason}</strong>? As bicicletas serão adicionadas à sua lista.</>
        : <>Aceitar a recolha da bicicleta <strong className="text-gray-800">{bikeNumber}</strong>? A solicitação será atribuída a você.</>);
        
  const confirmButtonClass = isDecline
    ? "py-2 px-6 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:bg-gray-400 flex items-center"
    : "py-2 px-6 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 flex items-center";

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white p-6 rounded-xl shadow-lg w-full max-w-sm text-center">
        <h2 className="text-lg font-bold text-gray-800">{title}</h2>
        <p className="text-gray-600 my-4">
          {confirmationText}
        </p>
        <div className="flex justify-center gap-4 mt-6">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="py-2 px-6 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={confirmButtonClass}
          >
            {isLoading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>}
            {isDecline ? 'Recusar' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationModal;
