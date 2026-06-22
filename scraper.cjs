const Parser = require('rss-parser');
const axios = require('axios');

const parser = new Parser({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; EuromixSourcesBot/1.0; +https://euromix.co.il)'
  }
});

const FEEDS = Object.keys(process.env)
  .filter(key => key.startsWith('GOOGLE_ALERT_RSS_'))
  .sort((a, b) => {
    const aNum = Number(a.split('_').pop()) || 0;
    const bNum = Number(b.split('_').pop()) || 0;
    return aNum - bNum;
  })
  .map(key => process.env[key])
  .filter(Boolean);

const HOURS_BACK = Number(process.env.HOURS_BACK || 24);
const WP_BASE_URL = (process.env.WP_BASE_URL || '').replace(/\/$/, '');
const WP_USERNAME = process.env.WP_USERNAME || '';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || '';
const WP_IMPORT_ENDPOINT =
  process.env.WP_IMPORT_ENDPOINT || `${WP_BASE_URL}/wp-json/custom/v1/import-source-item`;

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const IMPORT_CONCURRENCY = Number(process.env.IMPORT_CONCURRENCY || 3);
const BETWEEN_REQUEST_DELAY_MS = Number(process.env.BETWEEN_REQUEST_DELAY_MS || 150);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return '';

  try {
    const url = new URL(rawUrl.trim());
    url.hash = '';

    const blockedParams = new Set([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'utm_id',
      'utm_name',
      'fbclid',
      'gclid',
      'mc_cid',
      'mc_eid',
      'mkt_tok',
      'igshid'
    ]);

    [...url.searchParams.keys()].forEach(key => {
      if (blockedParams.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    });

    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }

    url.hostname = url.hostname.toLowerCase();

    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }

    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

function decodeGoogleRedirect(possibleGoogleUrl) {
  if (!possibleGoogleUrl) return '';

  try {
    const u = new URL(possibleGoogleUrl);

    if (
      u.hostname.includes('google.') &&
      (u.pathname.includes('/url') || u.pathname.includes('/rss/articles'))
    ) {
      const direct =
        u.searchParams.get('url') ||
        u.searchParams.get('q') ||
        u.searchParams.get('continue');

      if (direct) return direct;
    }

    return possibleGoogleUrl;
  } catch {
    return possibleGoogleUrl;
  }
}

function extractBestUrl(item) {
  const candidates = [
    item.link,
    item.guid,
    item.id
  ].filter(Boolean);

  for (const candidate of candidates) {
    const decoded = decodeGoogleRedirect(candidate);
    const normalized = normalizeUrl(decoded);
    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
      return normalized;
    }
  }

  return '';
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function getPublishedAt(item) {
  return (
    toIsoDate(item.isoDate) ||
    toIsoDate(item.pubDate) ||
    toIsoDate(item.published) ||
    toIsoDate(item.created)
  );
}

function isRecent(isoDate, hoursBack) {
  if (!isoDate) return false;
  const published = new Date(isoDate).getTime();
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  return published >= cutoff;
}

function cleanText(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function buildArticle(feedUrl, item) {
  const sourceUrl = extractBestUrl(item);
  const title = cleanText(item.title || '');
  const publishedAt = getPublishedAt(item);
  const summary = cleanText(item.contentSnippet || item.content || item.summary || '');
  const sourceName = cleanText(item.creator || item.author || '');

  return {
    title,
    source_url: sourceUrl,
    published_at: publishedAt,
    excerpt: summary,
    source_name: sourceName,
    feed_url: feedUrl
  };
}

async function fetchFeed(feedUrl, index, total) {
  console.log(`🔗 Fetching feed ${index + 1}/${total}...`);

  try {
    const feed = await parser.parseURL(feedUrl);
    const items = Array.isArray(feed.items) ? feed.items : [];

    if (!items.length) {
      console.log('⚠️ Feed empty');
      return { ok: true, items: [] };
    }

    console.log(`✅ Found ${items.length} items`);
    return {
      ok: true,
      items: items.map(item => buildArticle(feedUrl, item))
    };
  } catch (error) {
    const status = error?.response?.status;
    console.log(`❌ Feed error: ${status ? `Status code ${status}` : error.message}`);
    return { ok: false, items: [] };
  }
}

function dedupeArticles(articles) {
  const seen = new Set();
  const unique = [];

  for (const article of articles) {
    if (!article.source_url) continue;
    if (!article.title) continue;

    const key = article.source_url;
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(article);
  }

  return unique;
}

function authHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${token}`;
}

async function importOneArticle(article, index, total) {
  try {
    const payload = {
      title: article.title,
      source_url: article.source_url,
      published_at: article.published_at,
      excerpt: article.excerpt,
      source_name: article.source_name
    };

    const response = await axios.post(WP_IMPORT_ENDPOINT, payload, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader(WP_USERNAME, WP_APP_PASSWORD)
      },
      validateStatus: () => true
    });

    const data = response.data || {};

    if (response.status >= 200 && response.status < 300) {
      if (data.duplicate) {
        console.log(`⏭️ [${index + 1}/${total}] Duplicate: ${article.title}`);
        return { status: 'duplicate' };
      }

      console.log(`✅ [${index + 1}/${total}] Imported: ${article.title}`);
      return { status: 'created' };
    }

    console.log(
      `❌ [${index + 1}/${total}] Import failed (${response.status}): ${article.title}`
    );

    return {
      status: 'failed',
      code: response.status,
      body: data
    };
  } catch (error) {
    console.log(`❌ [${index + 1}/${total}] Import error: ${article.title}`);
    console.log(`   ${error.message}`);
    return {
      status: 'failed',
      error: error.message
    };
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;

      results[currentIndex] = await worker(items[currentIndex], currentIndex, items.length);

      if (BETWEEN_REQUEST_DELAY_MS > 0) {
        await sleep(BETWEEN_REQUEST_DELAY_MS);
      }
    }
  }

  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => runner()
  );

  await Promise.all(runners);
  return results;
}

async function pushArticlesToWordPress(articles) {
  if (!articles.length) {
    console.log('ℹ️ No articles to import');
    return;
  }

  console.log(`🚀 Sending ${articles.length} articles to WordPress...`);
  console.log(`⚙️ Concurrency: ${IMPORT_CONCURRENCY}`);

  const results = await runPool(articles, IMPORT_CONCURRENCY, importOneArticle);

  const summary = results.reduce(
    (acc, item) => {
      if (!item) return acc;
      acc.total += 1;
      if (item.status === 'created') acc.created += 1;
      if (item.status === 'duplicate') acc.duplicates += 1;
      if (item.status === 'failed') acc.failed += 1;
      return acc;
    },
    { total: 0, created: 0, duplicates: 0, failed: 0 }
  );

  console.log('📊 Import summary:');
  console.log(`   Total processed: ${summary.total}`);
  console.log(`   Created: ${summary.created}`);
  console.log(`   Duplicates: ${summary.duplicates}`);
  console.log(`   Failed: ${summary.failed}`);

  if (summary.failed > 0) {
    throw new Error(`WordPress import completed with ${summary.failed} failed items`);
  }
}

function validateEnv() {
  const missing = [];

  if (!FEEDS.length) missing.push('At least one GOOGLE_ALERT_RSS_* env var');
  if (!WP_BASE_URL) missing.push('WP_BASE_URL');
  if (!WP_USERNAME) missing.push('WP_USERNAME');
  if (!WP_APP_PASSWORD) missing.push('WP_APP_PASSWORD');

  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}

async function run() {
  console.log(`🚀 Starting scraper at ${new Date().toUTCString()}`);
  console.log('🚀 Starting scraper with Google Alerts RSS feeds...');
  validateEnv();

  console.log(`📡 Processing ${FEEDS.length} RSS feeds...`);
  console.log(`⏰ Importing articles from last ${HOURS_BACK} hours`);

  const feedResults = [];
  for (let i = 0; i < FEEDS.length; i += 1) {
    const result = await fetchFeed(FEEDS[i], i, FEEDS.length);
    feedResults.push(result);
  }

  const successFeeds = feedResults.filter(r => r.ok).length;
  const failedFeeds = feedResults.filter(r => !r.ok).length;

  console.log(`📊 Feeds processed: ${successFeeds} success, ${failedFeeds} failed`);

  const allItems = feedResults.flatMap(r => r.items || []);
  console.log(`📦 Total items collected: ${allItems.length}`);

  const uniqueArticles = dedupeArticles(allItems);
  console.log(`🔎 Unique articles (after in-memory dedup): ${uniqueArticles.length}`);

  const recentArticles = uniqueArticles.filter(article =>
    isRecent(article.published_at, HOURS_BACK)
  );
  console.log(`🔎 Recent articles (${HOURS_BACK}h): ${recentArticles.length}`);

  recentArticles.sort((a, b) => {
    const aTime = a.published_at ? new Date(a.published_at).getTime() : 0;
    const bTime = b.published_at ? new Date(b.published_at).getTime() : 0;
    return bTime - aTime;
  });

  await pushArticlesToWordPress(recentArticles);

  console.log('🎉 Scraper finished successfully');
}

run().catch(error => {
  console.error('❌ Error:', error.message);
  if (error.stack) {
    console.error('\nStack:', error.stack);
  }
  process.exit(1);
});
