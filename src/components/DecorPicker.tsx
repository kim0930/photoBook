import { useRef } from 'react'
import {
  applyCoverTheme,
  COVER_THEMES,
  FRAME_TEMPLATES,
  frameFromTemplate,
  readFrameImage,
} from '../decorate/frames'
import type { BookCoverDesign, DecorFrame, FrameTemplateId } from '../types'

export function PageDecorPicker({
  frame,
  onChange,
  onClose,
}: {
  frame: DecorFrame
  onChange: (next: DecorFrame) => void
  onClose: () => void
}) {
  return (
    <DecorShell title="페이지 테두리" onClose={onClose}>
      <FrameControls frame={frame} onChange={onChange} />
    </DecorShell>
  )
}

export function CoverDecorPicker({
  cover,
  onCoverChange,
  onClose,
}: {
  cover: BookCoverDesign
  onCoverChange: (patch: Partial<BookCoverDesign>) => void
  onClose: () => void
}) {
  const frame = cover.frame ?? frameFromTemplate('none')
  return (
    <DecorShell title="표지 꾸미기" onClose={onClose}>
      <section className="decor-section">
        <header>
          <h4>표지 테마</h4>
          <p>색과 테두리를 한 번에 적용합니다.</p>
        </header>
        <div className="decor-grid">
          {COVER_THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`decor-swatch${cover.themeId === theme.id ? ' is-active' : ''}`}
              onClick={() => onCoverChange(applyCoverTheme(theme.id, cover))}
            >
              <span
                className="decor-swatch-preview cover-theme-preview"
                style={{ background: theme.backgroundColor, color: theme.textColor }}
              >
                <em>Aa</em>
              </span>
              <strong>{theme.label}</strong>
              <small>{theme.hint}</small>
            </button>
          ))}
        </div>
      </section>
      <FrameControls
        frame={frame}
        onChange={(next) => onCoverChange({ frame: next, themeId: 'custom' })}
      />
    </DecorShell>
  )
}

function DecorShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="decor-picker" role="dialog" aria-label={title}>
      <header className="decor-picker-head">
        <strong>{title}</strong>
        <button type="button" onClick={onClose} aria-label="닫기">×</button>
      </header>
      <div className="decor-picker-body">{children}</div>
    </div>
  )
}

function FrameControls({
  frame,
  onChange,
}: {
  frame: DecorFrame
  onChange: (next: DecorFrame) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <section className="decor-section">
      <header>
        <h4>테두리 템플릿</h4>
        <p>예제를 고르거나, 색·굵기·이미지를 직접 넣으세요.</p>
      </header>
      <div className="decor-grid">
        {FRAME_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            className={`decor-swatch${frame.templateId === template.id ? ' is-active' : ''}`}
            onClick={() => onChange(frameFromTemplate(template.id, frame))}
          >
            <span className={`decor-swatch-preview frame-preview frame-${template.id}`}>
              {template.id === 'corner-flourish' && (
                <>
                  <i className="frame-corner tl" />
                  <i className="frame-corner tr" />
                  <i className="frame-corner bl" />
                  <i className="frame-corner br" />
                </>
              )}
            </span>
            <strong>{template.label}</strong>
            <small>{template.hint}</small>
          </button>
        ))}
      </div>

      {frame.templateId !== 'none' && (
        <div className="decor-custom">
          <label className="note-swatch">
            색
            <input
              type="color"
              aria-label="테두리 색"
              value={frame.color}
              onChange={(event) => onChange({
                ...frame,
                templateId: frame.templateId === 'custom' ? 'custom' : frame.templateId,
                color: event.target.value,
              })}
            />
          </label>
          <label className="note-swatch">
            강조
            <input
              type="color"
              aria-label="테두리 강조색"
              value={frame.accentColor ?? frame.color}
              onChange={(event) => onChange({ ...frame, accentColor: event.target.value })}
            />
          </label>
          <label className="note-opacity">
            굵기
            <input
              type="range"
              min={0.6}
              max={3}
              step={0.1}
              aria-label="테두리 굵기"
              value={frame.weight}
              onChange={(event) => onChange({ ...frame, weight: Number(event.target.value) })}
            />
          </label>
          <label className="note-opacity">
            여백
            <input
              type="range"
              min={0.5}
              max={8}
              step={0.1}
              aria-label="테두리 안쪽 여백"
              value={frame.inset}
              onChange={(event) => onChange({ ...frame, inset: Number(event.target.value) })}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => fileRef.current?.click()}
          >
            장식 이미지 넣기
          </button>
          <input
            ref={fileRef}
            className="hidden-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              void (async () => {
                try {
                  const customImageDataUrl = await readFrameImage(file)
                  onChange({
                    ...frame,
                    templateId: 'custom' as FrameTemplateId,
                    customImageDataUrl,
                  })
                } catch (error) {
                  window.alert(error instanceof Error ? error.message : '이미지를 넣지 못했습니다.')
                }
              })()
            }}
          />
          {frame.customImageDataUrl && (
            <button
              type="button"
              className="text-button"
              onClick={() => onChange({ ...frame, customImageDataUrl: undefined })}
            >
              이미지 제거
            </button>
          )}
        </div>
      )}
    </section>
  )
}
