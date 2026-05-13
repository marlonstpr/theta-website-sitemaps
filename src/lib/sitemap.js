export const ROOT = 'https://www.theta.co.nz'

export function urlPath(url) {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

export function sectionOf(url) {
  const path = urlPath(url)
  if (path === '/' || path === '') return 'home'
  const seg = path.split('/').filter(Boolean)[0] || 'home'
  return seg
}

export const SECTION_COLORS = {
  home: '#e5e7eb',
  about: '#60a5fa',
  customer: '#34d399',
  customers: '#10b981',
  solutions: '#a78bfa',
  technologies: '#f472b6',
  packages: '#fbbf24',
  'news-blogs': '#fb923c',
  careers: '#22d3ee',
  'our-people': '#f87171',
  contact: '#facc15',
  'contact-us': '#facc15',
}
export function colorFor(section) {
  return SECTION_COLORS[section] || '#9ca3af'
}

// Build a tree from a flat list of pages, keyed by their URL path.
// Synthetic intermediate nodes are created when a path segment has no own page
// (e.g. /customer when /customer/foo exists but /customer itself wasn't crawled).
export function buildTree(pages) {
  const root = { name: '/', full: '/', page: null, children: new Map() }
  for (const p of pages) {
    const path = urlPath(p.id)
    if (path === '/' || path === '') {
      root.page = p
      continue
    }
    const segs = path.split('/').filter(Boolean)
    let cursor = root
    let acc = ''
    for (const seg of segs) {
      acc += '/' + seg
      if (!cursor.children.has(seg)) {
        cursor.children.set(seg, {
          name: seg,
          full: acc,
          page: null,
          children: new Map(),
        })
      }
      cursor = cursor.children.get(seg)
    }
    cursor.page = p
  }
  function visit(n) {
    n.children = [...n.children.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    n.children.forEach(visit)
  }
  visit(root)
  return root
}

// Index: page URL → tree node. Used for cross-link routing.
export function indexByPage(tree) {
  const m = new Map()
  function visit(n) {
    if (n.page) m.set(n.page.id, n)
    n.children.forEach(visit)
  }
  visit(tree)
  return m
}
