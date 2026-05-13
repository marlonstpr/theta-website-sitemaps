import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import {
  urlPath,
  sectionOf,
  colorFor,
  SECTION_COLORS,
  buildTree,
  indexByPage,
} from './lib/sitemap.js'
import './App.css'

const ROW_H = 40
const COL_W = 680
const NODE_R = 11
const MARGIN = { top: 44, right: 400, bottom: 60, left: 44 }

export default function App() {
  const [manifest, setManifest] = useState(null)
  const [activeSite, setActiveSite] = usePersistedState(
    'theta-sitemap.activeSite',
    null,
  )
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState(null)
  const [siteOpen, setSiteOpen] = useState(false)
  const siteRef = useRef(null)
  // overrides: full-path -> true (force collapsed) | false (force expanded)
  const [overrides, setOverrides] = useState(() => new Map())
  const [selected, setSelected] = useState(null) // tree node
  const [search, setSearch] = useState('')
  const [showAllCrossLinks, setShowAllCrossLinks] = usePersistedState(
    'theta-sitemap.filters.showAllCrossLinks',
    false,
  )
  const [uniqueOnly, setUniqueOnly] = usePersistedState(
    'theta-sitemap.filters.uniqueOnly',
    true,
  )
  const [hideBroken, setHideBroken] = usePersistedState(
    'theta-sitemap.filters.hideBroken',
    false,
  )
  const [hideUntitled, setHideUntitled] = usePersistedState(
    'theta-sitemap.filters.hideUntitled',
    false,
  )
  // Filter chips for the inbound/outbound lists, scoped by selected node so
  // switching pages naturally clears them. Key: `${nodeFull}:out|in` → section.
  const [filterByKey, setFilterByKey] = useState({})

  const viewportRef = useRef(null)
  const svgRef = useRef(null)
  const zoomRef = useRef(null)
  const initialFitRef = useRef(false)
  const filtersRef = useRef(null)
  // When a toggle changes the layout, stash the full-path here so we can pan
  // to it after the new layout is rendered.
  const pendingPanRef = useRef(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [transform, setTransform] = useState(d3.zoomIdentity)
  const [containerDims, setContainerDims] = useState({ w: 800, h: 600 })

  // Close the filters popover when clicking outside it.
  useEffect(() => {
    if (!filtersOpen) return
    function onDoc(e) {
      if (!filtersRef.current) return
      if (!filtersRef.current.contains(e.target)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [filtersOpen])

  // Step 1: load the multi-site manifest.
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}sites.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load sites.json (HTTP ${r.status})`)
        return r.json()
      })
      .then((m) => setManifest(m))
      .catch((e) => setError(String(e)))
  }, [])

  // Make sure activeSite is valid against the loaded manifest.
  useEffect(() => {
    if (!manifest) return
    if (!activeSite || !manifest.sites?.[activeSite]) {
      setActiveSite(manifest.default || Object.keys(manifest.sites || {})[0])
    }
  }, [manifest]) // eslint-disable-line react-hooks/exhaustive-deps

  // Step 2: whenever activeSite or manifest changes, load that site's graph.
  useEffect(() => {
    if (!manifest || !activeSite || !manifest.sites?.[activeSite]) return
    const site = manifest.sites[activeSite]
    setGraph(null)
    setSelected(null)
    initialFitRef.current = false
    fetch(`${import.meta.env.BASE_URL}${site.data}`)
      .then((r) => {
        if (!r.ok)
          throw new Error(`Could not load ${site.data} (HTTP ${r.status})`)
        return r.json()
      })
      .then(setGraph)
      .catch((e) => setError(String(e)))
  }, [manifest, activeSite]) // eslint-disable-line react-hooks/exhaustive-deps

  // Per-site filter config (broken / untitled markers).
  const siteFilters = useMemo(() => {
    if (!manifest || !activeSite) return null
    return manifest.sites?.[activeSite]?.filters || null
  }, [manifest, activeSite])

  // Close the site-picker popover when clicking outside.
  useEffect(() => {
    if (!siteOpen) return
    function onDoc(e) {
      if (!siteRef.current) return
      if (!siteRef.current.contains(e.target)) setSiteOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [siteOpen])

  // Site's display root (used in detail panel links). Falls back to graph meta.
  const siteRoot = useMemo(() => {
    if (!manifest || !activeSite) return ''
    return manifest.sites?.[activeSite]?.url || ''
  }, [manifest, activeSite])

  // Build full tree from pages
  const fullTree = useMemo(() => (graph ? buildTree(graph.nodes) : null), [graph])
  const pageToTreeNode = useMemo(
    () => (fullTree ? indexByPage(fullTree) : null),
    [fullTree],
  )

  // Counts of hide-able pages, recomputed when graph or filter config changes.
  const hideableCounts = useMemo(() => {
    if (!graph) return { broken: 0, untitled: 0 }
    let broken = 0
    let untitled = 0
    for (const n of graph.nodes) {
      if (isBrokenPage(n, siteFilters)) broken++
      else if (isUntitledPage(n, siteFilters)) untitled++
    }
    return { broken, untitled }
  }, [graph, siteFilters])

  // Tree with hidden pages stripped out (subtrees of hidden nodes are dropped too).
  const filteredTree = useMemo(() => {
    if (!fullTree) return null
    if (!hideBroken && !hideUntitled) return fullTree
    function shouldHide(page) {
      if (!page) return false
      if (hideBroken && isBrokenPage(page, siteFilters)) return true
      if (hideUntitled && isUntitledPage(page, siteFilters)) return true
      return false
    }
    function visit(node) {
      if (shouldHide(node.page)) return null
      const kids = []
      for (const c of node.children) {
        const v = visit(c)
        if (v) kids.push(v)
      }
      return { ...node, children: kids }
    }
    return visit(fullTree)
  }, [fullTree, hideBroken, hideUntitled, siteFilters])

  // Default: collapse everything at depth >= 1 so user starts with a clean overview.
  const defaultCollapsed = useMemo(() => {
    if (!fullTree) return new Set()
    const s = new Set()
    function visit(node, depth) {
      if (depth >= 1 && node.children.length > 0) s.add(node.full)
      node.children.forEach((c) => visit(c, depth + 1))
    }
    visit(fullTree, 0)
    return s
  }, [fullTree])

  // Effective collapsed set: default ± user overrides.
  const collapsed = useMemo(() => {
    const s = new Set(defaultCollapsed)
    overrides.forEach((wantCollapsed, full) => {
      if (wantCollapsed) s.add(full)
      else s.delete(full)
    })
    return s
  }, [defaultCollapsed, overrides])

  // d3.hierarchy + d3.tree layout, respecting collapsed state.
  const layout = useMemo(() => {
    if (!filteredTree) return null
    const treeRoot = d3.hierarchy(filteredTree, (n) =>
      collapsed.has(n.full) ? null : n.children,
    )
    d3.tree().nodeSize([ROW_H, COL_W])(treeRoot)
    return treeRoot
  }, [filteredTree, collapsed])

  // Find min/max x to determine height; min/max y for width.
  const layoutBounds = useMemo(() => {
    if (!layout) return null
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    layout.each((n) => {
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    })
    return { minX, maxX, minY, maxY }
  }, [layout])

  // Visible tree nodes (the d3 hierarchy nodes), keyed by full path
  const visibleByFull = useMemo(() => {
    if (!layout) return new Map()
    const m = new Map()
    layout.each((n) => m.set(n.data.full, n))
    return m
  }, [layout])

  // For a page URL, return the visible hierarchy node that represents it
  // (the page itself if visible, otherwise the deepest visible ancestor).
  const visibleNodeForPage = useCallback(
    (pageId) => {
      if (!pageToTreeNode) return null
      const treeNode = pageToTreeNode.get(pageId)
      if (!treeNode) return null
      let cursor = treeNode
      while (cursor) {
        const v = visibleByFull.get(cursor.full)
        if (v) return v
        const idx = cursor.full.lastIndexOf('/')
        if (idx <= 0) return visibleByFull.get('/') || null
        const parentFull = cursor.full.slice(0, idx) || '/'
        cursor = findByFull(fullTree, parentFull)
      }
      return null
    },
    [pageToTreeNode, visibleByFull, fullTree],
  )

  // Search highlighting
  const matches = useMemo(() => {
    if (!search.trim() || !layout) return null
    const q = search.trim().toLowerCase()
    const m = new Set()
    layout.each((n) => {
      const p = n.data.page
      const label = (p && p.title) || n.data.full
      if (label.toLowerCase().includes(q) || n.data.full.toLowerCase().includes(q))
        m.add(n.data.full)
    })
    return m
  }, [search, layout])

  // Cross-links: from each visible node, edges to other visible nodes that are
  // NOT in the parent/child relationship within the tree.
  const crossLinksForSelected = useMemo(() => {
    if (!graph || !selected || !pageToTreeNode) return null
    // Collect all pages that the selected node represents
    // (itself + every descendant in the full tree)
    const reps = new Set()
    function collect(n) {
      if (n.page) reps.add(n.page.id)
      n.children.forEach(collect)
    }
    collect(selected.data)

    const out = []
    const inn = []
    for (const l of graph.links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      const sIn = reps.has(s)
      const tIn = reps.has(t)
      if (sIn && !tIn) {
        const vt = visibleNodeForPage(t)
        if (vt && vt !== selected) out.push({ from: selected, to: vt, sourcePage: s, targetPage: t })
      } else if (tIn && !sIn) {
        const vs = visibleNodeForPage(s)
        if (vs && vs !== selected) inn.push({ from: vs, to: selected, sourcePage: s, targetPage: t })
      }
    }
    return { out, inn, reps }
  }, [graph, selected, pageToTreeNode, visibleNodeForPage])

  // Visible cross-links (what gets drawn and listed). When uniqueOnly is on,
  // dedupe by the *visible* node pair so we draw one curve per connection.
  const visibleCrossLinks = useMemo(() => {
    if (!crossLinksForSelected) return { out: [], inn: [] }
    if (!uniqueOnly) return crossLinksForSelected
    return {
      out: dedupePairs(crossLinksForSelected.out),
      inn: dedupePairs(crossLinksForSelected.inn, true),
    }
  }, [crossLinksForSelected, uniqueOnly])

  // Cross-link analytics: occurrence counts per target/source page, plus
  // per-section aggregation for the breakdown bar.
  const crossLinkAnalytics = useMemo(() => {
    if (!crossLinksForSelected) return null
    function analyse(list, side) {
      // side: 'out' uses cl.to as the "other" node; 'inn' uses cl.from
      const counts = new Map() // full -> { node, count, section }
      const sections = new Map() // section -> { uniquePages: Set, occurrences: count }
      for (const cl of list) {
        const other = side === 'out' ? cl.to : cl.from
        const sec = other.data.page
          ? other.data.page.section || sectionOf(other.data.page.id)
          : sectionOf(other.data.full)
        const key = other.data.full
        if (!counts.has(key)) counts.set(key, { node: other, count: 0, section: sec })
        counts.get(key).count += 1
        if (!sections.has(sec))
          sections.set(sec, { uniquePages: new Set(), occurrences: 0 })
        const s = sections.get(sec)
        s.uniquePages.add(key)
        s.occurrences += 1
      }
      const sortedDestinations = [...counts.values()].sort(
        (a, b) => b.count - a.count || a.node.data.full.localeCompare(b.node.data.full),
      )
      const sortedSections = [...sections.entries()]
        .map(([name, v]) => ({
          name,
          unique: v.uniquePages.size,
          occurrences: v.occurrences,
        }))
        .sort((a, b) => b.occurrences - a.occurrences || b.unique - a.unique)
      return { destinations: sortedDestinations, sections: sortedSections }
    }
    return {
      out: analyse(crossLinksForSelected.out, 'out'),
      inn: analyse(crossLinksForSelected.inn, 'inn'),
    }
  }, [crossLinksForSelected])

  // Background "show all cross-links" — aggregate by visible node pair.
  const aggregateCrossLinks = useMemo(() => {
    if (!showAllCrossLinks || !graph || !pageToTreeNode || !visibleByFull.size) return null
    const pairs = new Map() // "from.full -> to.full" -> count
    for (const l of graph.links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      const vs = visibleNodeForPage(s)
      const vt = visibleNodeForPage(t)
      if (!vs || !vt || vs === vt) continue
      // Skip parent-child relationships (those are already drawn as tree edges)
      if (vs.parent === vt || vt.parent === vs) continue
      const key = vs.data.full + '⇒' + vt.data.full
      pairs.set(key, (pairs.get(key) || 0) + 1)
    }
    return [...pairs.entries()].map(([k, n]) => {
      const [a, b] = k.split('⇒')
      return { from: visibleByFull.get(a), to: visibleByFull.get(b), count: n }
    })
  }, [showAllCrossLinks, graph, pageToTreeNode, visibleByFull, visibleNodeForPage])

  // Tree content bounds (used for initial fit, not for SVG sizing).
  const treeW = layoutBounds
    ? layoutBounds.maxY - layoutBounds.minY + MARGIN.left + MARGIN.right
    : 800
  const treeH = layoutBounds
    ? layoutBounds.maxX - layoutBounds.minX + MARGIN.top + MARGIN.bottom
    : 600

  // Convert d3 (x,y) → tree-local coords. The container's transform layer
  // handles pan & zoom from there.
  function nodeXY(n) {
    return {
      x: n.y - (layoutBounds ? layoutBounds.minY : 0) + MARGIN.left,
      y: n.x - (layoutBounds ? layoutBounds.minX : 0) + MARGIN.top,
    }
  }

  // Track viewport size. Depends on `graph` because the .viewport node only
  // exists after the loading state ends.
  useEffect(() => {
    if (!graph || !viewportRef.current) return
    const node = viewportRef.current
    const rect = node.getBoundingClientRect()
    setContainerDims({ w: Math.max(100, rect.width), h: Math.max(100, rect.height) })
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect
        setContainerDims({ w: Math.max(100, width), h: Math.max(100, height) })
      }
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [graph])

  // Install d3.zoom. Depends on `graph` so the effect re-runs after the SVG
  // is actually in the DOM.
  useEffect(() => {
    if (!graph || !svgRef.current) return
    const svg = d3.select(svgRef.current)
    const zoom = d3
      .zoom()
      .scaleExtent([0.15, 4])
      .filter((event) => {
        // Allow wheel zoom anywhere. For drag, block when starting on an
        // interactive node element so clicks aren't hijacked.
        if (event.type === 'wheel') return true
        const tag = event.target.tagName
        if (tag === 'circle' || tag === 'rect' || tag === 'text' || tag === 'tspan')
          return false
        return true
      })
      .on('zoom', (event) => setTransform(event.transform))
    svg.call(zoom)
    zoomRef.current = zoom
    return () => {
      svg.on('.zoom', null)
    }
  }, [graph])

  // Compute a transform that fits the tree into the viewport with padding.
  const fitTransform = useCallback(() => {
    if (!layoutBounds) return d3.zoomIdentity
    const pad = 40
    const k = Math.min(
      (containerDims.w - pad * 2) / treeW,
      (containerDims.h - pad * 2) / treeH,
      1,
    )
    const tx = (containerDims.w - treeW * k) / 2
    const ty = (containerDims.h - treeH * k) / 2
    return d3.zoomIdentity.translate(tx, ty).scale(k)
  }, [layoutBounds, treeW, treeH, containerDims])

  // Initial fit when both layout and viewport size are known.
  useEffect(() => {
    if (initialFitRef.current) return
    if (!svgRef.current || !zoomRef.current || !layoutBounds) return
    if (containerDims.w < 200 || containerDims.h < 200) return
    initialFitRef.current = true
    d3.select(svgRef.current).call(zoomRef.current.transform, fitTransform())
  }, [layoutBounds, containerDims, fitTransform])

  // Pan/zoom to selected node so it's roughly centered.
  useEffect(() => {
    if (!selected || !svgRef.current || !zoomRef.current || !layoutBounds) return
    const { x, y } = nodeXY(selected)
    const k = Math.max(transform.k, 0.9)
    const tx = containerDims.w * 0.35 - x * k
    const ty = containerDims.h / 2 - y * k
    d3.select(svgRef.current)
      .transition()
      .duration(450)
      .call(zoomRef.current.transform, d3.zoomIdentity.translate(tx, ty).scale(k))
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  // After a collapse/expand toggle, pan to keep the toggled node in view.
  // The layout has just updated, so we look up the node's new position.
  useEffect(() => {
    const targetFull = pendingPanRef.current
    if (!targetFull) return
    pendingPanRef.current = null
    if (!layout || !svgRef.current || !zoomRef.current) return
    let target = null
    layout.each((n) => {
      if (n.data.full === targetFull) target = n
    })
    if (!target) return
    const { x, y } = nodeXY(target)
    const k = Math.max(transform.k, 0.9)
    const tx = containerDims.w * 0.35 - x * k
    const ty = containerDims.h / 2 - y * k
    d3.select(svgRef.current)
      .transition()
      .duration(400)
      .call(zoomRef.current.transform, d3.zoomIdentity.translate(tx, ty).scale(k))
  }, [layout]) // eslint-disable-line react-hooks/exhaustive-deps

  function resetView() {
    if (!svgRef.current || !zoomRef.current) return
    d3.select(svgRef.current)
      .transition()
      .duration(400)
      .call(zoomRef.current.transform, fitTransform())
  }
  function zoomBy(factor) {
    if (!svgRef.current || !zoomRef.current) return
    d3.select(svgRef.current)
      .transition()
      .duration(180)
      .call(zoomRef.current.scaleBy, factor)
  }

  function toggleCollapsed(node) {
    const full = node.data.full
    const currentlyCollapsed = collapsed.has(full)
    pendingPanRef.current = full
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(full, !currentlyCollapsed)
      return next
    })
  }

  function expandAll() {
    const m = new Map()
    defaultCollapsed.forEach((f) => m.set(f, false))
    setOverrides(m)
  }
  function collapseAll() {
    if (!fullTree) return
    const all = new Map()
    function visit(n, depth) {
      if (depth >= 1 && n.children.length > 0) all.set(n.full, true)
      n.children.forEach((c) => visit(c, depth + 1))
    }
    visit(fullTree, 0)
    setOverrides(all)
  }

  if (error) return <div className="app"><div className="state">Error: {error}</div></div>
  if (!graph || !layout || !layoutBounds) return <div className="app"><div className="state">Loading sitemap…</div></div>

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="6" cy="6" r="2.5" />
              <circle cx="6" cy="18" r="2.5" />
              <circle cx="18" cy="12" r="2.5" />
              <path d="M8 7l8 4M8 17l8-4" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="site-picker" ref={siteRef}>
              <button
                className={'site-picker-btn' + (siteOpen ? ' open' : '')}
                onClick={() => setSiteOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={siteOpen}
              >
                <span className="brand-title">
                  {manifest?.sites?.[activeSite]?.name || 'Sitemap'}
                </span>
                <svg
                  className={'chev' + (siteOpen ? ' up' : '')}
                  viewBox="0 0 24 24" width="14" height="14"
                  fill="none" stroke="currentColor" strokeWidth="2.4"
                  strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {siteOpen && manifest?.sites && (
                <div className="popover site-popover" role="listbox">
                  <div className="popover-heading">Site</div>
                  {Object.entries(manifest.sites).map(([id, s]) => (
                    <button
                      key={id}
                      role="option"
                      aria-selected={activeSite === id}
                      className={'site-row' + (activeSite === id ? ' active' : '')}
                      onClick={() => {
                        setActiveSite(id)
                        setSiteOpen(false)
                      }}
                    >
                      <div className="site-row-name">{s.name}</div>
                      <div className="site-row-meta">
                        {s.pages.toLocaleString()} pages ·{' '}
                        {s.edges.toLocaleString()} links
                      </div>
                      <div className="site-row-url">{s.url}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="brand-sub">
              <span className="pill">{graph.meta.pages} pages</span>
              <span className="pill">{graph.meta.edges.toLocaleString()} links</span>
            </div>
          </div>
        </div>

        <div className="search-wrap">
          <svg className="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            className="search"
            placeholder="Search pages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="search-clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="actions">
          <div className="btn-group" role="group" aria-label="Tree controls">
            <button className="btn" onClick={expandAll} title="Expand every subtree">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 12h8M12 8v8" />
              </svg>
              Expand
            </button>
            <button className="btn" onClick={collapseAll} title="Collapse all subtrees">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 12h8" />
              </svg>
              Collapse
            </button>
          </div>

          {(() => {
            const activeCount =
              (uniqueOnly ? 0 : 1) +
              (showAllCrossLinks ? 1 : 0) +
              (hideBroken ? 1 : 0) +
              (hideUntitled ? 1 : 0)
            return (
              <div className="filters-wrap" ref={filtersRef}>
                <button
                  className={'btn filters-btn' + (filtersOpen ? ' open' : '') + (activeCount > 0 ? ' has-active' : '')}
                  onClick={() => setFiltersOpen((v) => !v)}
                  aria-haspopup="true"
                  aria-expanded={filtersOpen}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 6h16M7 12h10M10 18h4" />
                  </svg>
                  Filters
                  {activeCount > 0 && (
                    <span className="filters-badge">{activeCount}</span>
                  )}
                  <svg
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={'chev' + (filtersOpen ? ' up' : '')}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                {filtersOpen && (
                  <div className="popover" role="dialog">
                    <div className="popover-section">
                      <div className="popover-heading">Display</div>
                      <PopoverToggle
                        checked={uniqueOnly}
                        onChange={setUniqueOnly}
                        title="Unique links only"
                        description="Counts each linked page once instead of every occurrence on the source page."
                      />
                      <PopoverToggle
                        checked={showAllCrossLinks}
                        onChange={setShowAllCrossLinks}
                        title="Show all cross-links"
                        description="Faintly overlay every cross-link between visible tree branches."
                      />
                    </div>

                    <div className="popover-divider" />

                    <div className="popover-section">
                      <div className="popover-heading">Hide pages</div>
                      <PopoverToggle
                        checked={hideBroken}
                        onChange={setHideBroken}
                        title="Broken"
                        countLabel={hideableCounts.broken}
                        description="Pages whose title is “Not Found” — soft-404 destinations of broken internal links."
                      />
                      <PopoverToggle
                        checked={hideUntitled}
                        onChange={setHideUntitled}
                        title="Untitled"
                        countLabel={hideableCounts.untitled}
                        description="Pages whose title is just “Theta” — CMS pages without a custom title."
                      />
                    </div>

                    {activeCount > 0 && (
                      <>
                        <div className="popover-divider" />
                        <button
                          className="popover-reset"
                          onClick={() => {
                            setUniqueOnly(true)
                            setShowAllCrossLinks(false)
                            setHideBroken(false)
                            setHideUntitled(false)
                          }}
                        >
                          Reset to defaults
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      </header>

      <div className="main">
        <div className="viewport" ref={viewportRef}>
          <svg
            ref={svgRef}
            width={containerDims.w}
            height={containerDims.h}
            style={{ cursor: 'grab', display: 'block' }}
            onClick={(e) => {
              if (e.target.tagName === 'svg') setSelected(null)
            }}
          >
            <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {/* Tree links (parent → child) */}
            <g className="tree-links">
              {layout.links().map((l, i) => {
                const a = nodeXY(l.source)
                const b = nodeXY(l.target)
                const mx = (a.x + b.x) / 2
                return (
                  <path
                    key={i}
                    d={`M${a.x},${a.y}C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`}
                    fill="none"
                    stroke="#4d5167"
                    strokeWidth="2"
                  />
                )
              })}
            </g>

            {/* Aggregate cross-links (background, when toggle is on) */}
            {aggregateCrossLinks && (
              <g className="cross-links bg">
                {aggregateCrossLinks.map((cl, i) => {
                  if (!cl.from || !cl.to) return null
                  const a = nodeXY(cl.from)
                  const b = nodeXY(cl.to)
                  const dy = b.y - a.y
                  const mx = (a.x + b.x) / 2 + Math.abs(dy) * 0.15
                  return (
                    <path
                      key={i}
                      d={`M${a.x},${a.y}Q${mx},${(a.y + b.y) / 2} ${b.x},${b.y}`}
                      fill="none"
                      stroke="#aa3bff"
                      strokeOpacity={Math.min(0.35, 0.04 + cl.count * 0.0005)}
                      strokeWidth={Math.min(1.8, 0.4 + cl.count * 0.02)}
                    />
                  )
                })}
              </g>
            )}

            {/* Highlighted cross-links (when a node is selected) */}
            {crossLinksForSelected && (
              <g className="cross-links hot">
                {visibleCrossLinks.out.map((cl, i) => {
                  const a = nodeXY(cl.from)
                  const b = nodeXY(cl.to)
                  const dy = b.y - a.y
                  const mx = (a.x + b.x) / 2 + Math.abs(dy) * 0.25
                  return (
                    <path
                      key={'o' + i}
                      d={`M${a.x},${a.y}Q${mx},${(a.y + b.y) / 2} ${b.x},${b.y}`}
                      fill="none"
                      stroke="#fbbf24"
                      strokeOpacity="0.75"
                      strokeWidth="1.2"
                      markerEnd="url(#arrow-out)"
                    />
                  )
                })}
                {visibleCrossLinks.inn.map((cl, i) => {
                  const a = nodeXY(cl.from)
                  const b = nodeXY(cl.to)
                  const dy = b.y - a.y
                  const mx = (a.x + b.x) / 2 - Math.abs(dy) * 0.25
                  return (
                    <path
                      key={'i' + i}
                      d={`M${a.x},${a.y}Q${mx},${(a.y + b.y) / 2} ${b.x},${b.y}`}
                      fill="none"
                      stroke="#22d3ee"
                      strokeOpacity="0.7"
                      strokeWidth="1.1"
                    />
                  )
                })}
              </g>
            )}

            <defs>
              <marker
                id="arrow-out"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="#fbbf24" />
              </marker>
            </defs>

            {/* Nodes */}
            <g className="tree-nodes">
              {layout.descendants().map((n) => {
                const { x, y } = nodeXY(n)
                const isSelected = selected && selected.data.full === n.data.full
                const isMatch = matches ? matches.has(n.data.full) : true
                const hasChildren = n.data.children.length > 0
                const isCollapsed = collapsed.has(n.data.full)
                const sec = n.data.page
                  ? n.data.page.section || sectionOf(n.data.page.id)
                  : sectionOf(n.data.full)
                const color = colorFor(sec)
                const label =
                  (n.data.page && n.data.page.title) ||
                  (n.data.full === '/' ? 'Home (/)' : n.data.name)
                const text =
                  label.length > 42 ? label.slice(0, 39) + '…' : label

                // Subtree page count (for collapsed indicator)
                let subCount = 0
                if (isCollapsed) {
                  function count(node) {
                    if (node.page) subCount++
                    node.children.forEach(count)
                  }
                  count(n.data)
                  subCount -= n.data.page ? 1 : 0
                }

                // Hit rect dimensions: cover toggle + circle + label with a
                // pleasant click area, capped so neighbouring columns don't fight.
                const approxLabelWidth = text.length * 9.2 + (isCollapsed && subCount > 0 ? 36 : 0) + (!n.data.page ? 106 : 0)
                const hitX = hasChildren ? -56 : -22
                const hitW = Math.min(
                  (hasChildren ? 56 : 22) + NODE_R + 14 + approxLabelWidth + 20,
                  COL_W - 24,
                )

                return (
                  <g
                    key={n.data.full}
                    transform={`translate(${x},${y})`}
                    className={'node' + (isSelected ? ' selected' : '')}
                    opacity={matches && !isMatch ? 0.25 : 1}
                  >
                    <rect
                      className="hit"
                      x={hitX}
                      y={-ROW_H / 2 + 3}
                      width={hitW}
                      height={ROW_H - 6}
                      rx="8"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelected(n)
                      }}
                    />
                    {hasChildren && (
                      <g
                        className={'toggle-btn' + (isCollapsed ? ' collapsed' : ' expanded')}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleCollapsed(n)
                        }}
                      >
                        {/* Outer ring (collapsed only): adds a soft halo for emphasis */}
                        {isCollapsed && (
                          <circle
                            className="toggle-halo"
                            cx="-34"
                            cy="0"
                            r="21"
                            fill={color}
                            opacity="0.18"
                          />
                        )}
                        <circle
                          className="toggle-disc"
                          cx="-34"
                          cy="0"
                          r="17"
                          fill={isCollapsed ? color : '#1a1d28'}
                          stroke={color}
                          strokeWidth="2.4"
                        />
                        {/* Chevron — ▶ when collapsed, ▼ when expanded */}
                        <path
                          className="toggle-chevron"
                          d={
                            isCollapsed
                              ? 'M-37.5,-7 L-29,0 L-37.5,7'
                              : 'M-41,-3.5 L-34,4.5 L-27,-3.5'
                          }
                          fill="none"
                          stroke={isCollapsed ? '#fff' : color}
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ pointerEvents: 'none' }}
                        />
                      </g>
                    )}
                    <circle
                      r={NODE_R}
                      fill={n.data.page ? color : '#1c1e26'}
                      stroke={color}
                      strokeWidth={isSelected ? 3.4 : 1.8}
                      style={{ pointerEvents: 'none' }}
                    />
                    <text
                      x={NODE_R + 12}
                      y="0"
                      dominantBaseline="central"
                      fontSize="18"
                      fill={isSelected ? '#fff' : '#e3e6ee'}
                      fontWeight={isSelected ? 600 : 500}
                      style={{ pointerEvents: 'none' }}
                    >
                      {text}
                      {isCollapsed && subCount > 0 && (
                        <tspan fill="#7d8395" fontSize="15" fontWeight="500">
                          {' '}
                          ({subCount})
                        </tspan>
                      )}
                      {!n.data.page && (
                        <tspan fill="#7d8395" fontSize="15" fontStyle="italic" fontWeight="400">
                          {' '}
                          (intermediate)
                        </tspan>
                      )}
                    </text>
                  </g>
                )
              })}
            </g>
            </g>
          </svg>
          <div className="viewport-controls">
            <div className="control-panel">
              <button
                className="control-btn"
                onClick={() => zoomBy(1.4)}
                title="Zoom in"
                aria-label="Zoom in"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M12 6v12M6 12h12" />
                </svg>
              </button>
              <div className="control-divider" />
              <button
                className="control-btn"
                onClick={() => zoomBy(1 / 1.4)}
                title="Zoom out"
                aria-label="Zoom out"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 12h12" />
                </svg>
              </button>
              <div className="control-divider" />
              <button
                className="control-btn"
                onClick={resetView}
                title="Fit to view"
                aria-label="Fit to view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
                </svg>
              </button>
            </div>
            <div className="zoom-readout" title="Current zoom level">
              {Math.round(transform.k * 100)}%
            </div>
          </div>
        </div>

        <aside className="side">
          {!selected && (
            <>
              <div className="welcome">
                <h2 className="welcome-title">Explore the sitemap</h2>
                <p className="welcome-sub">
                  {graph.meta.pages} pages, organised by URL path. Click any node to see what links to and from it.
                </p>
              </div>

              <div className="card tips">
                <h3>Tips</h3>
                <ul className="tip-list">
                  <li>
                    <span className="tip-key">Drag</span> the canvas to pan,{' '}
                    <span className="tip-key">scroll</span> to zoom.
                  </li>
                  <li>
                    Click <span className="tip-key">＋</span> /{' '}
                    <span className="tip-key">−</span> to expand or collapse a subtree.
                  </li>
                  <li>
                    <span className="dot gold" /> Outbound cross‑links ·{' '}
                    <span className="dot cyan" /> Inbound cross‑links.
                  </li>
                </ul>
              </div>

              <h3>Top‑level sections</h3>
              <ul className="section-list">
                {fullTree.children.map((c) => {
                  let n = 0
                  function count(node) {
                    if (node.page) n++
                    node.children.forEach(count)
                  }
                  count(c)
                  const color = colorFor(c.name)
                  return (
                    <li key={c.full}>
                      <button
                        className="section-row"
                        onClick={() => {
                          const v = visibleByFull.get(c.full)
                          if (v) setSelected(v)
                        }}
                      >
                        <span className="section-dot" style={{ background: color }} />
                        <span className="section-name">/{c.name}</span>
                        <span className="section-count">{n}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>

              <h3>All sections</h3>
              <ul className="legend">
                {Object.entries(SECTION_COLORS).map(([k, c]) => (
                  <li key={k}>
                    <span className="dot" style={{ background: c }} />
                    /{k === 'home' ? '' : k}
                  </li>
                ))}
              </ul>
            </>
          )}
          {selected && crossLinksForSelected && (
            <>
              <button className="back" onClick={() => setSelected(null)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
                Back to overview
              </button>

              {(() => {
                const sec = selected.data.page
                  ? selected.data.page.section || sectionOf(selected.data.page.id)
                  : sectionOf(selected.data.full)
                const color = colorFor(sec)
                return (
                  <div className="detail-header" style={{ borderTopColor: color }}>
                    <div className="detail-section">
                      <span className="section-dot" style={{ background: color }} />
                      /{sec === 'home' ? '' : sec}
                    </div>
                    <h2 className="detail-title">
                      {(selected.data.page && selected.data.page.title) ||
                        selected.data.full}
                    </h2>
                    {selected.data.page ? (
                      <a
                        className="url"
                        href={selected.data.page.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {(siteRoot ? selected.data.page.url.replace(siteRoot, '') : urlPath(selected.data.page.url)) || '/'}
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 4h6v6M20 4l-9 9M19 13v6H5V5h6" />
                        </svg>
                      </a>
                    ) : (
                      <div className="url dim">
                        {selected.data.full}{' '}
                        <span className="badge">intermediate</span>
                      </div>
                    )}
                  </div>
                )
              })()}

              {(() => {
                const rawIn = crossLinksForSelected.inn.length
                const rawOut = crossLinksForSelected.out.length
                const uniqueIn = new Set(
                  crossLinksForSelected.inn.map((cl) => cl.from.data.full),
                ).size
                const uniqueOut = new Set(
                  crossLinksForSelected.out.map((cl) => cl.to.data.full),
                ).size
                return (
                  <div className="stats">
                    <div
                      title={`${uniqueIn} unique source page${
                        uniqueIn === 1 ? '' : 's'
                      } · ${rawIn} total link occurrence${
                        rawIn === 1 ? '' : 's'
                      } (counts the same link appearing on multiple pages)`}
                    >
                      <strong>
                        {uniqueIn}
                        {!uniqueOnly && (
                          <span className="stat-sub">/ {rawIn.toLocaleString()}</span>
                        )}
                      </strong>
                      <span>inbound</span>
                    </div>
                    <div
                      title={`${uniqueOut} unique target page${
                        uniqueOut === 1 ? '' : 's'
                      } · ${rawOut} total link occurrence${
                        rawOut === 1 ? '' : 's'
                      } (counts the same link appearing on multiple pages)`}
                    >
                      <strong>
                        {uniqueOut}
                        {!uniqueOnly && (
                          <span className="stat-sub">/ {rawOut.toLocaleString()}</span>
                        )}
                      </strong>
                      <span>outbound</span>
                    </div>
                    <div title={`${crossLinksForSelected.reps.size} page${crossLinksForSelected.reps.size === 1 ? '' : 's'} represented by this node`}>
                      <strong>{crossLinksForSelected.reps.size}</strong>
                      <span>{selected.data.children.length ? 'in subtree' : 'page'}</span>
                    </div>
                  </div>
                )
              })()}

              {!uniqueOnly && (
                <p className="stat-explainer">
                  Counts shown as <strong>unique pages / total link occurrences</strong>.
                  Shared nav and footer links inflate the second number — switch on{' '}
                  <strong>Unique links only</strong> in the top bar for a cleaner view.
                </p>
              )}

              {crossLinkAnalytics && (() => {
                const selKey = selected.data.full
                const outFilter = filterByKey[selKey + ':out'] ?? null
                const inFilter = filterByKey[selKey + ':in'] ?? null
                function setFilter(side, sec) {
                  setFilterByKey((prev) => {
                    const next = { ...prev }
                    const k = selKey + ':' + side
                    if (sec === null) delete next[k]
                    else next[k] = sec
                    return next
                  })
                }

                const renderSide = (sideKey, sideLabel, dotClass, analytics, filter) => {
                  const total = analytics.sections.reduce(
                    (sum, s) => sum + (uniqueOnly ? s.unique : s.occurrences),
                    0,
                  )
                  const visible = filter
                    ? analytics.destinations.filter((d) => d.section === filter)
                    : analytics.destinations
                  const totalCount = uniqueOnly
                    ? analytics.destinations.length
                    : analytics.destinations.reduce((s, d) => s + d.count, 0)
                  return (
                    <div className="link-block">
                      <h4>
                        <span className={'h4-dot ' + dotClass} /> {sideLabel} ·{' '}
                        {uniqueOnly
                          ? analytics.destinations.length
                          : totalCount.toLocaleString()}
                      </h4>

                      {analytics.sections.length > 0 && (
                        <>
                          <div
                            className="section-bar"
                            role="group"
                            aria-label={`${sideLabel} by section`}
                          >
                            {analytics.sections.map((s) => {
                              const value = uniqueOnly ? s.unique : s.occurrences
                              const pct = total > 0 ? (value / total) * 100 : 0
                              if (pct < 0.5) return null
                              const isActive = filter === s.name
                              const isMuted = filter && filter !== s.name
                              return (
                                <button
                                  key={s.name}
                                  className={
                                    'section-bar-seg' +
                                    (isActive ? ' active' : '') +
                                    (isMuted ? ' muted' : '')
                                  }
                                  style={{
                                    flexGrow: value,
                                    background: colorFor(s.name),
                                  }}
                                  title={`/${s.name === 'home' ? '' : s.name} · ${s.unique} unique · ${s.occurrences} occurrences${isActive ? ' (click to clear filter)' : ' (click to filter)'}`}
                                  onClick={() =>
                                    setFilter(sideKey, isActive ? null : s.name)
                                  }
                                />
                              )
                            })}
                          </div>
                          <div className="section-legend">
                            {analytics.sections.slice(0, 6).map((s) => {
                              const value = uniqueOnly ? s.unique : s.occurrences
                              const isActive = filter === s.name
                              return (
                                <button
                                  key={'lg' + s.name}
                                  className={'section-chip' + (isActive ? ' active' : '')}
                                  onClick={() =>
                                    setFilter(sideKey, isActive ? null : s.name)
                                  }
                                  title={`${s.unique} unique · ${s.occurrences} occurrences`}
                                >
                                  <span
                                    className="section-dot"
                                    style={{ background: colorFor(s.name) }}
                                  />
                                  /{s.name === 'home' ? '' : s.name}
                                  <span className="chip-count">{value}</span>
                                </button>
                              )
                            })}
                            {analytics.sections.length > 6 && (
                              <span className="dim">
                                +{analytics.sections.length - 6} more
                              </span>
                            )}
                          </div>
                        </>
                      )}

                      {filter && (
                        <div className="filter-banner">
                          Filtered by{' '}
                          <span
                            className="section-dot"
                            style={{ background: colorFor(filter) }}
                          />
                          <strong>/{filter === 'home' ? '' : filter}</strong>
                          <button
                            className="filter-clear"
                            onClick={() => setFilter(sideKey, null)}
                            aria-label="Clear filter"
                          >
                            ×
                          </button>
                        </div>
                      )}

                      <ul className="neighbors">
                        {visible.slice(0, 100).map((d) => {
                          const target =
                            sideKey === 'out' ? d.node : d.node
                          const sec = d.section
                          return (
                            <li key={sideKey + d.node.data.full}>
                              <button
                                className="neighbor-row"
                                onClick={() => setSelected(target)}
                              >
                                <span
                                  className="section-dot"
                                  style={{ background: colorFor(sec) }}
                                />
                                <span className="neighbor-title">
                                  {(d.node.data.page && d.node.data.page.title) ||
                                    d.node.data.full}
                                </span>
                                {!uniqueOnly && d.count > 1 && (
                                  <span
                                    className="neighbor-count"
                                    title={`Appears ${d.count} times across the linking pages`}
                                  >
                                    ×{d.count}
                                  </span>
                                )}
                              </button>
                            </li>
                          )
                        })}
                        {visible.length === 0 && (
                          <li className="empty">
                            {filter
                              ? `No ${sideLabel.toLowerCase()} links in /${filter}.`
                              : `No ${sideLabel.toLowerCase()} cross‑links.`}
                          </li>
                        )}
                      </ul>
                    </div>
                  )
                }

                return (
                  <>
                    {renderSide('out', 'Outbound', 'gold', crossLinkAnalytics.out, outFilter)}
                    {renderSide('in', 'Inbound', 'cyan', crossLinkAnalytics.inn, inFilter)}
                  </>
                )
              })()}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

// Keeps a piece of UI state in sync with localStorage so it survives refresh.
function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key)
      if (stored === null) return defaultValue
      return JSON.parse(stored)
    } catch {
      return defaultValue
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage may be disabled or full; ignore */
    }
  }, [key, value])
  return [value, setValue]
}

function PopoverToggle({ checked, onChange, title, description, countLabel }) {
  return (
    <label className={'popover-row' + (checked ? ' on' : '')}>
      <div className="popover-row-text">
        <div className="popover-row-title">
          {title}
          {countLabel != null && (
            <span className="popover-row-count">{countLabel}</span>
          )}
        </div>
        <div className="popover-row-desc">{description}</div>
      </div>
      <span className="switch-only">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
      </span>
    </label>
  )
}

function dedupePairs(list, byFrom = false) {
  const seen = new Set()
  const out = []
  for (const cl of list) {
    const key = byFrom ? cl.from.data.full : cl.to.data.full
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cl)
  }
  return out
}

// A page is "broken" when its title matches any of the site's soft-404 markers.
// Patterns are case-insensitive regexes loaded from the manifest.
function isBrokenPage(page, siteFilters) {
  if (!page) return false
  const patterns = siteFilters?.brokenTitlePatterns
  if (!patterns || patterns.length === 0) return false
  const title = (page.title || '').trim()
  if (!title) return false
  return patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(title)
    } catch {
      return false
    }
  })
}
// A page is "untitled" when the CMS fell back to a bare site-name title.
function isUntitledPage(page, siteFilters) {
  if (!page) return false
  const titles = siteFilters?.untitledTitles
  if (!titles || titles.length === 0) return false
  return titles.includes((page.title || '').trim())
}

function findByFull(root, full) {
  if (root.full === full) return root
  for (const c of root.children) {
    if (full === c.full || full.startsWith(c.full + '/')) {
      const found = findByFull(c, full)
      if (found) return found
    }
  }
  return null
}
