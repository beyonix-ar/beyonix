import assert from "node:assert/strict"
import test from "node:test"

import { LOGIN_GENERIC_INVALID_CREDENTIALS, signInWithIdentifier } from "./login.ts"

interface FakeAdminOptions {
  /** username (ya normalizado a minúsculas) -> email real, o null si no existe. */
  usernameEmails?: Record<string, string | null>
  /** email -> resultado de signInWithPassword. */
  passwords?: Record<
    string,
    | { ok: true; accessToken?: string; refreshToken?: string }
    | { ok: false; message: string; code?: string }
  >
  blockedEmails?: string[]
  blockedUsernames?: string[]
}

function createFakeAdmin(options: FakeAdminOptions = {}) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: unknown }>,
    signInWithPassword: [] as Array<{ email: string; password: string }>,
  }

  const admin = {
    rpc: async (fn: string, args: unknown) => {
      calls.rpc.push({ fn, args })

      if (fn === "get_profile_email_by_username") {
        const username = (args as { username_input: string }).username_input
        return { data: options.usernameEmails?.[username] ?? null, error: null }
      }

      if (fn === "is_client_registration_blocked") {
        const { email_input, username_input } = args as {
          email_input: string | null
          username_input: string | null
        }
        const blocked =
          (email_input && options.blockedEmails?.includes(email_input)) ||
          (username_input && options.blockedUsernames?.includes(username_input))
        return { data: Boolean(blocked), error: null }
      }

      return { data: null, error: { message: `unexpected rpc ${fn}` } }
    },
    auth: {
      signInWithPassword: async ({
        email,
        password,
      }: {
        email: string
        password: string
      }) => {
        calls.signInWithPassword.push({ email, password })
        const outcome = options.passwords?.[email]

        if (!outcome || !outcome.ok) {
          return {
            data: { session: null },
            error: outcome
              ? { message: outcome.message, code: outcome.code }
              : { message: "Invalid login credentials" },
          }
        }

        return {
          data: {
            session: {
              access_token: outcome.accessToken ?? "access-token",
              refresh_token: outcome.refreshToken ?? "refresh-token",
            },
          },
          error: null,
        }
      },
    },
  }

  return {
    admin: admin as unknown as Parameters<typeof signInWithIdentifier>[0]["admin"],
    calls,
  }
}

test("login por email: resuelve directo sin llamar al RPC de username", async () => {
  const { admin, calls } = createFakeAdmin({
    passwords: { "cliente@example.com": { ok: true } },
  })

  const result = await signInWithIdentifier({
    admin,
    identifierRaw: "Cliente@Example.com",
    passwordRaw: "Segura123!",
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.session, {
    access_token: "access-token",
    refresh_token: "refresh-token",
  })
  assert.equal(calls.signInWithPassword[0].email, "cliente@example.com")
  assert.equal(
    calls.rpc.some((c) => c.fn === "get_profile_email_by_username"),
    false,
  )
})

test("login por username: resuelve server-side vía RPC y autentica con el email real", async () => {
  const { admin, calls } = createFakeAdmin({
    usernameEmails: { antares: "antares-real@example.com" },
    passwords: { "antares-real@example.com": { ok: true } },
  })

  const result = await signInWithIdentifier({
    admin,
    identifierRaw: "ANTARES",
    passwordRaw: "Segura123!",
  })

  assert.equal(result.ok, true)
  assert.equal(calls.signInWithPassword[0].email, "antares-real@example.com")
})

test("username inexistente: mismo mensaje genérico que una contraseña incorrecta, sin llamar a signInWithPassword", async () => {
  const { admin, calls } = createFakeAdmin({ usernameEmails: {} })

  const result = await signInWithIdentifier({
    admin,
    identifierRaw: "usuario-fantasma",
    passwordRaw: "cualquier-cosa",
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, LOGIN_GENERIC_INVALID_CREDENTIALS)
  assert.equal(calls.signInWithPassword.length, 0)
})

test("contraseña incorrecta para un email existente: mismo mensaje genérico que username inexistente", async () => {
  const { admin: adminMissing } = createFakeAdmin({ usernameEmails: {} })
  const missing = await signInWithIdentifier({
    admin: adminMissing,
    identifierRaw: "usuario-fantasma",
    passwordRaw: "loquesea",
  })

  const { admin: adminWrongPass } = createFakeAdmin({
    passwords: {
      "real@example.com": { ok: false, message: "Invalid login credentials" },
    },
  })
  const wrongPassword = await signInWithIdentifier({
    admin: adminWrongPass,
    identifierRaw: "real@example.com",
    passwordRaw: "incorrecta",
  })

  assert.deepEqual(missing, wrongPassword)
})

test("cuenta bloqueada por email: no llega a intentar signInWithPassword", async () => {
  const { admin, calls } = createFakeAdmin({
    blockedEmails: ["bloqueado@example.com"],
    passwords: { "bloqueado@example.com": { ok: true } },
  })

  const result = await signInWithIdentifier({
    admin,
    identifierRaw: "bloqueado@example.com",
    passwordRaw: "Segura123!",
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, "Esta cuenta no puede acceder a la tienda.")
  assert.equal(calls.signInWithPassword.length, 0)
})

test("cuenta bloqueada por username crudo (no por el email resuelto): sigue bloqueando", async () => {
  const { admin, calls } = createFakeAdmin({
    usernameEmails: { vetado: "vetado-real@example.com" },
    blockedUsernames: ["vetado"],
    passwords: { "vetado-real@example.com": { ok: true } },
  })

  const result = await signInWithIdentifier({
    admin,
    identifierRaw: "vetado",
    passwordRaw: "Segura123!",
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, "Esta cuenta no puede acceder a la tienda.")
  assert.equal(calls.signInWithPassword.length, 0)
})

test("email sin confirmar: mensaje específico (no es enumeración -- sólo se llega acá con contraseña correcta)", async () => {
  const { admin } = createFakeAdmin({
    passwords: {
      "pendiente@example.com": {
        ok: false,
        message: "Email not confirmed",
        code: "email_not_confirmed",
      },
    },
  })

  const result = await signInWithIdentifier({
    admin,
    identifierRaw: "pendiente@example.com",
    passwordRaw: "Segura123!",
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, "Tenés que confirmar tu correo antes de iniciar sesión.")
})

test("identificador o contraseña vacíos: error genérico de formato, no distingue causa", async () => {
  const { admin, calls } = createFakeAdmin()

  const result = await signInWithIdentifier({
    admin,
    identifierRaw: "",
    passwordRaw: "",
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, LOGIN_GENERIC_INVALID_CREDENTIALS)
  assert.equal(calls.signInWithPassword.length, 0)
})

test("el email resuelto de un username nunca aparece en el resultado devuelto", async () => {
  const { admin } = createFakeAdmin({
    usernameEmails: { antares: "antares-secreto@example.com" },
    passwords: { "antares-secreto@example.com": { ok: true } },
  })

  const result = await signInWithIdentifier({
    admin,
    identifierRaw: "antares",
    passwordRaw: "Segura123!",
  })

  assert.doesNotMatch(JSON.stringify(result), /antares-secreto/)
})
