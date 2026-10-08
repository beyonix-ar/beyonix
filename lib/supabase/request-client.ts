import { createClient } from "@supabase/supabase-js"

/**
 * Cliente Supabase con la sesión del usuario que hizo el request (Bearer):
 * RLS y auth.uid() son los del usuario real, igual que si llamara desde el
 * navegador. Se usa cuando una RPC existente valida el rol con auth.uid() y
 * la ruta server-side necesita intermediar (p. ej. para sanear la entrada).
 * Llamar sólo después de requireInternalUser, que ya verificó el token.
 */
export function createRequestUserClient(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")

  if (!url || !anonKey || !token) {
    throw new Error("Supabase no configurado")
  }

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
