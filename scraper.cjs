const admin = require("firebase-admin");
const axios = require('axios');

const APP_ID = 'euromix-pro-v4-wp';
const WP_API_URL = "https://www.euromix.co.il/wp-json/wp/v2/posts";
const MAX_AGE_HOURS = 48;
const KEEP_NEW_LIMIT = 300;
const MAX_NEW_DAYS = 2;
const KEEP_WORK_DAYS = 30;

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
    console.log("🚀 Starting scraper with WordPress REST API...");
    
    try {
        await updateStatusTime();

        console.log(`🔗 Fetching data from ${WP_API_URL}...`);
        
        const response = await axios.get(WP_API_URL, {
            params: {
                per_page: 100,
                orderby: 'date',
                order: 'desc',
                _embed: true
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            },
            timeout: 30000
        });

        console.log(`📦 Found ${response.data.length} posts`);

        if (!response.data || response.data.length === 0) {
            console.log("⚠️ API returned empty");
            process.exit(0);
        }

        const articles = response.data.map(post => {
            let source = "Unknown";
            try { 
                const urlObj = new URL(post.link); 
                source = urlObj.hostname.replace('www.', ''); 
            } catch (e) {}

            let img = null;
            if (post._embedded?.['wp:featuredmedia']?.[0]?.source_url) {
                img = post._embedded['wp:featuredmedia'][0].source_url;
            }

            const snippet = post.excerpt?.rendered 
                ? post.excerpt.rendered.replace(/<[^>]*>/g, '').substring(0, 200)
                : post.title.rendered;

            return {
                title: post.title.rendered || '',
                link: post.link || '',
                source: source,
                img: img,
                pubDate: post.date ? new Date(post.date).toISOString() : new Date().toISOString(),
                snippet: snippet
            };
        });

        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - (MAX_AGE_HOURS * 60 * 60 * 1000));
        const recentArticles = uniqueArticles.filter(article => {
            const pubDate = new Date(article.pubDate);
            return pubDate >= cutoffTime;
        });
        
        console.log(`🔎 ${uniqueArticles.length} total, ${recentArticles.length} from last ${MAX_AGE_HOURS}h.`);

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
        if (e.response) {
            console.error("Response status:", e.response.status);
            console.error("Response data:", JSON.stringify(e.response.data).substring(0, 200));
        }
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
