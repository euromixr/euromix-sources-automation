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
const MAX_ARTICLE_AGE_HOURS = 24;
const MAX_NEW_ARTICLES = 1000;
const KEEP_IN_PROGRESS_DAYS = 14;
const FIRESTORE_BATCH_LIMIT = 500;

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

        // --- חילוץ כתבות - גישה חדשה עם מבנה ממוקד ---
        const articles = await page.evaluate(() => {
            const results = [];
            
            // מחפש את כל האלמנטים שמכילים "Published on"
            const publishedElements = Array.from(document.querySelectorAll('*')).filter(el => 
                el.textContent.includes('Published on') && 
                el.textContent.match(/\d+\s+(hour|hours|day|days|minute|minutes)\s+ago/i)
            );

            console.log(`Found ${publishedElements.length} elements with "Published on"`);

            publishedElements.forEach(pubElement => {
                // מחפש את הקישור הקרוב ביותר (למעלה או לצד)
                let articleContainer = pubElement.parentElement;
                let link = null;
                let depth = 0;
                
                // מחפש את הקונטיינר שמכיל גם קישור וגם תאריך
                while (articleContainer && depth < 5) {
                    link = articleContainer.querySelector('a[href]');
                    if (link && link.href && link.href.length > 10) {
                        // מצא קישור תקין
                        break;
                    }
                    articleContainer = articleContainer.parentElement;
                    depth++;
                }

                if (!link || !link.href) return;
                
                const href = link.href;
                let title = link.innerText.trim() || link.textContent.trim();
                
                // סינונים בסיסיים
                if (href.includes('euromix.co.il') || 
                    href.includes('facebook.com') || 
                    href.includes('twitter.com') || 
                    href.includes('whatsapp.com')) return;
                
                if (title.length < 10) return;

                // חילוץ התאריך מה-"Published on" element
                const publishedText = pubElement.textContent;
                const timeMatch = publishedText.match(/(\d+)\s+(hour|hours|day|days|minute|minutes)\s+ago/i);
                
                if (!timeMatch) return;
                
                const num = parseInt(timeMatch[1]);
                const unit = timeMatch[2].toLowerCase();
                
                const now = new Date();
                if (unit.startsWith('minute')) {
                    now.setMinutes(now.getMinutes() - num);
                } else if (unit.startsWith('hour')) {
                    now.setHours(now.getHours() - num);
                } else if (unit.startsWith('day')) {
                    now.setDate(now.getDate() - num);
                }
                
                const pubDate = now.toISOString();

                // חיפוש תמונה באותו קונטיינר
                let img = null;
                if (articleContainer) {
                    const foundImg = articleContainer.querySelector('img');
                    if (foundImg) {
                        img = foundImg.src || foundImg.getAttribute('data-src') || foundImg.getAttribute('srcset');
                        // מסנן אייקונים
                        if (img && (img.includes('icon') || img.includes('logo') || img.length < 20)) {
                            img = null;
                        }
                    }
                }

                // חילוץ מקור
                let source = "Unknown";
                try { 
                    const urlObj = new URL(href); 
                    source = urlObj.hostname.replace('www.', ''); 
                } catch (e) {}

                results.push({
                    title: title,
                    link: href,
                    source: source,
                    img: img,
                    pubDate: pubDate,
                    publishedText: publishedText.trim().substring(0, 50), // לדיבוג
                    snippet: title
                });
            });

            return results;
        });

        // סינון כפילויות
        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        console.log(`🔎 נמצאו ${uniqueArticles.length} כתבות ייחודיות עם תאריך.`);

        // דוגמאות לדיבוג
        if (uniqueArticles.length > 0) {
            console.log(`📝 דוגמאות (3 ראשונות):`, 
                uniqueArticles.slice(0, 3).map(a => ({
                    title: a.title.substring(0, 40),
                    published: a.publishedText
                }))
            );
        }

        // --- סינון כתבות מ-24 שעות בלבד ---
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - (MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000));
        
        const recentArticles = uniqueArticles.filter(article => {
            const articleDate = new Date(article.pubDate);
            return articleDate >= oneDayAgo && articleDate <= now;
        });
        
        console.log(`⏰ ${recentArticles.length} כתבות מ-${MAX_ARTICLE_AGE_HOURS} שעות אחרונות.`);

        // --- שמירה ב-Firestore ---
        if (recentArticles.length > 0) {
            const articlesToSave = recentArticles.slice(0, MAX_NEW_ARTICLES);
            
            if (articlesToSave.length < recentArticles.length) {
                console.log(`⚠️ מגביל ל-${MAX_NEW_ARTICLES} כתבות.`);
            }
            
            await saveToBatches(articlesToSave);
        } else {
            console.log("👌 אין כתבות חדשות לשמירה.");
        }

        // --- ניקוי ---
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

// === שמירה ב-batches ===
async function saveToBatches(articles) {
    const articlesCollection = db.collection('artifacts').doc(APP_ID)
        .collection('public').doc('data').collection('articles');

    let totalSaved = 0;
    
    for (let i = 0; i < articles.length; i += FIRESTORE_BATCH_LIMIT) {
        const chunk = articles.slice(i, i + FIRESTORE_BATCH_LIMIT);
        const batch = db.batch();
        
        chunk.forEach(article => {
            const articleId = Buffer.from(article.link)
                .toString('base64')
                .replace(/[^a-zA-Z0-9]/g, '')
                .substring(0, 60);
            
            const docRef = articlesCollection.doc(articleId);
            
            // מסירים publishedText לפני שמירה
            const { publishedText, ...articleData } = article;
            
            batch.set(docRef, {
                ...articleData,
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
        totalSaved += chunk.length;
        console.log(`💾 נשמרו ${chunk.length} כתבות (סה"כ ${totalSaved}/${articles.length})`);
        
        if (i + FIRESTORE_BATCH_LIMIT < articles.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    console.log(`✅ סה"כ נשמרו ${totalSaved} כתבות.`);
}

// === ניקוי ===
async function cleanupOldArticles() {
    console.log("🧹 מתחיל ניקוי...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID)
            .collection('public').doc('data').collection('articles');
        
        const now = admin.firestore.Timestamp.now();
        
        // 1. מחיקת 'new' מעל 24 שעות
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
            await deleteInBatches(oldNewArticles.docs);
            console.log(`🗑️ נמחקו ${oldNewArticles.size} כתבות 'new' ישנות.`);
        }

        // 2. מחיקת כתבות בעבודה מעל 14 יום
        const fourteenDaysAgo = new admin.firestore.Timestamp(
            now.seconds - (KEEP_IN_PROGRESS_DAYS * 24 * 60 * 60), 
            now.nanoseconds
        );
        
        const oldInProgressArticles = await articlesRef
            .where('status', '!=', 'new')
            .where('createdAt', '<', fourteenDaysAgo)
            .limit(100)
            .get();
        
        if (!oldInProgressArticles.empty) {
            await deleteInBatches(oldInProgressArticles.docs);
            console.log(`🗑️ נמחקו ${oldInProgressArticles.size} כתבות בעבודה ישנות.`);
        }

        // 3. בדיקת מכסה
        const newArticlesSnapshot = await articlesRef
            .where('status', '==', 'new')
            .count()
            .get();
        
        const totalNewArticles = newArticlesSnapshot.data().count;
        console.log(`📊 סה"כ כתבות 'new': ${totalNewArticles}`);
        
    } catch (error) {
        console.error("⚠️ שגיאה בניקוי:", error.message);
    }
}

async function deleteInBatches(docs) {
    for (let i = 0; i < docs.length; i += FIRESTORE_BATCH_LIMIT) {
        const chunk = docs.slice(i, i + FIRESTORE_BATCH_LIMIT);
        const batch = db.batch();
        chunk.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        
        if (i + FIRESTORE_BATCH_LIMIT < docs.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
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
