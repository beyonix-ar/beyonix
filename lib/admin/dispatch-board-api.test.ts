import assert from "node:assert/strict"
import test from "node:test"

test("la búsqueda de Despachos exige sesión antes de consultar datos", async () => {
  const { GET } = await import("../../app/api/admin/dispatch/search/route")
  const response = await GET(new Request("https://beyonix.test/api/admin/dispatch/search?tab=delivered"))
  assert.equal(response.status, 401)
})
