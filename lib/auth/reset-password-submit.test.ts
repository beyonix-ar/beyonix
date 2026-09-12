import assert from "node:assert/strict"
import test from "node:test"

import { createPasswordUpdateSubmitter } from "./reset-password-submit.ts"
import type { PasswordUpdateAuthClient } from "./reset-password-submit.ts"

interface FakeAuthOptions {
  updateUserError?: { message: string } | null
  signOutError?: { message: string } | null
}

function createFakeAuth(options: FakeAuthOptions = {}) {
  const calls = {
    updateUser: [] as Array<{ password: string }>,
    signOut: 0,
  }

  const auth: PasswordUpdateAuthClient = {
    updateUser: async (attrs) => {
      calls.updateUser.push(attrs)
      return { error: options.updateUserError ?? null }
    },
    signOut: async () => {
      calls.signOut += 1
      return { error: options.signOutError ?? null }
    },
  }

  return { auth, calls }
}

// --- 3. submit válido: updateUser una sola vez ---

test("submit válido llama a updateUser({password}) exactamente una vez con la contraseña dada", async () => {
  const { auth, calls } = createFakeAuth()
  const submitter = createPasswordUpdateSubmitter(auth)

  const result = await submitter.submit("Segura123!")

  assert.deepEqual(result, { status: "success" })
  assert.deepEqual(calls.updateUser, [{ password: "Segura123!" }])
})

// --- 4. doble submit: updateUser una sola vez ---

test("dos submit() concurrentes (doble click) antes de resolver: updateUser se llama UNA sola vez, ambas llamadas devuelven el mismo resultado", async () => {
  const { auth, calls } = createFakeAuth()
  const submitter = createPasswordUpdateSubmitter(auth)

  const [first, second] = await Promise.all([
    submitter.submit("Segura123!"),
    submitter.submit("Segura123!"),
  ])

  assert.equal(calls.updateUser.length, 1)
  assert.deepEqual(first, second)
})

test("un submit() legítimo DESPUÉS de que el anterior ya resolvió (reintento tras corregir algo) sí puede volver a llamar a updateUser", async () => {
  const { auth, calls } = createFakeAuth()
  const submitter = createPasswordUpdateSubmitter(auth)

  await submitter.submit("Segura123!")
  await submitter.submit("Segura123!")

  assert.equal(calls.updateUser.length, 2)
})

// --- 5. updateUser success: signOut + success ---

test("updateUser exitoso: cierra la sesión (signOut) y resuelve 'success'", async () => {
  const { auth, calls } = createFakeAuth()
  const submitter = createPasswordUpdateSubmitter(auth)

  const result = await submitter.submit("Segura123!")

  assert.deepEqual(result, { status: "success" })
  assert.equal(calls.signOut, 1)
})

// --- 6. updateUser error: NO signOut, mensaje de error ---

test("updateUser con error: NO cierra la sesión y devuelve un mensaje seguro, nunca el error crudo de Supabase", async () => {
  const { auth, calls } = createFakeAuth({
    updateUserError: { message: "AuthApiError: some internal detail" },
  })
  const submitter = createPasswordUpdateSubmitter(auth)

  const result = await submitter.submit("Segura123!")

  assert.equal(result.status, "error")
  assert.equal(calls.signOut, 0)
  if (result.status === "error") {
    assert.doesNotMatch(result.message, /AuthApiError|internal detail/)
  }
})

test("mismo password que el anterior: mensaje específico sin exponer detalle interno de Supabase", async () => {
  const { auth } = createFakeAuth({
    updateUserError: { message: "New password should be different from the old password." },
  })
  const submitter = createPasswordUpdateSubmitter(auth)

  const result = await submitter.submit("Segura123!")

  assert.equal(result.status, "error")
  if (result.status === "error") {
    assert.equal(
      result.message,
      "La nueva contraseña no puede coincidir con la contraseña anterior.",
    )
  }
})

// --- 12. la contraseña nunca aparece en el resultado devuelto ---

test("la contraseña nunca aparece en el resultado devuelto, ni en éxito ni en error", async () => {
  const { auth: authOk } = createFakeAuth()
  const okResult = await createPasswordUpdateSubmitter(authOk).submit("MiSecreta123!")
  assert.doesNotMatch(JSON.stringify(okResult), /MiSecreta123!/)

  const { auth: authErr } = createFakeAuth({ updateUserError: { message: "boom" } })
  const errResult = await createPasswordUpdateSubmitter(authErr).submit("OtraSecreta456!")
  assert.doesNotMatch(JSON.stringify(errResult), /OtraSecreta456!/)
})

test("un error al hacer signOut tras un updateUser exitoso no revierte el resultado a error (la contraseña ya cambió)", async () => {
  const { auth } = createFakeAuth({ signOutError: { message: "network blip" } })
  const submitter = createPasswordUpdateSubmitter(auth)

  const result = await submitter.submit("Segura123!")

  assert.deepEqual(result, { status: "success" })
})

test("una excepción inesperada (ej. red caída) nunca se propaga sin capturar: resuelve 'error' con mensaje genérico, y libera el gate para reintentar", async () => {
  const auth: PasswordUpdateAuthClient = {
    updateUser: async () => {
      throw new Error("network down")
    },
    signOut: async () => ({ error: null }),
  }
  const submitter = createPasswordUpdateSubmitter(auth)

  const result = await submitter.submit("Segura123!")

  assert.equal(result.status, "error")
  if (result.status === "error") {
    assert.doesNotMatch(result.message, /network down/)
  }

  // El gate se liberó: un reintento después de la excepción vuelve a intentar.
  const secondResult = await submitter.submit("Segura123!")
  assert.equal(secondResult.status, "error")
})
