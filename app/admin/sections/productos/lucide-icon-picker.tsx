"use client"

import { useMemo, useState } from "react"
import {
  Armchair,
  BadgeCheck,
  Battery,
  BatteryCharging,
  BatteryFull,
  Bluetooth,
  Cable,
  CircleHelp,
  Clock,
  CookingPot,
  CupSoda,
  Gamepad2,
  Hammer,
  Headphones,
  Home,
  Lock,
  Mic,
  Monitor,
  Music,
  Package,
  Plug,
  Rocket,
  Search,
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
  BadgeCheck,
  Battery,
  BatteryCharging,
  BatteryFull,
  Bluetooth,
  Cable,
  Clock,
  CookingPot,
  CupSoda,
  Gamepad2,
  Hammer,
  Headphones,
  Home,
  Lock,
  Mic,
  Monitor,
  Music,
  Package,
  Plug,
  Rocket,
  Shield,
  ShieldCheck,
  Smile,
  Sparkles,
  Star,
  Truck,
  Usb,
  Volume2,
  Zap,
} satisfies Record<string, LucideIcon>

type IconName = keyof typeof iconMap

const iconOptions: Array<IconOption & { name: IconName }> = [
  {
    name: "Battery",
    label: "Bateria",
    keywords: ["bateria", "energia", "duracion", "carga"],
  },
  {
    name: "BatteryCharging",
    label: "Bateria cargando",
    keywords: ["bateria", "carga", "cargando", "energia"],
  },
  {
    name: "BatteryFull",
    label: "Bateria completa",
    keywords: ["bateria", "duracion", "energia", "completa"],
  },
  {
    name: "Headphones",
    label: "Auriculares",
    keywords: ["sonido", "audio", "auricular", "auriculares", "musica"],
  },
  {
    name: "Volume2",
    label: "Sonido",
    keywords: ["sonido", "volumen", "audio", "parlante"],
  },
  {
    name: "Music",
    label: "Musica",
    keywords: ["sonido", "musica", "audio"],
  },
  {
    name: "Bluetooth",
    label: "Bluetooth",
    keywords: ["bluetooth", "inalambrico", "conexion"],
  },
  {
    name: "Truck",
    label: "Envio",
    keywords: ["envio", "entrega", "transporte", "rapido"],
  },
  {
    name: "Package",
    label: "Paquete",
    keywords: ["envio", "paquete", "caja", "producto"],
  },
  {
    name: "Shield",
    label: "Seguridad",
    keywords: ["seguridad", "resistente", "proteccion", "garantia"],
  },
  {
    name: "ShieldCheck",
    label: "Garantia",
    keywords: ["garantia", "seguridad", "proteccion", "calidad"],
  },
  {
    name: "Lock",
    label: "Bloqueo",
    keywords: ["seguridad", "bloqueo", "proteccion"],
  },
  {
    name: "Clock",
    label: "Tiempo",
    keywords: ["tiempo", "duracion", "hora", "rapido"],
  },
  {
    name: "BadgeCheck",
    label: "Calidad",
    keywords: ["calidad", "garantia", "certificado", "verificado"],
  },
  {
    name: "Star",
    label: "Destacado",
    keywords: ["calidad", "estrella", "destacado", "premium"],
  },
  {
    name: "Mic",
    label: "Microfono",
    keywords: ["microfono", "voz", "llamada", "audio"],
  },
  {
    name: "Cable",
    label: "Cable",
    keywords: ["cable", "conexion", "usb", "carga"],
  },
  {
    name: "Usb",
    label: "USB",
    keywords: ["usb", "cable", "conexion", "carga"],
  },
  {
    name: "Plug",
    label: "Enchufe",
    keywords: ["carga", "enchufe", "energia", "plug"],
  },
  {
    name: "Zap",
    label: "Rapido",
    keywords: ["carga", "rapido", "energia", "potencia"],
  },
  {
    name: "Armchair",
    label: "Comodidad",
    keywords: ["comodidad", "confort", "sillon"],
  },
  {
    name: "Smile",
    label: "Comodo",
    keywords: ["comodidad", "confort", "facil"],
  },
  {
    name: "Home",
    label: "Hogar",
    keywords: ["hogar", "casa", "smart home"],
  },
  {
    name: "CookingPot",
    label: "Cocina",
    keywords: ["cocina", "olla", "cocinar"],
  },
  {
    name: "CupSoda",
    label: "Bebidas",
    keywords: ["cocina", "vaso", "bebida"],
  },
  {
    name: "Gamepad2",
    label: "Gaming",
    keywords: ["gaming", "juego", "gamer"],
  },
  {
    name: "Monitor",
    label: "Pantalla",
    keywords: ["pantalla", "monitor", "display"],
  },
  {
    name: "Sparkles",
    label: "Limpieza",
    keywords: ["limpieza", "brillo", "nuevo"],
  },
  {
    name: "Hammer",
    label: "Resistente",
    keywords: ["resistente", "duro", "fuerte", "herramienta"],
  },
  {
    name: "Rocket",
    label: "Velocidad",
    keywords: ["rapido", "velocidad", "potencia"],
  },
]

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
  return iconOptions.find((option) => option.name === iconName)?.label ?? iconName
}

export function LucideIconPicker({
  value,
  onChange,
}: LucideIconPickerProps) {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)
  const SelectedIcon = value ? getLucideIcon(value) : Search
  const selectedLabel = value ? getFriendlyIconName(value) : "Elegir icono"

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
    <div className="relative">
      <button
        type="button"
        title="Abrir buscador de iconos"
        aria-label="Abrir buscador de iconos"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-48px w-full cursor-pointer items-center justify-between gap-3 rounded-2xl border border-white/8 bg-black px-4 text-left transition-colors hover:border-beyonix-blue-light/45"
      >
        <span className="flex min-w-0 items-center gap-3">
          <SelectedIcon className="size-5 shrink-0 text-beyonix-sky" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-white">
              {selectedLabel}
            </span>
            <span className="block truncate text-11px text-white/42">
              {value || "Buscar por nombre o uso"}
            </span>
          </span>
        </span>
        <Search className="size-4 shrink-0 text-white/45" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-56px z-30 space-y-3 rounded-2xl border border-white/10 bg-black p-3 shadow-beyonix-modal">
          <div className="flex items-center gap-3 rounded-2xl border border-white/8 bg-black px-4 py-3">
        <SelectedIcon className="size-5 shrink-0 text-beyonix-sky" />
        <input
          type="search"
          title="Buscar icono"
          aria-label="Buscar icono"
          value={search}
          placeholder="Buscar: bateria, sonido, envio..."
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
        />
            <button
              type="button"
              title="Cerrar buscador de iconos"
              aria-label="Cerrar buscador de iconos"
              onClick={() => setOpen(false)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-lg border border-white/8 text-white/55 transition-colors hover:text-white"
            >
              <X className="size-4" />
            </button>
      </div>

          <div className="grid max-h-220px gap-2 overflow-y-auto pr-1 custom-scrollbar sm:grid-cols-2">
        {filteredOptions.map((option) => {
          const Icon = getLucideIcon(option.name)
          const selected = value === option.name

          return (
            <button
              key={option.name}
              type="button"
              title={`Elegir icono ${option.label}`}
              aria-label={`Elegir icono ${option.label}`}
              onClick={() => {
                onChange(option.name)
                setOpen(false)
              }}
              className={`flex min-h-48px cursor-pointer items-center gap-3 rounded-2xl border px-3 text-left transition-colors ${
                selected
                  ? "border-beyonix-sky bg-beyonix-blue text-white"
                  : "border-white/8 bg-black text-white/70 hover:border-beyonix-blue-light/45 hover:text-white"
              }`}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/20 bg-beyonix-blue/35 text-beyonix-sky">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{option.label}</span>
                <span className="block truncate text-11px text-white/42">
                  {option.name}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {!filteredOptions.length && (
        <div className="rounded-2xl border border-white/8 bg-black px-4 py-5 text-center">
          <p className="text-sm text-white/50">No encontramos iconos.</p>
        </div>
      )}
        </div>
      )}
    </div>
  )
}
