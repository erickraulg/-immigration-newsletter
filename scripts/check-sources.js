require('dotenv').config();
const fetchArticles = require('../src/fetcher');
const { tier_1, tier_2, tier_3 } = require('../config/sources');

const allSources = [...tier_1, ...tier_2, ...tier_3];

fetchArticles(allSources).then((articles) => {
  const sourcesWithArticles = new Set(articles.map((a) => a.source));

  console.log('\n=== Sources with articles ===');
  for (const s of allSources) {
    if (sourcesWithArticles.has(s.name)) {
      const count = articles.filter((a) => a.source === s.name).length;
      console.log(`  OK  ${s.name} (${count} articles)`);
    }
  }

  console.log('\n=== Sources with ZERO articles ===');
  for (const s of allSources) {
    if (!sourcesWithArticles.has(s.name)) {
      console.log(`  FAIL  ${s.name} - ${s.url}`);
    }
  }
});
