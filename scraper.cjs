const admin = require("firebase-admin");
const axios = require('axios');
const Parser = require('rss-parser');

const APP_ID = 'euromix-pro-v4-wp';
const MAX_AGE_HOURS = 24;           // 24 שעות ייבוא
const KEEP_WORK_DAYS = 30;          // כתבות בתהליך - 30 יום
const KEEP_NEW_HOURS = 48;          // כתבות new - 48 שעות
const MAX_HYDRATE_PER_RUN = 40;     // מגבלת hydration לריצה (למנוע ריצה ארוכה מדי)
const HYDRATE_DELAY_MS = 500;       // delay בין כתבות ל-rate limiting

// הגדרות WordPress API (ייקרא מתוך Environment Variables של GitHub Actions במידה וקיים)
const WP_API_ROOT = process.env.WP_API_ROOT || "https://euro-mix.co.il/wp-json";
const EUROMIX_IMPORT_SECRET = process.env.EUROMIX_IMPORT_SECRET || "my-test-secret-123";

// Cleanup thresholds mirrored from Firestore, applied to WordPress source-items table
const WP_KEEP_NEW_HOURS = KEEP_NEW_HOURS; // status 'new' -> delete after 48h
const WP_KEEP_WORK_DAYS = KEEP_WORK_DAYS; // any other status -> delete after 30 days

// דומיינים שידועים כחוסמים / לא נותנים og:tags דרך fetch פשוט - לדלג עליהם מראש
const BLOCKED_HOSTS = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com'];

const GOOGLE_ALERT_FEEDS = [
    "https://www.google.com/alerts/feeds/15835567105207766825/5913675776665511822",
    "https://corsproxy.io/?https://www.reddit.com/r/eurovision/new.rss",
    "https://www.google.com/alerts/feeds/15835567105207766825/14323053635267839718",
    "https://www.google.com/alerts/feeds/15835567105207766825/3774609703160026695",
    "https://www.google.com/alerts/feeds/15835567105207766825/7909243822372747901",
    "https://www.google.com/alerts/feeds/15835567105207766825/3212966415973058238",
    "https://www.google.com/alerts/feeds/15835567105207766825/9865084348395279824",
    "https://www.google.com/alerts/feeds/15835567105207766825/2294528357901013805",
    "https://www.google.com/alerts/feeds/15835567105207766825/16530782648428681816",
    "https://www.google.com/alerts/feeds/15835567105207766825/2839844874789685639",
    "https://www.google.com/alerts/feeds/15835567105207766825/590056587497403967",
    "https://www.google.com/alerts/feeds/15835567105207766825/8289137387248956728",
    "https://www.google.com/alerts/feeds/15835567105207766825/7887756076627969525",
    "https://www.google.com/alerts/feeds/15835567105207766825/650055242359765947",
    "https://www.google.com/alerts/feeds/15835567105207766825/18150856224220615637",
    "https://www.google.com/alerts/feeds/15835567105207766825/590056587497404513",
    "https://www.google.com/alerts/feeds/15835567105207766825/5439785953820081518",
    "https://www.google.com/alerts/feeds/15835567105207766825/14323053635267838170",
    "https://www.google.com/alerts/feeds/15835567105207766825/16462799108050230353",
    "https://www.google.com/alerts/feeds/15835567105207766825/5229535975056204060",
    "https://www.google.com/alerts/feeds/15835567105207766825/18149203235573798037",
    "https://www.google.com/alerts/feeds/15835567105207766825/1734480943282004171",
    "https://www.google.com/alerts/feeds/15835567105207766825/7686022273118167199",
    "https://www.google.com/alerts/feeds/15835567105207766825/2511188842940626316",
    "https://www.google.com/alerts/feeds/15835567105207766825/6708471790519134431",
    "https://www.google.com/alerts/feeds/15835567105207766825/6073672349489065697",
    "https://www.google.com/alerts/feeds/15835567105207766825/15780802084620737192",
    "https://www.google.com/alerts/feeds/15835567105207766825/6665331610851128851",
    "https://www.google.com/alerts/feeds/15835567105207766825/16734694345916095083",
    "https://www.google.com/alerts/feeds/15835567105207766825/5768382838368422062",
    "https://www.google.com/alerts/feeds/15835567105207766825/15462106606358024819",
    "https://www.google.com/alerts/feeds/15835567105207766825/4939101851014900767",
    "https://www.google.com/alerts/feeds/15835567105207766825/10258311237790315460",
    "https://www.google.com/alerts/feeds/15835567105207766825/13469247121030984786",
    "https://www.google.com/alerts/feeds/15835567105207766825/7471694817148723592",
    "https://www.google.com/alerts/feeds/15835567105207766825/5521115869083766938",
    "https://www.google.com/alerts/feeds/15835567105207766825/600578587183424385",
    "https://www.google.com/alerts/feeds/15835567105207766825/6489150213567016703",
    "https://www.google.com/alerts/feeds/15835567105207766825/1180767461695683410",
    "https://www.google.com/alerts/feeds/15835567105207766825/15615812334629122465",
    "https://www.google.com/alerts/feeds/15835567105207766825/8117892362414115022",
    "https://www.google.com/alerts/feeds/15835567105207766825/17418799624831186251",
    "https://www.google.com/alerts/feeds/15835567105207766825/5615330509302177194",
    "https://www.google.com/alerts/feeds/15835567105207766825/9276029416140084921",
    "https://www.google.com/alerts/feeds/15835567105207766825/8937318266706503768",
    "https://www.google.com/alerts/feeds/15835567105207766825/836375354746867643",
    "https://www.google.com/alerts/feeds/15835567105207766825/4702931870982455282",
    "https://www.google.com/alerts/feeds/15835567105207766825/7841272026805120970",
    "https://www.google.com/alerts/feeds/15835567105207766825/5270168749846509977",
    "https://www.google.com/alerts/feeds/15835567105207766825/15423983244498170540",
    "https://www.google.com/alerts/feeds/15835567105207766825/14086237475371258259",
    "https://www.google.com/alerts/feeds/15835567105207766825/13669486295274188151",
    "https://www.google.com/alerts/feeds/15835567105207766825/13164718255631459023",
    "https://www.google.com/alerts/feeds/15835567105207766825/12504643566802910413",
    "https://www.google.com/alerts/feeds/15835567105207766825/11425745387878122567",
    "https://www.google.com/alerts/feeds/15835567105207766825/7969999045049038384",
    "https://www.google.com/alerts/feeds/15835567105207766825/17262529628428332060",
    "https://www.google.com/alerts/feeds/15835567105207766825/14407299024310346891",
    "https://www.google.com/alerts/feeds/15835567105207766825/15099035478425700531",
    "https://www.google.com/alerts/feeds/15835567105207766825/5473716720584096141",
    "https://www.google.com/alerts/feeds/15835567105207766825/1913102588284681727",
    "https://www.google.com/alerts/feeds/15835567105207766825/2150643630344992794",
    "https://www.google.com/alerts/feeds/15835567105207766825/5024685657597218016",
    "https://www.google.com/alerts/feeds/15835567105207766825/4854044355477788333",
    "https://www.google.com/alerts/feeds/15835567105207766825/15551386491322919916",
    "https://www.google.com/alerts/feeds/15835567105207766825/5825472544868778374",
    "https://www.google.com/alerts/feeds/15835567105207766825/17366842103016854853",
    "https://www.google.com/alerts/feeds/15835567105207766825/14327067969509063538",
    "https://www.google.com/alerts/feeds/15835567105207766825/13215923477997557724",
    "https://www.google.com/alerts/feeds/15835567105207766825/12663402077177438741",
    "https://www.google.com/alerts/feeds/15835567105207766825/4826808762736646782",
    "https://www.google.com/alerts/feeds/15835567105207766825/4826808762736644521",
    "https://www.google.com/alerts/feeds/15835567105207766825/7385955869198543219",
    "https://www.google.com/alerts/feeds/15835567105207766825/8866379031215318377",
    "https://www.google.com/alerts/feeds/15835567105207766825/15309312881762578228",
    "https://www.google.com/alerts/feeds/15835567105207766825/7628706936256400347",
    "https://www.google.com/alerts/feeds/15835567105207766825/960640283877058796",
    "https://www.google.com/alerts/feeds/15835567105207766825/7909243822372746376",
    "https://www.google.com/alerts/feeds/15835567105207766825/17112238031615030532",
    "https://www.google.com/alerts/feeds/15835567105207766825/15568534955257898837",
    "https://www.google.com/alerts/feeds/15835567105207766825/8021792460522158297",
    "https://www.google.com/alerts/feeds/15835567105207766825/16054439845077286272",
    "https://www.google.com/alerts/feeds/15835567105207766825/8021792460522158387",
    "https://www.google.com/alerts/feeds/15835567105207766825/12981302875322281890",
    "https://www.google.com/alerts/feeds/15835567105207766825/10474700008340530024",
    "https://www.google.com/alerts/feeds/15835567105207766825/16401508015335764264",
    "https://www.google.com/alerts/feeds/15835567105207766825/10446842549172419926",
    "https://www.google.com/alerts/feeds/15835567105207766825/3752359685739993463",
    "https://www.google.com/alerts/feeds/15835567105207766825/826679917683776817",
    "https://www.google.com/alerts/feeds/15835567105207766825/138718906201805591",
    "https://www.google.com/alerts/feeds/15835567105207766825/4171072731871609982"
];

function initFirebase() {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountRaw) {
        console.error("❌ FIREBASE_SERVICE_ACCOUNT missing.");
        process.exit(1);
    }
    try {
        const serviceAccount = JSON.parse(serviceAccountRaw);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        return admin.firestore();
    } catch (error) {
        console.error("❌ Error parsing service account:", error.message);
        process.exit(1);
    }
}

const db = initFirebase();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==========================================
// Hydration helpers: תרגום + תקציר + תמונה
// ==========================================

async function translateText(text, targetLang) {
    if (!text) return '';
    try {
        const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
            params: { client: 'gtx', sl: 'auto', tl: targetLang, dt: 't', q: text },
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
        });
        const json = res.data;
        if (Array.isArray(json) && Array.isArray(json[0])) {
            return json[0].map(part => (Array.isArray(part) ? part[0] : '')).join('').trim();
        }
    } catch (e) {
        console.warn(`⚠️ Translate(${targetLang}) failed for "${String(text).substring(0, 40)}...": ${e.message}`);
    }
    return '';
}

function isBlockedHost(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return BLOCKED_HOSTS.some(b => host.includes(b));
    } catch (e) {
        return false;
    }
}

function makeAbsoluteUrl(maybeRelative, baseUrl) {
    if (!maybeRelative) return '';
    try {
        return new URL(maybeRelative, baseUrl).href;
    } catch (e) {
        return '';
    }
}

async function fetchPageMeta(url) {
    if (isBlockedHost(url)) {
        return { img: '', description: '', title: '', ok: false };
    }
    try {
        const res = await axios.get(url, {
            timeout: 15000,
            maxContentLength: 3 * 1024 * 1024,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            validateStatus: (status) => status >= 200 && status < 300
        });
        const html = String(res.data || '');

        const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        const twImageMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
        const anyImgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        const rawImg = (ogImageMatch && ogImageMatch[1]) || (twImageMatch && twImageMatch[1]) || (anyImgMatch && anyImgMatch[1]) || '';

        const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
        const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<title>([^<]+)<\/title>/i);

        const decode = (s) => String(s || '')
            .replace(/&quot;|&#34;/g, '"')
            .replace(/&amp;|&#38;/g, '&')
            .replace(/&nbsp;|&#160;/g, ' ')
            .replace(/&#39;|&apos;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();

        return {
            img: rawImg ? makeAbsoluteUrl(rawImg, url) : '',
            description: decode(ogDescMatch && ogDescMatch[1]),
            title: decode(ogTitleMatch && ogTitleMatch[1]),
            ok: true
        };
    } catch (e) {
        console.warn(`⚠️ fetchPageMeta failed for ${url}: ${e.message}`);
        return { img: '', description: '', title: '', ok: false };
    }
}

async function hydrateArticle(article) {
    const meta = await fetchPageMeta(article.link);
    await sleep(200);

    const baseTitle = meta.title || article.title || '';
    const baseSnippet = meta.description || article.snippet || '';

    const [titleHe, titleEn, snippetHe, snippetEn] = await Promise.all([
        translateText(baseTitle, 'he'),
        translateText(baseTitle, 'en'),
        translateText(baseSnippet, 'he'),
        translateText(baseSnippet, 'en'),
    ]);

    return {
        ...article,
        title: baseTitle || article.title,
        snippet: baseSnippet || article.snippet,
        img: meta.img || article.img || '',
        titleHe: titleHe || '',
        titleEn: titleEn || '',
        snippetHe: snippetHe || '',
        snippetEn: snippetEn || '',
        translationComplete: !!((titleHe && titleEn) && (snippetHe || snippetEn)),
    };
}

async function hydrateArticlesBatch(articles) {
    const toHydrate = articles.slice(0, MAX_HYDRATE_PER_RUN);
    const rest = articles.slice(MAX_HYDRATE_PER_RUN);

    if (rest.length > 0) {
        console.log(`ℹ️ Hydrating first ${toHydrate.length} articles this run, ${rest.length} will be saved without hydration and picked up later.`);
    }

    const hydrated = [];
    for (let i = 0; i < toHydrate.length; i++) {
        const article = toHydrate[i];
        console.log(`   🌐 [${i + 1}/${toHydrate.length}] Hydrating: ${article.link.substring(0, 70)}...`);
        try {
            const h = await hydrateArticle(article);
            hydrated.push(h);
        } catch (e) {
            console.warn(`   ⚠️ Hydration failed for ${article.link}: ${e.message}`);
            hydrated.push(article);
        }
        await sleep(HYDRATE_DELAY_MS);
    }

    // כתבות שלא הגיעו ל-hydration בריצה זו - נשמרות כמו שהן (ייעברו hydration בריצה הבאה, אם תרצה להוסיף לוגיקה כזו בעתיד)
    return [...hydrated, ...rest];
}

async function run() {
    console.log("🚀 Starting scraper with Google Alerts RSS feeds...");
    console.log(`📡 Processing ${GOOGLE_ALERT_FEEDS.length} RSS feeds...`);
    console.log(`⏰ Importing articles from last ${MAX_AGE_HOURS} hours`);

    try {
        await updateStatusTime();

        const parser = new Parser({
            headers: {
                'User-Agent': 'NodeJS:euromix-scraper:v1.0 (by /u/Fluffy_Care7919)',
                'Accept': 'application/rss+xml, application/xml, text/xml'
            },
            timeout: 30000
        });

        let allArticles = [];
        let successCount = 0;
        let failCount = 0;

        for (const feedUrl of GOOGLE_ALERT_FEEDS) {
            try {
                console.log(`🔗 Fetching feed ${successCount + failCount + 1}/${GOOGLE_ALERT_FEEDS.length}...`);
                const feed = await parser.parseURL(feedUrl);

                if (feed.items && feed.items.length > 0) {
                    const articles = feed.items.map(item => {
                        let actualLink = item.link || '';
                        let source = "Unknown";

                        try {
                            // חילוץ Google redirect URL
                            if (actualLink.includes('google.com/url')) {
                                const urlObj = new URL(actualLink);
                                const realUrl = urlObj.searchParams.get('url');
                                if (realUrl) {
                                    actualLink = decodeURIComponent(realUrl);
                                }
                            }

                            // ניקוי פרמטרים מיותרים מהקישור
                            try {
                                const cleanUrl = new URL(actualLink);
                                actualLink = cleanUrl.origin + cleanUrl.pathname;
                            } catch (e) {}

                            // חילוץ מקור נקי
                            try {
                                const sourceUrl = new URL(actualLink);
                                source = sourceUrl.hostname.replace(/^(www\.)?/, '');
                            } catch (e) {}

                        } catch (e) {
                            console.error(`⚠️ URL parsing error for "${item.link?.substring(0, 100)}...": ${e.message}`);
                        }

                        const rawTitle = item.title || '';
                        const cleanTitle = typeof rawTitle === 'string'
                            ? rawTitle.replace(/<[^>]*>/g, '').trim()
                            : String(rawTitle).trim();

                        const rawSnippet = item.contentSnippet || item.title || '';
                        const cleanSnippet = typeof rawSnippet === 'string'
                            ? rawSnippet.replace(/<[^>]*>/g, '').substring(0, 200).trim()
                            : String(rawSnippet).substring(0, 200).trim();

                        return {
                            title: cleanTitle,
                            link: actualLink,
                            source: source,
                            img: item.enclosure?.url || null,
                            pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                            snippet: cleanSnippet
                        };
                    });

                    allArticles.push(...articles);
                    successCount++;
                } else {
                    successCount++;
                }
            } catch (error) {
                failCount++;
                console.error(`❌ Feed error: ${error.message}`);
            }
        }

        const uniqueArticles = Array.from(new Map(allArticles.map(item => [item.link, item])).values());
        console.log(`🔎 נמצאו ${uniqueArticles.length} כתבות חיצוניות ייחודיות.`);

        // סינון לפי שעות הייבוא המוגדרות (קבוע MAX_AGE_HOURS)
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - (MAX_AGE_HOURS * 60 * 60 * 1000));
        const recentArticles = uniqueArticles.filter(article => new Date(article.pubDate) >= cutoffTime);
        console.log(`🔎 סינון: ${recentArticles.length} כתבות ב- ${MAX_AGE_HOURS} השעות האחרונות.`);

        // ==========================================
        // מנגנון 1: בדיקת כפילויות מול Firestore
        // ==========================================
        const articlesCollection = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');
        let newArticles = [];

        if (recentArticles.length > 0) {
            const linksToCheck = recentArticles.map(a => a.link);
            const existingLinks = new Set();

            console.log(`🔍 Checking ${linksToCheck.length} links for duplicates in Firestore...`);
            for (let i = 0; i < linksToCheck.length; i += 10) {
                const batch = linksToCheck.slice(i, i + 10);
                const snapshot = await articlesCollection.where('link', 'in', batch).select('link').get();
                snapshot.docs.forEach(doc => existingLinks.add(doc.data().link));
            }

            newArticles = recentArticles.filter(a => !existingLinks.has(a.link));
            console.log(`📦 Checked ${linksToCheck.length} links in Firestore, found ${newArticles.length} new articles`);
        }

        // ==========================================
        // מנגנון 2: בדיקת כפילויות מול WordPress
        // ==========================================
        console.log("🔍 Checking duplicates against WordPress Database...");
        let wpExistingLinks = new Set();
        try {
            const wpResponse = await axios.get(`${WP_API_ROOT}/euromix/v1/get-source-items`);
            if (Array.isArray(wpResponse.data)) {
                wpResponse.data.forEach(item => {
                    if (item.link) wpExistingLinks.add(item.link);
                });
            }
        } catch (e) {
            console.warn("⚠️ WordPress read failed (CORS/Network), continuing with fallback database checks:", e.message);
        }

        const newWPArticles = recentArticles.filter(a => !wpExistingLinks.has(a.link));
        console.log(`📦 WordPress: Checked ${recentArticles.length} links, found ${newWPArticles.length} new articles.`);

        // ==========================================
        // Hydration: תרגום + תקציר + תמונה עבור כתבות חדשות
        // ==========================================
        // מאחדים את קבוצת ה-links החדשים (union בין Firestore ל-WordPress) כדי לא לבצע hydration כפול
        const allNewLinksMap = new Map();
        newArticles.forEach(a => allNewLinksMap.set(a.link, a));
        newWPArticles.forEach(a => { if (!allNewLinksMap.has(a.link)) allNewLinksMap.set(a.link, a); });
        const allNewUnique = Array.from(allNewLinksMap.values());

        let hydratedMap = new Map();
        if (allNewUnique.length > 0) {
            console.log(`🌐 Starting hydration (translate + snippet + image) for ${allNewUnique.length} unique new articles...`);
            const hydrated = await hydrateArticlesBatch(allNewUnique);
            hydrated.forEach(h => hydratedMap.set(h.link, h));
            console.log(`✅ Hydration finished for this run.`);
        } else {
            console.log("👌 No new unique articles to hydrate.");
        }

        const hydrate = (article) => hydratedMap.get(article.link) || article;

        // ==========================================
        // שמירה ל-Firestore
        // ==========================================
        if (newArticles.length > 0) {
            const batch = db.batch();
            newArticles.forEach(article => {
                const finalArticle = hydrate(article);
                const docRef = articlesCollection.doc();
                batch.set(docRef, {
                    ...finalArticle,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'new',
                    flagged: false,
                    publishedSite: false,
                    publishedSocialHe: false,
                    publishedSocialEn: false,
                    translationComplete: !!finalArticle.translationComplete,
                    assignedTo: null,
                    isCustom: false,
                    hasCountedWriting: false,
                    isDeleted: false
                });
            });
            await batch.commit();
            console.log(`💾 Saved ${newArticles.length} hydrated articles to Firestore.`);
        } else {
            console.log("👌 No new articles for Firestore.");
        }

        // ==========================================
        // שמירה ל-WordPress Custom DB Table
        // ==========================================
        if (newWPArticles.length > 0) {
            let wpSavedCount = 0;
            for (const article of newWPArticles) {
                const finalArticle = hydrate(article);
                try {
                    const res = await axios.post(`${WP_API_ROOT}/euromix/v1/import-source-item`, {
                        ...finalArticle,
                        status: 'new',
                        flagged: false,
                        publishedSite: false,
                        publishedSocialHe: false,
                        publishedSocialEn: false,
                        translationComplete: !!finalArticle.translationComplete,
                        assignedTo: null,
                        isCustom: false,
                        hasCountedWriting: false,
                        isDeleted: false
                    }, {
                        headers: {
                            'Content-Type': 'application/json',
                            'x-euromix-secret': EUROMIX_IMPORT_SECRET
                        }
                    });
                    if (res.status === 200 && res.data.ok) {
                        wpSavedCount++;
                    }
                } catch (err) {
                    console.error(`⚠️ Error saving article to WordPress (${article.link}): ${err.message}`);
                }
            }
            console.log(`💾 Saved ${wpSavedCount} hydrated articles directly to WordPress Table.`);

            // עדכון מועד הסריקה האחרון בוורדפרס
            try {
                await axios.post(`${WP_API_ROOT}/euromix/v1/update-status`, {
                    lastScrape: new Date().toISOString()
                });
            } catch (e) {}
        } else {
            console.log("👌 No new articles for WordPress Database.");
        }

        // ביצוע ניקוי חכם מקורי (Firestore)
        await cleanupSmart();

        // ביצוע ניקוי חכם על טבלת ה-WordPress
        await cleanupWordPress();

        await updateStatusTime();
        console.log("🎉 Scraper finished successfully!");

    } catch (e) {
        console.error("❌ Error in run:", e.message);
        console.error("Stack:", e.stack);
        process.exit(1);
    }
}

async function cleanupSmart() {
    console.log("🧹 Smart cleanup running...");
    try {
        const articlesCollection = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('articles');

        // 1. כתבות 'new' - מחיקה לאחר 48 שעות (קבוע KEEP_NEW_HOURS)
        const allNew = await articlesCollection.where('status', '==', 'new').get();
        console.log(`📊 ${allNew.size} articles with status 'new' checked for cleanup.`);

        if (!allNew.empty) {
            const batch = db.batch();
            let deleteCount = 0;
            const now = new Date();
            const keepNewCutoff = new Date(now.getTime() - (KEEP_NEW_HOURS * 60 * 60 * 1000));

            allNew.docs.forEach(doc => {
                const data = doc.data();
                const pubDate = data.pubDate ? new Date(data.pubDate) : new Date(0);

                if (pubDate < keepNewCutoff) {
                    batch.delete(doc.ref);
                    deleteCount++;
                }
            });

            if (deleteCount > 0) {
                await batch.commit();
                console.log(`🗑️ Deleted ${deleteCount} 'new' articles older than ${KEEP_NEW_HOURS} hours.`);
            } else {
                console.log(`✅ No 'new' articles older than ${KEEP_NEW_HOURS} hours found.`);
            }
        }

        // 2. כתבות בתהליך (לא 'new') - מחיקה לאחר 30 יום (קבוע KEEP_WORK_DAYS)
        console.log("🧹 Checking articles in process (not 'new') for cleanup...");
        const allArticles = await articlesCollection.where('status', '!=', 'new').get();
        console.log(`📊 ${allArticles.size} articles in process checked for cleanup.`);

        if (!allArticles.empty) {
            const workBatch = db.batch();
            let workDeleteCount = 0;
            const thirtyDaysAgo = new Date(Date.now() - (KEEP_WORK_DAYS * 24 * 60 * 60 * 1000));

            allArticles.docs.forEach(doc => {
                const data = doc.data();
                const createdDate = data.createdAt ? data.createdAt.toDate() : new Date(0);

                if (createdDate < thirtyDaysAgo) {
                    workBatch.delete(doc.ref);
                    workDeleteCount++;
                }
            });

            if (workDeleteCount > 0) {
                await workBatch.commit();
                console.log(`🗑️ Deleted ${workDeleteCount} articles in process older than ${KEEP_WORK_DAYS} days.`);
            } else {
                console.log(`✅ No articles in process older than ${KEEP_WORK_DAYS} days found.`);
            }
        }

        const totalCount = await articlesCollection.count().get();
        console.log(`📊 Total articles in Firestore DB: ${totalCount.data().count}`);

    } catch (error) {
        console.error("⚠️ Cleanup error:", error.message);
    }
}

async function cleanupWordPress() {
    console.log("🧹 WordPress cleanup running...");
    try {
        const res = await axios.post(`${WP_API_ROOT}/euromix/v1/cleanup-source-items`, {
            keepNewHours: WP_KEEP_NEW_HOURS,
            keepWorkDays: WP_KEEP_WORK_DAYS
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-euromix-secret': EUROMIX_IMPORT_SECRET
            }
        });
        if (res.status === 200 && res.data) {
            console.log(`🗑️ WordPress cleanup: deleted ${res.data.deletedNew || 0} 'new' items, ${res.data.deletedWork || 0} in-process items.`);
        }
    } catch (e) {
        console.warn("⚠️ WordPress cleanup failed (endpoint may be missing):", e.message);
    }
}

async function updateStatusTime() {
    try {
        const settingsRef = db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('settings').doc('status');
        await settingsRef.set({ lastScrape: admin.firestore.Timestamp.now() }, { merge: true });
    } catch (e) {
        console.error("⚠️ Failed to update Firestore last scrape time:", e.message);
    }
}

run();
