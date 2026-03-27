require('dotenv').config();
const fetchArticles = require('./fetcher');
const summarizeArticles = require('./summarizer');
const writeArticlesToNotion = require('./notion-writer');
const generateNewsletter = require('./newsletter-generator');
const { tier_1, tier_2, tier_3 } = require('../config/sources');

const sources = [...tier_1, ...tier_2, ...tier_3];

async function runPipeline() {
  console.log('=== IMMIGRATION NEWSLETTER PIPELINE ===');
  console.log(`Date: ${new Date().toISOString().split('T')[0]}`);
  console.log(`Sources: ${sources.length} (${tier_1.length} tier_1, ${tier_2.length} tier_2, ${tier_3.length} tier_3)\n`);

  // Step 1: Fetch
  const articles = await fetchArticles(sources);
  const sourceCount = new Set(articles.map((a) => a.source)).size;
  console.log(`[FETCH] ${articles.length} articles fetched from ${sourceCount} sources\n`);
  if (articles.length === 0) {
    throw new Error('No articles fetched from any source. Aborting pipeline.');
  }

  // Step 2: Summarize
  const summarized = await summarizeArticles(articles);
  console.log(`[SUMMARIZE] ${summarized.length} articles summarized\n`);
  if (summarized.length === 0) {
    throw new Error('No articles were successfully summarized. Aborting pipeline.');
  }

  // Step 3: Write to Notion
  const result = await writeArticlesToNotion(summarized);
  console.log(`[NOTION] ${result.inserted} inserted, ${result.skipped} skipped, ${result.failed} failed\n`);

  // Step 4: Generate newsletter (non-blocking — failure here won't crash the pipeline)
  try {
    const newsletter = await generateNewsletter();
    if (newsletter.success) {
      console.log(`[NEWSLETTER] Newsletter page created: ${newsletter.pageUrl}`);
    } else {
      console.log(`[NEWSLETTER] Skipped (${newsletter.reason})`);
    }
  } catch (err) {
    console.error(`[NEWSLETTER] Failed to generate newsletter: ${err.message}`);
    console.error('[NEWSLETTER] Articles were already saved to Notion — continuing.');
  }

  console.log('\n=== NEWSLETTER RUN COMPLETE ===');
  console.log(`Total fetched: ${articles.length}`);
  console.log(`Total summarized: ${summarized.length}`);
  console.log(`Inserted to Notion: ${result.inserted}`);
  console.log(`Skipped (duplicates): ${result.skipped}`);
  console.log(`Failed: ${result.failed}`);
  console.log('[SUCCESS] Pipeline complete');
}

runPipeline()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n[FATAL] Pipeline failed: ${err.message}`);
    process.exit(1);
  });
