// Crawl configurations — single source of truth for which sites the
// crawler can target. Add a new key here to register a new site.
//
// Fields:
//   name                  display name used in the app's site picker
//   root                  starting URL (trailing slash recommended)
//   scopePrefix           optional path prefix the crawler must stay within
//                         (e.g. '/nz/en' to crawl only the NZ/EN regional site)
//   maxPages              hard cap on crawled pages (politeness/safety)
//   requestDelayMs        delay between requests (politeness)
//   brokenTitlePatterns   regex patterns that mark a soft-404 page
//   untitledTitles        exact title strings that mean "no real title"

export const sites = {
  theta: {
    name: 'Theta',
    root: 'https://www.theta.co.nz/',
    maxPages: 500,
    requestDelayMs: 300,
    brokenTitlePatterns: ['^not found$'],
    untitledTitles: ['Theta'],
  },
  datacom: {
    name: 'Datacom NZ',
    root: 'https://datacom.com/nz/en/',
    scopePrefix: '/nz/en',
    sitemapUrl: 'https://datacom.com/bin/nz/en/sitemap.xml',
    // Datacom sits behind Cloudflare bot protection; plain fetch + cheerio
    // gets 403'd by the JS challenge. Run a real browser instead.
    usePlaywright: true,
    maxPages: 800,
    requestDelayMs: 400,
    // Tune these after the first crawl by inspecting top page titles.
    brokenTitlePatterns: ['^page not found', 'not found'],
    untitledTitles: ['Datacom'],
  },
}

export function getSite(id) {
  const site = sites[id]
  if (!site) {
    const ids = Object.keys(sites).join(', ')
    throw new Error(`Unknown site "${id}". Available: ${ids}`)
  }
  return site
}
