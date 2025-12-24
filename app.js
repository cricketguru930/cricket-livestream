import express from 'express';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import tough from 'tough-cookie';
import * as cheerio from 'cheerio';
import morgan from 'morgan';
import { LRUCache } from 'lru-cache';
import { URL } from 'url';

/* ================== APP ================== */
const app = express();

/* ================== CONFIG ================== */
const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;
const STREAM_TTL_SEC = Number(process.env.STREAM_TTL_SEC || 600);

const UA =
    process.env.UA ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143 Safari/537.36';

const THIRD_PARTY_ROOT_REFERER = 'https://app.livetvapi.com/';
const THIRD_PARTY_ORIGIN = 'https://app.livetvapi.com';

/* ================== MIDDLEWARE ================== */
app.use(morgan('dev'));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

/* ================== EVENT META CACHE ================== */
const metaCache = new LRUCache({
    max: 200,
    ttl: STREAM_TTL_SEC * 1000
});

/* ================== SEGMENT + PLAYLIST CACHE ================== */
const cache = new Map();           // url -> { data, headers, expiresAt }
const inFlight = new Map();        // url -> Promise

const SEGMENT_TTL_MS = 12_000;
const PLAYLIST_TTL_MS = 2_500;
const MAX_CACHE_ITEMS = 1500;

/* ================== HELPERS ================== */
const now = () => Date.now();

function evictIfNeeded() {
    if (cache.size <= MAX_CACHE_ITEMS) return;
    const first = cache.keys().next().value;
    cache.delete(first);
}

function getCached(url) {
    const e = cache.get(url);
    if (!e) return null;
    if (e.expiresAt <= now()) {
        cache.delete(url);
        return null;
    }
    return e;
}

function setCached(url, entry) {
    cache.set(url, entry);
    evictIfNeeded();
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

/* ================== AXIOS ================== */
function newJar() {
    return new tough.CookieJar();
}

function newClient(jar) {
    return wrapper(
        axios.create({
            jar,
            withCredentials: true,
            timeout: 15000,
            validateStatus: () => true
        })
    );
}

function headers() {
    return {
        'User-Agent': UA,
        Referer: THIRD_PARTY_ROOT_REFERER,
        Origin: THIRD_PARTY_ORIGIN,
        Accept: '*/*'
    };
}

/* ================== SHARED FETCH ================== */
async function fetchShared(url, jar, isText) {
    const cached = getCached(url);
    if (cached) return cached;

    if (inFlight.has(url)) return inFlight.get(url);

    const p = (async () => {
        try {
            const client = newClient(jar);
            const res = await client.get(url, {
                headers: headers(),
                responseType: isText ? 'text' : 'stream'
            });

            if (res.status !== 200) throw new Error(`Upstream ${res.status}`);

            const data = isText
                ? typeof res.data === 'string'
                    ? res.data
                    : (await streamToBuffer(res.data)).toString('utf8')
                : await streamToBuffer(res.data);

            const ttl = isText ? PLAYLIST_TTL_MS : SEGMENT_TTL_MS;

            const entry = {
                data,
                headers: res.headers,
                expiresAt: now() + ttl
            };

            setCached(url, entry);
            return entry;
        } finally {
            inFlight.delete(url);
        }
    })();

    inFlight.set(url, p);
    return p;
}

/* ================== PREPARE ================== */
async function prepareEvent(eventId) {
    const jar = newJar();
    const client = newClient(jar);

    const startUrl = `https://app.livetvapi.com/event-play-2/${eventId}`;
    const res = await client.get(startUrl, { headers: headers() });

    if (res.status !== 200) throw new Error('prepare failed');

    const $ = cheerio.load(res.data);
    let streamUrl = $('input#stream-link').attr('value');

    if (!streamUrl) {
        const m = res.data.match(/https?:\/\/[^\s'"]+\.m3u8/);
        if (m) streamUrl = m[0];
    }

    if (!streamUrl) throw new Error('no stream url');

    const finalUrl = new URL(streamUrl, startUrl).href;

    metaCache.set(eventId, {
        streamUrl: finalUrl,
        cookies: await jar.getCookies(startUrl),
        createdAt: now()
    });

    return metaCache.get(eventId);
}

/* ================== ROUTES ================== */
app.get('/prepare/:eventId', async (req, res) => {
    const { eventId } = req.params;
    if (metaCache.has(eventId)) return res.json({ cached: true });

    try {
        await prepareEvent(eventId);
        res.json({ cached: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/live/:eventId/playlist.m3u8', async (req, res) => {
    const { eventId } = req.params;

    let meta = metaCache.get(eventId);
    if (!meta) meta = await prepareEvent(eventId);

    const jar = newJar();
    const entry = await fetchShared(meta.streamUrl, jar, true);

    const base = new URL(meta.streamUrl);
    const rewritten = entry.data
        .split('\n')
        .map(l => {
            if (!l || l.startsWith('#')) return l;
            return `/live/${eventId}/seg?url=${encodeURIComponent(new URL(l, base))}`;
        })
        .join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(rewritten);
});

app.get('/live/:eventId/seg', async (req, res) => {
    const { eventId } = req.params;
    const realUrl = decodeURIComponent(req.query.url);

    if (inFlight.size > 500) {
        return res.status(503).send('busy');
    }

    const jar = newJar();
    const isPlaylist = realUrl.endsWith('.m3u8');

    const entry = await fetchShared(realUrl, jar, isPlaylist);

    if (isPlaylist) {
        const base = new URL(realUrl);
        const rewritten = entry.data
            .split('\n')
            .map(l => {
                if (!l || l.startsWith('#')) return l;
                return `/live/${eventId}/seg?url=${encodeURIComponent(new URL(l, base))}`;
            })
            .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(rewritten);
    }

    res.setHeader('Content-Type', entry.headers['content-type'] || 'video/mp2t');
    res.send(entry.data);
});

/* ================== PLAYER ================== */
app.get('/player/:eventId', (req, res) => {
    const { eventId } = req.params;
    res.send(`
<!doctype html>
<html>
<body style="margin:0;background:black">
<video id="v" controls autoplay muted style="width:100%;height:100%"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
(async () => {
  await fetch('/prepare/${eventId}');
  const hls = new Hls();
  hls.loadSource('/live/${eventId}/playlist.m3u8');
  hls.attachMedia(document.getElementById('v'));
})();
</script>
</body>
</html>
`);
});

/* ================== BOOT ================== */
app.listen(PORT, () => {
    console.log(`🔥 HLS proxy running on http://localhost:${PORT}`);
});
