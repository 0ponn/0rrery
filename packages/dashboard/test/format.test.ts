import { test, expect } from 'bun:test'
import { fmtDuration, fmtTokens, fmtCost } from '../src/format'

test('fmtDuration', () => {
  expect(fmtDuration(950)).toBe('950ms')
  expect(fmtDuration(3500)).toBe('3.5s')
  expect(fmtDuration(65_000)).toBe('1m 5s')
})

test('fmtTokens', () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(1234)).toBe('1.2k')
  expect(fmtTokens(2_500_000)).toBe('2.5M')
})

test('fmtCost', () => {
  expect(fmtCost(0)).toBe('<$0.01')
  expect(fmtCost(0.0049)).toBe('<$0.01')
  expect(fmtCost(0.005)).toBe('$0.01')
  expect(fmtCost(1.234)).toBe('$1.23')
})
