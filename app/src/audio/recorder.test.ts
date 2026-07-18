import { expect, test } from 'vitest'
import { meterLevel, rms } from './recorder'

function tone(n: number, amp: number): Float32Array {
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * i) / 32)
  return b
}

test('rms of silence is 0, and grows with amplitude', () => {
  expect(rms(new Float32Array(256))).toBe(0)
  expect(rms(tone(256, 0.5))).toBeGreaterThan(rms(tone(256, 0.1)))
})

test('meterLevel maps silence→0, full-scale→1, monotonic between', () => {
  expect(meterLevel(0)).toBe(0) // silence pins empty, no NaN from log(0)
  expect(meterLevel(1)).toBe(1) // full scale clamps to full
  // a quiet clip (~−45 dB) reads low; a loud one (~−20 dB) reads high
  const quiet = meterLevel(10 ** (-45 / 20))
  const loud = meterLevel(10 ** (-20 / 20))
  expect(quiet).toBeLessThan(loud)
  expect(quiet).toBeLessThan(0.4)
  expect(loud).toBeGreaterThan(0.7)
})
