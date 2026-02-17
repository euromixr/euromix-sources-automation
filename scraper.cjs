const admin = require("firebase-admin");
const axios = require('axios');
const Parser = require('rss-parser');

const APP_ID = 'euromix-pro-v4-wp';
const MAX_AGE_HOURS = 48;
const KEEP_NEW_LIMIT = 300;
const MAX_NEW_DAYS = 2;
const KEEP_WORK_DAYS = 30;

const GOOGLE_ALERT_FEEDS = [
    "https://www.google.com/alerts/feeds/06246568100549944052/795343927474894566",
    "https://www.google.com/alerts/feeds/06246568100549944052/10733370037108467223",
    "https://www.google.com/alerts/feeds/06246568100549944052/557423423509538553",
    "https://www.google.com/alerts/feeds/06246568100549944052/17088384328630950891",
    "https://www.google.com/alerts/feeds/06246568100549944052/12440077986784934032",
    "https://www.google.com/alerts/feeds/06246568100549944052/11474771711481293980",
    "https://www.google.com/alerts/feeds/06246568100549944052/11802422789544832213",
    "https://www.google.com/alerts/feeds/06246568100549944052/7566706820455729623",
    "https://www.google.com/alerts/feeds/06246568100549944052/13681067940937661426",
    "https://www.google.com/alerts/feeds/06246568100549944052/4200751291116562980",
    "https://www.google.com/alerts/feeds/06246568100549944052/14935090722471529293",
    "https://www.google.com/alerts/feeds/06246568100549944052/10277104388747642774",
    "https://www.google.com/alerts/feeds/06246568100549944052/3312570918171874401",
    "https://www.google.com/alerts/feeds/06246568100549944052/8332233932659767354",
    "https://www.google.com/alerts/feeds/06246568100549944052/16097641400209404195",
    "https://www.google.com/alerts/feeds/06246568100549944052/16097641400209405898",
    "https://www.google.com/alerts/feeds/06246568100549944052/16097641400209407660",
    "https://www.google.com/alerts/feeds/06246568100549944052/16097641400209406321",
    "https://www.google.com/alerts/feeds/06246568100549944052/12394802389823905697",
    "https://www.google.com/alerts/feeds/06246568100549944052/12394802389823902745",
    "https://www.google.com/alerts/feeds/06246568100549944052/12394802389823904210",
    "https://www.google.com/alerts/feeds/06246568100549944052/6704048547094928896",
    "https://www.google.com/alerts/feeds/06246568100549944052/6704048547094928765",
    "https://www.google.com/alerts/feeds/06246568100549944052/6704048547094927573",
    "https://www.google.com/alerts/feeds/06246568100549944052/12089369468476994837",
    "https://www.google.com/alerts/feeds/06246568100549944052/12089369468476994087",
    "https://www.google.com/alerts/feeds/06246568100549944052/1831928013655623988",
    "https://www.google.com/alerts/feeds/06246568100549944052/14198917735619385905",
    "https://www.google.com/alerts/feeds/06246568100549944052/3589006963503121351",
    "https://www.google.com/alerts/feeds/06246568100549944052/12383218810042123539",
    "https://www.google.com/alerts/feeds/06246568100549944052/16244574932590237425"
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
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        return admin.firestore();
    } catch (error) {
        console.error("❌ Error parsing service account:", error.message);
        process.exit(1);
    }
}

const db = initFirebase();

async function run() {
    console.log("🚀 Starting scraper with Google Alerts RSS feeds...");
    console.log(`📡 Processing ${GOOGLE_ALERT_FEEDS.length} RSS feeds...`);
    
    try {
        await updateStatusTime();

        const parser = new Parser({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            },
            timeout: 30000
        });

        let allArticles = [];
        let successCount = 0;
        let failCount = 0;

        for (const feedUrl of GOOGLE_ALERT_FEEDS) {
            try {
                console.log(`🔗 Fetching feed ${successCount + failCount + 1}/${GOOGLE_ALERT_FEEDS.length}...`);
                const feed = await parser.parseURL(feedUrl);
                
                if (feed.items && feed.items.length > 0) {
                    const articles = feed.items.map(item => {
                        let source = "Unknown";
                        try { 
                            const urlObj = new URL(item.link); 
                            source = urlObj.hostname.replace('www.', ''); 
                        } catch (e) {}

                        return {
                            title: item.title || '',
                            link: item.link || '',
                            source: source,
                            img: item.enclosure?.url || null,
                            pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                            snippet: item.contentSnippet || item.title || ''
                        };
                    });
                    
                    allArticles.push(...articles);
                    successCount++;
                    console.log(`✅ Found ${articles.length} items`);
                } else {
                    successCount++;
                    console.log(`⚠️ Feed empty`);
                }
            } catch (error) {
                failCount++;
                console.error(`❌ Feed error: ${error.message}`);
            }
        }

        console.log(`📊 Feeds processed: ${successCount} success, ${failCount} failed`);
        console.log(`📦 Total items collected: ${allArticles.length}`);

        if (allArticles.length === 0) {
            console.log("⚠️ No articles found");
            process.exit(0);
        }

        const uniqueArticles = Array.from(new Map(allArticles.map(item => [item.link, item])).values());
        console.log(`🔎 Unique articles: ${uniqueArticles.length}`);
        
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - (MAX_AGE_HOURS * 60 * 60 * 1000));
        const recentArticles = uniqueArticles.filter(article => {
            const pubDate = new Date(article.pubDate);
            return pubDate >= cutoffTime;
        });
        
        console.log(`🔎 Recent articles (${MAX_AGE_HOURS}h): ${recentArticles.length}`);

        const articlesCollection = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');

        const linksToCheck = recentArticles.map(a => a.link);
        const existingLinks = new Set();
        let totalReads = 0;

        console.log(`🔍 Checking ${linksToCheck.length} links...`);
        for (let i = 0; i < linksToCheck.length; i += 10) {
            const batch = linksToCheck.slice(i, i + 10);
            const snapshot = await articlesCollection.where('link', 'in', batch).select('link').get();
            totalReads += snapshot.size;
            snapshot.docs.forEach(doc => existingLinks.add(doc.data().link));
        }

        const newArticles = recentArticles.filter(a => !existingLinks.has(a.link));
        console.log(`📦 Checked ${linksToCheck.length} links (${totalReads} reads), found ${newArticles.length} new articles`);

        if (newArticles.length > 0) {
            const batch = db.batch();
            newArticles.forEach(article => {
                const docRef = articlesCollection.doc();
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
                });
            });
            await batch.commit();
            console.log(`💾 Saved ${newArticles.length} articles.`);
        } else {
            console.log("👌 No new articles.");
        }

        await cleanupSmart();
        await updateStatusTime();
        console.log("🎉 Scraper finished successfully!");

    } catch (e) {
        console.error("❌ Error:", e.message);
        console.error("Stack:", e.stack);
        process.exit(1);
    }
}

async function cleanupSmart() {
    console.log("🧹 Smart cleanup...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
        
        const allNew = await articlesRef.where('status', '==', 'new').get();
        console.log(`📊 ${allNew.size} articles with status 'new'.`);
        
        if (!allNew.empty) {
            const batch = db.batch();
            let deleteCount = 0;
            const now = new Date();
            const twoDaysAgo = new Date(now.getTime() - (MAX_NEW_DAYS * 24 * 60 * 60 * 1000));

            const docs = allNew.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
            docs.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

            docs.forEach((doc, index) => {
                const pubDate = new Date(doc.pubDate);
                if (pubDate < twoDaysAgo || (docs.length > KEEP_NEW_LIMIT && index < (docs.length - KEEP_NEW_LIMIT))) {
                    batch.delete(doc.ref);
                    deleteCount++;
                }
            });

            if (deleteCount > 0) {
                await batch.commit();
                console.log(`🗑️ Deleted ${deleteCount} old 'new' articles.`);
            } else {
                console.log("✅ No old 'new' articles to delete.");
            }
        }

        const totalCount = await articlesRef.count().get();
        console.log(`📊 Total: ${totalCount.data().count} articles.`);

        if (totalCount.data().count > 500) {
            console.log("🧹 Checking old work articles...");
            const allArticles = await articlesRef.get();
            const workBatch = db.batch();
            let workDeleteCount = 0;
            const thirtyDaysAgo = new Date(Date.now() - (KEEP_WORK_DAYS * 24 * 60 * 60 * 1000));

            allArticles.docs.forEach(doc => {
                const data = doc.data();
                if (data.status !== 'new') {
                    const createdDate = data.createdAt ? data.createdAt.toDate() : new Date(0);
                    if (createdDate < thirtyDaysAgo) {
                        workBatch.delete(doc.ref);
                        workDeleteCount++;
                    }
                }
            });

            if (workDeleteCount > 0) {
                await workBatch.commit();
                console.log(`🗑️ Deleted ${workDeleteCount} work articles older than 30 days.`);
            } else {
                console.log("✅ No old work articles to delete.");
            }
        } else {
            console.log("✅ Under 500 articles, skipping work cleanup.");
        }

    } catch (error) {
        console.error("⚠️ Cleanup error:", error.message);
    }
}

async function updateStatusTime() {
    try {
        await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('settings').doc('status').set({ lastScrape: admin.firestore.Timestamp.now() }, { merge: true });
    } catch(e) {}
}

run();
