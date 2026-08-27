import type { AndreaniBranch } from "./types"

export function formatAndreaniBranchStreetLine(
  direccion: AndreaniBranch["direccion"],
) {
  return [direccion.calle, direccion.numero]
    .filter((part): part is string => Boolean(part))
    .join(" ")
}

export function formatAndreaniBranchAddress(
  direccion: AndreaniBranch["direccion"],
) {
  const streetLine = formatAndreaniBranchStreetLine(direccion)
  if (streetLine) return streetLine

  return [
    direccion.localidad,
    direccion.provincia,
    direccion.codigoPostal ? `CP ${direccion.codigoPostal}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ")
}
