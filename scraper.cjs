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
        console.error("❌ שגיאה: FIREBASE_SERVICE_ACCOUNT חסר.");
        process.exit(1);
    }
    try {
        const serviceAccount = JSON.parse(serviceAccountRaw);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        return admin.firestore();
    } catch (error) {
        console.error("❌ שגיאה בפענוח מפתח:", error.message);
        process.exit(1);
    }
}

const db = initFirebase();

async function run() {
    console.log("🚀 מתחיל ריצה עם WordPress REST API...");
    
    try {
        await updateStatusTime();

        console.log(`🔗 מושך נתונים מ-${WP_API_URL}...`);
        
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

        console.log(`📦 נמצאו ${response.data.length} פוסטים`);

        if (!response.data || response.data.length === 0) {
            console.log("⚠️ API ריק");
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
        
        console.log(`🔎 ${uniqueArticles.length} כולל, ${recentArticles.length} מ-${MAX_AGE_HOURS}h אחרונות.`);

        const articlesCollection = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');

        const linksToCheck = recentArticles.map(a => a.link);
        const existingLinks = new Set();
        let totalReads = 0;

        console.log(`🔍 בודק ${linksToCheck.length} לינקים...`);
        for (let i = 0; i < linksToCheck.length; i += 10) {
            const batch = linksToCheck.slice(i, i + 10);
            const snapshot = await articlesCollection
                .where('link', 'in', batch)
                .select('link')
                .get();
            totalReads += snapshot.size;
            snapshot.docs.forEach(doc => existingLinks.add(doc.data().link));
        }

        const newArticles = recentArticles.filter(a => !existingLinks.has(a.link));
        console.log(`📦 נבדקו ${linksToCheck.length} (${totalReads} reads), חדשות: ${newArticles.length}`);

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
            console.log(`💾 נשמרו ${newArticles.length} כתבות.`);
        } else {
            console.log("👌 אין כתבות חדשות.");
        }

        await cleanupSmart();
        await updateStatusTime();
        console.log("🎉 ריצה הסתיימה בהצלחה!");

    } catch (e) {
        console.error("❌ שגיאה:", e.message);
        if (e.response) {
            console.error("Response status:", e.response.status);
            console.error("Response data:", JSON.stringify(e.response.data).substring(0, 200));
        }
        console.error("Stack:", e.stack);
        process.exit(1);
    }
}

async function cleanupSmart() {
    console.log("🧹 ניקוי חכם...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('article
