import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startPicking, getLastPickedElement, setLastPickedElement } from '../src/lib/picker'

let cleanup: (() => void) | null = null

function click(el: Element): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
  el.dispatchEvent(ev)
  return ev
}

function hover(el: Element): void {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }))
}

function unhover(el: Element): void {
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, composed: true }))
}

describe('startPicking', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setLastPickedElement(null)
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('click on a page element calls onPick with the target and prevents default', () => {
    const target = document.createElement('button')
    target.id = 'buy'
    document.body.appendChild(target)
    const onPick = vi.fn()
    cleanup = startPicking(onPick)

    const ev = click(target)

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(target)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('records the picked element as lastPickedElement', () => {
    const target = document.createElement('p')
    document.body.appendChild(target)
    cleanup = startPicking(() => {})

    click(target)

    expect(getLastPickedElement()).toBe(target)
  })

  it('ignores clicks originating inside the #c11n-root host', () => {
    const host = document.createElement('div')
    host.id = 'c11n-root'
    const inner = document.createElement('button')
    host.appendChild(inner)
    document.body.appendChild(host)
    const onPick = vi.fn()
    cleanup = startPicking(onPick)

    const ev = click(inner)

    expect(onPick).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('cleanup removes listeners — subsequent clicks are no-ops', () => {
    const target = document.createElement('button')
    document.body.appendChild(target)
    const onPick = vi.fn()
    const stop = startPicking(onPick)
    stop()

    const ev = click(target)

    expect(onPick).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('sets crosshair cursor on body and restores the previous inline value on cleanup', () => {
    document.body.style.cursor = 'pointer'
    const stop = startPicking(() => {})

    expect(document.body.style.cursor).toBe('crosshair')
    stop()
    expect(document.body.style.cursor).toBe('pointer')
  })

  it('hover highlights via inline outline and restores it on unhover and cleanup', () => {
    const target = document.createElement('div')
    target.style.outline = '1px dotted red'
    document.body.appendChild(target)
    const stop = startPicking(() => {})

    hover(target)
    expect(target.style.outline).not.toBe('1px dotted red')
    expect(target.style.outline).toContain('solid')

    unhover(target)
    expect(target.style.outline).toBe('1px dotted red')

    // highlight active at cleanup time is also restored
    hover(target)
    stop()
    expect(target.style.outline).toBe('1px dotted red')
  })

  it('does not highlight elements inside the #c11n-root host', () => {
    const host = document.createElement('div')
    host.id = 'c11n-root'
    const inner = document.createElement('button')
    host.appendChild(inner)
    document.body.appendChild(host)
    cleanup = startPicking(() => {})

    hover(inner)

    expect(inner.style.outline).toBe('')
  })
})
