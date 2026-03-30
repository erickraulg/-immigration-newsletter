require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const RSS_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml'];
const REQUEST_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ARTICLES_PER_SOURCE = 10;
const MAX_AGE_DAYS = 14;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
  return d.toISOString().split('T')[0];
}

async function tryFetchRSS(source) {
  const baseUrl = source.url.replace(/\/$/, '');

  for (const path of RSS_PATHS) {
    const feedUrl = baseUrl + path;
    try {
      const { data } = await axios.get(feedUrl, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'User-Agent': 'ImmigrationNewsletterBot/1.0' },
      });

      if (typeof data !== 'string' || !data.includes('<')) continue;

      const $ = cheerio.load(data, { xmlMode: true });
      const articles = [];

      $('item').each((_, el) => {
        articles.push({
          title: $(el).find('title').first().text().trim(),
          url: $(el).find('link').first().text().trim() || $(el).find('link').attr('href') || '',
          source: source.name,
          publishedDate: formatDate($(el).find('pubDate').text() || $(el).find('dc\\:date').text()),
          tier: source.tier || 'tier_1',
        });
      });

      if (articles.length === 0) {
        $('entry').each((_, el) => {
          articles.push({
            title: $(el).find('title').first().text().trim(),
            url: $(el).find('link').attr('href') || '',
            source: source.name,
            publishedDate: formatDate($(el).find('published').text() || $(el).find('updated').text()),
            tier: source.tier || 'tier_1',
          });
        });
      }

      if (articles.length > 0) {
        console.log(`  [RSS] Found ${articles.length} articles from ${source.name} (${feedUrl})`);
        return articles;
      }
    } catch {
      // Try next RSS path
    }
  }

  return null;
}

function scrapeAILA($, source) {
  const articles = [];
  const seen = new Set();
  let skippedMemberOnly = 0;

  $('.collection-result').each((_, el) => {
    const $result = $(el);

    // Skip member-only articles (they 404 for unauthenticated requests)
    const accessLevel = $result.find('.access-level-text').text().trim().toLowerCase();
    if (accessLevel && !accessLevel.includes('public')) {
      skippedMemberOnly++;
      return;
    }

    const $link = $result.find('h2 a[href]').first();
    const title = $link.text().trim();
    let url = $link.attr('href') || '';

    if (!title || !url) return;
    if (url.startsWith('/')) url = 'https://www.aila.org' + url;
    if (seen.has(url)) return;

    // Parse date from AILA's format (e.g., "3/27/26")
    const dateText = $result.find('.documentDate').text().trim();
    let publishedDate = new Date().toISOString().split('T')[0];
    if (dateText) {
      const parts = dateText.split('/');
      if (parts.length === 3) {
        const year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
        const month = parts[0].padStart(2, '0');
        const day = parts[1].padStart(2, '0');
        publishedDate = `${year}-${month}-${day}`;
      }
    }

    seen.add(url);
    articles.push({ title, url, source: source.name, publishedDate, tier: source.tier || 'tier_1' });
  });

  if (skippedMemberOnly > 0) {
    console.log(`  [AILA] Skipped ${skippedMemberOnly} member-only articles`);
  }

  return articles;
}

async function scrapeHTML(source) {
  const { data } = await axios.get(source.url, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': 'ImmigrationNewsletterBot/1.0' },
  });

  const $ = cheerio.load(data);

  // AILA-specific scraper: uses their collection-result structure and filters member-only articles
  if ($('.collection-result').length > 0) {
    const ailaArticles = scrapeAILA($, source);
    console.log(`  [HTML] Scraped ${ailaArticles.length} articles from ${source.name} (AILA format)`);
    return ailaArticles;
  }

  const articles = [];
  const seen = new Set();

  const selectors = [
    'article a[href]',
    '.post-title a[href]',
    'h2 a[href]',
    'h3 a[href]',
    '.entry-title a[href]',
    '.article-title a[href]',
    '.news-title a[href]',
    '.views-row a[href]',
    '.item-list a[href]',
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const title = $el.text().trim();
      let url = $el.attr('href') || '';

      if (!title || title.length < 10) return;
      if (url.startsWith('/')) {
        const base = new URL(source.url);
        url = base.origin + url;
      }
      if (!url.startsWith('http')) return;
      if (seen.has(url)) return;

      seen.add(url);
      articles.push({
        title,
        url,
        source: source.name,
        publishedDate: new Date().toISOString().split('T')[0],
        tier: source.tier || 'tier_1',
      });
    });

    if (articles.length > 0) break;
  }

  if (articles.length === 0) {
    $('a[href]').each((_, el) => {
      const $el = $(el);
      const title = $el.text().trim();
      let url = $el.attr('href') || '';

      if (!title || title.length < 30) return;
      if (url.startsWith('/')) {
        const base = new URL(source.url);
        url = base.origin + url;
      }
      if (!url.startsWith('http')) return;
      if (seen.has(url)) return;

      seen.add(url);
      articles.push({
        title,
        url,
        source: source.name,
        publishedDate: new Date().toISOString().split('T')[0],
        tier: source.tier || 'tier_1',
      });
    });
  }

  console.log(`  [HTML] Scraped ${articles.length} articles from ${source.name}`);
  return articles;
}

async function scrapWithPlaywright(source) {
  let browser;
  try {
    console.log(`  [PLAYWRIGHT] Launching browser for ${source.name}`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    await page.goto(source.url, { waitUntil: 'networkidle', timeout: REQUEST_TIMEOUT_MS });
    const html = await page.content();
    
    const $ = cheerio.load(html);
    const articles = [];
    const seen = new Set();

    const selectors = [
      'article a[href]',
      '.post-title a[href]',
      'h2 a[href]',
      'h3 a[href]',
      '.entry-title a[href]',
      '.article-title a[href]',
      '.news-title a[href]',
      '.views-row a[href]',
      '.item-list a[href]',
    ];

    for (const selector of selectors) {
      $(selector).each((_, el) => {
        const $el = $(el);
        const title = $el.text().trim();
        let url = $el.attr('href') || '';

        if (!title || title.length < 10) return;
        if (url.startsWith('/')) {
          const base = new URL(source.url);
          url = base.origin + url;
        }
        if (!url.startsWith('http')) return;
        if (seen.has(url)) return;

        seen.add(url);
        articles.push({
          title,
          url,
          source: source.name,
          publishedDate: new Date().toISOString().split('T')[0],
          tier: source.tier || 'tier_1',
        });
      });

      if (articles.length > 0) break;
    }

    if (articles.length === 0) {
      $('a[href]').each((_, el) => {
        const $el = $(el);
        const title = $el.text().trim();
        let url = $el.attr('href') || '';

        if (!title || title.length < 30) return;
        if (url.startsWith('/')) {
          const base = new URL(source.url);
          url = base.origin + url;
        }
        if (!url.startsWith('http')) return;
        if (seen.has(url)) return;

        seen.add(url);
        articles.push({
          title,
          url,
          source: source.name,
          publishedDate: new Date().toISOString().split('T')[0],
          tier: source.tier || 'tier_1',
        });
      });
    }

    console.log(`  [PLAYWRIGHT] Rendered and found ${articles.length} articles from ${source.name}`);
    return articles;
  } catch (err) {
    console.error(`  [PLAYWRIGHT ERROR] Failed to render ${source.name}: ${err.message}`);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function fetchFromSource(source) {
  const rssArticles = await tryFetchRSS(source);
  if (rssArticles && rssArticles.length > 0) return rssArticles;

  const htmlArticles = await scrapeHTML(source);
  if (htmlArticles && htmlArticles.length > 0) return htmlArticles;

  console.log(`  [INFO] No articles found with RSS or HTML scraping for ${source.name}, trying Playwright...`);
  return await scrapWithPlaywright(source);
}

function filterAndCapArticles(articles) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Group by source
  const bySource = {};
  for (const article of articles) {
    if (!bySource[article.source]) bySource[article.source] = [];
    bySource[article.source].push(article);
  }

  const filtered = [];
  const seenUrls = new Set();
  let duplicates = 0;

  for (const [source, sourceArticles] of Object.entries(bySource)) {
    // Keep only articles within the last MAX_AGE_DAYS
    const recent = sourceArticles.filter((a) => a.publishedDate >= cutoffStr);

    // Cap at MAX_ARTICLES_PER_SOURCE (keep most recent first)
    const capped = recent
      .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate))
      .slice(0, MAX_ARTICLES_PER_SOURCE);

    const dropped = sourceArticles.length - capped.length;
    if (dropped > 0) {
      console.log(`  [FILTER] ${source}: ${sourceArticles.length} → ${capped.length} (${recent.length - capped.length} capped, ${sourceArticles.length - recent.length} older than ${MAX_AGE_DAYS}d)`);
    }

    // Deduplicate across sources by URL
    for (const article of capped) {
      if (seenUrls.has(article.url)) {
        duplicates++;
      } else {
        seenUrls.add(article.url);
        filtered.push(article);
      }
    }
  }

  if (duplicates > 0) {
    console.log(`  [DEDUP] Removed ${duplicates} duplicate articles (same URL from multiple sources)`);
  }

  return filtered;
}

async function fetchArticles(sources) {
  const allArticles = [];

  console.log(`Fetching articles from ${sources.length} sources...`);

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    console.log(`[${i + 1}/${sources.length}] ${source.name} (${source.url})`);

    try {
      const articles = await fetchFromSource(source);
      allArticles.push(...articles);
    } catch (err) {
      console.error(`  [ERROR] Failed to fetch from ${source.name}: ${err.message}`);
    }

    if (i < sources.length - 1) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  console.log(`\nTotal articles fetched (raw): ${allArticles.length}`);

  // Filter to last 2 weeks, cap at 10 per source
  const filtered = filterAndCapArticles(allArticles);
  console.log(`After filtering (last ${MAX_AGE_DAYS} days, max ${MAX_ARTICLES_PER_SOURCE}/source): ${filtered.length}`);

  return filtered;
}

module.exports = fetchArticles;