import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
    parseOraclePrompt, injectionSuspect, lockReply, buildOracleMessages, buildGateMessages, gateSaysOn,
    buildRiftMessages, parseJsonObject, clampRiftConfig, cleanQuestion, OFF_TOPIC_LINE, SAFE_ORACLE_LINE, SAFE_RIFT_CONFIG,
} from './oracle-core.js';

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
// Cloudflare's token page also offers a "test your token" curl command; a paste of that whole command (or
// stray quotes/whitespace) still yields the bare token. Anything that is not a token becomes '' so the
// value can never reach a header (Node puts an invalid header value into the error message = the log).
function cleanToken(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/Bearer\s+([A-Za-z0-9._~+\/=-]+)/);
    const t = m ? m[1] : s.replace(/^["']+|["']+$/g, '');
    return /^[A-Za-z0-9._~+\/=-]+$/.test(t) ? t : '';
}
const CF_API_TOKEN = cleanToken(process.env.CF_API_TOKEN);
// 2026-11-15: IBM Granite 4.0 Micro (owner: "Granite on my Cloudflare account"): no reasoning step, so it answers
// in about a second, at $0.017/M input tokens. The Oracle is game-locked by oracle-core.js, not by the model.
const TEXT_MODEL = '@cf/ibm-granite/granite-4.0-h-micro';
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

// No response_format JSON mode (it was slow on Workers AI): rifts ask for JSON in the system prompt and
// parseJsonObject() takes the object out of the reply.
async function generateText({ system, user }, { maxTokens, temperature = 0.7 }) {
    const r = await cfPost('/v1/chat/completions', {
        model: TEXT_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature,
    });
    if (!r.ok) throw new Error(`Workers AI text ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    const text = String(d.choices?.[0]?.message?.content ?? d.result?.response ?? '').trim();
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

// What the safety check reads for a game-built prompt (it never sees the knowledge pack).
const GUARD_PROMPT = { hub: 'Greet me at the hub.', flight: 'Guide me mid-flight.', aura: 'Read my aura.', chronicle: 'Chronicle my last run.' };

// A generative rift: the description is data, the reply is clamped to the game's ranges and carries at most a
// 3-word name and a 15-word sentence. A reply that is not JSON keeps the old answer ({error}), so the app falls
// back to its own keyword compiler.
async function riftReply(prompt) {
    const desc = cleanQuestion(prompt);
    if (injectionSuspect(desc)) return { config: { ...SAFE_RIFT_CONFIG } };
    const text = await generateText(buildRiftMessages(desc), { maxTokens: 220, temperature: 0.6 });
    let config;
    try { config = clampRiftConfig(parseJsonObject(text)); } catch (e) {
        console.warn('[rift] reply was not JSON');
        return { error: 'Failed to parse generative dimension config.' };
    }
    if (!(await replyIsSafe(desc, `${config.name}. ${config.description}`))) config = { ...SAFE_RIFT_CONFIG };
    return { config };
}

// An Oracle answer. Game-built prompts are rebuilt in the server's words; the pilot's own words are capped,
// fenced off, checked for injection (no AI call at all) and topic-checked in parallel with the answer.
// Returns { wisdom, speak } - fixed lines (refusals, replacements) are never voiced.
async function oracleReply(prompt) {
    const parsed = parseOraclePrompt(prompt);
    const gated = parsed.kind === 'ask' || parsed.kind === 'free';
    if (gated && (injectionSuspect(parsed.question) || !parsed.question)) return { wisdom: OFF_TOPIC_LINE, speak: false };
    const maxTokens = parsed.kind === 'chronicle' ? 200 : 160;
    const [gate, answer] = await Promise.allSettled([
        gated ? generateText(buildGateMessages(parsed.question), { maxTokens: 3, temperature: 0 }) : Promise.resolve('ON'),
        generateText(buildOracleMessages(parsed), { maxTokens, temperature: 0.5 }),
    ]);
    if (gate.status === 'rejected') throw gate.reason;
    if (!gateSaysOn(gate.value)) return { wisdom: OFF_TOPIC_LINE, speak: false };
    if (answer.status === 'rejected') throw answer.reason;
    const locked = lockReply(answer.value, { maxSentences: 3 });
    if (!locked) return { wisdom: SAFE_ORACLE_LINE, speak: false };
    if (locked === OFF_TOPIC_LINE) return { wisdom: OFF_TOPIC_LINE, speak: false };
    if (!(await replyIsSafe(parsed.question || GUARD_PROMPT[parsed.kind] || 'Speak to me.', locked))) return { wisdom: SAFE_ORACLE_LINE, speak: false };
    return { wisdom: locked, speak: true };
}

app.post('/api/oracle', customRateLimiter, async (req, res) => {
    try {
        if (!validOracleBody(req.body)) return res.status(400).json({ error: 'Invalid request.' });
        const { prompt, voiceEnabled, mode, isPreset } = req.body;
        const ck = cacheKey(req.body);
        if (isPreset && presetResponseCache.has(ck)) return res.json(presetResponseCache.get(ck));

        if (mode === 'rift') {
            const r = await riftReply(prompt);
            if (r.error) return res.json({ wisdom: '', base64Audio: null, sampleRate: VOICE_SAMPLE_RATE, error: r.error });
            return res.json({ wisdom: JSON.stringify(r.config), base64Audio: null, sampleRate: VOICE_SAMPLE_RATE, config: r.config });
        }

        let { wisdom, speak: speakIt } = await oracleReply(prompt);
        let base64Audio = null;
        if (voiceEnabled && speakIt) {
            try {
                base64Audio = await speak(wisdom);
            } catch (e) {
                console.warn('[voice]', e.message);
                wisdom += ` [The Oracle's voice could not be summoned this time.]`;   // no upstream details to the client
            }
        }
        const responseBody = { wisdom, base64Audio, sampleRate: VOICE_SAMPLE_RATE };   // the shape every shipped app expects
        if (isPreset) cacheSet(ck, responseBody);
        res.json(responseBody);
    } catch (error) {
        console.error('Oracle Manifestation Error:', error.message);
        res.status(500).json({ error: 'The Oracle could not answer. Try again in a moment.' });   // details stay in the log
    }
});

// /api/models and /api/tasks were removed in the 2026-11-14 audit: unauthenticated and unused by the game.
// The global prophecy cron was removed the same day: the game no longer shows it, and it sent the top
// pilots' names to the AI (the privacy policy promises names are never sent).

app.listen(PORT, () => {
    console.log(`👁️ The Oracle Nexus is active on port ${PORT}`);
});
