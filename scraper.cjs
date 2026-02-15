const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

// === הגדרות ===
const APP_ID = 'euromix-pro-v4-wp';
const TARGET_URL = "https://www.euromix.co.il/a123/";
const MAX_ARTICLE_AGE_HOURS = 24;      
const KEEP_NEW_LIMIT = 300;             
const KEEP_WORK_DAYS = 30;              

// --- 1. אתחול מאובטח ---
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
    console.log("🚀 מתחיל ריצה מלאה...");
    
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', 
                   '--disable-accelerated-2d-canvas', '--disable-gpu', '--single-process', '--no-zygote'] 
        });
        
        const page = await browser.newPage();
        await updateStatusTime();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 180000 });
        await aggressiveAutoScroll(page);

        // --- חילוץ כתבות (תמיכה מורחבת בזמנים) ---
        const articles = await page.evaluate(() => {
            const results = [];
            const allLinks = document.querySelectorAll('a');

            const parseRelativeTime = (text) => {
                if (!text) return new Date().toISOString();
                const now = new Date();
                const cleanText = text.toLowerCase();
                
                // תמיכה מלאה: published/לפני/ago + מספרים
                const timeMatch = cleanText.match(/(\d+)\s*(דקות?|שעות?|דק|שע|min|mins?|hour|hours?|day|days?|יום|ימים|לפני|ago|published)/i);
                if (!timeMatch) return now.toISOString();
                
                const [_, numStr] = timeMatch;
                const num = parseInt(numStr);
                
                if (cleanText.includes('דק') || cleanText.includes('min')) now.setMinutes(now.getMinutes() - num);
                else if (cleanText.includes('שע') || cleanText.includes('hour')) now.setHours(now.getHours() - num);
                else if (cleanText.includes('יום') || cleanText.includes('day')) now.setDate(now.getDate() - num);
                
                return now.toISOString();
            };

            allLinks.forEach(link => {
                const href = link.href;
                let title = link.innerText.trim();
                
                if (!href || href.length < 10) return;
                if (href.includes('euromix.co.il') || href.includes('facebook.com') || 
                    href.includes('twitter.com') || href.includes('whatsapp.com')) return;
                if (title.length < 10) return;

                // חילוץ תאריך משופר
                let dateStr = null;
                let container = link.parentElement;
                let depth = 0;
                while (container && !dateStr && depth < 5) {
                    const text = container.innerText;
                    if ((text.includes('לפני') || text.includes('ago') || text.includes('published')) && /\d/.test(text)) {
                        const lines = text.split('\n');
                        dateStr = lines.find(l => /\d/.test(l) && (l.includes('לפני') || l.includes('ago') || l.includes('published')));
                    }
                    container = container.parentElement;
                    depth++;
                }

                // חילוץ תמונה
                let img = null;
                container = link.parentElement;
                depth = 0;
                while (container && !img && depth < 4) {
                    const foundImg = container.querySelector('img');
                    if (foundImg) {
                        img = foundImg.src || foundImg.getAttribute('data-src');
                        if (img && (img.includes('icon') || img.includes('logo'))) img = null;
                    }
                    container = container.parentElement;
                    depth++;
                }

                let source = "Unknown";
                try { const urlObj = new URL(href); source = urlObj.hostname.replace('www.', ''); } catch (e) {}

                results.push({
                    title, link: href, source, img,
                    pubDate: parseRelativeTime(dateStr), snippet: title
                });
            });
            return results;
        });

        // סינון כפילויות + 24h אחרונות
        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - (MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000));
        const recentArticles = uniqueArticles.filter(article => new Date(article.pubDate) >= oneDayAgo);
        
        console.log(`🔎 נמצאו ${uniqueArticles.length} כולל, ${recentArticles.length} מ-24h אחרונות.`);

        // --- שמירה חכמה ---
        const articlesCollection = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');

        const existingDocs = await articlesCollection.select('link').get();
        const existingLinks = new Set(existingDocs.docs.map(d => d.data().link));
        const newArticles = recentArticles.filter(a => !existingLinks.has(a.link));
        
        console.log(`📦 קיימות: ${existingDocs.size}, חדשות: ${newArticles.length}`);

        if (newArticles.length > 0) {
            const batch = db.batch();
            newArticles.forEach(article => {
                const articleId = Buffer.from(article.link).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 60);
                const docRef = articlesCollection.doc(articleId);
                
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
            console.log(`💾 נשמרו ${newArticles.length} כתבות חדשות.`);
        }

        // --- ניקוי כפוי של new >48h (למרות index) ---
        console.log("🧹 ניקוי כפוי new >48h...");
        const forceCleanup = await articlesCollection.where('status', '==', 'new').get();
        const docsToDelete = [];
        forceCleanup.docs.forEach(doc => {
            const data = doc.data();
            const createdDate = data.createdAt ? data.createdAt.toDate() : new Date(0);
            const ageHours = (Date.now() - createdDate) / (3600*1000);
            if (ageHours > 48) docsToDelete.push(doc.ref);
        });

        if (docsToDelete.length > 0) {
            const batch = db.batch();
            docsToDelete.forEach(ref => batch.delete(ref));
            await batch.commit();
            console.log(`🗑️ נוקה ${docsToDelete.length} new >48h.`);
        }

        // --- ניקוי חכם ---
        await cleanupSmart();

        await updateStatusTime();
        console.log("🎉 ריצה הסתיימה בהצלחה!");

    } catch (e) {
        console.error("❌ שגיאה:", e);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        setTimeout(() => process.exit(0), 1000);
    }
}

// === ניקוי חכם ===
async function cleanupSmart() {
    console.log("🧹 ניקוי חכם...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');
        
        const now = admin.firestore.Timestamp.now();

        // עבודה >30 יום
        const oldWork = await articlesRef.where('status', '!=', 'new')
            .where('createdAt', '<', new admin.firestore.Timestamp(now.seconds - KEEP_WORK_DAYS*86400, 0))
            .limit(100).get();
        if (!oldWork.empty) {
            const batch = db.batch();
            oldWork.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            console.log(`🗑️ נמחקו ${oldWork.size} עבודה >30 יום.`);
        }

        // מגבלה על new
        const newCountSnap = await articlesRef.where('status', '==', 'new').count().get();
        if (newCountSnap.data().count > KEEP_NEW_LIMIT) {
            const excess = await articlesRef.where('status', '==', 'new')
                .orderBy('createdAt').limit(newCountSnap.data().count - KEEP_NEW_LIMIT + 10).get();
            const batch = db.batch();
            excess.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            console.log(`🗑️ נמחקו ${excess.size} new עודפות.`);
        }

    } catch (error) {
        console.error("⚠️ שגיאת ניקוי:", error.message);
        if (error.message.includes('index')) console.log("💡 צור index: status+createdAt");
    }
}

async function aggressiveAutoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            let count = 0;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                count++;
                if (count > 40 || totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer); resolve();
                }
            }, 50);
        });
    });
}

async function updateStatusTime() {
    try {
        await db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('settings').doc('status')
            .set({ lastScrape: admin.firestore.Timestamp.now() }, { merge: true });
    } catch(e) {}
}

run();
