import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const beyonixInteractiveOutline =
  "border border-white/10 outline-none transition-all duration-200 hover:border-beyonix-blue-light/70 focus-visible:border-beyonix-blue-light focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25 active:border-beyonix-blue-light disabled:pointer-events-none disabled:opacity-50"

export const beyonixHoverBorder =
  beyonixInteractiveOutline
