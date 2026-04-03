import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LogoutIcon, MapIcon, XIcon, MovingIcon } from './icons';
import { DriverLocation } from '../types';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface AdminMapProps {
  adminName: string;
  onLogout: () => void;
  onClose: () => void;
  driverLocations?: any[];
}

const normalizeCoord = (coord: number): number => {
  if (isNaN(coord) || coord === null) return coord;
  let val = coord;
  if (Math.abs(val) > 1000) {
    while (Math.abs(val) > 180) val /= 10;
  }
  return val;
};

// Interpolação linear entre dois pontos para animação suave
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};
const getDistanceInMeters = (lat1: number, lon1: number, lat2: number, lon2: number) =>
  calculateDistance(lat1, lon1, lat2, lon2) * 1000;

const AdminMap: React.FC<AdminMapProps> = ({ onLogout, onClose }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [driverCount, setDriverCount] = useState(0);

  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<{ [key: string]: L.Marker }>({});
  const pathsRef = useRef<{ [key: string]: L.Polyline }>({});

  // Posições alvo (do Firebase) e posições atuais (animadas)
  const targetLocsRef = useRef<{ [key: string]: { lat: number; lng: number; timestamp: number; speed: number; stale: boolean } }>({});
  // Cada motorista tem: posição de origem, posição alvo, tempo de início e duração da animação
  const animStatesRef = useRef<{ [key: string]: {
    fromLat: number; fromLng: number;
    toLat: number; toLng: number;
    startTime: number; duration: number; // ms
  } }>({});
  const animFrameRef = useRef<number | null>(null);
  const hasCenteredRef = useRef(false);

  // Loop de animação baseado em tempo — sempre leva DURATION ms para completar
  // independente da distância, eliminando teletransporte
  const ANIM_DURATION = 3000; // ms — igual ao intervalo de envio do GPS

  const animationLoop = useCallback(function loop() {
    const map = mapRef.current;
    if (!map) return;

    const now = performance.now();

    Object.entries(animStatesRef.current).forEach(([name, anim]) => {
      const elapsed = now - anim.startTime;
      // t vai de 0 a 1 ao longo de DURATION ms — easing linear para movimento constante
      const t = Math.min(elapsed / anim.duration, 1);

      const lat = lerp(anim.fromLat, anim.toLat, t);
      const lng = lerp(anim.fromLng, anim.toLng, t);

      const marker = markersRef.current[name];
      if (marker) marker.setLatLng([lat, lng]);
    });

    animFrameRef.current = requestAnimationFrame(loop);
  }, []);

  const startAnimationLoop = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(animationLoop);
  }, [animationLoop]);

  const updateMapWithLocations = useCallback((locations: DriverLocation[]) => {
    if (!mapContainerRef.current) return;

    if (!mapRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: [-23.1791, -45.8872],
        zoom: 12,
        zoomControl: true,
        attributionControl: true
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
      mapRef.current = map;
      startAnimationLoop();
    }

    const map = mapRef.current;
    const activeDrivers = new Set<string>();
    const markerGroup: L.LatLng[] = [];

    locations.forEach(loc => {
      const { driverName, latitude, longitude, timestamp, speed } = loc;
      const ts = timestamp ? new Date(timestamp).getTime() : 0;
      const isStale = ts > 0 && (Date.now() - ts) > 120000; // 2 min
      const normLat = normalizeCoord(latitude);
      const normLng = normalizeCoord(longitude);
      if (isNaN(normLat) || isNaN(normLng) || normLat === 0 || normLng === 0) return;

      activeDrivers.add(driverName);
      markerGroup.push(L.latLng(normLat, normLng));

      // Atualiza posição alvo — inicia nova animação APENAS se o alvo mudou
      const prevAnim = animStatesRef.current[driverName];
      const prevTarget = targetLocsRef.current[driverName];

      // Se o alvo é o mesmo e ainda estamos animando, não faz nada
      if (prevTarget && prevTarget.lat === normLat && prevTarget.lng === normLng && prevAnim) {
        const elapsed = performance.now() - prevAnim.startTime;
        if (elapsed < prevAnim.duration) {
          // Ainda animando para o mesmo alvo, deixa continuar
          return;
        }
      }

      // Ponto de partida = posição atual interpolada (ou alvo anterior se não há anim)
      let fromLat = normLat, fromLng = normLng;
      if (prevAnim) {
        const elapsed = performance.now() - prevAnim.startTime;
        const raw = Math.min(elapsed / prevAnim.duration, 1);
        const t = 1 - Math.pow(1 - raw, 3);
        fromLat = lerp(prevAnim.fromLat, prevAnim.toLat, t);
        fromLng = lerp(prevAnim.fromLng, prevAnim.toLng, t);
      }

      // Calcula distância para ajustar duração — posições muito próximas animam mais rápido
      const distM = getDistanceInMeters(fromLat, fromLng, normLat, normLng);
      
      // Se a distância for insignificante (< 0.5m) e já tivermos um alvo, não reinicia animação
      if (distM < 0.5 && prevTarget) return;

      // Entre 1s (parado) e 3s (movimento longo) — proporcional à distância
      const duration = Math.min(Math.max(distM * 300, 1000), ANIM_DURATION);

      animStatesRef.current[driverName] = {
        fromLat, fromLng,
        toLat: normLat, toLng: normLng,
        startTime: performance.now(),
        duration,
      };
      targetLocsRef.current[driverName] = { lat: normLat, lng: normLng, timestamp: ts, speed: speed || 0, stale: isStale };

      // Atualiza rastro (polyline) com a posição REAL (não interpolada)
      // Processa o buffer para preencher buracos de conexão
      const path = pathsRef.current[driverName];
      if (path) {
        const latlngs = path.getLatLngs() as L.LatLng[];
        const buffer = (loc.pathBuffer || [{ latitude: normLat, longitude: normLng, timestamp: ts }])
          .sort((a: any, b: any) => a.timestamp - b.timestamp); // Garante ordem cronológica
        
        buffer.forEach((p: any) => {
          const pos = L.latLng(normalizeCoord(p.latitude), normalizeCoord(p.longitude));
          // Só adiciona se for diferente do último ponto
          if (latlngs.length === 0 || !latlngs[latlngs.length - 1].equals(pos, 1e-5)) {
            latlngs.push(pos);
          }
        });

        if (latlngs.length > 500) latlngs.splice(0, latlngs.length - 500);
        path.setLatLngs(latlngs);
      } else {
        const position = L.latLng(normLat, normLng);
        pathsRef.current[driverName] = L.polyline([position], {
          color: '#2563eb', weight: 4, opacity: 0.7, dashArray: '1, 10'
        }).addTo(map);
      }

      // Cria marcador se não existir — posição inicial = posição real (sem anim na criação)
      if (!markersRef.current[driverName]) {
        // DivIcon — sem dependência de imagem, nunca quebra no Vite
        const driverIcon = L.divIcon({
          className: '',
          html: `<div style="
            width: 14px; height: 14px;
            background: #2563eb;
            border: 3px solid white;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
          "></div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        });
        const marker = L.marker([normLat, normLng], { title: driverName, icon: driverIcon }).addTo(map);
        markersRef.current[driverName] = marker;
      }

      // Atualiza tooltip com velocidade
      const tooltipClass = isStale
        ? 'bg-orange-500 text-white font-bold px-2 py-1 rounded shadow-lg border-none'
        : 'bg-blue-600 text-white font-bold px-2 py-1 rounded shadow-lg border-none';
      const speedLabel = speed !== undefined && speed > 0 ? ` ${speed} km/h` : ' 0 km/h';
      const label = `${driverName} ${speedLabel}${isStale ? ' ⚠️' : ''}`;

      markersRef.current[driverName].unbindTooltip();
      markersRef.current[driverName].bindTooltip(label, { permanent: true, direction: 'top', className: tooltipClass });
    });

    // Centraliza uma vez ao carregar
    if (markerGroup.length > 0 && !hasCenteredRef.current) {
      map.fitBounds(L.latLngBounds(markerGroup), { padding: [70, 70] });
      hasCenteredRef.current = true;
    }

    // Remove marcadores e rastros de motoristas inativos
    Object.keys(markersRef.current).forEach(name => {
      if (!activeDrivers.has(name)) {
        map.removeLayer(markersRef.current[name]);
        delete markersRef.current[name];
        delete animStatesRef.current[name];
        delete targetLocsRef.current[name];
        if (pathsRef.current[name]) {
          map.removeLayer(pathsRef.current[name]);
          delete pathsRef.current[name];
        }
      }
    });

    setDriverCount(activeDrivers.size);
  }, [startAnimationLoop]);

  const handleRecenter = useCallback(() => {
    if (!mapRef.current) return;
    const markerGroup = Object.values(markersRef.current).map(m => m.getLatLng());
    if (markerGroup.length > 0) {
      mapRef.current.fitBounds(L.latLngBounds(markerGroup), { padding: [70, 70] });
    }
  }, []);

  useEffect(() => {
    const THIRTY_MIN = 30 * 60 * 1000;

    const unsubscribe = onSnapshot(
      collection(db, 'locations'),
      (snapshot) => {
        const locs: any[] = [];
        const now = Date.now();

        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          const status = (data.status || '').toString().toUpperCase();
          if (status === 'DESLOGADO') return;
          if (!data.latitude || !data.longitude) return;
          const ts = data.timestamp?.toDate?.()?.getTime() || 0;
          const ageMs = ts ? (now - ts) : Infinity;
          if (ageMs > THIRTY_MIN) return;
          const lat = normalizeCoord(Number(data.latitude));
          const lng = normalizeCoord(Number(data.longitude));
          if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) return;
          locs.push({
            driverName: data.driverName || docSnap.id,
            latitude: lat,
            longitude: lng,
            timestamp: ts ? new Date(ts).toISOString() : '',
            speed: data.speed || 0,
            pathBuffer: data.pathBuffer || [],
          });
        });

        setIsLoading(false);
        updateMapWithLocations(locs as DriverLocation[]);
      },
      (err) => {
        console.error('[Mapa] Erro listener locations:', err);
        setError('Erro ao conectar ao banco de dados.');
        setIsLoading(false);
      }
    );

    return () => {
      unsubscribe();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      markersRef.current = {};
      animStatesRef.current = {};
      targetLocsRef.current = {};
      hasCenteredRef.current = false;
    };
  }, [updateMapWithLocations]);

  return (
    <div className="bg-white p-6 rounded-xl shadow-lg w-full h-full flex flex-col">
      <header className="flex justify-between items-center mb-3 pb-3 border-b flex-shrink-0">
        <div className="flex items-center gap-3">
          <MapIcon className="w-6 h-6 text-blue-600"/>
          <div>
            <h2 className="font-semibold text-gray-700">Mapa de Motoristas</h2>
            {driverCount > 0 && (
              <p className="text-xs text-gray-400">{driverCount} motorista{driverCount > 1 ? 's' : ''} ativo{driverCount > 1 ? 's' : ''}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleRecenter} title="Centralizar Motoristas"
            className="flex items-center gap-2 px-3 py-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors font-medium text-sm">
            <MovingIcon className="w-4 h-4"/>
            <span>Centralizar</span>
          </button>
          <button onClick={onClose} title="Fechar Mapa"
            className="p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors">
            <XIcon className="w-5 h-5"/>
          </button>
          <button onClick={onLogout} title="Sair"
            className="p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-red-600 transition-colors">
            <LogoutIcon className="w-5 h-5"/>
          </button>
        </div>
      </header>

      <div className="flex items-center gap-4 mb-3 px-1">
        <div className="flex items-center gap-1.5">
          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold text-white bg-blue-600">NOME</span>
          <span className="text-[10px] text-gray-500">GPS atualizado (últimos 2 min)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold text-white bg-orange-500">NOME</span>
          <span className="text-[10px] text-gray-500">GPS desatualizado (&gt;2 min)</span>
        </div>
      </div>

      <main className="flex-grow relative bg-gray-100 rounded-md overflow-hidden">
        <div id="map-container" ref={mapContainerRef} className="w-full h-full z-0"/>
        {(isLoading || error) && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100 z-10">
            <div className="bg-white p-6 rounded-lg shadow-2xl text-center">
              {isLoading && (
                <div className="flex flex-col items-center gap-3 text-gray-600">
                  <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"/>
                  <span className="text-sm">Carregando mapa...</span>
                </div>
              )}
              {error && <p className="text-red-600 font-semibold">{error}</p>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default AdminMap;