// Same-origin BFS crawler. Site target comes from scripts/sites.js.
// Usage:  node scripts/crawl.mjs <siteId>
// Output: public/graphs/<siteId>.json, plus updates public/sites.json manifest.

import * as cheerio from 'cheerio'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSite, sites } from './sites.js'

// Playwright is loaded lazily so the dependency only matters when a site opts in.
let chromium = null
async function loadPlaywright() {
  if (!chromium) {
    const pw = await import('playwright')
    chromium = pw.chromium
  }
  return chromium
}

const SITE_ID = process.argv[2]
if (!SITE_ID) {
  console.error(
    `Usage: node scripts/crawl.mjs <siteId>\nAvailable: ${Object.keys(sites).join(', ')}`,
  )
  process.exit(1)
}

const SITE = getSite(SITE_ID)
const ROOT = SITE.root
const ORIGIN = new URL(ROOT).origin
const SCOPE_PREFIX = SITE.scopePrefix || null
const MAX_PAGES = SITE.maxPages || 500
const REQUEST_DELAY_MS = SITE.requestDelayMs || 300
const TIMEOUT_MS = 20000
const USER_AGENT =
  'theta-website-sitemaps-crawler/0.2 (internal sitemap visualization; contact: marlon.parra@theta.co.nz)'

const SKIP_EXTENSIONS = new Set([
  'pdf','jpg','jpeg','png','gif','webp','svg','ico','zip','rar','7z',
  'doc','docx','xls','xlsx','ppt','pptx','mp3','mp4','mov','avi','wav',
  'css','js','json','xml','txt','woff','woff2','ttf','otf',
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
  u.hostname = u.hostname.toLowerCase()
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '')
  }
  return u.toString()
}

function isInScope(url) {
  try {
    const u = new URL(url)
    if (u.origin !== ORIGIN) return false
    if (!SCOPE_PREFIX) return true
    // Match exact prefix or with trailing slash boundary
    return u.pathname === SCOPE_PREFIX || u.pathname.startsWith(SCOPE_PREFIX + '/')
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

// Playwright-backed page fetch for sites behind bot-challenge protection.
let _browser = null
let _ctx = null
async function getPlaywrightPage() {
  if (!_browser) {
    const c = await loadPlaywright()
    _browser = await c.launch({ headless: true })
    _ctx = await _browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-NZ',
    })
  }
  return _ctx.newPage()
}
async function closePlaywright() {
  if (_browser) {
    try { await _browser.close() } catch {}
    _browser = null
    _ctx = null
  }
}

async function fetchPagePlaywright(url) {
  let page = null
  try {
    page = await getPlaywrightPage()
    let response
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_MS,
      })
    } catch (err) {
      return { ok: false, status: 0, finalUrl: url, html: null, error: String(err) }
    }
    if (!response) {
      return { ok: false, status: 0, finalUrl: url, html: null }
    }
    const status = response.status()
    const finalUrl = normalize(response.url(), ROOT) || url

    // If we hit a Cloudflare interstitial, wait a bit for the challenge to resolve.
    let title = await page.title()
    if (/cloudflare|attention required|just a moment/i.test(title)) {
      try {
        await page.waitForFunction(
          () => !/cloudflare|attention required|just a moment/i.test(document.title),
          null,
          { timeout: 15000 },
        )
        title = await page.title()
      } catch {
        // Still on the challenge page — give up on this URL.
        return { ok: false, status, finalUrl, html: null, error: 'cloudflare-challenge' }
      }
    }

    if (status >= 400) {
      // 4xx/5xx pages may still have useful HTML (e.g. soft-404 templates), keep them.
    }
    const html = await page.content()
    return { ok: status < 500, status, finalUrl, html }
  } finally {
    if (page) {
      try { await page.close() } catch {}
    }
  }
}

const pageFetcher = SITE.usePlaywright ? fetchPagePlaywright : fetchPage

// Fetch raw text. Uses Playwright when the site is behind bot protection so
// we can still read sitemap.xml.
async function fetchText(url) {
  if (SITE.usePlaywright) {
    const c = await loadPlaywright()
    if (!_browser) {
      _browser = await c.launch({ headless: true })
      _ctx = await _browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'en-NZ',
      })
    }
    const page = await _ctx.newPage()
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
      if (!res || res.status() >= 400) return null
      // XML pages render as wrapped <html><body><pre>…</pre></body></html> via Chromium.
      // The actual XML lives in <pre> when content-type is application/xml.
      const body = await page.evaluate(() => {
        const pre = document.querySelector('pre')
        return pre ? pre.innerText : document.documentElement.outerHTML
      })
      return body
    } catch {
      return null
    } finally {
      try { await page.close() } catch {}
    }
  }
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function seedFromSitemap() {
  const seeds = new Set([ROOT])
  const sitemapUrl = SITE.sitemapUrl || new URL('/sitemap.xml', ROOT).toString()
  const xml = await fetchText(sitemapUrl)
  if (!xml) return [...seeds]
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
  for (const loc of locs) {
    if (loc.endsWith('.xml')) {
      const subXml = await fetchText(loc)
      if (subXml) {
        for (const m of subXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
          const n = normalize(m[1].trim(), ROOT)
          if (n && isInScope(n) && !hasSkippedExtension(n)) seeds.add(n)
        }
      }
    } else {
      const n = normalize(loc, ROOT)
      if (n && isInScope(n) && !hasSkippedExtension(n)) seeds.add(n)
    }
  }
  return [...seeds]
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function crawl() {
  console.log(`Crawling "${SITE.name}" (${SITE_ID}) from ${ROOT}`)
  if (SCOPE_PREFIX) console.log(`Scope prefix: ${SCOPE_PREFIX}`)
  console.log('Seeding from /sitemap.xml…')
  const seeds = await seedFromSitemap()
  console.log(`Seeded with ${seeds.length} URL(s).`)

  const queue = seeds.map((u) => ({ url: u, depth: 0 }))
  const visited = new Map()
  const edges = []
  const edgeSet = new Set()

  while (queue.length && visited.size < MAX_PAGES) {
    const { url, depth } = queue.shift()
    if (visited.has(url)) continue
    visited.set(url, { title: '', depth, status: 0 })

    console.log(`[${visited.size}/${MAX_PAGES}] depth=${depth} ${url}`)
    const { ok, status, finalUrl, html } = await pageFetcher(url)
    const record = visited.get(url)
    record.status = status

    // If the request landed somewhere outside our scope (e.g. region-detection
    // redirect from /nz/en/foo to /au/en/foo), drop the page entirely.
    if (finalUrl && finalUrl !== url && !isInScope(finalUrl)) {
      visited.delete(url)
      console.log(`  → redirected out of scope (${finalUrl}); skipping`)
      await sleep(REQUEST_DELAY_MS)
      continue
    }

    if (finalUrl !== url && !visited.has(finalUrl)) {
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
        if (!isInScope(target)) return
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

  // Build nodes (URLs that are visited OR appear as link endpoints).
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
      siteId: SITE_ID,
      siteName: SITE.name,
      root: ROOT,
      scopePrefix: SCOPE_PREFIX,
      crawledAt: new Date().toISOString(),
      pages: visited.size,
      nodes: nodeMap.size,
      edges: edges.length,
    },
    nodes: [...nodeMap.values()],
    links: edges,
  }

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const graphsDir = resolve(__dirname, '..', 'public', 'graphs')
  mkdirSync(graphsDir, { recursive: true })
  const outPath = resolve(graphsDir, `${SITE_ID}.json`)
  writeFileSync(outPath, JSON.stringify(graph, null, 2))
  console.log(
    `\nDone. ${graph.meta.pages} pages crawled, ${graph.meta.nodes} nodes, ${graph.meta.edges} edges.`,
  )
  console.log(`Wrote ${outPath}`)

  // Update sites.json manifest with this site's latest crawl info.
  const manifestPath = resolve(__dirname, '..', 'public', 'sites.json')
  let manifest = { sites: {}, default: SITE_ID }
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {}
    if (!manifest.sites) manifest.sites = {}
  }
  manifest.sites[SITE_ID] = {
    name: SITE.name,
    url: ROOT.replace(/\/$/, ''),
    scopePrefix: SCOPE_PREFIX,
    data: `graphs/${SITE_ID}.json`,
    crawledAt: graph.meta.crawledAt,
    pages: graph.meta.pages,
    edges: graph.meta.edges,
    filters: {
      brokenTitlePatterns: SITE.brokenTitlePatterns || [],
      untitledTitles: SITE.untitledTitles || [],
    },
  }
  if (!manifest.default || !manifest.sites[manifest.default]) {
    manifest.default = SITE_ID
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`Updated ${manifestPath}`)
}

crawl()
  .then(closePlaywright)
  .catch(async (err) => {
    console.error('Crawler failed:', err)
    await closePlaywright()
    process.exit(1)
  })
