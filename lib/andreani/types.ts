export type AndreaniEnvironment = "QA" | "PROD"

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
}

export interface AndreaniAuthenticationResponse {
  token: string
  refreshToken?: string
}

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

export interface AndreaniCheckoutQuoteItem {
  productId: number
  quantity: number
  variantId?: number | null
  conditionedStockId?: string | null
}

export interface AndreaniCheckoutQuoteRequest {
  cpDestino: string
  items: AndreaniCheckoutQuoteItem[]
}

export interface AndreaniCheckoutQuoteOption {
  type: "domicilio" | "sucursal"
  price: number
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

export interface AndreaniBranch {
  id: number
  codigo: string
  numero: string
  descripcion: string
  canal: string
  direccion: {
    calle: string
    numero: string
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
  }
  telefonos?: string[]
  codigosPostalesAtendidos?: string[]
}

export interface AndreaniMetadata {
  meta: string
  contenido: string
}

export interface AndreaniPhone {
  tipo: number
  numero: string
}

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

export interface AndreaniLocation {
  postal?: AndreaniPostalAddress
  sucursal?: {
    id: string
    nomenclatura?: string
    descripcion?: string
  }
}

export interface AndreaniPerson {
  nombreCompleto: string
  email?: string
  documentoTipo?: string
  documentoNumero?: string
  telefonos?: AndreaniPhone[]
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
  origen: AndreaniLocation
  destino: AndreaniLocation
  idPedido?: string
  remitente: AndreaniPerson
  destinatario: AndreaniPerson[]
  centroDeCostos?: string
  pagoDestino?: number
  valorACobrar?: number
  codigoVerificadorDeEntrega?: string
  bultos: AndreaniPackage[]
  pagoPendienteEnMostrador?: boolean
}

export interface AndreaniShipmentBranch {
  nomenclatura?: string
  descripcion?: string
  id?: string
}

export interface AndreaniCreateShipmentResponse {
  estado: string
  tipo: string
  sucursalDeDistribucion?: AndreaniShipmentBranch
  sucursalDeRendicion?: AndreaniShipmentBranch
  sucursalDeImposicion?: AndreaniShipmentBranch
  fechaCreacion?: string
  numeroDePermisionaria?: string
  descripcionServicio?: string
  bultos: Array<{
    numeroDeBulto: string
    numeroDeEnvio: string
    totalizador?: string
    linking?: AndreaniMetadata[]
  }>
  agrupadorDeBultos?: string
  etiquetasPorAgrupador?: string
}

export interface AndreaniCreateShipmentInput {
  envio: Omit<AndreaniCreateShipmentRequest, "bultos">
  items: Array<{
    producto: ProductLogisticsSource
    variante?: ProductLogisticsSource | null
    bulto?: Omit<
      AndreaniPackage,
      "kilos" | "altoCm" | "anchoCm" | "largoCm" | "volumenCm"
    >
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

export interface AndreaniTrackingEvent {
  Fecha: string
  Ciclo: string
  Evento: string
  Motivo?: string
  Submotivo?: string
  Estado?: string
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

export interface AndreaniIntegrationStatus {
  environment: AndreaniEnvironment | "INVALID"
  configured: boolean
  message: string
  lastTest: AndreaniConnectionTestResult | null
}
import type { ProductLogisticsSource } from "../shipping/product-logistics.ts"
