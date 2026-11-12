"use client"

import { useEffect, useRef } from "react"

export interface ShortcutHandlers {
  next: () => void
  prev: () => void
  open: () => void
  reply: () => void
  resolve: () => void
  ignore: () => void
  /** Space: quick preview in the side sheet. */
  preview?: () => void
  /** Esc (when no sheet or dialog handles it), e.g. back to the list from the item page. */
  escape?: () => void
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
}

/** A confirmation dialog or an open menu/listbox owns the keyboard. */
function overlayOpen(): boolean {
  return Boolean(document.querySelector('[role="alertdialog"], [role="menu"], [role="listbox"]'))
}

/**
 * Inbox shortcuts: j/k move, Enter/o open the full view, Space preview, r reply, e resolve,
 * i ignore. Esc is handled by the sheet itself unless an `escape` handler is given.
 * Ignored while typing or when a dialog/menu is open.
 */
export function useInboxShortcuts(handlers: ShortcutHandlers, enabled = true) {
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (isTyping(e.target) || overlayOpen()) return
      const h = ref.current
      const map: Record<string, (() => void) | undefined> = {
        j: h.next,
        k: h.prev,
        Enter: h.open,
        o: h.open,
        r: h.reply,
        e: h.resolve,
        i: h.ignore,
        " ": h.preview,
        Escape: h.escape,
      }
      const fn = map[e.key]
      if (!fn) return
      // Enter/Space on a focused button/link should keep its native behaviour.
      if (
        (e.key === "Enter" || e.key === " ") &&
        e.target instanceof HTMLElement &&
        e.target.closest("button, a")
      )
        return
      e.preventDefault()
      fn()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled])
}
