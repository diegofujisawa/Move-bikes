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
  const currentLocsRef = useRef<{ [key: string]: { lat: number; lng: number } }>({});
  const animFrameRef = useRef<number | null>(null);
  const hasCenteredRef = useRef(false);

  // Loop de animação — roda a ~60fps, interpola posições suavemente
  const animationLoop = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const LERP_SPEED = 0.08; // 0.08 = ~60 frames para cobrir 100% da distância (~1s para chegada)

    Object.entries(targetLocsRef.current).forEach(([name, target]) => {
      const current = currentLocsRef.current[name];
      if (!current) {
        // Primeira aparição — posiciona direto sem animar
        currentLocsRef.current[name] = { lat: target.lat, lng: target.lng };
        return;
      }

      // Interpolação suave
      const newLat = lerp(current.lat, target.lat, LERP_SPEED);
      const newLng = lerp(current.lng, target.lng, LERP_SPEED);
      currentLocsRef.current[name] = { lat: newLat, lng: newLng };

      const marker = markersRef.current[name];
      if (marker) {
        marker.setLatLng([newLat, newLng]);
      }
    });

    animFrameRef.current = requestAnimationFrame(animationLoop);
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

      // Atualiza posição alvo — a animação vai interpolar até ela
      targetLocsRef.current[driverName] = { lat: normLat, lng: normLng, timestamp: ts, speed: speed || 0, stale: isStale };

      // Atualiza rastro (polyline) com a posição REAL (não interpolada)
      const position = L.latLng(normLat, normLng);
      if (pathsRef.current[driverName]) {
        const path = pathsRef.current[driverName];
        const latlngs = path.getLatLngs() as L.LatLng[];
        if (latlngs.length === 0 || !latlngs[latlngs.length - 1].equals(position, 1e-5)) {
          latlngs.push(position);
          if (latlngs.length > 100) latlngs.shift();
          path.setLatLngs(latlngs);
        }
      } else {
        pathsRef.current[driverName] = L.polyline([position], {
          color: '#3b82f6', weight: 3, opacity: 0.4, dashArray: '5, 10'
        }).addTo(map);
      }

      // Cria marcador se não existir — posição inicial = alvo (sem anim na criação)
      if (!markersRef.current[driverName]) {
        if (!currentLocsRef.current[driverName]) {
          currentLocsRef.current[driverName] = { lat: normLat, lng: normLng };
        }
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
        const marker = L.marker([currentLocsRef.current[driverName].lat, currentLocsRef.current[driverName].lng], { title: driverName, icon: driverIcon }).addTo(map);
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
        delete currentLocsRef.current[name];
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
      currentLocsRef.current = {};
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