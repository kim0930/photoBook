import { Pause, Play, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Photo } from '../types'

interface Props {
  photo: Photo
  onSelect: (dataUrl: string) => void
  onClose: () => void
}

export function LivePhotoPicker({ photo, onSelect, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState(false)
  const [movieUrl] = useState(() => (photo.movie ? URL.createObjectURL(photo.movie) : ''))

  useEffect(() => {
    return () => {
      if (movieUrl) URL.revokeObjectURL(movieUrl)
    }
  }, [movieUrl])

  function capture() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    onSelect(canvas.toDataURL('image/jpeg', 0.94))
    onClose()
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="실시간 사진 장면 선택">
      <div className="modal">
        <header>
          <div>
            <span className="eyebrow">LIVE PHOTO</span>
            <h2>메인 장면 선택</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="닫기"><X /></button>
        </header>
        {error ? (
          <div className="video-error">
            이 MOV의 HEVC 코덱을 브라우저가 재생할 수 없습니다. 아이폰의 원본 HEIC 장면을 사용해주세요.
          </div>
        ) : (
          <video
            ref={videoRef}
            src={movieUrl}
            className="live-video"
            playsInline
            onError={() => setError(true)}
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        )}
        {!error && (
          <div className="timeline-row">
            <button
              className="icon-button"
              onClick={() => {
                const video = videoRef.current
                if (!video) return
                if (video.paused) void video.play()
                else video.pause()
              }}
              aria-label={playing ? '일시정지' : '재생'}
            >
              {playing ? <Pause /> : <Play />}
            </button>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.01}
              value={time}
              onChange={(event) => {
                const next = Number(event.target.value)
                setTime(next)
                if (videoRef.current) videoRef.current.currentTime = next
              }}
            />
            <span>{time.toFixed(1)}초</span>
          </div>
        )}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>취소</button>
          <button className="primary-button" disabled={error} onClick={capture}>이 장면 사용</button>
        </div>
      </div>
    </div>
  )
}
