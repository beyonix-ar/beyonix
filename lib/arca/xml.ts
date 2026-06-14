import { XMLParser } from "fast-xml-parser"

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
})

export function parseXml<T = Record<string, unknown>>(xml: string): T {
  return parser.parse(xml) as T
}

export function escapeXml(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function getSoapFaultMessage(document: Record<string, any>) {
  const fault = document?.Envelope?.Body?.Fault
  if (!fault) return null

  return (
    fault.faultstring ??
    fault.Reason?.Text ??
    fault.detail?.exception ??
    "ARCA devolvió un error SOAP."
  )
}
