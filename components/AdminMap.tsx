import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LogoutIcon, MapIcon, XIcon } from './icons';
import { DriverLocation } from '../types';
import { apiGetCall } from '../api';
import L from 'leaflet';

// Fix for default marker icons in Leaflet
import 'leaflet/dist/leaflet.css';

interface AdminMapProps {
  adminName: string;
  onLogout: () => void;
  onClose: () => void;
}

const AdminMap: React.FC<AdminMapProps> = ({ onLogout, onClose }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<{ [key: string]: L.Marker }>({});
  
  const fetchLocationsAndUpdateMap = useCallback(async () => {
    try {
      const result = await apiGetCall('getDriverLocations');
      const locations = (result.data || []) as DriverLocation[];
      setError(null);
      
      if (!mapContainerRef.current) return;

      // Inicializa o mapa apenas uma vez usando Leaflet (GRATUITO)
      if (!mapRef.current) {
          const map = L.map(mapContainerRef.current, {
              center: [-23.1791, -45.8872], // Coordenadas do centro de São José dos Campos
              zoom: 12,
              zoomControl: true,
              attributionControl: true
          });

          // Adiciona os tiles do OpenStreetMap (Gratuito e sem limite de uso)
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
              attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          }).addTo(map);

          mapRef.current = map;
      }

      if (mapRef.current) {
          const map = mapRef.current;
          const currentMarkers = markersRef.current;
          const activeDrivers = new Set<string>();
          const markerGroup: L.LatLngExpression[] = [];

          locations.forEach(loc => {
              const { driverName, latitude, longitude } = loc;
              const position: L.LatLngExpression = [latitude, longitude];
              activeDrivers.add(driverName);
              markerGroup.push(position);

              if (currentMarkers[driverName]) {
                  currentMarkers[driverName].setLatLng(position);
              } else {
                  const marker = L.marker(position, {
                      title: driverName,
                  }).addTo(map);

                  marker.bindTooltip(driverName, { 
                      permanent: true, 
                      direction: 'top',
                      className: 'bg-blue-600 text-white font-bold px-2 py-1 rounded shadow-lg border-none'
                  });

                  currentMarkers[driverName] = marker;
              }
          });

          if (markerGroup.length > 0 && isLoading) {
              const bounds = L.latLngBounds(markerGroup);
              map.fitBounds(bounds, { padding: [50, 50] });
          }

          Object.keys(currentMarkers).forEach(driverName => {
              if (!activeDrivers.has(driverName)) {
                  map.removeLayer(currentMarkers[driverName]);
                  delete currentMarkers[driverName];
              }
          });
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocorreu um erro ao buscar localizações.');
    }
  }, [isLoading]);

  useEffect(() => {
    let isMounted = true;
    
    const runProcess = async () => {
      await fetchLocationsAndUpdateMap();
      if (isMounted) {
        setIsLoading(false);
      }
    };

    runProcess();
    
    const intervalId = setInterval(fetchLocationsAndUpdateMap, 10000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
      if (mapRef.current) {
          mapRef.current.remove();
          mapRef.current = null;
      }
      markersRef.current = {};
    };
  }, [fetchLocationsAndUpdateMap]);

  return (
    <div className="bg-white p-6 rounded-xl shadow-lg w-full h-full flex flex-col">
      <header className="flex justify-between items-center mb-4 pb-4 border-b flex-shrink-0">
        <div className="flex items-center gap-3">
          <MapIcon className="w-6 h-6 text-blue-600"/>
          <h2 className="font-semibold text-gray-700">Mapa de Motoristas (OpenStreetMap - Gratuito)</h2>
        </div>
        <div className="flex items-center gap-2">
            <button onClick={onClose} title="Fechar Mapa" className="p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors">
                <XIcon className="w-5 h-5" />
            </button>
            <button onClick={onLogout} title="Sair" className="p-2 rounded-full text-gray-500 hover:bg-gray-100 hover:text-red-600 transition-colors">
                <LogoutIcon className="w-5 h-5" />
            </button>
        </div>
      </header>
      <main className="flex-grow relative bg-gray-100 rounded-md overflow-hidden">
        <div id="map-container" ref={mapContainerRef} className="w-full h-full z-0"></div>
        
        {(isLoading || error) && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-100/50 backdrop-blur-sm z-10">
                <div className="bg-white p-6 rounded-lg shadow-2xl text-center">
                    {isLoading && (
                        <div className="flex items-center gap-3 text-gray-600">
                            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                            <span>Carregando mapa gratuito...</span>
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
