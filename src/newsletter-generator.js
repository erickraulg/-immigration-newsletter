require('dotenv').config();
const axios = require('axios');

const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_BLOCKS_PER_REQUEST = 100;

const TIER_CONFIG = {
  tier_1: { label: '🔴 Critical Updates', order: 1 },
  tier_2: { label: '🟢 Important Updates', order: 2 },
  tier_3: { label: '🔵 Industry Updates', order: 3 },
};

function getHeaders() {
  return {
    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getFormattedDate() {
  const today = new Date();
  const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `${dayName}, ${dateStr}`;
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen - 3) + '...';
}

async function queryTodaysArticles() {
  const databaseId = process.env.NOTION_DATABASE_ID;
  const today = getTodayStr();
  const allResults = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const body = {
      filter: {
        property: 'Published Date',
        date: { equals: today },
      },
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const response = await axios.post(
      `${NOTION_API_URL}/databases/${databaseId}/query`,
      body,
      { headers: getHeaders() }
    );

    allResults.push(...response.data.results);
    hasMore = response.data.has_more;
    startCursor = response.data.next_cursor;
  }

  return allResults.map((page) => {
    const props = page.properties;
    return {
      title: props.Title?.title?.[0]?.text?.content || 'Untitled',
      summary: props.Summary?.rich_text?.[0]?.text?.content || '',
      source: props.Source?.select?.name || 'Unknown',
      tier: props.Tier?.select?.name || 'tier_3',
      url: props.URL?.url || '',
    };
  });
}

function groupByTierAndSource(articles) {
  const grouped = {};

  for (const article of articles) {
    const tier = article.tier;
    if (!grouped[tier]) grouped[tier] = {};
    if (!grouped[tier][article.source]) grouped[tier][article.source] = [];
    grouped[tier][article.source].push(article);
  }

  return grouped;
}

function buildNewsletterBlocks(grouped, articles, formattedDate) {
  const blocks = [];
  const sourceCount = new Set(articles.map((a) => a.source)).size;

  // Header
  blocks.push({
    object: 'block',
    type: 'heading_1',
    heading_1: {
      rich_text: [{ type: 'text', text: { content: `📰 Immigration News — ${formattedDate}` } }],
    },
  });

  // Summary line
  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: 'Summary: ' }, annotations: { bold: true } },
        { type: 'text', text: { content: `${articles.length} articles from ${sourceCount} sources today` } },
      ],
    },
  });

  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // Tiers in order
  const tierOrder = ['tier_1', 'tier_2', 'tier_3'];

  for (const tier of tierOrder) {
    if (!grouped[tier] || Object.keys(grouped[tier]).length === 0) continue;

    // Tier heading
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: TIER_CONFIG[tier].label } }],
      },
    });

    // Sources within tier
    const tierSources = Object.entries(grouped[tier]);
    for (let i = 0; i < tierSources.length; i++) {
      const [source, sourceArticles] = tierSources[i];
      const isLastSource = i === tierSources.length - 1;

      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: {
          rich_text: [{ type: 'text', text: { content: `${source} (${sourceArticles.length} articles)` } }],
        },
      });

      for (const article of sourceArticles) {
        const summaryText = truncate(article.summary, 150);
        const richText = [
          { type: 'text', text: { content: article.title }, annotations: { bold: true } },
        ];

        if (summaryText) {
          richText.push({ type: 'text', text: { content: ` — ${summaryText} ` } });
        } else {
          richText.push({ type: 'text', text: { content: ' ' } });
        }

        if (article.url) {
          richText.push({
            type: 'text',
            text: { content: 'Read more →', link: { url: article.url } },
          });
        }

        blocks.push({
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: richText },
        });
      }

      // Add divider between sources (not after the last source)
      if (!isLastSource) {
        blocks.push({ object: 'block', type: 'divider', divider: {} });
      }
    }

    blocks.push({ object: 'block', type: 'divider', divider: {} });
  }

  // Footer
  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: 'Created: ' }, annotations: { bold: true } },
        { type: 'text', text: { content: new Date().toUTCString() } },
      ],
    },
  });

  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: 'Cron Schedule: ' }, annotations: { bold: true } },
        { type: 'text', text: { content: 'Every Sunday & Wednesday at 8:00 AM EST' } },
      ],
    },
  });

  return blocks;
}

async function createNewsletterPage(blocks, formattedDate) {
  const archiveFolderId = process.env.NOTION_NEWSLETTER_ARCHIVE_FOLDER_ID;

  // Create page with first batch of blocks
  const firstBatch = blocks.slice(0, MAX_BLOCKS_PER_REQUEST);

  const response = await axios.post(
    `${NOTION_API_URL}/pages`,
    {
      parent: { page_id: archiveFolderId },
      icon: { type: 'emoji', emoji: '📰' },
      properties: {
        title: {
          title: [{ text: { content: `📰 ${formattedDate} — Immigration News` } }],
        },
      },
      children: firstBatch,
    },
    { headers: getHeaders() }
  );

  const pageId = response.data.id;
  const pageUrl = response.data.url;

  // Append remaining blocks in batches if over 100
  for (let i = MAX_BLOCKS_PER_REQUEST; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
    const batch = blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST);
    await axios.patch(
      `${NOTION_API_URL}/blocks/${pageId}/children`,
      { children: batch },
      { headers: getHeaders() }
    );
  }

  return pageUrl;
}

async function generateNewsletter() {
  console.log('Newsletter generator started...');

  if (!process.env.NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY is not set');
  }
  if (!process.env.NOTION_DATABASE_ID) {
    throw new Error('NOTION_DATABASE_ID is not set');
  }
  if (!process.env.NOTION_NEWSLETTER_ARCHIVE_FOLDER_ID) {
    throw new Error('NOTION_NEWSLETTER_ARCHIVE_FOLDER_ID is not set');
  }

  // Query today's articles from the database
  const today = getTodayStr();
  console.log(`Querying articles for ${today}...`);

  const articles = await queryTodaysArticles();
  console.log(`${articles.length} articles found for today.`);

  if (articles.length === 0) {
    console.log('No articles for today, skipping newsletter.');
    return { success: false, reason: 'No articles' };
  }

  // Group by tier, then by source
  const grouped = groupByTierAndSource(articles);
  const formattedDate = getFormattedDate();

  // Build Notion blocks
  const blocks = buildNewsletterBlocks(grouped, articles, formattedDate);
  console.log(`Built ${blocks.length} Notion blocks.`);

  // Create the newsletter page
  console.log('Creating newsletter page in Notion...');
  const pageUrl = await createNewsletterPage(blocks, formattedDate);
  console.log(`Newsletter page created at ${pageUrl}`);

  return { success: true, pageUrl, articlesCount: articles.length };
}

module.exports = generateNewsletter;
