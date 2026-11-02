import assert from "node:assert/strict"
import test from "node:test"

import {
  FORGOT_PASSWORD_GENERIC_MESSAGE,
  FORGOT_PASSWORD_MAX_JITTER_MS,
  FORGOT_PASSWORD_MIN_RESPONSE_MS,
  finalizeForgotPasswordResponse,
  requestPasswordRecovery,
  type ForgotPasswordTiming,
  type RequestPasswordRecoveryInput,
} from "./forgot-password.ts"

type AdminClient = Exclude<RequestPasswordRecoveryInput["admin"], () => unknown>

function captureLogs(run: () => Promise<unknown>) {
  const originalLog = console.log
  const originalError = console.error
  const logLines: unknown[][] = []
  const errorLines: unknown[][] = []
  console.log = (...args: unknown[]) => {
    logLines.push(args)
  }
  console.error = (...args: unknown[]) => {
    errorLines.push(args)
  }
  return run().finally(() => {
    console.log = originalLog
    console.error = originalError
  }).then((result) => ({ result, logLines, errorLines }))
}

function parsedPasswordResetLogs(logLines: unknown[][]) {
  return logLines
    .filter((line) => line[0] === "password-reset:")
    .map((line) => JSON.parse(line[1] as string))
}

interface FakeAdminOptions {
  /** username (ya normalizado a minúsculas) -> email real, o null si no existe. */
  usernameEmails?: Record<string, string | null>
  attemptCounts?: {
    identifierHour?: number
    identifierDay?: number
    ipHour?: number
    ipDay?: number
  }
  resetPasswordError?: { message: string; code?: string } | null
  /** Simula la migración pendiente: la RPC/tabla de rate limit no existe. */
  tableMissing?: boolean
  /** Emails que SÍ tienen una fila real en `profiles` (para accountExistsForEmail, sólo diagnóstico/log). */
  knownEmails?: string[]
  /** La RPC atómica falla al contar (error de PostgREST/red). */
  countError?: boolean
  /** La RPC atómica responde sin error pero con un formato inválido (no boolean). */
  countNull?: boolean
  /** La RPC atómica falla al registrar el intento. */
  insertError?: boolean
  /** La purga de filas viejas falla (no debe bloquear). */
  purgeError?: boolean
  /** La RPC de username -> email falla. */
  rpcError?: boolean
  /** resetPasswordForEmail lanza (no devuelve `{ error }`). */
  resetPasswordThrows?: boolean
}

function createFakeAdmin(options: FakeAdminOptions = {}) {
  const counts = {
    identifierHour: 0,
    identifierDay: 0,
    ipHour: 0,
    ipDay: 0,
    ...options.attemptCounts,
  }
  const calls = {
    inserts: [] as Array<{ identifier_hash: string; ip_hash: string | null }>,
    deletes: 0,
    admissions: 0,
    rpc: [] as Array<{ fn: string; args: unknown }>,
    resetPasswordForEmail: [] as Array<{ email: string; redirectTo: string }>,
  }

  // Sólo quedan dos usos de `from()`: la purga y el diagnóstico en profiles.
  // Contar/insertar intentos ya no existe en TS (lo hace la RPC atómica).
  function makeQuery(table: string) {
    const state: { filterKey: string | null } = { filterKey: null }

    const builder = {
      select() {
        assert.equal(table, "profiles", "el rate limit no debe consultarse por tabla desde TS")
        return builder
      },
      delete() {
        assert.equal(table, "password_reset_attempts")
        return builder
      },
      ilike(column: string, value: string) {
        state.filterKey = `${column}:${value.toLowerCase()}`
        return builder
      },
      limit() {
        return builder
      },
      lt() {
        calls.deletes += 1
        return Promise.resolve({
          error: options.purgeError ? { message: "purge failed", code: "57014" } : null,
        })
      },
      then(resolve: (value: unknown) => void) {
        const email = state.filterKey?.replace(/^email:/, "") ?? ""
        const exists = (options.knownEmails ?? []).some(
          (known) => known.toLowerCase() === email,
        )
        return resolve({ data: exists ? [{ id: "fake-id" }] : [], error: null })
      },
    }

    return builder
  }

  // Espejo de admit_password_reset_attempt: decide con los conteos previos
  // configurados y registra el intento SIEMPRE (también si queda limitado).
  function admitPasswordResetAttempt(args: { p_identifier_hash: string; p_ip_hash: string | null }) {
    if (options.tableMissing) {
      return { data: null, error: { message: "function admit_password_reset_attempt does not exist", code: "PGRST202" } }
    }
    if (options.countError) return { data: null, error: { message: "count failed", code: "57014" } }
    if (options.insertError) return { data: null, error: { message: "insert failed", code: "42501" } }
    if (options.countNull) return { data: null, error: null }
    calls.inserts.push({ identifier_hash: args.p_identifier_hash, ip_hash: args.p_ip_hash })
    const hasIp = args.p_ip_hash !== null
    const allowed =
      counts.identifierHour < 3 &&
      counts.identifierDay < 6 &&
      (!hasIp || (counts.ipHour < 8 && counts.ipDay < 20))
    return { data: allowed, error: null }
  }

  const admin = {
    from: (table: string) => makeQuery(table),
    rpc: async (fn: string, args: unknown) => {
      if (fn === "admit_password_reset_attempt") {
        calls.admissions += 1
        return admitPasswordResetAttempt(args as { p_identifier_hash: string; p_ip_hash: string | null })
      }
      calls.rpc.push({ fn, args })
      if (options.rpcError) return { data: null, error: { message: "rpc failed", code: "PGRST301" } }
      const username = (args as { username_input: string }).username_input
      const email = options.usernameEmails?.[username] ?? null
      return { data: email, error: null }
    },
    auth: {
      resetPasswordForEmail: async (email: string, opts: { redirectTo: string }) => {
        calls.resetPasswordForEmail.push({ email, redirectTo: opts.redirectTo })
        if (options.resetPasswordThrows) throw new Error(`fetch failed for ${email}`)
        return { error: options.resetPasswordError ?? null }
      },
    },
  }

  return { admin: admin as unknown as AdminClient, calls }
}

const SITE_URL = "https://beyonix.com.ar"

test("email existente: dispara resetPasswordForEmail con la URL canónica y responde el mensaje genérico", async () => {
  const { admin, calls } = createFakeAdmin()

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "cliente@example.com",
    ip: "1.2.3.4",
    siteUrl: SITE_URL,
  })

  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
  assert.equal(calls.resetPasswordForEmail.length, 1)
  assert.equal(calls.resetPasswordForEmail[0].email, "cliente@example.com")
  assert.equal(calls.resetPasswordForEmail[0].redirectTo, `${SITE_URL}/reset-password`)
})

test("username existente (ANTARES): resuelve server-side a su email y dispara el envío", async () => {
  const { admin, calls } = createFakeAdmin({
    usernameEmails: { antares: "antares-real@example.com" },
  })

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "ANTARES",
    ip: "1.2.3.4",
    siteUrl: SITE_URL,
  })

  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
  assert.equal(calls.resetPasswordForEmail.length, 1)
  assert.equal(calls.resetPasswordForEmail[0].email, "antares-real@example.com")
})

test("con un email (exista o no la cuenta): resetPasswordForEmail SIEMPRE se llama y la respuesta pública es idéntica", async () => {
  // Para un identificador con forma de email no hay lookup previo de
  // existencia: se delega en la propia protección de Supabase (su endpoint
  // /recover no distingue "existe" de "no existe" ni en respuesta ni en
  // tiempo). Verificar existencia nosotros antes de llamar sería agregar
  // una asimetría (una consulta extra sólo cuando el email SÍ existe) que
  // hoy no existe.
  const { admin: adminA, calls: callsA } = createFakeAdmin()
  const resultA = await requestPasswordRecovery({
    admin: adminA,
    identifierRaw: "existe@example.com",
    ip: "1.2.3.4",
    siteUrl: SITE_URL,
  })

  const { admin: adminB, calls: callsB } = createFakeAdmin()
  const resultB = await requestPasswordRecovery({
    admin: adminB,
    identifierRaw: "no-existe@example.com",
    ip: "1.2.3.4",
    siteUrl: SITE_URL,
  })

  // La respuesta pública (lo único que un atacante puede observar) es
  // exactamente la misma -- ni el status, ni el JSON, distinguen los casos.
  assert.deepEqual(resultA, resultB)
  assert.equal(callsA.resetPasswordForEmail.length, 1)
  assert.equal(callsB.resetPasswordForEmail.length, 1)
})

test("username inexistente: respuesta pública idéntica a la de un username existente", async () => {
  const { admin: adminFound } = createFakeAdmin({
    usernameEmails: { antares: "antares@example.com" },
  })
  const foundResult = await requestPasswordRecovery({
    admin: adminFound,
    identifierRaw: "antares",
    ip: "5.6.7.8",
    siteUrl: SITE_URL,
  })

  const { admin: adminMissing } = createFakeAdmin({
    usernameEmails: { antares: null },
  })
  const missingResult = await requestPasswordRecovery({
    admin: adminMissing,
    identifierRaw: "orion-no-existe",
    ip: "5.6.7.8",
    siteUrl: SITE_URL,
  })

  assert.deepEqual(foundResult, missingResult)
})

test("un username inexistente NUNCA se pasa como email a resetPasswordForEmail", async () => {
  const { admin, calls } = createFakeAdmin({ usernameEmails: {} })

  await requestPasswordRecovery({
    admin,
    identifierRaw: "usuario-fantasma",
    ip: "1.1.1.1",
    siteUrl: SITE_URL,
  })

  assert.equal(calls.resetPasswordForEmail.length, 0)
})

test("input vacío devuelve un error de FORMATO (no el mensaje genérico) -- no es enumeración, no depende de ninguna cuenta", async () => {
  const { admin } = createFakeAdmin()

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "",
    ip: "1.1.1.1",
    siteUrl: SITE_URL,
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.status, 400)
})

test("identificador con formato inválido (espacios) devuelve el mismo error de formato", async () => {
  const { admin } = createFakeAdmin()

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "dos palabras",
    ip: "1.1.1.1",
    siteUrl: SITE_URL,
  })

  assert.equal(result.ok, false)
})

test("rate limit por identificador: no dispara el envío pero responde igual que un envío exitoso", async () => {
  const { admin, calls } = createFakeAdmin({
    attemptCounts: { identifierHour: 3 },
  })

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "cliente@example.com",
    ip: "9.9.9.9",
    siteUrl: SITE_URL,
  })

  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
  assert.equal(calls.resetPasswordForEmail.length, 0)
  // El intento se sigue registrando aunque esté bloqueado.
  assert.equal(calls.inserts.length, 1)
})

test("rate limit por IP: no dispara el envío, misma respuesta pública", async () => {
  const { admin, calls } = createFakeAdmin({
    attemptCounts: { ipHour: 8 },
  })

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "cualquier-usuario",
    ip: "9.9.9.9",
    siteUrl: SITE_URL,
  })

  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
  assert.equal(calls.resetPasswordForEmail.length, 0)
})

test("cada solicitud registra un intento de rate limit (hash, nunca el identificador en texto plano)", async () => {
  const { admin, calls } = createFakeAdmin()

  await requestPasswordRecovery({
    admin,
    identifierRaw: "cliente@example.com",
    ip: "1.2.3.4",
    siteUrl: SITE_URL,
  })

  assert.equal(calls.inserts.length, 1)
  assert.doesNotMatch(calls.inserts[0].identifier_hash, /cliente|example/i)
  assert.equal(calls.inserts[0].identifier_hash.length, 64)
  assert.equal(calls.inserts[0].ip_hash?.length, 64)
})

test("sin siteUrl resuelto (canónica no configurada): no envía nada y responde neutro", async () => {
  const { admin, calls } = createFakeAdmin()

  const { result, logLines } = await captureLogs(() =>
    requestPasswordRecovery({
      admin,
      identifierRaw: "cliente@example.com",
      ip: "1.2.3.4",
      siteUrl: null,
    }),
  )

  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
  assert.equal(calls.resetPasswordForEmail.length, 0)
  assert.equal(parsedPasswordResetLogs(logLines)[0].internalError, "SITE_URL_UNAVAILABLE")
})

test("si la tabla de rate limit todavía no existe (migración pendiente): falla cerrado, NUNCA manda el email, respuesta neutra", async () => {
  const { admin, calls } = createFakeAdmin({ tableMissing: true })

  const { result } = await captureLogs(() =>
    requestPasswordRecovery({
      admin,
      identifierRaw: "cliente@example.com",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
    }),
  )

  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
  assert.equal(calls.resetPasswordForEmail.length, 0)
})

test("un error al enviar el email (proveedor caído) no se filtra al resultado público", async () => {
  const { admin } = createFakeAdmin({
    resetPasswordError: { message: "SMTP down" },
  })

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "cliente@example.com",
    ip: "1.2.3.4",
    siteUrl: SITE_URL,
  })

  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
})

// --- Observabilidad segura (caso real: "enzito" vs "enzitop") ---

test("un username válido y RESUELTO deja un log con accountResolved=true, resetRequested=true, sin error de proveedor", async () => {
  const { admin } = createFakeAdmin({
    usernameEmails: { enzitop: "real@gmail.com" },
  })

  const { logLines } = await captureLogs(() =>
    requestPasswordRecovery({
      admin,
      identifierRaw: "enzitop",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
    }),
  )

  const [event] = parsedPasswordResetLogs(logLines)
  assert.equal(event.identifierType, "username")
  assert.equal(event.accountResolved, true)
  assert.equal(event.resetRequested, true)
  assert.equal(event.providerErrorCode, null)
})

test("un username que NO resuelve a ninguna cuenta (caso real: 'enzito' en vez de 'enzitop') deja un log con accountResolved=false, resetRequested=false -- sin llamar a resetPasswordForEmail", async () => {
  const { admin, calls } = createFakeAdmin({
    usernameEmails: { enzitop: "real@gmail.com" }, // sólo "enzitop" existe, "enzito" no
  })

  const { result, logLines } = await captureLogs(() =>
    requestPasswordRecovery({
      admin,
      identifierRaw: "enzito",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
    }),
  )

  // Respuesta pública idéntica a la del caso resuelto -- el log interno es
  // lo único que distingue "no se encontró la cuenta" de "sí se encontró".
  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })
  assert.equal(calls.resetPasswordForEmail.length, 0)

  const [event] = parsedPasswordResetLogs(logLines)
  assert.equal(event.identifierType, "username")
  assert.equal(event.accountResolved, false)
  assert.equal(event.resetRequested, false)
})

test("un identificador con forma de email SIEMPRE dispara resetPasswordForEmail, pero el log distingue si la cuenta existe de verdad (sólo para diagnóstico, nunca cambia la respuesta)", async () => {
  const { admin: adminReal, calls: callsReal } = createFakeAdmin({
    knownEmails: ["real@gmail.com"],
  })
  const { result: resultReal, logLines: logsReal } = await captureLogs(() =>
    requestPasswordRecovery({
      admin: adminReal,
      identifierRaw: "real@gmail.com",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
    }),
  )

  const { admin: adminFake, calls: callsFake } = createFakeAdmin({ knownEmails: [] })
  const { result: resultFake, logLines: logsFake } = await captureLogs(() =>
    requestPasswordRecovery({
      admin: adminFake,
      identifierRaw: "no-existe@gmail.com",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
    }),
  )

  // Público: exactamente igual.
  assert.deepEqual(resultReal, resultFake)
  assert.equal(callsReal.resetPasswordForEmail.length, 1)
  assert.equal(callsFake.resetPasswordForEmail.length, 1)

  // Interno (sólo en logs del servidor): distinto, para poder diagnosticar.
  assert.equal(parsedPasswordResetLogs(logsReal)[0].accountResolved, true)
  assert.equal(parsedPasswordResetLogs(logsFake)[0].accountResolved, false)
})

test("un error real de Supabase al pedir el reset se registra con su código, pero NUNCA en la respuesta pública", async () => {
  const { admin } = createFakeAdmin({
    usernameEmails: { enzitop: "real@gmail.com" },
    resetPasswordError: { message: "Email rate limit exceeded", code: "over_email_send_rate_limit" },
  })

  const { result, logLines, errorLines } = await captureLogs(() =>
    requestPasswordRecovery({
      admin,
      identifierRaw: "enzitop",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
    }),
  )

  assert.deepEqual(result, { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE })

  const [event] = parsedPasswordResetLogs(logLines)
  assert.equal(event.providerErrorCode, "over_email_send_rate_limit")

  // El error también queda en console.error para diagnóstico -- sin el
  // email/username real.
  assert.equal(errorLines.length, 1)
  const errorPayload = JSON.stringify(errorLines[0])
  assert.doesNotMatch(errorPayload, /real@gmail\.com/)
  assert.doesNotMatch(errorPayload, /enzitop/)
})

test("un identificador con formato inválido nunca llega a resetPasswordForEmail ni deja accountResolved engañoso", async () => {
  const { admin, calls } = createFakeAdmin()

  const { logLines } = await captureLogs(() =>
    requestPasswordRecovery({
      admin,
      identifierRaw: "",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
    }),
  )

  assert.equal(calls.resetPasswordForEmail.length, 0)
  const [event] = parsedPasswordResetLogs(logLines)
  assert.equal(event.identifierType, "invalid")
  assert.equal(event.accountResolved, false)
  assert.equal(event.resetRequested, false)
})

test("ningún log de este flujo imprime el email/username completo en texto plano", async () => {
  const { admin } = createFakeAdmin({
    usernameEmails: { enzitop: "muy-secreto@gmail.com" },
  })

  const { logLines, errorLines } = await captureLogs(() =>
    requestPasswordRecovery({
      admin,
      identifierRaw: "enzitop",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
    }),
  )

  const allOutput = JSON.stringify([...logLines, ...errorLines])
  assert.doesNotMatch(allOutput, /muy-secreto@gmail\.com/)
  assert.doesNotMatch(allOutput, /\benzitop\b/)
})

// --- Fail closed del rate limit, timing uniforme, excepciones y logs ---

function spyTiming() {
  let clock = 0
  const sleeps: number[] = []
  const timing: ForgotPasswordTiming = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    jitter: () => 0,
  }
  return { timing, sleeps }
}

const NEUTRAL = { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE }

async function run(
  options: FakeAdminOptions,
  input: Partial<RequestPasswordRecoveryInput> = {},
) {
  const fake = createFakeAdmin(options)
  const { timing, sleeps } = spyTiming()
  const captured = await captureLogs(() =>
    requestPasswordRecovery({
      admin: fake.admin,
      identifierRaw: "cliente@example.com",
      ip: "1.2.3.4",
      siteUrl: SITE_URL,
      timing,
      ...input,
    }),
  )
  return { ...captured, calls: fake.calls, sleeps, events: parsedPasswordResetLogs(captured.logLines) }
}

test("A. fallo al contar intentos => no envía email, respuesta neutra, error observable", async () => {
  for (const options of [{ countError: true }, { countNull: true }] satisfies FakeAdminOptions[]) {
    const { result, calls, events, errorLines } = await run(options)

    assert.deepEqual(result, NEUTRAL)
    assert.equal(calls.resetPasswordForEmail.length, 0)
    assert.equal(calls.inserts.length, 0)
    assert.equal(events[0].internalError, "RATE_LIMIT_STORAGE_ERROR")
    assert.equal(errorLines[0][0], "FORGOT_PASSWORD_FAIL_CLOSED")
  }
})

test("B. fallo al registrar el intento => no envía email, respuesta neutra", async () => {
  const { result, calls, events } = await run({ insertError: true })

  assert.deepEqual(result, NEUTRAL)
  assert.equal(calls.resetPasswordForEmail.length, 0)
  assert.equal(events[0].internalError, "RATE_LIMIT_STORAGE_ERROR")
})

test("una purga fallida NO bloquea (no debilita el límite) pero queda registrada", async () => {
  const { result, calls, errorLines } = await run({ purgeError: true })

  assert.deepEqual(result, NEUTRAL)
  assert.equal(calls.resetPasswordForEmail.length, 1)
  assert.equal(errorLines[0][0], "FORGOT_PASSWORD_RATE_LIMIT_PURGE_ERROR")
})

test("C. rate limit alcanzado => no envía, mismo body/status que un envío normal y que un fallo interno", async () => {
  const limited = await run({ attemptCounts: { identifierDay: 6 } })
  const normal = await run({})
  const broken = await run({ insertError: true })

  assert.equal(limited.calls.resetPasswordForEmail.length, 0)
  assert.equal(normal.calls.resetPasswordForEmail.length, 1)
  assert.deepEqual(limited.result, normal.result)
  assert.deepEqual(broken.result, normal.result)
  assert.equal(limited.events[0].rateLimited, true)
})

test("D. sin IP confiable el límite por identificador sigue operativo", async () => {
  const limited = await run({ attemptCounts: { identifierHour: 3 } }, { ip: null })
  assert.equal(limited.calls.resetPasswordForEmail.length, 0)
  assert.equal(limited.calls.inserts[0].ip_hash, null)

  const allowed = await run({ attemptCounts: { ipHour: 999 } }, { ip: null })
  assert.equal(allowed.calls.resetPasswordForEmail.length, 1)
})

test("E. variantes de mayúsculas/espacios comparten la misma clave de rate limit", async () => {
  const hashes = new Set<string>()
  for (const identifierRaw of ["Usuario", "usuario", " usuario ", "USUARIO"]) {
    const { calls } = await run({}, { identifierRaw })
    hashes.add(calls.inserts[0].identifier_hash)
  }
  assert.equal(hashes.size, 1)

  const emailHashes = new Set<string>()
  for (const identifierRaw of ["Cliente@Example.com", " cliente@example.com "]) {
    const { calls } = await run({}, { identifierRaw })
    emailHashes.add(calls.inserts[0].identifier_hash)
  }
  assert.equal(emailHashes.size, 1)
})

test("timing: todo camino (normal, inexistente, limitado, fallos, excepción, formato) pasa una única vez por la finalización con el mismo piso", async () => {
  const throwingFactory = () => {
    throw new Error("Supabase admin no configurado")
  }
  const scenarios: Array<[string, FakeAdminOptions, Partial<RequestPasswordRecoveryInput>]> = [
    ["email existente", { knownEmails: ["cliente@example.com"] }, {}],
    ["username inexistente", {}, { identifierRaw: "nadie" }],
    ["rate limited", { attemptCounts: { identifierHour: 3 } }, {}],
    ["conteo fallido", { countError: true }, {}],
    ["insert fallido", { insertError: true }, {}],
    ["proveedor con error", { resetPasswordError: { message: "x", code: "unexpected_failure" } }, {}],
    ["proveedor lanza", { resetPasswordThrows: true }, {}],
    ["rpc lanza", { rpcError: true }, { identifierRaw: "alguien" }],
    ["sin site url", {}, { siteUrl: null }],
    ["admin no construible", {}, { admin: throwingFactory }],
    ["formato inválido", {}, { identifierRaw: "" }],
  ]

  for (const [name, options, input] of scenarios) {
    const { sleeps } = await run(options, input)
    assert.deepEqual(sleeps, [FORGOT_PASSWORD_MIN_RESPONSE_MS], name)
  }
})

test("timing: el piso incluye jitter acotado y no se duerme si ya se superó", async () => {
  const sleeps: number[] = []
  const timing: ForgotPasswordTiming = {
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    jitter: () => FORGOT_PASSWORD_MAX_JITTER_MS,
  }
  await finalizeForgotPasswordResponse(0, { ok: true, message: "x" }, timing)
  assert.deepEqual(sleeps, [FORGOT_PASSWORD_MIN_RESPONSE_MS + FORGOT_PASSWORD_MAX_JITTER_MS])

  const late: ForgotPasswordTiming = { ...timing, now: () => 10_000 }
  await finalizeForgotPasswordResponse(0, { ok: true, message: "x" }, late)
  assert.equal(sleeps.length, 1)
})

test("timing: el trabajo dependiente de la cuenta (RPC, profiles, proveedor) corre DESPUÉS de responder vía defer", async () => {
  for (const identifierRaw of ["cliente@example.com", "antares", "nadie"]) {
    const deferred: Array<() => Promise<void>> = []
    const { result, calls } = await run(
      { usernameEmails: { antares: "antares@example.com" } },
      { identifierRaw, defer: (task) => deferred.push(task) },
    )

    assert.deepEqual(result, NEUTRAL)
    assert.equal(calls.rpc.length, 0, identifierRaw)
    assert.equal(calls.resetPasswordForEmail.length, 0, identifierRaw)
    assert.equal(deferred.length, 1, identifierRaw)

    await captureLogs(() => deferred[0]())
    assert.equal(calls.resetPasswordForEmail.length, identifierRaw === "nadie" ? 0 : 1, identifierRaw)
  }
})

test("rate limited / fallo de la RPC atómica no programan ningún envío diferido ni llaman a Supabase Auth", async () => {
  const cases: FakeAdminOptions[] = [
    { attemptCounts: { identifierHour: 3 } },
    { attemptCounts: { ipDay: 20 } },
    { insertError: true },
    { countError: true },
    { countNull: true },
    { tableMissing: true },
  ]
  for (const options of cases) {
    const deferred: Array<() => Promise<void>> = []
    const { result, calls } = await run(options, { defer: (task) => deferred.push(task) })
    assert.deepEqual(result, NEUTRAL, JSON.stringify(options))
    assert.equal(deferred.length, 0, JSON.stringify(options))
    assert.equal(calls.resetPasswordForEmail.length, 0, JSON.stringify(options))
    assert.equal(calls.rpc.length, 0, JSON.stringify(options))
  }
})

test("sólo una admisión de la RPC atómica programa el envío diferido", async () => {
  const deferred: Array<() => Promise<void>> = []
  const { calls } = await run({}, { defer: (task) => deferred.push(task) })
  assert.equal(calls.admissions, 1)
  assert.equal(deferred.length, 1)
})

test("la decisión es UNA llamada a admit_password_reset_attempt con hashes (IP null si no hay IP confiable); sin COUNT/INSERT desde TS", async () => {
  const withIp = await run({}, { identifierRaw: " Cliente@Example.com ", ip: "203.0.113.7" })
  assert.equal(withIp.calls.admissions, 1)
  assert.match(withIp.calls.inserts[0].identifier_hash, /^[0-9a-f]{64}$/)
  assert.match(withIp.calls.inserts[0].ip_hash ?? "", /^[0-9a-f]{64}$/)

  const withoutIp = await run({}, { ip: null })
  assert.equal(withoutIp.calls.admissions, 1)
  assert.equal(withoutIp.calls.inserts[0].ip_hash, null)

  const { readFileSync } = await import("node:fs")
  const source = readFileSync("lib/auth/forgot-password.ts", "utf8")
  assert.match(source, /admin\.rpc\("admit_password_reset_attempt"/)
  assert.doesNotMatch(source, /\.insert\(/)
  assert.doesNotMatch(source, /count: "exact"/)
  assert.doesNotMatch(source, /isPasswordResetRateLimited/)
})

test("excepciones: resolución de username, proveedor y cliente admin => respuesta neutra y error observable", async () => {
  const rpc = await run({ rpcError: true }, { identifierRaw: "alguien" })
  assert.deepEqual(rpc.result, NEUTRAL)
  assert.equal(rpc.calls.resetPasswordForEmail.length, 0)
  assert.equal(rpc.events.at(-1)?.internalError, "USERNAME_LOOKUP_ERROR")
  assert.equal(rpc.errorLines[0][0], "FORGOT_PASSWORD_FAIL_CLOSED")

  const provider = await run({ resetPasswordThrows: true })
  assert.deepEqual(provider.result, NEUTRAL)
  assert.equal(provider.events.at(-1)?.internalError, "PROVIDER_CALL_FAILED")
  assert.doesNotMatch(JSON.stringify(provider.errorLines), /cliente@example\.com|fetch failed/)

  const admin = await run({}, {
    admin: () => {
      throw new Error("Supabase admin no configurado")
    },
  })
  assert.deepEqual(admin.result, NEUTRAL)
  assert.equal(admin.events[0].internalError, "ADMIN_CLIENT_UNAVAILABLE")
})

test("logs: sin email, username, IP, token ni mensaje crudo del proveedor; providerErrorCode normalizado", async () => {
  const { logLines, errorLines, events } = await run(
    {
      usernameEmails: { enzitop: "muy-secreto@gmail.com" },
      resetPasswordError: {
        message: "SMTP 550 muy-secreto@gmail.com token=eyJhbGciOi",
        code: "smtp error for muy-secreto@gmail.com",
      },
    },
    { identifierRaw: "EnziTop", ip: "203.0.113.7" },
  )

  const output = JSON.stringify([...logLines, ...errorLines])
  assert.doesNotMatch(output, /muy-secreto|enzitop|203\.0\.113\.7|eyJhbGciOi|SMTP 550/i)
  assert.equal(events[0].providerErrorCode, "provider_error_unknown")
})

test("logs: el correlationId es aleatorio por request y no deriva del identificador", async () => {
  const first = await run({})
  const second = await run({})
  const firstId = first.events[0].correlationId
  const secondId = second.events[0].correlationId

  assert.notEqual(firstId, secondId)
  const { createHash } = await import("node:crypto")
  const digest = createHash("sha256").update("cliente@example.com").digest("hex")
  assert.equal(digest.startsWith(firstId), false)
})