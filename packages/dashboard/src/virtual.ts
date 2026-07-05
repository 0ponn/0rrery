import { useState } from 'react'

export const ROW_H = 24

export function visibleRange(scrollTop: number, viewportH: number, rowH: number, total: number, overscan = 20) {
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + overscan)
  return { start, end, padTop: start * rowH, padBottom: (total - end) * rowH }
}

export function useVirtualRows(total: number, rowH = ROW_H) {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(800)
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setScrollTop(el.scrollTop)
    if (el.clientHeight !== viewportH) setViewportH(el.clientHeight)
  }
  return { onScroll, ...visibleRange(scrollTop, viewportH, rowH, total) }
}
