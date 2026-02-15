const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

function initFirebase() {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountRaw) {
        console.error("❌ FIREBASE_SERVICE_ACCOUNT missing");
        process.exit(1);
    }
    try {
        const serviceAccount = JSON.parse(serviceAccountRaw);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        return admin.firestore();
    } catch (error) {
        console.error("❌ Error parsing key:", error.message);
        process.exit(1);
    }
}

const db = initFirebase();
const APP_ID = 'euromix-pro-v4-wp';
const TARGET_URL = "https://www.euromix.co.il/a123/";
const MAX_ARTICLE_AGE_HOURS = 24;
const MAX_NEW_ARTICLES = 500;
const KEEP_IN_PROGRESS_DAYS = 14;
const FIRESTORE_BATCH_LIMIT = 500;

async function run() {
    console.log("🔥 NEW VERSION RUNNING!");
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--disable-gpu', '--single-process', '--no-zygote'] 
        });
        
        const page = await browser.newPage();
        await updateStatusTime();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 180000 });
        await aggressiveAutoScroll(page);

        const articles = await page.evaluate(() => {
            const results = [];
            const publishedElements = Array.from(document.querySelectorAll('*')).filter(el => 
                el.textContent.includes('Published on') && 
                el.textContent.match(/\d+\s+(hour|hours|day|days|minute|minutes)\s+ago/i)
            );

            publishedElements.forEach(pubElement => {
                let articleContainer = pubElement.parentElement;
                let link = null;
                let depth = 0;
                
                while (articleContainer && depth < 5) {
                    link = articleContainer.querySelector('a[href]');
                    if (link && link.href && link.href.length > 10) break;
                    articleContainer = articleContainer.parentElement;
                    depth++;
                }

                if (!link || !link.href) return;
                
                const href = link.href;
                let title = link.innerText.trim() || link.textContent.trim();
                
                if (href.includes('euromix.co.il') || href.includes('facebook.com') || 
                    href.includes('twitter.com') || href.includes('whatsapp.com')) return;
                if (title.length < 10) return;

                const publishedText = pubElement.textContent;
                const timeMatch = publishedText.match(/(\d+)\s+(hour|hours|day|days|minute|minutes)\s+ago/i);
                if (!timeMatch) return;
                
                const num = parseInt(timeMatch[1]);
                const unit = timeMatch[2].toLowerCase();
                const now = new Date();
                
                if (unit.startsWith('minute')) now.setMinutes(now.getMinutes() - num);
                else if (unit.startsWith('hour')) now.setHours(now.getHours() - num);
                else if (unit.startsWith('day')) now.setDate(now.getDate() - num);
                
                const pubDate = now.toISOString();

                let img = null;
                if (articleContainer) {
                    const foundImg = articleContainer.querySelector('img');
                    if (foundImg) {
                        img = foundImg.src || foundImg.getAttribute('data-src') || foundImg.getAttribute('srcset');
                        if (img && (img.includes('icon') || img.includes('logo') || img.length < 20)) img = null;
                    }
                }

                let source = "Unknown";
                try { 
                    const urlObj = new URL(href); 
                    source = urlObj.hostname.replace('www.', ''); 
                } catch (e) {}

                results.push({
                    title: title, link: href, source: source, img: img,
                    pubDate: pubDate, snippet: title
                });
            });

            return results;
        });

        const uniqueArticles = Array.from(new Map(articles.map(item => [item.link, item])).values());
        console.log(`Found ${uniqueArticles.length} unique articles with dates`);

        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - (MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000));
        const recentArticles = uniqueArticles.filter(article => {
            const articleDate = new Date(article.pubDate);
            return articleDate >= oneDayAgo && articleDate <= now;
        });
        
        console.log(`${recentArticles.length} articles from last 24 hours`);

        if (recentArticles.length > 0) {
            const articlesToSave = recentArticles.slice(0, MAX_NEW_ARTICLES);
            await saveToBatches(articlesToSave);
        } else {
            console.log("No new articles to save");
        }

        await cleanupOldArticles();
        await updateStatusTime();
        console.log("Done!");

    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        setTimeout(() => process.exit(0), 1000);
    }
}

async function saveToBatches(articles) {
    const articlesCollection = db.collection('artifacts').doc(APP_ID)
        .collection('public').doc('data').collection('articles');
    let totalSaved = 0;
    
    for (let i = 0; i < articles.length; i += FIRESTORE_BATCH_LIMIT) {
        const chunk = articles.slice(i, i + FIRESTORE_BATCH_LIMIT);
        const batch = db.batch();
        
        chunk.forEach(article => {
            const articleId = Buffer.from(article.link).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 60);
            const docRef = articlesCollection.doc(articleId);
            
            batch.set(docRef, {
                ...article,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                status: 'new', flagged: false, publishedSite: false,
                publishedSocialHe: false, publishedSocialEn: false,
                translationComplete: false, assignedTo: null,
                isCustom: false, hasCountedWriting: false
            }, { merge: true });
        });
        
        await batch.commit();
        totalSaved += chunk.length;
        console.log(`Saved ${chunk.length} (total: ${totalSaved}/${articles.length})`);
        
        if (i + FIRESTORE_BATCH_LIMIT < articles.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    console.log(`Total saved: ${totalSaved}`);
}

async function cleanupOldArticles() {
    console.log("Cleaning up...");
    try {
        const articlesRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
        const now = admin.firestore.Timestamp.now();
        
        const oneDayAgo = new admin.firestore.Timestamp(now.seconds - (MAX_ARTICLE_AGE_HOURS * 60 * 60), now.nanoseconds);
        const oldNewArticles = await articlesRef.where('status', '==', 'new').where('createdAt', '<', oneDayAgo).limit(200).get();
        
        if (!oldNewArticles.empty) {
            await deleteInBatches(oldNewArticles.docs);
            console.log(`Deleted ${oldNewArticles.size} old 'new' articles`);
        }

        const fourteenDaysAgo = new admin.firestore.Timestamp(now.seconds - (KEEP_IN_PROGRESS_DAYS * 24 * 60 * 60), now.nanoseconds);
        const oldInProgressArticles = await articlesRef.where('status', '!=', 'new').where('createdAt', '<', fourteenDaysAgo).limit(100).get();
        
        if (!oldInProgressArticles.empty) {
            await deleteInBatches(oldInProgressArticles.docs);
            console.log(`Deleted ${oldInProgressArticles.size} old in-progress articles`);
        }

        const newArticlesSnapshot = await articlesRef.where('status', '==', 'new').count().get();
        const totalNewArticles = newArticlesSnapshot.data().count;
        console.log(`Total 'new' articles: ${totalNewArticles}`);
        
    } catch (error) {
        console.error("Cleanup error:", error.message);
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
            let distance = 100;
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
}

async function updateStatusTime() {
    try {
        await db.collection('artifacts').doc(APP_ID).collection('public').doc('data')
            .collection('settings').doc('status')
            .set({ lastScrape: admin.firestore.Timestamp.now() }, { merge: true });
    } catch(e) {
        console.error("Status update error:", e.message);
    }
}

run();

        await db.collection('artifacts').doc(APP_ID).collection('public').doc('data')
            .collection('settings').doc('status')
            .set({ lastScrape: admin.firestore.Timestamp.now() }, { merge: true });
    } catch(e) {
        console.error("Status update error:", e.message);
    }
}

run();
