const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

// --- 1. אתחול מאובטח (כמו במערכת החדשה) ---
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
const APP_ID = 'euromix-pro-v4-wp'; // משתמשים ב-ID החדש
const TARGET_URL = "https://www.euromix.co.il/a123/";

async function run() {
    console.log("🚀 מתחיל ריצה (לוגיקה משולבת)...");
    
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--disable-gpu', '--single-process', '--no-zygote'] 
        });
        
        const page = await browser.newPage();
        await updateStatusTime();

        // הגדרות דפדפן
        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 180000 });
        await aggressiveAutoScroll(page);

        // --- שלב החילוץ (המוח הישן והטוב) ---
        const articles = await page.evaluate(() => {
            const results = [];
            const allLinks = document.querySelectorAll('a');

            const parseRelativeTime = (text) => {
                if (!text) return new Date().toISOString();
                const now = new Date();
                const cleanText = text.toLowerCase();
                const match = cleanText.match(/(\d+)/);
                if (!match) return now.toISOString();
                const num = parseInt(match[0]);
                if (cleanText.includes('דק') || cleanText.includes('min')) now.setMinutes(now.getMinutes() - num);
                else if (cleanText.includes('שע') || cleanText.includes('hour')) now.setHours(now.getHours() - num);
                else if (cleanText.includes('יום') || cleanText.includes('ימים') || cleanText.includes('day')) now.setDate(now.getDate() - num);
                return now.toISOString();
            };

            allLinks.forEach(link => {
                const href = link.href;
                let title = link.innerText.trim();
                
                if (!href || href.length < 10) return;
                
                // *** הסינון הקריטי מהקוד הישן ***
                // מתעלם מקישורים פנימיים של האתר שלך וממדיה חברתית
                if (href.includes('euromix.co.il') || href.includes('facebook.com') || href.includes('twitter.com') || href.includes('whatsapp.com')) return;
                
                if (title.length < 10) return;

                // לוגיקת חילוץ תאריך (מהקוד הישן)
                let dateStr = null;
                let container = link.parentElement;
                let depth = 0;
                while (container && !dateStr && depth < 3) {
                    if ((container.innerText.includes('לפני') || container.innerText.includes('ago')) && /\d/.test(container.innerText)) {
                         const lines = container.innerText.split('\n');
                         const timeLine = lines.find(l => (l.includes('לפני') || l.includes('ago')) && /\d/.test(l));
                         if (timeLine) dateStr = timeLine;
                    }
                    container = container.parentElement;
                    depth++;
                }

                // לוגיקת חילוץ תמונה (מהקוד הישן)
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
                    title: title, link: href, source: source, img: img,
                    pubDate: parseRelativeTime(dateStr), snippet: title
                });
            });
            return results;
        });

        // סינון כפילויות בזיכרון
        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        console.log(`🔎 נמצאו ${uniqueArticles.length} כתבות (מקורות חיצוניים בלבד).`);

        // --- שלב השמירה (השיטה החסכונית - Bulk Check) ---
        // זה מה שמונע את קריסת המכסה
        console.log("📦 בודק אילו כתבות כבר קיימות במסד...");
        const articlesCollection = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');

        // שולפים רק קישורים קיימים (קריאה אחת זולה)
        const existingDocs = await articlesCollection.select('link').get();
        const existingLinks = new Set(existingDocs.docs.map(d => d.data().link));
        
        // מסננים בזיכרון
        const newArticles = uniqueArticles.filter(a => !existingLinks.has(a.link));
        console.log(`✨ יש להוסיף ${newArticles.length} כתבות חדשות.`);

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
            
            // שומרים ב"מכה אחת"
            await batch.commit();
            console.log(`💾 נשמרו ${count} כתבות.`);
        } else {
            console.log("👌 אין כתבות חדשות.");
        }

        // --- ניקוי חכם (כדי לא לצבור זבל) ---
        // מפעילים רק אם יש המון כתבות כדי לא לבזבז משאבים סתם
        if (existingDocs.size > 350) {
            await cleanupQuotaSafe();
        }

        await updateStatusTime();
        console.log("🎉 ריצה הסתיימה בהצלחה.");

    } catch (e) {
        console.error("❌ שגיאה בריצה:", e);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        setTimeout(() => process.exit(0), 1000);
    }
}

// === פונקציית ניקוי חסכונית ===
async function cleanupQuotaSafe() {
    console.log("🧹 מבצע ניקוי...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
        // שולף רק כתבות בסטטוס 'new' (לא נוגעים בכתבות בטיפול)
        const snapshot = await articlesRef.where('status', '==', 'new').get();
        
        if (snapshot.empty) return;

        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data(), ref: d.ref }));
        // מיון: ישן לחדש
        docs.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        const batch = db.batch();
        let deleteCount = 0;
        const now = new Date();
        
        // הגדרות מגבלה
        const KEEP_NEW_LIMIT = 300; 
        const MAX_DAYS = 5;

        docs.forEach((doc, index) => {
            let shouldDelete = false;
            const pubDate = new Date(doc.pubDate);
            
            // אם הכתבה ישנה מדי
            if ((now - pubDate) / (1000 * 60 * 60 * 24) > MAX_DAYS) shouldDelete = true;
            // אם יש יותר מדי כתבות ממתינות
            if (index >= KEEP_NEW_LIMIT) shouldDelete = true;

            if (shouldDelete) {
                batch.delete(doc.ref);
                deleteCount++;
            }
        });

        if (deleteCount > 0) {
            await batch.commit();
            console.log(`🗑️ נמחקו ${deleteCount} כתבות ישנות.`);
        }
    } catch (error) {
        console.error("⚠️ שגיאה בניקוי:", error.message);
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
