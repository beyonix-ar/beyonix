import { createBrowserClient } from '@supabase/ssr'
import type { Session } from '@supabase/supabase-js'

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
)

const unsafeGetSession = supabase.auth.getSession.bind(supabase.auth)

supabase.auth.getSession = (async () => {
  try {
    const result = await unsafeGetSession()

    if (result.error && isInvalidRefreshTokenError(result.error)) {
      clearSupabaseBrowserSession()
    }

    return result
  } catch (error) {
    if (isInvalidRefreshTokenError(error)) {
      clearSupabaseBrowserSession()

      return {
        data: {
          session: null,
        },
        error,
      }
    }

    throw error
  }
}) as typeof supabase.auth.getSession

export function createClient() {
  return supabase
}

function getSupabaseBrowserAuthStoragePrefix() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  if (!supabaseUrl) return null

  try {
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0]

    return `sb-${projectRef}-auth-token`
  } catch {
    return null
  }
}

export function isInvalidRefreshTokenError(error: unknown) {
  if (!error || typeof error !== "object") return false

  const authError = error as {
    code?: string
    message?: string
  }
  const message = authError.message?.toLowerCase() ?? ""

  return (
    authError.code === "refresh_token_not_found" ||
    authError.code === "refresh_token_already_used" ||
    message.includes("invalid refresh token") ||
    message.includes("refresh token not found")
  )
}

export function clearSupabaseBrowserSession() {
  if (typeof window === "undefined") return

  const storagePrefix = getSupabaseBrowserAuthStoragePrefix()

  if (!storagePrefix) return

  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith(storagePrefix)) {
        storage.removeItem(key)
      }
    }
  }

  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim()

    if (name?.startsWith(storagePrefix)) {
      document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`
    }
  }
}

export async function getSafeSupabaseSession(): Promise<Session | null> {
  try {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession()

    if (error) {
      if (isInvalidRefreshTokenError(error)) {
        clearSupabaseBrowserSession()
      }

      return null
    }

    return session
  } catch (error) {
    if (isInvalidRefreshTokenError(error)) {
      clearSupabaseBrowserSession()
      return null
    }

    throw error
  }
}
