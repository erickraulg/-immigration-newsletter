require('dotenv').config();
const axios = require('axios');

const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const RATE_LIMIT_DELAY_MS = 1000;
const MAX_RETRIES = 3;

function getHeaders() {
  return {
    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notionRequest(method, url, data, retries = 0) {
  try {
    const response = await axios({ method, url, data, headers: getHeaders() });
    return response.data;
  } catch (err) {
    if (err.response?.status === 429 && retries < MAX_RETRIES) {
      const retryAfter = parseInt(err.response.headers['retry-after'], 10) || 1;
      console.warn(`  [RATE LIMIT] Hit Notion rate limit. Retrying in ${retryAfter}s... (attempt ${retries + 1}/${MAX_RETRIES})`);
      await delay(retryAfter * 1000);
      return notionRequest(method, url, data, retries + 1);
    }
    throw err;
  }
}

async function getExistingUrls(databaseId) {
  const existingUrls = new Set();
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const body = {
      filter: {
        property: 'URL',
        url: { is_not_empty: true },
      },
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const result = await notionRequest(
      'post',
      `${NOTION_API_URL}/databases/${databaseId}/query`,
      body
    );

    for (const page of result.results) {
      const url = page.properties.URL?.url;
      if (url) existingUrls.add(url);
    }

    hasMore = result.has_more;
    startCursor = result.next_cursor;
  }

  return existingUrls;
}

function buildPageProperties(article, databaseId) {
  return {
    parent: { database_id: databaseId },
    properties: {
      'Title': {
        title: [{ text: { content: article.title || 'Untitled' } }],
      },
      'URL': {
        url: article.url,
      },
      'Summary': {
        rich_text: [{ text: { content: (article.summary || '').slice(0, 2000) } }],
      },
      'Source': {
        select: { name: article.source || 'Unknown' },
      },
      'Published Date': {
        date: { start: article.publishedDate || new Date().toISOString().split('T')[0] },
      },
      'Tier': {
        select: { name: article.tier || 'tier_1' },
      },
      'Status': {
        select: { name: 'new' },
      },
    },
  };
}

async function writeArticlesToNotion(articles, notionDatabaseId) {
  const databaseId = notionDatabaseId || process.env.NOTION_DATABASE_ID;

  if (!process.env.NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY is not set in environment variables');
  }
  if (!databaseId) {
    throw new Error('Notion database ID is not provided and NOTION_DATABASE_ID is not set');
  }

  const result = { inserted: 0, skipped: 0, failed: 0, details: [] };

  // Step 1: Fetch all existing URLs for deduplication
  console.log('Fetching existing articles from Notion for deduplication...');
  let existingUrls;
  try {
    existingUrls = await getExistingUrls(databaseId);
    console.log(`Found ${existingUrls.size} existing articles in database.`);
  } catch (err) {
    console.error(`[ERROR] Failed to query existing articles: ${err.message}`);
    console.error('Proceeding without deduplication — duplicates may be created.');
    existingUrls = new Set();
  }

  // Step 2: Insert articles one by one
  console.log(`\nWriting ${articles.length} articles to Notion...`);

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const label = `[${i + 1}/${articles.length}]`;

    // Check for duplicate
    if (existingUrls.has(article.url)) {
      console.log(`${label} SKIP (duplicate): ${article.title}`);
      result.skipped++;
      result.details.push({
        title: article.title,
        url: article.url,
        status: 'skipped',
        message: 'Duplicate URL already in database',
      });
      continue;
    }

    try {
      const pageData = buildPageProperties(article, databaseId);
      await notionRequest('post', `${NOTION_API_URL}/pages`, pageData);

      console.log(`${label} INSERTED: ${article.title}`);
      result.inserted++;
      result.details.push({
        title: article.title,
        url: article.url,
        status: 'inserted',
        message: 'Successfully created in Notion',
      });

      // Track the URL so we don't insert it again within the same run
      existingUrls.add(article.url);
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message;
      console.error(`${label} FAILED: ${article.title} — ${errMsg}`);
      result.failed++;
      result.details.push({
        title: article.title,
        url: article.url,
        status: 'failed',
        message: errMsg,
      });
    }

    // Small delay between inserts to be kind to Notion's API
    if (i < articles.length - 1) {
      await delay(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(`\nNotion write complete: ${result.inserted} inserted, ${result.skipped} skipped, ${result.failed} failed.`);
  return result;
}

module.exports = writeArticlesToNotion;
