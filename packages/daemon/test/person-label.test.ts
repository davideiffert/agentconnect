import { describe, expect, it } from 'vitest'
import { isPersonId, personLabel } from '../src/slack/name-resolver.js'

describe('personLabel', () => {
  it('names a Slack person next to their id', () => {
    expect(personLabel('U02LTRR6A', 'Jordan Eiffert')).toBe('Jordan Eiffert (U02LTRR6A)')
  })
  it('keeps the bare id when the name is unknown', () => {
    expect(personLabel('U02LTRR6A', undefined)).toBe('U02LTRR6A')
  })
  it('never names a non-person id', () => {
    expect(personLabel('B0123456', 'Some Bot')).toBe('B0123456')
    expect(personLabel('C0CBV5YN7KQ', '#general')).toBe('C0CBV5YN7KQ')
    expect(isPersonId('W0123ABCD')).toBe(true)
    expect(isPersonId('b7eabb84-3647')).toBe(false)
  })
})
