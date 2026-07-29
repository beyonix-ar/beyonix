"use client"

import { useMemo, useState } from "react"
import {
  Armchair,
  AudioLines,
  BadgeCheck,
  Battery,
  BatteryCharging,
  BatteryFull,
  Bluetooth,
  Cable,
  Camera,
  Car,
  CircleHelp,
  Clock,
  Coffee,
  CookingPot,
  CupSoda,
  Ear,
  Flame,
  Gamepad2,
  Gauge,
  Hammer,
  Hand,
  HardDrive,
  Headphones,
  Home,
  Laptop,
  Layers3,
  Lock,
  Mic,
  Monitor,
  MonitorUp,
  Music,
  Network,
  Package,
  PanelsTopLeft,
  Plug,
  PlugZap,
  Rocket,
  Rotate3d,
  Ruler,
  ScanFace,
  Search,
  Smartphone,
  Thermometer,
  Weight,
  Wifi,
  X,
  Shield,
  ShieldCheck,
  Smile,
  Sparkles,
  Star,
  Truck,
  Usb,
  Volume2,
  Zap,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

interface IconOption {
  name: string
  label: string
  keywords: string[]
}

interface LucideIconPickerProps {
  value: string
  onChange: (iconName: string) => void
}

const iconMap = {
  Armchair,
  AudioLines,
  BadgeCheck,
  Battery,
  BatteryCharging,
  BatteryFull,
  Bluetooth,
  Cable,
  Camera,
  Car,
  Clock,
  Coffee,
  CookingPot,
  CupSoda,
  Ear,
  Flame,
  Gamepad2,
  Gauge,
  Hammer,
  Hand,
  HardDrive,
  Headphones,
  Home,
  Laptop,
  Layers3,
  Lock,
  Mic,
  Monitor,
  MonitorUp,
  Music,
  Network,
  Package,
  PanelsTopLeft,
  Plug,
  PlugZap,
  Rocket,
  Rotate3d,
  Ruler,
  ScanFace,
  Shield,
  ShieldCheck,
  Smile,
  Smartphone,
  Sparkles,
  Star,
  Thermometer,
  Truck,
  Usb,
  Volume2,
  Weight,
  Wifi,
  Zap,
} satisfies Record<string, LucideIcon>

type IconName = keyof typeof iconMap

const iconOptions: Array<IconOption & { name: IconName }> = [
  {
    name: "Laptop",
    label: "Notebook",
    keywords: ["notebook", "laptop", "computadora", "portátil"],
  },
  {
    name: "MonitorUp",
    label: "Soporte para notebook",
    keywords: ["soporte", "notebook", "laptop", "elevado", "altura"],
  },
  {
    name: "PanelsTopLeft",
    label: "Aluminio",
    keywords: ["aluminio", "metal", "material", "estructura"],
  },
  {
    name: "Layers3",
    label: "Construcción reforzada",
    keywords: ["construcción", "estructura", "capas", "reforzado", "resistente"],
  },
  {
    name: "Usb",
    label: "Conexión USB",
    keywords: ["usb", "puerto", "conexión", "carga"],
  },
  {
    name: "Network",
    label: "Hub USB",
    keywords: ["hub", "usb", "puertos", "adaptador", "concentrador"],
  },
  {
    name: "HardDrive",
    label: "Transferencia de datos",
    keywords: ["datos", "transferencia", "velocidad", "usb 3.0", "almacenamiento"],
  },
  {
    name: "Cable",
    label: "Cable incluido",
    keywords: ["cable", "incluido", "conexión", "usb", "carga"],
  },
  {
    name: "PlugZap",
    label: "Alimentación USB",
    keywords: ["alimentación", "usb", "enchufe", "energía", "corriente"],
  },
  {
    name: "Battery",
    label: "Funciona a batería",
    keywords: ["batería", "energía", "autonomía", "inalámbrico"],
  },
  {
    name: "BatteryCharging",
    label: "Batería recargable",
    keywords: ["batería", "recargable", "carga", "autonomía"],
  },
  {
    name: "Zap",
    label: "Carga rápida",
    keywords: ["carga", "rápida", "energía", "potencia"],
  },
  {
    name: "Bluetooth",
    label: "Conexión Bluetooth",
    keywords: ["bluetooth", "inalámbrico", "conexión", "audio"],
  },
  {
    name: "Wifi",
    label: "Conexión inalámbrica",
    keywords: ["wifi", "inalámbrico", "conexión", "red"],
  },
  {
    name: "Headphones",
    label: "Auriculares",
    keywords: ["auriculares", "audio", "sonido", "música"],
  },
  {
    name: "Mic",
    label: "Micrófono integrado",
    keywords: ["micrófono", "voz", "llamada", "audio"],
  },
  {
    name: "AudioLines",
    label: "Audio estéreo",
    keywords: ["audio", "estéreo", "sonido", "música"],
  },
  {
    name: "Volume2",
    label: "Control de volumen",
    keywords: ["volumen", "audio", "sonido", "control"],
  },
  {
    name: "Ear",
    label: "Ajuste cómodo",
    keywords: ["oído", "auricular", "ajuste", "comodidad", "ergonómico"],
  },
  {
    name: "Camera",
    label: "Cámara y fotografía",
    keywords: ["cámara", "foto", "video", "trípode"],
  },
  {
    name: "Rotate3d",
    label: "Rotación 360°",
    keywords: ["rotación", "360", "giro", "seguimiento", "trípode"],
  },
  {
    name: "ScanFace",
    label: "Seguimiento inteligente",
    keywords: ["seguimiento", "rostro", "inteligente", "automático", "trípode"],
  },
  {
    name: "Smartphone",
    label: "Compatible con celular",
    keywords: ["celular", "teléfono", "smartphone", "compatible", "trípode"],
  },
  {
    name: "Coffee",
    label: "Mate o taza",
    keywords: ["mate", "bombilla", "taza", "vaso", "bebida"],
  },
  {
    name: "Thermometer",
    label: "Control de temperatura",
    keywords: ["temperatura", "calor", "caliente", "térmico"],
  },
  {
    name: "Flame",
    label: "Calentamiento",
    keywords: ["calor", "calentador", "temperatura", "encendedor", "taza"],
  },
  {
    name: "Car",
    label: "Uso en automóvil",
    keywords: ["auto", "automóvil", "vehículo", "12 v", "viaje"],
  },
  {
    name: "Plug",
    label: "Conexión 12 V",
    keywords: ["12 v", "auto", "automóvil", "enchufe", "corriente"],
  },
  {
    name: "Armchair",
    label: "Diseño ergonómico",
    keywords: ["ergonómico", "comodidad", "apoyabrazos", "escritorio"],
  },
  {
    name: "Hand",
    label: "Apoyo confortable",
    keywords: ["apoyo", "brazo", "apoyabrazos", "comodidad", "escritorio"],
  },
  {
    name: "ShieldCheck",
    label: "Estructura resistente",
    keywords: ["resistente", "durable", "protección", "estructura", "seguridad"],
  },
  {
    name: "BadgeCheck",
    label: "Calidad verificada",
    keywords: ["calidad", "garantía", "certificado", "verificado"],
  },
  {
    name: "Ruler",
    label: "Dimensiones",
    keywords: ["dimensiones", "medidas", "tamaño", "largo", "ancho", "alto"],
  },
  {
    name: "Weight",
    label: "Peso",
    keywords: ["peso", "liviano", "gramos", "kilogramos"],
  },
  {
    name: "Gauge",
    label: "Potencia",
    keywords: ["potencia", "velocidad", "rendimiento", "watts"],
  },
]

const legacyFriendlyNames: Record<string, string> = {
  BatteryFull: "Batería completa",
  Clock: "Duración",
  CookingPot: "Uso en cocina",
  CupSoda: "Recipiente para bebidas",
  Gamepad2: "Videojuegos",
  Hammer: "Resistencia",
  Home: "Uso doméstico",
  Lock: "Bloqueo de seguridad",
  Monitor: "Pantalla",
  Music: "Música",
  Package: "Presentación del producto",
  Rocket: "Alto rendimiento",
  Shield: "Protección",
  Smile: "Comodidad",
  Sparkles: "Terminación",
  Star: "Característica destacada",
  Truck: "Transporte",
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

export function isAllowedLucideIcon(iconName: string) {
  return iconName in iconMap
}

export function getLucideIcon(iconName: string): LucideIcon {
  return isAllowedLucideIcon(iconName)
    ? iconMap[iconName as IconName]
    : CircleHelp
}

export function getFriendlyIconName(iconName: string) {
  return (
    iconOptions.find((option) => option.name === iconName)?.label ??
    legacyFriendlyNames[iconName] ??
    iconName
  )
}

export function LucideIconPicker({
  value,
  onChange,
}: LucideIconPickerProps) {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)
  const SelectedIcon = value ? getLucideIcon(value) : Search
  const selectedLabel = value ? getFriendlyIconName(value) : "Elegir ícono"

  const filteredOptions = useMemo(() => {
    const query = normalize(search.trim())

    if (!query) {
      return iconOptions
    }

    return iconOptions.filter((option) => {
      const haystack = normalize(
        [option.name, option.label, ...option.keywords].join(" ")
      )

      return haystack.includes(query)
    })
  }, [search])

  return (
    <div className="admin-icon-picker relative min-w-0">
      <button
        type="button"
        aria-label="Abrir buscador de iconos"
        onClick={() => setOpen((current) => !current)}
        className="admin-icon-picker-trigger flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-xl border px-3.5 text-left transition-colors"
      >
        <span className="flex min-w-0 items-center gap-3">
          <SelectedIcon className="size-5 shrink-0 text-white" />
          <span className="truncate text-sm font-semibold text-white">
            {selectedLabel}
          </span>
        </span>
        <Search className="size-4 shrink-0 text-white/60" />
      </button>

      {open && (
        <div className="admin-icon-picker-popover absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 space-y-2 rounded-2xl border p-2.5 shadow-beyonix-modal">
          <div className="admin-icon-picker-search flex min-h-11 items-center gap-2 rounded-xl border px-3">
            <Search className="size-4.5 shrink-0 text-white" />
            <input
              type="search"
              aria-label="Buscar ícono"
              value={search}
              placeholder="Buscar ícono..."
              onChange={(event) => setSearch(event.target.value)}
              className="admin-icon-picker-search-input min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
            />
            <button
              type="button"
              aria-label="Cerrar buscador de iconos"
              onClick={() => setOpen(false)}
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/12 bg-[#444444] text-white transition-colors hover:border-beyonix-sky/40 hover:bg-beyonix-blue"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="grid max-h-[340px] gap-2 overflow-y-auto pr-1 custom-scrollbar">
            {filteredOptions.map((option) => {
              const Icon = getLucideIcon(option.name)
              const selected = value === option.name

              return (
                <button
                  key={option.name}
                  type="button"
                  aria-label={`Elegir ícono ${option.label}`}
                  onClick={() => {
                    onChange(option.name)
                    setOpen(false)
                  }}
                  className={`admin-icon-picker-option flex min-h-12 cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${
                    selected ? "admin-icon-picker-option-selected" : ""
                  }`}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/12 bg-[#444444] text-white">
                    <Icon className="size-4.5 text-white" />
                  </span>
                  <span className="min-w-0 truncate text-sm font-semibold leading-tight text-white">
                    {option.label}
                  </span>
                </button>
              )
            })}
          </div>

          {!filteredOptions.length && (
            <div className="rounded-xl border border-white/10 bg-[#111820] px-4 py-4 text-center">
              <p className="text-sm text-white/50">No encontramos íconos.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
