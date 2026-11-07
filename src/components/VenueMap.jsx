import { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';

function Fit({ markers }) {
  const map = useMap();
  useEffect(() => {
    if (markers.length === 1) map.setView([markers[0].lat, markers[0].lng], 15);
    else if (markers.length > 1) map.fitBounds(L.latLngBounds(markers.map((m) => [m.lat, m.lng])), { padding: [30, 30], maxZoom: 14 });
  }, [markers, map]);
  return null;
}

// markers: [{ id, lat, lng, label, href? }]  -  tiles and data: OpenStreetMap contributors
export default function VenueMap({ markers, height = 260 }) {
  const valid = markers.filter((m) => typeof m.lat === 'number' && typeof m.lng === 'number');
  if (!valid.length) return <div className="map-empty" style={{ height }}>No location set</div>;
  return (
    <MapContainer center={[valid[0].lat, valid[0].lng]} zoom={14} style={{ height, width: '100%', borderRadius: 12 }} scrollWheelZoom={false}>
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Fit markers={valid} />
      {valid.map((m) => (
        <Marker key={m.id} position={[m.lat, m.lng]}>
          <Popup>
            {m.href ? <a href={m.href}>{m.label}</a> : m.label}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
