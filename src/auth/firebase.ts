import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
}

export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey
    && firebaseConfig.authDomain
    && firebaseConfig.projectId
    && firebaseConfig.appId,
  )
}

let app: FirebaseApp | undefined
let auth: Auth | undefined
let firestore: Firestore | undefined

function getFirebaseApp() {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase 환경 변수가 설정되지 않았습니다.')
  }
  if (!app) {
    app = initializeApp({
      apiKey: firebaseConfig.apiKey!,
      authDomain: firebaseConfig.authDomain!,
      projectId: firebaseConfig.projectId!,
      appId: firebaseConfig.appId!,
      messagingSenderId: firebaseConfig.messagingSenderId,
      storageBucket: firebaseConfig.storageBucket,
    })
  }
  return app
}

export function getFirebaseAuth() {
  if (!auth) auth = getAuth(getFirebaseApp())
  return auth
}

export function getFirebaseFirestore() {
  if (!firestore) firestore = getFirestore(getFirebaseApp())
  return firestore
}

export function parseAllowedEmails(raw = import.meta.env.VITE_ALLOWED_EMAILS as string | undefined) {
  if (!raw?.trim()) return null
  const emails = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  return emails.length ? new Set(emails) : null
}

export function isEmailAllowed(email: string | null | undefined) {
  const allowlist = parseAllowedEmails()
  if (!allowlist) return true
  if (!email) return false
  return allowlist.has(email.trim().toLowerCase())
}
