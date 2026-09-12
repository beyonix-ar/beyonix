import assert from "node:assert/strict"
import test from "node:test"

import { confirmPasswordReset } from "./reset-password-confirm.ts"

function fakeJwt(payload: unknown) {
  const base64url = (value: string) =>
    Buffer.from(value)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

  return `${base64url(JSON.stringify({ alg: "HS256" }))}.${base64url(
    JSON.stringify(payload),
  )}.firma-no-verificada`
}

const RECOVERY_TOKEN = fakeJwt({ sub: "user-1", amr: [{ method: "recovery" }] })
const NORMAL_SESSION_TOKEN = fakeJwt({ sub: "user-1", amr: [{ method: "password" }] })
const VALID_PASSWORD = "Segura123!"

interface FakeAdminOptions {
  getUserResult?: { user: { id: string } | null; error: { message: string } | null }
  updateUserByIdError?: { message: string } | null
  signOutError?: Error | null
}

function createFakeAdmin(options: FakeAdminOptions = {}) {
  const calls = {
    getUser: [] as string[],
    updateUserById: [] as Array<{ id: string; password: string }>,
    signOutOthers: [] as string[],
  }

  const admin = {
    auth: {
      getUser: async (token: string) => {
        calls.getUser.push(token)
        return {
          data: {
            user: options.getUserResult?.user ?? { id: "user-1" },
          },
          error: options.getUserResult?.error ?? null,
        }
      },
      admin: {
        updateUserById: async (id: string, attrs: { password?: string }) => {
          calls.updateUserById.push({ id, password: attrs.password ?? "" })
          return { error: options.updateUserByIdError ?? null }
        },
        signOut: async (token: string, scope: string) => {
          if (scope === "others") calls.signOutOthers.push(token)
          if (options.signOutError) throw options.signOutError
          return { error: null }
        },
      },
    },
  }

  return {
    admin: admin as unknown as Parameters<typeof confirmPasswordReset>[0]["admin"],
    calls,
  }
}

// --- 7. nueva contraseña establecida correctamente ---

test("token de recuperación válido + contraseña que cumple la política: actualiza la contraseña y cierra las otras sesiones", async () => {
  const { admin, calls } = createFakeAdmin()

  const result = await confirmPasswordReset({
    admin,
    accessToken: RECOVERY_TOKEN,
    passwordRaw: VALID_PASSWORD,
  })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls.updateUserById, [{ id: "user-1", password: VALID_PASSWORD }])
  assert.deepEqual(calls.signOutOthers, [RECOVERY_TOKEN])
})

test("sin access_token (header Authorization ausente): mensaje unificado de enlace inválido, nunca llega a tocar la contraseña", async () => {
  const { admin, calls } = createFakeAdmin()

  const result = await confirmPasswordReset({
    admin,
    accessToken: "",
    passwordRaw: VALID_PASSWORD,
  })

  assert.equal(result.ok, false)
  assert.equal(calls.updateUserById.length, 0)
})

test("un access_token de una sesión NORMAL (no de recuperación) se rechaza aunque sea válido y esté logueado", async () => {
  const { admin, calls } = createFakeAdmin()

  const result = await confirmPasswordReset({
    admin,
    accessToken: NORMAL_SESSION_TOKEN,
    passwordRaw: VALID_PASSWORD,
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 403)
  assert.equal(calls.getUser.length, 0, "ni siquiera debe llamar a admin.auth.getUser")
  assert.equal(calls.updateUserById.length, 0)
})

test("admin.auth.getUser no encuentra al usuario (token revocado/inválido pese a tener amr=recovery): enlace inválido, no actualiza nada", async () => {
  const { admin, calls } = createFakeAdmin({
    getUserResult: { user: null, error: { message: "invalid token" } },
  })

  const result = await confirmPasswordReset({
    admin,
    accessToken: RECOVERY_TOKEN,
    passwordRaw: VALID_PASSWORD,
  })

  assert.equal(result.ok, false)
  assert.equal(calls.updateUserById.length, 0)
})

test("contraseña que no cumple la política server-side: se rechaza con el mensaje de validación, nunca llega a updateUserById", async () => {
  const { admin, calls } = createFakeAdmin()

  const result = await confirmPasswordReset({
    admin,
    accessToken: RECOVERY_TOKEN,
    passwordRaw: "corta1",
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 400)
  assert.equal(calls.updateUserById.length, 0)
})

test("un error real de Supabase al actualizar la contraseña se traduce a un mensaje legible, no se propaga crudo", async () => {
  const { admin } = createFakeAdmin({
    updateUserByIdError: { message: "Password should be at least 6 characters" },
  })

  const result = await confirmPasswordReset({
    admin,
    accessToken: RECOVERY_TOKEN,
    passwordRaw: VALID_PASSWORD,
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.status, 400)
    assert.equal(typeof result.error, "string")
    assert.ok(result.error.length > 0)
  }
})

test("si falla el signOut de otras sesiones, la contraseña YA cambiada sigue contando como éxito (best-effort, no crítico)", async () => {
  const { admin, calls } = createFakeAdmin({
    signOutError: new Error("network blip"),
  })

  const result = await confirmPasswordReset({
    admin,
    accessToken: RECOVERY_TOKEN,
    passwordRaw: VALID_PASSWORD,
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(calls.updateUserById.length, 1)
})

test("la contraseña nunca aparece en el resultado devuelto", async () => {
  const { admin } = createFakeAdmin()

  const result = await confirmPasswordReset({
    admin,
    accessToken: RECOVERY_TOKEN,
    passwordRaw: VALID_PASSWORD,
  })

  assert.doesNotMatch(JSON.stringify(result), new RegExp(VALID_PASSWORD))
})
