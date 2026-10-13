// Registro único de íconos de especificaciones, compartido por Admin y tienda.
//
// - `name` (iconName): identificador técnico estable; es lo único que se
//   guarda en `producto_especificaciones.icono`.
// - `label` (defaultLabel): nombre base del catálogo.
// - El nombre visible en Admin (displayLabel) = alias guardado ?? defaultLabel.
// - La tienda muestra ícono + `texto` de la especificación; nunca un label.
//
// Cada entrada del catálogo usa un dibujo distinto y un nombre normalizado
// único (lo verifican los tests).
import {
  Accessibility, Activity, AirVent, AlarmClock, Anchor, AppWindow, Archive, Armchair, ArrowDownUp, Atom, AudioLines,
  Award, Baby, Backpack, BadgeCheck, BadgePercent, Barcode, Bath, Battery, BatteryCharging, BatteryFull, BatteryLow,
  Beaker, BedDouble, Bell, BicepsFlexed, Bike, Bluetooth, BookOpen, Box, BriefcaseBusiness, Brush, Cable, Calculator,
  CalendarDays, Camera, Car, ChartNoAxesCombined, Check, ChefHat, CircuitBoard, Clipboard, Clock, Cloud, CloudDownload,
  Coffee, Compass, Contact, CookingPot, Cpu, CreditCard, Crosshair, CupSoda, Database, Disc3, Dog, DoorOpen, Download,
  Drill, Droplets, Dumbbell, Ear, Fan, Feather, FileText, Flame, FlaskConical, FlaskRound, Flashlight, Flower2,
  FoldHorizontal, FolderOpen, Footprints, Fuel, Gamepad2, Gauge, Gift, GlassWater, Globe, GraduationCap, Grip, Hammer,
  Hand, HardDrive, Headphones, Headset, Heart, Heater, Home, Hourglass, Image, Key, Keyboard, Lamp, LampDesk, Laptop,
  Layers3, LayoutGrid, Leaf, Lightbulb, Link2, ListChecks, Lock, LockKeyhole, Magnet, MapPin, Maximize, Medal,
  MemoryStick, MessageCircle, Mic, Microwave, Milk, Minimize2, Monitor, MonitorUp, Mountain, Mouse, MousePointer2,
  Move3d, Music, Navigation, Network, Notebook, NotebookPen, Package, PackageCheck, Paintbrush, Palette, PanelTop,
  PanelsTopLeft, Paperclip, PenTool, Phone, Pin, Plane, Plug, PlugZap, PocketKnife, Printer, Projector, Puzzle, Radio,
  Recycle, RefreshCcw, Repeat, Rocket, Rotate3d, Router, Ruler, Scan, ScanFace, Scissors, Settings, Shield,
  ShieldCheck, Shirt, SlidersHorizontal, Smartphone, Smile, Snowflake, Sofa, Sparkles, Speaker, Sprout, Star, Sun,
  Tablet, Tent, Thermometer, Timer, Truck, Tv, Umbrella, Usb, UtensilsCrossed, Video, Volume2, Watch, Waves, Weight,
  Wifi, Wind, Wine, Wrench, Zap,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

export interface SpecIconOption {
  name: string
  label: string
  keywords: readonly string[]
  Icon: LucideIcon
}

const entry = (name: string, Icon: LucideIcon, label: string, ...keywords: string[]): SpecIconOption =>
  ({ name, Icon, label, keywords })

/** Catálogo ofrecido en el selector: un dibujo y un nombre únicos por entrada. */
export const SPEC_ICON_CATALOG: readonly SpecIconOption[] = [
  entry("Box", Box, "Capacidad", "almacenamiento", "contenido", "caja"),
  entry("ShieldCheck", ShieldCheck, "Seguridad", "seguro", "certificado", "protección verificada"),
  entry("Shield", Shield, "Protección", "resguardo", "defensa", "cubierta"),
  entry("Hammer", Hammer, "Durabilidad", "vida útil", "robusto", "golpes"),
  entry("Zap", Zap, "Potencia", "energía", "watts", "carga rápida"),
  entry("PlugZap", PlugZap, "Voltaje", "voltios", "220 v", "electricidad", "alimentación"),
  entry("BatteryFull", BatteryFull, "Autonomía", "duración", "batería completa", "horas"),
  entry("BicepsFlexed", BicepsFlexed, "Resistencia", "fuerza", "solidez", "carga máxima"),
  entry("Beaker", Beaker, "Volumen", "litros", "mililitros", "capacidad líquida"),
  entry("Weight", Weight, "Peso", "kilogramos", "gramos", "kg"),
  entry("Layers3", Layers3, "Material", "composición", "fabricación", "capas", "construcción"),
  entry("Thermometer", Thermometer, "Temperatura", "grados", "térmico", "medición"),
  entry("Droplets", Droplets, "Impermeable", "agua", "resistente al agua", "salpicaduras"),
  entry("Move3d", Move3d, "Flexible", "movilidad", "adaptable", "articulado"),
  entry("SlidersHorizontal", SlidersHorizontal, "Ajustable", "regulable", "configurable", "personalizable"),
  entry("FoldHorizontal", FoldHorizontal, "Plegable", "plegar", "cerrar", "guardar"),
  entry("Backpack", Backpack, "Portátil", "transportable", "mochila", "llevar"),
  entry("Minimize2", Minimize2, "Compacto", "pequeño", "reducido", "ocupa poco"),
  entry("ChartNoAxesCombined", ChartNoAxesCombined, "Rendimiento", "desempeño", "eficiencia", "estadísticas"),
  entry("Gauge", Gauge, "Velocidad", "rápido", "rpm", "medidor"),
  entry("Network", Network, "Conectividad", "red", "conexión", "hub", "puertos"),
  entry("BadgeCheck", BadgeCheck, "Garantía", "respaldo", "oficial", "verificado"),
  entry("Award", Award, "Calidad", "premium", "certificación", "distinción"),
  entry("LayoutGrid", LayoutGrid, "Organización", "orden", "compartimentos", "divisiones"),
  entry("Armchair", Armchair, "Ergonomía", "comodidad", "postura", "apoyo"),
  entry("AudioLines", AudioLines, "Audio", "sonido", "estéreo"),
  entry("Video", Video, "Video", "grabación", "filmación", "hd"),
  entry("Camera", Camera, "Cámara", "foto", "fotografía", "lente"),
  entry("Battery", Battery, "Batería", "pila", "energía", "inalámbrico"),
  entry("Usb", Usb, "USB", "puerto usb", "conector", "usb-a"),
  entry("Cable", Cable, "USB-C", "tipo c", "cable", "carga"),
  entry("Bluetooth", Bluetooth, "Bluetooth", "inalámbrico", "emparejar"),
  entry("Wifi", Wifi, "Wi-Fi", "internet", "wireless", "red inalámbrica"),
  entry("Car", Car, "Auto", "vehículo", "automóvil", "12 v"),
  entry("Home", Home, "Hogar", "casa", "doméstico"),
  entry("CookingPot", CookingPot, "Cocina", "olla", "gastronomía", "alimentos"),
  entry("BriefcaseBusiness", BriefcaseBusiness, "Oficina", "trabajo", "escritorio", "profesional"),
  entry("Tent", Tent, "Camping", "carpa", "aire libre", "acampar"),
  entry("Plane", Plane, "Viaje", "equipaje", "vuelo", "turismo"),
  entry("Wrench", Wrench, "Herramientas", "taller", "llave", "bricolaje"),
  entry("Gamepad2", Gamepad2, "Gaming", "videojuegos", "consola", "joystick"),
  entry("Dumbbell", Dumbbell, "Fitness", "gimnasio", "entrenamiento", "ejercicio"),
  entry("Coffee", Coffee, "Mate", "taza", "infusión", "bombilla", "café"),
  entry("Milk", Milk, "Botella", "envase", "recipiente"),
  entry("FlaskRound", FlaskRound, "Termo", "térmico", "bebida caliente"),
  entry("Laptop", Laptop, "Notebook", "laptop", "computadora portátil"),
  entry("MonitorUp", MonitorUp, "Soporte para notebook", "elevador", "altura", "soporte"),
  entry("HardDrive", HardDrive, "Almacenamiento de datos", "disco", "transferencia", "gb"),
  entry("BatteryCharging", BatteryCharging, "Batería recargable", "recarga", "cargando"),
  entry("Headphones", Headphones, "Auriculares", "vincha", "música"),
  entry("Headset", Headset, "Auricular con micrófono", "llamadas", "gamer"),
  entry("Mic", Mic, "Micrófono", "voz", "grabar voz"),
  entry("Volume2", Volume2, "Control de volumen", "volumen de sonido", "subir volumen"),
  entry("Speaker", Speaker, "Parlante", "altavoz", "sonido fuerte"),
  entry("Ear", Ear, "Ajuste al oído", "in-ear", "auricular"),
  entry("Rotate3d", Rotate3d, "Rotación 360°", "giro", "gira"),
  entry("ScanFace", ScanFace, "Seguimiento facial", "rostro", "reconocimiento"),
  entry("Smartphone", Smartphone, "Celular", "teléfono móvil", "smartphone", "compatible"),
  entry("Tablet", Tablet, "Tablet", "ipad", "pantalla táctil"),
  entry("Watch", Watch, "Reloj inteligente", "smartwatch", "pulsera"),
  entry("Monitor", Monitor, "Pantalla", "monitor", "display"),
  entry("Tv", Tv, "Televisor", "tv", "smart tv"),
  entry("Projector", Projector, "Proyector", "imagen grande", "cine"),
  entry("Keyboard", Keyboard, "Teclado", "teclas", "escritura"),
  entry("Mouse", Mouse, "Mouse", "ratón", "clic"),
  entry("Printer", Printer, "Impresora", "imprimir"),
  entry("Router", Router, "Router", "módem", "internet hogar"),
  entry("Cpu", Cpu, "Procesador", "chip", "cpu"),
  entry("MemoryStick", MemoryStick, "Memoria", "ram", "pendrive"),
  entry("CircuitBoard", CircuitBoard, "Electrónica", "circuito", "placa"),
  entry("Cloud", Cloud, "Nube", "online", "sincronización"),
  entry("AppWindow", AppWindow, "Aplicación", "app", "software"),
  entry("Plug", Plug, "Enchufe", "toma", "corriente"),
  entry("Flame", Flame, "Calor", "calentamiento", "fuego", "encendedor"),
  entry("Snowflake", Snowflake, "Frío", "refrigeración", "congelado"),
  entry("Sun", Sun, "Solar", "sol", "luz solar", "exterior"),
  entry("Wind", Wind, "Flujo de aire", "viento", "soplado"),
  entry("AirVent", AirVent, "Ventilación", "rejilla", "aire acondicionado"),
  entry("Fan", Fan, "Ventilador", "aspas", "refrigerar"),
  entry("Heater", Heater, "Calefacción", "estufa", "calefactor"),
  entry("Lightbulb", Lightbulb, "Iluminación", "luz", "led", "bombilla"),
  entry("Lamp", Lamp, "Lámpara", "velador"),
  entry("LampDesk", LampDesk, "Lámpara de escritorio", "flexo", "estudio"),
  entry("Flashlight", Flashlight, "Linterna", "luz portátil"),
  entry("Hand", Hand, "Apoyo de mano", "apoyabrazos", "palma"),
  entry("Grip", Grip, "Agarre", "antideslizante", "sujeción"),
  entry("Ruler", Ruler, "Dimensiones", "medidas", "tamaño", "largo", "ancho"),
  entry("Maximize", Maximize, "Tamaño amplio", "grande", "extensible"),
  entry("ArrowDownUp", ArrowDownUp, "Altura regulable", "subir", "bajar"),
  entry("Crosshair", Crosshair, "Precisión", "exacto", "puntería"),
  entry("Lock", Lock, "Bloqueo", "candado", "traba", "cierre"),
  entry("Key", Key, "Llave", "cerradura", "acceso"),
  entry("Magnet", Magnet, "Magnético", "imán", "fijación magnética"),
  entry("Anchor", Anchor, "Anclaje", "fijación firme", "base"),
  entry("Pin", Pin, "Fijación", "chinche", "sujeción", "pegar"),
  entry("Puzzle", Puzzle, "Modular", "piezas", "encastre"),
  entry("Link2", Link2, "Compatibilidad", "enlace", "vincular", "compatible"),
  entry("Hourglass", Hourglass, "Duración", "tiempo", "vida útil"),
  entry("Timer", Timer, "Temporizador", "cronómetro", "minutos"),
  entry("Clock", Clock, "Horario", "hora", "reloj"),
  entry("AlarmClock", AlarmClock, "Alarma", "despertador"),
  entry("CalendarDays", CalendarDays, "Calendario", "fecha", "agenda"),
  entry("Bell", Bell, "Notificaciones", "aviso", "timbre"),
  entry("Feather", Feather, "Liviano", "ultraliviano", "poco peso"),
  entry("Leaf", Leaf, "Ecológico", "natural", "sustentable"),
  entry("Recycle", Recycle, "Reciclable", "reciclado", "reutilizar"),
  entry("RefreshCcw", RefreshCcw, "Reutilizable", "lavable", "renovable"),
  entry("Sparkles", Sparkles, "Terminación premium", "acabado", "brillo"),
  entry("Star", Star, "Destacado", "favorito", "top"),
  entry("Smile", Smile, "Comodidad", "confort", "agradable"),
  entry("Heart", Heart, "Bienestar", "salud", "cuidado"),
  entry("Accessibility", Accessibility, "Accesibilidad", "inclusivo", "fácil uso"),
  entry("Activity", Activity, "Actividad física", "pulso", "movimiento"),
  entry("Bike", Bike, "Bicicleta", "ciclismo"),
  entry("Footprints", Footprints, "Caminata", "pasos", "running"),
  entry("Mountain", Mountain, "Montaña", "aventura", "trekking"),
  entry("Compass", Compass, "Orientación", "brújula", "exploración"),
  entry("MapPin", MapPin, "Ubicación", "gps", "localización"),
  entry("Navigation", Navigation, "Navegación", "rumbo", "dirección"),
  entry("Globe", Globe, "Internacional", "mundo", "global"),
  entry("Umbrella", Umbrella, "Lluvia", "paraguas", "clima"),
  entry("Waves", Waves, "Uso acuático", "pileta", "playa", "mar"),
  entry("Truck", Truck, "Envío", "entrega", "transporte"),
  entry("PackageCheck", PackageCheck, "Contenido de la caja", "incluye", "accesorios"),
  entry("Gift", Gift, "Regalo", "obsequio", "presente"),
  entry("Barcode", Barcode, "Código de barras", "ean", "código"),
  entry("Scan", Scan, "Escáner", "lectura", "escanear"),
  entry("CreditCard", CreditCard, "Tarjeta", "pago", "billetera"),
  entry("Calculator", Calculator, "Calculadora", "cálculo", "números"),
  entry("BookOpen", BookOpen, "Manual", "instrucciones", "lectura"),
  entry("GraduationCap", GraduationCap, "Educativo", "aprendizaje", "escuela"),
  entry("PenTool", PenTool, "Diseño", "trazo", "dibujo"),
  entry("Palette", Palette, "Colores", "color", "tonos"),
  entry("Paintbrush", Paintbrush, "Pintura", "pincel", "manualidades"),
  entry("Brush", Brush, "Limpieza", "cepillo", "limpiar"),
  entry("Scissors", Scissors, "Corte", "tijera", "recortar"),
  entry("Drill", Drill, "Taladro", "perforar", "atornillar"),
  entry("PocketKnife", PocketKnife, "Multiherramienta", "navaja", "cortaplumas"),
  entry("Atom", Atom, "Tecnología", "innovación", "avanzada"),
  entry("Fuel", Fuel, "Combustible", "nafta", "gasolina"),
  entry("ChefHat", ChefHat, "Chef", "gastronomía profesional", "cocinero"),
  entry("UtensilsCrossed", UtensilsCrossed, "Cubiertos", "comer", "mesa"),
  entry("Microwave", Microwave, "Microondas", "apto microondas"),
  entry("GlassWater", GlassWater, "Vaso", "beber", "agua fresca"),
  entry("CupSoda", CupSoda, "Vaso con sorbete", "bebida fría", "pajita"),
  entry("Wine", Wine, "Copa", "vino", "brindis"),
  entry("BedDouble", BedDouble, "Dormitorio", "cama", "descanso"),
  entry("Sofa", Sofa, "Living", "sillón", "sala"),
  entry("Bath", Bath, "Baño", "bañera", "ducha"),
  entry("DoorOpen", DoorOpen, "Puerta", "entrada", "abertura"),
  entry("Flower2", Flower2, "Decoración", "flores", "adorno"),
  entry("Sprout", Sprout, "Jardín", "plantas", "cultivo"),
  entry("Baby", Baby, "Bebé", "infantil", "niños"),
  entry("Dog", Dog, "Mascotas", "perro", "gato"),
  entry("Shirt", Shirt, "Indumentaria", "ropa", "remera", "talle"),
  entry("Music", Music, "Música", "canciones", "melodía"),
  entry("Radio", Radio, "Radio", "fm", "am"),
  entry("MessageCircle", MessageCircle, "Atención al cliente", "consultas", "chat"),
  entry("Phone", Phone, "Teléfono", "llamada", "fijo"),
  entry("Check", Check, "Incluido", "sí", "tilde"),
  entry("Settings", Settings, "Configuración", "ajustes", "engranaje"),
]

/**
 * Íconos que ya pueden estar guardados en especificaciones existentes pero que
 * salieron del catálogo (duplicados visuales o poco útiles): se siguen
 * renderando y validando para no romper productos, pero no se ofrecen.
 */
const LEGACY_SPEC_ICONS: readonly SpecIconOption[] = [
  entry("Archive", Archive, "Archivo"),
  entry("BadgePercent", BadgePercent, "Descuento"),
  entry("BatteryLow", BatteryLow, "Batería baja"),
  entry("Clipboard", Clipboard, "Portapapeles"),
  entry("CloudDownload", CloudDownload, "Descarga en nube"),
  entry("Contact", Contact, "Contacto"),
  entry("Database", Database, "Base de datos"),
  entry("Disc3", Disc3, "Disco"),
  entry("Download", Download, "Descarga"),
  entry("FileText", FileText, "Documento"),
  entry("FlaskConical", FlaskConical, "Laboratorio"),
  entry("FolderOpen", FolderOpen, "Carpeta"),
  entry("Image", Image, "Imagen"),
  entry("ListChecks", ListChecks, "Lista de tareas"),
  entry("LockKeyhole", LockKeyhole, "Seguridad con llave"),
  entry("Medal", Medal, "Medalla"),
  entry("MousePointer2", MousePointer2, "Puntero"),
  entry("Notebook", Notebook, "Cuaderno"),
  entry("NotebookPen", NotebookPen, "Anotaciones"),
  entry("Package", Package, "Paquete"),
  entry("PanelTop", PanelTop, "Panel"),
  entry("PanelsTopLeft", PanelsTopLeft, "Aluminio"),
  entry("Paperclip", Paperclip, "Clip"),
  entry("Repeat", Repeat, "Repetición"),
  entry("Rocket", Rocket, "Alto rendimiento"),
]

const BY_NAME = new Map<string, SpecIconOption>(
  [...LEGACY_SPEC_ICONS, ...SPEC_ICON_CATALOG].map((option) => [option.name, option]),
)

/** iconName válido para guardar: del catálogo o ya usado por productos existentes. */
export function isAllowedSpecIcon(iconName: string) {
  return BY_NAME.has(iconName)
}

export function getSpecIcon(iconName: string): LucideIcon | null {
  return BY_NAME.get(iconName)?.Icon ?? null
}

export function getSpecIconDefaultLabel(iconName: string) {
  return BY_NAME.get(iconName)?.label ?? iconName
}

/** displayLabel (sólo Admin): alias guardado o, si no hay, el nombre base. */
export function getSpecIconDisplayLabel(iconName: string, aliases: Readonly<Record<string, string>>) {
  return aliases[iconName] ?? getSpecIconDefaultLabel(iconName)
}

/** Comparación de nombres: sin mayúsculas, tildes, espacios ni signos sobrantes. */
export function normalizeSpecIconLabel(value: string) {
  return value.toLocaleLowerCase("es-AR").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9°]+/g, " ").trim()
}

/** Nombre del ícono que ya usa `label` (alias o nombre base de otro ícono), o null. */
export function findSpecIconLabelConflict(iconName: string, label: string, aliases: Readonly<Record<string, string>>) {
  const wanted = normalizeSpecIconLabel(label)
  const conflict = SPEC_ICON_CATALOG.find((option) => option.name !== iconName && (
    normalizeSpecIconLabel(option.label) === wanted ||
    normalizeSpecIconLabel(getSpecIconDisplayLabel(option.name, aliases)) === wanted
  ))
  return conflict ? getSpecIconDisplayLabel(conflict.name, aliases) : null
}

export type SpecIconAliases = Record<string, string>

// v1 guardaba el alias por una entrada sintética del catálogo
// ("ShieldCheck:seguridad"); como la especificación sólo guarda el iconName,
// al reabrir se resolvía otra entrada del mismo ícono y volvía el nombre
// viejo. v2 usa el iconName como clave estable.
export const SPEC_ICON_ALIAS_KEY_PREFIX = "product_spec_icon_alias_v2:"
export const SPEC_ICON_LEGACY_ALIAS_KEY_PREFIX = "product_spec_icon_alias_v1:"

type AliasRow = { key: string; value: unknown; updated_at?: string | null }

function aliasLabelOf(value: unknown) {
  const label = value && typeof value === "object" && !Array.isArray(value) && "label" in value
    ? (value as { label?: unknown }).label
    : null
  return typeof label === "string" && label.trim() ? label.trim() : null
}

/** Filas de `site_settings` → alias por iconName. v2 gana; de v1, el más reciente por ícono. */
export function resolveSpecIconAliasRows(rows: readonly AliasRow[]): SpecIconAliases {
  const current: SpecIconAliases = {}
  const legacy = new Map<string, { label: string; updatedAt: string }>()
  for (const row of rows) {
    const label = aliasLabelOf(row.value)
    if (!label) continue
    if (row.key.startsWith(SPEC_ICON_ALIAS_KEY_PREFIX)) {
      current[row.key.slice(SPEC_ICON_ALIAS_KEY_PREFIX.length)] = label
    } else if (row.key.startsWith(SPEC_ICON_LEGACY_ALIAS_KEY_PREFIX)) {
      const iconName = row.key.slice(SPEC_ICON_LEGACY_ALIAS_KEY_PREFIX.length).split(":")[0]
      const updatedAt = row.updated_at ?? ""
      const previous = legacy.get(iconName)
      if (iconName && (!previous || updatedAt > previous.updatedAt)) legacy.set(iconName, { label, updatedAt })
    }
  }
  for (const [iconName, { label }] of legacy) current[iconName] ??= label
  return current
}

/** Búsqueda por displayLabel, defaultLabel, iconName y keywords. */
export function matchesSpecIconSearch(option: SpecIconOption, query: string, aliases: Readonly<Record<string, string>>) {
  const wanted = normalizeSpecIconLabel(query)
  if (!wanted) return true
  return normalizeSpecIconLabel([aliases[option.name] ?? "", option.label, option.name, ...option.keywords].join(" ")).includes(wanted)
}
