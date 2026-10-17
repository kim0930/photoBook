import { useEffect } from 'react'
import L from 'leaflet'
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import type { Photo } from '../types'

function InvalidateSize({ token }: { token?: string }) {
  const map = useMap()
  useEffect(() => {
    if (!token) return
    const timer = window.setTimeout(() => map.invalidateSize({ animate: false }), 40)
    return () => window.clearTimeout(timer)
  }, [map, token])
  return null
}

function project(lat: number, lng: number, bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }) {
  const pad = 0.08
  const latSpan = Math.max(bounds.maxLat - bounds.minLat, 0.002)
  const lngSpan = Math.max(bounds.maxLng - bounds.minLng, 0.002)
  const x = pad + ((lng - bounds.minLng) / lngSpan) * (1 - pad * 2)
  const y = pad + ((bounds.maxLat - lat) / latSpan) * (1 - pad * 2)
  return { x: x * 100, y: y * 100 }
}

function photoIcon(photo: Photo, size = 36) {
  const src = photo.thumbUrl || photo.url || ''
  return L.divIcon({
    className: 'photo-map-marker',
    html: `<span class="photo-map-marker-inner"><img src="${src.replace(/"/g, '&quot;')}" alt="" /></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

/** OSM 타일 없이 경로·대표 사진만 그려 PDF/html-to-image가 깨지지 않게 함 */
function StaticRouteMap({
  photos,
  showPhotos = false,
}: {
  photos: Array<Photo & { latitude: number; longitude: number }>
  showPhotos?: boolean
}) {
  const lats = photos.map((photo) => photo.latitude)
  const lngs = photos.map((photo) => photo.longitude)
  const bounds = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  }
  const points = photos.map((photo) => ({
    photo,
    ...project(photo.latitude, photo.longitude, bounds),
  }))
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')

  return (
    <div className="trip-map is-static static-route-map" aria-hidden>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          {showPhotos && points.map((point) => (
            <clipPath key={`clip-${point.photo.id}`} id={`map-photo-${point.photo.id}`}>
              <circle cx={point.x} cy={point.y} r="3.6" />
            </clipPath>
          ))}
        </defs>
        <rect width="100" height="100" fill="#dfe8df" />
        <path d="M0 72 Q25 58 50 68 T100 55" fill="none" stroke="#c5d0c4" strokeWidth="2.2" />
        <path d="M0 40 Q30 28 55 38 T100 30" fill="none" stroke="#c5d0c4" strokeWidth="1.6" />
        {!showPhotos && (
          <path d={path} fill="none" stroke="#e3533d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {points.map((point, index) => (
          showPhotos ? (
            <g key={point.photo.id}>
              <image
                href={point.photo.thumbUrl || point.photo.url}
                x={point.x - 3.6}
                y={point.y - 3.6}
                width="7.2"
                height="7.2"
                preserveAspectRatio="xMidYMid slice"
                clipPath={`url(#map-photo-${point.photo.id})`}
              />
              <circle cx={point.x} cy={point.y} r="3.6" fill="none" stroke="#fff" strokeWidth="0.7" />
            </g>
          ) : (
            <circle
              key={`${point.x}-${point.y}-${index}`}
              cx={point.x}
              cy={point.y}
              r={index === 0 || index === points.length - 1 ? 2.4 : 1.5}
              fill="#e3533d"
              stroke="#fff"
              strokeWidth="0.7"
            />
          )
        ))}
      </svg>
    </div>
  )
}

export function TripMap({
  photos,
  interactive = true,
  sizeToken,
  forExport = false,
  showPhotos = false,
  showRoute = true,
}: {
  photos: Photo[]
  interactive?: boolean
  sizeToken?: string
  forExport?: boolean
  showPhotos?: boolean
  showRoute?: boolean
}) {
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

  if (forExport) return <StaticRouteMap photos={located} showPhotos={showPhotos} />

  return (
    <MapContainer
      bounds={positions}
      boundsOptions={{ padding: [36, 36] }}
      zoomControl={false}
      dragging={interactive}
      scrollWheelZoom={interactive}
      doubleClickZoom={interactive}
      touchZoom={interactive}
      boxZoom={interactive}
      keyboard={interactive}
      className={`trip-map${interactive ? '' : ' is-static'}${showPhotos ? ' has-photos' : ''}`}
    >
      <InvalidateSize token={sizeToken} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {showRoute && !showPhotos && (
        <Polyline positions={positions} pathOptions={{ color: '#e3533d', weight: 4 }} />
      )}
      {located.map((photo, index) => (
        showPhotos ? (
          <Marker key={photo.id} position={[photo.latitude, photo.longitude]} icon={photoIcon(photo)}>
            {interactive && (
              <Tooltip>
                {new Date(photo.capturedAt).toLocaleDateString('ko-KR')}
              </Tooltip>
            )}
          </Marker>
        ) : (
          <CircleMarker
            key={photo.id}
            center={[photo.latitude, photo.longitude]}
            radius={index === 0 || index === located.length - 1 ? 7 : 4}
            pathOptions={{ color: '#fff', weight: 2, fillColor: '#e3533d', fillOpacity: 1 }}
          >
            {interactive && <Tooltip>{new Date(photo.capturedAt).toLocaleDateString('ko-KR')}</Tooltip>}
          </CircleMarker>
        )
      ))}
    </MapContainer>
  )
}
