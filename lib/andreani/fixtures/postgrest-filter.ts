// Evaluador mínimo de filtros lógicos de PostgREST para los fakes de tests
// (`or=(…)` con `and(…)` anidados y los operadores que usa el tracking
// Andreani). No es un parser completo: sólo lo necesario para que los fakes
// apliquen el mismo WHERE que la base.

type Row = Record<string, unknown>

function splitTopLevel(expression: string) {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const character of expression) {
    if (character === "(") depth += 1
    if (character === ")") depth -= 1
    if (character === "," && depth === 0) {
      parts.push(current)
      current = ""
    } else current += character
  }
  if (current) parts.push(current)
  return parts.map((part) => part.trim())
}

export function matchesPostgrestCondition(row: Row, expression: string): boolean {
  const logic = /^(and|or)\((.*)\)$/.exec(expression.trim())
  if (logic) {
    const parts = splitTopLevel(logic[2])
    return logic[1] === "and" ? parts.every((part) => matchesPostgrestCondition(row, part)) : parts.some((part) => matchesPostgrestCondition(row, part))
  }
  const [column, operator, ...rest] = expression.trim().split(".")
  const value = rest.join(".")
  const current = row[column]
  switch (operator) {
    case "is": return value === "null" ? current === null || current === undefined : String(current) === value
    case "eq": return current !== null && current !== undefined && String(current) === value
    case "ilike": return typeof current === "string" && current.toLowerCase() === value.toLowerCase()
    case "lte": return current !== null && current !== undefined && Date.parse(String(current)) <= Date.parse(value)
    case "lt": return current !== null && current !== undefined && Date.parse(String(current)) < Date.parse(value)
    default: throw new Error(`Operador no soportado en el fake: ${operator}`)
  }
}

/** Valor de `.or(…)` (sin los paréntesis externos). */
export const matchesPostgrestOr = (row: Row, filter: string) => matchesPostgrestCondition(row, `or(${filter})`)
