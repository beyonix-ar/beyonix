import assert from "node:assert/strict"
import test from "node:test"

import { resolveRecoveryLink, type RecoveryAuthClient } from "./recovery-link.ts"

const EMPTY_PARAMS = {
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
  /** Sesión que getSession() devuelve DESPUÉS de una llamada exitosa (o si ya había una). */
  sessionAfterSuccess?: { access_token: string } | null
}

function createFakeAuth(options: FakeAuthOptions = {}) {
  const calls = {
    verifyOtp: [] as unknown[],
    exchangeCodeForSession: [] as unknown[],
    setSession: [] as unknown[],
    getSession: 0,
  }

  const auth: RecoveryAuthClient = {
    exchangeCodeForSession: async (code) => {
      calls.exchangeCodeForSession.push(code)
      return { error: options.exchangeCodeError ?? null }
    },
    verifyOtp: async (args) => {
      calls.verifyOtp.push(args)
      return { error: options.verifyOtpError ?? null }
    },
    setSession: async (args) => {
      calls.setSession.push(args)
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

// --- 1. token recovery válido ---

test("token_hash + type=recovery válido: verifyOtp se llama una sola vez y resuelve 'valid' con el access_token de la sesión resultante", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "abc123", type: "recovery" },
    false,
  )

  assert.deepEqual(result, { status: "valid", accessToken: "session-access-token" })
  assert.equal(calls.verifyOtp.length, 1)
  assert.deepEqual(calls.verifyOtp[0], { token_hash: "abc123", type: "recovery" })
  // Ni exchangeCodeForSession ni setSession se tocan en esta rama.
  assert.equal(calls.exchangeCodeForSession.length, 0)
  assert.equal(calls.setSession.length, 0)
})

test("?code= (PKCE) válido: exchangeCodeForSession se llama una sola vez y resuelve 'valid'", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, code: "pkce-code-xyz" },
    false,
  )

  assert.equal(result.status, "valid")
  assert.equal(calls.exchangeCodeForSession.length, 1)
  assert.equal(calls.exchangeCodeForSession[0], "pkce-code-xyz")
  assert.equal(calls.verifyOtp.length, 0)
})

test("#access_token+refresh_token (implícito/legado) válido: setSession se llama una sola vez y resuelve 'valid'", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, accessToken: "at-legacy", refreshToken: "rt-legacy" },
    false,
  )

  assert.equal(result.status, "valid")
  assert.equal(calls.setSession.length, 1)
  assert.deepEqual(calls.setSession[0], {
    access_token: "at-legacy",
    refresh_token: "rt-legacy",
  })
})

test("sesión ya establecida (recarga de /reset-password) + marca de recuperación en localStorage: resuelve 'valid' sin volver a llamar a verifyOtp/exchangeCode/setSession", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveRecoveryLink(auth, EMPTY_PARAMS, true)

  assert.equal(result.status, "valid")
  assert.equal(calls.verifyOtp.length, 0)
  assert.equal(calls.exchangeCodeForSession.length, 0)
  assert.equal(calls.setSession.length, 0)
})

// --- 2. token recovery vencido ---

test("token recovery VENCIDO: verifyOtp devuelve otp_expired -> resuelve 'invalid'", async () => {
  const { auth } = createFakeAuth({
    verifyOtpError: { message: "Token has expired or is invalid", code: "otp_expired" },
  })

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "vencido", type: "recovery" },
    false,
  )

  assert.deepEqual(result, { status: "invalid" })
})

// --- 3. token recovery ya utilizado ---

test("token recovery YA UTILIZADO: verifyOtp devuelve el mismo tipo de error genérico que uno vencido -> también resuelve 'invalid' (Supabase no distingue ambos casos)", async () => {
  const { auth } = createFakeAuth({
    verifyOtpError: { message: "Token has expired or is invalid" },
  })

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "ya-usado", type: "recovery" },
    false,
  )

  assert.deepEqual(result, { status: "invalid" })
})

test("un ?code= ya canjeado (reuso del link con PKCE): exchangeCodeForSession falla -> 'invalid', nunca queda una sesión a medias", async () => {
  const { auth } = createFakeAuth({
    exchangeCodeError: { message: "invalid request: both auth code and code verifier should be non-empty" },
  })

  const result = await resolveRecoveryLink(auth, { ...EMPTY_PARAMS, code: "ya-canjeado" }, false)

  assert.deepEqual(result, { status: "invalid" })
})

// --- 4. token_hash ausente ---

test("token_hash ausente y sin ningún otro parámetro de recuperación ni sesión previa: 'invalid' sin llamar a ningún método de auth", async () => {
  const { auth, calls } = createFakeAuth({ sessionAfterSuccess: null })

  const result = await resolveRecoveryLink(auth, EMPTY_PARAMS, false)

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.verifyOtp.length, 0)
  assert.equal(calls.exchangeCodeForSession.length, 0)
  assert.equal(calls.setSession.length, 0)
})

test("type=recovery presente pero SIN token_hash: no alcanza para autenticar, cae al chequeo de sesión existente y sin marca ni sesión previa resuelve 'invalid'", async () => {
  const { auth } = createFakeAuth({ sessionAfterSuccess: null })

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, type: "recovery" },
    false,
  )

  assert.deepEqual(result, { status: "invalid" })
})

// --- 5. type incorrecto ---

test("token_hash presente pero type NO es 'recovery' (ej. 'signup'): no se consume acá -- no llama a verifyOtp, resuelve 'invalid'", async () => {
  const { auth, calls } = createFakeAuth({ sessionAfterSuccess: null })

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "algun-hash", type: "signup" },
    false,
  )

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.verifyOtp.length, 0)
})

test("token_hash presente pero type ausente: tampoco se consume -- exige EXACTAMENTE type=recovery", async () => {
  const { auth, calls } = createFakeAuth({ sessionAfterSuccess: null })

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "algun-hash" },
    false,
  )

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.verifyOtp.length, 0)
})

// --- 6. error de Supabase (redirect con error en query o hash) ---

test("error en la query (?error=access_denied&error_description=...): corta ANTES de intentar nada, incluso si además viniera un code válido", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveRecoveryLink(
    auth,
    {
      ...EMPTY_PARAMS,
      code: "codigo-que-nunca-se-debe-usar",
      queryError: "El enlace ya fue utilizado.",
    },
    false,
  )

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.exchangeCodeForSession.length, 0)
})

test("error en el hash (#error=access_denied&error_description=...): mismo corte inmediato", async () => {
  const { auth, calls } = createFakeAuth()

  const result = await resolveRecoveryLink(
    auth,
    {
      ...EMPTY_PARAMS,
      tokenHash: "hash-que-nunca-se-debe-usar",
      type: "recovery",
      hashError: "otp_expired",
    },
    false,
  )

  assert.deepEqual(result, { status: "invalid" })
  assert.equal(calls.verifyOtp.length, 0)
})

// --- Consumo único (nunca doble verifyOtp/exchangeCode para el mismo link) ---

test("una vez resuelto, la función no vuelve a intentar otra rama: un token_hash válido nunca dispara también exchangeCodeForSession o setSession", async () => {
  const { auth, calls } = createFakeAuth()

  await resolveRecoveryLink(
    auth,
    {
      ...EMPTY_PARAMS,
      tokenHash: "unico",
      type: "recovery",
      accessToken: "no-deberia-usarse",
      refreshToken: "no-deberia-usarse",
    },
    false,
  )

  assert.equal(calls.verifyOtp.length, 1)
  assert.equal(calls.setSession.length, 0)
})

test("si getSession() no devuelve token tras un verifyOtp 'exitoso' (estado inconsistente): igual resuelve 'invalid', nunca 'valid' sin accessToken", async () => {
  const { auth } = createFakeAuth({ sessionAfterSuccess: null })

  const result = await resolveRecoveryLink(
    auth,
    { ...EMPTY_PARAMS, tokenHash: "hash", type: "recovery" },
    false,
  )

  assert.deepEqual(result, { status: "invalid" })
})
