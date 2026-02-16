const admin = require("firebase-admin");
const { chromium } = require('playwright');

const APP_ID = 'euromix-pro-v4-wp';
const TARGET_URL = "https://www.euromix.co.il/a123/";
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
    console.log("🚀 מתחיל ריצה עם Playwright...");
    
    let browser;
    try {
        console.log("🌐 מפעיל דפדפן Chromium...");
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });
        console.log("✅ דפדפן פעיל!");
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'he-IL',
            timezoneId: 'Asia/Jerusalem',
            viewport: { width: 1920, height: 1080 }
        });
        
        const page = await context.newPage();
        await updateStatusTime();

        console.log(`🔗 טוען ${TARGET_URL}...`);
        await page.goto(TARGET_URL, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });

        console.log("⏳ ממתין לטעינה מלאה...");
        await page.waitForTimeout(15000);
        
        const title = await page.title();
        console.log("📄 כותרת העמוד:", title);
        
        // בדיקת Cloudflare
        if (title.includes("רק רגע") || title.includes("Just a moment") || title.includes("Cloudflare")) {
            console.log("⚠️ זוהה Cloudflare, ממתין 30 שניות נוספות...");
            await page.waitForTimeout(30000);
            const newTitle = await page.title();
            console.log("📄 כותרת לאחר המתנה:", newTitle);
            
            if (newTitle.includes("רק רגע") || newTitle.includes("Just a moment")) {
                console.log("❌ Cloudflare חוסם - מדלג על הריצה הזו");
                await browser.close();
                process.exit(0);
            }
        }
        
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log("📝 תוכן העמוד (200 תווים):", bodyText.substring(0, 200));
        
        console.log("✅ העמוד נטען!");

        // גלילה
        console.log("📜 מבצע גלילה...");
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
                        clearInterval(timer);
                        resolve();
                    }
                }, 50);
            });
        });
        console.log("✅ גלילה הושלמה!");

        console.log("🔍 מחלץ כתבות...");
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
                if (href.includes('euromix.co.il') || href.includes('facebook.com') || 
                    href.includes('twitter.com') || href.includes('whatsapp.com')) return;
                if (title.length < 10) return;

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
        console.log(`✅ נמצאו ${articles.length} לינקים גולמיים!`);

        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - (MAX_AGE_HOURS * 60 * 60 * 1000));
        const recentArticles = uniqueArticles.filter(article => {
            const pubDate = new Date(article.pubDate);
            return pubDate >= cutoffTime;
        });
        
        console.log(`🔎 נמצאו ${uniqueArticles.length} כולל, ${recentArticles.length} מ-${MAX_AGE_HOURS}h אחרונות.`);

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
        console.log(`📦 נבדקו ${linksToCheck.length} לינקים (${totalReads} reads), חדשות: ${newArticles.length}`);

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
        console.error("❌ שגיאה בריצה:", e.message);
        console.error("Stack:", e.stack);
        process.exit(1);
    } finally {
        if (browser) {
            console.log("🔒 סוגר דפדפן...");
            await browser.close();
        }
        setTimeout(() => process.exit(0), 2000);
    }
}

async function cleanupSmart() {
    console.log("🧹 ניקוי חכם...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');
        
        const allNew = await articlesRef.where('status', '==', 'new').get();
        console.log(`📊 ${allNew.size} כתבות new.`);
        
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
                console.log(`🗑️ נמחקו ${deleteCount} new ישנות.`);
            } else {
                console.log("✅ אין new למחיקה.");
            }
        }

        const totalCount = await articlesRef.count().get();
        console.log(`📊 סה"כ ${totalCount.data().count} כתבות.`);

        if (totalCount.data().count > 500) {
            console.log("🧹 בודק עבודה ישנות...");
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
                console.log(`🗑️ נמחקו ${workDeleteCount} עבודה >30 יום.`);
            } else {
                console.log("✅ אין עבודה ישנות.");
            }
        } else {
            console.log("✅ <500 כתבות, דילוג על ניקוי עבודה.");
        }

    } catch (error) {
        console.error("⚠️ שגיאת ניקוי:", error.message);
    }
}

async function updateStatusTime() {
    try {
        await db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('settings').doc('status')
            .set({ lastScrape: admin.firestore.Timestamp.now() }, { merge: true });
    } catch(e) {}
}

run();
