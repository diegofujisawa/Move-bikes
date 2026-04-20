import React, { useState, useEffect, useCallback } from 'react';
import { apiCall } from '../api';
import { XIcon, AlertTriangleIcon, TrashIcon } from './icons';

interface Alert {
    id: string;
    msg: string;
    time: string;
}

interface AdminAlertsProps {
    adminName: string;
    isOpen: boolean;
    onClose: () => void;
}

const AdminAlerts: React.FC<AdminAlertsProps> = ({ adminName, isOpen, onClose }) => {
    const [alerts, setAlerts] = useState<Alert[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    const fetchAlerts = useCallback(async () => {
        if (!adminName) return;
        setIsLoading(true);
        try {
            const response = await apiCall({ action: 'getAdminAlerts', adminName });
            if (response.success) {
                setAlerts(response.alerts || []);
                // NÃO limpa automaticamente — ADM precisa clicar no lixo para confirmar leitura
            }
        } catch (error) {
            console.error("Erro ao buscar alertas:", error);
        } finally {
            setIsLoading(false);
        }
    }, [adminName]);

    const clearAlerts = async () => {
        if (!adminName) return;
        if (!confirm("Confirmar leitura de todos os alertas? Eles não aparecerão novamente.")) return;

        setIsLoading(true);
        try {
            const response = await apiCall({ action: 'clearAdminAlerts', adminName });
            if (response.success) {
                setAlerts([]);
            }
        } catch (error) {
            console.error("Erro ao limpar alertas:", error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            fetchAlerts();
            // Atualiza a cada 10 segundos enquanto o modal estiver aberto
            const interval = setInterval(fetchAlerts, 10000);
            return () => clearInterval(interval);
        }
    }, [isOpen, fetchAlerts]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[80vh]">
                <div className="p-4 border-b flex items-center justify-between bg-red-50">
                    <div className="flex items-center gap-2 text-red-700">
                        <AlertTriangleIcon className="w-6 h-6" />
                        <div>
                            <h2 className="text-lg font-bold">Alertas e Notificações</h2>
                            {alerts.length > 0 && (
                                <p className="text-xs text-red-500 font-normal">
                                    {alerts.length} alerta{alerts.length > 1 ? 's' : ''} — clique no lixo para confirmar leitura
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {alerts.length > 0 && (
                            <button
                                onClick={clearAlerts}
                                disabled={isLoading}
                                className="p-2 text-gray-500 hover:text-red-600 transition-colors disabled:opacity-50"
                                title="Confirmar leitura de todos os alertas"
                            >
                                <TrashIcon className="w-5 h-5" />
                            </button>
                        )}
                        <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-700">
                            <XIcon className="w-6 h-6" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {isLoading && alerts.length === 0 ? (
                        <div className="flex justify-center py-8">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600"></div>
                        </div>
                    ) : alerts.length === 0 ? (
                        <div className="text-center py-12 text-gray-500 italic">
                            Nenhum alerta ou notificação no momento.
                        </div>
                    ) : (
                        alerts.map((alert) => (
                            <div
                                key={alert.id}
                                className="p-3 bg-red-50 border-l-4 border-red-500 rounded-r-lg shadow-sm"
                            >
                                <p className="text-red-900 font-medium text-xs leading-tight">{alert.msg}</p>
                                <p className="text-[10px] text-red-400 mt-1">
                                    {new Date(alert.time).toLocaleString('pt-BR', {
                                        hour: '2-digit', minute: '2-digit',
                                        day: '2-digit', month: '2-digit'
                                    })}
                                </p>
                            </div>
                        ))
                    )}
                </div>

                <div className="p-4 border-t bg-gray-50 flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-6 py-2 bg-white border border-gray-300 rounded-xl text-gray-700 font-medium hover:bg-gray-100 transition-colors shadow-sm"
                    >
                        Fechar
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AdminAlerts;