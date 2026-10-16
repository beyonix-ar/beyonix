// Confirmación audible/háptica de un escaneo, como un lector de depósito.
// Opcional: si el navegador no deja reproducir audio o vibrar, no pasa nada.

let context: AudioContext | null = null

function audioContext() {
  if (typeof window === "undefined") return null
  const legacy: Window & { webkitAudioContext?: typeof AudioContext } = window
  const Constructor = window.AudioContext ?? legacy.webkitAudioContext
  if (!Constructor) return null
  context ??= new Constructor()
  return context
}

function tone(frequency: number, durationMs: number, startOffsetMs = 0) {
  const audio = audioContext()
  if (!audio) return
  if (audio.state === "suspended") void audio.resume().catch(() => {})
  const start = audio.currentTime + startOffsetMs / 1000
  const oscillator = audio.createOscillator()
  const gain = audio.createGain()
  oscillator.type = "square"
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(0.06, start)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationMs / 1000)
  oscillator.connect(gain).connect(audio.destination)
  oscillator.start(start)
  oscillator.stop(start + durationMs / 1000 + 0.02)
}

export function playScanFeedback(kind: "success" | "warning" | "error") {
  try {
    if (kind === "success") tone(1320, 90)
    else if (kind === "warning") { tone(660, 90); tone(660, 90, 140) }
    else tone(220, 260)
    navigator.vibrate?.(kind === "success" ? 40 : kind === "warning" ? [60, 60, 60] : [180, 80, 180])
  } catch { /* Feedback opcional. */ }
}
