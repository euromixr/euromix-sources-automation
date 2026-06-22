const admin = require("firebase-admin");
const axios = require("axios");
const Parser = require("rss-parser");

const APP_ID = "euromix-pro-v4-wp";
const MAX_AGE_HOURS = 24;
const KEEP_WORK_DAYS = 30;
const KEEP_NEW_HOURS = 48;

const WP_IMPORT_URL =
  process.env.WP_IMPORT_URL || "https://euromix.co.il/wp-json/euromix/v1/import-source-item";
const WP_IMPORT_SECRET = process.env.WP_IMPORT_SECRET || "";

const GOOGLE_ALERT_FEEDS = [
  "https://www.google.com/alerts/feeds/15835567105207766825/5913675776665511822",
  "https://corsproxy.io/?https://www.reddit.com/r/eurovision/new.rss",
  "https://www.google.com/alerts/feeds/15835567105207766825/14323053635267839718",
  "https://www.google.com/alerts/feeds/15835567105207766825/3774609703160026695",
  "https://www.google.com/alerts/feeds/15835567105207766825/7909243822372747901",
  "https://www.google.com/alerts/feeds/15835567105207766825/3212966415973058238",
  "https://www.google.com/alerts/feeds/15835567105207766825/9865084348395279824",
  "https://www.google.com/alerts/feeds/15835567105207766825/2294528357901013805",
  "https://www.google.com/alerts/feeds/15835567105207766825/16530782648428681816",
  "https://www.google.com/alerts/feeds/15835567105207766825/2839844874789685639",
  "https://www.google.com/alerts/feeds/15835567105207766825/590056587497403967",
  "https://www.google.com/alerts/feeds/15835567105207766825/8289137387248956728",
  "https://www.google.com/alerts/feeds/15835567105207766825/7887756076627969525",
  "https://www.google.com/alerts/feeds/15835567105207766825/650055242359765947",
  "https://www.google.com/alerts/feeds/15835567105207766825/18150856224220615637",
  "https://www.google.com/alerts/feeds/15835567105207766825/590056587497404513",
  "https://www.google.com/alerts/feeds/15835567105207766825/5439785953820081518",
  "https://www.google.com/alerts/feeds/15835567105207766825/14323053635267838170",
  "https://www.google.com/alerts/feeds/15835567105207766825/16462799108050230353",
  "https://www.google.com/alerts/feeds/15835567105207766825/5229535975056204060",
  "https://www.google.com/alerts/feeds/15835567105207766825/18149203235573798037",
  "https://www.google.com/alerts/feeds/15835567105207766825/1734480943282004171",
  "https://www.google.com/alerts/feeds/15835567105207766825/7686022273118167199",
  "https://www.google.com/alerts/feeds/15835567105207766825/2511188842940626316",
  "https://www.google.com/alerts/feeds/15835567105207766825/6708471790519134431",
  "https://www.google.com/alerts/feeds/15835567105207766825/6073672349489065697",
  "https://www.google.com/alerts/feeds/15835567105207766825/15780802084620737192",
  "https://www.google.com/alerts/feeds/15835567105207766825/6665331610851128851",
  "https://www.google.com/alerts/feeds/15835567105207766825/16734694345916095083",
  "https://www.google.com/alerts/feeds/15835567105207766825/5768382838368422062",
  "https://www.google.com/alerts/feeds/15835567105207766825/15462106606358024819",
  "https://www.google.com/alerts/feeds/15835567105207766825/4939101851014900767",
  "https://www.google.com/alerts/feeds/15835567105207766825/10258311237790315460",
  "https://www.google.com/alerts/feeds/15835567105207766825/13469247121030984786",
  "https://www.google.com/alerts/feeds/15835567105207766825/7471694817148723592",
  "https://www.google.com/alerts/feeds/15835567105207766825/5521115869083766938",
  "https://www.google.com/alerts/feeds/15835567105207766825/600578587183424385",
  "https://www.google.com/alerts/feeds/15835567105207766825/6489150213567016703",
  "https://www.google.com/alerts/feeds/15835567105207766825/1180767461695683410",
  "https://www.google.com/alerts/feeds/15835567105207766825/15615812334629122465",
  "https://www.google.com/alerts/feeds/15835567105207766825/8117892362414115022",
  "https://www.google.com/alerts/feeds/15835567105207766825/17418799624831186251",
  "https://www.google.com/alerts/feeds/15835567105207766825/5615330509302177194",
  "https://www.google.com/alerts/feeds/15835567105207766825/9276029416140084921",
  "https://www.google.com/alerts/feeds/15835567105207766825/8937318266706503768",
  "https://www.google.com/alerts/feeds/15835567105207766825/836375354746867643",
  "https://www.google.com/alerts/feeds/15835567105207766825/4702931870982455282",
  "https://www.google.com/alerts/feeds/15835567105207766825/7841272026805120970",
  "https://www.google.com/alerts/feeds/15835567105207766825/5270168749846509977",
  "https://www.google.com/alerts/feeds/15835567105207766825/15423983244498170540",
  "https://www.google.com/alerts/feeds/15835567105207766825/14086237475371258259",
  "https://www.google.com/alerts/feeds/15835567105207766825/13669486295274188151",
  "https://www.google.com/alerts/feeds/15835567105207766825/13164718255631459023",
  "https://www.google.com/alerts/feeds/15835567105207766825/12504643566802910413",
  "https://www.google.com/alerts/feeds/15835567105207766825/11425745387878122567",
  "https://www.google.com/alerts/feeds/15835567105207766825/7969999045049038384",
  "https://www.google.com/alerts/feeds/15835567105207766825/17262529628428332060",
  "https://www.google.com/alerts/feeds/15835567105207766825/14407299024310346891",
  "https://www.google.com/alerts/feeds/15835567105207766825/15099035478425700531",
  "https://www.google.com/alerts/feeds/15835567105207766825/5473716720584096141",
  "https://www.google.com/alerts/feeds/15835567105207766825/1913102588284681727",
  "https://www.google.com/alerts/feeds/15835567105207766825/2150643630344992794",
  "https://www.google.com/alerts/feeds/15835567105207766825/5024685657597218016",
  "https://www.google.com/alerts/feeds/15835567105207766825/4854044355477788333",
  "https://www.google.com/alerts/feeds/15835567105207766825/15551386491322919916",
  "https://www.google.com/alerts/feeds/15835567105207766825/5825472544868778374",
  "https://www.google.com/alerts/feeds/15835567105207766825/17366842103016854853",
  "https://www.google.com/alerts/feeds/15835567105207766825/14327067969509063538",
  "https://www.google.com/alerts/feeds/15835567105207766825/13215923477997557724",
  "https://www.google.com/alerts/feeds/15835567105207766825/12663402077177438741",
  "https://www.google.com/alerts/feeds/15835567105207766825/4826808762736646782",
  "https://www.google.com/alerts/feeds/15835567105207766825/4826808762736644521",
  "https://www.google.com/alerts/feeds/15835567105207766825/7385955869198543219",
  "https://www.google.com/alerts/feeds/15835567105207766825/8866379031215318377",
  "https://www.google.com/alerts/feeds/15835567105207766825/15309312881762578228",
  "https://www.google.com/alerts/feeds/15835567105207766825/7628706936256400347",
  "https://www.google.com/alerts/feeds/15835567105207766825/960640283877058796",
  "https://www.google.com/alerts/feeds/15835567105207766825/7909243822372746376",
  "https://www.google.com/alerts/feeds/15835567105207766825/17112238031615030532",
  "https://www.google.com/alerts/feeds/15835567105207766825/15568534955257898837",
  "https://www.google.com/alerts/feeds/15835567105207766825/8021792460522158297",
  "https://www.google.com/alerts/feeds/15835567105207766825/16054439845077286272",
  "https://www.google.com/alerts/feeds/15835567105207766825/8021792460522158387",
  "https://www.google.com/alerts/feeds/15835567105207766825/12981302875322281890",
  "https://www.google.com/alerts/feeds/15835567105207766825/10474700008340530024",
  "https://www.google.com/alerts/feeds/15835567105207766825/16401508015335764264",
  "https://www.google.com/alerts/feeds/15835567105207766825/10446842549172419926",
  "https://www.google.com/alerts/feeds/15835567105207766825/3752359685739993463",
  "https://www.google.com/alerts/feeds/15835567105207766825/826679917683776817",
  "https://www.google.com/alerts/feeds/15835567105207766825/138718906201805591",
  "https://www.google.com/alerts/feeds/15835567105207766825/4171072731871609982"
];

function initFirebase() {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT missing.");
    process.exit(1);
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountRaw);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    return admin.firestore();
  } catch (error) {
    console.error("❌ Error parsing service account:", error.message);
    process.exit(1);
  }
}

const db = initFirebase();

function normalizeUrl(rawUrl) {
  if (!rawUrl) return "";

  let actualLink = String(rawUrl).trim();

  try {
    if (actualLink.includes("google.com/url")) {
      const urlObj = new URL(actualLink);
      const realUrl = urlObj.searchParams.get("url");
      if (realUrl) actualLink = decodeURIComponent(realUrl);
    }
  } catch (_) {}

  try {
    const cleanUrl = new URL(actualLink);
    cleanUrl.hash = "";
    cleanUrl.search = "";
    return cleanUrl.origin + cleanUrl.pathname;
  } catch (_) {
    return actualLink;
  }
}

function extractSource(link) {
  try {
    return new URL(link).hostname.replace(/^(www\.)?/, "");
  } catch (_) {
    return "Unknown";
  }
}

function cleanText(value, maxLength = null) {
  try {
    const text = typeof value === "string" ? value : String(value || "");
    const cleaned = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
  } catch (_) {
    return "";
  }
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function mapFeedItem(item) {
  const link = normalizeUrl(item?.link || "");
  return {
    title: cleanText(item?.title || "", 500),
    link,
    source: extractSource(link),
    img: item?.enclosure?.url || null,
    pubDate: toIsoDate(item?.pubDate),
    snippet: cleanText(item?.contentSnippet || item?.title || "", 200),
  };
}

function dedupeByLink(items) {
  return Array.from(new Map(items.map((item) => [item.link, item])).values());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pushArticleToWordPress(article) {
  if (!WP_IMPORT_SECRET) {
    throw new Error("WP_IMPORT_SECRET missing");
  }

  const payload = {
    title: article.title || "",
    link: article.link || "",
    source: article.source || "",
    img: article.img || "",
    pubDate: article.pubDate || "",
    snippet: article.snippet || "",
    status: "new",
    flagged: false,
    processing: false,
    assignedTo: "",
    isCustom: false,
    isManual: false,
  };

  const response = await axios.post(WP_IMPORT_URL, payload, {
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
      "x-euromix-secret": WP_IMPORT_SECRET,
    },
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300 || !response.data?.ok) {
    throw new Error(`WP import failed (${response.status}): ${JSON.stringify(response.data)}`);
  }

  return response.data;
}

async function pushArticlesToWordPress(articles) {
  if (!articles.length) {
    console.log("🌐 No new articles to push to WordPress.");
    return { success: 0, failed: 0 };
  }

  let success = 0;
  let failed = 0;

  for (const [index, article] of articles.entries()) {
    try {
      const result = await pushArticleToWordPress(article);
      success++;
      console.log(`🌐 [${index + 1}/${articles.length}] WP imported: ${article.link} -> ${result.received || "ok"}`);
    } catch (error) {
      failed++;
      console.error(`❌ [${index + 1}/${articles.length}] WP import failed for ${article.link}: ${error.message}`);
    }

    await sleep(250);
  }

  return { success, failed };
}

async function saveArticlesToFirestore(articles) {
  if (!articles.length) {
    console.log("💾 No recent articles to save to Firestore.");
    return;
  }

  const articlesCollection = db
    .collection("artifacts")
    .doc(APP_ID)
    .collection("public")
    .doc("data")
    .collection("articles");

  let saved = 0;

  for (let i = 0; i < articles.length; i += 400) {
    const slice = articles.slice(i, i + 400);
    const batch = db.batch();

    slice.forEach((article) => {
      const docRef = articlesCollection.doc();
      batch.set(docRef, {
        ...article,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "new",
        flagged: false,
        publishedSite: false,
        publishedSocialHe: false,
        publishedSocialEn: false,
        translationComplete: false,
        assignedTo: null,
        isCustom: false,
        hasCountedWriting: false,
      });
    });

    await batch.commit();
    saved += slice.length;
    console.log(`💾 Saved ${saved}/${articles.length} articles to Firestore`);
  }
}

async function run() {
  console.log("🚀 Starting scraper with Google Alerts RSS feeds...");
  console.log(`📡 Processing ${GOOGLE_ALERT_FEEDS.length} RSS feeds...`);
  console.log(`⏰ Importing articles from last ${MAX_AGE_HOURS} hours`);

  try {
    await updateStatusTime();

    const parser = new Parser({
      headers: {
        "User-Agent": "NodeJS:euromix-scraper:v1.2 (by /u/Fluffy_Care7919)",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
      timeout: 30000,
    });

    const allArticles = [];
    let successCount = 0;
    let failCount = 0;

    for (const feedUrl of GOOGLE_ALERT_FEEDS) {
      try {
        console.log(`🔗 Fetching feed ${successCount + failCount + 1}/${GOOGLE_ALERT_FEEDS.length}...`);
        const feed = await parser.parseURL(feedUrl);

        if (feed.items && feed.items.length > 0) {
          const articles = feed.items
            .map(mapFeedItem)
            .filter((article) => article.title && article.link);

          allArticles.push(...articles);
          successCount++;
          console.log(`✅ Found ${articles.length} items`);
        } else {
          successCount++;
          console.log("⚠️ Feed empty");
        }
      } catch (error) {
        failCount++;
        console.error(`❌ Feed error: ${error.message}`);
      }
    }

    console.log(`📊 Feeds processed: ${successCount} success, ${failCount} failed`);
    console.log(`📦 Total items collected: ${allArticles.length}`);

    if (!allArticles.length) {
      console.log("⚠️ No articles found");
      process.exit(0);
    }

    const uniqueArticles = dedupeByLink(allArticles);
    console.log(`🔎 Unique articles (after in-memory dedup): ${uniqueArticles.length}`);

    const cutoffTime = new Date(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000);
    const recentArticles = uniqueArticles.filter((article) => new Date(article.pubDate) >= cutoffTime);
    console.log(`🔎 Recent articles (${MAX_AGE_HOURS}h): ${recentArticles.length}`);

    console.log(`⏭️ Skipping Firestore duplicate check. Using ${recentArticles.length} recent articles directly.`);

    await saveArticlesToFirestore(recentArticles);

    const wpResult = await pushArticlesToWordPress(recentArticles);
    console.log(`🌐 WordPress import summary: ${wpResult.success} success, ${wpResult.failed} failed`);

    await cleanupSmart();
    await updateStatusTime();

    console.log("🎉 Scraper finished successfully!");
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

async function cleanupSmart() {
  console.log("🧹 Smart cleanup...");

  try {
    const articlesRef = db
      .collection("artifacts")
      .doc(APP_ID)
      .collection("public")
      .doc("data")
      .collection("articles");

    const allNew = await articlesRef.where("status", "==", "new").get();
    console.log(`📊 ${allNew.size} articles with status 'new'.`);

    if (!allNew.empty) {
      const batch = db.batch();
      let deleteCount = 0;
      const keepNewCutoff = new Date(Date.now() - KEEP_NEW_HOURS * 60 * 60 * 1000);

      allNew.docs.forEach((doc) => {
        const data = doc.data();
        const pubDate = data.pubDate ? new Date(data.pubDate) : new Date(0);

        if (pubDate < keepNewCutoff) {
          batch.delete(doc.ref);
          deleteCount++;
        }
      });

      if (deleteCount > 0) {
        await batch.commit();
        console.log(`🗑️ Deleted ${deleteCount} 'new' articles older than ${KEEP_NEW_HOURS} hours.`);
      } else {
        console.log(`✅ No 'new' articles older than ${KEEP_NEW_HOURS} hours.`);
      }
    }

    console.log("🧹 Checking articles in process (not 'new')...");
    const allArticles = await articlesRef.where("status", "!=", "new").get();
    console.log(`📊 ${allArticles.size} articles in process.`);

    if (!allArticles.empty) {
      const workBatch = db.batch();
      let workDeleteCount = 0;
      const thirtyDaysAgo = new Date(Date.now() - KEEP_WORK_DAYS * 24 * 60 * 60 * 1000);

      allArticles.docs.forEach((doc) => {
        const data = doc.data();
        const createdDate = data.createdAt ? data.createdAt.toDate() : new Date(0);

        if (createdDate < thirtyDaysAgo) {
          workBatch.delete(doc.ref);
          workDeleteCount++;
        }
      });

      if (workDeleteCount > 0) {
        await workBatch.commit();
        console.log(`🗑️ Deleted ${workDeleteCount} articles in process older than ${KEEP_WORK_DAYS} days.`);
      } else {
        console.log(`✅ No articles in process older than ${KEEP_WORK_DAYS} days.`);
      }
    }

    try {
      const totalCount = await articlesRef.count().get();
      console.log(`📊 Total articles in DB: ${totalCount.data().count}`);
    } catch (_) {
      const snapshot = await articlesRef.get();
      console.log(`📊 Total articles in DB: ${snapshot.size}`);
    }
  } catch (error) {
    console.error("⚠️ Cleanup error:", error.message);
  }
}

async function updateStatusTime() {
  try {
    await db
      .collection("artifacts")
      .doc(APP_ID)
      .collection("public")
      .doc("data")
      .collection("settings")
      .doc("status")
      .set(
        {
          lastScrape: admin.firestore.Timestamp.now(),
        },
        { merge: true }
      );
  } catch (_) {}
}

run();
