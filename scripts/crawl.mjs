// Same-origin BFS crawler for https://www.theta.co.nz/
// Output: public/graph.json with { nodes, links } for force-directed graph viz.

import * as cheerio from 'cheerio'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = 'https://www.theta.co.nz/'
const ORIGIN = new URL(ROOT).origin
const MAX_PAGES = 500
const REQUEST_DELAY_MS = 300
const TIMEOUT_MS = 20000
const USER_AGENT =
  'theta-website-sitemaps-crawler/0.1 (internal sitemap visualization; contact: marlon.parra@theta.co.nz)'

const SKIP_EXTENSIONS = new Set([
  'pdf','jpg','jpeg','png','gif','webp','svg','ico','zip','rar','7z',
  'doc','docx','xls','xlsx','ppt','pptx','mp3','mp4','mov','avi','wav','css','js','json','xml','txt','woff','woff2','ttf','otf',
])

function normalize(rawUrl, base) {
  let u
  try {
    u = new URL(rawUrl, base)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  u.hash = ''
  u.search = ''
  // Lowercase host, strip trailing slash except for root path
  u.hostname = u.hostname.toLowerCase()
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '')
  }
  return u.toString()
}

function isSameOrigin(url) {
  try {
    return new URL(url).origin === ORIGIN
  } catch {
    return false
  }
}

function hasSkippedExtension(url) {
  try {
    const path = new URL(url).pathname
    const dot = path.lastIndexOf('.')
    if (dot === -1) return false
    const ext = path.slice(dot + 1).toLowerCase()
    return SKIP_EXTENSIONS.has(ext)
  } catch {
    return false
  }
}

async function fetchPage(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
    })
    const finalUrl = normalize(res.url, ROOT) || url
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !contentType.includes('html')) {
      return { ok: false, status: res.status, finalUrl, html: null }
    }
    const html = await res.text()
    return { ok: true, status: res.status, finalUrl, html }
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, html: null, error: String(err) }
  } finally {
    clearTimeout(timer)
  }
}

async function seedFromSitemap() {
  const seeds = new Set([ROOT])
  try {
    const res = await fetch(new URL('/sitemap.xml', ROOT), {
      headers: { 'user-agent': USER_AGENT },
    })
    if (!res.ok) return [...seeds]
    const xml = await res.text()
    // Handle both sitemap and sitemap-index
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
    for (const loc of locs) {
      if (loc.endsWith('.xml')) {
        // Sub-sitemap
        try {
          const subRes = await fetch(loc, { headers: { 'user-agent': USER_AGENT } })
          if (subRes.ok) {
            const subXml = await subRes.text()
            for (const m of subXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
              const n = normalize(m[1].trim(), ROOT)
              if (n && isSameOrigin(n) && !hasSkippedExtension(n)) seeds.add(n)
            }
          }
        } catch {}
      } else {
        const n = normalize(loc, ROOT)
        if (n && isSameOrigin(n) && !hasSkippedExtension(n)) seeds.add(n)
      }
    }
  } catch {
    // No sitemap — fall back to BFS from root
  }
  return [...seeds]
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function crawl() {
  console.log('Seeding from /sitemap.xml…')
  const seeds = await seedFromSitemap()
  console.log(`Seeded with ${seeds.length} URL(s).`)

  const queue = seeds.map((u) => ({ url: u, depth: 0 }))
  const visited = new Map() // url -> { title, depth, status }
  const edges = [] // { source, target }
  const edgeSet = new Set() // dedupe key "s -> t"

  while (queue.length && visited.size < MAX_PAGES) {
    const { url, depth } = queue.shift()
    if (visited.has(url)) continue
    visited.set(url, { title: '', depth, status: 0 })

    console.log(`[${visited.size}/${MAX_PAGES}] depth=${depth} ${url}`)
    const { ok, status, finalUrl, html } = await fetchPage(url)
    const record = visited.get(url)
    record.status = status

    if (finalUrl !== url && !visited.has(finalUrl)) {
      // Treat redirect target as canonical for this URL
      visited.set(finalUrl, { ...record })
    }
    const canonical = finalUrl && visited.has(finalUrl) ? finalUrl : url

    if (ok && html) {
      const $ = cheerio.load(html)
      const title = ($('title').first().text() || '').trim().slice(0, 200)
      visited.get(canonical).title = title

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href')
        const target = normalize(href, canonical)
        if (!target) return
        if (!isSameOrigin(target)) return
        if (hasSkippedExtension(target)) return

        const key = `${canonical} -> ${target}`
        if (!edgeSet.has(key)) {
          edgeSet.add(key)
          edges.push({ source: canonical, target })
        }
        if (!visited.has(target) && visited.size + queue.length < MAX_PAGES) {
          queue.push({ url: target, depth: depth + 1 })
        }
      })
    }

    await sleep(REQUEST_DELAY_MS)
  }

  // Build nodes: include every URL that appears either visited or as edge endpoint
  const nodeMap = new Map()
  for (const [url, rec] of visited) {
    nodeMap.set(url, {
      id: url,
      url,
      title: rec.title || url.replace(ORIGIN, '') || '/',
      depth: rec.depth,
      status: rec.status,
      inDegree: 0,
      outDegree: 0,
    })
  }
  for (const e of edges) {
    if (!nodeMap.has(e.source))
      nodeMap.set(e.source, { id: e.source, url: e.source, title: e.source.replace(ORIGIN, '') || '/', depth: -1, status: 0, inDegree: 0, outDegree: 0 })
    if (!nodeMap.has(e.target))
      nodeMap.set(e.target, { id: e.target, url: e.target, title: e.target.replace(ORIGIN, '') || '/', depth: -1, status: 0, inDegree: 0, outDegree: 0 })
    nodeMap.get(e.source).outDegree++
    nodeMap.get(e.target).inDegree++
  }

  const graph = {
    meta: {
      root: ROOT,
      crawledAt: new Date().toISOString(),
      pages: visited.size,
      nodes: nodeMap.size,
      edges: edges.length,
    },
    nodes: [...nodeMap.values()],
    links: edges,
  }

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const outPath = resolve(__dirname, '..', 'public', 'graph.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(graph, null, 2))
  console.log(
    `\nDone. ${graph.meta.pages} pages crawled, ${graph.meta.nodes} nodes, ${graph.meta.edges} edges.`,
  )
  console.log(`Wrote ${outPath}`)
}

crawl().catch((err) => {
  console.error('Crawler failed:', err)
  process.exit(1)
})
