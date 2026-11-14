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

// The key is fetched securely from Render's Environment Variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
    console.warn("⚠️ WARNING: No valid GEMINI_API_KEY detected. Placeholder or empty value present.");
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

// Lightweight memory-based IP rate limiter to protect the server and API key under heavy load
const ipRequestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 15; // Max 15 custom chats per minute per IP

// Every request counts, presets and rifts included (they used to skip the limiter, and each one was a
// fresh paid Gemini call), plus a global ceiling. Stale addresses are pruned every minute.
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

// 4.0.1: explicit Gemini safety filters on every request (store AI-generated
// content policies): block harassment, hate, sexual and dangerous content from
// LOW probability up. A blocked reply falls back to an in-character line.
const SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_LOW_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' }
];

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

app.post('/api/oracle', customRateLimiter, async (req, res) => {
    try {
        if (!validOracleBody(req.body)) return res.status(400).json({ error: 'Invalid request.' });
        const { prompt, voiceEnabled, isChronicle, mode, isPreset } = req.body;
        const ck = cacheKey(req.body);

        // Cache hit check
        if (isPreset && presetResponseCache.has(ck)) {
            return res.json(presetResponseCache.get(ck));
        }
        
        let sysInstruction = "You are the Primordial Cosmic Oracle of the void. Answer in 2 or 3 short sentences. Keep your thoughts brief but always complete your sentences fully. Speak in an esoteric, mystical, and primordial tone using emojis. Analyze the provided stats, remark on their achievements, and offer cryptic cosmic advice. CRITICAL: Output ONLY the spoken response. Do not include any word counts, thinking process, or meta-commentary.";
        let maxTokens = 1000;
        let generationConfig = {
            temperature: 0.7,
            maxOutputTokens: maxTokens
        };

        if (mode === 'rift') {
            sysInstruction = `You are a game level designer API for the mobile game "Cosmic Ascension".
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
            
            generationConfig = {
                temperature: 0.7,
                maxOutputTokens: 500,
                responseMimeType: "application/json"
            };
        } else if (isChronicle) {
            sysInstruction = "You are the Cosmic Oracle recording history in the celestial ledger. Chronicle the pilot's latest journey. Detail their performance, reference their total lifetime achievements, and deliver a dramatic, esoteric, and mystical obituary of their run. Keep it to about 3 or 4 sentences. Use cosmic emojis. CRITICAL: Output ONLY the spoken response. Do not include any word counts, thinking process, or meta-commentary.";
            maxTokens = 2048;
            generationConfig = {
                temperature: 0.7,
                maxOutputTokens: maxTokens
            };
        }

        // 1. GENERATE TEXT
        const textResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { 
                    parts: [{ text: sysInstruction }] 
                },
                contents: [{ parts: [{ text: prompt }] }],
                safetySettings: SAFETY_SETTINGS,
                generationConfig: generationConfig
            })
        });

        if (!textResponse.ok) {
            const errData = await textResponse.json();
            throw new Error(`Gemini Text Error: ${textResponse.status} - ${JSON.stringify(errData)}`);
        }

        const textData = await textResponse.json();
        let wisdom = textData.candidates?.[0]?.content?.parts?.[0]?.text || "The void remains silent.";

        // 2. GENERATE VOICE (IF REQUESTED AND NOT RIFT MODE)
        let base64Audio = null;
        let sampleRate = 24000;

        if (voiceEnabled && mode !== 'rift') {
            const voiceResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: "Speak in a grand, ancient, majestic voice suitable for kids. Do not whisper. Read this: " + wisdom }] }],
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } }
                    }
                })
            });

            if (voiceResponse.ok) {
                const voiceRawText = await voiceResponse.text();
                try {
                    const voiceData = JSON.parse(voiceRawText);
                    const inlineData = voiceData.candidates?.[0]?.content?.parts?.[0]?.inlineData;
                    if (inlineData) {
                        base64Audio = inlineData.data;
                        const match = (inlineData.mimeType || "").match(/rate=(\d+)/);
                        if (match) sampleRate = parseInt(match[1], 10);
                    }
                } catch (parseError) {
                    console.warn(`Gemini Voice JSON Error: ${parseError.message} - Response text: ${voiceRawText.substring(0, 100)}`);
                    wisdom += ` [Voice Generation Failed: Invalid JSON response from API]`;
                }
            } else {
                const errorData = await voiceResponse.text();
                console.warn(`Gemini Voice Error: ${voiceResponse.status} - ${errorData}`);
                
                if (voiceResponse.status === 429) {
                    wisdom += ` [Oracle Voice is resting. Please wait 60 seconds before speaking to the Oracle again.]`;
                } else {
                    wisdom += ` [The Oracle's voice could not be summoned this time.]`;   // no upstream details to the client
                }
            }
        }

        // 3. RETURN UNIFIED RESPONSE
        let responseBody = { wisdom, base64Audio, sampleRate };
        if (mode === 'rift') {
            try {
                responseBody.config = JSON.parse(wisdom);
            } catch (e) {
                console.error("Failed to parse Gemini response as JSON:", wisdom);
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

// /api/models and /api/tasks were removed in the 2026-11-14 audit: unauthenticated, unused by the game,
// and /api/models spent quota on the owner's key on every call.


// --- Scheduled Global Prophecy Cron Job (One Prompt, Infinite Players) ---
const FB_URL = 'https://cosmic-ascension-2e3b7-default-rtdb.firebaseio.com';

async function updateGlobalProphecy() {
    console.log("[Cron] Starting global prophecy generation...");
    try {
        let topPlayerName = "NeonStriker";
        let topScore = 12500;

        // 1. Fetch leaderboard from Firebase
        const lbResponse = await fetch(`${FB_URL}/leaderboard.json`);
        if (lbResponse.ok) {
            const lbData = await lbResponse.json();
            if (lbData) {
                const entries = Object.values(lbData).filter(e => e && e.score && (e.displayName || e.name));
                if (entries.length > 0) {
                    entries.sort((a, b) => b.score - a.score);
                    topPlayerName = entries[0].displayName || entries[0].name || "NeonStriker";
                    topScore = entries[0].score;
                }
            }
        } else {
            console.warn("[Cron] Failed to fetch leaderboard from Firebase. Using fallbacks.");
        }

        console.log(`[Cron] Top player identified: ${topPlayerName} (Score: ${topScore})`);

        // 2. Query Gemini or generate local fallback
        let prophecyText = "";

        if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
            console.warn("[Cron] No GEMINI_API_KEY detected. Generating local fallback prophecy.");
            const fallbacks = [
                `👁️ The stars foretell that Pilot ${topPlayerName} will conquer the higher altitudes and transcend the void. Ascend further, for the Source awaits! 🌌`,
                `🔮 A grand neon aura surrounds Pilot ${topPlayerName}, whose peak of ${topScore} meters has shaken the rifts. Trust in the thrusters! ✨`,
                `🌀 The cosmic ledger whispers of Pilot ${topPlayerName}. Their record flight path is etched into the stellar tides, guiding all future pilots. 👁️`,
                `✨ The Exosphere resonates with the name of Pilot ${topPlayerName}. They have reached ${topScore} meters, leaving a trail of stardust. 🌌`
            ];
            prophecyText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        } else {
            const sysInstruction = "You are the Primordial Cosmic Oracle of the void. You generate a grand, mysterious, and informative cosmic prophecy about the leaderboard's current reigning champion. Your prophecy MUST explicitly mention the pilot's name and their record altitude (in meters). Keep the tone mystical, esoteric, and legendary, using cosmic emojis (like 👁️, 🔮, 🌌, 🌀, ✨, 🚀). Keep the response between 2 and 3 sentences. Output ONLY the prophecy itself. Do not include word counts, thinking process, or any markdown formatting/backticks.";
            const prompt = `Lead Pilot: '${topPlayerName}'\nRecord Altitude: ${topScore} meters\n\nWrite a prophecy containing this pilot's name and their record altitude, inspiring other pilots to either follow their path or try to defeat them.`;

            const modelsToTry = [
                'gemini-2.5-flash',
                'gemini-flash-latest',
                'gemini-2.5-flash-lite'
            ];

            let success = false;
            for (const model of modelsToTry) {
                try {
                    console.log(`[Cron] Attempting prophecy generation with model: ${model}`);
                    const textResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            systemInstruction: { 
                                parts: [{ text: sysInstruction }] 
                            },
                            contents: [{ parts: [{ text: prompt }] }],
                            safetySettings: SAFETY_SETTINGS,
                            generationConfig: {
                                temperature: 0.8,
                                maxOutputTokens: 1000,
                                thinkingConfig: {
                                    thinkingBudget: 0
                                }
                            }
                        })
                    });

                    if (textResponse.ok) {
                        const textData = await textResponse.json();
                        prophecyText = textData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
                        if (prophecyText) {
                            console.log(`[Cron] Prophecy successfully generated using model ${model}`);
                            success = true;
                            break;
                        }
                    } else {
                        const errData = await textResponse.text();
                        console.warn(`[Cron] Model ${model} failed: ${textResponse.status} - ${errData}`);
                    }
                } catch (e) {
                    console.warn(`[Cron] Exception trying model ${model}:`, e);
                }
            }

            if (!success) {
                console.warn("[Cron] All Gemini models failed or returned empty. Falling back to local offline prophecy generator.");
                const fallbacks = [
                    `👁️ The stars foretell that Pilot ${topPlayerName} will conquer the higher altitudes and transcend the void. Ascend further, for the Source awaits! 🌌`,
                    `🔮 A grand neon aura surrounds Pilot ${topPlayerName}, whose peak of ${topScore} meters has shaken the rifts. Trust in the thrusters! ✨`,
                    `🔮 The cosmic ledger whispers of Pilot ${topPlayerName}. Their record flight path of ${topScore} meters is etched into the stellar tides. 🌀`,
                    `✨ The Exosphere resonates with the name of Pilot ${topPlayerName}. They have reached ${topScore} meters, leaving a trail of stardust. 🌌`
                ];
                prophecyText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
            }
        }

        if (!prophecyText) {
            throw new Error("Oracle returned empty text for prophecy.");
        }

        console.log(`[Cron] Generated Prophecy: "${prophecyText}"`);

        // 3. Write prophecy back to Firebase
        const payload = {
            text: prophecyText,
            updatedAt: Date.now(),
            topPlayer: topPlayerName,
            topScore: topScore
        };

        const fbWriteResponse = await fetch(`${FB_URL}/global_prophecy.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (fbWriteResponse.ok) {
            console.log("[Cron] Successfully updated global prophecy in Firebase.");
        } else {
            console.error(`[Cron] Failed to write prophecy to Firebase: ${fbWriteResponse.status}`);
        }

    } catch (err) {
        console.error("[Cron] Prophecy generation failed:", err);
    }
}

// Endpoint to manually trigger prophecy update
app.post('/api/cron/prophecy', async (req, res) => {
    // only with the CRON_SECRET header (it triggered paid AI calls for anyone before)
    if (!process.env.CRON_SECRET || req.get('x-cron-secret') !== process.env.CRON_SECRET) return res.status(404).end();
    try {
        await updateGlobalProphecy();
        res.json({ message: "Prophecy update triggered successfully." });
    } catch (error) {
        console.error('[cron] prophecy failed:', error);
        res.status(500).json({ error: 'failed' });
    }
});

app.listen(PORT, () => {
    console.log(`👁️ The Oracle Nexus is active on port ${PORT}`);
    
    // 4.0.1: the AI prophecy no longer runs on a timer. The game does not show
    // its text any more, and it sent the top pilots' names to the AI.
    // (POST /api/cron/prophecy still triggers it manually if ever needed.)
});

