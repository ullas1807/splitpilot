import { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';

function Clicker({ onPick }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}
function Recenter({ position }) {
  const map = useMap();
  useEffect(() => { if (position) map.setView([position.lat, position.lng], Math.max(map.getZoom(), 15)); }, [position, map]);
  return null;
}

export default function MapPicker({ position, onChange, height = 220 }) {
  return (
    <MapContainer center={position ? [position.lat, position.lng] : [20, 0]} zoom={position ? 15 : 2} style={{ height, width: '100%', borderRadius: 12 }}>
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Clicker onPick={onChange} />
      <Recenter position={position} />
      {position && <Marker position={[position.lat, position.lng]} />}
    </MapContainer>
  );
}
