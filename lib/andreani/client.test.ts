import assert from "node:assert/strict"
import test from "node:test"

import { createAndreaniAdminTestHandlers } from "./admin-test-handler.ts"
import {
  AndreaniClient,
  AndreaniError,
  resetAndreaniRuntimeStateForTests,
  resolveAndreaniConfig,
  sanitizeAndreaniMessage,
  testAndreaniQaConnection,
} from "./client.ts"

function qaEnvironment(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    ANDREANI_ENV: "QA",
    ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
    ANDREANI_QA_USERNAME: ["usuario", "de", "prueba"].join("-"),
    ANDREANI_QA_PASSWORD: ["clave", "de", "prueba"].join("-"),
    ...overrides,
    NODE_ENV: "test",
  }
}

test("rechaza variables obligatorias faltantes", () => {
  assert.throws(
    () => resolveAndreaniConfig({ NODE_ENV: "test", ANDREANI_ENV: "QA" }),
    (error) =>
      error instanceof AndreaniError && error.code === "CONFIGURATION_ERROR",
  )
})

test("selecciona únicamente la configuración QA", () => {
  const config = resolveAndreaniConfig(qaEnvironment())
  assert.equal(config.environment, "QA")
  assert.equal(config.baseUrl, "https://apisqa.andreani.com")
})

test("bloquea el uso accidental de PROD", () => {
  assert.throws(
    () =>
      resolveAndreaniConfig({
        NODE_ENV: "test",
        ANDREANI_ENV: "PROD",
        ANDREANI_PROD_API_URL: "https://apis.andreani.com",
        ANDREANI_PROD_USERNAME: "valor-de-prueba",
        ANDREANI_PROD_PASSWORD: "valor-de-prueba",
      }),
    (error) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
})

test("normaliza una autenticación rechazada sin exponer la respuesta", async () => {
  resetAndreaniRuntimeStateForTests()
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async () =>
      new Response("detalle externo que no debe propagarse", { status: 401 }),
  })

  await assert.rejects(
    () => client.authenticate(),
    (error) =>
      error instanceof AndreaniError &&
      error.code === "AUTHENTICATION_FAILED" &&
      !error.message.includes("detalle externo"),
  )
})

test("corta la solicitud al alcanzar el timeout", async () => {
  resetAndreaniRuntimeStateForTests()
  const client = new AndreaniClient({
    env: qaEnvironment(),
    timeoutMs: 5,
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Abortado", "AbortError"))
        })
      }),
  })

  await assert.rejects(
    () => client.authenticate(),
    (error) => error instanceof AndreaniError && error.code === "TIMEOUT",
  )
})

test("acepta una respuesta de autenticación exitosa", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestedUrl = ""
  let requestedMethod = ""
  let usedBasicAuthentication = false
  const result = await testAndreaniQaConnection({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      requestedUrl = String(input)
      requestedMethod = init?.method ?? ""
      usedBasicAuthentication = new Headers(init?.headers)
        .get("authorization")
        ?.startsWith("Basic ") ?? false
      return Response.json({ token: ["token", "de", "prueba"].join("-") })
    },
  })

  assert.equal(result.status, "success")
  assert.equal(result.environment, "QA")
  assert.equal(requestedUrl, "https://apisqa.andreani.com/login")
  assert.equal(requestedMethod, "POST")
  assert.equal(usedBasicAuthentication, true)
  assert.deepEqual(Object.keys(result).sort(), [
    "environment",
    "message",
    "status",
    "testedAt",
  ])
})

test("sanitiza secretos y headers de los mensajes", () => {
  const env = qaEnvironment()
  const raw = `Falló ${env.ANDREANI_QA_USERNAME} password=${env.ANDREANI_QA_PASSWORD} Basic dGVzdDp0ZXN0 x-authorization-token: abc.def`
  const sanitized = sanitizeAndreaniMessage(raw, env)

  assert.doesNotMatch(sanitized, /usuario-de-prueba|clave-de-prueba|dGVzdDp0ZXN0|abc\.def/)
  assert.match(sanitized, /DATO PROTEGIDO/)
})

test("la ruta de prueba exige autorización administrativa", async () => {
  let testWasCalled = false
  const handlers = createAndreaniAdminTestHandlers({
    authorize: async () => ({
      error: Response.json({ error: "Acceso denegado." }, { status: 403 }),
    }),
    getStatus: () => ({
      environment: "QA",
      configured: true,
      message: "Configuración QA completa.",
      lastTest: null,
    }),
    testConnection: async () => {
      testWasCalled = true
      return {
        status: "success",
        environment: "QA",
        testedAt: new Date(0).toISOString(),
        message: "Correcto.",
      }
    },
  })

  const response = await handlers.POST(new Request("http://localhost/test"))
  assert.equal(response.status, 403)
  assert.equal(testWasCalled, false)
})

test("Andreani cotiza usando únicamente la resolución logística central", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestedUrl = ""
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input) => {
      requestedUrl = String(input)
      return Response.json({
        pesoAforado: "3.50",
        tarifaSinIva: {
          seguroDistribucion: "1",
          distribucion: "10",
          total: "11",
        },
        tarifaConIva: {
          seguroDistribucion: "1.21",
          distribucion: "12.10",
          total: "13.31",
        },
      })
    },
  })

  await client.cotizar({
    codigoPostalOrigen: "2000",
    codigoPostalDestino: "5000",
    contrato: "CONTRATO-QA",
    cliente: "CLIENTE-QA",
    valorDeclarado: 25_000,
    modalidadEntrega: "domicilio",
    producto: {
      id: 30,
      nombre: "Producto para cotizar",
      peso_empaquetado_kg: 1.2,
      alto_paquete_cm: 10,
      ancho_paquete_cm: 20,
      largo_paquete_cm: 30,
    },
    variante: {
      id: 31,
      nombre: "Variante pesada",
      peso_empaquetado_kg: 2.4,
    },
  })

  const url = new URL(requestedUrl)
  assert.equal(url.pathname, "/v1/tarifas")
  assert.equal(url.searchParams.get("bultos[0][kilos]"), "2.4")
  assert.equal(url.searchParams.get("bultos[0][altoCm]"), "10")
  assert.equal(url.searchParams.get("bultos[0][anchoCm]"), "20")
  assert.equal(url.searchParams.get("bultos[0][largoCm]"), "30")
  assert.equal(url.searchParams.get("bultos[0][volumen]"), "6000")
})

test("Andreani no llama a la red si un producto está incompleto", async () => {
  resetAndreaniRuntimeStateForTests()
  let fetchCalls = 0
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async () => {
      fetchCalls += 1
      return Response.json({})
    },
  })

  await assert.rejects(
    () =>
      client.cotizar({
        codigoPostalOrigen: "2000",
        codigoPostalDestino: "5000",
        contrato: "CONTRATO-QA",
        cliente: "CLIENTE-QA",
        valorDeclarado: 25_000,
        modalidadEntrega: "domicilio",
        producto: {
          id: 40,
          nombre: "Producto sin dimensiones",
          peso_empaquetado_kg: 1,
        },
      }),
    (error) =>
      error instanceof AndreaniError &&
      error.code === "VALIDATION_ERROR" &&
      error.message.includes("Producto sin dimensiones"),
  )
  assert.equal(fetchCalls, 0)

  await assert.rejects(
    () =>
      client.crearEnvio({
        envio: {
          contrato: "CONTRATO-QA",
          origen: {
            postal: {
              codigoPostal: "2000",
              calle: "Calle de prueba",
              numero: "100",
              localidad: "Rosario",
            },
          },
          destino: {
            postal: {
              codigoPostal: "5000",
              calle: "Calle de destino",
              numero: "200",
              localidad: "Córdoba",
            },
          },
          remitente: { nombreCompleto: "Remitente de prueba" },
          destinatario: [{ nombreCompleto: "Destinatario de prueba" }],
        },
        items: [
          {
            producto: {
              id: 40,
              nombre: "Producto sin dimensiones",
              peso_empaquetado_kg: 1,
            },
          },
        ],
      }),
    (error) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
  assert.equal(fetchCalls, 0)
})
