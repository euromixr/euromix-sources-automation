const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

// --- 1. אתחול מאובטח ---
function initFirebase() {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountRaw) {
        console.error("❌ FIREBASE_SERVICE_ACCOUNT missing.");
        process.exit(1);
    }
    const serviceAccount = JSON.parse(serviceAccountRaw);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return admin.firestore();
}

const db = initFirebase();
const APP_ID = 'euromix-pro-v4-wp'; 
const TARGET_URL = "https://www.euromix.co.il/a123/";

async function run() {
    console.log("🚀 Starting Firebase Scraper (Optimized)...");
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'] 
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 120000 });
        await aggressiveAutoScroll(page);
        
        // --- חילוץ נתונים ---
        const articles = await page.evaluate(() => {
            const results = [];
            const allLinks = document.querySelectorAll('a');
            
            const parseRelativeTime = (text) => {
                if (!text) return new Date().toISOString();
                const now = new Date();
                const match = text.toLowerCase().match(/(\d+)/);
                if (!match) return now.toISOString();
                const num = parseInt(match[0]);
                const clean = text.toLowerCase();
                if (clean.includes('דק') || clean.includes('min')) now.setMinutes(now.getMinutes() - num);
                else if (clean.includes('שע') || clean.includes('hour')) now.setHours(now.getHours() - num);
                else if (clean.includes('יום') || clean.includes('day')) now.setDate(now.getDate() - num);
                return now.toISOString();
            };

            allLinks.forEach(link => {
                const href = link.href;
                let title = link.innerText.trim();
                if (!href || href.length < 10) return;
                
                // --- סינון אתרים (כולל האתר שלך) ---
                if (href.includes('euromix.co.il') || href.includes('facebook.com') || href.includes('twitter.com') || href.includes('whatsapp.com')) return;
                
                if (title.length < 10) return;

                // Simple date finder
                let dateStr = null;
                let container = link.parentElement;
                let depth = 0;
                while (container && !dateStr && depth < 3) {
                    if (/\d/.test(container.innerText) && (container.innerText.includes('לפני') || container.innerText.includes('ago'))) dateStr = container.innerText;
                    container = container.parentElement;
                    depth++;
                }

                let img = null;
                container = link.parentElement;
                depth = 0;
                while (container && !img && depth < 4) {
                    const foundImg = container.querySelector('img');
                    if (foundImg) img = foundImg.src || foundImg.getAttribute('data-src');
                    container = container.parentElement;
                    depth++;
                }

                let source = "Unknown";
                try { const urlObj = new URL(href); source = urlObj.hostname.replace('www.', ''); } catch (e) {}

                results.push({
                    title: title, link: href, source: source, img: img,
                    pubDate: parseRelativeTime(dateStr), snippet: title
                });
            });
            return results;
        });

        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        console.log(`🔎 Found ${uniqueArticles.length} articles.`);

        // --- Bulk Check (1 Read Operation) ---
        console.log("📦 Bulk checking existing links...");
        const articlesCollection = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
        const existingDocs = await articlesCollection.select('link').get();
        const existingLinks = new Set(existingDocs.docs.map(d => d.data().link));
        
        const newArticles = uniqueArticles.filter(a => !existingLinks.has(a.link));
        console.log(`✨ New articles to add: ${newArticles.length}`);

        if (newArticles.length > 0) {
            const batch = db.batch();
            let count = 0;
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
                count++;
            });
            await batch.commit();
            console.log(`💾 Saved ${count} new articles.`);
        }

        // --- Cleanup (Only run if too big) ---
        if (existingDocs.size > 350) {
            console.log("🧹 Cleaning up old articles...");
            const snapshot = await articlesCollection.where('status', '==', 'new').get();
            const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data(), ref: d.ref }));
            docs.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
            
            const batch = db.batch();
            let deleted = 0;
            const KEEP_LIMIT = 300;
            
            docs.forEach((doc, idx) => {
                if (idx >= KEEP_LIMIT) { 
                    batch.delete(doc.ref);
                    deleted++;
                }
            });
            if (deleted > 0) await batch.commit();
            console.log(`🗑️ Deleted ${deleted} old articles.`);
        }

        await db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('settings').doc('status')
            .set({ lastScrape: admin.firestore.Timestamp.now() }, { merge: true });

        console.log("🎉 Done.");

    } catch (e) {
        console.error("❌ Error:", e);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        setTimeout(() => process.exit(0), 1000);
    }
}
run();
