import assert from "node:assert/strict"
import test from "node:test"

import {
  resolveConfirmationLink,
  type ConfirmationAuthClient,
} from "./confirmation-link.ts"

const EMPTY_PARAMS = {
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
    verifyOtp: [] as unknown[],
    exchangeCodeForSession: [] as unknown[],
  }

  const session =
    options.sessionAfterSuccess === undefined
      ? { access_token: "confirmation-access-token" }
      : options.sessionAfterSuccess
  const user =
    options.userAfterSuccess === undefined
      ? { id: "user-123" }
      : options.userAfterSuccess

  const auth: ConfirmationAuthClient = {
    verifyOtp: async (args) => {
      calls.verifyOtp.push(args)
      return {
        data: { session, user },
        error: options.verifyOtpError ?? null,
      }
    },
    exchangeCodeForSession: async (code) => {
      calls.exchangeCodeForSession.push(code)
      return {
        data: { session, user },
        error: options.exchangeCodeError ?? null,
      }
    },
  }

  return { auth, calls }
}

// --- 1. token_hash + type=signup válido ---

test("token_hash + type=signup válido: verifyOtp se llama una sola vez con type=signup y resuelve 'confirmed' con accessToken/userId", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveConfirmationLink(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "abc123",
    type: "signup",
  })

  assert.deepEqual(result, {
    status: "confirmed",
    accessToken: "confirmation-access-token",
    userId: "user-123",
  })
  assert.equal(calls.verifyOtp.length, 1)
  assert.deepEqual(calls.verifyOtp[0], { token_hash: "abc123", type: "signup" })
  assert.equal(calls.exchangeCodeForSession.length, 0)
})

test("token_hash SIN type (o type desconocido): por defecto se trata como signup (único flujo que se usa hoy)", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveConfirmationLink(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "abc123",
    type: null,
  })

  assert.equal(result.status, "confirmed")
  assert.deepEqual(calls.verifyOtp[0], { token_hash: "abc123", type: "signup" })
})

test("?code= (PKCE) válido: exchangeCodeForSession se llama una sola vez y resuelve 'confirmed'", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveConfirmationLink(auth, {
    ...EMPTY_PARAMS,
    code: "pkce-code-xyz",
  })

  assert.equal(result.status, "confirmed")
  assert.equal(calls.exchangeCodeForSession.length, 1)
  assert.equal(calls.exchangeCodeForSession[0], "pkce-code-xyz")
  assert.equal(calls.verifyOtp.length, 0)
})

// --- 2. token vencido / ya usado ---

test("token de signup VENCIDO o YA UTILIZADO: verifyOtp devuelve error -> resuelve 'invalid'", async () => {
  const { auth } = createFakeAuth({
    verifyOtpError: { message: "Token has expired or is invalid", code: "otp_expired" },
  })

  const result = await resolveConfirmationLink(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "vencido",
    type: "signup",
  })

  assert.deepEqual(result, { status: "invalid" })
})

test("?code= ya canjeado: exchangeCodeForSession falla -> 'invalid'", async () => {
  const { auth } = createFakeAuth({
    exchangeCodeError: { message: "invalid request: both auth code and code verifier should be non-empty" },
  })

  const result = await resolveConfirmationLink(auth, {
    ...EMPTY_PARAMS,
    code: "ya-canjeado",
  })

  assert.deepEqual(result, { status: "invalid" })
})

// --- 3. sin ningún parámetro consumible ---

test("sin token_hash ni code: 'invalid' sin llamar a ningún método de auth", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveConfirmationLink(auth, EMPTY_PARAMS)

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.verifyOtp.length, 0)
  assert.equal(calls.exchangeCodeForSession.length, 0)
})

// --- 4. estado inconsistente: sin error pero sin sesión/usuario ---

test("si verifyOtp no devuelve error pero tampoco sesión: igual resuelve 'invalid', nunca 'confirmed' sin accessToken", async () => {
  const { auth } = createFakeAuth({ sessionAfterSuccess: null })

  const result = await resolveConfirmationLink(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "hash",
    type: "signup",
  })

  assert.deepEqual(result, { status: "invalid" })
})

test("si verifyOtp no devuelve error pero tampoco usuario: igual resuelve 'invalid'", async () => {
  const { auth } = createFakeAuth({ userAfterSuccess: null })

  const result = await resolveConfirmationLink(auth, {
    ...EMPTY_PARAMS,
    tokenHash: "hash",
    type: "signup",
  })

  assert.deepEqual(result, { status: "invalid" })
})

// --- 5. prioridad token_hash sobre code ---

test("con token_hash Y code presentes a la vez: usa token_hash, nunca llama a exchangeCodeForSession", async () => {
  const { auth, calls } = createFakeAuth()

  await resolveConfirmationLink(auth, {
    tokenHash: "unico",
    type: "signup",
    code: "no-deberia-usarse",
  })

  assert.equal(calls.verifyOtp.length, 1)
  assert.equal(calls.exchangeCodeForSession.length, 0)
})
