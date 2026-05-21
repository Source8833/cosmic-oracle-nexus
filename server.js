import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// The key is fetched securely from Render's Environment Variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

if (!GEMINI_API_KEY) {
    console.warn("⚠️ WARNING: No GEMINI_API_KEY detected.");
}

app.post('/api/oracle', async (req, res) => {
    try {
        const { prompt, voiceEnabled, isChronicle } = req.body;
        
        let sysInstruction = "You are the Primordial Cosmic Oracle of the void. Answer in exactly 1 or 2 extremely short sentences. Max 20 words. Speak in an esoteric, mystical, and primordial tone using emojis. Analyze the provided stats, remark on their achievements, and offer cryptic cosmic advice.";
        let maxTokens = 100;

        if (isChronicle) {
            sysInstruction = "You are the Cosmic Oracle recording history in the celestial ledger. Chronicle the pilot's latest journey. Detail their performance, reference their total lifetime achievements, and deliver a dramatic, esoteric, and mystical obituary of their run. You are permitted to use up to 4 sentences and 80 words. Use cosmic emojis.";
            maxTokens = 250;
        }

        // 1. GENERATE TEXT
        const textResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { 
                    parts: [{ text: sysInstruction }] 
                },
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: maxTokens
                }
            })
        });

        if (!textResponse.ok) {
            const errData = await textResponse.json();
            throw new Error(`Gemini Text Error: ${textResponse.status} - ${JSON.stringify(errData)}`);
        }

        const textData = await textResponse.json();
        const wisdom = textData.candidates?.[0]?.content?.parts?.[0]?.text || "The void remains silent.";

        // 2. GENERATE VOICE (IF REQUESTED)
        let base64Audio = null;
        let sampleRate = 24000;

        if (voiceEnabled) {
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
                const voiceData = await voiceResponse.json();
                const inlineData = voiceData.candidates?.[0]?.content?.parts?.[0]?.inlineData;
                if (inlineData) {
                    base64Audio = inlineData.data;
                    const match = (inlineData.mimeType || "").match(/rate=(\d+)/);
                    if (match) sampleRate = parseInt(match[1], 10);
                }
            } else {
                console.warn(`Gemini Voice Error: ${voiceResponse.status}`);
            }
        }

        // 3. RETURN UNIFIED RESPONSE
        res.json({ wisdom, base64Audio, sampleRate });

    } catch (error) {
        console.error("Oracle Manifestation Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`👁️ The Oracle Nexus is active on port ${PORT}`);
});
