
import React from 'react';
import { XIcon, UserIcon } from './icons';

interface MechanicSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (mechanicName: string) => void;
    isLoading: boolean;
    bikeNumber: string;
}

const MechanicSelectionModal: React.FC<MechanicSelectionModalProps> = ({ isOpen, onClose, onConfirm, isLoading, bikeNumber }) => {
    const mechanics = ["Kauan", "Felipe", "João", "Rafael", "Andre"];
    const [selected, setSelected] = React.useState('');

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50 animate-fade-in">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden">
                <div className="bg-blue-600 p-4 flex justify-between items-center text-white">
                    <h2 className="font-bold text-lg">Selecionar Mecânico - Bike {bikeNumber}</h2>
                    <button onClick={onClose} className="p-1 hover:bg-blue-700 rounded-full transition-colors">
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-6 space-y-4">
                    <p className="text-sm text-gray-600 mb-2">Quem será o mecânico responsável por esta bicicleta?</p>
                    <div className="grid grid-cols-2 gap-3">
                        {mechanics.map(name => (
                            <button
                                key={name}
                                onClick={() => setSelected(name)}
                                className={`flex flex-col items-center justify-center gap-2 p-4 rounded-xl border-2 transition-all ${
                                    selected === name 
                                    ? 'border-blue-600 bg-blue-50 text-blue-700 shadow-md' 
                                    : 'border-gray-100 hover:border-gray-200 text-gray-700 bg-gray-50'
                                }`}
                            >
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${selected === name ? 'bg-blue-600 text-white' : 'bg-white text-gray-400 border border-gray-200'}`}>
                                    <UserIcon className="w-6 h-6" />
                                </div>
                                <span className="font-bold text-sm">{name}</span>
                            </button>
                        ))}
                    </div>
                    <div className="flex gap-3 pt-4">
                        <button 
                            onClick={onClose}
                            disabled={isLoading}
                            className="flex-1 py-2.5 border border-gray-300 rounded-md text-sm font-bold text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            Cancelar
                        </button>
                        <button 
                            onClick={() => onConfirm(selected)}
                            disabled={isLoading || !selected}
                            className="flex-1 py-2.5 bg-blue-600 text-white rounded-md text-sm font-bold hover:bg-blue-700 transition-colors shadow-md disabled:bg-gray-400 flex items-center justify-center gap-2"
                        >
                            {isLoading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
                            Confirmar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MechanicSelectionModal;
