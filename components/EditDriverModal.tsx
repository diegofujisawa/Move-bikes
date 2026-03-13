
import React, { useState } from 'react';
import { XIcon, PlusIcon, TrashIcon, BicycleIcon, MapIcon } from './icons';

interface EditDriverModalProps {
    isOpen: boolean;
    onClose: () => void;
    driver: {
        name: string;
        realTime: {
            route: string[];
            collected: string[];
        };
    } | null;
    onSave: (driverName: string, routeBikes: string[], collectedBikes: string[]) => Promise<void>;
    isLoading: boolean;
}

const EditDriverModal: React.FC<EditDriverModalProps> = ({ isOpen, onClose, driver, onSave, isLoading }) => {
    const [routeBikes, setRouteBikes] = useState<string[]>([]);
    const [collectedBikes, setCollectedBikes] = useState<string[]>([]);
    const [newBike, setNewBike] = useState('');
    const [activeTab, setActiveTab] = useState<'route' | 'collected'>('route');

    React.useEffect(() => {
        if (driver) {
            setRouteBikes([...driver.realTime.route]);
            setCollectedBikes([...driver.realTime.collected]);
        }
    }, [driver]);

    if (!isOpen || !driver) return null;

    const handleAddBike = () => {
        const bike = newBike.trim();
        if (!bike) return;

        if (activeTab === 'route') {
            // Não adiciona ao roteiro se já estiver no roteiro ou já estiver em posse
            if (!routeBikes.includes(bike) && !collectedBikes.includes(bike)) {
                setRouteBikes([...routeBikes, bike]);
            } else if (collectedBikes.includes(bike)) {
                alert(`A bicicleta ${bike} já está em posse do motorista.`);
            }
        } else {
            // Se adicionar em posse, remove do roteiro se estiver lá
            if (!collectedBikes.includes(bike)) {
                setCollectedBikes([...collectedBikes, bike]);
                setRouteBikes(routeBikes.filter(b => b !== bike));
            }
        }
        setNewBike('');
    };

    const handleRemoveBike = (bike: string, type: 'route' | 'collected') => {
        if (type === 'route') {
            setRouteBikes(routeBikes.filter(b => b !== bike));
        } else {
            setCollectedBikes(collectedBikes.filter(b => b !== bike));
        }
    };

    const handleSave = async () => {
        await onSave(driver.name, routeBikes, collectedBikes);
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
                <div className="p-4 border-b bg-gray-50 flex justify-between items-center">
                    <div>
                        <h2 className="text-lg font-bold text-gray-800">Editar Motorista</h2>
                        <p className="text-xs text-gray-500 font-mono uppercase">{driver.name}</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
                        <XIcon className="w-5 h-5 text-gray-500" />
                    </button>
                </div>

                <div className="flex border-b">
                    <button 
                        onClick={() => setActiveTab('route')}
                        className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${activeTab === 'route' ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50/50' : 'text-gray-500 hover:bg-gray-50'}`}
                    >
                        <MapIcon className="w-4 h-4" />
                        Roteiro ({routeBikes.length})
                    </button>
                    <button 
                        onClick={() => setActiveTab('collected')}
                        className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${activeTab === 'collected' ? 'text-green-600 border-b-2 border-green-600 bg-green-50/50' : 'text-gray-500 hover:bg-gray-50'}`}
                    >
                        <BicycleIcon className="w-4 h-4" />
                        Em Posse ({collectedBikes.length})
                    </button>
                </div>

                <div className="p-4 flex-grow overflow-y-auto">
                    <div className="flex gap-2 mb-4">
                        <input 
                            type="text" 
                            value={newBike}
                            onChange={(e) => setNewBike(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddBike()}
                            placeholder="Adicionar bike (ex: 1234)"
                            className="flex-grow p-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <button 
                            onClick={handleAddBike}
                            className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                        >
                            <PlusIcon className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="space-y-2">
                        {(activeTab === 'route' ? routeBikes : collectedBikes).map(bike => (
                            <div key={bike} className="flex justify-between items-center p-2 bg-gray-50 rounded-lg border border-gray-200 group">
                                <span className="font-mono text-sm font-bold text-gray-700">{bike}</span>
                                <button 
                                    onClick={() => handleRemoveBike(bike, activeTab)}
                                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                                >
                                    <TrashIcon className="w-4 h-4" />
                                </button>
                            </div>
                        ))}
                        {(activeTab === 'route' ? routeBikes : collectedBikes).length === 0 && (
                            <p className="text-center py-8 text-gray-400 text-sm italic">
                                Nenhuma bicicleta na lista
                            </p>
                        )}
                    </div>
                </div>

                <div className="p-4 border-t bg-gray-50 flex gap-3">
                    <button 
                        onClick={onClose}
                        className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-100 transition-all"
                    >
                        Cancelar
                    </button>
                    <button 
                        onClick={handleSave}
                        disabled={isLoading}
                        className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {isLoading ? (
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                            'Salvar Alterações'
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default EditDriverModal;
