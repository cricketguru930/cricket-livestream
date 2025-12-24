// npm init - y
// npm install express axios axios-cookiejar-support tough-cookie cheerio lru-cache morgan express-rate-limit

/**
 * LRU-cached HLS proxy + session cache
 *
 * - LRU cache stores per-event metadata: streamUrl, cookies[], createdAt
 * - /prepare/:eventId -> warms session, stores stream url + cookies in LRU cache
 * - /api/live/:eventId -> returns cached metadata or triggers prepare
 * - /live/:eventId/playlist.m3u8 -> proxies playlist, rewrites segments to /seg?url=
 * - /live/:eventId/seg?url=... -> proxies nested playlists or .ts segments (pipes streams)
 *
 * Notes:
 * - TTL configurable via STREAM_TTL_SEC env (default 600s)
 * - Max cache size: 200 items (auto-evicts oldest)
 * - For production: no '*' CORS, proper rate-limiting, TLS
 * - Render.com memory cap: node --max-old-space-size=384
 */

import express from 'express';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import tough from 'tough-cookie';
import * as cheerio from 'cheerio';
import morgan from 'morgan';
import { LRUCache } from 'lru-cache';
import { URL } from 'url';
import { startKeepAlive } from "./keepAlive.js";


const app = express();

/* ================== GLOBAL ERROR HANDLERS ================== */
// Prevent server crashes from unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit - just log the error
});

// Prevent server crashes from uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught Exception:', error);
    // Don't exit immediately - give time to log and cleanup
    setTimeout(() => {
        console.error('⚠️ Server shutting down due to uncaught exception');
        process.exit(1);
    }, 1000);
});

/* ================== CONFIG ================== */
const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;
const STREAM_TTL_SEC = process.env.STREAM_TTL_SEC ? Number(process.env.STREAM_TTL_SEC) : 600; // 10 minutes
const CACHE_MAX_SIZE = 200; // Max number of cached events
const UA =
    process.env.UA ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const THIRD_PARTY_ROOT_REFERER = 'https://app.livetvapi.com/';
const THIRD_PARTY_ORIGIN = 'https://app.livetvapi.com';

/* ================== MIDDLEWARE ================== */
app.use(morgan('dev'));

// Lightweight CORS for dev/testing. In prod, set allowed origin(s).
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD');
    next();
});

app.get('/favicon.ico', (req, res) => res.sendStatus(204));

/* ================== LRU CACHE ================== */
// Production-ready LRU cache with TTL and max size limits
// Auto-evicts oldest entries when max size is reached
const lruCache = new LRUCache({
    max: CACHE_MAX_SIZE,
    ttl: STREAM_TTL_SEC * 1000, // TTL in milliseconds
    updateAgeOnGet: false, // Don't reset TTL on access
    updateAgeOnHas: false // Don't reset TTL on has check
});

/* ================== CACHE HELPERS ================== */

function cacheKey(eventId) {
    return `live:event:${eventId}:meta`;
}

// Save metadata object to LRU cache
async function cacheSet(eventId, metaObj, ttl = STREAM_TTL_SEC) {
    const key = cacheKey(eventId);
    lruCache.set(key, metaObj, { ttl: ttl * 1000 });
}

// Read from LRU cache (returns null if expired or not found)
async function cacheGet(eventId) {
    const key = cacheKey(eventId);
    return lruCache.get(key) || null;
}

// Delete from LRU cache
async function cacheDel(eventId) {
    const key = cacheKey(eventId);
    lruCache.delete(key);
}

/* ================== HEALTH CHECK ================== */
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        cacheSize: lruCache.size,
        cacheMax: CACHE_MAX_SIZE
    });
});

/* ================== COOKIE -> JAR HELPERS ================== */

// Convert array of 'Set-Cookie' strings into jar entries.
// We set cookies against the provided url (domain).
function setCookiesIntoJar(jar, cookieStrings = [], url) {
    // jar.setCookie supports callback; wrap in Promise
    const promises = cookieStrings.map((cs) => {
        return new Promise((resolve, reject) => {
            jar.setCookie(cs, url, { ignoreError: true }, (err, cookie) => {
                if (err) return reject(err);
                resolve(cookie);
            });
        });
    });
    return Promise.allSettled(promises);
}

// Return cookie strings from a jar for a url
function getCookieStringsFromJar(jar, url) {
    return new Promise((resolve, reject) => {
        jar.getCookies(url, (err, cookies) => {
            if (err) return reject(err);
            resolve(cookies.map((c) => c.cookieString()));
        });
    });
}

/* ================== AXIOS + COOKIEJAR SETUP ================== */

function newJar() {
    return new tough.CookieJar();
}

function newAxiosWithJar(jar) {
    return wrapper(
        axios.create({
            jar,
            withCredentials: true,
            timeout: 20000,
            maxRedirects: 5,
            validateStatus: () => true
        })
    );
}

function browserLikeHeaders() {
    return {
        'User-Agent': UA,
        Referer: THIRD_PARTY_ROOT_REFERER,
        Origin: THIRD_PARTY_ORIGIN,
        Accept: '*/*',
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        Connection: 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
    };
}

/* ================== HTTP FETCH HELPERS ================== */

// Fetch HTML/text with jar and headers
async function fetchTextWithJar(url, jar) {
    const client = newAxiosWithJar(jar);
    const res = await client.get(url, {
        headers: browserLikeHeaders(),
        responseType: 'text'
    });
    return res;
}

// Fetch streaming resource (playlist or ts) with jar
async function fetchStreamWithJar(url, jar, asText = false) {
    const client = newAxiosWithJar(jar);
    const res = await client.get(url, {
        headers: browserLikeHeaders(),
        responseType: asText ? 'text' : 'stream'
    });
    return res;
}

/* ================== STREAM EXTRACTION LOGIC ================== */

// Single prepare flow: (1) request event page, (2) store cookies, (3) extract stream URL
async function prepareEvent(eventId) {
    const jar = newJar();
    const startUrl = `https://app.livetvapi.com/event-play-2/${eventId}`;

    // 1) Request initial page (this will set cookies)
    const res = await fetchTextWithJar(startUrl, jar);

    // check status
    if (res.status !== 200) {
        throw new Error(`Initial page fetch failed ${res.status}`);
    }

    // capture Set-Cookie headers (if any) and ensure jar includes them (axios-cookiejar-support already populated jar)
    const setCookieHeaders = res.headers['set-cookie'] || [];

    // ensure cookie strings from jar are up-to-date
    const cookieStrings = await getCookieStringsFromJar(jar, startUrl);

    // 2) parse HTML and extract .m3u8 link (robust)
    const html = res.data;
    const $ = cheerio.load(html);

    // primary: input#stream-link
    let streamUrl = $('input#stream-link').attr('value');

    // fallback: iframe src -> fetch iframe
    if (!streamUrl) {
        const iframe = $('iframe[src]').attr('src');
        if (iframe) {
            const iframeUrl = new URL(iframe, res.request.res.responseUrl || startUrl).toString();
            const iframeRes = await fetchTextWithJar(iframeUrl, jar);
            if (iframeRes.status === 200) {
                const $ifr = cheerio.load(iframeRes.data);
                streamUrl = $ifr('input#stream-link').attr('value') || iframeRes.data.match(/https?:\/\/[^\s'"]+\.m3u8/)?.[0];
            }
        }
    }

    // fallback: regex in initial HTML
    if (!streamUrl) {
        const m = html.match(/https?:\/\/[^\s'"]+\.m3u8/);
        if (m) streamUrl = m[0];
    }

    if (!streamUrl) {
        throw new Error('Stream URL not found in page');
    }

    // Normalize absolute URL
    const finalStreamUrl = new URL(streamUrl, res.request.res.responseUrl || startUrl).toString();

    // 3) collect cookies (from jar) to persist
    const cookieStringsFinal = await getCookieStringsFromJar(jar, startUrl);

    // 4) store in cache (streamUrl + cookies)
    const meta = {
        streamUrl: finalStreamUrl,
        cookies: cookieStringsFinal,
        createdAt: Date.now()
    };

    await cacheSet(eventId, meta, STREAM_TTL_SEC);

    // Return meta
    return meta;
}

/* ================== PER-EVENT MUTEX (avoid concurrent prepares) ================== */
const prepareLocks = new Map(); // eventId -> Promise

async function ensurePrepared(eventId) {
    // fast path: if cached return
    const cached = await cacheGet(eventId);
    if (cached && cached.streamUrl) {
        return cached;
    }

    // if there's an ongoing prepare, wait for it
    let ongoing = prepareLocks.get(eventId);
    if (ongoing) {
        return ongoing;
    }

    // otherwise start one
    const p = (async () => {
        try {
            const meta = await prepareEvent(eventId);
            return meta;
        } catch (err) {
            // on failure delete cached maybe
            console.error(`prepareEvent failed for ${eventId}:`, err.message);
            await cacheDel(eventId);
            throw err;
        } finally {
            prepareLocks.delete(eventId);
        }
    })();

    prepareLocks.set(eventId, p);
    return p;
}

/* ================== API ROUTES ================== */

/**
 * Prepare route
 * - ensures stream is fetched and cookies saved in LRU cache
 */
app.get('/prepare/:eventId', async (req, res) => {
    const { eventId } = req.params;
    if (!/^\d+$/.test(eventId)) return res.status(400).json({ error: 'invalid eventId' });

    try {
        const cached = await cacheGet(eventId);
        if (cached && cached.streamUrl) {
            console.log(`Cache HIT for prepare ${eventId}`);
            return res.json({ eventId, cached: true, ttl: STREAM_TTL_SEC });
        }

        console.log(`Cache MISS for prepare ${eventId}, preparing...`);
        const meta = await ensurePrepared(eventId);
        return res.json({ eventId, cached: false, ttl: STREAM_TTL_SEC });
    } catch (e) {
        console.error('Prepare route failed:', e.message);
        return res.status(500).json({ error: 'prepare_failed', message: e.message });
    }
});

/**
 * Stream metadata route
 * - GET /api/live/:eventId
 */
app.get('/api/live/:eventId', async (req, res) => {
    const { eventId } = req.params;
    if (!/^\d+$/.test(eventId)) return res.status(400).json({ error: 'invalid eventId' });

    try {
        let meta = await cacheGet(eventId);
        if (!meta || !meta.streamUrl) {
            console.log(`api/live: cache miss for ${eventId}, auto preparing`);
            meta = await ensurePrepared(eventId);
            // ensurePrepared stored in cache
            meta = await cacheGet(eventId);
        } else {
            console.log(`api/live: cache hit for ${eventId}`);
        }

        return res.json({
            eventId,
            streamUrl: meta.streamUrl,
            source: 'lru-cache',
            createdAt: meta.createdAt
        });
    } catch (e) {
        console.error('api/live error:', e.message);
        res.status(500).json({ error: 'failed' });
    }
});

/**
 * Playlist proxy
 * - GET /live/:eventId/playlist.m3u8
 * - loads streamUrl and cookies from cache, fetches playlist, rewrites .ts/.m3u8 lines to /seg?url=
 */
app.get('/live/:eventId/playlist.m3u8', async (req, res) => {
    const { eventId } = req.params;
    if (!/^\d+$/.test(eventId)) return res.status(400).send('invalid eventId');

    try {
        let meta = await cacheGet(eventId);
        if (!meta || !meta.streamUrl) {
            // warm
            meta = await ensurePrepared(eventId);
        }

        if (!meta || !meta.streamUrl) {
            return res.status(500).send('Failed to prepare stream');
        }

        // create jar and hydrate cookies
        const jar = newJar();
        if (Array.isArray(meta.cookies) && meta.cookies.length) {
            // set cookies against the stream origin
            const originForCookies = meta.streamUrl;
            await setCookiesIntoJar(jar, meta.cookies, originForCookies);
        }

        // fetch the playlist (may be top-level or variant)
        const playlistRes = await fetchStreamWithJar(meta.streamUrl, jar, true);
        if (playlistRes.status !== 200) {
            console.error('Upstream playlist fetch failed', playlistRes.status);
            return res.status(502).send('Upstream playlist fetch failed');
        }

        const base = new URL(meta.streamUrl);
        const lines = playlistRes.data.split('\n');

        // Rewrite every .ts and nested .m3u8 to our dynamic proxy
        const rewritten = lines
            .map((line) => {
                if (!line || line.startsWith('#')) return line;
                // convert to absolute URL then proxy
                try {
                    const realUrl = new URL(line, base).href;
                    return `/live/${eventId}/seg?url=${encodeURIComponent(realUrl)}`;
                } catch {
                    return line; // if it can't parse, return raw
                }
            })
            .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.send(rewritten);
    } catch (e) {
        console.error('playlist proxy error:', e.message);
        return res.status(500).send('playlist error');
    }
});

/**
 * Segment proxy
 * - GET /live/:eventId/seg?url=<encoded>
 * - If url ends with .m3u8 -> fetch text, rewrite nested items to /seg?url=...
 * - Else -> stream the binary (.ts)
 */
app.get('/live/:eventId/seg', async (req, res) => {
    const { eventId } = req.params;
    const encoded = req.query.url;
    if (!encoded) return res.status(400).send('missing url param');
    let realUrl;
    try {
        realUrl = decodeURIComponent(encoded);
    } catch {
        return res.status(400).send('invalid url encoding');
    }

    if (!/^https?:\/\//.test(realUrl)) return res.status(400).send('invalid url');

    try {
        let meta = await cacheGet(eventId);
        if (!meta || !meta.streamUrl) {
            // allow prepare on-demand
            meta = await ensurePrepared(eventId);
        }

        if (!meta) {
            return res.status(500).send('Failed to prepare stream');
        }

        // new jar and hydrate cookies from meta if any
        const jar = newJar();
        if (Array.isArray(meta.cookies) && meta.cookies.length) {
            await setCookiesIntoJar(jar, meta.cookies, realUrl);
        }

        const upstreamRes = await fetchStreamWithJar(realUrl, jar, false);

        // if upstream returned non-200, propagate as 502 (or specific code)
        if (upstreamRes.status >= 400) {
            console.error('Upstream segment request failed', upstreamRes.status, realUrl);
            return res.sendStatus(502);
        }

        // If content-type indicates playlist or url ends with .m3u8, treat as text
        const isPlaylist = realUrl.endsWith('.m3u8') ||
            (upstreamRes.headers['content-type'] && upstreamRes.headers['content-type'].includes('application/vnd.apple.mpegurl'));

        if (isPlaylist) {
            // read text
            const playlistText = await (async () => {
                if (typeof upstreamRes.data === 'string') return upstreamRes.data;
                // stream -> accumulate as text
                const chunks = [];
                for await (const chunk of upstreamRes.data) chunks.push(chunk);
                return Buffer.concat(chunks).toString('utf8');
            })();

            const base = new URL(realUrl);
            const rewritten = playlistText
                .split('\n')
                .map((line) => {
                    if (!line || line.startsWith('#')) return line;
                    try {
                        const urlAbs = new URL(line, base).href;
                        return `/live/${eventId}/seg?url=${encodeURIComponent(urlAbs)}`;
                    } catch {
                        return line;
                    }
                })
                .join('\n');

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            return res.send(rewritten);
        }

        // otherwise stream bytes (TS segments)
        res.setHeader('Content-Type', upstreamRes.headers['content-type'] || 'video/mp2t');
        res.setHeader('Cache-Control', 'no-store');

        // Handle client disconnection
        req.on('close', () => {
            if (!res.headersSent) {
                try {
                    upstreamRes.data.destroy();
                } catch { }
            }
        });

        // pipe upstream stream to client with error handling
        upstreamRes.data.on('error', (err) => {
            console.error('Upstream stream error:', err.message);
            if (!res.headersSent) {
                try {
                    res.status(502).send('Stream error');
                } catch { }
            } else {
                try {
                    res.destroy();
                } catch { }
            }
        });

        res.on('error', (err) => {
            console.error('Response stream error:', err.message);
            try {
                upstreamRes.data.destroy();
            } catch { }
        });

        upstreamRes.data.pipe(res);
    } catch (e) {
        console.error('segment proxy error:', e.message);
        return res.sendStatus(502);
    }
});

/* ================== PLAYER PAGE (test) ================== */
app.get('/player/:eventId', (req, res) => {
    const { eventId } = req.params;
    // dynamic JS that calls /prepare before starting Hls.js
    res.send(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Player ${eventId}</title>
<style>html,body{height:100%;margin:0;background:#000}video{width:100%;height:100%}</style>
</head>
<body>
<video id="v" controls autoplay muted playsinline></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<video id="v" autoplay muted playsinline style="width:100%;height:100%;cursor:pointer;"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
(async function() {
  const video = document.getElementById('v');
  const eventId = ${JSON.stringify(eventId)};

  // Play/Pause toggle on click
  video.addEventListener('click', () => {
    if (video.paused) video.play();
    else video.pause();
  });

  // Prepare stream
  const prep = await fetch('/prepare/' + eventId);
  const info = await prep.json();
  if (!info || (info.cached === false && prep.status !== 200)) {
    console.error('prepare failed', info);
    alert('Stream not ready');
    return;
  }

  const src = '/live/' + eventId + '/playlist.m3u8';

  if (Hls.isSupported()) {
    const hls = new Hls({ lowLatencyMode: true, liveDurationInfinity: true, backBufferLength: 90 });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src;
  }

  video.muted = true;
  try { await video.play(); } catch(e) { console.warn('autoplay blocked'); }
})();
</script>

</body>
</html>`);
});

/* ================== DEBUG ROUTE ================== */
app.get('/debug/:eventId', async (req, res) => {
    const { eventId } = req.params;
    try {
        const meta = await cacheGet(eventId);
        if (!meta) return res.status(404).json({ ok: false, msg: 'not cached' });
        return res.json({ 
            ok: true, 
            meta, 
            cacheSize: lruCache.size,
            cacheMax: CACHE_MAX_SIZE
        });
    } catch (e) {
        return res.status(500).json({ ok: false, err: e.message });
    }
});

/* ================== BOOT ================== */
(async () => {
    try {
        // LRU cache initialized above, no async initialization needed
        const server = app.listen(PORT, () => {
            console.log(`🔥 HLS proxy running on http://localhost:${PORT}`);
            console.log(`▶ Example player: http://localhost:${PORT}/player/{eventId}`);
            console.log(`📦 LRU cache: max ${CACHE_MAX_SIZE} items, TTL ${STREAM_TTL_SEC}s`);
            startKeepAlive();

        });

        // Handle server errors
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} is already in use. Please use a different port.`);
            } else {
                console.error('❌ Server error:', error);
            }
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('⚠️ SIGTERM received, shutting down gracefully...');
            server.close(() => {
                console.log('✅ Server closed');
                process.exit(0);
            });
        });

        process.on('SIGINT', () => {
            console.log('⚠️ SIGINT received, shutting down gracefully...');
            server.close(() => {
                console.log('✅ Server closed');
                process.exit(0);
            });
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();




// http://localhost:5000/player/35071141