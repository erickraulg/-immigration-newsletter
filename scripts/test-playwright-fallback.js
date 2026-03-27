require('dotenv').config();
const summarizeArticles = require('../src/summarizer');

// Sample articles that were getting 403s in the previous run
const testArticles = [
  {
    title: "Practice Alert: FY 2027 H-1B Cap Registration Period Extended",
    url: "https://www.aila.org/practice/practice-alerts/fy-2027-h-1b-cap-registration-period-extended",
    source: "AILA Recent Postings",
    publishedDate: "2026-03-27",
    tier: "tier_1",
  },
  {
    title: "Practice Alert: DHS Terminates TPS Designation for South Sudan",
    url: "https://www.aila.org/practice/practice-alerts/dhs-terminates-tps-designation-for-south-sudan",
    source: "AILA Recent Postings",
    publishedDate: "2026-03-27",
    tier: "tier_1",
  },
  {
    title: "Practice Alert: Visa Bond Pilot Program for B-1/B-2 Applicants",
    url: "https://www.aila.org/practice/practice-alerts/visa-bond-pilot-program-for-b-1-b-2-applicants",
    source: "AILA Recent Postings",
    publishedDate: "2026-03-27",
    tier: "tier_1",
  },
];

console.log(`Testing Playwright fallback with ${testArticles.length} AILA articles (403 on axios)...\n`);

summarizeArticles(testArticles).then((results) => {
  console.log('\n=== Results ===');
  for (const r of results) {
    console.log(`\nTitle: ${r.title}`);
    console.log(`Summary: ${r.summary}`);
  }
  console.log(`\n${results.length}/${testArticles.length} articles summarized successfully.`);
});
