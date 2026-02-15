const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

// --- 1. אתחול מאובטח (כמו במערכת החדשה) ---
// --- 1. אתחול מאובטח ---
function initFirebase() {
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountRaw) {
@@ -21,28 +21,33 @@ function initFirebase() {
}

const db = initFirebase();
const APP_ID = 'euromix-pro-v4-wp'; // משתמשים ב-ID החדש
const APP_ID = 'euromix-pro-v4-wp';
const TARGET_URL = "https://www.euromix.co.il/a123/";

// === הגדרות תצורה ===
const MAX_ARTICLE_AGE_HOURS = 24;        // כתבות חדשות רק מ-24 שעות
const MAX_NEW_ARTICLES = 500;            // מקסימום כתבות בסטטוס 'new'
const KEEP_IN_PROGRESS_DAYS = 14;        // כתבות בעבודה נשמרות 14 יום

async function run() {
    console.log("🚀 מתחיל ריצה (לוגיקה משולבת)...");
    console.log("🚀 מתחיל ריצה...");

let browser;
try {
browser = await puppeteer.launch({ 
headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--disable-gpu', '--single-process', '--no-zygote'] 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', 
                   '--disable-accelerated-2d-canvas', '--disable-gpu', '--single-process', '--no-zygote'] 
});

const page = await browser.newPage();
await updateStatusTime();

        // הגדרות דפדפן
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 180000 });
await aggressiveAutoScroll(page);

        // --- שלב החילוץ (המוח הישן והטוב) ---
        // --- חילוץ כתבות ---
const articles = await page.evaluate(() => {
const results = [];
const allLinks = document.querySelectorAll('a');
@@ -66,13 +71,11 @@ async function run() {

if (!href || href.length < 10) return;

                // *** הסינון הקריטי מהקוד הישן ***
                // מתעלם מקישורים פנימיים של האתר שלך וממדיה חברתית
                if (href.includes('euromix.co.il') || href.includes('facebook.com') || href.includes('twitter.com') || href.includes('whatsapp.com')) return;
                if (href.includes('euromix.co.il') || href.includes('facebook.com') || 
                    href.includes('twitter.com') || href.includes('whatsapp.com')) return;

if (title.length < 10) return;

                // לוגיקת חילוץ תאריך (מהקוד הישן)
let dateStr = null;
let container = link.parentElement;
let depth = 0;
@@ -86,7 +89,6 @@ async function run() {
depth++;
}

                // לוגיקת חילוץ תמונה (מהקוד הישן)
let img = null;
container = link.parentElement;
depth = 0;
@@ -111,30 +113,40 @@ async function run() {
return results;
});

        // סינון כפילויות בזיכרון
        // סינון כפילויות
const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        console.log(`🔎 נמצאו ${uniqueArticles.length} כתבות (מקורות חיצוניים בלבד).`);

        // --- שלב השמירה (השיטה החסכונית - Bulk Check) ---
        // זה מה שמונע את קריסת המכסה
        console.log("📦 בודק אילו כתבות כבר קיימות במסד...");
        const articlesCollection = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');
        console.log(`🔎 נמצאו ${uniqueArticles.length} כתבות.`);

        // שולפים רק קישורים קיימים (קריאה אחת זולה)
        const existingDocs = await articlesCollection.select('link').get();
        const existingLinks = new Set(existingDocs.docs.map(d => d.data().link));
        // --- סינון כתבות רק מ-24 שעות אחרונות ---
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - (MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000));

        // מסננים בזיכרון
        const newArticles = uniqueArticles.filter(a => !existingLinks.has(a.link));
        console.log(`✨ יש להוסיף ${newArticles.length} כתבות חדשות.`);
        const recentArticles = uniqueArticles.filter(article => {
            const articleDate = new Date(article.pubDate);
            return articleDate >= oneDayAgo;
        });
        
        console.log(`⏰ מתוכן ${uniqueArticles.length} כתבות, ${recentArticles.length} הן מ-24 שעות אחרונות.`);

        // --- שמירה ב-Firestore (ללא reads!) ---
        if (recentArticles.length > 0) {
            const articlesCollection = db.collection('artifacts').doc(APP_ID)
                .collection('public').doc('data').collection('articles');

        if (newArticles.length > 0) {
const batch = db.batch();
            let count = 0;
            let addedCount = 0;

            newArticles.forEach(article => {
                const docRef = articlesCollection.doc();
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
@@ -147,22 +159,19 @@ async function run() {
assignedTo: null,
isCustom: false,
hasCountedWriting: false
                });
                count++;
                }, { merge: true });
                
                addedCount++;
});

            // שומרים ב"מכה אחת"
await batch.commit();
            console.log(`💾 נשמרו ${count} כתבות.`);
            console.log(`💾 עודכנו/נוספו ${addedCount} כתבות.`);
} else {
            console.log("👌 אין כתבות חדשות.");
            console.log("👌 אין כתבות חדשות מ-24 שעות אחרונות.");
}

        // --- ניקוי חכם (כדי לא לצבור זבל) ---
        // מפעילים רק אם יש המון כתבות כדי לא לבזבז משאבים סתם
        if (existingDocs.size > 350) {
            await cleanupQuotaSafe();
        }
        // --- ניקוי חכם (שומר כתבות בעבודה) ---
        await cleanupOldArticles();

await updateStatusTime();
console.log("🎉 ריצה הסתיימה בהצלחה.");
@@ -176,49 +185,100 @@ async function run() {
}
}

// === פונקציית ניקוי חסכונית ===
async function cleanupQuotaSafe() {
    console.log("🧹 מבצע ניקוי...");
// === פונקציית ניקוי חכמה - שומרת כתבות בעבודה ===
async function cleanupOldArticles() {
    console.log("🧹 מתחיל ניקוי...");
try {
        const articlesRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
        // שולף רק כתבות בסטטוס 'new' (לא נוגעים בכתבות בטיפול)
        const snapshot = await articlesRef.where('status', '==', 'new').get();
        const articlesRef = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');

        if (snapshot.empty) return;

        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data(), ref: d.ref }));
        // מיון: ישן לחדש
        docs.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
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

        const batch = db.batch();
        let deleteCount = 0;
        const now = new Date();
        // 2. מחיקת כתבות בעבודה (לא 'new') מעל 14 יום
        const fourteenDaysAgo = new admin.firestore.Timestamp(
            now.seconds - (KEEP_IN_PROGRESS_DAYS * 24 * 60 * 60), 
            now.nanoseconds
        );

        // הגדרות מגבלה
        const KEEP_NEW_LIMIT = 300; 
        const MAX_DAYS = 5;
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

        docs.forEach((doc, index) => {
            let shouldDelete = false;
            const pubDate = new Date(doc.pubDate);
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

            // אם הכתבה ישנה מדי
            if ((now - pubDate) / (1000 * 60 * 60 * 24) > MAX_DAYS) shouldDelete = true;
            // אם יש יותר מדי כתבות ממתינות
            if (index >= KEEP_NEW_LIMIT) shouldDelete = true;

            if (shouldDelete) {
                batch.delete(doc.ref);
                deleteCount++;
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
        });

        if (deleteCount > 0) {
            await batch.commit();
            console.log(`🗑️ נמחקו ${deleteCount} כתבות ישנות.`);
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
