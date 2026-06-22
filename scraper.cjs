const admin = require("firebase-admin");
const axios = require('axios');
const Parser = require('rss-parser');

const APP_ID = 'euromix-pro-v4-wp';
const MAX_AGE_HOURS = 24;           // 24 שעות ייבוא
const KEEP_WORK_DAYS = 30;          // כתבות בתהליך - 30 יום
const KEEP_NEW_HOURS = 48;          // כתבות new - 48 שעות




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
@@ -123,91 +127,155 @@

const db = initFirebase();
