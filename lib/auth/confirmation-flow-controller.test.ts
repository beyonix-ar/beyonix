import assert from "node:assert/strict"
import test from "node:test"

import { createConfirmationLinkController } from "./confirmation-flow-controller.ts"
import type {
  ConfirmationAuthClient,
  ConfirmationLinkParams,
} from "./confirmation-link.ts"

const EMPTY_PARAMS: ConfirmationLinkParams = {
  code: null,
  tokenHash: null,
  type: null,
}

interface FakeAuthOptions {
  verifyOtpError?: { message: string; code?: string } | null
  exchangeCodeError?: { message: string; code?: string } | null
  sessionAfterSuccess?: { access_token: string } | null
  userAfterSuccess?: { id: string } | null
}

function createFakeAuth(options: FakeAuthOptions = {}) {
  const calls = {
    verifyOtp: 0,
    exchangeCodeForSession: 0,
  }

  const session =
    options.sessionAfterSuccess === undefined
      ? { access_token: "confirmation-access-token" }
      : options.sessionAfterSuccess
  const user =
    options.userAfterSuccess === undefined ? { id: "user-123" } : options.userAfterSuccess

  const auth: ConfirmationAuthClient = {
    verifyOtp: async (args) => {
      calls.verifyOtp += 1
      void args
      return { data: { session, user }, error: options.verifyOtpError ?? null }
    },
    exchangeCodeForSession: async (code) => {
      calls.exchangeCodeForSession += 1
      void code
      return { data: { session, user }, error: options.exchangeCodeError ?? null }
    },
  }

  return { auth, calls }
}

// --- 1. abrir /confirmar-email NO llama verifyOtp ---

test("token_hash + type=email: needsConfirmation=true y verifyOtp NO se llama automáticamente (sólo al crear el controller)", () => {
  const { auth, calls } = createFakeAuth()

  const controller = createConfirmationLinkController(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "abc123",
    type: "email",
  })

  assert.equal(controller.needsConfirmation, true)
  assert.equal(calls.verifyOtp, 0)
  assert.equal(calls.exchangeCodeForSession, 0)
})

// --- 2. un click llama verifyOtp una sola vez ---

test("confirm() llamado una vez (un click) ejecuta verifyOtp exactamente una vez y resuelve 'confirmed'", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createConfirmationLinkController(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "abc123",
    type: "email",
  })

  const result = await controller.confirm()

  assert.equal(calls.verifyOtp, 1)
  assert.deepEqual(result, {
    status: "confirmed",
    accessToken: "confirmation-access-token",
    userId: "user-123",
  })
})

// --- 3. doble click no genera doble consumo ---

test("doble click (confirm() llamado dos veces seguidas antes de resolver): verifyOtp se llama UNA sola vez y ambas llamadas devuelven el mismo resultado", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createConfirmationLinkController(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "abc123",
    type: "email",
  })

  const [first, second] = await Promise.all([
    controller.confirm(),
    controller.confirm(),
  ])

  assert.equal(calls.verifyOtp, 1)
  assert.deepEqual(first, second)
})

test("confirm() llamado repetidas veces DESPUÉS de ya haber resuelto: sigue sin volver a llamar a verifyOtp -- el token se consume una sola vez", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createConfirmationLinkController(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "abc123",
    type: "email",
  })

  await controller.confirm()
  await controller.confirm()
  await controller.confirm()

  assert.equal(calls.verifyOtp, 1)
})

// --- 4. code (PKCE): tampoco se consume hasta confirm() ---

test("?code=: needsConfirmation=true y exchangeCodeForSession NO se llama hasta invocar confirm()", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createConfirmationLinkController(auth, {
    ...EMPTY_PARAMS,
    code: "pkce-xyz",
  })

  assert.equal(controller.needsConfirmation, true)
  assert.equal(calls.exchangeCodeForSession, 0)

  await controller.confirm()

  assert.equal(calls.exchangeCodeForSession, 1)
})

// --- 5. error de token muestra estado correcto ---

test("token vencido/ya usado: confirm() resuelve 'invalid' -- la página muestra el error, nunca la activa", async () => {
  const { auth } = createFakeAuth({
    verifyOtpError: { message: "Token has expired or is invalid", code: "otp_expired" },
  })
  const controller = createConfirmationLinkController(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "vencido",
    type: "email",
  })

  const result = await controller.confirm()

  assert.deepEqual(result, { status: "invalid" })
})

// --- 6. sin ningún parámetro consumible ---

test("sin token_hash ni code: needsConfirmation=false (no hay botón) y confirm() resuelve 'invalid' sin llamar nada", async () => {
  const { auth, calls } = createFakeAuth()
  const controller = createConfirmationLinkController(auth, EMPTY_PARAMS)

  assert.equal(controller.needsConfirmation, false)

  const result = await controller.confirm()

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.verifyOtp, 0)
  assert.equal(calls.exchangeCodeForSession, 0)
})
