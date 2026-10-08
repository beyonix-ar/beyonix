import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const source = (path: string) => readFileSync(path, "utf8")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })
}

test("WhatsApp flotante eliminado: sin componente, sin links wa.me y sin el número placeholder", () => {
  assert.equal(existsSync("components/whatsapp-button.tsx"), false)
  for (const file of [...sourceFiles("app"), ...sourceFiles("components"), ...sourceFiles("lib")]) {
    const content = source(file)
    assert.doesNotMatch(content, /wa\.me|api\.whatsapp|WhatsAppButton|5491112345678|--color-whatsapp/i, file)
  }
})

test("arrepentimiento: acceso único en el footer, sin franja superior ni espacio reservado", () => {
  const header = source("components/site-header.tsx")
  assert.doesNotMatch(header, /BOTÓN DE ARREPENTIMIENTO|beyonix-site-header-legal-strip|BEYONIX_WITHDRAWAL_PAGE_URL/)
  assert.match(header, /<header[\s\S]*?<nav className="container mx-auto px-4 lg:px-8">/)
  const footer = source("components/footer.tsx")
  assert.equal(footer.match(/BOTÓN DE ARREPENTIMIENTO/g)?.length, 1)
  assert.match(footer, /href=\{BEYONIX_WITHDRAWAL_PAGE_URL\}[\s\S]{0,300}BOTÓN DE ARREPENTIMIENTO/)
  assert.match(source("lib/legal-contact.ts"), /BEYONIX_WITHDRAWAL_PAGE_URL = "\/arrepentimiento"/)
  assert.match(source("app/arrepentimiento/page.tsx"), /export default function ArrepentimientoPage/)
  assert.doesNotMatch(source("app/devoluciones/page.tsx"), /BOTÓN DE ARREPENTIMIENTO|BEYONIX_WITHDRAWAL_PAGE_URL/)
  const shell = source("components/layout-shell.tsx")
  assert.doesNotMatch(shell, /SITE_HEADER_LEGAL_STRIP_OFFSET|pt-6/)
  assert.doesNotMatch(source("app/globals.css"), /beyonix-site-header-legal-(strip|link)/)
})

test("arrepentimiento: sin registración, email como acción principal (no exige cuenta de Google) y código en 24 h", () => {
  const page = source("app/arrepentimiento/page.tsx")
  assert.match(page, /<a href=\{BEYONIX_WITHDRAWAL_URL\}>[\s\S]*Solicitar por email/)
  assert.match(page, /No hace falta tener cuenta en BEYONIX/)
  assert.match(page, /24 horas/)
  assert.match(page, /sucursal Andreani/)
  assert.match(page, /Disposición 954\/2025/)
})

test("términos: normativa vigente, sin la resolución derogada como vigente ni cláusulas contradictorias", () => {
  const terms = source("app/terminos/page.tsx")
  assert.doesNotMatch(terms, /424\/2020/, "Res. 424/2020 derogada por la Disp. 954/2025")
  assert.doesNotMatch(terms, /invitación a comprar/, "la oferta obliga (art. 7 Ley 24.240)")
  assert.doesNotMatch(terms, /no se hace responsable/i)
  assert.doesNotMatch(terms, /cargas de saldo/, "el cliente no puede cargar saldo")
  assert.match(terms, /disposici%C3%B3n-954-2025/)
  assert.match(terms, /Los gastos de devolución\s+corren por cuenta de BEYONIX/)
  assert.match(terms, /no se realizan retiros a domicilio/)
  assert.match(terms, /TRANSFER_PAYMENT_EXPIRATION_HOURS/)
  assert.match(terms, /artículo 17 de la Ley 24\.240/)
  assert.match(terms, /AAIP_PERSONAL_DATA_NOTICE/)
  assert.match(terms, /CONSUMER_COMPLAINTS_URL/)
})

test("privacidad: texto obligatorio de la Res. AAIP 14/2018 y derechos del titular", () => {
  const privacy = source("app/privacidad/page.tsx")
  assert.match(privacy, /AAIP_PERSONAL_DATA_NOTICE/)
  assert.match(privacy, /10 días corridos/)
  assert.match(source("lib/legal-contact.ts"), /LA AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley N° 25\.326/)
})

test("garantía: siempre 'garantía legal' (sin garantía propia o extendida) con el plazo de la política", () => {
  for (const file of ["components/products/product-purchase-box.tsx", "components/claims/customer-claim-experience.tsx", "lib/order-claims.ts"]) {
    assert.doesNotMatch(source(file), /Garantía BEYONIX|Garantía de 6 meses/, file)
  }
  assert.match(source("components/products/product-purchase-box.tsx"), /Garantía legal de \{DEFAULT_PRODUCT_WARRANTY_MONTHS\} meses/)
})
