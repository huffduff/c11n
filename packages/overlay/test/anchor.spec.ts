import { describe, it, expect, beforeEach } from 'vitest'
import { createAnchor, resolveAnchor, type Anchor } from '../src/lib/anchor'

function anchorOf(selector: string, tag: string, text: string): Anchor {
  return {
    selector,
    meta: { tag, text, rect: { x: 0, y: 0, width: 0, height: 0 } },
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('createAnchor', () => {
  it('round-trips: selector from an id element resolves back to it', () => {
    document.body.innerHTML = '<div><p id="target">hello world</p></div>'
    const el = document.getElementById('target')!
    const anchor = createAnchor(el)
    expect(typeof anchor.selector).toBe('string')
    expect(resolveAnchor(anchor)).toBe(el)
  })

  it('builds meta: lowercase tag, trimmed text capped at 80 chars, rect keys', () => {
    const long = 'x'.repeat(120)
    document.body.innerHTML = `<div><SPAN id="m">  ${long}  </SPAN></div>`
    const el = document.getElementById('m')!
    const anchor = createAnchor(el)
    expect(anchor.meta.tag).toBe('span')
    expect(anchor.meta.text).toBe('x'.repeat(80))
    expect(anchor.meta.text.length).toBe(80)
    expect(anchor.meta.rect).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    })
  })

  it('throws when the element is inside the overlay host #c11n-root', () => {
    document.body.innerHTML = '<div id="c11n-root"><p id="inside">nope</p></div>'
    const el = document.getElementById('inside')!
    expect(() => createAnchor(el)).toThrow(/c11n-root/)
  })
})

describe('resolveAnchor', () => {
  it('primary path: valid selector returns the exact element', () => {
    document.body.innerHTML = '<p id="a">one</p><p id="b">two</p>'
    const el = document.getElementById('b')!
    expect(resolveAnchor(anchorOf('#b', 'p', 'two'))).toBe(el)
  })

  it('fallback: dead selector + unique text-prefix match returns that element', () => {
    document.body.innerHTML =
      '<p>unique prefix and more words</p><p>other text entirely</p>'
    const expected = document.body.querySelector('p')!
    const anchor = anchorOf('#gone-123', 'p', 'unique prefix')
    expect(resolveAnchor(anchor)).toBe(expected)
  })

  it('fallback ambiguity (2+ prefix matches) returns null — no guessing', () => {
    document.body.innerHTML =
      '<p>shared prefix alpha</p><p>shared prefix beta</p>'
    const anchor = anchorOf('#gone-123', 'p', 'shared prefix')
    expect(resolveAnchor(anchor)).toBeNull()
  })

  it('fallback with zero candidates returns null', () => {
    document.body.innerHTML = '<p>nothing similar here</p>'
    const anchor = anchorOf('#gone-123', 'p', 'unmatched prefix')
    expect(resolveAnchor(anchor)).toBeNull()
  })

  it('empty meta.text + dead selector returns null without fallback scan', () => {
    document.body.innerHTML = '<p></p><p></p>'
    const anchor = anchorOf('#gone-123', 'p', '')
    expect(resolveAnchor(anchor)).toBeNull()
  })

  it('invalid selector string does not throw; ladder falls through to fallback', () => {
    document.body.innerHTML = '<p>fallback wins here</p>'
    const expected = document.body.querySelector('p')!
    const anchor = anchorOf(':::garbage', 'p', 'fallback wins')
    expect(() => resolveAnchor(anchor)).not.toThrow()
    expect(resolveAnchor(anchor)).toBe(expected)
  })

  it('never returns elements inside #c11n-root (selector or fallback)', () => {
    // Decoy: a plain (non-shadow) div#c11n-root containing the only matches.
    document.body.innerHTML =
      '<div id="c11n-root"><p id="decoy">overlay text</p></div>'
    // Primary path: selector hits the decoy → guarded → and with no meta.text
    // fallback candidates outside the host, result is null.
    expect(resolveAnchor(anchorOf('#decoy', 'p', 'overlay text'))).toBeNull()
    // Fallback path: dead selector, only text match lives inside the host.
    expect(resolveAnchor(anchorOf('#gone-123', 'p', 'overlay text'))).toBeNull()
    // Fallback still finds a legit twin outside the host uniquely.
    const legit = document.createElement('p')
    legit.textContent = 'overlay text'
    document.body.appendChild(legit)
    expect(resolveAnchor(anchorOf('#gone-123', 'p', 'overlay text'))).toBe(legit)
  })
})

// Review fix: corrupted meta.tag must not throw out of resolveAnchor.
describe('resolveAnchor corrupted meta', () => {
  it('returns null (no throw) when meta.tag is an invalid selector', () => {
    const anchor = anchorOf('#definitely-gone-404', ':::garbage', 'whatever')
    expect(() => resolveAnchor(anchor)).not.toThrow()
    expect(resolveAnchor(anchor)).toBeNull()
  })
})
