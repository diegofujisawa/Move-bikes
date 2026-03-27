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

const AdminMap: React.FC<AdminMapProps> = ({ onLogout, onClose }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [driverCount, setDriverCount] = useState(0);

  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<{ [key: string]: L.Marker }>({});
  const pathsRef = useRef<{ [key: string]: L.Polyline }>({});
  const lastLocsRef = useRef<DriverLocation[]>([]);
  const hasCenteredRef = useRef(false);

  const updateMapWithLocations = useCallback((locations: DriverLocation[]) => {
    if (!mapContainerRef.current) return;
    lastLocsRef.current = locations;

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
    }

    const map = mapRef.current;
    const currentMarkers = markersRef.current;
    const currentPaths = pathsRef.current;
    const activeDrivers = new Set<string>();
    const markerGroup: L.LatLng[] = [];

    locations.forEach(loc => {
      const { driverName, latitude, longitude, timestamp, speed } = loc;
      const ts = timestamp ? new Date(timestamp).getTime() : 0;
      const isStale = ts > 0 && (Date.now() - ts) > 120000; // 2 min
      const normLat = normalizeCoord(latitude);
      const normLng = normalizeCoord(longitude);
      if (isNaN(normLat) || isNaN(normLng) || normLat === 0 || normLng === 0) return;

      const position = L.latLng(normLat, normLng);
      activeDrivers.add(driverName);
      markerGroup.push(position);

      // Atualiza ou cria o rastro (polyline)
      if (currentPaths[driverName]) {
        const path = currentPaths[driverName];
        const latlngs = path.getLatLngs() as L.LatLng[];
        // Adiciona nova posição se for diferente da última
        if (latlngs.length === 0 || !latlngs[latlngs.length - 1].equals(position)) {
          latlngs.push(position);
          // Mantém apenas os últimos 50 pontos para performance
          if (latlngs.length > 50) latlngs.shift();
          path.setLatLngs(latlngs);
        }
      } else {
        const path = L.polyline([position], {
          color: '#3b82f6',
          weight: 3,
          opacity: 0.5,
          dashArray: '5, 10'
        }).addTo(map);
        currentPaths[driverName] = path;
      }

      const tooltipClass = isStale
        ? 'bg-orange-500 text-white font-bold px-2 py-1 rounded shadow-lg border-none'
        : 'bg-blue-600 text-white font-bold px-2 py-1 rounded shadow-lg border-none';
      
      const speedLabel = speed !== undefined && speed > 0 ? ` | ${speed} km/h` : ' | 0 km/h';
      const label = `${driverName}${speedLabel}${isStale ? ' ⚠️' : ''}`;

      if (currentMarkers[driverName]) {
        currentMarkers[driverName].setLatLng(position);
        currentMarkers[driverName].unbindTooltip();
        currentMarkers[driverName].bindTooltip(label, { permanent: true, direction: 'top', className: tooltipClass });
      } else {
        const marker = L.marker(position, { title: driverName }).addTo(map);
        marker.bindTooltip(label, { permanent: true, direction: 'top', className: tooltipClass });
        currentMarkers[driverName] = marker;
      }
    });

    if (markerGroup.length > 0 && !hasCenteredRef.current) {
      map.fitBounds(L.latLngBounds(markerGroup), { padding: [70, 70] });
      hasCenteredRef.current = true;
    }

    // Remove marcadores e rastros de motoristas inativos
    Object.keys(currentMarkers).forEach(name => {
      if (!activeDrivers.has(name)) {
        map.removeLayer(currentMarkers[name]);
        delete currentMarkers[name];
        if (currentPaths[name]) {
          map.removeLayer(currentPaths[name]);
          delete currentPaths[name];
        }
      }
    });

    setDriverCount(activeDrivers.size);
  }, []);

  const handleRecenter = useCallback(() => {
    if (!mapRef.current) return;
    const markerGroup = Object.values(markersRef.current).map(m => m.getLatLng());
    if (markerGroup.length > 0) {
      mapRef.current.fitBounds(L.latLngBounds(markerGroup), { padding: [70, 70] });
    }
  }, []);

  // Timer para atualizar o contador de segundos nos tooltips sem precisar de novo evento do Firebase
  useEffect(() => {
    const interval = setInterval(() => {
      if (lastLocsRef.current.length > 0) {
        updateMapWithLocations(lastLocsRef.current);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [updateMapWithLocations]);

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
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      markersRef.current = {};
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