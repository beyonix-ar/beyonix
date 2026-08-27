export type AndreaniEnvironment = "QA" | "PROD"

export const ANDREANI_DESTINATION_UNAVAILABLE_MESSAGE =
  "No encontramos envío disponible para este destino."

export type AndreaniErrorCode =
  | "CONFIGURATION_ERROR"
  | "PRODUCTION_BLOCKED"
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_FAILED"
  | "TIMEOUT"
  | "SERVICE_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "REQUEST_FAILED"

export interface AndreaniSafeError {
  code: AndreaniErrorCode
  message: string
  status: number | null
  retryable: boolean
  requestId: string | null
}

export interface AndreaniAuthenticationResponse {
  token: string
  refreshToken?: string
}

export interface AndreaniLocalityFilters {
  localidad?: string
  provincia?: string
  idprovincia?: string
  partido?: string
  /** Códigos postales separados por comas. */
  codigosPostales?: string
  /** Número de página; Andreani informa hasta 2000 localidades por página. */
  p?: string
}

export interface AndreaniLocality {
  idDeProvLocalidad: number
  localidad: string
  provincia: string
  codigosPostales: string[]
}

export type AndreaniPreShipmentStatus =
  | "Pendiente"
  | "Solicitado"
  | "Creado"
  | "Creada"
  | "Rechazado"

export interface AndreaniProductQuoteInput {
  codigoPostalOrigen: string
  codigoPostalDestino: string
  contrato: string
  cliente: string
  codigoSucursalOrigen?: string
  valorDeclarado: number
  modalidadEntrega: "domicilio" | "sucursal"
  producto: ProductLogisticsSource
  variante?: ProductLogisticsSource | null
}

export interface AndreaniPackageQuoteInput {
  codigoPostalDestino: string
  contrato: string
  cliente: string
  codigoSucursalOrigen?: string
  valorDeclarado: number
  pesoKg: number
  volumenCm3: number
  altoCm?: number
  anchoCm?: number
  largoCm?: number
}

export interface AndreaniTariffPackage {
  valorDeclarado?: number
  volumen: number
  kilos?: number
  altoCm?: number
  largoCm?: number
  anchoCm?: number
}

export interface AndreaniTariffRequest {
  cpDestino: string
  contrato: string
  cliente: string
  sucursalOrigen?: string
  bultos: [AndreaniTariffPackage]
}

export type AndreaniTariffResponse = AndreaniQuoteResponse

export interface AndreaniCheckoutQuoteItem {
  productId: number
  quantity: number
  variantId?: number | null
  conditionedStockId?: string | null
}

export interface AndreaniCheckoutQuoteRequest {
  cpDestino: string
  localidad: string
  provincia: string
  items: AndreaniCheckoutQuoteItem[]
  /** Calle y altura del domicilio del cliente -- opcionales, sólo se usan para geocodificar y ordenar sucursales por cercanía real. Nunca afectan la cotización en sí. */
  calle?: string
  numero?: string
}

/** Sucursal Andreani real con la distancia aproximada (Haversine) al domicilio del cliente, cuando se pudo geocodificar. */
export type AndreaniBranchWithDistance = AndreaniBranch & {
  distanciaKm?: number
}

export interface AndreaniCheckoutQuoteOption {
  type: "domicilio" | "sucursal"
  price: number
  /**
   * Sucursales reales disponibles para la localidad destino cotizada -- sólo
   * presente en la opción "sucursal". Ya se consultaban internamente para
   * decidir si ofrecer la modalidad (ver branchesPromise en
   * checkout-quote.ts); acá se exponen, ordenadas por cercanía cuando se
   * pudo geocodificar el domicilio, para que el checkout pueda mostrar un
   * selector real en vez de descartarlas después de comprobar que existían.
   */
  branches?: AndreaniBranchWithDistance[]
}

export interface AndreaniQuoteResponse {
  pesoAforado: string
  tarifaSinIva: {
    seguroDistribucion: string
    distribucion: string
    total: string
  }
  tarifaConIva: {
    seguroDistribucion: string
    distribucion: string
    total: string
  }
}

export interface AndreaniBranchFilters {
  codigo?: string
  sucursal?: string
  region?: string
  localidad?: string
  codigoPostal?: string
  canal?: "B2B" | "B2C"
  seHaceAtencionAlCliente?: boolean
  conBuzonInteligente?: boolean
  numero?: string
}

export interface AndreaniThirdPartyPointFilters
  extends AndreaniBranchFilters {
  contrato: string
  admiteEnvios?: boolean
  entregaEnvios?: boolean
  id?: string
  atencionPorCodigoPostal?: string
}

export interface AndreaniBranch {
  id: number
  codigo: string
  numero: string
  descripcion: string
  canal: string
  direccion: {
    calle?: string
    numero?: string
    provincia: string
    localidad: string
    region: string
    pais: string
    codigoPostal: string
  }
  coordenadas?: {
    latitud: string
    longitud: string
  }
  horarioDeAtencion?: string
  datosAdicionales?: {
    seHaceAtencionAlCliente?: boolean
    conBuzonInteligente?: boolean
    tipo?: string
    admiteEnvios?: boolean
    entregaEnvios?: boolean
  }
  telefonos?: string[]
  codigosPostalesAtendidos?: string[]
}

export interface AndreaniMetadata {
  meta: string
  contenido: string
}

export interface AndreaniPhone<PhoneType extends number = number> {
  tipo: PhoneType
  numero: string
}

export type AndreaniSenderPhoneType = 0 | 1 | 2 | 3

export type AndreaniRecipientPhoneType = 1 | 2 | 3 | 4

export interface AndreaniPostalAddress {
  codigoPostal: string
  calle: string
  numero: string
  piso?: string
  departamento?: string
  localidad: string
  region?: string
  pais?: string
  casillaDeCorreo?: string
  componentesDeDireccion?: AndreaniMetadata[]
}

export interface AndreaniOfficeLocation {
  id: string
  nomenclatura?: string
  descripcion?: string
}

export type AndreaniLocation =
  | { postal: AndreaniPostalAddress; sucursal?: never }
  | { postal?: never; sucursal: AndreaniOfficeLocation }

export interface AndreaniPerson<PhoneType extends number = number> {
  nombreCompleto: string
  email?: string
  documentoTipo?: string
  documentoNumero?: string
  telefonos?: AndreaniPhone<PhoneType>[]
}

export interface AndreaniPackage {
  kilos: number
  largoCm?: number
  altoCm?: number
  anchoCm?: number
  volumenCm: number
  valorDeclaradoSinImpuestos?: number
  valorDeclaradoConImpuestos?: number
  valorDeclarado?: number
  referencias?: AndreaniMetadata[]
  descripcion?: string
  numeroDeEnvio?: string
  ean?: string
}

export interface AndreaniCreateShipmentRequest {
  contrato: string
  tipoDeServicio?: string
  sucursalClienteID?: number
  remitoPDF?: number[]
  origen: AndreaniLocation
  destino: AndreaniLocation
  idPedido?: string
  remitente: AndreaniPerson<AndreaniSenderPhoneType>
  destinatario: AndreaniPerson<AndreaniRecipientPhoneType>[]
  centroDeCostos?: string
  productoAEntregar?: string
  productoARetirar?: string
  tipoProducto?: string
  categoriaFacturacion?: string
  pagoDestino?: number
  valorACobrar?: number
  codigoVerificadorDeEntrega?: string
  remito?: {
    numeroRemito: string
    complementarios: string[]
  }
  fechaDeEntrega?: {
    fecha: string
    horaDesde: string
    horaHasta: string
  }
  bultos: AndreaniPackage[]
  pagoPendienteEnMostrador?: boolean
}

export type AndreaniB2COrderRequest = Omit<
  AndreaniCreateShipmentRequest,
  "bultos"
> & {
  bultos: [AndreaniPackage]
}

export interface AndreaniShipmentBranch {
  nomenclatura?: string
  descripcion?: string
  id?: string
}

export interface AndreaniCreateShipmentResponse {
  estado: AndreaniPreShipmentStatus
  tipo: string
  sucursalDeDistribucion?: AndreaniShipmentBranch
  sucursalDeRendicion?: AndreaniShipmentBranch
  sucursalDeImposicion?: AndreaniShipmentBranch
  sucursalAbastecedora?: AndreaniShipmentBranch
  fechaCreacion?: string
  fechaEstimadaDeEntrega?: string
  zonaDeReparto?: string
  numeroDePermisionaria?: string
  descripcionServicio?: string
  etiquetaRemito?: string
  etiquetasDocumentoDeCambio?: string
  bultos: Array<{
    numeroDeBulto: string
    numeroDeEnvio: string
    totalizador?: string
    linking?: AndreaniMetadata[]
  }>
  agrupadorDeBultos?: string
  etiquetasPorAgrupador?: string
  motivo?: string
  gastoEnergetico?: string
  huellaDeCarbono?: string
}

export interface AndreaniOrderStatusResponse
  extends AndreaniCreateShipmentResponse {
  creada: boolean
}

export interface AndreaniCreateShipmentInput {
  envio: Omit<AndreaniCreateShipmentRequest, "bultos">
  items: Array<{
    producto: ProductLogisticsSource
    variante?: ProductLogisticsSource | null
    bulto?: Omit<
      AndreaniPackage,
      "kilos" | "altoCm" | "anchoCm" | "largoCm" | "volumenCm"
    > & {
      /** Volumen consolidado calculado a partir de todas las unidades del pedido. */
      volumenCm?: number
    }
  }>
}

export interface AndreaniLabelRequest {
  numeroAndreaniOAgrupador: string
  formato?: "pdf" | "zpl"
  bulto?: string
  tipo?: "remito" | "documentoDeCambio"
  id?: string
  lote?: string
  desde?: string
  hasta?: string
}

export interface AndreaniLabelResponse {
  contentType: string
  data: ArrayBuffer
}

export interface AndreaniShipmentDistributionBranch {
  nomenclatura?: string
  descripcion?: string
  id?: number
}

export interface AndreaniShipmentPostalDestination {
  localidad: string
  region?: string
  pais: string
  direccion: string
  codigoPostal: string
}

export interface AndreaniShipmentParty {
  nombreYApellido?: string
  tipoYNumeroDeDocumento?: string
  eMail?: string
}

export interface AndreaniShipmentPackage {
  kilos: number
  valorDeclaradoConImpuestos?: number
  IdDeProducto?: string
  volumen: number
}

export interface AndreaniShipmentStatusResponse {
  numeroDeTracking: string
  contrato: string
  ciclo: string
  estado: string
  estadoId?: number
  fechaEstado: string
  servicio?: string
  sucursalDeDistribucion: AndreaniShipmentDistributionBranch
  fechaCreacion: string
  destino: {
    Postal: AndreaniShipmentPostalDestination
  }
  remitente: AndreaniShipmentParty
  destinatario: AndreaniShipmentParty
  bultos: AndreaniShipmentPackage[]
  idDeProducto?: string
  referencias: string[]
}

export interface AndreaniShipmentSearchFilters {
  numeroDeDocumentoDestinatario?: string
  fechaCreacionDesde?: string
  fechaCreacionHasta?: string
  contrato?: string
  limit?: string
  codigoCliente?: string
  idDeProducto?: string
  actualizadoDesde?: string
  actualizadoHasta?: string
  /** BEYONIX consume únicamente el formato JSON documentado. */
  format?: "JSON"
}

export const ANDREANI_TRACKING_CYCLES = [
  "Distribution",
  "DEVOLUCION",
  "DIRECTO",
  "Drop",
  "Resend",
  "REENVIO",
  "SINIESTRO",
  "LOGISTICA INVERSA",
  "RESCATE",
] as const

export type AndreaniTrackingCycle =
  (typeof ANDREANI_TRACKING_CYCLES)[number]

export const ANDREANI_TRACKING_EVENTS = [
  "Admision",
  "AltaAutomatica",
  "AltaManual",
  "AltaRemota",
  "AsignacionACaja",
  "CambioDeDestino",
  "CierreDeEntidad",
  "ComienzoCustodiaEnSucursal",
  "Destruccion",
  "Distribucion",
  "EnvioAnulado",
  "EnvioConsolidado",
  "EnvioDespachado",
  "EnvioEnInformeDeRendicion",
  "EnvioEntregado",
  "EnvioNoEntregado",
  "EnvioRendido",
  "ExpedicionHojaDeRutaCabecera",
  "ExpedicionHojaDeRutaDeViaje",
  "FaltanBultos",
  "FaltaRemito",
  "FinCustodiaEnSucursal",
  "Impresion",
  "IncorporarMarcaDeCustodia",
  "InicioCicloDeRendicion",
  "InicioEtapaDeGestionTelefonica",
  "IntroduccionDeMotivo",
  "NuevaFechaDeEntregaPactada",
  "NuevaFechaDeEntregaRepactada",
  "OrdenDeEnvioCreada",
  "OrdenDeEnvioRechazada",
  "OrdenDeEnvioSolicitada",
  "PedidoDeDestruccion",
  "RecepcionEnSucursalDestino",
  "RectificacionDeMotivo",
  "Reenvio",
  "RemitoDigitalizado",
  "Rescate",
  "RoturaParcial",
  "RoturaTotal",
  "Siniestro",
  "SolicitudDeRescate",
  "Visita",
  "GestionTelefonica",
] as const

export type AndreaniTrackingEventName =
  (typeof ANDREANI_TRACKING_EVENTS)[number]

export interface AndreaniTrackingEvent {
  Fecha: string
  /** El maestro deja el ciclo vacío para los tres eventos de pre-envío. */
  Ciclo?: AndreaniTrackingCycle
  Evento: AndreaniTrackingEventName
  Motivo?: string
  Submotivo?: string
  Estado?: string
  EstadoId?: number
  Sucursal?: string
  SucursalId?: string
  Comentario?: string
}

export interface AndreaniTrackingResponse {
  eventos: AndreaniTrackingEvent[]
}

export interface AndreaniConnectionTestResult {
  status: "success" | "error"
  environment: "QA"
  testedAt: string
  message: string
}

export interface AndreaniShipmentCreationConfigStatus {
  environment: AndreaniEnvironment | "INVALID"
  configured: boolean
  message: string
}

export interface AndreaniIntegrationStatus {
  environment: AndreaniEnvironment | "INVALID"
  configured: boolean
  message: string
  lastTest: AndreaniConnectionTestResult | null
  shipmentCreation?: AndreaniShipmentCreationConfigStatus
}
import type { ProductLogisticsSource } from "../shipping/product-logistics.ts"
