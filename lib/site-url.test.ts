import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { resolveConfiguredSiteUrl, resolveTrustedSiteUrl } from "./site-url.ts"

function withEnv(
  env: { siteUrl?: string; nodeEnv?: string },
  run: () => void,
) {
  const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL
  const previousNodeEnv = process.env.NODE_ENV

  try {
    if (env.siteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL
    else process.env.NEXT_PUBLIC_SITE_URL = env.siteUrl
    ;(process.env as Record<string, string | undefined>).NODE_ENV =
      env.nodeEnv ?? "test"
    run()
  } finally {
    if (previousSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL
    else process.env.NEXT_PUBLIC_SITE_URL = previousSiteUrl
    ;(process.env as Record<string, string | undefined>).NODE_ENV =
      previousNodeEnv
  }
}

function requestWithOrigin(origin: string) {
  return new Request("https://beyonix.com.ar/api/test", {
    headers: { origin },
  })
}

test("en producción NUNCA se usa el header Origin, aunque falte NEXT_PUBLIC_SITE_URL", () => {
  withEnv({ siteUrl: undefined, nodeEnv: "production" }, () => {
    assert.equal(
      resolveTrustedSiteUrl(requestWithOrigin("https://atacante.example")),
      null,
    )
  })
})

test("en producción el Origin no puede sobreescribir la URL configurada", () => {
  withEnv({ siteUrl: "https://beyonix.com.ar", nodeEnv: "production" }, () => {
    assert.equal(
      resolveTrustedSiteUrl(requestWithOrigin("https://atacante.example")),
      "https://beyonix.com.ar",
    )
  })
})

test("en producción se rechaza una URL configurada sin https o apuntando a localhost", () => {
  withEnv({ siteUrl: "http://beyonix.com.ar", nodeEnv: "production" }, () => {
    assert.equal(resolveTrustedSiteUrl(), null)
  })
  withEnv({ siteUrl: "https://localhost:3000", nodeEnv: "production" }, () => {
    assert.equal(resolveTrustedSiteUrl(), null)
  })
})

test("una NEXT_PUBLIC_SITE_URL inválida no se adivina: devuelve null", () => {
  withEnv({ siteUrl: "no-es-una-url", nodeEnv: "production" }, () => {
    assert.equal(resolveTrustedSiteUrl(), null)
  })
})

test("fuera de producción el Origin sirve como fallback de desarrollo", () => {
  withEnv({ siteUrl: undefined, nodeEnv: "development" }, () => {
    assert.equal(
      resolveTrustedSiteUrl(requestWithOrigin("http://localhost:3001")),
      "http://localhost:3001",
    )
    assert.equal(resolveTrustedSiteUrl(), "http://localhost:3000")
  })
})

test("las rutas sensibles ya no construyen URLs desde el header Origin", () => {
  // app/api/customer-credit/mercadopago/preference/route.ts quedó fuera de
  // esta lista: la carga de saldo por parte del cliente está deshabilitada
  // (ver lib/mercadopago/customer-credit-topup-attempt.test.ts) y esa ruta
  // ya no construye ninguna URL, confiable o no.
  const sensitiveRoutes = [
    "app/api/auth/forgot-password/route.ts",
    "app/api/mercadopago/create-preference/route.ts",
  ]

  for (const route of sensitiveRoutes) {
    const source = readFileSync(route, "utf8")
    assert.doesNotMatch(
      source,
      /headers\.get\("origin"\)/,
      `${route} sigue leyendo el header Origin`,
    )
    assert.match(source, /resolveTrustedSiteUrl|resolveConfiguredSiteUrl/, `${route} no usa la URL confiable`)
  }
})

// --- resolveConfiguredSiteUrl: enlaces de autenticación (recuperación) ---

test("recuperación: PROD usa exclusivamente la URL configurada", () => {
  withEnv({ siteUrl: "https://beyonix.com.ar/", nodeEnv: "production" }, () => {
    assert.equal(resolveConfiguredSiteUrl(), "https://beyonix.com.ar")
  })
})

test("recuperación: QA (build de producción con su propia variable) usa su URL configurada", () => {
  withEnv({ siteUrl: "https://qa.beyonix.com.ar", nodeEnv: "production" }, () => {
    assert.equal(resolveConfiguredSiteUrl(), "https://qa.beyonix.com.ar")
  })
})

test("recuperación: local usa la URL local configurada (http sólo para localhost)", () => {
  withEnv({ siteUrl: "http://localhost:3000", nodeEnv: "development" }, () => {
    assert.equal(resolveConfiguredSiteUrl(), "http://localhost:3000")
  })
  withEnv({ siteUrl: "http://beyonix.com.ar", nodeEnv: "development" }, () => {
    assert.equal(resolveConfiguredSiteUrl(), null)
  })
})

test("recuperación: configuración ausente o inválida => null en todos los entornos (nunca fallback a headers)", () => {
  for (const nodeEnv of ["production", "development", "test"]) {
    withEnv({ siteUrl: undefined, nodeEnv }, () => assert.equal(resolveConfiguredSiteUrl(), null))
    withEnv({ siteUrl: "no-es-una-url", nodeEnv }, () => assert.equal(resolveConfiguredSiteUrl(), null))
    withEnv({ siteUrl: "https://user:pass@beyonix.com.ar", nodeEnv }, () =>
      assert.equal(resolveConfiguredSiteUrl(), null),
    )
  }
  withEnv({ siteUrl: "https://localhost:3000", nodeEnv: "production" }, () =>
    assert.equal(resolveConfiguredSiteUrl(), null),
  )
})

test("recuperación: la función no recibe el request -- Origin/Host maliciosos no pueden influir", () => {
  assert.equal(resolveConfiguredSiteUrl.length, 0)
  const route = readFileSync("app/api/auth/forgot-password/route.ts", "utf8")
  assert.match(route, /siteUrl: resolveConfiguredSiteUrl\(\)/)
  assert.doesNotMatch(route, /headers\.get\("(origin|host|x-forwarded-host|x-forwarded-for)"\)/i)
  assert.doesNotMatch(route, /resolveTrustedSiteUrl/)
})
