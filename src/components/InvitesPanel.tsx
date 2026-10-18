import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { fetchInviteConfig, isAdminEmailAsync, saveInviteEmails } from '../auth/invites'

export function InvitesPanel() {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [text, setText] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const admin = await isAdminEmailAsync(user?.email)
      if (cancelled) return
      setIsAdmin(admin)
      if (!admin) return
      const config = await fetchInviteConfig(true)
      if (!cancelled) setText(config.emails.join('\n'))
    })()
    return () => { cancelled = true }
  }, [user?.email])

  if (!isAdmin) return null

  return (
    <section className="invites-panel" aria-label="초대 목록 관리">
      <header>
        <h3>초대 이메일</h3>
        <p>한 줄에 하나씩 입력하세요. Firestore에 저장되며 재배포 없이 반영됩니다.</p>
      </header>
      <textarea
        value={text}
        rows={6}
        spellCheck={false}
        placeholder="friend@gmail.com"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="invites-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !user?.email}
          onClick={() => {
            void (async () => {
              if (!user?.email) return
              setBusy(true)
              setStatus('')
              try {
                const emails = text.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)
                await saveInviteEmails(emails, user.email)
                setStatus(`${emails.length}명을 저장했습니다.`)
              } catch (error) {
                setStatus(error instanceof Error ? error.message : '저장에 실패했습니다.')
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          {busy ? '저장 중…' : '초대 목록 저장'}
        </button>
        {status && <small>{status}</small>}
      </div>
    </section>
  )
}
