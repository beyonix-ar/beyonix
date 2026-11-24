import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { AuthClient, createClient } from "@supabase/supabase-js"

// API de banners (Admin y pública) contra Supabase simulado por fetch:
// permisos reales de Admin/Super Admin, validación de imágenes (firma real),
// enlaces y fechas en el servidor, PATCH que conserva lo no enviado, y la
// lectura pública (Home sin campañas futuras; Productos con su contrato y el
// respaldo heredado sólo cuando nunca tuvo banners propios).

type Call = { method: string; path: string; body: unknown; filters: Record<string, string> }
type Responder = (call: Call) => Response | undefined

const SUPABASE = "https://banners-routes.invalid"
const BUCKET = `${SUPABASE}/storage/v1/object/public/site-banners/`
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const ID = "20000000-0000-4000-8000-000000000001"

const row = (overrides: Record<string, unknown> = {}) => ({
  id: ID, placement: "home", campaign_name: "Navidad", image_url: `${BUCKET}home/navidad.jpg`, mobile_image_url: `${BUCKET}home/mobile/navidad.jpg`,
  alt_text: "Navidad BEYONIX", active: true, sort_order: 0, starts_at: "2026-12-20T12:00:00.000Z", ends_at: "2026-12-27T03:00:00.000Z",
  destination_url: "/productos", created_at: "2026-11-23T12:00:00.000Z", updated_at: "2026-11-23T12:00:00.000Z", ...overrides,
})

async function withSupabase(role: string, run: (calls: Call[]) => Promise<void>, responder?: Responder, files: Record<string, Uint8Array> = {}) {
  const previousEnv = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service"
  const calls: Call[] = []
  const claims = mock.method(AuthClient.prototype, "getClaims", async () => ({ data: { claims: { sub: "actor", email: "admin@example.test" } }, error: null }))
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const rawBody = init?.body
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) as unknown : null
    const call = { method: init?.method ?? "GET", path: url.pathname, body, filters: Object.fromEntries([...url.searchParams].filter(([name]) => name !== "select")) }
    calls.push(call)
    const custom = responder?.(call)
    if (custom) return custom
    if (call.path === "/rest/v1/profiles") return Response.json({ id: "actor", email: "admin@example.test", rol: role })
    if (call.path.startsWith("/storage/v1/object/site-banners/")) {
      const file = files[decodeURIComponent(call.path.replace("/storage/v1/object/site-banners/", ""))]
      return file ? new Response(file, { headers: { "Content-Type": "application/octet-stream" } }) : Response.json({ message: "not found" }, { status: 404 })
    }
    if (call.path === "/rest/v1/site_banner_items" && call.method === "POST") return Response.json({ id: ID, created_at: "2026-11-23T12:00:00.000Z", updated_at: "2026-11-23T12:00:00.000Z", ...(body as object) }, { status: 201 })
    // UPDATE condicionado: sólo afecta la fila si su versión (updated_at) es la esperada.
    if (call.path === "/rest/v1/site_banner_items" && call.method === "PATCH") {
      return Response.json(call.filters.updated_at === `eq.${row().updated_at}` ? [{ ...row(), ...(body as object) }] : [])
    }
    if (call.path === "/rest/v1/site_banner_items" && call.method === "GET") return Response.json(row())
    if (call.path === "/rest/v1/audit_logs") return new Response(null, { status: 201 })
    return Response.json([])
  })
  try {
    await run(calls)
  } finally {
    claims.mock.restore(); fetchMock.mock.restore()
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
  }
}

const adminRequest = (method: string, body?: unknown, query = "") => new Request(`http://localhost/api/admin/banners${query}`, {
  method,
  headers: { Authorization: "Bearer token", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const writes = (calls: Call[]) => calls.filter((call) => call.path === "/rest/v1/site_banner_items" && call.method !== "GET")
const downloads = (calls: Call[]) => calls.filter((call) => call.path.startsWith("/storage/v1/object/site-banners/")).map((call) => decodeURIComponent(call.path.replace("/storage/v1/object/site-banners/", "")))
const NEW_HOME = {
  placement: "home", campaign_name: "  Navidad 2026  ", image_url: `${BUCKET}home/navidad.jpg`, mobile_image_url: `${BUCKET}home/mobile/navidad.jpg`,
  alt_text: "", active: true, sort_order: "2", starts_at: "2026-12-20T12:00:00.000Z", ends_at: "2026-12-27T03:00:00.000Z", destination_url: " /productos?categoria=audio ",
}
const FILES = { "home/navidad.jpg": JPEG, "home/mobile/navidad.jpg": JPEG }
const VERSION = row().updated_at
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]) // "GIF89a" + tamaño

test("Admin crea una campaña del Home: normaliza, valida las dos imágenes por su firma real y audita", async () => {
  const { POST } = await import("../../app/api/admin/banners/route")
  for (const role of ["admin", "super_admin"]) {
    await withSupabase(role, async (calls) => {
      const response = await POST(adminRequest("POST", NEW_HOME))
      assert.equal(response.status, 200, role)
      const insert = writes(calls)[0]?.body as Record<string, unknown>
      assert.deepEqual({ ...insert, updated_at: undefined }, {
        placement: "home", campaign_name: "Navidad 2026", image_url: NEW_HOME.image_url, mobile_image_url: NEW_HOME.mobile_image_url,
        alt_text: "Campaña BEYONIX", active: true, sort_order: 2, starts_at: NEW_HOME.starts_at, ends_at: NEW_HOME.ends_at,
        destination_url: "/productos?categoria=audio", created_by: "actor", updated_by: "actor", updated_at: undefined,
      })
      assert.deepEqual(downloads(calls).sort(), ["home/mobile/navidad.jpg", "home/navidad.jpg"])
      assert.ok(calls.some((call) => call.path === "/rest/v1/audit_logs" && (call.body as { action?: string }).action === "INSERT"))
    }, undefined, FILES)
  }
})

test("Admin rechaza en el servidor: imagen externa o con otra firma, enlace peligroso, fechas invertidas, sin nombre", async () => {
  const { POST } = await import("../../app/api/admin/banners/route")
  const cases: Array<[Record<string, unknown>, RegExp, Record<string, Uint8Array>?]> = [
    [{ image_url: "https://img.example/navidad.jpg" }, /se suben desde este panel/],
    [{ mobile_image_url: "https://img.example/m.jpg" }, /Imagen para celular/],
    [{}, /no es una imagen admitida/, { ...FILES, "home/navidad.jpg": SVG }],
    [{}, /No encontramos la imagen/, { "home/mobile/navidad.jpg": JPEG }],
    [{ destination_url: "javascript:alert(1)" }, /enlace/i],
    [{ destination_url: "data:text/html,hola" }, /enlace/i],
    [{ destination_url: "https://evil.example/" }, /Dominio externo no admitido/],
    [{ destination_url: "//evil.example" }, /no es válido/],
    [{ ends_at: NEW_HOME.starts_at }, /posterior a la de inicio/],
    [{ starts_at: "mañana" }, /fecha u hora no es válida/],
    [{ campaign_name: "   " }, /nombre de la campaña/],
    [{ placement: "checkout" }, /Ubicación de banner inválida/],
  ]
  for (const [overrides, expected, files] of cases) {
    await withSupabase("admin", async (calls) => {
      const response = await POST(adminRequest("POST", { ...NEW_HOME, ...overrides }))
      assert.equal(response.status, 400, JSON.stringify(overrides))
      assert.match((await response.json() as { error: string }).error, expected)
      assert.deepEqual(writes(calls), [], "no escribe nada")
    }, undefined, files ?? FILES)
  }
})

test("permisos reales: operador, cliente o sin sesión no administran banners", async () => {
  const route = await import("../../app/api/admin/banners/route")
  for (const role of ["operador", "cliente"]) {
    await withSupabase(role, async (calls) => {
      assert.equal((await route.POST(adminRequest("POST", NEW_HOME))).status, 403, role)
      assert.equal((await route.PATCH(adminRequest("PATCH", { id: ID, active: false, expected_updated_at: VERSION }))).status, 403)
      assert.equal((await route.DELETE(adminRequest("DELETE", undefined, `?${new URLSearchParams({ id: ID, expected_updated_at: VERSION })}`))).status, 403)
      assert.equal((await route.GET(adminRequest("GET", undefined, "?placement=home"))).status, 403)
      assert.deepEqual(writes(calls), [])
    }, undefined, FILES)
  }
  await withSupabase("admin", async () => {
    const response = await route.POST(new Request("http://localhost/api/admin/banners", { method: "POST", body: JSON.stringify(NEW_HOME) }))
    assert.equal(response.status, 401)
  })
})

test("activar/desactivar desde la lista conserva fechas, destino e imágenes (sin volver a descargarlas)", async () => {
  const { PATCH } = await import("../../app/api/admin/banners/route")
  await withSupabase("admin", async (calls) => {
    const response = await PATCH(adminRequest("PATCH", { id: ID, active: false, expected_updated_at: VERSION }))
    assert.equal(response.status, 200)
    const update = writes(calls)[0]?.body as Record<string, unknown>
    assert.deepEqual([update.active, update.starts_at, update.ends_at, update.destination_url, update.mobile_image_url, update.campaign_name, update.sort_order],
      [false, row().starts_at, row().ends_at, "/productos", row().mobile_image_url, "Navidad", 0])
    assert.deepEqual(downloads(calls), [], "las imágenes no cambiaron")
    assert.deepEqual(writes(calls)[0]?.filters, { id: `eq.${ID}`, updated_at: `eq.${VERSION}` }, "UPDATE condicionado a la versión vista")
  })
  // Cambiar sólo la imagen de escritorio vuelve a validar ésa.
  await withSupabase("admin", async (calls) => {
    assert.equal((await PATCH(adminRequest("PATCH", { id: ID, image_url: `${BUCKET}home/nueva.webp`, expected_updated_at: VERSION }))).status, 200)
    assert.deepEqual(downloads(calls), ["home/nueva.webp"])
  }, undefined, { "home/nueva.webp": new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ") })
})

test("Productos sigue como antes: URL externa https admitida (sin descargarla), esquemas peligrosos no", async () => {
  const { POST } = await import("../../app/api/admin/banners/route")
  await withSupabase("admin", async (calls) => {
    const response = await POST(adminRequest("POST", { placement: "products", image_url: "https://img.example/banner.jpg", alt_text: "", active: true, sort_order: 0 }))
    assert.equal(response.status, 200)
    const insert = writes(calls)[0]?.body as Record<string, unknown>
    assert.deepEqual([insert.placement, insert.alt_text, insert.campaign_name, insert.mobile_image_url, insert.starts_at, insert.ends_at, insert.destination_url],
      ["products", "Banner de productos BEYONIX", null, null, null, null, null])
    assert.deepEqual(downloads(calls), [])
  })
  await withSupabase("admin", async (calls) => {
    assert.equal((await POST(adminRequest("POST", { placement: "products", image_url: "javascript:alert(1)" }))).status, 400)
    assert.deepEqual(writes(calls), [])
  })
})

// ── Concurrencia entre administradores (control optimista) ─────────────────

/** Base con UNA fila y su versión real: cada UPDATE exitoso la avanza. */
function versionedDb(initial: Record<string, unknown> = {}) {
  let current: ReturnType<typeof row> | null = row({ active: false, updated_at: "2026-11-23T12:00:00.000000+00:00", ...initial })
  let saves = 0
  const responder: Responder = (call) => {
    if (call.path !== "/rest/v1/site_banner_items") return undefined
    if (!current) return Response.json(call.method === "GET" ? null : [])
    if (call.method === "GET") return Response.json(current)
    // DELETE condicionado: sólo borra la fila si id y versión coinciden.
    if (call.method === "DELETE") {
      if (call.filters.id !== `eq.${current.id}` || call.filters.updated_at !== `eq.${current.updated_at}`) return Response.json([])
      const deleted = current
      current = null
      return Response.json([deleted])
    }
    if (call.method === "PATCH") {
      if (call.filters.updated_at !== `eq.${current.updated_at}`) return Response.json([])
      saves += 1
      current = { ...current, ...(call.body as object), updated_at: `2026-11-23T12:0${saves}:00.000000+00:00` }
      return Response.json([current])
    }
    return undefined
  }
  return {
    responder,
    exists: () => current !== null,
    current: () => {
      if (!current) throw new Error("El banner ya fue eliminado")
      return current
    },
  }
}

test("dos administradores: el que guarda con datos viejos recibe 409 y no reactiva la campaña desactivada", async () => {
  const { PATCH } = await import("../../app/api/admin/banners/route")
  const db = versionedDb()
  const opened = db.current().updated_at // ambos abrieron la misma versión (desactivada)
  await withSupabase("admin", async (calls) => {
    // Admin A la desactiva... ya estaba desactivada: A cambia el nombre.
    const first = await PATCH(adminRequest("PATCH", { id: ID, campaign_name: "Navidad (pausada)", expected_updated_at: opened }))
    assert.equal(first.status, 200)
    // Admin B, con el formulario viejo, la reactivaría.
    const second = await PATCH(adminRequest("PATCH", { id: ID, active: true, expected_updated_at: opened }))
    assert.equal(second.status, 409)
    const payload = await second.json() as { error: string; conflict: boolean }
    assert.equal(payload.conflict, true)
    assert.match(payload.error, /otro administrador.*Recargá los datos/)
    assert.equal(writes(calls).length, 1, "el segundo no escribe")
    assert.deepEqual([db.current().active, db.current().campaign_name], [false, "Navidad (pausada)"], "sigue desactivada y con lo de A")
    // Con la versión nueva (tras recargar), B decide y guarda.
    const retry = await PATCH(adminRequest("PATCH", { id: ID, active: true, expected_updated_at: db.current().updated_at }))
    assert.equal(retry.status, 200)
    assert.equal(db.current().active, true)
  }, db.responder)
})

test("carrera entre la lectura y la escritura: el UPDATE condicionado no afecta filas => 409; sin versión => 400", async () => {
  const { PATCH } = await import("../../app/api/admin/banners/route")
  // La lectura ve la versión esperada, pero otro guardado entra antes del UPDATE.
  await withSupabase("admin", async (calls) => {
    const response = await PATCH(adminRequest("PATCH", { id: ID, active: true, expected_updated_at: VERSION }))
    assert.equal(response.status, 409)
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 1)
    assert.equal(calls.some((call) => call.path === "/rest/v1/audit_logs"), false, "sin auditoría de algo que no pasó")
  }, (call) => call.path === "/rest/v1/site_banner_items" && call.method === "PATCH" ? Response.json([]) : undefined)
  for (const expected of [undefined, "", "ayer"]) {
    await withSupabase("admin", async (calls) => {
      const response = await PATCH(adminRequest("PATCH", { id: ID, active: true, ...(expected === undefined ? {} : { expected_updated_at: expected }) }))
      assert.equal(response.status, 400, String(expected))
      assert.deepEqual(writes(calls), [])
    })
  }
})

const deleteQuery = (expected?: string, id = ID) => `?${new URLSearchParams({ id, ...(expected === undefined ? {} : { expected_updated_at: expected }) })}`
const audits = (calls: Call[]) => calls.filter((call) => call.path === "/rest/v1/audit_logs")

for (const placement of ["home", "products"] as const) {
  test(`${placement}: dos administradores — A edita, B elimina con la versión vieja => 409, no borra ni audita; tras recargar, elimina`, async () => {
    const { PATCH, DELETE } = await import("../../app/api/admin/banners/route")
    const db = versionedDb(placement === "products" ? { placement: "products", campaign_name: null, mobile_image_url: null, starts_at: null, ends_at: null, destination_url: null } : {})
    const opened = db.current().updated_at // ambos abrieron la misma versión
    await withSupabase("super_admin", async (calls) => {
      const edited = await PATCH(adminRequest("PATCH", { id: ID, alt_text: "Editado por A", expected_updated_at: opened }))
      assert.equal(edited.status, 200)
      const stale = await DELETE(adminRequest("DELETE", undefined, deleteQuery(opened)))
      assert.equal(stale.status, 409)
      const payload = await stale.json() as { error: string; conflict: boolean }
      assert.equal(payload.conflict, true)
      assert.match(payload.error, /No se eliminó.*otro administrador.*Recargá los datos/)
      assert.equal(db.exists(), true, "el banner editado por A sigue")
      assert.equal(db.current().alt_text, "Editado por A")
      const deleteCall = calls.find((call) => call.method === "DELETE")
      assert.deepEqual(deleteCall?.filters, { id: `eq.${ID}`, updated_at: `eq.${opened}` }, "un solo DELETE condicionado por id y versión")
      assert.deepEqual(audits(calls).map((call) => (call.body as { action: string }).action), ["UPDATE"], "sin auditoría de la eliminación rechazada")

      // B recarga (versión nueva) y confirma: ahora sí elimina y audita lo que se borró.
      const retry = await DELETE(adminRequest("DELETE", undefined, deleteQuery(db.current().updated_at)))
      assert.equal(retry.status, 200)
      assert.equal(db.exists(), false)
      const deletedAudit = audits(calls).at(-1)?.body as { action: string; before_data: { alt_text: string }; after_data: unknown }
      assert.deepEqual([deletedAudit.action, deletedAudit.before_data.alt_text, deletedAudit.after_data], ["DELETE", "Editado por A", null])
    }, db.responder)
  })
}

test("dos administradores: A elimina, B guarda o elimina con la versión vieja => 404 sin escribir ni auditar", async () => {
  const { PATCH, DELETE } = await import("../../app/api/admin/banners/route")
  const db = versionedDb()
  const opened = db.current().updated_at
  await withSupabase("admin", async (calls) => {
    assert.equal((await DELETE(adminRequest("DELETE", undefined, deleteQuery(opened)))).status, 200)
    assert.equal((await PATCH(adminRequest("PATCH", { id: ID, active: true, expected_updated_at: opened }))).status, 404)
    assert.equal((await DELETE(adminRequest("DELETE", undefined, deleteQuery(opened)))).status, 404)
    assert.equal(audits(calls).length, 1, "sólo la eliminación de A")
  }, db.responder)
})

test("DELETE: carrera entre otra edición y el borrado => 409 (el DELETE condicionado no afecta filas); sin versión => 400", async () => {
  const { DELETE } = await import("../../app/api/admin/banners/route")
  // Otro guardado entra justo antes del DELETE: la base no borra nada, la fila sigue.
  await withSupabase("admin", async (calls) => {
    const response = await DELETE(adminRequest("DELETE", undefined, deleteQuery(VERSION)))
    assert.equal(response.status, 409)
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1)
    assert.deepEqual(audits(calls), [], "sin auditoría de algo que no pasó")
  })
  for (const expected of [undefined, "", "ayer"]) {
    await withSupabase("admin", async (calls) => {
      const response = await DELETE(adminRequest("DELETE", undefined, deleteQuery(expected)))
      assert.equal(response.status, 400, String(expected))
      assert.deepEqual(writes(calls), [])
    })
  }
})

const MALFORMED_VERSIONS = [undefined, "", "   ", "0", "ayer", "texto cualquiera", "2026-02-30T12:00:00Z", "2026-11-23", "2026-11-23T12:00:00"]

test("versión malformada ('0', texto, fecha imposible, vacía o ausente) => 400 en PATCH y DELETE, sin consultar la base", async () => {
  const { PATCH, DELETE } = await import("../../app/api/admin/banners/route")
  for (const expected of MALFORMED_VERSIONS) {
    await withSupabase("admin", async (calls) => {
      const patch = await PATCH(adminRequest("PATCH", { id: ID, active: true, ...(expected === undefined ? {} : { expected_updated_at: expected }) }))
      assert.equal(patch.status, 400, `PATCH ${String(expected)}`)
      assert.match((await patch.json() as { error: string }).error, /versión.*no es válida/)
      const remove = await DELETE(adminRequest("DELETE", undefined, deleteQuery(expected)))
      assert.equal(remove.status, 400, `DELETE ${String(expected)}`)
      assert.match((await remove.json() as { error: string }).error, /versión.*no es válida/)
      assert.deepEqual(calls.filter((call) => call.path === "/rest/v1/site_banner_items" || call.path === "/rest/v1/audit_logs"), [], `${String(expected)}: nada llega a Supabase`)
    })
  }
})

for (const version of ["2026-11-23T12:00:00Z", "2026-11-23T12:00:00.123456+00:00", "2026-11-23T09:00:00.123456-03:00"]) {
  test(`versión válida ${version}: llega intacta a la base; PATCH y DELETE conservan 200, 409 y 404`, async () => {
    const { PATCH, DELETE } = await import("../../app/api/admin/banners/route")
    const db = versionedDb({ updated_at: version })
    await withSupabase("admin", async (calls) => {
      // Con la versión vigente (formato exacto de Supabase), guarda.
      assert.equal((await PATCH(adminRequest("PATCH", { id: ID, alt_text: "Editado", expected_updated_at: version }))).status, 200)
      assert.equal(calls.find((call) => call.method === "PATCH")?.filters.updated_at, `eq.${version}`, "sin perder fracción ni zona")
      // La versión vieja ya no sirve: 409 en ambos.
      assert.equal((await PATCH(adminRequest("PATCH", { id: ID, active: true, expected_updated_at: version }))).status, 409)
      assert.equal((await DELETE(adminRequest("DELETE", undefined, deleteQuery(version)))).status, 409)
      assert.equal(db.exists(), true)
      // Con la versión actual, elimina; después, 404 en ambos.
      const current = db.current().updated_at
      assert.equal((await DELETE(adminRequest("DELETE", undefined, deleteQuery(current)))).status, 200)
      assert.equal((await PATCH(adminRequest("PATCH", { id: ID, active: true, expected_updated_at: current }))).status, 404)
      assert.equal((await DELETE(adminRequest("DELETE", undefined, deleteQuery(current)))).status, 404)
    }, db.responder)
  })
}

test("prioridad inválida (vacía, texto, decimal, fuera de rango o ausente al crear) => 400 sin escribir", async () => {
  const { POST, PATCH } = await import("../../app/api/admin/banners/route")
  for (const sortOrder of ["", "  ", "abc", "1.5", 1.5, "1e2", 1000, "-1000", null, undefined]) {
    await withSupabase("admin", async (calls) => {
      const body: Record<string, unknown> = { ...NEW_HOME, sort_order: sortOrder }
      if (sortOrder === undefined) delete body.sort_order
      const response = await POST(adminRequest("POST", body))
      assert.equal(response.status, 400, String(sortOrder))
      assert.match((await response.json() as { error: string }).error, /prioridad tiene que ser un número entero entre -999 y 999/)
      assert.deepEqual(writes(calls), [])
    }, undefined, FILES)
  }
  await withSupabase("admin", async (calls) => {
    assert.equal((await PATCH(adminRequest("PATCH", { id: ID, sort_order: "x", expected_updated_at: VERSION }))).status, 400)
    assert.deepEqual(writes(calls), [])
  })
  await withSupabase("admin", async (calls) => {
    assert.equal((await POST(adminRequest("POST", { ...NEW_HOME, sort_order: -999 }))).status, 200)
    assert.equal((writes(calls)[0]?.body as { sort_order: number }).sort_order, -999)
  }, undefined, FILES)
})

test("GIF: Productos lo sigue admitiendo (firma real); el Home lo rechaza; un SVG renombrado no pasa", async () => {
  const { POST } = await import("../../app/api/admin/banners/route")
  await withSupabase("admin", async (calls) => {
    const response = await POST(adminRequest("POST", { placement: "products", image_url: `${BUCKET}products/animado.gif`, active: true, sort_order: 0 }))
    assert.equal(response.status, 200)
    assert.deepEqual(downloads(calls), ["products/animado.gif"])
  }, undefined, { "products/animado.gif": GIF })
  await withSupabase("admin", async (calls) => {
    const response = await POST(adminRequest("POST", { ...NEW_HOME, image_url: `${BUCKET}home/animado.gif` }))
    assert.equal(response.status, 400)
    assert.match((await response.json() as { error: string }).error, /JPG, PNG, WebP o AVIF/)
    assert.deepEqual(writes(calls), [])
  }, undefined, { ...FILES, "home/animado.gif": GIF })
  await withSupabase("admin", async (calls) => {
    const response = await POST(adminRequest("POST", { placement: "products", image_url: `${BUCKET}products/falso.png`, active: true, sort_order: 0 }))
    assert.equal(response.status, 400)
    assert.deepEqual(writes(calls), [])
  }, undefined, { "products/falso.png": SVG })
})

// ── Lectura pública ─────────────────────────────────────────────────────────

const publicGet = async (query: string) => {
  const { publicBannersResponse } = await import("./public-banners-response")
  return publicBannersResponse(new Request(`http://localhost/api/store/banners${query}`), async () => createClient(SUPABASE, "test-anon"))
}
const rpcResult = (result: unknown) => (call: Call) => call.path === "/rest/v1/rpc/get_public_site_banners" ? Response.json(result) : undefined
const publicBanner = (overrides: Record<string, unknown> = {}) => ({
  id: ID, placement: "home", image_url: `${BUCKET}home/navidad.jpg`, mobile_image_url: null, alt_text: "Navidad", destination_url: "/productos",
  active: true, sort_order: 0, ends_at: "2026-12-27T03:00:00.000Z", updated_at: null, ...overrides,
})

test("Home público: sólo la campaña vigente (la elige la base), próximo cambio y sin caché; si falla, ninguna", async () => {
  await withSupabase("anon", async (calls) => {
    const response = await publicGet("?placement=home")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("Cache-Control"), "no-store")
    const payload = await response.json() as { banner: { id: string } | null; nextChangeAt: string; serverNow: string }
    assert.equal(payload.banner?.id, ID)
    assert.equal(payload.nextChangeAt, "2026-12-27T03:00:00.000Z")
    assert.deepEqual(calls.find((call) => call.path === "/rest/v1/rpc/get_public_site_banners")?.body, { p_placement: "home" })
    assert.equal(calls.some((call) => call.path === "/rest/v1/site_banner_items" || call.path === "/rest/v1/site_banners"), false, "nunca lee la tabla directo")
  }, rpcResult({ banners: [publicBanner()], hasItems: true, nextChangeAt: "2026-12-27T03:00:00.000Z", serverNow: "2026-12-24T12:00:00Z" }))

  await withSupabase("anon", async () => {
    const payload = await (await publicGet("?placement=home")).json() as { banner: unknown }
    assert.equal(payload.banner, null, "sin campañas")
  }, rpcResult({ banners: [], hasItems: true, nextChangeAt: "2027-01-01T03:00:00.000Z", serverNow: "2026-12-24T12:00:00Z" }))

  await withSupabase("anon", async (calls) => {
    const response = await publicGet("?placement=home")
    assert.equal(response.status, 503)
    assert.equal((await response.json() as { banner: unknown }).banner, null, "sin respaldo inseguro")
    assert.equal(calls.some((call) => call.path === "/rest/v1/site_banners"), false)
  }, (call) => call.path === "/rest/v1/rpc/get_public_site_banners" ? Response.json({ message: "boom" }, { status: 500 }) : undefined)
})

test("Productos público: mismo contrato; respaldo heredado SÓLO si nunca tuvo banners propios", async () => {
  const legacy = { key: "products_hero", title: null, image_url: "https://img.example/viejo.jpg", alt_text: "Viejo", active: true, updated_at: null }
  const legacyResponder = (rpc: unknown) => (call: Call) =>
    call.path === "/rest/v1/site_banners" ? Response.json(legacy) : rpcResult(rpc)(call)

  await withSupabase("anon", async () => {
    const payload = await (await publicGet("?key=products_hero")).json() as { banners: Array<{ id: string; placement: string }>; banner: { id: string } }
    assert.deepEqual(payload.banners.map((banner) => banner.id), ["p1", "p2"])
    assert.equal(payload.banner.id, "p1")
  }, legacyResponder({ banners: [publicBanner({ id: "p1", placement: "products" }), publicBanner({ id: "p2", placement: "products" })], hasItems: true, nextChangeAt: null, serverNow: "2026-12-24T12:00:00Z" }))

  // Tiene banners propios pero ninguno visible (desactivados o fuera de vigencia): no vuelve el viejo.
  await withSupabase("anon", async (calls) => {
    assert.deepEqual(await (await publicGet("?key=products_hero")).json(), { banners: [], banner: null })
    assert.equal(calls.some((call) => call.path === "/rest/v1/site_banners"), false)
  }, legacyResponder({ banners: [], hasItems: true, nextChangeAt: null, serverNow: "2026-12-24T12:00:00Z" }))

  // Lectura fallida: tampoco.
  await withSupabase("anon", async (calls) => {
    assert.deepEqual(await (await publicGet("?placement=products")).json(), { banners: [], banner: null })
    assert.equal(calls.some((call) => call.path === "/rest/v1/site_banners"), false)
  }, (call) => call.path === "/rest/v1/rpc/get_public_site_banners" ? Response.json({ message: "boom" }, { status: 500 }) : undefined)

  // Nunca tuvo banners propios: respaldo heredado como antes.
  await withSupabase("anon", async () => {
    const payload = await (await publicGet("?key=products_hero")).json() as { banner: { id: string; image_url: string } }
    assert.deepEqual([payload.banner.id, payload.banner.image_url], ["products_hero", legacy.image_url])
  }, legacyResponder({ banners: [], hasItems: false, nextChangeAt: null, serverNow: "2026-12-24T12:00:00Z" }))

  await withSupabase("anon", async () => {
    assert.equal((await publicGet("?placement=checkout")).status, 404)
  })
})
