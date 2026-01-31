const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

// --- שלב 1: אתחול ---
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
        process.exit(1);
    }
}

const db = initFirebase();
const APP_ID = 'euromix-pro-v4-wp'; 
const TARGET_URL = "https://www.euromix.co.il/a123/";

async function run() {
    console.log("🚀 מתחיל ריצה...");
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote'] 
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        await updateStatusTime();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 120000 });
        await aggressiveAutoScroll(page);

        // --- חילוץ נתונים (אותו לוגיקה כמו קודם) ---
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
                if (href.includes('facebook.com') || href.includes('twitter.com') || href.includes('whatsapp.com')) return;
                if (title.length < 10) return;

                let dateStr = null;
                let container = link.parentElement;
                let depth = 0;
                while (container && !dateStr && depth < 3) {
                    if (/\d/.test(container.innerText) && (container.innerText.includes('לפני') || container.innerText.includes('ago'))) {
                         dateStr = container.innerText;
                    }
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

        // סינון כפילויות פנימי
        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        console.log(`🔎 נמצאו ${uniqueArticles.length} כתבות בדף.`);

        // --- שיפור קריטי: בדיקת קיום ב-Bulk (קריאה אחת במקום 961) ---
        console.log("📦 מושך רשימת כתבות קיימות לבדיקה מהירה...");
        const articlesCollection = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');
            
        // שולף רק את השדה 'link' כדי לחסוך בתעבורה
        const existingDocs = await articlesCollection.select('link').get();
        const existingLinks = new Set(existingDocs.docs.map(d => d.data().link));
        
        // סינון בזיכרון (מהיר וחינמי)
        const newArticles = uniqueArticles.filter(a => !existingLinks.has(a.link));
        
        console.log(`✨ מתוך ${uniqueArticles.length} כתבות, ${newArticles.length} הן חדשות.`);

        if (newArticles.length > 0) {
            const batch = db.batch();
            let count = 0;
            
            // שמירת החדשות בלבד
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
            console.log(`💾 נשמרו ${count} כתבות חדשות.`);
        } else {
            console.log("👌 אין כתבות חדשות לשמירה.");
        }

        // --- ניקוי (גם הוא עבר אופטימיזציה כדי לא לקרוא סתם) ---
        if (existingDocs.size > 350) { 
             await cleanupQuotaSafe();
        }

        await updateStatusTime();
        console.log("🎉 תהליך הסתיים.");

    } catch (e) {
        console.error("❌ שגיאה:", e);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        setTimeout(() => process.exit(0), 1000);
    }
}

async function cleanupQuotaSafe() {
    console.log("🧹 מבצע ניקוי...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
        // קורא רק כתבות בסטטוס 'new' כדי לחסוך
        const snapshot = await articlesRef.where('status', '==', 'new').get();
        if (snapshot.empty) return;

        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data(), ref: d.ref }));
        docs.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        const batch = db.batch();
        let deleteCount = 0;
        const now = new Date();
        const KEEP_NEW_LIMIT = 100; // שומר רק 100 אחרונות בסטטוס 'חדש'
        const MAX_DAYS = 4;

        docs.forEach((doc, index) => {
            let shouldDelete = false;
            const pubDate = new Date(doc.pubDate);
            if ((now - pubDate) / (1000 * 60 * 60 * 24) > MAX_DAYS) shouldDelete = true;
            if (index >= KEEP_NEW_LIMIT) shouldDelete = true;

            if (shouldDelete) {
                batch.delete(doc.ref);
                deleteCount++;
            }
        });

        if (deleteCount > 0) {
            await batch.commit();
            console.log(`🗑️ נמחקו ${deleteCount} כתבות.`);
        }
    } catch (error) { console.error("שגיאת ניקוי:", error.message); }
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
                if (count > 30 || totalHeight >= document.body.scrollHeight) { 
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
