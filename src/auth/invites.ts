import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getFirebaseFirestore, isFirebaseConfigured, parseAllowedEmails } from './firebase'

export type InviteConfig = {
  emails: string[]
  admins: string[]
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export function envAllowlist() {
  return parseAllowedEmails()
}

export function envAdmins() {
  const raw = import.meta.env.VITE_ADMIN_EMAILS as string | undefined
  if (raw?.trim()) {
    return new Set(raw.split(',').map(normalizeEmail).filter(Boolean))
  }
  const allow = envAllowlist()
  if (!allow?.size) return new Set<string>()
  return new Set([[...allow][0]])
}

let cachedInvites: InviteConfig | null = null
let cachedAt = 0

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 시간 초과`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function envFallback(): InviteConfig {
  const envEmails = [...(envAllowlist() ?? [])]
  return {
    emails: envEmails,
    admins: [...envAdmins()],
  }
}

export async function fetchInviteConfig(force = false): Promise<InviteConfig> {
  const now = Date.now()
  if (!force && cachedInvites && now - cachedAt < 30_000) return cachedInvites

  const fallback = envFallback()

  if (!isFirebaseConfigured()) {
    cachedInvites = fallback
    cachedAt = now
    return fallback
  }

  try {
    const snap = await withTimeout(
      getDoc(doc(getFirebaseFirestore(), 'appConfig', 'invites')),
      4_000,
      '초대 목록',
    )
    if (!snap.exists()) {
      cachedInvites = fallback
      cachedAt = now
      return fallback
    }
    const data = snap.data() as Partial<InviteConfig>
    const emails = [...new Set([
      ...fallback.emails,
      ...(data.emails ?? []).map(normalizeEmail).filter(Boolean),
    ])]
    const admins = [...new Set([
      ...fallback.admins,
      ...(data.admins ?? []).map(normalizeEmail).filter(Boolean),
    ])]
    cachedInvites = { emails, admins }
    cachedAt = now
    return cachedInvites
  } catch (error) {
    console.warn('초대 목록을 불러오지 못했습니다. 환경 변수 목록을 사용합니다.', error)
    cachedInvites = fallback
    cachedAt = now
    return fallback
  }
}

export async function isEmailAllowedAsync(email: string | null | undefined) {
  if (!email) return false
  const normalized = normalizeEmail(email)
  const env = envAllowlist()
  // 환경 변수 허용 목록에 있으면 Firestore를 기다리지 않는다.
  if (env?.has(normalized)) return true

  const config = await fetchInviteConfig()
  if (!config.emails.length) return true
  return config.emails.includes(normalized)
}

export async function isAdminEmailAsync(email: string | null | undefined) {
  if (!email) return false
  const normalized = normalizeEmail(email)
  if (envAdmins().has(normalized)) return true
  const config = await fetchInviteConfig()
  return config.admins.includes(normalized)
}

export async function saveInviteEmails(emails: string[], actorEmail: string) {
  if (!(await isAdminEmailAsync(actorEmail))) {
    throw new Error('초대 목록을 수정할 권한이 없습니다.')
  }
  if (!isFirebaseConfigured()) throw new Error('Firebase가 설정되지 않았습니다.')
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))]
  const admins = [...new Set([...envAdmins(), normalizeEmail(actorEmail)])]
  await withTimeout(
    setDoc(
      doc(getFirebaseFirestore(), 'appConfig', 'invites'),
      { emails: normalized, admins },
      { merge: true },
    ),
    8_000,
    '초대 목록 저장',
  )
  cachedInvites = { emails: normalized, admins }
  cachedAt = Date.now()
  return cachedInvites
}
