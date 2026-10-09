import { useMemo, useState } from 'react'
import { useBookStore } from '../store'
import { buildMemories, type MemoryCard } from '../curate/memories'
import { scanDocuments } from '../curate/ocr'

const KIND_LABEL = {
  trip: '여행',
  event: '사건',
  month: '하이라이트',
  place: '장소',
  color: '색',
  person: '사람',
} as const

export function MemoriesPanel() {
  const photos = useBookStore((state) => state.photos)
  const chapters = useBookStore((state) => state.chapters)
  const curation = useBookStore((state) => state.curation)
  const faceGroups = useBookStore((state) => state.faceGroups)
  const includePhotos = useBookStore((state) => state.includePhotos)
  const hideDateRange = useBookStore((state) => state.hideDateRange)
  const removeHiddenRange = useBookStore((state) => state.removeHiddenRange)
  const setPhotoText = useBookStore((state) => state.setPhotoText)
  const [openId, setOpenId] = useState<string>()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const cards = useMemo(
    () => buildMemories(photos, chapters, curation.hiddenRanges, curation.faceGroupsEnabled ? faceGroups : []),
    [photos, chapters, curation, faceGroups],
  )
  const needle = query.trim().toLowerCase()
  const textMatches = needle
    ? photos.filter((photo) => photo.ocrText?.toLowerCase().includes(needle)).map((photo) => photo.id)
    : []
  const visible = cards.filter((card) => {
    if (!needle) return true
    if (card.title.toLowerCase().includes(needle) || card.subtitle.toLowerCase().includes(needle)) return true
    return card.photoIds.some((id) => textMatches.includes(id))
  })
  const open = cards.find((card) => card.id === openId)

  async function searchText() {
    if (!needle || searching) return
    setSearching(true)
    try {
      await scanDocuments(photos, (id, text, document) => setPhotoText(id, text, document))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="memories-panel">
      <form className="memory-search" onSubmit={(event) => { event.preventDefault(); void searchText() }}>
        <input aria-label="추억 검색" value={query} placeholder="제목 또는 사진 속 글자" onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" disabled={searching}>{searching ? '읽는 중' : '글자 검색'}</button>
      </form>
      {curation.hiddenRanges.length > 0 && (
        <div className="hidden-ranges">
          {curation.hiddenRanges.map((range) => (
            <button key={range.id} type="button" onClick={() => removeHiddenRange(range.id)}>
              {range.start} – {range.end} 숨김 해제
            </button>
          ))}
        </div>
      )}
      <div className="memory-list">
        {visible.map((card) => (
          <button key={card.id} type="button" className={`memory-card kind-${card.kind}${card.id === openId ? ' open' : ''}`} onClick={() => setOpenId(card.id === openId ? undefined : card.id)}>
            <small>{KIND_LABEL[card.kind]}</small>
            <strong>{card.title}</strong>
            <span>{card.subtitle}</span>
            <MemoryThumbs card={card} />
          </button>
        ))}
        {!visible.length && <p className="tray-empty">보여줄 추억이 없습니다.</p>}
      </div>
      {open && (
        <div className="memory-detail">
          <div className="memory-actions">
            <button type="button" onClick={() => includePhotos(open.photoIds)}>책에 넣기</button>
            {open.start && open.end && (
              <button type="button" onClick={() => hideDateRange(open.start!, open.end!)}>이 날짜 숨기기</button>
            )}
          </div>
          <div className="memory-photos">
            {open.photoIds.map((id) => {
              const photo = photos.find((item) => item.id === id)
              if (!photo) return null
              const groupId = open.kind === 'person' ? open.id.replace('memory-person-', '') : ''
              return (
                <figure key={id}>
                  <img src={photo.thumbUrl} alt={photo.name} />
                  {groupId && (
                    <button type="button" onClick={() => useBookStore.getState().removeFacePhoto(groupId, id)}>빼기</button>
                  )}
                </figure>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function MemoryThumbs({ card }: { card: MemoryCard }) {
  const photos = useBookStore((state) => state.photos)
  return (
    <span className="memory-thumbs">
      {card.photoIds.slice(0, 3).map((id) => {
        const photo = photos.find((item) => item.id === id)
        return photo ? <img key={id} src={photo.thumbUrl} alt="" /> : null
      })}
    </span>
  )
}
