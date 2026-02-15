const admin = require("firebase-admin");
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// 🔐 Firebase דרך משתנה סביבה FIREBASE_SERVICE_ACCOUNT (JSON מלא)
function initFirebase() {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT missing");
    process.exit(1);
  }
  try {
    const serviceAccount = JSON.parse(serviceAccountRaw);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    return admin.firestore();
  } catch (error) {
    console.error("❌ Error parsing key:", error.message);
    process.exit(1);
  }
}

const db = initFirebase();
const APP_ID = 'euromix-pro-v4-wp';
const TARGET_URL = "https://www.euromix.co.il/a123/";
const MAX_ARTICLE_AGE_HOURS = 24;
const MAX_NEW_ARTICLES = 300;
const FIRESTORE_BATCH_LIMIT = 500;

async function run() {
  console.log("🔥 Running - 24h articles only, skip existing!");
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const page = await browser.newPage();

    // User agent + headers
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });

    await updateStatusTime();

    console.log("🔍 Loading existing article IDs...");
    const existingIds = await getExistingArticleIds();
    console.log(`📋 Found ${existingIds.size} existing articles in DB`);

    await page.setViewport({ width: 1920, height: 1080 });
    console.log("📡 Loading page...");
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 180000 });

    console.log("📜 Scrolling...");
    await aggressiveAutoScroll(page);

    console.log("🔍 Extracting articles...");
    const articles = await page.evaluate(() => {
      const results = [];
      const allLinks = document.querySelectorAll('a');

      const parseRelativeTime = (text) => {
        if (!text) return null;
        const now = new Date();
        const cleanText = text.toLowerCase();
        const match = cleanText.match(/(\d+)/);
        if (!match) return null;
        const num = parseInt(match[0]);

        if (cleanText.includes('דק') || cleanText.includes('min')) {
          now.setMinutes(now.getMinutes() - num);
        } else if (cleanText.includes('שע') || cleanText.includes('hour')) {
          now.setHours(now.getHours() - num);
        } else if (cleanText.includes('יום') || cleanText.includes('ימים') || cleanText.includes('day')) {
          now.setDate(now.getDate() - num);
        } else {
          return null;
        }

        return now.toISOString();
      };

      allLinks.forEach(link => {
        const href = link.href;
        let title = link.innerText.trim();

        if (!href || href.length < 10) return;
        if (href.includes('euromix.co.il') || href.includes('facebook.com') ||
            href.includes('twitter.com') || href.includes('whatsapp.com')) return;
        if (title.length < 10) return;

        let dateStr = null;
        let container = link.parentElement;
        let depth = 0;

        while (container && !dateStr && depth < 5) {
          const text = container.innerText;
          if ((text.includes('לפני') || text.includes('ago') || text.includes('Published')) && /\d/.test(text)) {
            const lines = text.split('\n');
            const timeLine = lines.find(l =>
              (l.includes('לפני') || l.includes('ago') || l.includes('Published')) && /\d/.test(l)
            );
            if (timeLine) dateStr = timeLine;
          }
          container = container.parentElement;
          depth++;
        }

        const pubDate = parseRelativeTime(dateStr);
        if (!pubDate) return;

        let img = null;
        container = link.parentElement;
        depth = 0;

        while (container && !img && depth < 4) {
          const foundImg = container.querySelector('img');
          if (foundImg) {
            img = foundImg.src ||
                  foundImg.getAttribute('data-src') ||
                  foundImg.getAttribute('srcset');
            if (img && (img.includes('icon') || img.includes('logo') || img.length < 20)) img = null;
          }
          container = container.parentElement;
          depth++;
        }

        let source = "Unknown";
        try {
          const urlObj = new URL(href);
          source = urlObj.hostname.replace('www.', '');
        } catch (e) {}

        results.push({
          title: title,
          link: href,
          source: source,
          img: img,
          pubDate: pubDate,
          snippet: title
        });
      });

      return results;
    });

    console.log(`📰 Scraped ${articles.length} articles from page`);

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - (MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000));
    const recentArticles = articles.filter(article => {
      const articleDate = new Date(article.pubDate);
      return articleDate >= oneDayAgo && articleDate <= now;
    });

    console.log(`⏰ ${recentArticles.length} from last 24 hours`);

    const uniqueArticles = Array.from(new Map(
      recentArticles.map(item => [item.link, item])
    ).values());
    console.log(`🔗 ${uniqueArticles.length} unique articles`);

    const newArticles = uniqueArticles.filter(article => {
      const articleId = generateArticleId(article.link);
      return !existingIds.has(articleId);
    });

    console.log(`✨ ${newArticles.length} NEW articles (${uniqueArticles.length - newArticles.length} already exist, skipped)`);

    if (newArticles.length > 0) {
      const articlesToSave = newArticles.slice(0, MAX_NEW_ARTICLES);
      await saveArticlesBatch(articlesToSave);
    } else {
      console.log("✅ No new articles to save");
    }

    await cleanupOldArticles();
    await updateStatusTime();
    console.log("✅ Done!");
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    setTimeout(() => process.exit(0), 1000);
  }
}

async function getExistingArticleIds() {
  const articlesRef = db.collection('artifacts').doc(APP_ID)
    .collection('public').doc('data').collection('articles');

  const snapshot = await articlesRef.select().get();
  const ids = new Set();

  snapshot.forEach(doc => {
    ids.add(doc.id);
  });

  return ids;
}

function generateArticleId(link) {
  return Buffer.from(link)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 60);
}

async function saveArticlesBatch(articles) {
  console.log(`💾 Saving ${articles.length} NEW articles...`);
  const articlesRef = db.collection('artifacts').doc(APP_ID)
    .collection('public').doc('data').collection('articles');

  let savedCount = 0;

  for (let i = 0; i < articles.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = articles.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();

    chunk.forEach(article => {
      const articleId = generateArticleId(article.link);
      const docRef = articlesRef.doc(articleId);

      batch.set(docRef, {
        ...article,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'new',
        flagged: false,
        publishedSite: false,
        publishedSocialHe: false,
        publishedSocialEn: false,
        translationComplete: false,
        assignedTo: null,
        isCustom: false,
        hasCountedWriting: false
      }, { merge: true });
    });

    await batch.commit();
    savedCount += chunk.length;
    console.log(`💾 Batch ${Math.floor(i / FIRESTORE_BATCH_LIMIT) + 1}: ${chunk.length} articles (total: ${savedCount})`);

    if (i + FIRESTORE_BATCH_LIMIT < articles.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`✅ Saved ${savedCount} new articles`);
}

async function cleanupOldArticles() {
  console.log("🧹 Cleaning articles older than 24h...");
  try {
    const articlesRef = db.collection('artifacts').doc(APP_ID)
      .collection('public').doc('data').collection('articles');

    const now = admin.firestore.Timestamp.now();
    const oneDayAgo = new admin.firestore.Timestamp(
      now.seconds - (24 * 60 * 60),
      now.nanoseconds
    );

    const oldArticles = await articlesRef
      .where('createdAt', '<', oneDayAgo)
      .limit(200)
      .get();

    if (!oldArticles.empty) {
      await deleteInBatches(oldArticles.docs);
      console.log(`🗑️ Deleted ${oldArticles.size} old articles`);
    } else {
      console.log("✅ No old articles to delete");
    }

    const totalSnapshot = await articlesRef.where('status', '==', 'new').count().get();
    console.log(`📊 Total 'new' articles: ${totalSnapshot.data().count}`);
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

async function deleteInBatches(docs) {
  for (let i = 0; i < docs.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = docs.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    if (i + FIRESTORE_BATCH_LIMIT < docs.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function aggressiveAutoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      let distance = 100;
      let count = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        count++;
        if (count > 40 || totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  });
}

async function updateStatusTime() {
  try {
    await db.collection('artifacts').doc(APP_ID)
      .collection('public').doc('data')
      .collection('settings').doc('status')
      .set({ lastScrape: admin.firestore.Timestamp.now() }, { merge: true });
  } catch (e) {
    console.error("Status update error:", e.message);
  }
}

run();
