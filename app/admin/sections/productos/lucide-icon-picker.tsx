"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
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
import {
  Accessibility,
  Activity,
  AirVent,
  AlarmClock,
  Anchor,
  AppWindow,
  Archive,
  ArrowDownUp,
  Atom,
  Award,
  Backpack,
  BadgePercent,
  Barcode,
  BatteryLow,
  BedDouble,
  Bell,
  Bike,
  BookOpen,
  BriefcaseBusiness,
  Brush,
  Calculator,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChefHat,
  CircuitBoard,
  Clipboard,
  Cloud,
  CloudDownload,
  Compass,
  Contact,
  Cpu,
  CreditCard,
  Crosshair,
  Database,
  Disc3,
  DoorOpen,
  Download,
  Drill,
  Droplets,
  Dumbbell,
  Fan,
  Feather,
  FileText,
  Flashlight,
  FlaskConical,
  Flower2,
  FolderOpen,
  Fuel,
  Gift,
  GlassWater,
  Globe,
  GraduationCap,
  Grip,
  Headset,
  Heart,
  Heater,
  Hourglass,
  Image,
  Lamp,
  LampDesk,
  Leaf,
  Lightbulb,
  Link2,
  ListChecks,
  LockKeyhole,
  MapPin,
  Maximize,
  Medal,
  MemoryStick,
  MessageCircle,
  Microwave,
  Mountain,
  Mouse,
  MousePointer2,
  Move3d,
  Navigation,
  Notebook,
  NotebookPen,
  PackageCheck,
  Paintbrush,
  Palette,
  Pencil,
  PanelTop,
  Paperclip,
  PenTool,
  Phone,
  Pin,
  Plane,
  PocketKnife,
  Printer,
  Projector,
  Puzzle,
  Radio,
  Recycle,
  RefreshCcw,
  Repeat,
  RotateCcw,
  Router,
  Scan,
  Scissors,
  Settings,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  loadSpecIconAliases,
  resetSpecIconAlias,
  saveSpecIconAlias,
  type SpecIconAliases,
} from "@/lib/supabase/queries/spec-icon-aliases"

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
  Accessibility,
  Activity,
  AirVent,
  AlarmClock,
  Anchor,
  AppWindow,
  Archive,
  ArrowDownUp,
  Atom,
  Award,
  Backpack,
  BadgePercent,
  Barcode,
  BatteryLow,
  BedDouble,
  Bell,
  Bike,
  BookOpen,
  BriefcaseBusiness,
  Brush,
  Calculator,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChefHat,
  CircuitBoard,
  Clipboard,
  Cloud,
  CloudDownload,
  Compass,
  Contact,
  Cpu,
  CreditCard,
  Crosshair,
  Database,
  Disc3,
  DoorOpen,
  Download,
  Drill,
  Droplets,
  Dumbbell,
  Fan,
  Feather,
  FileText,
  Flashlight,
  FlaskConical,
  Flower2,
  FolderOpen,
  Fuel,
  Gift,
  GlassWater,
  Globe,
  GraduationCap,
  Grip,
  Headset,
  Heart,
  Heater,
  Hourglass,
  Image,
  Lamp,
  LampDesk,
  Leaf,
  Lightbulb,
  Link2,
  ListChecks,
  LockKeyhole,
  MapPin,
  Maximize,
  Medal,
  MemoryStick,
  MessageCircle,
  Microwave,
  Mountain,
  Mouse,
  MousePointer2,
  Move3d,
  Navigation,
  Notebook,
  NotebookPen,
  PackageCheck,
  Paintbrush,
  Palette,
  PanelTop,
  Paperclip,
  PenTool,
  Phone,
  Pin,
  Plane,
  PocketKnife,
  Printer,
  Projector,
  Puzzle,
  Radio,
  Recycle,
  RefreshCcw,
  Repeat,
  Router,
  Scan,
  Scissors,
  Settings,
} satisfies Record<string, LucideIcon>

type IconName = keyof typeof iconMap

const additionalIconOptions: Array<IconOption & { name: IconName }> = [
  { name: "Accessibility", label: "Accesibilidad", keywords: ["ergonomía","inclusión"] },
  { name: "Activity", label: "Actividad", keywords: ["fitness","salud","movimiento"] },
  { name: "AirVent", label: "Ventilación", keywords: ["aire","ventilador"] },
  { name: "AlarmClock", label: "Alarma", keywords: ["reloj","despertador"] },
  { name: "Anchor", label: "Anclaje", keywords: ["soporte","fijación"] },
  { name: "AppWindow", label: "Aplicación", keywords: ["software","pantalla"] },
  { name: "Archive", label: "Archivo", keywords: ["organización","almacenamiento"] },
  { name: "ArrowDownUp", label: "Movimiento vertical", keywords: ["ajustable","altura"] },
  { name: "Atom", label: "Tecnología avanzada", keywords: ["innovación","ciencia"] },
  { name: "Award", label: "Premio", keywords: ["calidad","distinción"] },
  { name: "Backpack", label: "Mochila", keywords: ["viaje","portabilidad"] },
  { name: "BadgePercent", label: "Descuento", keywords: ["oferta","porcentaje"] },
  { name: "Barcode", label: "Código de barras", keywords: ["scanner","identificación"] },
  { name: "BatteryLow", label: "Batería baja", keywords: ["energía","carga"] },
  { name: "BedDouble", label: "Dormitorio", keywords: ["cama","hogar"] },
  { name: "Bell", label: "Alerta", keywords: ["notificación","timbre"] },
  { name: "Bike", label: "Bicicleta", keywords: ["movilidad","transporte"] },
  { name: "BookOpen", label: "Lectura", keywords: ["libro","manual"] },
  { name: "BriefcaseBusiness", label: "Trabajo", keywords: ["oficina","profesional"] },
  { name: "Brush", label: "Cepillo", keywords: ["limpieza","cuidado"] },
  { name: "Calculator", label: "Cálculo", keywords: ["números","oficina"] },
  { name: "CalendarDays", label: "Calendario", keywords: ["fecha","agenda"] },
  { name: "ChartNoAxesCombined", label: "Rendimiento", keywords: ["estadísticas","velocidad"] },
  { name: "Check", label: "Verificado", keywords: ["confirmación","calidad"] },
  { name: "ChefHat", label: "Chef", keywords: ["cocina","gastronomía"] },
  { name: "CircuitBoard", label: "Circuito", keywords: ["electrónica","tecnología"] },
  { name: "Clipboard", label: "Portapapeles", keywords: ["oficina","organización"] },
  { name: "Cloud", label: "Nube", keywords: ["almacenamiento","internet"] },
  { name: "CloudDownload", label: "Descarga en nube", keywords: ["transferencia","datos"] },
  { name: "Compass", label: "Brújula", keywords: ["viaje","orientación"] },
  { name: "Contact", label: "Contacto", keywords: ["personas","agenda"] },
  { name: "Cpu", label: "Procesador", keywords: ["computadora","chip"] },
  { name: "CreditCard", label: "Tarjeta", keywords: ["pago","billetera"] },
  { name: "Crosshair", label: "Precisión", keywords: ["objetivo","ajuste"] },
  { name: "Database", label: "Base de datos", keywords: ["información","almacenamiento"] },
  { name: "Disc3", label: "Disco", keywords: ["audio","almacenamiento"] },
  { name: "DoorOpen", label: "Acceso", keywords: ["puerta","hogar"] },
  { name: "Download", label: "Descarga", keywords: ["transferencia","archivos"] },
  { name: "Drill", label: "Taladro", keywords: ["herramienta","perforación"] },
  { name: "Droplets", label: "Resistente al agua", keywords: ["impermeable","líquidos"] },
  { name: "Dumbbell", label: "Entrenamiento", keywords: ["fitness","gimnasio"] },
  { name: "Fan", label: "Ventilador", keywords: ["aire","refrigeración"] },
  { name: "Feather", label: "Liviano", keywords: ["peso","portabilidad"] },
  { name: "FileText", label: "Documento", keywords: ["archivo","información"] },
  { name: "Flashlight", label: "Linterna", keywords: ["iluminación","portátil"] },
  { name: "FlaskConical", label: "Laboratorio", keywords: ["material","ciencia"] },
  { name: "Flower2", label: "Decoración", keywords: ["hogar","flores"] },
  { name: "FolderOpen", label: "Carpeta", keywords: ["organización","archivos"] },
  { name: "Fuel", label: "Combustible", keywords: ["auto","energía"] },
  { name: "Gift", label: "Regalo", keywords: ["obsequio","presentación"] },
  { name: "GlassWater", label: "Vaso", keywords: ["agua","bebida"] },
  { name: "Globe", label: "Global", keywords: ["mundo","internet"] },
  { name: "GraduationCap", label: "Aprendizaje", keywords: ["educación","estudio"] },
  { name: "Grip", label: "Agarre", keywords: ["sujeción","ergonomía"] },
  { name: "Headset", label: "Auricular con micrófono", keywords: ["audio","comunicación"] },
  { name: "Heart", label: "Bienestar", keywords: ["salud","comodidad"] },
  { name: "Heater", label: "Calefacción", keywords: ["calor","hogar"] },
  { name: "Hourglass", label: "Duración", keywords: ["tiempo","autonomía"] },
  { name: "Image", label: "Imagen", keywords: ["fotografía","multimedia"] },
  { name: "Lamp", label: "Lámpara", keywords: ["iluminación","luz"] },
  { name: "LampDesk", label: "Lámpara de escritorio", keywords: ["oficina","luz"] },
  { name: "Leaf", label: "Sustentable", keywords: ["reciclable","reutilizable"] },
  { name: "Lightbulb", label: "Iluminación", keywords: ["idea","luz"] },
  { name: "Link2", label: "Conexión", keywords: ["enlace","compatibilidad"] },
  { name: "ListChecks", label: "Lista de tareas", keywords: ["organización"] },
  { name: "LockKeyhole", label: "Seguridad con llave", keywords: ["protección","bloqueo"] },
  { name: "MapPin", label: "Ubicación", keywords: ["viaje","localización"] },
  { name: "Maximize", label: "Pantalla completa", keywords: ["dimensiones","ampliación"] },
  { name: "Medal", label: "Medalla", keywords: ["calidad","reconocimiento"] },
  { name: "MemoryStick", label: "Memoria", keywords: ["almacenamiento","RAM"] },
  { name: "MessageCircle", label: "Comunicación", keywords: ["mensaje","chat"] },
  { name: "Microwave", label: "Microondas", keywords: ["cocina","hogar"] },
  { name: "Mountain", label: "Montaña", keywords: ["camping","aventura"] },
  { name: "Mouse", label: "Mouse", keywords: ["computadora","oficina"] },
  { name: "MousePointer2", label: "Puntero", keywords: ["computadora","precisión"] },
  { name: "Move3d", label: "Movimiento 3D", keywords: ["ajustable","flexible"] },
  { name: "Navigation", label: "Navegación", keywords: ["GPS","viaje"] },
  { name: "Notebook", label: "Cuaderno", keywords: ["oficina","notas"] },
  { name: "NotebookPen", label: "Anotaciones", keywords: ["escritura","estudio"] },
  { name: "PackageCheck", label: "Paquete verificado", keywords: ["calidad","envío"] },
  { name: "Paintbrush", label: "Pintura", keywords: ["bazar","creatividad"] },
  { name: "Palette", label: "Paleta", keywords: ["color","diseño"] },
  { name: "PanelTop", label: "Panel", keywords: ["pantalla","soporte"] },
  { name: "Paperclip", label: "Clip", keywords: ["organización","oficina"] },
  { name: "PenTool", label: "Diseño", keywords: ["trazo","creatividad"] },
  { name: "Phone", label: "Teléfono", keywords: ["celular","comunicación"] },
  { name: "Pin", label: "Fijación", keywords: ["soporte","anclaje"] },
  { name: "Plane", label: "Avión", keywords: ["viaje","portabilidad"] },
  { name: "PocketKnife", label: "Navaja", keywords: ["camping","herramienta"] },
  { name: "Printer", label: "Impresora", keywords: ["oficina","impresión"] },
  { name: "Projector", label: "Proyector", keywords: ["imagen","pantalla"] },
  { name: "Puzzle", label: "Compatibilidad", keywords: ["modular","piezas"] },
  { name: "Radio", label: "Radio", keywords: ["audio","inalámbrico"] },
  { name: "Recycle", label: "Reciclable", keywords: ["sustentable","reutilizable"] },
  { name: "RefreshCcw", label: "Reutilizable", keywords: ["recarga","renovación"] },
  { name: "Repeat", label: "Repetición", keywords: ["ciclo","continuo"] },
  { name: "Router", label: "Router", keywords: ["wifi","red","internet"] },
  { name: "Scan", label: "Escaneo", keywords: ["scanner","lectura"] },
  { name: "Scissors", label: "Tijera", keywords: ["herramienta","corte"] },
  { name: "Settings", label: "Configuración", keywords: ["ajustable","personalización"] },
]

const baseIconOptions: Array<IconOption & { name: IconName }> = [
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
  ...additionalIconOptions,
]

// Conceptos de búsqueda útiles con los mismos SVG ya incluidos en el picker.
// La especificación continúa guardando únicamente el nombre técnico Lucide.
const conceptIconOptions: Array<IconOption & { name: IconName }> = [
  { name: "Package", label: "Capacidad", keywords: ["almacenamiento", "volumen"] },
  { name: "ShieldCheck", label: "Seguridad", keywords: ["protección", "seguro"] },
  { name: "Shield", label: "Protección", keywords: ["seguridad", "resguardo"] },
  { name: "Hammer", label: "Durabilidad", keywords: ["resistencia", "vida útil"] },
  { name: "Zap", label: "Potencia", keywords: ["energía", "watts"] },
  { name: "PlugZap", label: "Voltaje", keywords: ["voltios", "electricidad"] },
  { name: "BatteryFull", label: "Autonomía", keywords: ["duración", "batería"] },
  { name: "Dumbbell", label: "Resistencia", keywords: ["fuerza", "solidez"] },
  { name: "CupSoda", label: "Volumen", keywords: ["capacidad", "litros"] },
  { name: "Weight", label: "Peso", keywords: ["kilogramos", "gramos"] },
  { name: "Layers3", label: "Material", keywords: ["composición", "fabricación"] },
  { name: "Thermometer", label: "Temperatura", keywords: ["grados", "térmico"] },
  { name: "Droplets", label: "Impermeable", keywords: ["agua", "protección"] },
  { name: "Move3d", label: "Flexible", keywords: ["movilidad", "adaptable"] },
  { name: "Settings", label: "Ajustable", keywords: ["regulable", "adaptable"] },
  { name: "Repeat", label: "Plegable", keywords: ["compacto", "doble"] },
  { name: "Backpack", label: "Portátil", keywords: ["viaje", "transportable"] },
  { name: "Package", label: "Compacto", keywords: ["pequeño", "portátil"] },
  { name: "Gauge", label: "Rendimiento", keywords: ["desempeño", "velocidad"] },
  { name: "Rocket", label: "Velocidad", keywords: ["rápido", "rendimiento"] },
  { name: "Network", label: "Conectividad", keywords: ["red", "conexión"] },
  { name: "BadgeCheck", label: "Garantía", keywords: ["calidad", "respaldo"] },
  { name: "Award", label: "Calidad", keywords: ["certificación", "garantía"] },
  { name: "Archive", label: "Organización", keywords: ["orden", "almacenamiento"] },
  { name: "Armchair", label: "Ergonomía", keywords: ["comodidad", "postura"] },
  { name: "AudioLines", label: "Audio", keywords: ["sonido", "música"] },
  { name: "Projector", label: "Video", keywords: ["imagen", "pantalla"] },
  { name: "Camera", label: "Cámara", keywords: ["fotografía", "video"] },
  { name: "Battery", label: "Batería", keywords: ["energía", "carga"] },
  { name: "Usb", label: "USB", keywords: ["conector", "puerto"] },
  { name: "Cable", label: "USB-C", keywords: ["tipo c", "carga"] },
  { name: "Bluetooth", label: "Bluetooth", keywords: ["inalámbrico", "conexión"] },
  { name: "Wifi", label: "Wi-Fi", keywords: ["internet", "inalámbrico"] },
  { name: "Car", label: "Auto", keywords: ["vehículo", "automóvil"] },
  { name: "Home", label: "Hogar", keywords: ["casa", "doméstico"] },
  { name: "CookingPot", label: "Cocina", keywords: ["gastronomía", "alimentos"] },
  { name: "BriefcaseBusiness", label: "Oficina", keywords: ["trabajo", "escritorio"] },
  { name: "Mountain", label: "Camping", keywords: ["aire libre", "aventura"] },
  { name: "Plane", label: "Viaje", keywords: ["equipaje", "transporte"] },
  { name: "Drill", label: "Herramientas", keywords: ["taller", "bricolaje"] },
  { name: "Gamepad2", label: "Gaming", keywords: ["videojuegos", "juegos"] },
  { name: "Dumbbell", label: "Fitness", keywords: ["entrenamiento", "ejercicio"] },
  { name: "Coffee", label: "Mate", keywords: ["infusión", "bebida"] },
  { name: "GlassWater", label: "Botella", keywords: ["agua", "recipiente"] },
  { name: "Thermometer", label: "Termo", keywords: ["temperatura", "bebida"] },
]

const iconOptions = [...baseIconOptions, ...conceptIconOptions,
  ...baseIconOptions.flatMap((option) => option.keywords.slice(0, 2).map((keyword) => ({
    ...option,
    label: `${keyword.charAt(0).toLocaleUpperCase("es-AR")}${keyword.slice(1)} · ${option.label}`,
  }))),
].map((option) => ({
  ...option,
  id: `${option.name}:${normalize(option.label).replace(/[^a-z0-9]+/g, "-")}`,
})).filter((option, index, options) => options.findIndex((candidate) => candidate.id === option.id) === index)

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

const MIN_POPOVER_WIDTH = 300

export function LucideIconPicker({
  value,
  onChange,
}: LucideIconPickerProps) {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: MIN_POPOVER_WIDTH })
  const [aliases, setAliases] = useState<SpecIconAliases>({})
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState("")
  const [savingAlias, setSavingAlias] = useState(false)
  const [aliasError, setAliasError] = useState("")
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const SelectedIcon = value ? getLucideIcon(value) : Search
  const selectedOption = iconOptions.find((option) => option.id === selectedOptionId && option.name === value)
    ?? iconOptions.find((option) => option.name === value)
  const selectedLabel = value
    ? selectedOption ? aliases[selectedOption.id] ?? selectedOption.label : getFriendlyIconName(value)
    : "Elegir ícono"

  const filteredOptions = useMemo(() => {
    const query = normalize(search.trim())

    if (!query) {
      return iconOptions
    }

    return iconOptions.filter((option) => {
      const haystack = normalize(
        [option.name, option.label, aliases[option.id] ?? "", ...option.keywords].join(" ")
      )

      return haystack.includes(query)
    })
  }, [search, aliases])

  useEffect(() => {
    let active = true
    loadSpecIconAliases()
      .then((loaded) => { if (active) setAliases(loaded) })
      .catch(() => { if (active) setAliasError("No se pudieron cargar los nombres personalizados.") })
    return () => { active = false }
  }, [])

  const saveAlias = async () => {
    if (!editingOptionId || savingAlias) return
    const label = draftLabel.trim()
    if (!label) {
      setAliasError("Escribí un nombre visible.")
      return
    }
    setSavingAlias(true)
    setAliasError("")
    try {
      await saveSpecIconAlias(editingOptionId, label)
      setAliases((current) => ({ ...current, [editingOptionId]: label }))
      setEditingOptionId(null)
    } catch {
      setAliasError("No se pudo guardar el nombre visible.")
    } finally {
      setSavingAlias(false)
    }
  }

  const resetAlias = async () => {
    if (!editingOptionId || savingAlias) return
    setSavingAlias(true)
    setAliasError("")
    try {
      await resetSpecIconAlias(editingOptionId)
      setAliases((current) => {
        const next = { ...current }
        delete next[editingOptionId]
        return next
      })
      setEditingOptionId(null)
    } catch {
      setAliasError("No se pudo restablecer el nombre.")
    } finally {
      setSavingAlias(false)
    }
  }

  useEffect(() => {
    setMounted(true)
  }, [])

  // Cierra al hacer clic afuera (trigger + menú portaleado cuentan como
  // "adentro") o al presionar Escape. Listeners sólo existen mientras el
  // menú está abierto -- se dan de baja en el cleanup de este mismo efecto,
  // nunca se acumulan entre aperturas.
  useEffect(() => {
    if (!open) return

    function handlePointerDownOutside(event: MouseEvent) {
      const target = event.target as Node
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }

    document.addEventListener("mousedown", handlePointerDownOutside)
    document.addEventListener("keydown", handleEscape)

    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [open])

  // Posición por getBoundingClientRect (mismo patrón que AdminSelect /
  // ProfitabilityPopover): ancho mínimo propio en vez de calcar el ancho del
  // trigger, así los nombres largos ("Construcción reforzada") no quedan
  // cortados aunque la columna de ícono sea angosta; clamp contra el
  // viewport para no desbordar.
  useEffect(() => {
    if (!open) return

    function updatePosition() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return

      const width = Math.min(
        Math.max(rect.width, MIN_POPOVER_WIDTH),
        window.innerWidth - 16,
      )
      const estimatedHeight = menuRef.current?.offsetHeight ?? 320
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < estimatedHeight + 8 && rect.top > estimatedHeight
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - width - 8),
      )

      setPosition({
        left,
        top: openAbove
          ? Math.max(8, rect.top - estimatedHeight - 4)
          : Math.min(window.innerHeight - 8, rect.bottom + 4),
        width,
      })
    }

    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)

    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [open, filteredOptions.length])

  // Portalea dentro de .product-editor-screen (no a document.body): así
  // sigue siendo descendiente del selector con el que está scopeado todo el
  // CSS de este picker (.product-editor-screen .admin-icon-picker-*), pero
  // con position:fixed evita el recorte/ancho de cualquier ancestro
  // (la tarjeta de Especificaciones, la fila, etc.).
  const portalTarget =
    triggerRef.current?.closest<HTMLElement>(".product-editor-screen") ??
    (typeof document !== "undefined" ? document.body : null)

  return (
    <div className="admin-icon-picker relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Abrir buscador de iconos"
        aria-haspopup="listbox"
        aria-expanded={open}
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

      {mounted &&
        open &&
        portalTarget &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Íconos disponibles"
            className="admin-portal-scope admin-icon-picker-popover fixed z-100 space-y-2 rounded-2xl border p-2.5 shadow-beyonix-modal"
            style={{ left: position.left, top: position.top, width: position.width }}
          >
            <div className="admin-icon-picker-search flex min-h-11 items-center gap-2 rounded-xl border px-3">
              <Search className="size-4.5 shrink-0 text-white" />
              <input
                autoFocus
                type="search"
                aria-label="Buscar ícono"
                value={search}
                placeholder="Buscar ícono..."
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation()
                    setOpen(false)
                  }
                }}
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

            {aliasError && <p role="alert" className="text-xs text-red-300">{aliasError}</p>}

            <div className="grid max-h-[340px] gap-2 overflow-y-auto pr-1 custom-scrollbar">
              {filteredOptions.map((option) => {
                const Icon = getLucideIcon(option.name)
                const displayLabel = aliases[option.id] ?? option.label
                const selected = value === option.name && selectedOption?.id === option.id

                return (
                  <div key={option.id} className="min-w-0">
                    <div className="flex min-w-0 items-stretch gap-1">
                      <button
                        type="button"
                        aria-label={`Elegir ícono ${displayLabel}`}
                        title={displayLabel}
                        onClick={() => {
                          setSelectedOptionId(option.id)
                          onChange(option.name)
                          setOpen(false)
                        }}
                        className={`admin-icon-picker-option flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-1 text-left transition-colors ${
                          selected ? "admin-icon-picker-option-selected" : ""
                        }`}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/12 bg-[#444444] text-white">
                          <Icon className="size-4.5 text-white" />
                        </span>
                        <span className="min-w-0 truncate text-sm font-semibold leading-tight text-white">{displayLabel}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Editar nombre de ${displayLabel}`}
                        title={`Editar nombre de ${displayLabel}`}
                        onClick={() => {
                          setEditingOptionId(option.id)
                          setDraftLabel(displayLabel)
                          setAliasError("")
                        }}
                        className="admin-icon-picker-edit flex min-w-11 items-center justify-center rounded-xl border border-white/14 bg-[#0c1219] text-white/75 hover:border-white/40 hover:text-white"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                    {editingOptionId === option.id && (
                      <div className="mt-1 space-y-2 rounded-xl border border-white/14 bg-[#171c22] p-2">
                        <label className="block text-xs font-semibold text-white" htmlFor={`alias-${option.id}`}>Nombre visible</label>
                        <input
                          id={`alias-${option.id}`}
                          autoFocus
                          type="text"
                          maxLength={80}
                          value={draftLabel}
                          onChange={(event) => setDraftLabel(event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter") void saveAlias() }}
                          className="h-9 w-full rounded-lg border border-white/25 bg-[#0c1219] px-2 text-sm text-white outline-none focus:border-emerald-400"
                        />
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {aliases[option.id] && (
                            <button type="button" disabled={savingAlias} onClick={() => void resetAlias()} className="mr-auto inline-flex items-center gap-1 text-xs text-white/75 hover:text-white">
                              <RotateCcw className="size-3.5" /> Restablecer nombre
                            </button>
                          )}
                          <button type="button" disabled={savingAlias} onClick={() => setEditingOptionId(null)} className="rounded-lg px-2 py-1 text-xs text-white/75 hover:text-white">Cancelar</button>
                          <button type="button" disabled={savingAlias} onClick={() => void saveAlias()} className="rounded-lg border border-emerald-400/50 bg-emerald-500/20 px-2 py-1 text-xs font-bold text-white hover:bg-emerald-500/30">Guardar</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {!filteredOptions.length && (
              <div className="rounded-xl border border-white/10 bg-[#111820] px-4 py-4 text-center">
                <p className="text-sm text-white/50">No encontramos íconos.</p>
              </div>
            )}
          </div>,
          portalTarget,
        )}
    </div>
  )
}
