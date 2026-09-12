import assert from "node:assert/strict"
import test from "node:test"

import {
  createRecoveryLinkController,
} from "./recovery-flow-controller.ts"
import type { RecoveryAuthClient, RecoveryLinkParams } from "./recovery-link.ts"

const EMPTY_PARAMS: RecoveryLinkParams = {
  code: null,
  tokenHash: null,
  type: null,
  recovery: null,
  accessToken: null,
  refreshToken: null,
  hashType: null,
  hashError: null,
  queryError: null,
}

interface FakeAuthOptions {
  verifyOtpError?: { message: string; code?: string } | null
  exchangeCodeError?: { message: string; code?: string } | null
  setSessionError?: { message: string; code?: string } | null
  sessionAfterSuccess?: { access_token: string } | null
}

function createFakeAuth(options: FakeAuthOptions = {}) {
  const calls = {
    verifyOtp: 0,
    exchangeCodeForSession: 0,
    setSession: 0,
    getSession: 0,
  }

  const auth: RecoveryAuthClient = {
    exchangeCodeForSession: async (code) => {
      calls.exchangeCodeForSession += 1
      void code
      return { error: options.exchangeCodeError ?? null }
    },
    verifyOtp: async (args) => {
      calls.verifyOtp += 1
      void args
      return { error: options.verifyOtpError ?? null }
    },
    setSession: async (args) => {
      calls.setSession += 1
      void args
      return { error: options.setSessionError ?? null }
    },
    getSession: async () => {
      calls.getSession += 1
      return {
        data: {
          session:
            options.sessionAfterSuccess === undefined
              ? { access_token: "session-access-token" }
              : options.sessionAfterSuccess,
        },
      }
    },
  }

  return { auth, calls }
}

// --- 1. cargar con token_hash válido: verifyOtp NO se llama automáticamente ---

test("token_hash + type=recovery: needsConfirmation=true y verifyOtp NO se llama hasta invocar confirm()", () => {
  const { auth, calls } = createFakeAuth()

  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "abc123", type: "recovery" },
    false,
  )

  assert.equal(controller.needsConfirmation, true)
  assert.equal(calls.verifyOtp, 0)
  assert.equal(calls.exchangeCodeForSession, 0)
  assert.equal(calls.setSession, 0)
})

// --- 2. click una vez: verifyOtp llamado exactamente una vez ---

test("confirm() llamado una vez ejecuta verifyOtp exactamente una vez", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "abc123", type: "recovery" },
    false,
  )

  const result = await controller.confirm()

  assert.equal(calls.verifyOtp, 1)
  assert.deepEqual(result, { status: "valid", accessToken: "session-access-token" })
})

// --- 3. doble click: verifyOtp sigue llamado una sola vez ---

test("confirm() llamado dos veces seguidas (doble click) antes de resolver: verifyOtp se llama UNA sola vez y ambas llamadas devuelven el mismo resultado", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "abc123", type: "recovery" },
    false,
  )

  const [first, second] = await Promise.all([
    controller.confirm(),
    controller.confirm(),
  ])

  assert.equal(calls.verifyOtp, 1)
  assert.deepEqual(first, second)
})

test("confirm() llamado repetidas veces DESPUÉS de ya haber resuelto: sigue sin volver a llamar a verifyOtp", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "abc123", type: "recovery" },
    false,
  )

  await controller.confirm()
  await controller.confirm()
  await controller.confirm()

  assert.equal(calls.verifyOtp, 1)
})

// --- 4. token válido: resultado "valid" (dispara el formulario en la página) ---

test("token_hash válido resuelve status 'valid' con accessToken -- la página muestra el formulario a partir de este resultado", async () => {
  const { auth } = createFakeAuth()
  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "valido", type: "recovery" },
    false,
  )

  const result = await controller.confirm()

  assert.equal(result.status, "valid")
})

// --- 5. token inválido: resultado "invalid" (dispara el mensaje de error en la página) ---

test("token_hash vencido/ya usado resuelve status 'invalid' -- la página muestra el error, nunca el formulario", async () => {
  const { auth } = createFakeAuth({
    verifyOtpError: { message: "Token has expired or is invalid", code: "otp_expired" },
  })
  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "vencido", type: "recovery" },
    false,
  )

  const result = await controller.confirm()

  assert.deepEqual(result, { status: "invalid" })
})

// --- 6. visita directa sin parámetros: error sin llamar a verifyOtp ---

test("sin ningún parámetro de recovery ni sesión previa: needsConfirmation=false (no hay botón) y confirm() resuelve 'invalid' sin llamar a verifyOtp/exchangeCode/setSession", async () => {
  const { auth, calls } = createFakeAuth({ sessionAfterSuccess: null })
  const controller = createRecoveryLinkController(auth, EMPTY_PARAMS, false)

  assert.equal(controller.needsConfirmation, false)

  const result = await controller.confirm()

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.verifyOtp, 0)
  assert.equal(calls.exchangeCodeForSession, 0)
  assert.equal(calls.setSession, 0)
})

// --- 7. code (PKCE): no se consume hasta confirm() ---

test("?code=: needsConfirmation=true y exchangeCodeForSession NO se llama hasta invocar confirm()", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, code: "pkce-xyz" },
    false,
  )

  assert.equal(controller.needsConfirmation, true)
  assert.equal(calls.exchangeCodeForSession, 0)

  await controller.confirm()

  assert.equal(calls.exchangeCodeForSession, 1)
})

// --- 8. hash legado: no se consume hasta confirm() ---

test("#access_token+refresh_token (legado): needsConfirmation=true y setSession NO se llama hasta invocar confirm()", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, accessToken: "at-legacy", refreshToken: "rt-legacy" },
    false,
  )

  assert.equal(controller.needsConfirmation, true)
  assert.equal(calls.setSession, 0)

  await controller.confirm()

  assert.equal(calls.setSession, 1)
})

// --- Casos adicionales de robustez ---

test("un error explícito de Supabase (hashError/queryError) nunca requiere confirmación: se resuelve directo a 'invalid'", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createRecoveryLinkController(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "algo", type: "recovery", queryError: "El enlace ya fue utilizado." },
    false,
  )

  assert.equal(controller.needsConfirmation, false)

  const result = await controller.confirm()

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.verifyOtp, 0)
})

test("sesión ya establecida + marca de recuperación (recarga tras ya haber confirmado): no requiere un nuevo click, resuelve 'valid' sin llamar a verifyOtp/exchangeCode/setSession", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createRecoveryLinkController(auth, EMPTY_PARAMS, true)

  assert.equal(controller.needsConfirmation, false)

  const result = await controller.confirm()

  assert.equal(result.status, "valid")
  assert.equal(calls.verifyOtp, 0)
  assert.equal(calls.exchangeCodeForSession, 0)
  assert.equal(calls.setSession, 0)
})
