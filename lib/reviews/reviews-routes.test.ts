import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient } from "@supabase/supabase-js"

// Rutas reales de reseñas con Supabase interceptado a nivel HTTP (PostgREST):
// Home pide solo destacadas, producto sigue igual, el comentario y el plazo
// se validan server-side antes de insertar, y solo admin/super_admin cambian
// `featured`.

type Row = Record<string, unknown>
type Handler = (url: URL, init: RequestInit | undefined) => Row[] | Row | null

const DAY = 24 * 60 * 60 * 1000
const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const

function reply(init: RequestInit | undefined, rows: Row[] | Row | null) {
  const accept = new Headers(init?.headers).get("accept") ?? ""
  if (accept.includes("vnd.pgrst.object")) {
    const row = Array.isArray(rows) ? rows[0] ?? null : rows
    return Response.json(row)
  }
  return Response.json(rows === null ? [] : Array.isArray(rows) ? rows : [rows])
}

async function withSupabase(handler: Handler, run: (requests: Array<{ method: string; url: URL; body: unknown }>) => Promise<void>) {
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://reviews-test.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const requests: Array<{ method: string; url: URL; body: unknown }> = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor", email: "admin@example.test" } }, error: null }))
  const getUser = mock.method(AuthClient.prototype, "getUser", async () => ({ data: { user: { id: "client-1", user_metadata: {} } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return reply(init, handler(url, init))
  })
  try {
    await run(requests)
  } finally {
    claims.mock.restore(); getUser.mock.restore(); fetchMock.mock.restore()
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]
    }
  }
}

const review = (id: number, featured: boolean) => ({
  id, user_id: "user-secret-uuid", rating: 5, comment: "Excelente producto",
  city: "Rosario", province: "Santa Fe", created_at: "2026-09-20T12:00:00Z", featured,
})

// Perfil real del autor: nombre completo en mayúsculas y username distinto.
const PROFILE = { id: "user-secret-uuid", nombre: "LUCAS ALBERTO Espinosa", username: "antares" }

test("E/F. Home: sólo experiencias (product_id null) aprobadas y destacadas, con primer nombre y sin datos de más", async () => {
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/profiles") {
      assert.equal(url.searchParams.get("select"), "id,nombre", "sólo el nombre del perfil")
      return [PROFILE]
    }
    if (url.pathname !== "/rest/v1/reviews") throw new Error(`consulta inesperada ${url.pathname}`)
    return url.searchParams.get("featured") ? [review(2, true)] : [{ rating: 5 }, { rating: 4 }, { rating: 3 }]
  }, async (requests) => {
    const { GET } = await import("../../app/api/reviews/route")
    const response = await GET(new Request("http://localhost/api/reviews"))
    assert.equal(response.status, 200)
    const payload = await response.json()

    const home = requests.find((request) => request.url.searchParams.get("featured"))
    assert.ok(home, "consulta de Home")
    assert.equal(home.url.searchParams.get("featured"), "eq.true")
    assert.equal(home.url.searchParams.get("approved"), "eq.true")
    assert.equal(home.url.searchParams.get("product_id"), "is.null", "reseñas de producto nunca en Home")
    assert.equal(home.url.searchParams.get("order"), "created_at.desc,id.desc")
    assert.equal(home.url.searchParams.get("limit"), "12")
    assert.doesNotMatch(home.url.searchParams.get("select") ?? "", /nickname|order_id|product_id/)

    assert.deepEqual(payload.reviews.map((item: { id: number }) => item.id), [2])
    assert.deepEqual(payload.summary, { count: 3, average: 4 })
    // Privacidad: sólo primer nombre, localidad, provincia, rating, comentario y fecha.
    assert.deepEqual(Object.keys(payload.reviews[0]).sort(), ["canDelete", "city", "comment", "createdAt", "id", "name", "province", "rating"])
    assert.equal(payload.reviews[0].name, "Lucas")
    const raw = JSON.stringify(payload)
    for (const secret of ["user-secret-uuid", "antares", "Espinosa", "ALBERTO", "user_id", "order_id", "nickname"]) {
      assert.equal(raw.includes(secret), false, `no expone ${secret}`)
    }
  })
})

// Mini PostgREST: aplica a un conjunto de filas los filtros eq/is que manda
// la ruta, para probar el RESULTADO de Home y no sólo los parámetros.
// Columnas de una tabla embebida (p. ej. `ordenes.test_order_at` del join
// interno con el pedido) se leen del objeto anidado; sin pedido explícito, la
// fila es de un pedido real (reviews.order_id es NOT NULL con FK).
function columnValue(row: Row, column: string) {
  if (!column.includes(".")) return row[column]
  const [table, field] = column.split(".")
  return ((row[table] as Row | undefined) ?? {})[field] ?? null
}

function applyPostgrestFilters(rows: Row[], url: URL) {
  return rows.filter((row) =>
    [...url.searchParams].every(([column, filter]) => {
      if (["select", "order", "limit", "offset"].includes(column)) return true
      if (filter === "is.null") return columnValue(row, column) === null
      if (filter.startsWith("eq.")) return String(columnValue(row, column)) === filter.slice(3)
      return true
    }),
  )
}

test("compras de prueba: Home, producto y promedio filtran en la consulta (sin ocupar lugares) y no exponen el pedido", async () => {
  const testOrder = { ordenes: { test_order_at: "2026-11-25T15:52:02Z" } }
  const dataset: Row[] = [
    { ...review(20, true), product_id: null, approved: true, ...testOrder, rating: 1 },
    { ...review(21, true), product_id: null, approved: true, rating: 5 },
    { ...review(22, false), product_id: 7, approved: true, ...testOrder, rating: 1 },
    { ...review(23, false), product_id: 7, approved: true, rating: 4 },
  ]
  for (const path of ["/api/reviews", "/api/reviews?productId=7"]) {
    await withSupabase((url) => {
      if (url.pathname === "/rest/v1/profiles") return [PROFILE]
      return applyPostgrestFilters(dataset, url)
    }, async (requests) => {
      const { GET } = await import("../../app/api/reviews/route")
      const payload = await (await GET(new Request(`http://localhost${path}`))).json()
      const reviewQueries = requests.filter((request) => request.url.pathname === "/rest/v1/reviews")
      assert.ok(reviewQueries.length > 0)
      for (const request of reviewQueries) {
        assert.match(request.url.searchParams.get("select") ?? "", /ordenes!inner\(test_order_at\)/, `${path}: join con el pedido`)
        assert.equal(request.url.searchParams.get("ordenes.test_order_at"), "is.null", `${path}: filtro en la consulta`)
      }
      if (path === "/api/reviews") {
        assert.deepEqual(payload.reviews.map((item: { id: number }) => item.id), [21])
        assert.deepEqual(payload.summary, { count: 1, average: 5 }, "el 1★ de la prueba no cuenta en el promedio")
      } else {
        assert.deepEqual(payload.reviews.map((item: { id: number }) => item.id), [23])
      }
      assert.equal(JSON.stringify(payload).includes("test_order_at"), false)
      assert.equal(JSON.stringify(payload).includes("ordenes"), false)
    })
  }
})

test("compras de prueba: no son reseñables y sus reseñas propias no se muestran en la compra", async () => {
  const recent = new Date(Date.now() - 3 * DAY).toISOString()
  const testOrder = { id: 19, localidad: "Rosario", provincia: "Santa Fe", estado: "entregado", payment_status: "approved", delivered_at: recent, created_at: recent, test_order_at: "2026-11-25T15:52:02Z" }
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/profiles") return { nombre: "LUCAS", username: "Lucas", direccion: "", codigo_postal: "2000", provincia: "Santa Fe" }
    if (url.pathname === "/rest/v1/ordenes") return applyPostgrestFilters([testOrder], url)
    if (url.pathname === "/rest/v1/reviews") {
      // Reseñas propias ya existentes de la compra de prueba.
      if (url.searchParams.get("order_id") === "eq.19") {
        return url.searchParams.get("product_id") === "is.null"
          ? { id: 70, order_id: 19, rating: 5, comment: "Prueba interna", created_at: recent }
          : [{ product_id: 22, rating: 5, comment: "Prueba interna" }]
      }
      return []
    }
    throw new Error(`consulta inesperada ${url.pathname}`)
  }, async (requests) => {
    const { GET, POST } = await import("../../app/api/reviews/route")
    for (const body of [{ orderId: 19, rating: 5, comment: "Excelente producto" }, { orderId: 19, productId: 22, rating: 5, comment: "Excelente producto" }]) {
      const response = await POST(post(body))
      assert.equal(response.status, 403, JSON.stringify(body))
    }
    assert.ok(!requests.some((request) => request.method === "POST"), "sin insert")
    const orderQueries = requests.filter((request) => request.url.pathname === "/rest/v1/ordenes")
    assert.ok(orderQueries.length > 0 && orderQueries.every((request) => request.url.searchParams.get("test_order_at") === "is.null"))

    const payload = await (await GET(new Request("http://localhost/api/reviews?orderId=19", { headers: { Authorization: "Bearer client" } }))).json()
    assert.equal(payload.eligibleReview, null, "sin 'pendiente de reseñar'")
    assert.deepEqual(payload.ownProductReviews, [])
    assert.equal(payload.ownExperienceReview, null)
    assert.equal(payload.reviewWindow, null)
  })
})

test("compras de prueba: si la base rechaza la reseña (REVIEW_TEST_ORDER), la API responde 403 sin error técnico", async () => {
  const recent = new Date(Date.now() - 3 * DAY).toISOString()
  const handler = eligibilityHandler(recent)
  const previous = globalThis.fetch
  await withSupabase((url) => handler(url), async () => {
    const mocked = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/rest/v1/reviews" && init?.method === "POST") {
        return Response.json({ code: "P0001", message: "REVIEW_TEST_ORDER", details: null, hint: null }, { status: 400 })
      }
      return mocked(input, init)
    }) as typeof fetch
    try {
      const { POST } = await import("../../app/api/reviews/route")
      const response = await POST(post({ orderId: 1, rating: 5, comment: "Excelente producto" }))
      assert.equal(response.status, 403)
      assert.equal((await response.json()).error, "No encontramos una compra verificada disponible para reseñar.")
    } finally {
      globalThis.fetch = mocked
    }
  })
  assert.equal(globalThis.fetch, previous)
})

test("Home: aparece la experiencia aprobada + destacada; ni la no destacada, ni la pendiente, ni una reseña de producto", async () => {
  const dataset: Row[] = [
    { ...review(10, true), product_id: null, approved: true },
    { ...review(11, false), product_id: null, approved: true },
    { ...review(12, true), product_id: 7, approved: true },
    { ...review(13, true), product_id: null, approved: false },
  ]
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/profiles") return [PROFILE]
    return applyPostgrestFilters(dataset, url).map((row) =>
      url.searchParams.get("select") === "rating" ? { rating: row.rating } : row,
    )
  }, async () => {
    const { GET } = await import("../../app/api/reviews/route")
    const payload = await (await GET(new Request("http://localhost/api/reviews"))).json()
    assert.deepEqual(payload.reviews.map((item: { id: number }) => item.id), [10])
    // El promedio considera todas las experiencias aprobadas (destacadas o no).
    assert.equal(payload.summary.count, 2)
  })
})

test("la página de producto sigue mostrando todas sus reseñas aprobadas (sin filtro de destacado), con primer nombre", async () => {
  await withSupabase((url) => (url.pathname === "/rest/v1/profiles" ? [PROFILE] : [review(3, false)]), async (requests) => {
    const { GET } = await import("../../app/api/reviews/route")
    const response = await GET(new Request("http://localhost/api/reviews?productId=5"))
    assert.equal(response.status, 200)
    const reviewsRequest = requests.find((request) => request.url.pathname === "/rest/v1/reviews")!
    assert.equal(reviewsRequest.url.searchParams.get("product_id"), "eq.5")
    assert.equal(reviewsRequest.url.searchParams.get("featured"), null)
    const payload = await response.json()
    assert.deepEqual(payload.reviews.map((item: { id: number; name: string }) => [item.id, item.name]), [[3, "Lucas"]])
    assert.equal(JSON.stringify(payload).includes("user-secret-uuid"), false)
  })
})

const post = (body: Row) => new Request("http://localhost/api/reviews", {
  method: "POST", headers: { Authorization: "Bearer client", "Content-Type": "application/json" }, body: JSON.stringify(body),
})

test("F/G/H/I. el POST rechaza comentario vacío, espacios o basura antes de tocar la base", async () => {
  await withSupabase(() => { throw new Error("no debería consultar la base") }, async (requests) => {
    const { POST } = await import("../../app/api/reviews/route")
    for (const comment of [undefined, "", "     ", "ok", "aaaaaaaaaaaa", "asdfasdfasdfasdf"]) {
      const response = await POST(post({ orderId: 1, rating: 5, comment }))
      assert.equal(response.status, 400, String(comment))
    }
    assert.equal(requests.length, 0)
  })
})

function eligibilityHandler(deliveredAt: string | null) {
  return (url: URL): Row[] | Row | null => {
    if (url.pathname === "/rest/v1/reviews") return []
    if (url.pathname === "/rest/v1/profiles") return { nombre: "LUCAS ALBERTO", username: "Lucas", direccion: "", codigo_postal: "2000", provincia: "Santa Fe" }
    if (url.pathname === "/rest/v1/ordenes") {
      return [{ id: 1, localidad: "Rosario", provincia: "Santa Fe", estado: "entregado", payment_status: "approved", delivered_at: deliveredAt, created_at: "2026-09-01T00:00:00Z" }]
    }
    throw new Error(`consulta inesperada ${url.pathname}`)
  }
}

test("E. día 16: el POST rechaza con 'El período para dejar una reseña finalizó.' y no inserta", async () => {
  const expired = new Date(Date.now() - 16 * DAY).toISOString()
  await withSupabase(eligibilityHandler(expired), async (requests) => {
    const { POST } = await import("../../app/api/reviews/route")
    const response = await POST(post({ orderId: 1, rating: 5, comment: "Excelente producto" }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, "El período para dejar una reseña finalizó.")
    assert.ok(!requests.some((request) => request.method === "POST"), "sin insert")
  })
})

test("D/J. dentro del plazo con comentario real: inserta sin featured ni datos del cliente", async () => {
  const recent = new Date(Date.now() - 3 * DAY).toISOString()
  const handler = eligibilityHandler(recent)
  await withSupabase((url, init) => {
    if (url.pathname === "/rest/v1/reviews" && init?.method === "POST") return { ...review(9, false), created_at: new Date().toISOString() }
    return handler(url)
  }, async (requests) => {
    const { POST } = await import("../../app/api/reviews/route")
    const response = await POST(post({ orderId: 1, rating: 5, comment: "  Todo bien,   llegó rápido  ", featured: true }))
    assert.equal(response.status, 201)
    assert.equal((await response.json()).review.name, "Lucas", "la respuesta pública usa el primer nombre")
    const insert = requests.find((request) => request.method === "POST")
    assert.ok(insert)
    const body = insert.body as Row
    assert.equal(body.comment, "Todo bien, llegó rápido")
    assert.equal("featured" in body, false, "el cliente no puede mandar featured")
    assert.deepEqual([body.nickname, body.city, body.province], ["Lucas", "Rosario", "Santa Fe"])
  })
})

const patch = (body: unknown) => new Request("http://localhost/api/admin/reviews", {
  method: "PATCH", headers: { Authorization: "Bearer actor", "Content-Type": "application/json" }, body: JSON.stringify(body),
})

test("L. cliente y operador no pueden destacar reseñas", async () => {
  for (const rol of ["cliente", "operador"]) {
    await withSupabase((url) => {
      if (url.pathname === "/rest/v1/profiles") return { id: "actor", email: "x@example.test", rol }
      throw new Error(`no debería acceder a ${url.pathname}`)
    }, async (requests) => {
      const { PATCH, GET } = await import("../../app/api/admin/reviews/route")
      assert.equal((await PATCH(patch({ id: 1, featured: true }))).status, 403, rol)
      assert.equal((await GET(new Request("http://localhost/api/admin/reviews", { headers: { Authorization: "Bearer actor" } }))).status, 403, rol)
      assert.ok(requests.every((request) => request.url.pathname === "/rest/v1/profiles"))
    })
  }
})

test("M. admin destaca y quita de Home, con registro de auditoría", async () => {
  for (const rol of ["admin", "super_admin"]) {
    for (const featured of [true, false]) {
      await withSupabase((url, init) => {
        if (url.pathname === "/rest/v1/profiles") return { id: "actor", email: "admin@example.test", rol }
        if (url.pathname === "/rest/v1/reviews" && init?.method === "PATCH") {
          return { id: 1, featured, featured_at: featured ? "2026-09-30T12:00:00Z" : null }
        }
        if (url.pathname === "/rest/v1/reviews") {
          return { id: 1, approved: true, comment: "Excelente producto", featured: !featured, featured_at: null }
        }
        if (url.pathname === "/rest/v1/audit_logs") return null
        throw new Error(`consulta inesperada ${url.pathname}`)
      }, async (requests) => {
        const { PATCH } = await import("../../app/api/admin/reviews/route")
        const response = await PATCH(patch({ id: 1, featured }))
        assert.equal(response.status, 200, `${rol} ${featured}`)
        assert.equal((await response.json()).review.featured, featured)
        const update = requests.find((request) => request.method === "PATCH")
        assert.deepEqual(update?.body, { featured })
        assert.equal(update?.url.searchParams.get("id"), "eq.1")
        assert.ok(requests.some((request) => request.url.pathname === "/rest/v1/audit_logs"))
      })
    }
  }
})

test("M. no se destaca una reseña sin comentario ni con datos inválidos", async () => {
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/profiles") return { id: "actor", email: "admin@example.test", rol: "admin" }
    if (url.pathname === "/rest/v1/reviews") return { id: 1, approved: true, comment: "", featured: false, featured_at: null }
    throw new Error(`consulta inesperada ${url.pathname}`)
  }, async (requests) => {
    const { PATCH } = await import("../../app/api/admin/reviews/route")
    const response = await PATCH(patch({ id: 1, featured: true }))
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /con comentario/)
    assert.equal((await PATCH(patch({ id: 1, featured: "true" }))).status, 400)
    assert.equal((await PATCH(patch({ id: -1, featured: true }))).status, 400)
    assert.ok(!requests.some((request) => request.method === "PATCH"))
  })
})

const adminProfile = { id: "actor", email: "admin@example.test", rol: "admin" }

test("D. experiencia general (product_id null): el Admin la destaca", async () => {
  await withSupabase((url, init) => {
    if (url.pathname === "/rest/v1/profiles") return adminProfile
    if (url.pathname === "/rest/v1/reviews" && init?.method === "PATCH") return { id: 6, featured: true, featured_at: "2026-09-30T12:00:00Z" }
    if (url.pathname === "/rest/v1/reviews") {
      assert.match(url.searchParams.get("select") ?? "", /product_id/, "el Admin lee el tipo de reseña")
      return { id: 6, product_id: null, approved: true, comment: "Excelente atención", featured: false, featured_at: null }
    }
    if (url.pathname === "/rest/v1/audit_logs") return null
    throw new Error(`consulta inesperada ${url.pathname}`)
  }, async () => {
    const { PATCH } = await import("../../app/api/admin/reviews/route")
    const response = await PATCH(patch({ id: 6, featured: true }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).review.featured, true)
  })
})

test("E/F. reseña de producto: el backend rechaza featured=true aunque el pedido llegue directo (sin botón); quitar sí", async () => {
  for (const featured of [true, false]) {
    await withSupabase((url, init) => {
      if (url.pathname === "/rest/v1/profiles") return adminProfile
      if (url.pathname === "/rest/v1/reviews" && init?.method === "PATCH") return { id: 5, featured: false, featured_at: null }
      if (url.pathname === "/rest/v1/reviews") return { id: 5, product_id: 1, approved: true, comment: "Muy buen producto", featured: !featured, featured_at: null }
      if (url.pathname === "/rest/v1/audit_logs") return null
      throw new Error(`consulta inesperada ${url.pathname}`)
    }, async (requests) => {
      const { PATCH } = await import("../../app/api/admin/reviews/route")
      const response = await PATCH(patch({ id: 5, featured }))
      if (featured) {
        assert.equal(response.status, 400)
        assert.equal((await response.json()).error, "Las reseñas de producto no se muestran en Home: solo se destacan experiencias de compra.")
        assert.ok(!requests.some((request) => request.method === "PATCH"), "no intenta el update")
      } else {
        assert.equal(response.status, 200, "quitar de Home siempre se permite")
      }
    })
  }
})

test("F. si la base rechaza (REVIEW_FEATURED_EXPERIENCE_ONLY), la API responde 400 con el mismo mensaje", async () => {
  await withSupabase((url, init) => {
    if (url.pathname === "/rest/v1/profiles") return adminProfile
    // Lectura previa: la reseña figura como experiencia (el tipo cambió entre
    // la lectura y el update; el trigger es la última barrera).
    if (url.pathname === "/rest/v1/reviews" && init?.method !== "PATCH") return { id: 6, product_id: null, approved: true, comment: "Excelente atención", featured: false, featured_at: null }
    throw new Error(`consulta inesperada ${url.pathname}`)
  }, async () => {
    // El update responde como PostgREST cuando el trigger rechaza: 400 con el
    // mensaje de la excepción.
    const fetchMock = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return Response.json({ code: "23514", message: "REVIEW_FEATURED_EXPERIENCE_ONLY" }, { status: 400 })
      }
      return fetchMock(input, init)
    }) as typeof fetch
    try {
      const { PATCH } = await import("../../app/api/admin/reviews/route")
      const response = await PATCH(patch({ id: 6, featured: true }))
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /solo se destacan experiencias de compra/)
    } finally {
      globalThis.fetch = fetchMock
    }
  })
})

test("FAIL-CLOSED: si no se puede verificar la compra, error controlado y ninguna reseña asociada (500, error de consulta y red)", async () => {
  const recent = new Date(Date.now() - 3 * DAY).toISOString()
  const ownReviews = (url: URL) => url.searchParams.get("product_id") === "is.null"
    ? { id: 70, order_id: 1, rating: 5, comment: "Reseña histórica", created_at: recent }
    : [{ product_id: 22, rating: 5, comment: "Reseña histórica" }]
  const failures: Array<[string, () => Response]> = [
    ["HTTP 500", () => new Response("upstream error", { status: 500 })],
    ["error de consulta", () => Response.json({ code: "42703", message: "column does not exist", details: null, hint: null }, { status: 400 })],
    ["red", () => { throw new TypeError("fetch failed") }],
  ]
  for (const [label, failure] of failures) {
    await withSupabase((url) => {
      if (url.pathname === "/rest/v1/reviews") return url.searchParams.get("order_id") === "eq.1" ? ownReviews(url) : []
      if (url.pathname === "/rest/v1/profiles") return { rol: "cliente", nombre: "LUCAS", username: "Lucas", direccion: "", codigo_postal: "2000", provincia: "Santa Fe" }
      return []
    }, async (requests) => {
      const mocked = globalThis.fetch
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        // Sólo falla la verificación de la compra (consulta a ordenes por id).
        if (url.pathname === "/rest/v1/ordenes" && url.searchParams.get("id") === "eq.1") return failure()
        return mocked(input, init)
      }) as typeof fetch
      try {
        const errors = mock.method(console, "error", () => {})
        const { GET } = await import("../../app/api/reviews/route")
        const response = await GET(new Request("http://localhost/api/reviews?orderId=1", { headers: { Authorization: "Bearer client" } }))
        errors.mock.restore()
        assert.equal(response.status, 503, label)
        const raw = await response.text()
        assert.deepEqual(JSON.parse(raw), { error: "No pudimos cargar las reseñas de esta compra." }, label)
        assert.equal(raw.includes("Reseña histórica"), false, `${label}: no revela reseñas`)
        assert.equal(/column|upstream|fetch failed/.test(raw), false, `${label}: sin error técnico`)
        assert.ok(!requests.some((request) => request.url.pathname === "/rest/v1/reviews" && request.url.searchParams.get("order_id") === "eq.1"),
          `${label}: ni siquiera se consultan las reseñas de esa compra`)
      } finally {
        globalThis.fetch = mocked
      }
    })
  }
})

test("compra legítima verificada: devuelve sus reseñas propias y el plazo como siempre", async () => {
  const recent = new Date(Date.now() - 3 * DAY).toISOString()
  await withSupabase((url) => {
    if (url.pathname === "/rest/v1/ordenes") return applyPostgrestFilters([{ id: 1, estado: "entregado", delivered_at: recent, usuario_id: "client-1", localidad: "Rosario", provincia: "Santa Fe", payment_status: "approved", created_at: recent, test_order_at: null }], url)
    if (url.pathname === "/rest/v1/reviews") {
      if (url.searchParams.get("order_id") !== "eq.1") return []
      return url.searchParams.get("product_id") === "is.null"
        ? { id: 70, order_id: 1, rating: 5, comment: "Llegó perfecto", created_at: recent }
        : [{ product_id: 22, rating: 4, comment: "Muy bueno" }]
    }
    if (url.pathname === "/rest/v1/profiles") return { rol: "cliente", nombre: "LUCAS", username: "Lucas", direccion: "", codigo_postal: "2000", provincia: "Santa Fe" }
    return []
  }, async () => {
    const { GET } = await import("../../app/api/reviews/route")
    const response = await GET(new Request("http://localhost/api/reviews?orderId=1", { headers: { Authorization: "Bearer client" } }))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.ownProductReviews, [{ product_id: 22, rating: 4, comment: "Muy bueno" }])
    assert.equal(payload.ownExperienceReview.comment, "Llegó perfecto")
    assert.equal(payload.reviewWindow.status, "open")
  })
})
