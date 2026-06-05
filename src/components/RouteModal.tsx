import React, { useState, useEffect, useRef } from 'react';
import { PlusPlusIcon, XIcon, TrailerIcon, MapIcon } from './icons';
import { Upload, Loader2, Clipboard, AlertCircle } from 'lucide-react';

// Pequena alteração para reativar o estado do git e liberar o botão de sincronização do GitHub.

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
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const prevIsOpen = usePrevious(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const handlePaste = (e: ClipboardEvent) => {
      if (!isScannerOpen) return;
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf("image") !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
              const reader = new FileReader();
              reader.onloadend = () => {
                processImage(reader.result as string);
              };
              reader.readAsDataURL(blob);
            }
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isOpen, isScannerOpen]);

  const processImage = async (base64Image: string) => {
    setIsScanning(true);
    setScanError(null);
    try {
      // GEMINI_API_KEY is replaced during build time by Vite. Ensure that Cloudflare builds the site with the correct key.
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error("GEMINI_API_KEY is not defined in the environment.");
        setScanError("Erro: Chave API do Gemini não configurada nas variáveis do Cloudflare.");
        return;
      }

      // Normaliza a chave removendo espaços e possíveis aspas envolventes de copy-paste
      let cleanKey = apiKey.trim();
      if (cleanKey.startsWith('"') && cleanKey.endsWith('"')) {
        cleanKey = cleanKey.slice(1, -1).trim();
      } else if (cleanKey.startsWith("'") && cleanKey.endsWith("'")) {
        cleanKey = cleanKey.slice(1, -1).trim();
      }

      if (!cleanKey) {
        setScanError("Erro: Chave API do Gemini está vazia.");
        return;
      }

      const mimeType = base64Image.split(';')[0].split(':')[1] || "image/png";
      const base64Data = base64Image.split(',')[1];

      // Envia a chave API via query parameter 'key' na URL (padrão oficial do Google AI Studio para chaves AIzaSy e novos formatos)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cleanKey}`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };

      const payload = {
        contents: [
          {
            parts: [
              { inlineData: { mimeType, data: base64Data } },
              { text: "List bike numbers in this map. Return ONLY a JSON array of strings. Fast mode." }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: { type: "STRING" }
          }
        }
      };

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`A API do Google retornou o status ${res.status}: ${errorText}`);
      }

      const resJson = await res.json();
      const textResponse = resJson.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
      const bikes = JSON.parse(textResponse);

      if (Array.isArray(bikes) && bikes.length > 0) {
        setBikeListText(prev => {
          const current = prev.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean);
          const newBikes = bikes.filter(b => !current.includes(b));
          return current.concat(newBikes).join(', ');
        });
        setIsScannerOpen(false);
      } else {
        setScanError("Nenhuma bike detectada.");
      }
    } catch (err: any) {
      console.error("Scan error:", err);
      let errMsg = err.message || 'Erro desconhecido';
      
      const apiKeyVal = process.env.GEMINI_API_KEY || '';
      const maskedKey = apiKeyVal.length > 8 
        ? `${apiKeyVal.substring(0, 7)}...${apiKeyVal.substring(apiKeyVal.length - 5)} (Tam: ${apiKeyVal.length})`
        : `Vazia/Inválida (Tam: ${apiKeyVal.length})`;

      const upperMsg = errMsg.toUpperCase();
      if (upperMsg.includes('PREPAYMENT') || upperMsg.includes('429') || upperMsg.includes('RESOURCE_EXHAUSTED') || upperMsg.includes('BILLING')) {
        errMsg = `Chave de faturamento esgotada. Chave usada: ${maskedKey}. Erro original: ${errMsg}`;
      } else if (upperMsg.includes('UNAUTHENTICATED') || upperMsg.includes('CREDENTIALS') || upperMsg.includes('401') || upperMsg.includes('OAUTH') || upperMsg.includes('INVALID_KEY') || upperMsg.includes('API_KEY')) {
        errMsg = `Erro de Autenticação (401). Verifique se a chave está ativa no Google AI Studio. Chave lida pelo app: ${maskedKey}. Erro retornado pelo Google: ${errMsg}`;
      } else if (upperMsg.includes('404') || upperMsg.includes('NOT_FOUND') || upperMsg.includes('NOT FOUND')) {
        errMsg = `Erro 404 (Não Encontrado): Isso geralmente acontece se sua chave de API estiver RESTRETA para a API 'Gemini API' em vez de 'Generative Language API' (Google AI Studio) no Google Cloud Console. Para corrigir, no Google Cloud Console:
1. Vá nas configurações da chave de API
2. Remova as restrições de API selecionando 'Não restringir chave' OU marque a caixa para 'Generative Language API'
3. Salve, aguarde 2 minutos e tente novamente.
Chave usada: ${maskedKey}`;
      } else {
        errMsg = `Erro ao processar imagem: ${errMsg}. Chave lida pelo app: ${maskedKey}`;
      }
      
      setScanError(errMsg);
    } finally {
      setIsScanning(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => processImage(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  useEffect(() => {
    if (!isOpen && prevIsOpen) {
      setRouteName(''); 
      setBikeListText(''); 
      setRecipient('Todos'); 
      setIsScannerOpen(false);
      setScanError(null);
    }
  }, [isOpen, prevIsOpen]);

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
              <button type="button" onClick={() => setIsScannerOpen(!isScannerOpen)}
                className={`flex items-center gap-1 text-xs font-bold px-2 py-1 rounded ${isScannerOpen ? 'bg-red-100 text-red-600' : 'bg-indigo-100 text-indigo-600'}`}>
                {isScannerOpen ? <><XIcon className="w-3 h-3"/> Fechar</> : <><MapIcon className="w-3 h-3"/> Escanear Mapa</>}
              </button>
            </div>
            {isScannerOpen && (
              <div className="mb-3 p-4 border-2 border-dashed border-indigo-200 rounded-xl bg-indigo-50/30 space-y-3">
                {isScanning ? (
                  <div className="flex flex-col items-center py-4">
                    <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mb-2" />
                    <p className="text-[10px] font-bold text-indigo-700 uppercase tracking-widest">Analisando Mapa...</p>
                  </div>
                ) : (
                  <>
                    <label className="flex flex-col items-center justify-center py-4 cursor-pointer group">
                      <div className="p-3 bg-indigo-100 rounded-full mb-2 group-hover:scale-110 transition-transform">
                        <Upload className="w-5 h-5 text-indigo-600" />
                      </div>
                      <p className="text-[10px] font-bold text-indigo-700 uppercase text-center">Clique para Upload ou Cole (Ctrl+V)</p>
                      <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
                    </label>
                    <div className="flex items-center justify-center gap-1.5 text-[8px] text-indigo-400 font-bold uppercase">
                      <Clipboard className="w-2.5 h-2.5" />
                      <span>Área de Transferência Suportada</span>
                    </div>
                  </>
                )}
                {scanError && (
                  <div className="flex items-center gap-2 text-red-600 bg-red-50 p-2 rounded-lg text-[9px] font-bold uppercase">
                    <AlertCircle className="w-3 h-3" />
                    {scanError}
                  </div>
                )}
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