import React from 'react';
import { XIcon } from './icons';

interface ReporModalProps {
    isOpen: boolean;
    onClose: () => void;
    data: any[];
    isLoading: boolean;
}

const ReporModal: React.FC<ReporModalProps> = ({ isOpen, onClose, data, isLoading }) => {
    if (!isOpen) return null;

    // Process data: find columns, filter, sort
    const processData = () => {
        if (!data || data.length === 0) return [];

        const keys = Object.keys(data[0]);
        
        let stationKey = '';
        let qtyKey = '';

        // 1. Try to find by checking the keys themselves (headers from server)
        keys.forEach(key => {
            const k = key.toLowerCase();
            if (k.includes('estação') || k.includes('estacao') || k.includes('nome')) stationKey = key;
            if (k.includes('qtd') || k.includes('quantidade') || k.includes('ocupação') || k.includes('ocupacao')) qtyKey = key;
        });

        // 2. If not found, try to find by checking the values of the first row
        if (!stationKey || !qtyKey) {
            keys.forEach(key => {
                const val = String(data[0][key]).toLowerCase();
                if (!stationKey && (val.includes('estação') || val.includes('estacao'))) stationKey = key;
                if (!qtyKey && (val.includes('qtd') || val.includes('quantidade'))) qtyKey = key;
            });
        }

        // 3. Fallback to common column positions (Col 2 for station, Col 3 for qty)
        if (!stationKey) stationKey = keys[1] || keys[0];
        if (!qtyKey) qtyKey = keys[2] || keys[1];

        // Lista de estações permitidas (29 fornecidas pelo usuário)
        const allowedStations = [
            "Serttel Filial SJC",
            "Open Mall",
            "Pç. Padre João (Igreja Matriz)",
            "LV - Dutra",
            "Pç. Ulisses Guimarães",
            "Pq. Ribeirão Vermelho - B",
            "Villa Real – Urbanova",
            "Torii",
            "Centro da Juventude",
            "Pç. Afonso Pena",
            "Praça Conego Lima",
            "Pq Tecnológico",
            "Arco Inovação",
            "LV - Jd. América",
            "LV - Maurício Cury",
            "Pç. Kennedy",
            "LV - Osvaldo Cruz",
            "LV - Vl. Sanchez",
            "Mirante Anchieta",
            "Pç. Floripes Bicudo",
            "Pq. Vicentina Aranha",
            "Pq. Santos Dumont",
            "Banco do Povo",
            "Cassiopéia",
            "LV - Jd. Oriente",
            "LV - Morumbi",
            "LV - Vale do Sol",
            "LV - Eldorado",
            "LV - Sul",
            "Parque da Cidade",
            "Sub Pref Eugênio de Melo",
            "3 Parque da Cidade",
            "23 Sub Pref Eugênio de Melo",
            "11 LV - Osvaldo Cruz"
        ].map(s => s.toLowerCase().trim());

        // Filter: Only non-empty names, exclude header-like rows, and MUST be in the allowed list
        const filteredData = data.filter(row => {
            const stationVal = String(row[stationKey] || '').trim();
            if (!stationVal) return false;

            // Normalize: replace non-breaking spaces (\u00A0) and multiple spaces with a single space
            const normalizedVal = stationVal.replace(/[\u00A0\s]+/g, ' ').toLowerCase().trim();
            
            // Excluir cabeçalhos
            if (normalizedVal.includes('estação') || normalizedVal.includes('estacao') || normalizedVal.includes('número') || normalizedVal.includes('numero')) {
                return false;
            }

            // Filtrar apenas as 29 estações permitidas
            // Usamos some para permitir correspondência flexível
            return allowedStations.some(allowed => {
                const normalizedAllowed = allowed.replace(/[\u00A0\s]+/g, ' ').toLowerCase().trim();
                
                // Correspondência exata após normalização
                if (normalizedVal === normalizedAllowed) return true;
                
                // Se o valor da planilha contém o nome permitido (ex: "29 Banco do Povo" contém "Banco do Povo")
                if (normalizedVal.includes(normalizedAllowed)) return true;

                // Lidar com variações de "Praça" vs "Pç."
                const withPc = normalizedAllowed.replace('praça', 'pç.');
                const withPraca = normalizedAllowed.replace('pç.', 'praça');
                
                if (normalizedVal.includes(withPc) || normalizedVal.includes(withPraca)) return true;

                return false;
            });
        });

        // Map to simplified objects and sort by quantity ascending
        return filteredData
            .map(row => ({
                station: row[stationKey],
                qty: parseInt(row[qtyKey]) || 0
            }))
            .sort((a, b) => a.qty - b.qty);
    };

    const processedData = processData();

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in-up flex flex-col max-h-[85vh]">
                <div className="p-4 border-b flex justify-between items-center bg-blue-600 text-white">
                    <div className="flex flex-col">
                        <h2 className="text-lg font-bold">Ocupação das Estações</h2>
                        {!isLoading && processedData.length > 0 && (
                            <span className="text-xs opacity-80">{processedData.length} estações encontradas</span>
                        )}
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-blue-700 rounded-full transition-colors">
                        <XIcon className="w-6 h-6" />
                    </button>
                </div>
                
                <div className="p-4 overflow-auto flex-grow">
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                            <p className="text-gray-600 text-sm animate-pulse">Carregando...</p>
                        </div>
                    ) : processedData.length > 0 ? (
                        <div className="border rounded-lg overflow-hidden shadow-sm">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Estação</th>
                                        <th className="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider w-20">Qtd</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {processedData.map((row, index) => (
                                        <tr key={index} className="hover:bg-blue-50/50 transition-colors">
                                            <td className="px-4 py-3 text-sm text-gray-700 font-medium">
                                                {row.station}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-center">
                                                <span className={`inline-block px-2 py-0.5 rounded-full font-bold ${
                                                    row.qty === 0 
                                                    ? 'bg-red-100 text-red-700' 
                                                    : row.qty < 5 
                                                    ? 'bg-yellow-100 text-yellow-700' 
                                                    : 'bg-green-100 text-green-700'
                                                }`}>
                                                    {row.qty}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="text-center py-12">
                            <p className="text-gray-500">Nenhuma estação disponível para reposição.</p>
                        </div>
                    )}
                </div>
                
                <div className="p-4 border-t bg-gray-50 flex justify-end">
                    <button 
                        onClick={onClose}
                        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-sm"
                    >
                        Fechar
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ReporModal;
