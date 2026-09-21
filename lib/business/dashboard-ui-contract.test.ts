import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")

test("Q. los paneles distinguen error inicial de vacío y ofrecen retry", () => {
  const costs = read("app/admin/sections/dashboard/admin-costs-panel.tsx")
  const external = read("app/admin/sections/dashboard/admin-sales-ledger.tsx")
  const marketplace = read("app/admin/sections/dashboard/admin-mercadolibre-sales.tsx")

  assert.match(costs, /!loading && error && !data/)
  assert.match(external, /!loading && error && rows\.length === 0/)
  assert.match(marketplace, /!loading && error && sales\.length === 0/)
  for (const source of [costs, external, marketplace]) assert.match(source, /Reintentar/)
})

test("R. el error inicial del dashboard reemplaza el skeleton y permite reintentar", () => {
  const source = read("app/admin/sections/dashboard/admin-dashboard.tsx")
  const loadingIndex = source.indexOf("if (loading) return <Skeleton />")
  const errorIndex = source.indexOf("if (error && (!stats || !financialSummary))")
  assert.ok(loadingIndex >= 0)
  assert.ok(errorIndex > loadingIndex)
  assert.match(source, /onClick=\{\(\) => void reloadDashboard\(\)\}/)
  assert.match(source, /no se muestran valores en cero/i)
})

test("S. commercialSales navega al pedido web exacto", () => {
  const source = read("app/admin/sections/dashboard/admin-dashboard.tsx")
  assert.match(source, /sale\.channel === "BEYONIX Web" && sale\.orderId/)
  assert.match(source, /router\.push\(`\/admin\/pedidos\/\$\{encodeURIComponent\(sale\.orderId!\)\}`\)/)
  assert.match(source, />\s*Ver pedido\s*</)
})
