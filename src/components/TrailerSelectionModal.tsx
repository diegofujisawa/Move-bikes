
import React, { useState } from 'react';
import { XIcon, TruckIcon } from './icons';
import { Loader2 } from 'lucide-react';

interface TrailerSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (trailerName: string) => void;
    isLoading: boolean;
    bikeNumbers: string[];
}

const TrailerSelectionModal: React.FC<TrailerSelectionModalProps> = ({ 
    isOpen, 
    onClose, 
    onConfirm, 
    isLoading, 
    bikeNumbers 
}) => {
    const [selected, setSelected] = useState('');
    const [customName, setCustomName] = useState('');

    const trailers = [
        'Carretinha 1',
        'Carretinha 2',
        'Carretinha 3',
        'Carretinha 4',
        'Carretinha 5',
        'Carretinha 6',
        'Carretinha 7',
        'Carretinha 8',
        'Carretinha 9',
        'Carretinha 10'
    ];

    if (!isOpen) return null;

    const handleConfirm = () => {
        const finalName = customName.trim() || selected;
        if (finalName) {
            onConfirm(finalName);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[110] animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="bg-purple-600 p-4 flex justify-between items-center text-white">
                    <div className="flex items-center gap-3">
                        <TruckIcon className="w-6 h-6" />
                        <h2 className="font-black text-lg uppercase tracking-tight">Organizar Carretinha</h2>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-purple-700 rounded-full transition-colors">
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>
                
                <div className="p-6 space-y-6">
                    <div className="bg-purple-50 p-3 rounded-xl border border-purple-100">
                        <p className="text-[10px] font-black text-purple-400 uppercase tracking-widest mb-1">Bikes Selecionadas ({bikeNumbers.length})</p>
                        <p className="text-sm font-bold text-purple-700 truncate">{bikeNumbers.join(', ')}</p>
                    </div>

                    <div>
                        <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Selecione uma Carretinha:</p>
                        <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                            {trailers.map(trailer => (
                                <button
                                    key={trailer}
                                    onClick={() => { setSelected(trailer); setCustomName(''); }}
                                    className={`flex items-center justify-center p-3 rounded-xl border-2 font-bold text-sm transition-all ${
                                        selected === trailer && !customName
                                        ? 'border-purple-600 bg-purple-50 text-purple-700 shadow-sm' 
                                        : 'border-gray-100 hover:border-gray-200 text-gray-600 bg-gray-50'
                                    }`}
                                >
                                    {trailer}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="relative">
                        <div className="absolute inset-0 flex items-center" aria-hidden="true">
                            <div className="w-full border-t border-gray-200"></div>
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-white px-2 text-gray-400 font-black tracking-widest">Ou nome personalizado</span>
                        </div>
                    </div>

                    <input
                        type="text"
                        placeholder="Ex: Carretinha Centro"
                        value={customName}
                        onChange={(e) => { setCustomName(e.target.value); setSelected(''); }}
                        className="w-full p-4 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-purple-600 focus:outline-none font-bold text-gray-700 transition-all"
                    />

                    <div className="flex gap-3 pt-2">
                        <button 
                            onClick={onClose}
                            disabled={isLoading}
                            className="flex-1 py-4 border-2 border-gray-100 rounded-xl text-xs font-black text-gray-400 uppercase tracking-widest hover:bg-gray-50 transition-all disabled:opacity-50"
                        >
                            Cancelar
                        </button>
                        <button 
                            onClick={handleConfirm}
                            disabled={isLoading || (!selected && !customName.trim())}
                            className="flex-1 py-4 bg-purple-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-purple-700 active:scale-95 transition-all shadow-lg shadow-purple-200 disabled:bg-gray-300 disabled:shadow-none flex items-center justify-center gap-2"
                        >
                            {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Confirmar'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TrailerSelectionModal;
