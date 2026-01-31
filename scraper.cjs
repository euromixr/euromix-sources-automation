const admin = require("firebase-admin");
const puppeteer = require("puppeteer");
// וודא שאתה מוריד את הקובץ service-account.json מהגדרות פרויקט ה-Firebase החדש
// (Project Settings -> Service accounts -> Generate new private key)
const serviceAccount = require("./service-account.json"); 

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();
const APP_ID = 'euromix-pro-v4-wp'; // אותו מזהה שהוגדר ב-App.jsx
const TARGET_URL = "https://www.euromix.co.il/a123/";

async function run() {
    console.log("🚀 מתחיל ריצה...");
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
    
    const page = await browser.newPage();
    await updateStatusTime();

    try {
        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 180000 });
        await aggressiveAutoScroll(page);

        // --- Logic to extract articles (Same as before) ---
        // (יש להשאיר כאן את הלוגיקה לחילוץ כפי שהיתה בקוד המקורי)
        // לצורך הדוגמה כאן אני משאיר ריק, אך אל תשכח להעתיק את ה-evaluate המלא מהגרסה הקודמת
        const articles = await page.evaluate(() => { return []; });
        
        // --- הפעלת הניקוי החדש (דרישה 4) ---
        await cleanupDatabaseSmart();
        
        await updateStatusTime();
        console.log("✅ סריקה וניקוי הושלמו.");

    } catch (e) {
        console.error("❌ שגיאה:", e);
    } finally {
        await browser.close();
        process.exit(0);
    }
}

// === פונקציית הניקוי החדשה והחכמה ===
async function cleanupDatabaseSmart() {
    console.log("🧹 מתחיל ניקוי חכם לפי דרישות...");
    const articlesRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
    const snapshot = await articlesRef.get();
    
    const now = new Date();
    const batch = db.batch();
    let deleteCount = 0;

    // המרה למערך נוח לעבודה
    let allDocs = snapshot.docs.map(d => ({ id: d.id, ...d.data(), ref: d.ref }));

    // 1. הגנה על כתבות "בטיפול"
    // אנחנו מסננים החוצה כתבות שהסטטוס שלהן הוא לא 'new' ולא 'archived'
    const activeDocs = allDocs.filter(d => 
        d.status !== 'new' && d.status !== 'archived' && !d.isManual
    );
    
    // כתבות מועמדות למחיקה (חדשות או ארכיון)
    let candidatesForDeletion = allDocs.filter(d => 
        d.status === 'new' || d.status === 'archived'
    );

    // מיון המועמדות למחיקה מהחדש לישן
    candidatesForDeletion.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // חוק 1: מחיקה לפי זמן (מעל 4 ימים)
    const MAX_DAYS = 4;
    const idsToDelete = new Set();

    candidatesForDeletion.forEach(doc => {
        const pubDate = new Date(doc.pubDate);
        const diffDays = (now - pubDate) / (1000 * 60 * 60 * 24);
        
        if (diffDays > MAX_DAYS) {
            idsToDelete.add(doc.id);
        }
    });

    // סנן את מה שכבר מחקנו בחוק הזמן
    let remainingCandidates = candidatesForDeletion.filter(d => !idsToDelete.has(d.id));

    // חוק 2: הגבלת כמות כוללת (300)
    const totalProjected = activeDocs.length + remainingCandidates.length;
    const LIMIT = 300;

    if (totalProjected > LIMIT) {
        // צריך למחוק עוד. כמה?
        const toDeleteCount = totalProjected - LIMIT;
        // לוקחים את הישנים ביותר מתוך המועמדות למחיקה
        const extraDeletes = remainingCandidates.slice(-toDeleteCount);
        extraDeletes.forEach(d => idsToDelete.add(d.id));
    }

    // ביצוע המחיקה
    allDocs.forEach(d => {
        if (idsToDelete.has(d.id)) {
            batch.delete(d.ref);
            deleteCount++;
        }
    });

    if (deleteCount > 0) {
        await batch.commit();
        console.log(`🗑️ נמחקו ${deleteCount} כתבות. נשארו: ${allDocs.length - deleteCount}`);
    } else {
        console.log("👍 המערכת נקייה ועומדת במגבלות.");
    }
}

async function updateStatusTime() { /* ...לוגיקה קיימת... */ }
async function aggressiveAutoScroll(page) { /* ...לוגיקה קיימת... */ }

run();