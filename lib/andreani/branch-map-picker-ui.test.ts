import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
}

test("checkout: el mapa de sucursales se carga vía next/dynamic con ssr:false -- nunca en el bundle inicial de domicilio", () => {
  const checkout = source("app/checkout/page.tsx")

  assert.match(checkout, /import dynamic from "next\/dynamic"/)
  assert.match(
    checkout,
    /const BranchMapPicker = dynamic\(\s*\n?\s*\(\) =>\s*\n?\s*import\("@\/components\/checkout\/branch-map-picker"\)/,
  )
  assert.match(checkout, /ssr:\s*false/)
})

test("checkout: leaflet/react-leaflet nunca se importan directamente en la página -- sólo dentro del componente lazy", () => {
  const checkout = source("app/checkout/page.tsx")

  assert.doesNotMatch(checkout, /from "leaflet"/)
  assert.doesNotMatch(checkout, /from "react-leaflet"/)
  assert.doesNotMatch(checkout, /leaflet\/dist\/leaflet\.css/)
})

test("branch-map-picker: importa leaflet/react-leaflet -- vive sólo en el chunk separado que se carga bajo demanda", () => {
  const picker = source("components/checkout/branch-map-picker.tsx")

  assert.match(picker, /from "react-leaflet"/)
  assert.match(picker, /import L from "leaflet"/)
  assert.match(picker, /leaflet\/dist\/leaflet\.css/)
})

test("branch-map-picker: nunca muestra el idgla ni el código técnico como texto visible", () => {
  const picker = source("components/checkout/branch-map-picker.tsx")

  // branch.id se usa como key/posición interna, nunca interpolado como texto.
  assert.doesNotMatch(picker, />\s*\{branch\.id\}\s*</)
  assert.doesNotMatch(picker, />\s*\{branch\.codigo\}\s*</)
  assert.doesNotMatch(picker, /contrato/i)
})

test("branch-map-picker: cada tarjeta muestra nombre, dirección, localidad/provincia, CP, horario y distancia aproximada", () => {
  const picker = source("components/checkout/branch-map-picker.tsx")

  assert.match(picker, /branch\.descripcion/)
  assert.match(picker, /formatAndreaniBranchStreetLine\(branch\.direccion\)/)
  assert.match(picker, /formatAndreaniBranchAddress\(branch\.direccion\)/)
  assert.match(picker, /branch\.direccion\.localidad/)
  assert.match(picker, /branch\.direccion\.provincia/)
  assert.match(picker, /branch\.direccion\.codigoPostal/)
  assert.match(picker, /branch\.horarioDeAtencion/)
  assert.match(picker, /formatDistanceKm/)
})

test("branch-map-picker: recomienda la más cercana sin autoseleccionar -- exige click explícito", () => {
  const picker = source("components/checkout/branch-map-picker.tsx")

  assert.match(picker, /Más cercana/)
  assert.match(picker, /onClick=\{\(\) => onSelect\(branch\.id\)\}/)
  // Nunca llama a onSelect fuera de un handler de click/evento (nada de
  // auto-selección en efectos de montaje).
  assert.doesNotMatch(picker, /useEffect\([^)]*onSelect\(/)
})

test("branch-map-picker: buscador filtra localmente (nombre/calle/localidad) sin pegarle a Andreani por cada tecla", () => {
  const picker = source("components/checkout/branch-map-picker.tsx")

  assert.match(picker, /Buscar sucursal o dirección/)
  assert.match(picker, /branchMatchesSearch/)
  assert.doesNotMatch(picker, /fetch\(/)
})

test("branch-map-picker: lista y mapa comparten el mismo estado de selección en ambos sentidos (click tarjeta <-> click marcador)", () => {
  const picker = source("components/checkout/branch-map-picker.tsx")

  assert.match(picker, /eventHandlers=\{\{ click: \(\) => onSelect\(branch\.id\) \}\}/)
  assert.match(picker, /function FlyToSelected/)
  assert.match(picker, /scrollIntoView/)
})

test("checkout: sin sucursales en la localidad, se explica claramente y se ofrece volver a domicilio -- nunca un mapa vacío", () => {
  const checkout = source("app/checkout/page.tsx")

  assert.match(
    checkout,
    /No encontramos sucursales Andreani disponibles en tu localidad\./,
  )
  assert.match(checkout, /Volver a envío a domicilio/)
})

test("checkout: cambiar a domicilio limpia la sucursal elegida; cambiar de destino descarta una sucursal que ya no aplica", () => {
  const checkout = source("app/checkout/page.tsx")

  assert.match(
    checkout,
    /if \(option\.type !== "sucursal"\) \{\s*\n\s*setSelectedSucursalId\(null\)/,
  )
  assert.match(
    checkout,
    /branchOption\?\.branches\?\.some\(\(branch\) => branch\.id === current\)/,
  )
})

test("checkout: el botón Continuar exige sucursal cargada y seleccionada cuando la modalidad es sucursal", () => {
  const checkout = source("app/checkout/page.tsx")

  assert.match(
    checkout,
    /selectedShippingType !== "sucursal" \|\| selectedSucursalId !== null/,
  )
})

test("checkout-quote: la cotización de sucursal nunca cambia de precio por sucursal individual -- una sola tarifa por contrato", () => {
  const quote = source("lib/andreani/checkout-quote.ts")

  // quoteContract sólo se llama una vez por tipo (domicilio/sucursal), nunca
  // una vez por sucursal dentro del array.
  const sucursalCalls = quote.match(/quoteContract\("sucursal"/g) ?? []
  assert.equal(sucursalCalls.length, 1)
})
