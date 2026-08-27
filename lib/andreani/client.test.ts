import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("la prueba de credenciales Andreani no queda expuesta en una ruta pública legacy", () => {
  assert.throws(() =>
    readFileSync(
      new URL("../../app/api/andreani/test-login/route.ts", import.meta.url),
      "utf8",
    ),
  )

  const securedRoute = readFileSync(
    new URL(
      "../../app/api/admin/integrations/andreani/test/route.ts",
      import.meta.url,
    ),
    "utf8",
  )
  assert.match(securedRoute, /requireInternalUser/)
})

import { createAndreaniAdminTestHandlers } from "./admin-test-handler.ts"
import type { AndreaniCreateShipmentInput } from "./types.ts"
import {
  AndreaniClient,
  AndreaniError,
  resetAndreaniRuntimeStateForTests,
  resolveAndreaniConfig,
  sanitizeAndreaniMessage,
  testAndreaniQaConnection,
} from "./client.ts"
import { formatAndreaniBranchAddress } from "./branch-address.ts"

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

const officialLocalityResponse = [
  {
    idDeProvLocalidad: "107362",
    localidad: "PASO DE LOS LIBRES",
    provincia: "CORRIENTES",
    codigosPostales: ["3230"],
  },
]

const officialBranchResponse = [
  {
    id: 10055,
    codigo: "SFN",
    numero: "55",
    descripcion: "SANTA FE (CENTRO)",
    canal: "B2C",
    direccion: {
      calle: "25 de Mayo",
      numero: "3340",
      provincia: "Santa Fe",
      localidad: "Santa Fe",
      region: "Litoral",
      pais: "Argentina",
      codigoPostal: "3000",
    },
    coordenadas: { latitud: "-31.637650", longitud: "-60.703000" },
    horarioDeAtencion:
      "Lunes a Viernes de 08:00 a 18:00 - Sábados de 08:00 a 13:00",
    datosAdicionales: {
      seHaceAtencionAlCliente: true,
      conBuzonInteligente: false,
      tipo: "SUCURSAL",
    },
    telefonos: ["0810-122-1111"],
    codigosPostalesAtendidos: ["2469", "3000"],
  },
]

const officialOrderResponse = {
  estado: "Pendiente",
  tipo: "B2C",
  sucursalDeDistribucion: {
    nomenclatura: "TIG",
    descripcion: "TIGRE (AV PRES J D PERON)",
    id: "96",
  },
  sucursalDeRendicion: {
    nomenclatura: "REN",
    descripcion: "AVELLANEDA - RENDICIONES",
    id: "112",
  },
  sucursalDeImposicion: {},
  sucursalAbastecedora: {},
  fechaCreacion: "2025-11-10T17:29:40-03:00",
  numeroDePermisionaria: "RNPSP Nº 586",
  descripcionServicio: "Encomienda",
  bultos: [
    {
      numeroDeBulto: "1",
      numeroDeEnvio: "360000101651699",
      totalizador: "1/1",
      linking: [
        {
          meta: "Etiqueta",
          contenido:
            "https://apisqa.andreani.com/v2/ordenes-de-envio/API0000000428931/etiquetas?bulto=1",
        },
      ],
    },
  ],
  agrupadorDeBultos: "API0000000428931",
  etiquetasPorAgrupador:
    "https://apisqa.andreani.com/v2/ordenes-de-envio/API0000000428931/etiquetas",
}

const officialShipmentResponse = {
  numeroDeTracking: "360000044179430",
  contrato: "300006611",
  ciclo: "Distribution",
  estado: "Pendiente",
  estadoId: 21,
  fechaEstado: "2021-03-09T11:59:04",
  sucursalDeDistribucion: {
    nomenclatura: "MONSERRAT",
    descripcion: "Monserrat",
    id: 12,
  },
  fechaCreacion: "2021-03-10T11:18:01",
  destino: {
    Postal: {
      localidad: "C.A.B.A.",
      pais: "Argentina",
      direccion: "AV J MANUEL DE ROSAS 380",
      codigoPostal: "1002",
    },
  },
  remitente: {},
  destinatario: {
    nombreYApellido: "Juana Gonzalez",
    tipoYNumeroDeDocumento: "PAS783297632",
    eMail: "destinatario@andreani.com",
  },
  bultos: [
    {
      kilos: 0.005,
      valorDeclaradoConImpuestos: 1452,
      IdDeProducto: "123456789",
      volumen: 0.000005,
    },
  ],
  idDeProducto: "123456789",
  referencias: ["360000044179430", "2", "B", "123456789"],
}

const officialTrackingV3Response = {
  eventos: [
    {
      Fecha: "2025-10-08T12:19:04.054",
      Ciclo: "DIRECTO",
      Evento: "EnvioEntregado",
      Motivo: "Entregado",
      Submotivo: "Entregado en Domicilio de Destinatario",
      Estado: "Entregado",
      Sucursal: "WH MALVINAS ARGENTINAS",
      SucursalId: "128",
      Comentario: "Entregado en domicilio",
    },
  ],
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

test("rechaza una URL PROD aunque esté cargada en las variables QA", () => {
  assert.throws(
    () =>
      resolveAndreaniConfig(
        qaEnvironment({ ANDREANI_QA_API_URL: "https://apis.andreani.com" }),
      ),
    (error) =>
      error instanceof AndreaniError && error.code === "CONFIGURATION_ERROR",
  )
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

test("en PROD permite solo catálogos públicos además de login y tarifas", async () => {
  resetAndreaniRuntimeStateForTests()
  let networkCalls = 0
  const authorizationTokens: Array<string | null> = []
  const client = new AndreaniClient({
    env: {
      NODE_ENV: "test",
      ANDREANI_ENV: "PROD",
      ANDREANI_PROD_API_URL: "https://apis.andreani.com",
      ANDREANI_PROD_USERNAME: "usuario-prod-prueba",
      ANDREANI_PROD_PASSWORD: "clave-prod-prueba",
    },
    productionAccess: "tariffs-only",
    fetch: async (input, init) => {
      networkCalls += 1
      authorizationTokens.push(
        new Headers(init?.headers).get("x-authorization-token"),
      )
      return Response.json(
        new URL(String(input)).pathname === "/v1/localidades"
          ? officialLocalityResponse
          : officialBranchResponse,
      )
    },
  })

  assert.equal(
    (await client.getLocalidades({ codigosPostales: "3013" })).length,
    1,
  )
  assert.equal(
    (await client.getSucursales({ canal: "B2C" })).length,
    1,
  )
  await assert.rejects(
    () => client.getPuntosDeTercero({ contrato: "CONTRATO-PROD" }),
    (error) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  assert.equal(networkCalls, 2)
  assert.deepEqual(authorizationTokens, [null, null])
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
  let authorizationHeader: string | null = null
  let contentTypeHeader: string | null = null
  let requestBody: BodyInit | null | undefined
  const env = qaEnvironment()
  const result = await testAndreaniQaConnection({
    env,
    fetch: async (input, init) => {
      requestedUrl = String(input)
      requestedMethod = init?.method ?? ""
      requestBody = init?.body
      const headers = new Headers(init?.headers)
      authorizationHeader = headers.get("authorization")
      contentTypeHeader = headers.get("content-type")
      return Response.json({ token: ["token", "de", "prueba"].join("-") })
    },
  })

  assert.equal(result.status, "success")
  assert.equal(result.environment, "QA")
  assert.equal(requestedUrl, "https://apisqa.andreani.com/login")
  assert.equal(requestedMethod, "GET")
  assert.equal(
    authorizationHeader,
    `Basic ${Buffer.from(
      `${env.ANDREANI_QA_USERNAME}:${env.ANDREANI_QA_PASSWORD}`,
      "utf8",
    ).toString("base64")}`,
  )
  assert.equal(contentTypeHeader, null)
  assert.equal(requestBody, undefined)
  assert.deepEqual(Object.keys(result).sort(), [
    "environment",
    "message",
    "status",
    "testedAt",
  ])
})

test("acepta el token en el header sin cuerpo de respuesta", async () => {
  resetAndreaniRuntimeStateForTests()
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async () =>
      new Response(null, {
        status: 200,
        headers: {
          "x-authorization-token": ["token", "en", "header"].join("-"),
        },
      }),
  })

  assert.equal(await client.authenticate(), "token-en-header")
})

test("reutiliza el token durante su vigencia de 24 horas", async () => {
  resetAndreaniRuntimeStateForTests()
  let now = 0
  let authenticationCalls = 0
  const client = new AndreaniClient({
    env: qaEnvironment(),
    now: () => now,
    fetch: async () => {
      authenticationCalls += 1
      return Response.json({ token: `token-${authenticationCalls}` })
    },
  })

  assert.equal(await client.authenticate(), "token-1")
  now = 23 * 60 * 60 * 1000
  assert.equal(await client.authenticate(), "token-1")
  assert.equal(authenticationCalls, 1)

  now = 24 * 60 * 60 * 1000
  assert.equal(await client.authenticate(), "token-2")
  assert.equal(authenticationCalls, 2)
})

test("construye los QueryParams oficiales de localidades sin autenticación", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestedUrl = ""
  let authorizationToken: string | null = null
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      requestedUrl = String(input)
      authorizationToken = new Headers(init?.headers).get(
        "x-authorization-token",
      )
      return Response.json(officialLocalityResponse)
    },
  })

  const localidades = await client.getLocalidades({
    localidad: "PASO DE LOS LIBRES",
    provincia: "CORRIENTES",
    idprovincia: "18",
    partido: "PASO DE LOS LIBRES",
    codigosPostales: "3230,3232",
    p: "2",
  })

  const url = new URL(requestedUrl)
  assert.equal(url.pathname, "/v1/localidades")
  assert.deepEqual(
    [...url.searchParams.entries()],
    [
      ["localidad", "PASO DE LOS LIBRES"],
      ["provincia", "CORRIENTES"],
      ["idprovincia", "18"],
      ["partido", "PASO DE LOS LIBRES"],
      ["codigosPostales", "3230,3232"],
      ["p", "2"],
    ],
  )
  assert.equal(authorizationToken, null)
  assert.deepEqual(localidades, [
    { ...officialLocalityResponse[0], idDeProvLocalidad: 107362 },
  ])
})

test("consulta sucursales QA sin enviar autenticación", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestedUrl = ""
  let authorizationToken: string | null = null
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      requestedUrl = String(input)
      authorizationToken = new Headers(init?.headers).get(
        "x-authorization-token",
      )
      return Response.json(officialBranchResponse)
    },
  })

  const sucursales = await client.getSucursales({
    canal: "B2C",
    localidad: "Santa Fe",
    seHaceAtencionAlCliente: true,
  })

  const url = new URL(requestedUrl)
  assert.equal(url.pathname, "/v2/sucursales")
  assert.equal(url.searchParams.get("canal"), "B2C")
  assert.equal(url.searchParams.get("localidad"), "Santa Fe")
  assert.equal(url.searchParams.get("seHaceAtencionAlCliente"), "true")
  assert.equal(authorizationToken, null)
  assert.equal(sucursales.length, 1)
  assert.equal(sucursales[0]?.codigo, "SFN")
  assert.equal(sucursales[0]?.direccion.codigoPostal, "3000")
})

async function parseSingleBranch(payload: unknown) {
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async () => Response.json(payload),
  })
  return (await client.getSucursales({ canal: "B2C" }))[0]
}

test("parseBranches conserva una sucursal con dirección completa", async () => {
  const branch = await parseSingleBranch(officialBranchResponse)

  assert.equal(branch?.direccion.calle, "25 de Mayo")
  assert.equal(branch?.direccion.numero, "3340")
  assert.equal(formatAndreaniBranchAddress(branch!.direccion), "25 de Mayo 3340")
})

test("parseBranches conserva una sucursal sin número de calle", async () => {
  const payload = structuredClone(officialBranchResponse)
  Reflect.deleteProperty(payload[0]!.direccion, "numero")

  const branch = await parseSingleBranch(payload)

  assert.equal(branch?.direccion.calle, "25 de Mayo")
  assert.equal(branch?.direccion.numero, undefined)
  assert.equal(formatAndreaniBranchAddress(branch!.direccion), "25 de Mayo")
})

test("parseBranches conserva una sucursal sin calle y normaliza un número real numérico", async () => {
  const payload = structuredClone(officialBranchResponse)
  Reflect.deleteProperty(payload[0]!.direccion, "calle")
  Reflect.set(payload[0]!.direccion, "numero", 3340)

  const branch = await parseSingleBranch(payload)

  assert.equal(branch?.direccion.calle, undefined)
  assert.equal(branch?.direccion.numero, "3340")
  assert.equal(branch?.id, 10055)
  assert.equal(branch?.codigo, "SFN")
})

test("parseBranches conserva campos territoriales reales con calle y número ausentes", async () => {
  const payload = structuredClone(officialBranchResponse)
  Reflect.set(payload[0]!.direccion, "calle", null)
  Reflect.set(payload[0]!.direccion, "numero", "")

  const branch = await parseSingleBranch(payload)

  assert.deepEqual(branch?.direccion, {
    calle: undefined,
    numero: undefined,
    provincia: "Santa Fe",
    localidad: "Santa Fe",
    region: "Litoral",
    pais: "Argentina",
    codigoPostal: "3000",
  })
  assert.deepEqual(branch?.coordenadas, {
    latitud: "-31.637650",
    longitud: "-60.703000",
  })
  assert.equal(
    formatAndreaniBranchAddress(branch!.direccion),
    "Santa Fe, Santa Fe, CP 3000",
  )
})

test("parseBranches rechaza una sucursal sin localidad verificable", async () => {
  const payload = structuredClone(officialBranchResponse)
  Reflect.deleteProperty(payload[0]!.direccion, "localidad")

  await assert.rejects(
    () => parseSingleBranch(payload),
    (error) =>
      error instanceof AndreaniError && error.code === "INVALID_RESPONSE",
  )
})

test("consulta puntos de tercero por contrato con autenticación", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestedUrl = ""
  let authorizationToken: string | null = null
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-puntos" })
      }
      requestedUrl = String(input)
      authorizationToken = new Headers(init?.headers).get(
        "x-authorization-token",
      )
      return Response.json(officialBranchResponse)
    },
  })

  await client.getPuntosDeTercero({
    contrato: "300006611",
    admiteEnvios: true,
    entregaEnvios: true,
    canal: "B2C",
  })

  const url = new URL(requestedUrl)
  assert.equal(url.pathname, "/v2/puntos-de-tercero")
  assert.equal(url.searchParams.get("contrato"), "300006611")
  assert.equal(url.searchParams.get("admiteEnvios"), "true")
  assert.equal(url.searchParams.get("entregaEnvios"), "true")
  assert.equal(authorizationToken, "token-puntos")
})

test("reutiliza la autenticación en endpoints protegidos", async () => {
  resetAndreaniRuntimeStateForTests()
  let authenticationCalls = 0
  const protectedRequests: Array<{ url: string; token: string | null }> = []
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/login")) {
        authenticationCalls += 1
        return Response.json({ token: "token-reutilizable" })
      }

      protectedRequests.push({
        url,
        token: new Headers(init?.headers).get("x-authorization-token"),
      })
      return url.includes("/ordenes-de-envio/")
        ? Response.json({ ...officialOrderResponse, estado: "Creada" })
        : Response.json(officialShipmentResponse)
    },
  })

  const orden = await client.getEstadoOrden("360000000000001")
  await client.getEstadoEnvio("360000000000001")

  assert.equal(orden.creada, true)
  assert.equal(authenticationCalls, 1)
  assert.deepEqual(
    protectedRequests.map(({ token }) => token),
    ["token-reutilizable", "token-reutilizable"],
  )
  assert.deepEqual(
    protectedRequests.map(({ url }) => new URL(url).pathname),
    [
      "/v2/ordenes-de-envio/360000000000001",
      "/v2/envios/360000000000001",
    ],
  )
})

test("reconoce todos los estados de pre-envío documentados", async () => {
  resetAndreaniRuntimeStateForTests()
  const states = [
    "Pendiente",
    "Solicitado",
    "Creado",
    "Creada",
    "Rechazado",
  ] as const
  let stateIndex = 0
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-estados" })
      }
      return Response.json({
        ...officialOrderResponse,
        estado: states[stateIndex++],
      })
    },
  })

  const results = []
  for (let index = 0; index < states.length; index += 1) {
    results.push(await client.getEstadoOrden("360000101651699"))
  }

  assert.deepEqual(
    results.map(({ estado, creada }) => ({ estado, creada })),
    [
      { estado: "Pendiente", creada: false },
      { estado: "Solicitado", creada: false },
      { estado: "Creado", creada: true },
      { estado: "Creada", creada: true },
      { estado: "Rechazado", creada: false },
    ],
  )
})

test("recupera etiquetas por la ruta documentada", async () => {
  resetAndreaniRuntimeStateForTests()
  let labelPath = ""
  let labelAccept: string | null = null
  let labelToken: string | null = null
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/login")) {
        return Response.json({ token: "token-etiqueta" })
      }

      labelPath = new URL(url).pathname
      const headers = new Headers(init?.headers)
      labelAccept = headers.get("accept")
      labelToken = headers.get("x-authorization-token")
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "content-type": "application/pdf" },
      })
    },
  })

  const etiqueta = await client.getEtiquetas("API0000000428931")

  assert.equal(
    labelPath,
    "/v2/ordenes-de-envio/API0000000428931/etiquetas",
  )
  assert.equal(labelAccept, null)
  assert.equal(labelToken, "token-etiqueta")
  assert.equal(etiqueta.contentType, "application/pdf")
  assert.deepEqual(
    Array.from(new Uint8Array(etiqueta.data)),
    [37, 80, 68, 70],
  )
})

test("solicita ZPL únicamente mediante el header Accept documentado", async () => {
  resetAndreaniRuntimeStateForTests()
  let acceptHeader: string | null = null
  let requestedUrl = ""
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-zpl" })
      }
      requestedUrl = String(input)
      acceptHeader = new Headers(init?.headers).get("accept")
      return new Response("^XA^XZ", {
        headers: { "content-type": "application/zpl" },
      })
    },
  })

  await client.obtenerEtiqueta({
    numeroAndreaniOAgrupador: "API0000000428931",
    formato: "zpl",
    bulto: "1",
  })

  const url = new URL(requestedUrl)
  assert.equal(
    url.pathname,
    "/v2/ordenes-de-envio/API0000000428931/etiquetas",
  )
  assert.equal(url.searchParams.get("bulto"), "1")
  assert.equal(acceptHeader, "application/zpl")
})

test("maneja un 401 de un endpoint protegido sin filtrar su respuesta", async () => {
  resetAndreaniRuntimeStateForTests()
  let protectedToken: string | null = null
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-protegido" })
      }
      protectedToken = new Headers(init?.headers).get(
        "x-authorization-token",
      )
      return new Response("respuesta externa confidencial", { status: 401 })
    },
  })

  await assert.rejects(
    () => client.getEstadoEnvio("360000000000001"),
    (error) =>
      error instanceof AndreaniError &&
      error.code === "AUTHENTICATION_FAILED" &&
      !error.message.includes("confidencial"),
  )
  assert.equal(protectedToken, "token-protegido")
})

test("normaliza errores del servicio Andreani", async () => {
  resetAndreaniRuntimeStateForTests()
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async () =>
      new Response("detalle interno de Andreani", { status: 503 }),
  })

  await assert.rejects(
    () => client.getSucursales(),
    (error) =>
      error instanceof AndreaniError &&
      error.code === "SERVICE_UNAVAILABLE" &&
      error.retryable &&
      !error.message.includes("detalle interno"),
  )
})

test("busca envíos con los QueryParams oficiales", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestedUrl = ""
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-busqueda" })
      }
      requestedUrl = String(input)
      return Response.json(officialShipmentResponse)
    },
  })

  const envio = await client.buscarEnvio({
    contrato: "400006968",
    numeroDeDocumentoDestinatario: "31139666",
    fechaCreacionDesde: "2021-11-19T00:00:00",
    fechaCreacionHasta: "2021-11-20T00:00:00",
    idDeProducto: "dsd949216-01",
    actualizadoDesde: "2021-12-16T00:00:00",
    actualizadoHasta: "2021-12-17T00:00:00",
    limit: "1000",
    format: "JSON",
  })

  const url = new URL(requestedUrl)
  assert.equal(url.pathname, "/v2/envios")
  assert.equal(url.searchParams.get("contrato"), "400006968")
  assert.equal(url.searchParams.get("numeroDeDocumentoDestinatario"), "31139666")
  assert.equal(url.searchParams.get("limit"), "1000")
  assert.equal(url.searchParams.get("format"), "JSON")
  assert.equal(envio.numeroDeTracking, "360000044179430")
})

test("consulta trazas mediante PULL v3", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestedPath = ""
  let authorizationToken: string | null = null
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-tracking-v3" })
      }
      requestedPath = new URL(String(input)).pathname
      authorizationToken = new Headers(init?.headers).get(
        "x-authorization-token",
      )
      return Response.json(officialTrackingV3Response)
    },
  })

  const tracking = await client.getTrackingPullV3("360000044179430")

  assert.equal(requestedPath, "/v3/envios/360000044179430/trazas")
  assert.equal(authorizationToken, "token-tracking-v3")
  assert.equal(tracking.eventos.length, 1)
  assert.equal(tracking.eventos[0]?.Ciclo, "DIRECTO")
  assert.equal(tracking.eventos[0]?.Evento, "EnvioEntregado")
  assert.equal(
    tracking.eventos[0]?.Submotivo,
    "Entregado en Domicilio de Destinatario",
  )
})

for (const status of [400, 404] as const) {
  test(`normaliza el error HTTP ${status} documentado por Andreani`, async () => {
    resetAndreaniRuntimeStateForTests()
    const client = new AndreaniClient({
      env: qaEnvironment(),
      fetch: async () =>
        Response.json(
          {
            type: "about:blank",
            title: "Error de validación",
            detail: "Detalle externo",
            status,
            errors: null,
          },
          { status },
        ),
    })

    await assert.rejects(
      () => client.getSucursales(),
      (error) =>
        error instanceof AndreaniError &&
        error.code === "REQUEST_FAILED" &&
        error.status === status &&
        error.message === "Detalle externo",
    )
  })
}

test("conserva el detalle sanitizado de un 4xx y descarta el body completo", async () => {
  resetAndreaniRuntimeStateForTests()
  const env = qaEnvironment()
  const client = new AndreaniClient({
    env,
    fetch: async () =>
      Response.json(
        {
          type: "about:blank",
          title: "Error al generar alta de la orden",
          detail: `Numero de contrato 400042104 no existe. token secreto=${env.ANDREANI_QA_PASSWORD}`,
          status: 400,
          errors: null,
        },
        { status: 400 },
      ),
  })

  await assert.rejects(
    () => client.getSucursales(),
    (error) =>
      error instanceof AndreaniError &&
      error.status === 400 &&
      error.message.startsWith("Numero de contrato 400042104 no existe.") &&
      !error.message.includes(env.ANDREANI_QA_PASSWORD as string),
  )
})

test("sin detail ni title conserva el mensaje genérico", async () => {
  resetAndreaniRuntimeStateForTests()
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async () => Response.json({ type: "about:blank", status: 422 }, { status: 422 }),
  })

  await assert.rejects(
    () => client.getSucursales(),
    (error) =>
      error instanceof AndreaniError &&
      error.status === 422 &&
      error.message === "Andreani rechazó la solicitud.",
  )
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
  let requestedToken: string | null = null
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-tarifa" })
      }
      requestedUrl = String(input)
      requestedToken = new Headers(init?.headers).get("x-authorization-token")
      return Response.json({
        pesoAforado: "70.00",
        tarifaSinIva: {
          seguroDistribucion: "12.21",
          distribucion: "5806.97",
          total: "5819.18",
        },
        tarifaConIva: {
          seguroDistribucion: "14.77",
          distribucion: "7026.43",
          total: "7041.21",
        },
      })
    },
  })

  await client.cotizar({
    codigoPostalOrigen: "2000",
    codigoPostalDestino: "5000",
    contrato: "CONTRATO-QA",
    cliente: "CLIENTE-QA",
    codigoSucursalOrigen: "RAC",
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
  assert.equal(url.searchParams.get("sucursalOrigen"), "RAC")
  assert.equal(requestedToken, "token-tarifa")
})

test("cotiza con el contrato oficial y omite parámetros opcionales", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestedUrl = ""
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-tarifa-opcional" })
      }
      requestedUrl = String(input)
      return Response.json({
        pesoAforado: "1.00",
        tarifaSinIva: {
          seguroDistribucion: "0.00",
          distribucion: "100.00",
          total: "100.00",
        },
        tarifaConIva: {
          seguroDistribucion: "0.00",
          distribucion: "121.00",
          total: "121.00",
        },
      })
    },
  })

  const quote = await client.cotizarEnvio({
    cpDestino: "5000",
    contrato: "CONTRATO-QA",
    cliente: "CLIENTE-QA",
    bultos: [{ volumen: 6000 }],
  })

  const url = new URL(requestedUrl)
  assert.equal(url.pathname, "/v1/tarifas")
  assert.equal(url.searchParams.get("bultos[0][volumen]"), "6000")
  assert.equal(url.searchParams.has("bultos[0][valorDeclarado]"), false)
  assert.equal(url.searchParams.has("bultos[0][kilos]"), false)
  assert.equal(url.searchParams.has("sucursalOrigen"), false)
  assert.equal(quote.tarifaConIva.total, "121.00")
})

test("rechaza una respuesta incompleta del cotizador", async () => {
  resetAndreaniRuntimeStateForTests()
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input) =>
      String(input).endsWith("/login")
        ? Response.json({ token: "token-tarifa-invalida" })
        : Response.json({ pesoAforado: "1.00" }),
  })

  await assert.rejects(
    () =>
      client.cotizarEnvio({
        cpDestino: "5000",
        contrato: "CONTRATO-QA",
        cliente: "CLIENTE-QA",
        bultos: [{ volumen: 6000 }],
      }),
    (error) =>
      error instanceof AndreaniError && error.code === "INVALID_RESPONSE",
  )
})

test("shipment-read habilita consultas operativas PROD y conserva públicos los catálogos", async () => {
  resetAndreaniRuntimeStateForTests()
  const requestedPaths: string[] = []
  const client = new AndreaniClient({
    env: {
      NODE_ENV: "test",
      ANDREANI_ENV: "PROD",
      ANDREANI_PROD_API_URL: "https://apis.andreani.com",
      ANDREANI_PROD_USERNAME: "usuario-prod-prueba",
      ANDREANI_PROD_PASSWORD: "clave-prod-prueba",
    },
    productionAccess: "shipment-read",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname
      requestedPaths.push(path)
      if (path === "/login") return Response.json({ token: "token-prod-read" })
      if (path.endsWith("/etiquetas")) {
        return new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: { "content-type": "application/pdf" },
        })
      }
      return Response.json(officialTrackingV3Response)
    },
  })

  await client.getTrackingPullV3("360000044179430")
  await client.getEtiquetas("API0000000428931")
  await assert.rejects(
    () =>
      client.cotizarEnvio({
        cpDestino: "3013",
        contrato: "CONTRATO-PROD",
        cliente: "CLIENTE-PROD",
        bultos: [{ volumen: 1_000 }],
      }),
    (error: unknown) =>
      error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )

  assert.deepEqual(requestedPaths, [
    "/login",
    "/v3/envios/360000044179430/trazas",
    "/v2/ordenes-de-envio/API0000000428931/etiquetas",
  ])
})

test("serializa una orden B2C según el ejemplo oficial", async () => {
  resetAndreaniRuntimeStateForTests()
  let requestBody = ""
  let requestMethod = ""
  let requestToken: string | null = null
  let responseStatus = 202
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async (input, init) => {
      if (String(input).endsWith("/login")) {
        return Response.json({ token: "token-orden" })
      }
      requestMethod = init?.method ?? ""
      requestBody = String(init?.body ?? "")
      requestToken = new Headers(init?.headers).get("x-authorization-token")
      return Response.json(officialOrderResponse, { status: responseStatus })
    },
  })

  const input: AndreaniCreateShipmentInput = {
    envio: {
      contrato: "300006611",
      origen: {
        postal: {
          codigoPostal: "3378",
          calle: "Av Falsa",
          numero: "380",
          localidad: "Puerto Esperanza",
          region: "",
          pais: "Argentina",
          componentesDeDireccion: [
            { meta: "entreCalle", contenido: "Medina y Jualberto" },
          ],
        },
      },
      destino: {
        postal: {
          codigoPostal: "1292",
          calle: "Macacha Guemes",
          numero: "28",
          localidad: "C.A.B.A.",
          region: "AR-B",
          pais: "Argentina",
          componentesDeDireccion: [
            { meta: "piso", contenido: "2" },
            { meta: "departamento", contenido: "B" },
          ],
        },
      },
      remitente: {
        nombreCompleto: "Alberto Lopez",
        email: "remitente@andreani.com",
        documentoTipo: "DNI",
        documentoNumero: "33111222",
        telefonos: [{ tipo: 1, numero: "113332244" }],
      },
      destinatario: [
        {
          nombreCompleto: "Juana Gonzalez",
          email: "destinatario@andreani.com",
          documentoTipo: "DNI",
          documentoNumero: "33999888",
          telefonos: [{ tipo: 1, numero: "1112345678" }],
        },
      ],
    },
    items: [
      {
        producto: {
          id: 1,
          nombre: "Secador de pelo",
          peso_empaquetado_kg: 2,
          alto_paquete_cm: 50,
          ancho_paquete_cm: 10,
          largo_paquete_cm: 10,
        },
        bulto: {
          valorDeclaradoSinImpuestos: 1200,
          valorDeclaradoConImpuestos: 1452,
          referencias: [
            { meta: "detalle", contenido: "Secador de pelo" },
            { meta: "idCliente", contenido: "10000" },
            { meta: "observaciones", contenido: "color negro" },
          ],
        },
      },
    ],
  }
  const response = await client.crearEnvio(input)

  const serialized = JSON.parse(requestBody) as {
    bultos: Array<Record<string, unknown>>
  }
  assert.equal(requestMethod, "POST")
  assert.equal(requestToken, "token-orden")
  assert.deepEqual(serialized.bultos, [
    {
      valorDeclaradoSinImpuestos: 1200,
      valorDeclaradoConImpuestos: 1452,
      referencias: [
        { meta: "detalle", contenido: "Secador de pelo" },
        { meta: "idCliente", contenido: "10000" },
        { meta: "observaciones", contenido: "color negro" },
      ],
      kilos: 2,
      altoCm: 50,
      anchoCm: 10,
      largoCm: 10,
      volumenCm: 5000,
    },
  ])
  assert.equal(response.estado, "Pendiente")
  assert.equal(response.agrupadorDeBultos, "API0000000428931")

  responseStatus = 208
  const alreadyReported = await client.crearEnvio(input)
  assert.equal(alreadyReported.agrupadorDeBultos, "API0000000428931")
})

test("rechaza órdenes que no cumplen el límite B2C", async () => {
  resetAndreaniRuntimeStateForTests()
  let fetchCalls = 0
  const client = new AndreaniClient({
    env: qaEnvironment(),
    fetch: async () => {
      fetchCalls += 1
      return Response.json(officialOrderResponse)
    },
  })
  const envio = {
    contrato: "300006611",
    origen: {
      postal: {
        codigoPostal: "3378",
        calle: "Av Falsa",
        numero: "380",
        localidad: "Puerto Esperanza",
      },
    },
    destino: {
      postal: {
        codigoPostal: "1292",
        calle: "Macacha Guemes",
        numero: "28",
        localidad: "C.A.B.A.",
      },
    },
    remitente: { nombreCompleto: "Alberto Lopez" },
    destinatario: [{ nombreCompleto: "Juana Gonzalez" }],
  }

  await assert.rejects(
    () =>
      client.crearEnvio({
        envio,
        items: [
          {
            producto: {
              id: 2,
              nombre: "Bulto fuera del límite",
              peso_empaquetado_kg: 50.001,
              alto_paquete_cm: 50,
              ancho_paquete_cm: 10,
              largo_paquete_cm: 10,
            },
          },
        ],
      }),
    (error) =>
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR",
  )
  assert.equal(fetchCalls, 0)
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
