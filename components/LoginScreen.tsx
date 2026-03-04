import React, { useState, useEffect } from 'react';
import { BicycleIcon, UserIcon, LockClosedIcon, AlertTriangleIcon } from './icons';
import { User } from '../types';
import { apiCall, checkApiConnection } from '../api';

interface LoginScreenProps {
  onLogin: (user: User) => void;
}

const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [plate, setPlate] = useState('');
  const [kmInicial, setKmInicial] = useState('');
  const [plates, setPlates] = useState<{ plate: string, lastKmFinal: number }[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingPlates, setIsLoadingPlates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'testing' | 'ok' | 'error'>('testing');
  const [connectionError, setConnectionError] = useState('');
  const [apiVersion, setApiVersion] = useState('');

  const testConnection = async () => {
    try {
      const result = await checkApiConnection();
      if (result.status === 'ok') {
        setApiVersion(result.version || 'N/A');
        setConnectionStatus('ok');
        fetchPlates();
      } else {
        throw new Error('Resposta de teste inválida.');
      }
    } catch (err: any) {
      setConnectionStatus('error');
      setConnectionError(err.message || 'Erro desconhecido.');
    }
  };

  const fetchPlates = async () => {
    setIsLoadingPlates(true);
    try {
      const result = await apiCall({ action: 'getVehiclePlates' });
      if (result.success) {
        setPlates(result.data);
      }
    } catch (err) {
      console.error("Failed to fetch plates:", err);
    } finally {
      setIsLoadingPlates(false);
    }
  };

  useEffect(() => {
    testConnection();
  }, []);

  const handleRetryConnectionTest = () => {
    setConnectionStatus('testing');
    setConnectionError('');
    setApiVersion('');
    testConnection();
  };
  

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!login.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await apiCall({
        action: 'login',
        login: login.trim(),
        password: password,
        plate: plate,
        kmInicial: kmInicial ? parseFloat(kmInicial) : undefined
      });

      if (result.user) {
        onLogin({
          name: result.user.name,
          category: result.user.category,
          plate: result.user.plate,
          kmInicial: result.user.kmInicial
        });
      } else {
        throw new Error(result.error || 'Resposta do servidor inválida ou incompleta.');
      }
    } catch (err) {
      console.error("Login failed:", err);
      setError(err instanceof Error ? err.message : 'Ocorreu um erro desconhecido.');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePlateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedPlate = e.target.value;
    setPlate(selectedPlate);
    const vehicle = plates.find(p => p.plate === selectedPlate);
    if (vehicle) {
      setKmInicial(vehicle.lastKmFinal.toString());
    } else {
      setKmInicial('');
    }
  };

  const renderConnectionStatus = () => {
    switch (connectionStatus) {
      case 'testing':
        return <div className="text-center text-gray-500 text-sm p-3 bg-gray-100 rounded-md">Testando conexão com o servidor...</div>;
      case 'ok':
        return <div className="text-center text-green-700 text-sm p-3 bg-green-100 rounded-md">✓ Conexão estabelecida (API v{apiVersion}).</div>;
      case 'error':
        return (
            <div className="text-left text-red-900 p-4 bg-red-50 rounded-lg border-2 border-dashed border-red-300">
                <div className="flex items-start gap-3">
                    <AlertTriangleIcon className="w-10 h-10 text-red-500 flex-shrink-0 mt-1" />
                    <div>
                        <p className="font-bold text-lg mb-1">Ação Necessária: Corrija a Conexão da API</p>
                        <p className="mb-2 text-sm">O aplicativo não consegue se comunicar com o Google. A causa mais provável é um problema de rede ou uma configuração incorreta na implantação do script.</p>
                        
                        <div className="my-3 text-sm font-semibold text-red-800 bg-red-100 p-2 border border-red-200 rounded-md">
                          <strong>Erro Detalhado:</strong> {connectionError}
                        </div>
                        
                        <p className="font-semibold mb-2 text-sm text-gray-800">Siga estes passos na sua página do Google Apps Script:</p>
                        
                        <ol className="list-decimal list-inside space-y-2.5 text-sm bg-red-100 p-3 rounded-md border border-red-200">
                            <li>Clique em <strong className="bg-gray-200 px-1 rounded">Implantar</strong> e depois em <strong className="bg-gray-200 px-1 rounded">Nova implantação</strong>.
                                <span className="block text-xs text-red-700 font-medium ml-4">É crucial usar "Nova implantação" a cada alteração.</span>
                            </li>
                            <li>Na janela que abrir, configure <strong>EXATAMENTE</strong> assim:
                                <ul className="list-disc list-inside pl-5 mt-2 space-y-1 text-gray-800">
                                    <li>Executar como: <strong>Eu (seu e-mail)</strong></li>
                                    <li>Quem pode acessar: <strong className="bg-yellow-200 px-1 rounded text-red-800">Qualquer pessoa</strong>
                                       <span className="block text-xs font-medium">Esta é a causa mais comum do erro.</span>
                                    </li>
                                </ul>
                            </li>
                            <li>Clique em <strong className="bg-gray-200 px-1 rounded">Implantar</strong>, aguarde e copie a <strong>nova URL do app da Web</strong>.</li>
                            <li><strong>Envie a nova URL para mim.</strong> O aplicativo precisa ser atualizado com ela.</li>
                        </ol>
                         <p className="text-sm mt-3 font-semibold text-red-800">O erro só será resolvido após você me enviar a nova URL de uma implantação correta.</p>
                    </div>
                </div>
                <div className="mt-4 text-center">
                    <button onClick={handleRetryConnectionTest} className="text-sm bg-white text-red-700 border border-red-700 hover:bg-red-50 font-semibold py-1.5 px-4 rounded-md transition-colors">
                        Tentei corrigir, testar novamente
                    </button>
                </div>
            </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-white p-8 rounded-xl shadow-lg animate-fade-in-down w-full max-w-md">
      <div className="flex flex-col items-center mb-6">
        <BicycleIcon className="w-16 h-16 text-blue-600" />
        <h1 className="text-3xl font-bold text-gray-800 mt-4 text-center">Registro de Recolha</h1>
        <p className="text-gray-500 mt-1">Identifique-se para continuar</p>
      </div>
      
      <div className="mb-4">
        {renderConnectionStatus()}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label htmlFor="login" className="block text-sm font-medium text-gray-700">
              Login
            </label>
            <div className="mt-1 relative rounded-md shadow-sm">
               <div className="pointer-events-none absolute inset-y-0 left-0 pl-3 flex items-center">
                  <UserIcon className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                id="login"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Digite seu login"
                required
                autoCapitalize="none"
                disabled={connectionStatus !== 'ok'}
              />
            </div>
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Senha
            </label>
            <div className="mt-1 relative rounded-md shadow-sm">
               <div className="pointer-events-none absolute inset-y-0 left-0 pl-3 flex items-center">
                  <LockClosedIcon className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Digite sua senha"
                required
                disabled={connectionStatus !== 'ok'}
              />
            </div>
          </div>
        </div>

        <div className="pt-4 border-t border-gray-100">
          <p className="text-xs font-bold text-gray-400 uppercase mb-3">Informações do Veículo</p>
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label htmlFor="plate" className="block text-sm font-medium text-gray-700">
                Placa do Veículo
              </label>
              <select
                id="plate"
                value={plate}
                onChange={handlePlateChange}
                className="mt-1 block w-full pl-3 pr-10 py-3 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                required
                disabled={connectionStatus !== 'ok' || isLoadingPlates}
              >
                <option value="">Selecione a placa</option>
                {plates.map((p) => (
                  <option key={p.plate} value={p.plate}>
                    {p.plate}
                  </option>
                ))}
              </select>
              {isLoadingPlates && <p className="text-[10px] text-blue-500 mt-1">Carregando placas...</p>}
            </div>
            <div>
              <label htmlFor="kmInicial" className="block text-sm font-medium text-gray-700">
                KM Inicial
              </label>
              <input
                type="number"
                id="kmInicial"
                value={kmInicial}
                onChange={(e) => setKmInicial(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="KM do odômetro"
                required
                disabled={connectionStatus !== 'ok'}
              />
              <p className="text-[10px] text-gray-400 mt-1 italic">Deve ser igual ao KM final do último turno.</p>
            </div>
          </div>
        </div>

        {error && (
            <div className="text-red-600 bg-red-100 p-3 rounded-md text-sm">
                {error}
            </div>
        )}

        <button
          type="submit"
          disabled={!login.trim() || !plate || !kmInicial || isLoading || connectionStatus !== 'ok'}
          className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors mt-6"
        >
          {isLoading ? (
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          ) : (
            'Entrar e Iniciar Turno'
          )}
        </button>
      </form>
    </div>
  );
};

export default LoginScreen;