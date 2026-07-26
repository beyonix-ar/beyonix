function padPart(value: string) {
  return value.padStart(2, "0")
}

function takeDatePart(
  digits: string,
  maximum: number,
  singleDigitThreshold: number,
) {
  if (!digits) return { value: "", rest: "", complete: false }

  if (digits.length === 1) {
    const digit = Number(digits)
    if (digit >= singleDigitThreshold) {
      return { value: padPart(digits), rest: "", complete: true }
    }

    return { value: digits, rest: "", complete: false }
  }

  const pair = digits.slice(0, 2)
  const pairNumber = Number(pair)
  if (pairNumber >= 1 && pairNumber <= maximum) {
    return { value: pair, rest: digits.slice(2), complete: true }
  }

  const first = digits[0]
  const firstNumber = Number(first)
  if (firstNumber >= 1) {
    return {
      value: padPart(first),
      rest: digits.slice(1),
      complete: true,
    }
  }

  return {
    value: pair,
    rest: digits.slice(2),
    complete: true,
  }
}

export function formatAdminDateInput(rawValue: string) {
  const canonicalMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(
    rawValue.trim(),
  )
  if (canonicalMatch) {
    const [, year, month, day] = canonicalMatch
    return `${padPart(day)}/${padPart(month)}/${year}`
  }

  const digits = rawValue.replace(/\D/g, "").slice(0, 8)
  if (!digits) return ""

  const day = takeDatePart(digits, 31, 4)
  if (!day.complete) return day.value

  let formatted = `${day.value}/`
  if (!day.rest) return formatted

  const month = takeDatePart(day.rest, 12, 2)
  formatted += month.value
  if (!month.complete) return formatted

  formatted += "/"
  return `${formatted}${month.rest.slice(0, 4)}`
}

export function parseAdminDateInput(value: string) {
  if (!value.trim()) return ""

  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value)
  if (!match) return null

  const [, dayValue, monthValue, yearValue] = match
  const day = Number(dayValue)
  const month = Number(monthValue)
  const year = Number(yearValue)
  const date = new Date(0)
  date.setHours(0, 0, 0, 0)
  date.setFullYear(year, month - 1, day)

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }

  return `${yearValue}-${monthValue}-${dayValue}`
}
