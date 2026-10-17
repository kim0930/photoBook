import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getFirebaseAuth, isEmailAllowed, isFirebaseConfigured } from './firebase'

type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'denied' | 'misconfigured'

interface AuthContextValue {
  status: AuthStatus
  user: User | null
  error: string
  signInWithGoogle: () => Promise<void>
  signOutUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(() => (
    isFirebaseConfigured() ? 'loading' : 'misconfigured'
  ))
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setStatus('misconfigured')
      return
    }
    const auth = getFirebaseAuth()
    return onAuthStateChanged(auth, async (next) => {
      setError('')
      if (!next) {
        setUser(null)
        setStatus('signedOut')
        return
      }
      if (!isEmailAllowed(next.email)) {
        setUser(null)
        setStatus('denied')
        setError(`${next.email ?? '이 계정'}은 초대되지 않은 사용자입니다.`)
        try { await signOut(auth) } catch { /* ignore */ }
        return
      }
      setUser(next)
      setStatus('signedIn')
    })
  }, [])

  const signInWithGoogle = useCallback(async () => {
    if (!isFirebaseConfigured()) {
      setStatus('misconfigured')
      setError('Firebase 설정이 없습니다. 환경 변수를 확인해 주세요.')
      return
    }
    setError('')
    try {
      const auth = getFirebaseAuth()
      const result = await signInWithPopup(auth, new GoogleAuthProvider())
      if (!isEmailAllowed(result.user.email)) {
        setStatus('denied')
        setError(`${result.user.email ?? '이 계정'}은 초대되지 않은 사용자입니다.`)
        await signOut(auth)
        setUser(null)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '로그인에 실패했습니다.'
      setError(message.includes('popup-closed') ? '로그인이 취소되었습니다.' : 'Google 로그인에 실패했습니다.')
      setStatus('signedOut')
    }
  }, [])

  const signOutUser = useCallback(async () => {
    setError('')
    if (!isFirebaseConfigured()) {
      setUser(null)
      setStatus('misconfigured')
      return
    }
    await signOut(getFirebaseAuth())
    setUser(null)
    setStatus('signedOut')
  }, [])

  const value = useMemo(() => ({
    status,
    user,
    error,
    signInWithGoogle,
    signOutUser,
  }), [status, user, error, signInWithGoogle, signOutUser])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth는 AuthProvider 안에서만 사용할 수 있습니다.')
  return value
}
