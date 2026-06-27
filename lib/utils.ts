import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const beyonixHoverBorder =
  "border border-white/10 hover:border-[#1e6fae] hover:shadow-[0_0_0_1px_rgba(30,111,174,0.45)] transition-all duration-200"
