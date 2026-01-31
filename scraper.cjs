const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

// --- שלב 1: טעינת הגדרות Firebase בצורה מאובטחת ---
function initFirebase() {
    console.log("🔑 מנסה לטעון את מפתח Firebase...");
    
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    
    if (!serviceAccountRaw) {
        console.error("❌ שגיאה קריטית: משתנה הסביבה FIREBASE_SERVICE_ACCOUNT חסר!");
        console.error("נא לוודא שהוספת את הסוד ב-Settings -> Secrets -> Actions בגיטהאב.");
        process.exit(1);
    }

    try {
        const serviceAccount = JSON.parse(serviceAccountRaw);
        
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        console.log("✅ חיבור ל-Firebase הצליח.");
        return admin.firestore();
    } catch (error) {
        console.error("❌ שגיאה בפענוח ה-JSON של המפתח:", error.message);
        console.error("ודא שהעתקת את כל תוכן הקובץ service-account.json כולל הסוגריים המסולסלים {} להתחלה ולסוף.");
        process.exit(1);
    }
}

const db = initFirebase();
const APP_ID = 'euromix-pro-v4-wp'; // וודא שזה תואם ל-App.jsx
const TARGET_URL = "https://www.euromix.co.il/a123/";

// --- שלב 2: פונקציית הסריקה ---
async function run() {
    console.log("🚀 מתחיל ריצה...");
    
    let browser;
    try {
        console.log("🌐 מפעיל דפדפן (Puppeteer)...");
        browser = await puppeteer.launch({ 
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ] 
        });
        
        const page = await browser.newPage();
        
        // הגדרת User Agent כדי לא להיחסם
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        await updateStatusTime();

        console.log(`🔗 ניגש לכתובת: ${TARGET_URL}`);
        await page.setViewport({ width: 1920, height: 1080 });
        
        // הגדלת זמן המתנה ל-3 דקות למקרה שהאתר איטי
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 180000 });
        
        console.log("📜 גולל למטה לטעינת תוכן...");
        await aggressiveAutoScroll(page);

        // --- חילוץ המידע ---
        console.log("mag searching for articles...");
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
                // סינון קישורים פנימיים ורשתות חברתיות
                if (href.includes('euromix.co.il') || href.includes('facebook.com') || href.includes('twitter.com') || href.includes('whatsapp.com')) return;
                if (title.length < 10) return;

                // חיפוש תאריך
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

                // חיפוש תמונה
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
        
        console.log(`✅ נמצאו ${articles.length} כתבות פוטנציאליות.`);

        // סינון כפילויות בתוך הריצה הנוכחית
        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        
        console.log(`💾 שומר ${uniqueArticles.length} כתבות ייחודיות ל-Firebase...`);
        const batch = db.batch();
        let operationCount = 0;
        let savedCount = 0;

        for (const article of uniqueArticles) {
            // בדיקה אם הכתבה כבר קיימת כדי לא לדרוס סטטוסים
            const exists = await db.collection('artifacts').doc(APP_ID)
                .collection('public').doc('data').collection('articles')
                .where('link', '==', article.link).limit(1).get();

            if (!exists.empty) continue;

            const docRef = db.collection('artifacts').doc(APP_ID)
                .collection('public').doc('data').collection('articles').doc();

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
            
            savedCount++;
            operationCount++;
            if (operationCount >= 450) { await batch.commit(); operationCount = 0; }
        }

        if (operationCount > 0) await batch.commit();
        console.log(`✨ ${savedCount} כתבות חדשות נשמרו.`);
        
        // --- ניקוי מסד נתונים ---
        await cleanupDatabaseSmart();
        
        await updateStatusTime();
        console.log("🎉 התהליך הסתיים בהצלחה.");

    } catch (e) {
        console.error("❌ שגיאה כללית במהלך הריצה:", e);
        process.exit(1); // יציאה עם שגיאה כדי שגיטהאב יסמן באדום
    } finally {
        if (browser) {
            await browser.close();
        }
        // Force exit to ensure script doesn't hang
        setTimeout(() => process.exit(0), 1000);
    }
}

// === פונקציית הניקוי החדשה והחכמה ===
async function cleanupDatabaseSmart() {
    console.log("🧹 מתחיל ניקוי חכם...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
        const snapshot = await articlesRef.get();
        
        if (snapshot.empty) {
            console.log("📭 אין כתבות במסד הנתונים.");
            return;
        }

        const now = new Date();
        const batch = db.batch();
        let deleteCount = 0;

        let allDocs = snapshot.docs.map(d => ({ id: d.id, ...d.data(), ref: d.ref }));

        // שמירת כתבות בטיפול
        const activeDocs = allDocs.filter(d => 
            d.status !== 'new' && d.status !== 'archived' && !d.isManual
        );
        
        // מועמדות למחיקה
        let candidatesForDeletion = allDocs.filter(d => 
            d.status === 'new' || d.status === 'archived'
        );

        candidatesForDeletion.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        const MAX_DAYS = 4;
        const idsToDelete = new Set();

        candidatesForDeletion.forEach(doc => {
            const pubDate = new Date(doc.pubDate);
            const diffDays = (now - pubDate) / (1000 * 60 * 60 * 24);
            if (diffDays > MAX_DAYS) {
                idsToDelete.add(doc.id);
            }
        });

        let remainingCandidates = candidatesForDeletion.filter(d => !idsToDelete.has(d.id));
        const totalProjected = activeDocs.length + remainingCandidates.length;
        const LIMIT = 300;

        if (totalProjected > LIMIT) {
            const toDeleteCount = totalProjected - LIMIT;
            const extraDeletes = remainingCandidates.slice(-toDeleteCount);
            extraDeletes.forEach(d => idsToDelete.add(d.id));
        }

        allDocs.forEach(d => {
            if (idsToDelete.has(d.id)) {
                batch.delete(d.ref);
                deleteCount++;
            }
        });

        if (deleteCount > 0) {
            await batch.commit();
            console.log(`🗑️ נמחקו ${deleteCount} כתבות.`);
        } else {
            console.log("👍 המערכת נקייה.");
        }
    } catch (error) {
        console.error("⚠️ שגיאה במהלך הניקוי (לא קריטי):", error.message);
    }
}

async function aggressiveAutoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            let noChangeCount = 0;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight) {
                    noChangeCount++;
                    if (noChangeCount > 40) { clearInterval(timer); resolve(); }
                } else { noChangeCount = 0; }
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
