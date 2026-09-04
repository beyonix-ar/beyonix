import assert from "node:assert/strict"
import test from "node:test"

import { FORGOT_PASSWORD_GENERIC_MESSAGE, requestPasswordRecovery } from "./forgot-password.ts"

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
  /** Simula que la tabla password_reset_attempts todavía no existe (migración pendiente). */
  tableMissing?: boolean
  /** Emails que SÍ tienen una fila real en `profiles` (para accountExistsForEmail, sólo diagnóstico/log). */
  knownEmails?: string[]
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
    rpc: [] as Array<{ fn: string; args: unknown }>,
    resetPasswordForEmail: [] as Array<{ email: string; redirectTo: string }>,
  }

  function makeQuery(table: string) {
    const state: {
      mode: "count" | "insert" | "delete" | "canary" | "profiles-email" | null
      filterKey: string | null
      since: string | null
    } = {
      mode: null,
      filterKey: null,
      since: null,
    }

    const builder = {
      select(_columns: string, opts?: { count?: string; head?: boolean }) {
        if (table === "profiles") {
          state.mode = "profiles-email"
          return builder
        }
        // La canaria de existencia (rateLimitTableExists) hace un select SIN
        // `head: true` -- mismo criterio que el código real, para que el
        // fake sólo pueda "ver" la tabla ausente por ese camino.
        state.mode = opts?.head ? "count" : "canary"
        return builder
      },
      insert(payload: { identifier_hash: string; ip_hash: string | null }) {
        state.mode = "insert"
        calls.inserts.push(payload)
        return builder
      },
      delete() {
        state.mode = "delete"
        return builder
      },
      eq(column: string, value: string) {
        state.filterKey = `${column}:${value}`
        return builder
      },
      ilike(column: string, value: string) {
        state.filterKey = `${column}:${value.toLowerCase()}`
        return builder
      },
      gte(_column: string, since: string) {
        state.since = since
        return builder
      },
      limit() {
        return builder
      },
      lt() {
        calls.deletes += 1
        return Promise.resolve({ error: null })
      },
      then(resolve: (value: unknown) => void) {
        if (state.mode === "profiles-email") {
          const email = state.filterKey?.replace(/^email:/, "") ?? ""
          const exists = (options.knownEmails ?? []).some(
            (known) => known.toLowerCase() === email,
          )
          return resolve({ data: exists ? [{ id: "fake-id" }] : [], error: null })
        }

        if (state.mode === "canary") {
          return resolve({
            data: options.tableMissing ? null : [],
            error: options.tableMissing
              ? { message: 'relation "password_reset_attempts" does not exist' }
              : null,
          })
        }

        if (state.mode === "insert") {
          return resolve({ error: null })
        }

        // mode === "count": decide qué contador devolver según el filtro y
        // la ventana (hora vs día) que pidió el código real.
        const isHourWindow =
          state.since !== null &&
          Date.now() - Date.parse(state.since) <= 65 * 60 * 1000
        const isIdentifier = state.filterKey?.startsWith("identifier_hash:")
        const count = isIdentifier
          ? isHourWindow
            ? counts.identifierHour
            : counts.identifierDay
          : isHourWindow
            ? counts.ipHour
            : counts.ipDay

        return resolve({ count })
      },
    }

    return builder
  }

  const admin = {
    from: (table: string) => makeQuery(table),
    rpc: async (fn: string, args: unknown) => {
      calls.rpc.push({ fn, args })
      const username = (args as { username_input: string }).username_input
      const email = options.usernameEmails?.[username] ?? null
      return { data: email, error: null }
    },
    auth: {
      resetPasswordForEmail: async (email: string, opts: { redirectTo: string }) => {
        calls.resetPasswordForEmail.push({ email, redirectTo: opts.redirectTo })
        return { error: options.resetPasswordError ?? null }
      },
    },
  }

  return { admin: admin as unknown as Parameters<typeof requestPasswordRecovery>[0]["admin"], calls }
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

test("sin siteUrl resuelto (canónica no configurada): falla cerrado sin intentar enviar nada", async () => {
  const { admin, calls } = createFakeAdmin()

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "cliente@example.com",
    ip: "1.2.3.4",
    siteUrl: null,
  })

  assert.equal(result.ok, false)
  assert.equal(calls.resetPasswordForEmail.length, 0)
})

test("si la tabla de rate limit todavía no existe (migración pendiente): falla cerrado, NUNCA manda el email sin protección", async () => {
  const { admin, calls } = createFakeAdmin({ tableMissing: true })

  const result = await requestPasswordRecovery({
    admin,
    identifierRaw: "cliente@example.com",
    ip: "1.2.3.4",
    siteUrl: SITE_URL,
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 503)
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
