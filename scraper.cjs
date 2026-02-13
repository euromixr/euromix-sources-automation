const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

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
const APP_ID = 'euromix-pro-v4-wp';
const TARGET_URL = "https://www.euromix.co.il/a123/";

// === הגדרות תצורה ===
const MAX_ARTICLE_AGE_HOURS = 24;        // כתבות חדשות רק מ-24 שעות
const MAX_NEW_ARTICLES = 500;            // מקסימום כתבות בסטטוס 'new'
const KEEP_IN_PROGRESS_DAYS = 14;        // כתבות בעבודה נשמרות 14 יום

async function run() {
    console.log("🚀 מתחיל ריצה...");
    
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

        // --- חילוץ כתבות ---
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
                    title: title, link: href, source: source, img: img,
                    pubDate: parseRelativeTime(dateStr), snippet: title
                });
            });
            return results;
        });

        // סינון כפילויות
        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        console.log(`🔎 נמצאו ${uniqueArticles.length} כתבות.`);

        // --- סינון כתבות רק מ-24 שעות אחרונות ---
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - (MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000));
        
        const recentArticles = uniqueArticles.filter(article => {
            const articleDate = new Date(article.pubDate);
            return articleDate >= oneDayAgo;
        });
        
        console.log(`⏰ מתוכן ${uniqueArticles.length} כתבות, ${recentArticles.length} הן מ-24 שעות אחרונות.`);

        // --- שמירה ב-Firestore (ללא reads!) ---
        if (recentArticles.length > 0) {
            const articlesCollection = db.collection('artifacts').doc(APP_ID)
                .collection('public').doc('data').collection('articles');

            const batch = db.batch();
            let addedCount = 0;
            
            recentArticles.forEach(article => {
                // יצירת ID ייחודי מהקישור (דטרמיניסטי)
                const articleId = Buffer.from(article.link)
                    .toString('base64')
                    .replace(/[^a-zA-Z0-9]/g, '')
                    .substring(0, 60);
                
                const docRef = articlesCollection.doc(articleId);
                
                // merge: true לא דורש read - רק מוסיף שדות חדשים אם לא קיימים
                // אם הכתבה כבר קיימת עם סטטוס אחר, היא לא תשתנה
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
                
                addedCount++;
            });
            
            await batch.commit();
            console.log(`💾 עודכנו/נוספו ${addedCount} כתבות.`);
        } else {
            console.log("👌 אין כתבות חדשות מ-24 שעות אחרונות.");
        }

        // --- ניקוי חכם (שומר כתבות בעבודה) ---
        await cleanupOldArticles();

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

// === פונקציית ניקוי חכמה - שומרת כתבות בעבודה ===
async function cleanupOldArticles() {
    console.log("🧹 מתחיל ניקוי...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');
        
        const now = admin.firestore.Timestamp.now();
        
        // 1. מחיקת כתבות 'new' מעל 24 שעות
        const oneDayAgo = new admin.firestore.Timestamp(
            now.seconds - (MAX_ARTICLE_AGE_HOURS * 60 * 60), 
            now.nanoseconds
        );
        
        const oldNewArticles = await articlesRef
            .where('status', '==', 'new')
            .where('createdAt', '<', oneDayAgo)
            .limit(200)
            .get();
        
        if (!oldNewArticles.empty) {
            const batch1 = db.batch();
            oldNewArticles.docs.forEach(doc => batch1.delete(doc.ref));
            await batch1.commit();
            console.log(`🗑️ נמחקו ${oldNewArticles.size} כתבות 'new' ישנות (מעל 24 שעות).`);
        }

        // 2. מחיקת כתבות בעבודה (לא 'new') מעל 14 יום
        const fourteenDaysAgo = new admin.firestore.Timestamp(
            now.seconds - (KEEP_IN_PROGRESS_DAYS * 24 * 60 * 60), 
            now.nanoseconds
        );
        
        // שולף כתבות ישנות שאינן בסטטוס 'new'
        const oldInProgressArticles = await articlesRef
            .where('status', '!=', 'new')
            .where('createdAt', '<', fourteenDaysAgo)
            .limit(100)
            .get();
        
        if (!oldInProgressArticles.empty) {
            const batch2 = db.batch();
            oldInProgressArticles.docs.forEach(doc => batch2.delete(doc.ref));
            await batch2.commit();
            console.log(`🗑️ נמחקו ${oldInProgressArticles.size} כתבות בעבודה ישנות (מעל 14 יום).`);
        }

        // 3. בדיקה ושמירה על מקסימום כתבות 'new'
        const newArticlesSnapshot = await articlesRef
            .where('status', '==', 'new')
            .count()
            .get();
        
        const totalNewArticles = newArticlesSnapshot.data().count;
        console.log(`📊 סה"כ כתבות 'new' במערכת: ${totalNewArticles}`);
        
        if (totalNewArticles > MAX_NEW_ARTICLES) {
            const excess = totalNewArticles - MAX_NEW_ARTICLES;
            console.log(`⚠️ יש ${excess} כתבות 'new' מעבר למכסה. מוחק את הישנות ביותר...`);
            
            // שולף את הכתבות הישנות ביותר בסטטוס 'new'
            const oldestNewArticles = await articlesRef
                .where('status', '==', 'new')
                .orderBy('createdAt', 'asc')
                .limit(excess + 50)
                .get();
            
            if (!oldestNewArticles.empty) {
                const batch3 = db.batch();
                oldestNewArticles.docs.forEach(doc => batch3.delete(doc.ref));
                await batch3.commit();
                console.log(`🗑️ נמחקו ${oldestNewArticles.size} כתבות 'new' ישנות נוספות.`);
            }
        } else {
            console.log(`✅ מספר כתבות 'new' תקין (${totalNewArticles}/${MAX_NEW_ARTICLES}).`);
        }

        // 4. סטטיסטיקה כללית
        const inProgressSnapshot = await articlesRef
            .where('status', '!=', 'new')
            .count()
            .get();
        const totalInProgress = inProgressSnapshot.data().count;
        console.log(`📊 סה"כ כתבות בעבודה במערכת: ${totalInProgress}`);
        
    } catch (error) {
        console.error("⚠️ שגיאה בניקוי:", error.message);
        if (error.message.includes('index')) {
            console.log("💡 צריך ליצור composite index ב-Firestore.");
            console.log("פתח את הלינק שמופיע בשגיאה או צור ידנית:");
            console.log("- Collection: articles");
            console.log("- Fields: status (Ascending) + createdAt (Ascending)");
        }
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
