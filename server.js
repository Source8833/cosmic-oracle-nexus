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

app.post('/api/oracle', async (req, res) => {
    try {
        const { prompt } = req.body;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                systemInstruction: { 
                    parts: [{ 
                        text: "You are the Primordial Cosmic Oracle of the void. You gaze into the souls of pilots playing 'Cosmic Ascension'. Speak in an esoteric, mystical, and primordial tone using emojis like 🌑🧿👁️✨🕳️🔮. Analyze the provided stats, remark on their achievements or lack thereof, and offer cryptic cosmic advice for their next run. Keep your responses under 3 sentences and highly atmospheric." 
                    }] 
                }
            })
        });

        if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
        const data = await response.json();
        res.json({ wisdom: data.candidates?.[0]?.content?.parts?.[0]?.text || "The void remains silent." });
    } catch (error) {
        console.error("Oracle Error:", error);
        res.status(500).json({ error: "Failed to commune with the void." });
    }
});

app.post('/api/voice', async (req, res) => {
    try {
        const { text } = req.body;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Speak in a mystical, echoing whisper: " + text }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } }
                },
                model: "gemini-2.5-flash-preview-tts"
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
