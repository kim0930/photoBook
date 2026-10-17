import { BookOpen, LogIn } from 'lucide-react'
import { useAuth } from './AuthContext'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, error, signInWithGoogle } = useAuth()

  if (status === 'signedIn') return children

  if (status === 'loading') {
    return (
      <main className="welcome loading-screen auth-screen">
        <div className="brand"><BookOpen /><span>Year in Frames</span></div>
        <p>로그인 상태를 확인하는 중…</p>
      </main>
    )
  }

  return (
    <main className="welcome auth-screen">
      <nav className="brand"><BookOpen /><span>Year in Frames</span></nav>
      <section className="welcome-content">
        <span className="eyebrow"><LogIn size={14} /> 멤버 전용</span>
        <h1>사진은 그대로.<br /><em>추억은 한 권으로.</em></h1>
        <p className="lead">
          {status === 'misconfigured'
            ? '로그인 설정이 아직 준비되지 않았습니다. 관리자에게 문의해 주세요.'
            : '초대받은 Google 계정으로 로그인한 뒤 포토북을 만들고 편집할 수 있습니다.'}
        </p>
        <div className="import-card auth-card">
          {status !== 'misconfigured' && (
            <button type="button" className="import-button" onClick={() => void signInWithGoogle()}>
              <LogIn /> Google로 시작
            </button>
          )}
          {status === 'denied' && (
            <p className="error">초대 목록에 없는 계정입니다. 관리자에게 이메일을 알려 주세요.</p>
          )}
          {error && status !== 'denied' && <p className="error">{error}</p>}
          <p className="auth-note">사진과 포토북은 이 기기의 브라우저에만 저장됩니다.</p>
        </div>
      </section>
    </main>
  )
}
