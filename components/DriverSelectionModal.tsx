
import React from 'react';
import { XIcon, UserIcon } from './icons';
import { Loader2 } from 'lucide-react';

interface DriverSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (driverName: string) => void;
    isLoading: boolean;
    drivers: any[];
}

const DriverSelectionModal: React.FC<DriverSelectionModalProps> = ({ isOpen, onClose, onConfirm, isLoading, drivers }) => {
    const [selected, setSelected] = React.useState('');

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50 animate-fade-in">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden">
                <div className="bg-blue-600 p-4 flex justify-between items-center text-white">
                    <h2 className="font-bold text-lg">Atribuir Carretinha</h2>
                    <button onClick={onClose} className="p-1 hover:bg-blue-700 rounded-full transition-colors">
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-6 space-y-4">
                    <div>
                        <p className="text-sm font-bold text-gray-700 mb-3 uppercase">Selecione o Motorista:</p>
                        <div className="max-h-60 overflow-y-auto space-y-2 pr-2">
                            {drivers.length > 0 ? (
                                drivers.map(driver => (
                                    <button
                                        key={driver.name}
                                        onClick={() => setSelected(driver.name)}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                                            selected === driver.name 
                                            ? 'border-blue-600 bg-blue-50 text-blue-700 shadow-sm' 
                                            : 'border-gray-100 hover:border-gray-200 text-gray-700 bg-gray-50'
                                        }`}
                                    >
                                        <UserIcon className={`w-5 h-5 ${selected === driver.name ? 'text-blue-600' : 'text-gray-400'}`} />
                                        <span className="font-bold text-sm">{driver.name}</span>
                                    </button>
                                ))
                            ) : (
                                <p className="text-center text-gray-400 text-xs py-4">Nenhum motorista disponível</p>
                            )}
                        </div>
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
                            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                            Atribuir
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DriverSelectionModal;
