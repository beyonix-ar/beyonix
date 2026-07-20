export type DeliveryAddressFields = {
  street: string
  streetNumber: string
  floor?: string
  apartment?: string
  locality: string
  region: string
  postalCode: string
}

export function parseDeliveryAddress(
  value: string,
  region?: string,
  postalCode?: string
) {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const firstPart = parts[0] ?? value.trim()
  const match = firstPart.match(/^(.*?)(\d+[a-zA-Z]?)\b(.*)$/)
  const base = match
    ? {
        street: match[1].replace(/[,\s]+$/, "").trim(),
        streetNumber: match[2].trim(),
      }
    : {
        street: firstPart,
        streetNumber: "",
      }
  let floor = ""
  let apartment = ""
  let locality = ""

  for (const part of parts.slice(1)) {
    if (/^piso\s+/i.test(part)) {
      floor = part.replace(/^piso\s+/i, "").trim()
      continue
    }

    if (/^depto\s+/i.test(part)) {
      apartment = part.replace(/^depto\s+/i, "").trim().toLocaleUpperCase("es-AR")
      continue
    }

    if (region && part.toLowerCase() === region.toLowerCase()) {
      continue
    }

    if (postalCode && part.toLowerCase() === `cp ${postalCode}`.toLowerCase()) {
      continue
    }

    if (!locality) {
      locality = part
    }
  }

  return {
    ...base,
    floor,
    apartment,
    locality,
  }
}

export function formatDeliveryAddress(fields: DeliveryAddressFields) {
  const optionalParts = [
    fields.floor?.trim() ? `Piso ${fields.floor.trim()}` : "",
    fields.apartment?.trim() ? `Depto ${fields.apartment.trim().toLocaleUpperCase("es-AR")}` : "",
  ].filter(Boolean)

  return [
    `${fields.street.trim()} ${fields.streetNumber.trim()}`,
    ...optionalParts,
    fields.locality.trim(),
    fields.region.trim(),
    `CP ${fields.postalCode.trim()}`,
  ].join(", ")
}
