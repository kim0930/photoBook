import { MapContainer, Polyline, TileLayer, CircleMarker, Tooltip } from 'react-leaflet'
import type { Photo } from '../types'

export function TripMap({ photos }: { photos: Photo[] }) {
  const located = photos.filter(
    (photo): photo is Photo & { latitude: number; longitude: number } =>
      photo.latitude != null && photo.longitude != null,
  )
  const positions = located.map((photo) => [photo.latitude, photo.longitude] as [number, number])

  if (!positions.length) {
    return (
      <div className="map-empty">
        <strong>위치 정보가 없습니다</strong>
        <span>아이폰 카메라의 위치 서비스가 켜진 사진에서 여행 경로가 표시됩니다.</span>
      </div>
    )
  }

  return (
    <MapContainer bounds={positions} boundsOptions={{ padding: [30, 30] }} zoomControl={false} className="trip-map">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Polyline positions={positions} pathOptions={{ color: '#e3533d', weight: 4 }} />
      {located.map((photo, index) => (
        <CircleMarker
          key={photo.id}
          center={[photo.latitude, photo.longitude]}
          radius={index === 0 || index === located.length - 1 ? 7 : 4}
          pathOptions={{ color: '#fff', weight: 2, fillColor: '#e3533d', fillOpacity: 1 }}
        >
          <Tooltip>{new Date(photo.capturedAt).toLocaleDateString('ko-KR')}</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  )
}
