require('dotenv').config();
const axios = require('axios');
let chromium;
try {
  chromium = require('playwright').chromium;
} catch {
  console.warn('[WARN] Playwright not installed — browser fallback disabled');
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 300;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1000;
const ARTICLE_FETCH_TIMEOUT_MS = 15000;
const TOKEN_BUDGET = 100_000;

const SUMMARIZE_PROMPT =
  'Summarize this immigration news article in 2-3 sentences for business professionals. ' +
  'Focus on business impact, policy changes, visa implications. Keep it concise and actionable.';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

async function fetchArticleText(url) {
  const { data } = await axios.get(url, {
    timeout: ARTICLE_FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': 'ImmigrationNewsletterBot/1.0' },
  });

  return stripHtml(data);
}

async function fetchArticleTextWithPlaywright(url, browser) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: ARTICLE_FETCH_TIMEOUT_MS });
    const html = await page.content();
    return stripHtml(html);
  } finally {
    await page.close();
  }
}

async function summarizeWithClaude(text) {
  const response = await axios.post(
    ANTHROPIC_API_URL,
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: `${SUMMARIZE_PROMPT}\n\nArticle:\n${text}`,
        },
      ],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  const { content, usage } = response.data;
  const summary = content[0]?.text?.trim() || '';
  return { summary, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

async function processBatch(batch, browser) {
  const results = await Promise.allSettled(
    batch.map(async (article) => {
      let text = article.title;

      // Step 1a: Try axios
      try {
        text = await fetchArticleText(article.url);
      } catch (axiosErr) {
        // Step 1b: Try Playwright fallback (only if browser is available)
        console.warn(`  [WARN] Axios failed for "${article.title}": ${axiosErr.message}`);
        if (browser) {
          try {
            text = await fetchArticleTextWithPlaywright(article.url, browser);
            console.log(`  [PLAYWRIGHT FALLBACK] Fetched article text for "${article.title}"`);
          } catch (pwErr) {
            console.warn(`  [WARN] Playwright also failed for "${article.title}": ${pwErr.message}`);
            console.warn(`  [WARN] Using title as fallback for Claude input`);
          }
        } else {
          console.warn(`  [WARN] Using title as fallback for Claude input (no browser available)`);
        }
      }

      // Step 2: Summarize with Claude
      const { summary, inputTokens, outputTokens } = await summarizeWithClaude(text);
      return { article, summary, inputTokens, outputTokens };
    })
  );

  let batchInputTokens = 0;
  let batchOutputTokens = 0;
  const summarized = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { article, summary, inputTokens, outputTokens } = result.value;
      summarized.push({ ...article, summary });
      batchInputTokens += inputTokens;
      batchOutputTokens += outputTokens;
    } else {
      const errData = result.reason?.response?.data;
      const errDetail = errData ? JSON.stringify(errData) : result.reason?.message;
      console.error(`  [ERROR] Failed to summarize article: ${errDetail}`);
    }
  }

  console.log(
    `  [TOKENS] Batch used ${batchInputTokens} input + ${batchOutputTokens} output = ${batchInputTokens + batchOutputTokens} tokens`
  );

  return { summarized, totalTokens: batchInputTokens + batchOutputTokens };
}

async function summarizeArticles(articles) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set in environment variables');
  }

  const allSummarized = [];
  let totalTokensUsed = 0;
  const batches = [];

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }

  console.log(`Summarizing ${articles.length} articles in ${batches.length} batches of ${BATCH_SIZE}...`);

  let browser;
  try {
    if (chromium) {
      browser = await chromium.launch({ headless: true });
      console.log('[PLAYWRIGHT] Browser launched for fallback fetching.');
    } else {
      console.log('[PLAYWRIGHT] Not available — will use title fallback for blocked articles.');
    }

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`\n[Batch ${i + 1}/${batches.length}] Processing ${batch.length} articles...`);

      const { summarized, totalTokens } = await processBatch(batch, browser);
      allSummarized.push(...summarized);
      totalTokensUsed += totalTokens;

      console.log(`  [TOKENS] Running total: ${totalTokensUsed} / ${TOKEN_BUDGET}`);

      if (totalTokensUsed >= TOKEN_BUDGET) {
        console.warn(`\n[WARN] Approaching token budget (${totalTokensUsed} >= ${TOKEN_BUDGET}). Stopping early.`);
        break;
      }

      // Delay between batches (skip after the last one)
      if (i < batches.length - 1) {
        await delay(BATCH_DELAY_MS);
      }
    }
  } finally {
    if (browser) await browser.close();
    console.log('[PLAYWRIGHT] Browser closed.');
  }

  console.log(`\nSummarization complete. ${allSummarized.length} articles summarized. Total tokens used: ${totalTokensUsed}`);
  return allSummarized;
}

module.exports = summarizeArticles;
