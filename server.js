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
        const { prompt } = req.body;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { 
                    parts: [{ text: "You are the Primordial Cosmic Oracle of the void. You gaze into the souls of pilots playing 'Cosmic Ascension'. Speak in an esoteric, mystical, and primordial tone using emojis like 🌑🧿👁️✨🕳️🔮. Analyze the provided stats, remark on their achievements or lack thereof, and offer cryptic cosmic advice for their next run. Keep your responses under 3 sentences and highly atmospheric." }] 
                },
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 200
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
        console.error("Oracle Manifestation Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/voice', async (req, res) => {
    try {
        const { text } = req.body;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
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
