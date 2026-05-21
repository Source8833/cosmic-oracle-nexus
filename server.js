import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

if (!GEMINI_API_KEY) {
    console.warn("⚠️ WARNING: No GEMINI_API_KEY provided. The Oracle is blind.");
}

// --- UPDATED API ENDPOINTS ---

// Oracle Wisdom Route
app.post('/api/oracle', async (req, res) => {
    try {
        const { prompt } = req.body;
        // Corrected stable API endpoint
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                // Note: systemInstruction is now passed within the configuration object for newer models
                generationConfig: {
                    "systemInstruction": "You are the Primordial Cosmic Oracle of the void. You gaze into the souls of pilots playing 'Cosmic Ascension'. Speak in an esoteric, mystical, and primordial tone using emojis like 🌑🧿👁️✨🕳️🔮. Analyze the provided stats, remark on their achievements or lack thereof, and offer cryptic cosmic advice for their next run. Keep your responses under 3 sentences and highly atmospheric."
                }
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(`Gemini API Error: ${response.status} - ${JSON.stringify(errData)}`);
        }

        const data = await response.json();
        const wisdom = data.candidates?.[0]?.content?.parts?.[0]?.text || "The void remains silent.";
        res.json({ wisdom });
    } catch (error) {
        console.error("Oracle Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Voice Manifestation Route
app.post('/api/voice', async (req, res) => {
    try {
        const { text } = req.body;
        // Corrected stable API endpoint for TTS
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Speak in a mystical, echoing whisper: " + text }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } }
                }
            })
        });

        if (!response.ok) throw new Error(`Gemini TTS error: ${response.status}`);
        const data = await response.json();
        const inlineData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        
        if (!inlineData) return res.status(500).json({ error: "No voice data returned." });

        const mimeType = inlineData.mimeType || "audio/L16; rate=24000";
        let sampleRate = 24000;
        const match = mimeType.match(/rate=(\d+)/);
        if (match) sampleRate = parseInt(match[1], 10);

        res.json({ base64Audio: inlineData.data, sampleRate: sampleRate });
    } catch (error) {
        console.error("Voice Error:", error);
        res.status(500).json({ error: "Failed to manifest voice." });
    }
});

app.listen(PORT, () => {
    console.log(`👁️ The Oracle Nexus is active on port ${PORT}`);
});
