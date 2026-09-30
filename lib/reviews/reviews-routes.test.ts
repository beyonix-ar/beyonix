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
