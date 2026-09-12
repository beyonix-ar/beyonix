import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import { normalizeForgotPasswordIdentifier } from "./forgot-password-identifier.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export const LOGIN_GENERIC_INVALID_CREDENTIALS =
  "Usuario/email o contraseña incorrectos."

// Mismo piso que lib/auth/forgot-password.ts y por la misma razón: sin esto,
// el tiempo de respuesta real (resolver username -> email + intentar
// signInWithPassword) sería medible y distinguiría "username inexistente"
// de "username existe, contraseña incorrecta".
const MIN_RESPONSE_MS = 500

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolveUsernameEmail(admin: AdminClient, username: string) {
  const { data, error } = await admin.rpc("get_profile_email_by_username", {
    username_input: username,
  })

  if (error || typeof data !== "string" || !data.trim()) return null

  return data.trim().toLowerCase()
}

export interface SignInWithIdentifierInput {
  admin: AdminClient
  identifierRaw: unknown
  passwordRaw: unknown
}

export type SignInResult =
  | {
      ok: true
      session: { access_token: string; refresh_token: string }
    }
  | { ok: false; status: number; error: string }

/**
 * Resuelve "email o username" y autentica, todo server-side.
 *
 * Reemplaza la resolución que antes hacía el navegador llamando
 * directamente a `supabase.rpc("get_profile_email_by_username", ...)` con la
 * anon key: esa función estaba otorgada a anon/authenticated (ver migración
 * 20260912120000), así que cualquiera podía resolver el email real de
 * cualquier username sin autenticarse ni intentar loguearse -- un oráculo de
 * enumeración/PII completo. Ahora sólo `admin` (service_role) puede
 * ejecutarla.
 *
 * Devuelve siempre el mismo mensaje genérico ante username inexistente,
 * email inexistente o contraseña incorrecta -- nunca distingue cuál de los
 * tres pasó.
 */
export async function signInWithIdentifier({
  admin,
  identifierRaw,
  passwordRaw,
}: SignInWithIdentifierInput): Promise<SignInResult> {
  const startedAt = Date.now()
  const respond = async (result: SignInResult) => {
    const elapsed = Date.now() - startedAt
    if (elapsed < MIN_RESPONSE_MS) await sleep(MIN_RESPONSE_MS - elapsed)
    return result
  }

  const identifier = normalizeForgotPasswordIdentifier(identifierRaw)
  const password = typeof passwordRaw === "string" ? passwordRaw : ""

  if (!identifier || !password) {
    return respond({
      ok: false,
      status: 400,
      error: LOGIN_GENERIC_INVALID_CREDENTIALS,
    })
  }

  const email =
    identifier.kind === "email"
      ? identifier.value
      : await resolveUsernameEmail(admin, identifier.value)

  if (!email) {
    return respond({
      ok: false,
      status: 401,
      error: LOGIN_GENERIC_INVALID_CREDENTIALS,
    })
  }

  // Mismo chequeo que antes hacía el navegador (is_client_registration_blocked
  // sí tiene grant público, se mantiene así porque también la usa
  // register() -- fuera del alcance de esta tarea). Se pasa username_input
  // además de email_input para no perder cobertura: un bloqueo puede estar
  // cargado contra el username crudo, no sólo contra el email resuelto (ver
  // supabase/sql/009_client_blocks_and_notes.sql, chequeo OR entre los tres
  // identificadores).
  const { data: isBlocked } = await admin.rpc(
    "is_client_registration_blocked",
    {
      email_input: email,
      username_input: identifier.kind === "username" ? identifier.value : null,
      phone_input: null,
    },
  )

  if (isBlocked) {
    return respond({
      ok: false,
      status: 403,
      error: "Esta cuenta no puede acceder a la tienda.",
    })
  }

  const { data, error } = await admin.auth.signInWithPassword({
    email,
    password,
  })

  if (error || !data.session) {
    if (
      error?.code === "email_not_confirmed" ||
      error?.message?.toLowerCase().includes("email not confirmed")
    ) {
      return respond({
        ok: false,
        status: 403,
        error: "Tenés que confirmar tu correo antes de iniciar sesión.",
      })
    }

    return respond({
      ok: false,
      status: 401,
      error: LOGIN_GENERIC_INVALID_CREDENTIALS,
    })
  }

  return respond({
    ok: true,
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
  })
}
