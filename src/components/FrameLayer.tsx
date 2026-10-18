import type { DecorFrame } from '../types'

export function FrameLayer({ frame, variant = 'page' }: {
  frame?: DecorFrame | null
  variant?: 'page' | 'cover'
}) {
  if (!frame || frame.templateId === 'none') return null

  const style = {
    '--frame-color': frame.color,
    '--frame-accent': frame.accentColor ?? frame.color,
    '--frame-weight': String(frame.weight),
    '--frame-inset': `${frame.inset}%`,
  } as React.CSSProperties

  if (frame.customImageDataUrl) {
    return (
      <div className={`frame-layer frame-custom ${variant === 'cover' ? 'is-cover' : ''}`} style={style} aria-hidden>
        <img src={frame.customImageDataUrl} alt="" />
      </div>
    )
  }

  return (
    <div
      className={`frame-layer frame-${frame.templateId} ${variant === 'cover' ? 'is-cover' : ''}`}
      style={style}
      aria-hidden
    >
      {frame.templateId === 'corner-flourish' && (
        <>
          <i className="frame-corner tl" />
          <i className="frame-corner tr" />
          <i className="frame-corner bl" />
          <i className="frame-corner br" />
        </>
      )}
      {frame.templateId === 'ribbon' && (
        <>
          <i className="frame-ribbon top" />
          <i className="frame-ribbon bottom" />
        </>
      )}
      {frame.templateId === 'film' && (
        <>
          <i className="frame-film-side left" />
          <i className="frame-film-side right" />
        </>
      )}
    </div>
  )
}
