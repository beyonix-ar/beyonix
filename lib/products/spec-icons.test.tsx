import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as lucide from "lucide-react"

import { ProductDetailsPanel } from "@/components/products/product-details-panel"
import type { SupabaseProducto } from "@/lib/supabase/types"
import {
  findSpecIconLabelConflict,
  getSpecIcon,
  getSpecIconDisplayLabel,
  isAllowedSpecIcon,
  matchesSpecIconSearch,
  normalizeSpecIconLabel,
  resolveSpecIconAliasRows,
  SPEC_ICON_CATALOG,
  specIconLucideId,
} from "./spec-icons"

// Íconos que necesita BEYONIX (ids oficiales de Lucide). Todos existen en la
// versión instalada de lucide-react, así que ninguno usa un reemplazo.
const REQUESTED_LUCIDE_IDS = [
  "bluetooth", "headphones", "battery-charging", "battery-full", "usb", "cable", "plug", "zap", "power", "lightbulb",
  "smartphone", "monitor", "sliders-horizontal", "gauge", "activity", "calculator", "weight", "footprints",
  "chart-no-axes-column-increasing", "thermometer", "coffee", "glass-water", "wine", "circle-dot", "circle-check",
  "shield-check", "hand", "ear", "ruler", "fold-horizontal", "fold-vertical", "move", "arrow-up-down", "git-branch",
  "repeat", "wind", "laptop", "car-front", "briefcase-business", "armchair", "palette", "package", "gift", "mic",
  "thermometer-snowflake", "thermometer-sun", "snowflake", "droplets", "bottle-wine", "car", "bike", "flashlight", "sun",
  "zoom-in", "panels-top-left", "pen-line", "paintbrush", "swatch-book", "pen-tool", "volume-2", "music", "speaker",
  "cup-soda", "shield", "recycle",
]

// `producto_especificaciones.icono` en la base real (auditado en solo lectura).
const STORED_IN_DATABASE = [
  "Bluetooth", "BatteryCharging", "FoldHorizontal", "Monitor", "Smile", "SlidersHorizontal", "Cable", "Usb",
  "ArrowDownUp", "Zap", "Coffee", "Shield", "Backpack", "Hand", "Lightbulb", "Smartphone", "PlugZap", "Camera", "Laptop",
  "BadgeCheck", "Layers3", "AirVent", "Flame", "AudioLines", "Ear", "RefreshCcw", "Rotate3d", "Move3d", "Weight",
  "ScanFace", "Settings", "Volume2", "Plug", "Thermometer", "Sparkles", "Headset", "Link2", "Headphones",
  "ChartNoAxesCombined", "Gift", "Wrench", "Minimize2", "Grip", "Battery", "Armchair", "ShieldCheck", "Wine", "Ruler",
  "BicepsFlexed", "Calculator", "Beaker", "Gauge",
]

const searchNames = (query: string) =>
  SPEC_ICON_CATALOG.filter((option) => matchesSpecIconSearch(option, query, {})).map((option) => option.name)

// Íconos que el catálogo anterior permitía guardar: las especificaciones
// existentes que los usan tienen que seguir siendo válidas y renderizables.
const PREVIOUSLY_ALLOWED = [
  "Armchair", "AudioLines", "BadgeCheck", "Battery", "BatteryCharging", "BatteryFull", "Bluetooth", "Cable", "Camera",
  "Car", "Clock", "Coffee", "CookingPot", "CupSoda", "Ear", "Flame", "Gamepad2", "Gauge", "Hammer", "Hand", "HardDrive",
  "Headphones", "Home", "Laptop", "Layers3", "Lock", "Mic", "Monitor", "MonitorUp", "Music", "Network", "Package",
  "PanelsTopLeft", "Plug", "PlugZap", "Rocket", "Rotate3d", "Ruler", "ScanFace", "Shield", "ShieldCheck", "Smile",
  "Smartphone", "Sparkles", "Star", "Thermometer", "Truck", "Usb", "Volume2", "Weight", "Wifi", "Zap", "Accessibility",
  "Activity", "AirVent", "AlarmClock", "Anchor", "AppWindow", "Archive", "ArrowDownUp", "Atom", "Award", "Backpack",
  "BadgePercent", "Barcode", "BatteryLow", "BedDouble", "Bell", "Bike", "BookOpen", "BriefcaseBusiness", "Brush",
  "Calculator", "CalendarDays", "ChartNoAxesCombined", "Check", "ChefHat", "CircuitBoard", "Clipboard", "Cloud",
  "CloudDownload", "Compass", "Contact", "Cpu", "CreditCard", "Crosshair", "Database", "Disc3", "DoorOpen", "Download",
  "Drill", "Droplets", "Dumbbell", "Fan", "Feather", "FileText", "Flashlight", "FlaskConical", "Flower2", "FolderOpen",
  "Fuel", "Gift", "GlassWater", "Globe", "GraduationCap", "Grip", "Headset", "Heart", "Heater", "Hourglass", "Image",
  "Lamp", "LampDesk", "Leaf", "Lightbulb", "Link2", "ListChecks", "LockKeyhole", "MapPin", "Maximize", "Medal",
  "MemoryStick", "MessageCircle", "Microwave", "Mountain", "Mouse", "MousePointer2", "Move3d", "Navigation", "Notebook",
  "NotebookPen", "PackageCheck", "Paintbrush", "Palette", "PanelTop", "Paperclip", "PenTool", "Phone", "Pin", "Plane",
  "PocketKnife", "Printer", "Projector", "Puzzle", "Radio", "Recycle", "RefreshCcw", "Repeat", "Router", "Scan",
  "Scissors", "Settings",
]

const REQUIRED_CONCEPTS = [
  "Capacidad", "Seguridad", "Protección", "Durabilidad", "Potencia", "Voltaje", "Autonomía", "Resistencia", "Volumen",
  "Peso", "Material", "Temperatura", "Impermeable", "Flexible", "Ajustable", "Plegable", "Portátil", "Compacto",
  "Rendimiento", "Velocidad", "Conectividad", "Garantía", "Calidad", "Organización", "Ergonomía", "Audio", "Video",
  "Cámara", "Batería", "USB", "USB-C", "Bluetooth", "Wi-Fi", "Auto", "Hogar", "Cocina", "Oficina", "Camping", "Viaje",
  "Herramientas", "Gaming", "Fitness", "Mate", "Botella", "Termo",
]

function duplicates<T>(values: T[]) {
  return values.filter((value, index) => values.indexOf(value) !== index)
}

test("catálogo: ningún iconName repetido", () => {
  assert.deepEqual(duplicates(SPEC_ICON_CATALOG.map((option) => option.name)), [])
})

test("catálogo: ningún componente ni dibujo SVG repetido (aliases de lucide incluidos)", () => {
  assert.deepEqual(duplicates(SPEC_ICON_CATALOG.map((option) => option.Icon)).map(String), [])
  const drawings = SPEC_ICON_CATALOG.map((option) =>
    renderToStaticMarkup(createElement(option.Icon)).replace(/\sclass="[^"]*"/, ""))
  const repeated = duplicates(drawings).map((drawing) => SPEC_ICON_CATALOG[drawings.indexOf(drawing)].name)
  assert.deepEqual(repeated, [])
})

test("catálogo: nombres visibles únicos normalizados (mayúsculas, tildes, espacios, signos)", () => {
  const labels = SPEC_ICON_CATALOG.map((option) => normalizeSpecIconLabel(option.label))
  assert.deepEqual(duplicates(labels), [])
  assert.equal(normalizeSpecIconLabel("  Protección   REFORZADA "), normalizeSpecIconLabel("proteccion reforzada"))
  assert.notEqual(normalizeSpecIconLabel("USB"), normalizeSpecIconLabel("USB-C"))
})

test("catálogo: cubre los conceptos pedidos para ecommerce", () => {
  const labels = new Set(SPEC_ICON_CATALOG.map((option) => normalizeSpecIconLabel(option.label)))
  assert.deepEqual(REQUIRED_CONCEPTS.filter((concept) => !labels.has(normalizeSpecIconLabel(concept))), [])
})

test("compatibilidad: los íconos ya guardados siguen siendo válidos y se renderizan", () => {
  assert.deepEqual(PREVIOUSLY_ALLOWED.filter((name) => !isAllowedSpecIcon(name) || !getSpecIcon(name)), [])
  assert.deepEqual(STORED_IN_DATABASE.filter((name) => !isAllowedSpecIcon(name) || !getSpecIcon(name)), [], "I")
  assert.equal(isAllowedSpecIcon("CircleHelp"), false)
  assert.equal(isAllowedSpecIcon("NoExiste"), false)
  assert.equal(getSpecIcon("NoExiste"), null, "J: desconocido → el render usa su fallback")
  // El id guardado sigue siendo el nombre del componente: no se aceptan ids kebab como segundo formato.
  assert.equal(isAllowedSpecIcon("battery-charging"), false)
})

test("B: los 65 íconos pedidos están en el catálogo ofrecido, con su id oficial de Lucide", () => {
  assert.equal(new Set(REQUESTED_LUCIDE_IDS).size, 65)
  const byLucideId = new Map(SPEC_ICON_CATALOG.map((option) => [specIconLucideId(option.name), option]))
  assert.deepEqual(REQUESTED_LUCIDE_IDS.filter((id) => !byLucideId.has(id)), [])
  assert.equal(specIconLucideId("Volume2"), "volume-2")
  assert.equal(specIconLucideId("ChartNoAxesColumnIncreasing"), "chart-no-axes-column-increasing")
  assert.equal(specIconLucideId("Move3d"), "move-3d")
})

test("C: cada componente del catálogo (ofrecido y legacy) es el export real de lucide-react con ese nombre", () => {
  const exports = lucide as unknown as Record<string, unknown>
  const names = [...PREVIOUSLY_ALLOWED, ...SPEC_ICON_CATALOG.map((option) => option.name)]
  assert.deepEqual(names.filter((name) => !exports[name] || exports[name] !== getSpecIcon(name)), [])
})

test("D–F: la búsqueda encuentra por id técnico, nombre en español y palabras relacionadas", () => {
  const includesAll = (query: string, expected: string[]) => {
    const found = searchNames(query)
    assert.deepEqual(expected.filter((name) => !found.includes(name)), [], `«${query}» → ${found.join(", ")}`)
  }
  includesAll("battery-charging", ["BatteryCharging"])
  includesAll("BatteryCharging", ["BatteryCharging"])
  includesAll("volume-2", ["Volume2"])
  includesAll("thermometer-snowflake", ["ThermometerSnowflake"])
  includesAll("Temperatura fría", ["ThermometerSnowflake"])
  includesAll("batería", ["BatteryFull", "BatteryCharging", "Battery"])
  includesAll("BATERIA", ["BatteryFull", "BatteryCharging"])
  includesAll("frío", ["ThermometerSnowflake", "Snowflake"])
  includesAll("auto", ["Car", "CarFront"])
  includesAll("sonido", ["Headphones", "Speaker", "Volume2", "Music"])
  includesAll("temperatura", ["Thermometer", "ThermometerSnowflake", "ThermometerSun"])
  includesAll("agua", ["Droplets", "GlassWater"])
  includesAll("zoom", ["ZoomIn"])
  includesAll("USB", ["Usb", "Cable"])
  includesAll("sacacorchos", ["BottleWine"])
  includesAll("paneles", ["PanelsTopLeft"])
  assert.deepEqual(searchNames("zzz-no-existe"), [])
})

test("displayLabel: el alias gana sobre el nombre base; sin alias vuelve al base; iconName no cambia", () => {
  assert.equal(getSpecIconDisplayLabel("ShieldCheck", {}), "Seguridad")
  assert.equal(getSpecIconDisplayLabel("ShieldCheck", { ShieldCheck: "Protección reforzada" }), "Protección reforzada")
  assert.equal(getSpecIconDisplayLabel("Shield", { ShieldCheck: "Protección reforzada" }), "Protección")
})

test("búsqueda: por alias actual, nombre base, iconName y keywords", () => {
  const shield = SPEC_ICON_CATALOG.find((option) => option.name === "ShieldCheck")!
  const aliases = { ShieldCheck: "Protección reforzada" }
  for (const query of ["protección reforzada", "PROTECCION", "seguridad", "shield", "shieldcheck", "certificado"]) {
    assert.ok(matchesSpecIconSearch(shield, query, aliases), query)
  }
  assert.equal(matchesSpecIconSearch(shield, "bluetooth", aliases), false)
})

test("alias único: no puede repetir el nombre de otro ícono (base o alias), sí el propio", () => {
  assert.equal(findSpecIconLabelConflict("Shield", "  seguridad ", {}), "Seguridad")
  assert.equal(findSpecIconLabelConflict("Shield", "SEGURIDAD", { ShieldCheck: "Protección reforzada" }), "Protección reforzada")
  assert.equal(findSpecIconLabelConflict("Shield", "Protección Reforzada", { ShieldCheck: "Protección reforzada" }), "Protección reforzada")
  assert.equal(findSpecIconLabelConflict("ShieldCheck", "Seguridad", {}), null)
  assert.equal(findSpecIconLabelConflict("ShieldCheck", "Protección premium", {}), null)
})

test("persistencia: v2 por iconName gana; v1 legacy sólo como respaldo (el más reciente)", () => {
  const aliases = resolveSpecIconAliasRows([
    { key: "product_spec_icon_alias_v1:ShieldCheck:seguridad", value: { label: "Viejo" }, updated_at: "2026-10-01" },
    { key: "product_spec_icon_alias_v2:ShieldCheck", value: { label: "Protección premium" } },
    { key: "product_spec_icon_alias_v1:Laptop:notebook", value: { label: "Antes" }, updated_at: "2026-10-01" },
    { key: "product_spec_icon_alias_v1:Laptop:laptop-notebook", value: { label: "Después" }, updated_at: "2026-10-05" },
    { key: "product_spec_icon_alias_v2:Usb", value: { label: "   " } },
    { key: "otra_config", value: { label: "No" } },
  ])
  assert.deepEqual(aliases, { ShieldCheck: "Protección premium", Laptop: "Después" })
})

test("persistencia: un alias v1 que repite el nombre base de otro ícono no se aplica (Repeat → «Plegable»)", () => {
  // Fila real de site_settings: antes Repeat no se ofrecía y el alias no se veía.
  const aliases = resolveSpecIconAliasRows([
    { key: "product_spec_icon_alias_v1:Repeat:plegable", value: { label: "Plegable" }, updated_at: "2026-09-01" },
    { key: "product_spec_icon_alias_v1:Drill:taladro", value: { label: "Instalación" }, updated_at: "2026-09-01" },
  ])
  assert.deepEqual(aliases, { Drill: "Instalación" })
  assert.equal(getSpecIconDisplayLabel("Repeat", aliases), "Repetición")
  const visible = SPEC_ICON_CATALOG.map((option) => normalizeSpecIconLabel(getSpecIconDisplayLabel(option.name, aliases)))
  assert.deepEqual(duplicates(visible), [], "el selector no muestra dos «Plegable»")

  // Todos los alias guardados hoy en site_settings (auditados en solo lectura).
  const real = resolveSpecIconAliasRows([
    ["v1:Drill:taladro", "Instalación"], ["v1:Repeat:plegable", "Plegable"], ["v2:ArrowDownUp", "Control de extracción"],
    ["v2:BadgeCheck", "Fácil de usar"], ["v2:Calculator", "Índice de masa corporal"], ["v2:ChartNoAxesCombined", "Seguimiento de progreso"],
    ["v2:Coffee", "Taza"], ["v2:Ear", "Almohadillas acolchadas"], ["v2:Hand", "Diseño ergonómico"], ["v2:Headphones", "Diseño envolvente"],
    ["v2:Laptop", "Notebook / Tablet"], ["v2:Lightbulb", "Indicador luminoso"], ["v2:Plug", "Conexión 12V"],
    ["v2:Thermometer", "Temperatura constante"], ["v2:Weight", "Hasta 180kg"], ["v2:Wine", "Apertura eléctrica"],
    ["v2:Wrench", "Fácil instalación"], ["v2:Zap", "Sistema automático"],
  ].map(([key, label]) => ({ key: `product_spec_icon_alias_${key}`, value: { label }, updated_at: "2026-10-01" })))
  const realVisible = SPEC_ICON_CATALOG.map((option) => normalizeSpecIconLabel(getSpecIconDisplayLabel(option.name, real)))
  assert.deepEqual(duplicates(realVisible), [], "con los alias reales, ningún nombre visible se repite")
  assert.equal(getSpecIconDisplayLabel("Wine", real), "Apertura eléctrica", "los alias válidos se mantienen")
})

test("tienda: muestra ícono + texto de la característica, nunca el alias ni el nombre base", () => {
  const product = {
    id: 9, nombre: "Soporte", slug: "soporte", precio: 1000, precio_anterior: null, descuento: null, stock: 3, sku: "S",
    activo: true, descripcion: "", video_url: null, categorias: null, imagenes_producto: [], producto_variantes: [],
    producto_especificaciones: [
      { id: 1, producto_id: 9, icono: "ShieldCheck", texto: "Fijación por abrazadera, sin perforaciones", orden: 1, activo: true },
      { id: 2, producto_id: 9, icono: "Tent", texto: "Ideal para salidas al aire libre", orden: 2, activo: true },
      { id: 3, producto_id: 9, icono: "Layers3", texto: "Soporte metálico firme y duradero", orden: 3, activo: true },
      { id: 4, producto_id: 9, icono: "ThermometerSnowflake", texto: "Mantiene el frío 24 horas", orden: 4, activo: true },
      { id: 5, producto_id: 9, icono: "BottleWine", texto: "Descorcha en segundos", orden: 5, activo: true },
      { id: 6, producto_id: 9, icono: "IconoQueYaNoExiste", texto: "Dato histórico con ícono desconocido", orden: 6, activo: true },
    ],
  } as unknown as SupabaseProducto
  const noop = () => {}
  const markup = renderToStaticMarkup(createElement(ProductDetailsPanel, {
    product, selectedColor: "", onColorChange: noop, onAddToCart: noop, onDecreaseCart: noop,
    onRemoveFromCart: noop, onViewCart: noop, selectedStock: 3,
  }))
  for (const text of ["Fijación por abrazadera, sin perforaciones", "Ideal para salidas al aire libre", "Soporte metálico firme y duradero"]) {
    assert.ok(markup.includes(text), text)
  }
  for (const label of ["Seguridad", "Protección premium", "Camping", "Material"]) {
    assert.doesNotMatch(markup, new RegExp(`>${label}<`), label)
  }
  // Íconos nuevos del catálogo también se dibujan en la tienda (no el "?").
  assert.match(markup, /lucide-shield-check/)
  assert.match(markup, /lucide-tent/)
  assert.match(markup, /lucide-thermometer-snowflake/, "L: ícono nuevo en la tienda")
  assert.match(markup, /lucide-bottle-wine/)
  // J: un ícono desconocido no rompe la ficha: se ve el texto con el ícono de ayuda.
  assert.ok(markup.includes("Dato histórico con ícono desconocido"))
  assert.equal((markup.match(/lucide-circle-question-mark|lucide-circle-help/g) ?? []).length, 1, "sólo el desconocido usa el fallback")
  assert.equal(product.producto_especificaciones?.[5].icono, "IconoQueYaNoExiste", "P: el render no modifica el dato")
})
