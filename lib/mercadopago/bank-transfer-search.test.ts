import assert from "node:assert/strict"
import test from "node:test"

import {
  isSupportedBankTransferKind,
  searchIncomingBankTransfers,
} from "./bank-transfer-search.ts"

const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN
const originalFetch = globalThis.fetch

test.before(() => {
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-secret-token-never-logged"
})
test.after(() => {
  if (originalToken === undefined) delete process.env.MERCADOPAGO_ACCESS_TOKEN
  else process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function fullPagePayment(id: number) {
  return {
    id,
    status: "approved",
    operation_type: "money_transfer",
    payment_method_id: "account_money",
    transaction_amount: 900,
    currency_id: "ARS",
    date_created: "2026-09-13T18:17:43.000-04:00",
    date_approved: "2026-09-13T18:17:43.000-04:00",
    payer: { identification: { type: "CUIL", number: "20301112220" } },
    transaction_details: { bank_transfer_id: null },
  }
}

test("isSupportedBankTransferKind sólo admite los dos tipos comprobados contra la cuenta real", () => {
  assert.equal(isSupportedBankTransferKind("account_fund", "cvu"), true)
  assert.equal(isSupportedBankTransferKind("money_transfer", "account_money"), true)
  assert.equal(isSupportedBankTransferKind("regular_payment", "account_money"), false)
  assert.equal(isSupportedBankTransferKind("money_transfer", "visa"), false)
  assert.equal(isSupportedBankTransferKind(null, null), false)
})

test("nunca busca indefinidamente: se frena en el tope defensivo de páginas (40 x 50 = 2000) si Mercado Pago siempre devuelve páginas llenas, y marca exhaustive=false", async () => {
  let calls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    // Siempre devuelve una página LLENA (50), simulando una cuenta con
    // decenas de miles de movimientos -- si no hubiera tope, esto nunca
    // terminaría.
    const results = Array.from({ length: 50 }, (_, i) => fullPagePayment(offset + i + 1))
    return jsonResponse({ results, paging: { total: 100_000, offset, limit: 50 } })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 40, "debe frenar en el tope de páginas, nunca seguir indefinidamente")
  assert.equal(result.candidates.length, 2000)
  assert.equal(
    result.exhaustive,
    false,
    "se cortó por el tope sin poder demostrar que se cubrió toda la ventana -- nunca se puede auto-confirmar con esto",
  )
})

test("un candidato válido en una página MÁS ALLÁ del viejo tope de 4 páginas (200 movimientos) igual se encuentra, y exhaustive queda en true", async () => {
  let calls = 0
  const TARGET_PAGE = 7 // página 8 (offset 350): antes del fix esto NUNCA se recorría.
  // total=351 (7 páginas llenas de 50 + 1 resultado en la última): consistente
  // con lo que realmente se va a traer, para que offset+resultados alcance a
  // total exactamente en la última página -- nunca antes.
  const TOTAL = 7 * 50 + 1
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    const page = offset / 50

    if (page < TARGET_PAGE) {
      // Páginas previas: llenas, pero de movimientos irrelevantes (otro monto).
      const results = Array.from({ length: 50 }, (_, i) => ({
        ...fullPagePayment(offset + i + 1),
        transaction_amount: 111,
      }))
      return jsonResponse({ results, paging: { total: TOTAL, offset, limit: 50 } })
    }

    // Última página (parcial): acá está el candidato real, con el monto buscado.
    return jsonResponse({
      results: [fullPagePayment(offset + 1)],
      paging: { total: TOTAL, offset, limit: 50 },
    })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, TARGET_PAGE + 1)
  assert.equal(result.exhaustive, true)
  const relevant = result.candidates.filter((c) => c.transactionAmount === 900)
  assert.equal(relevant.length, 1, "el candidato de la página 8 debe encontrarse, no sólo los de las primeras 4 páginas")
})

test("BUG CODEX: 1 resultado devuelto + paging.total=100 -- una página corta NUNCA puede darse por exhaustiva si total indica que falta más", async () => {
  let calls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    // Cada página devuelve 1 solo resultado (mucho menos que el límite de
    // 50), pero paging.total=100 dice que faltan muchísimos más -- antes del
    // fix, la sola brevedad de la página ya marcaba exhaustive=true acá
    // mismo, en la primera vuelta, habilitando una auto-confirmación sin
    // haber recorrido casi nada.
    return jsonResponse({
      results: [fullPagePayment(offset + 1)],
      paging: { total: 100, offset, limit: 50 },
    })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(
    result.exhaustive,
    false,
    "total nunca se demuestra cubierto (offset+resultados siempre queda muy por debajo de 100): jamás puede quedar exhaustive=true",
  )
  assert.equal(calls, 40, "sin poder demostrar cobertura, sigue paginando hasta el tope defensivo")
})

test("total inconsistente con lo realmente recibido en TODAS las páginas (nunca llega a demostrar cobertura, ni siquiera agotando el tope) -> exhaustive=false", async () => {
  let calls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    // paging.total=50 en TODAS las páginas, pero cada una sólo trae 1
    // resultado real: la cantidad acumulada de resultados jamás alcanza los
    // 50 que "total" promete, ni siquiera después de agotar las 40 páginas
    // -- nunca hay evidencia real de haber cubierto el conjunto completo.
    return jsonResponse({
      results: [fullPagePayment(offset + 1)],
      paging: { total: 50, offset, limit: 50 },
    })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(result.exhaustive, false)
  assert.equal(calls, 40)
})

// Tercera auditoría (Codex): 3 casos exactos reproducidos contra la versión
// anterior de este algoritmo, todos con el mismo resultado incorrecto
// (exhaustive=true) por la misma causa raíz -- una vez que se depende de
// paging.total, cualquier página posterior que lo omita, lo cambie de forma
// incompatible o lo mande inválido tiene que tratarse como inconsistencia,
// nunca como "sin evidencia = ok".
test("CODEX CASO 1: página 1 con total=100, página 2 vacía SIN total -- exhaustive=false (antes daba true)", async () => {
  let call = 0
  globalThis.fetch = (async () => {
    call += 1
    if (call === 1) {
      return jsonResponse({
        results: [fullPagePayment(1)],
        paging: { total: 100, offset: 0, limit: 50 },
      })
    }
    // Página 2: vacía, sin campo paging.total en absoluto.
    return jsonResponse({ results: [] })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(
    result.exhaustive,
    false,
    "ya se había fijado total=100 en la página 1 -- que la página 2 lo omita es una inconsistencia, no evidencia de fin",
  )
})

test("CODEX CASO 2: página 1 con total=100, página 2 vacía con total=0 -- exhaustive=false (antes daba true)", async () => {
  let call = 0
  globalThis.fetch = (async () => {
    call += 1
    if (call === 1) {
      return jsonResponse({
        results: [fullPagePayment(1)],
        paging: { total: 100, offset: 0, limit: 50 },
      })
    }
    return jsonResponse({ results: [], paging: { total: 0, offset: 50, limit: 50 } })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(
    result.exhaustive,
    false,
    "total cambió de 100 a 0 de forma incompatible -- nunca se puede confiar en él para concluir cobertura",
  )
})

test("CODEX CASO 3: paging.total=-1 (inválido) -- exhaustive=false (antes daba true si la página venía corta)", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      results: [fullPagePayment(1)],
      paging: { total: -1, offset: 0, limit: 50 },
    })) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(
    result.exhaustive,
    false,
    "un total negativo es un dato malformado -- nunca se trata como 'ausente' ni habilita el atajo de página corta",
  )
})

test("un total válido en la primera página que luego se repite EXACTO en todas las siguientes sigue permitiendo exhaustive=true (no cualquier total posterior cuenta como inconsistencia, sólo uno que contradiga)", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    if (offset === 0) {
      return jsonResponse({
        results: Array.from({ length: 50 }, (_, i) => fullPagePayment(i + 1)),
        paging: { total: 51, offset: 0, limit: 50 },
      })
    }
    return jsonResponse({
      results: [fullPagePayment(51)],
      paging: { total: 51, offset, limit: 50 },
    })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(result.exhaustive, true)
  assert.equal(result.candidates.length, 51)
})

// Cuarta auditoría (Codex): la cobertura tiene que basarse en payment.id
// ÚNICOS, no en la cantidad bruta de resultados recibidos. Los 4 casos de
// abajo son los reproducidos exactamente contra la versión anterior.
test("CODEX #1: 1 resultado y total=0 -- inconsistencia inmediata (total dice 'nada' pero llegó un resultado real) -> exhaustive=false", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      results: [fullPagePayment(1)],
      paging: { total: 0, offset: 0, limit: 50 },
    })) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(result.exhaustive, false)
})

test("CODEX #2: 2 resultados y total=1 -- inconsistencia inmediata (total ya queda por debajo de lo recibido en la MISMA página) -> exhaustive=false", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      results: [fullPagePayment(1), fullPagePayment(2)],
      paging: { total: 1, offset: 0, limit: 50 },
    })) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(result.exhaustive, false)
})

test("CODEX #3: total aparece recién en la página 2 y contradice la cantidad de payment.id únicos ya recibidos en la página 1 -> exhaustive=false", async () => {
  let call = 0
  globalThis.fetch = (async () => {
    call += 1
    if (call === 1) {
      // Página 1: LLENA (50 payment.id distintos), SIN total todavía --
      // tiene que venir llena para que la búsqueda siga a la página 2 en vez
      // de darse por terminada acá mismo por el atajo de "página corta sin
      // total nunca visto" (esa es una situación distinta, ya cubierta por
      // otro test).
      return jsonResponse({
        results: Array.from({ length: 50 }, (_, i) => fullPagePayment(i + 1)),
      })
    }
    // Página 2: total aparece recién acá diciendo "2" -- muy por debajo de
    // los 50 payment.id únicos que ya se habían recibido antes.
    return jsonResponse({ results: [], paging: { total: 2, offset: 50, limit: 50 } })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(result.exhaustive, false)
})

test("CODEX #4: 100 resultados brutos pero sólo 50 payment.id ÚNICOS, con total=100 -- los duplicados nunca cuentan como cobertura adicional -> exhaustive=false", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    // Cada página de 50 resultados repite los MISMOS 50 payment.id
    // (overlap de paginación de Mercado Pago) -- nunca hay más de 50
    // distintos en total, pero MP informa total=100 (contando duplicados).
    const results = Array.from({ length: 50 }, (_, i) => fullPagePayment(i + 1))
    return jsonResponse({ results, paging: { total: 100, offset, limit: 50 } })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(
    result.exhaustive,
    false,
    "sólo hay 50 payment.id únicos -- nunca puede demostrarse que se cubrieron los 100 que dice total",
  )
})

test("última página real SIN paging.total (respuesta no lo informa): la única señal disponible es el tamaño de página, y sigue siendo válida", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse({
      results: [fullPagePayment(1)],
      // Sin campo paging.total en absoluto.
    })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 1)
  assert.equal(result.exhaustive, true)
})

test("una página parcial (menos de 50 resultados) corta la paginación antes de llegar al tope, y exhaustive queda en true", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse({
      results: [fullPagePayment(1), fullPagePayment(2)],
      paging: { total: 2, offset: 0, limit: 50 },
    })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 1)
  assert.equal(result.candidates.length, 2)
  assert.equal(result.exhaustive, true)
})

test("paging.total confirma cobertura completa incluso si la última página vino llena (evita una página final vacía)", async () => {
  let calls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    const results = Array.from({ length: 50 }, (_, i) => fullPagePayment(offset + i + 1))
    // paging.total=50: la única página que existe vino exactamente llena.
    return jsonResponse({ results, paging: { total: 50, offset, limit: 50 } })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 1, "paging.total ya confirma que no hay más: no debe pedir una segunda página vacía")
  assert.equal(result.exhaustive, true)
})

test("filtra en backend: nunca incluye movimientos no aprobados ni tipos no soportados", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      results: [
        { ...fullPagePayment(1), status: "pending" },
        { ...fullPagePayment(2), operation_type: "regular_payment", payment_method_id: "visa" },
        fullPagePayment(3),
      ],
      paging: { total: 3, offset: 0, limit: 50 },
    })) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].id, "3")
})

test("rechaza una ventana de búsqueda invertida o demasiado amplia (nunca busca indefinidamente todo el historial)", async () => {
  await assert.rejects(
    searchIncomingBankTransfers({
      beginDate: new Date("2026-09-14T00:00:00.000Z"),
      endDate: new Date("2026-09-01T00:00:00.000Z"),
    }),
    /Ventana de búsqueda inválida/,
  )

  await assert.rejects(
    searchIncomingBankTransfers({
      beginDate: new Date("2020-01-01T00:00:00.000Z"),
      endDate: new Date("2026-09-14T00:00:00.000Z"),
    }),
    /Ventana de búsqueda demasiado amplia/,
  )
})

test("nunca envía el access token en la URL, sólo en el header Authorization", async () => {
  let capturedUrl = ""
  let capturedAuth: string | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedAuth = new Headers(init?.headers).get("authorization")
    return jsonResponse({ results: [], paging: { total: 0, offset: 0, limit: 50 } })
  }) as typeof fetch

  await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.doesNotMatch(capturedUrl, /TEST-secret-token/)
  assert.equal(capturedAuth, "Bearer TEST-secret-token-never-logged")
})

test("BUDGET ESTRICTO (clock simulado): el timeout de cada request nunca excede el presupuesto restante, y la búsqueda aborta apenas se agota -- nunca sigue de largo", async () => {
  const originalNow = Date.now
  const originalAbortTimeout = AbortSignal.timeout
  let fakeNow = 1_700_000_000_000
  Date.now = () => fakeNow

  const capturedTimeouts: number[] = []
  // AbortSignal.timeout real dispararía de verdad con el clock real -- lo
  // reemplazamos por un spy que registra el ms pedido pero devuelve una señal
  // que jamás se dispara sola durante el test (los fetches mockeados abajo
  // nunca esperan un timeout real, así que un valor grande es inofensivo).
  AbortSignal.timeout = ((ms: number) => {
    capturedTimeouts.push(ms)
    return originalAbortTimeout(2_000_000_000)
  }) as typeof AbortSignal.timeout

  let calls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    // Cada request "tarda" 9s de reloj simulado.
    fakeNow += 9_000
    return jsonResponse({
      results: [fullPagePayment(offset + 1)],
      paging: { total: 100_000, offset, limit: 50 },
    })
  }) as typeof fetch

  try {
    const result = await searchIncomingBankTransfers({
      beginDate: new Date("2026-09-01T00:00:00.000Z"),
      endDate: new Date("2026-09-14T00:00:00.000Z"),
    })

    // SEARCH_TIME_BUDGET_MS=20000, PAGE_FETCH_TIMEOUT_MS=8000, cada request
    // "tarda" 9000ms de reloj:
    //  page0: restante=20000 -> timeout=min(8000,20000)=8000. tras la request, transcurrido=9000.
    //  page1: restante=20000-9000=11000 -> timeout=min(8000,11000)=8000. transcurrido=18000.
    //  page2: restante=20000-18000=2000 -> timeout=min(8000,2000)=2000 (recortado, nunca 8000 completos). transcurrido=27000.
    //  page3: restante=20000-27000<=0 -> aborta ANTES de arrancar otra request.
    assert.deepEqual(capturedTimeouts, [8000, 8000, 2000])
    assert.equal(calls, 3, "nunca arranca una cuarta request con el presupuesto ya agotado")
    assert.equal(
      result.exhaustive,
      false,
      "se cortó por presupuesto de tiempo, nunca demostró cobertura completa",
    )
  } finally {
    Date.now = originalNow
    AbortSignal.timeout = originalAbortTimeout
  }
})
