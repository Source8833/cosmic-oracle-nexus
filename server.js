import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Audit 2026-11-14 hardening. Render sits one proxy hop in front: req.ip is the real client address
// (the X-Forwarded-For header a client sends itself is no longer trusted as-is).
app.set('trust proxy', 1);
const ALLOWED_ORIGINS = ['capacitor://localhost', 'https://localhost', 'http://localhost', 'ionic://localhost',
    'https://cosmic-ascension-2e3b7.web.app', 'https://cosmic-ascension-2e3b7.firebaseapp.com'];
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)) }));
app.use(express.json({ limit: '16kb' }));

// --- Cloudflare Workers AI (2026-11-14: replaces Google Gemini) ------------------------------------
// Render's Environment holds CF_ACCOUNT_ID and CF_API_TOKEN (a Workers AI token). CF_API_BASE is only
// overridden by the tests, which point it at a fake API on localhost.
const CF_API_BASE = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const TEXT_MODEL = '@cf/qwen/qwen3.8-27b';
const VOICE_MODEL = '@cf/deepgram/aura-2-en';
const VOICE_SPEAKER = 'zeus';            // deep and grand, the closest to the old "Charon" voice
const VOICE_SAMPLE_RATE = 24000;         // raw 16-bit PCM: the apps wrap it in a WAV header themselves
const GUARD_MODEL = '@cf/meta/llama-guard-3-8b';
const CF_TIMEOUT_MS = 25000;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.warn('⚠️ WARNING: CF_ACCOUNT_ID / CF_API_TOKEN are not set. The Oracle cannot answer.');
}

const cfUrl = (p) => `${CF_API_BASE}/accounts/${CF_ACCOUNT_ID}/ai${p}`;
async function cfPost(p, body) {
    return fetch(cfUrl(p), {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CF_TIMEOUT_MS),
    });
}

// Qwen may emit a <think> block before the answer; the player only ever sees the answer.
const stripThinking = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();

// No response_format JSON mode: on the live Qwen 3.8 it took 54 s against 7.5 s without it (2026-11-14).
// Rifts ask for JSON in the system prompt and parseJsonObject() takes the object out of the reply.
// reasoning_effort accepts low | medium | xhigh (default); low keeps replies to a few seconds.
async function generateText(system, prompt, { maxTokens }) {
    const r = await cfPost('/v1/chat/completions', {
        model: TEXT_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.7,
        reasoning_effort: 'low',
    });
    if (!r.ok) throw new Error(`Workers AI text ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    const msg = d.choices?.[0]?.message;
    const text = stripThinking(msg?.content ?? d.result?.response ?? '');
    if (!text) throw new Error('Workers AI text: empty reply');
    return text;
}

// Store AI-content policies (App Store 1.2 / Google Play AI-generated content): every reply passes a
// Llama Guard check before it reaches a player. If the check itself fails, the reply is not shown.
async function replyIsSafe(prompt, reply) {
    try {
        const r = await cfPost(`/run/${GUARD_MODEL}`, { messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: reply }] });
        if (!r.ok) { console.warn(`[guard] ${r.status}`); return false; }
        const out = (await r.json()).result?.response;
        if (out && typeof out === 'object') return out.safe === true;
        return /^\s*safe\b/i.test(String(out || ''));
    } catch (e) {
        console.warn('[guard] failed:', e.message);
        return false;
    }
}

async function speak(text) {
    const r = await cfPost(`/run/${VOICE_MODEL}`, {
        text, speaker: VOICE_SPEAKER, encoding: 'linear16', container: 'none', sample_rate: VOICE_SAMPLE_RATE,
    });
    if (!r.ok) throw new Error(`Workers AI voice ${r.status}`);
    if ((r.headers.get('content-type') || '').includes('application/json')) {
        const d = await r.json();
        const audio = d.result?.audio || d.audio;
        if (!audio) throw new Error('Workers AI voice: no audio');
        return audio;
    }
    return Buffer.from(await r.arrayBuffer()).toString('base64');
}

const SAFE_ORACLE_LINE = 'The void stirs, but its words drift beyond the stars. Ask again, pilot. 🌌';
const SAFE_RIFT_CONFIG = { name: 'Silent Expanse', description: 'A calm, quiet stretch of the void.', gravity: 0.53, jump_force: -32, bouncy_chance: 0.15, platform_color: '#00f3ff', bouncy_color: '#ff00e5' };

// Small in-memory cache for preset questions, keyed on everything that changes the answer
// (the prompt alone let a 'rift'-mode answer be cached for the mystic preset), capped in size.
const presetResponseCache = new Map();
const PRESET_CACHE_MAX = 100;
const cacheKey = (b) => JSON.stringify([b.prompt, b.mode || '', !!b.isChronicle, !!b.voiceEnabled]);
function cacheSet(k, v) {
    if (presetResponseCache.size >= PRESET_CACHE_MAX) presetResponseCache.delete(presetResponseCache.keys().next().value);
    presetResponseCache.set(k, v);
}

// Lightweight memory-based IP rate limiter to protect the server and the AI account under heavy load
const ipRequestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 15; // Max 15 custom chats per minute per IP

// Every request counts, presets and rifts included (they used to skip the limiter, and each one was a
// fresh paid AI call), plus a global ceiling. Stale addresses are pruned every minute.
const GLOBAL_MAX_PER_MINUTE = Number(process.env.ORACLE_GLOBAL_MAX_PER_MINUTE) || 300;
let globalWindow = [];
setInterval(() => {
    const cut = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [ip, ts] of ipRequestLog) { const keep = ts.filter((t) => t > cut); if (keep.length) ipRequestLog.set(ip, keep); else ipRequestLog.delete(ip); }
}, RATE_LIMIT_WINDOW_MS).unref();
function customRateLimiter(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    globalWindow = globalWindow.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (globalWindow.length >= GLOBAL_MAX_PER_MINUTE) {
        return res.status(503).json({ error: "The Oracle is overwhelmed. Try again in a minute." });
    }
    globalWindow.push(now);

    if (!ipRequestLog.has(ip)) {
        ipRequestLog.set(ip, []);
    }

    const timestamps = ipRequestLog.get(ip).filter(time => now - time < RATE_LIMIT_WINDOW_MS);
    timestamps.push(now);
    ipRequestLog.set(ip, timestamps);

    if (timestamps.length > MAX_REQUESTS_PER_WINDOW) {
        console.warn(`[Rate Limit] Blocking IP ${ip} - too many inquiries (${timestamps.length}/${MAX_REQUESTS_PER_WINDOW})`);
        return res.status(429).json({
            error: "The Oracle is receiving too many thoughts from your coordinates. Telepathic link congested. Please wait 60 seconds."
        });
    }

    next();
}

const PROMPT_MAX = 6000;   // the longest prompt the game builds (chronicles) is well under this
function validOracleBody(b) {
    return b && typeof b.prompt === 'string' && b.prompt.length > 0 && b.prompt.length <= PROMPT_MAX &&
        (b.mode === undefined || b.mode === null || b.mode === 'rift' || b.mode === 'oracle') &&
        ['voiceEnabled', 'isChronicle', 'isPreset'].every((k) => b[k] === undefined || typeof b[k] === 'boolean');
}

// Keep-awake ping (since 2026-05): an uptime pinger calls it so the free Render instance never cold-starts.
app.get('/api/wakeup', (req, res) => {
    res.json({ status: 'Awake', message: "The Cosmic Oracle's eyes are open." });
});

const ORACLE_SYSTEM = "You are the Primordial Cosmic Oracle of the void. Answer in 2 or 3 short sentences. Keep your thoughts brief but always complete your sentences fully. Speak in an esoteric, mystical, and primordial tone using emojis. Analyze the provided stats, remark on their achievements, and offer cryptic cosmic advice. CRITICAL: Output ONLY the spoken response. Do not include any word counts, thinking process, or meta-commentary.";
const CHRONICLE_SYSTEM = "You are the Cosmic Oracle recording history in the celestial ledger. Chronicle the pilot's latest journey. Detail their performance, reference their total lifetime achievements, and deliver a dramatic, esoteric, and mystical obituary of their run. Keep it to about 3 or 4 sentences. Use cosmic emojis. CRITICAL: Output ONLY the spoken response. Do not include any word counts, thinking process, or meta-commentary.";
const RIFT_SYSTEM = `You are a game level designer API for the mobile game "Cosmic Ascension".
Analyze the user's description of a dimension and output a configuration JSON object with physics and visual properties that match their description.
You MUST respond with a valid JSON object matching the following structure:
{
  "name": "Name of the dimension (string, 1-3 words)",
  "description": "A short, cool one-sentence description (under 15 words)",
  "gravity": float (ranges from 0.15 for very low gravity to 1.5 for extremely heavy gravity, default is 0.53),
  "jump_force": integer (ranges from -22 for weak jump to -45 for extremely strong jump, default is -32),
  "bouncy_chance": float (ranges from 0.05 for very few bouncy platforms to 0.9 for almost all bouncy platforms, default is 0.15),
  "platform_color": "Hex color code for regular platforms (e.g. #00f3ff)",
  "bouncy_color": "Hex color code for bouncy platforms (e.g. #ff00e5)"
}
Ensure the gravity and jump_force are balanced so the player can actually jump high enough to reach the next platform. If gravity is high, jump_force should also be stronger (more negative, e.g. -40).
Output ONLY the JSON object. Do not include markdown formatting or backticks.`;

// The first {...} block of a reply (a model sometimes wraps JSON in prose or fences).
function parseJsonObject(text) {
    const s = String(text || ''), i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) throw new Error('no JSON object');
    return JSON.parse(s.slice(i, j + 1));
}

app.post('/api/oracle', customRateLimiter, async (req, res) => {
    try {
        if (!validOracleBody(req.body)) return res.status(400).json({ error: 'Invalid request.' });
        const { prompt, voiceEnabled, isChronicle, mode, isPreset } = req.body;
        const ck = cacheKey(req.body);

        // Cache hit check
        if (isPreset && presetResponseCache.has(ck)) {
            return res.json(presetResponseCache.get(ck));
        }

        const isRift = mode === 'rift';
        const system = isRift ? RIFT_SYSTEM : (isChronicle ? CHRONICLE_SYSTEM : ORACLE_SYSTEM);
        const maxTokens = isRift ? 800 : (isChronicle ? 2048 : 1000);

        // 1. GENERATE TEXT, then the safety check
        let wisdom = await generateText(system, prompt, { maxTokens });
        const safe = await replyIsSafe(prompt, wisdom);
        if (!safe) wisdom = isRift ? JSON.stringify(SAFE_RIFT_CONFIG) : SAFE_ORACLE_LINE;

        // 2. GENERATE VOICE (IF REQUESTED, NOT RIFT MODE, AND THE REPLY PASSED THE CHECK)
        let base64Audio = null;
        let sampleRate = VOICE_SAMPLE_RATE;
        if (voiceEnabled && !isRift && safe) {
            try {
                base64Audio = await speak(wisdom);
            } catch (e) {
                console.warn('[voice]', e.message);
                wisdom += ` [The Oracle's voice could not be summoned this time.]`;   // no upstream details to the client
            }
        }

        // 3. RETURN UNIFIED RESPONSE (the shape every shipped app expects)
        let responseBody = { wisdom, base64Audio, sampleRate };
        if (isRift) {
            try {
                responseBody.config = parseJsonObject(wisdom);
                responseBody.wisdom = JSON.stringify(responseBody.config);
            } catch (e) {
                console.error('Failed to parse the rift reply as JSON:', wisdom.slice(0, 300));
                responseBody.error = "Failed to parse generative dimension config.";
            }
        }
        if (isPreset && responseBody && !responseBody.error) cacheSet(ck, responseBody);
        res.json(responseBody);

    } catch (error) {
        console.error("Oracle Manifestation Error:", error);
        res.status(500).json({ error: 'The Oracle could not answer. Try again in a moment.' });   // details stay in the log
    }
});

// /api/models and /api/tasks were removed in the 2026-11-14 audit: unauthenticated and unused by the game.
// The global prophecy cron was removed the same day: the game no longer shows it, and it sent the top
// pilots' names to the AI (the privacy policy promises names are never sent).

app.listen(PORT, () => {
    console.log(`👁️ The Oracle Nexus is active on port ${PORT}`);
});
