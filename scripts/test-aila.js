require('dotenv').config();
const fetchArticles = require('../src/fetcher');

const ailaSources = [
  { name: "AILA Recent Postings", url: "https://www.aila.org/recent-postings", tier: "tier_1" },
];

fetchArticles(ailaSources).then((articles) => {
  console.log('\n=== AILA Articles (public only) ===');
  for (const a of articles) {
    console.log(`  [${a.publishedDate}] ${a.title}`);
    console.log(`    ${a.url}`);
  }
  console.log(`\nTotal: ${articles.length}`);
});
