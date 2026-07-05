import { useLayoutEffect, useRef, useState } from 'react'

export const ROW_H = 24

export function visibleRange(scrollTop: number, viewportH: number, rowH: number, total: number, overscan = 20) {
  const rawStart = Math.floor(scrollTop / rowH) - overscan
  const end = Math.min(total, Math.max(0, Math.ceil((scrollTop + viewportH) / rowH) + overscan))
  const start = Math.min(Math.max(0, rawStart), end)
  return { start, end, padTop: start * rowH, padBottom: (total - end) * rowH }
}

export function useVirtualRows(total: number, rowH = ROW_H) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(800)
  useLayoutEffect(() => {
    if (ref.current) setViewportH(ref.current.clientHeight)
  }, [])
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setScrollTop(el.scrollTop)
    if (el.clientHeight !== viewportH) setViewportH(el.clientHeight)
  }
  return { ref, onScroll, ...visibleRange(scrollTop, viewportH, rowH, total) }
}
