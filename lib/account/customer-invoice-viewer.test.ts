import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

test("REGRESIÓN causa raíz: el select de ítems para la factura no pide precio_unitario (columna inexistente en orden_items)", () => {
  const route = source("app/api/orders/[id]/invoice/route.ts")

  // orden_items sólo tiene la columna `precio`. Pedir `precio_unitario`
  // rompía la query completa con 42703 ("column does not exist") y el
  // endpoint devolvía 500 con "No se pudo recuperar el detalle de la
  // factura." — verificado en vivo contra la base real.
  assert.doesNotMatch(route, /precio_unitario/)
  assert.match(
    route,
    /\.select\("id, orden_id, producto_id, variante_id, conditioned_name, cantidad, precio"\)/,
  )
})

test("'Ver factura' abre el visor (sin ícono, sin descarga directa)", () => {
  const client = source("app/cuenta/cuenta-client.tsx")
  const buttonMatch = client.match(
    /\{invoiceAvailable && \([\s\S]*?<\/button>\s*\)\}/,
  )
  assert.ok(buttonMatch, "no se encontró el botón de 'Ver factura'")
  const button = buttonMatch![0]

  assert.match(button, /onClick=\{\(\) => setInvoiceViewerOpen\(true\)\}/)
  assert.doesNotMatch(button, /<Download/)
  assert.doesNotMatch(button, /fetch\(/)
  assert.match(button, />\s*Ver factura\s*</)
})

test("el botón 'Ver factura' NO dispara ningún fetch: abrir el visor sólo cambia un estado local", () => {
  const client = source("app/cuenta/cuenta-client.tsx")

  assert.doesNotMatch(client, /handleViewInvoice/)
  assert.match(client, /const \[invoiceViewerOpen, setInvoiceViewerOpen\] = useState\(false\)/)
})

test("la factura NO se solicita al cargar el detalle del pedido: sólo el visor (montado bajo demanda) hace fetch", () => {
  const client = source("app/cuenta/cuenta-client.tsx")
  // loadOrder es el único efecto que corre al entrar a la página; no debe
  // mencionar el endpoint de factura en ningún punto de su cuerpo.
  const loadOrderMatch = client.match(
    /async function loadOrder\(\) \{[\s\S]*?void loadOrder\(\)/,
  )
  assert.ok(loadOrderMatch, "no se encontró loadOrder")
  assert.doesNotMatch(loadOrderMatch![0], /\/invoice/)

  const modal = source("components/account/invoice-viewer-modal.tsx")
  // El propio visor sólo dispara su fetch en un useEffect atado a su
  // montaje/orderId — nunca se monta hasta que se abre invoiceViewerOpen.
  assert.match(modal, /fetch\(`\/api\/orders\/\$\{orderId\}\/invoice`\)/)
})

test("un fallo al obtener el PDF queda contenido en el visor: no toca el estado de error global de la página", () => {
  const client = source("app/cuenta/cuenta-client.tsx")
  const modal = source("components/account/invoice-viewer-modal.tsx")

  // El componente de detalle ya no tiene ninguna ruta que llame setError()
  // por una falla de factura (el visor administra su propio estado).
  assert.doesNotMatch(client, /setError\([^)]*factura/i)
  // El visor tiene su propio estado de error, independiente del padre.
  assert.match(modal, /const \[status, setStatus\] = useState<"loading" \| "ready" \| "error">\("loading"\)/)
  assert.match(modal, /setStatus\("error"\)/)
})

test("el visor muestra loading mientras pide el PDF y error propio si falla, sin abrir una pestaña nueva", () => {
  const modal = source("components/account/invoice-viewer-modal.tsx")

  assert.match(modal, /status === "loading"/)
  assert.match(modal, /status === "error"/)
  assert.match(modal, /status === "ready" && fileUrl/)
  assert.doesNotMatch(modal, /window\.open/)
})

test("el visor usa un solo PDF por apertura y descarga exactamente el mismo Blob", () => {
  const modal = source("components/account/invoice-viewer-modal.tsx")

  assert.match(modal, /const blob = await response\.blob\(\)/)
  assert.match(modal, /objectUrl = URL\.createObjectURL\(blob\)/)
  assert.match(modal, /<iframe src=\{fileUrl\}/)
  assert.match(modal, /Descargar factura/)
  assert.match(modal, /const handleDownload = \(\) =>/)
  assert.match(modal, /anchor\.href = fileUrl/)
  assert.match(modal, /anchor\.download = fileName/)
  // Un solo `fetch(` real en todo el archivo -> un solo pedido de PDF por apertura.
  const fetchCalls = modal.match(/\bfetch\(/g)
  assert.equal(fetchCalls?.length, 1)
})

test("el visor libera la blob URL al desmontarse/cerrarse (sin fugas de memoria)", () => {
  const modal = source("components/account/invoice-viewer-modal.tsx")

  assert.match(modal, /if \(objectUrl\) URL\.revokeObjectURL\(objectUrl\)/)
})

test("el visor de factura puede cerrarse con Escape, click en el fondo y botón X", () => {
  const modal = source("components/account/invoice-viewer-modal.tsx")

  assert.match(modal, /event\.key === "Escape"/)
  assert.match(modal, /aria-label="Cerrar"\s*\n\s*onClick=\{onClose\}\s*\n\s*className="absolute inset-0/)
  assert.match(modal, /aria-label="Cerrar"[\s\S]*?<X className/)
})

test("el endpoint de factura sigue exigiendo sesión y ownership por usuario (sin cambios de permisos)", () => {
  const route = source("app/api/orders/[id]/invoice/route.ts")

  assert.match(route, /supabase\.auth\.getUser\(\)/)
  assert.match(route, /if \(!user\)/)
  assert.match(route, /status: 401/)
  assert.match(route, /\.eq\("usuario_id", user\.id\)/)
  assert.match(route, /\.is\("usuario_id", null\)/)
  assert.match(route, /\.ilike\("cliente_email", escapeIlikeValue\(normalizedEmail\)\)/)
  assert.match(route, /order\.invoice_status !== "authorized"/)
  assert.match(route, /status: 404/)
})

test("la factura autorizada exige CAE y numeración completos antes de generar el PDF", () => {
  const route = source("app/api/orders/[id]/invoice/route.ts")

  assert.match(route, /!order\.invoice_number/)
  assert.match(route, /!order\.invoice_point/)
  assert.match(route, /!order\.invoice_cae/)
  assert.match(route, /!order\.invoice_cae_due/)
  assert.match(route, /!order\.invoice_created_at/)
  assert.match(route, /status: 409/)
})

test("la descarga de nota de crédito sigue funcionando con su propio handler (sin mezclarse con Ver factura)", () => {
  const client = source("app/cuenta/cuenta-client.tsx")

  assert.match(client, /const handleDownloadCreditNote = async \(\) => \{/)
  assert.match(client, /onClick=\{\(\) => void handleDownloadCreditNote\(\)\}/)
  assert.match(client, /\?type=credit_note/)
})

test("'Gestión del pedido' centra verticalmente la acción de seguimiento respecto de toda la tarjeta", () => {
  const client = source("app/cuenta/cuenta-client.tsx")
  const sectionMatch = client.match(
    /customer-order-management relative flex flex-col[\s\S]*?<\/section>/,
  )
  assert.ok(sectionMatch, "no se encontró la tarjeta de Gestión del pedido")
  assert.match(sectionMatch![0], /!showPaymentProofSection && "sm:pr-56"/)
  const centeredActions = sectionMatch![0].match(
    /sm:absolute sm:inset-y-0 sm:right-4 sm:my-auto sm:self-auto/g,
  )
  assert.equal(centeredActions?.length, 2)
  assert.doesNotMatch(sectionMatch![0], /translate-y/)
})
