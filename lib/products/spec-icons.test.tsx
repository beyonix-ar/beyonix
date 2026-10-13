import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

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
} from "./spec-icons"

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
  assert.equal(isAllowedSpecIcon("CircleHelp"), false)
  assert.equal(isAllowedSpecIcon("NoExiste"), false)
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

test("tienda: muestra ícono + texto de la característica, nunca el alias ni el nombre base", () => {
  const product = {
    id: 9, nombre: "Soporte", slug: "soporte", precio: 1000, precio_anterior: null, descuento: null, stock: 3, sku: "S",
    activo: true, descripcion: "", video_url: null, categorias: null, imagenes_producto: [], producto_variantes: [],
    producto_especificaciones: [
      { id: 1, producto_id: 9, icono: "ShieldCheck", texto: "Fijación por abrazadera, sin perforaciones", orden: 1, activo: true },
      { id: 2, producto_id: 9, icono: "Tent", texto: "Ideal para salidas al aire libre", orden: 2, activo: true },
      { id: 3, producto_id: 9, icono: "Layers3", texto: "Soporte metálico firme y duradero", orden: 3, activo: true },
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
  assert.doesNotMatch(markup, /lucide-circle-question-mark|lucide-circle-help/)
})
