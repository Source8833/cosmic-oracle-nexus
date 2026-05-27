import 'dotenv/config';
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
        
        let sysInstruction = "You are the Primordial Cosmic Oracle of the void. Answer in 2 or 3 short sentences. Keep your thoughts brief but always complete your sentences fully. Speak in an esoteric, mystical, and primordial tone using emojis. Analyze the provided stats, remark on their achievements, and offer cryptic cosmic advice. CRITICAL: Output ONLY the spoken response. Do not include any word counts, thinking process, or meta-commentary.";
        let maxTokens = 1000;

        if (isChronicle) {
            sysInstruction = "You are the Cosmic Oracle recording history in the celestial ledger. Chronicle the pilot's latest journey. Detail their performance, reference their total lifetime achievements, and deliver a dramatic, esoteric, and mystical obituary of their run. Keep it to about 3 or 4 sentences. Use cosmic emojis. CRITICAL: Output ONLY the spoken response. Do not include any word counts, thinking process, or meta-commentary.";
            maxTokens = 2048;
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
        let wisdom = textData.candidates?.[0]?.content?.parts?.[0]?.text || "The void remains silent.";

        // 2. GENERATE VOICE (IF REQUESTED)
        let base64Audio = null;
        let sampleRate = 24000;

        if (voiceEnabled) {
            const voiceResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
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
                    wisdom += ` [Voice Generation Failed: ${voiceResponse.status} - ${errorData}]`;
                }
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

// --- Tasks CRUD Routes ---

// Simple in-memory tasks storage
let tasks = [];

// Get all tasks
app.get('/api/tasks', (req, res) => {
    res.json(tasks);
});

// Create a new task
app.post('/api/tasks', (req, res) => {
    try {
        const newTask = { 
            id: Date.now().toString(), // Simple unique ID
            ...req.body,
            createdAt: new Date().toISOString()
        };
        tasks.push(newTask);
        res.status(201).json({ message: "Task created successfully", task: newTask });
    } catch (error) {
        console.error("Error creating task:", error);
        res.status(500).json({ error: error.message });
    }
});

// Update a task
app.put('/api/tasks/:id', (req, res) => {
    try {
        const taskId = req.params.id;
        const index = tasks.findIndex(t => t.id === taskId);
        
        if (index === -1) {
            return res.status(404).json({ error: "Task not found" });
        }
        
        // Update task while preserving its ID
        tasks[index] = { ...tasks[index], ...req.body, id: taskId };
        
        res.json({ 
            message: `Task ${taskId} updated successfully`, 
            task: tasks[index] 
        });
    } catch (error) {
        console.error("Error updating task:", error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a task
app.delete('/api/tasks/:id', (req, res) => {
    try {
        const taskId = req.params.id;
        const index = tasks.findIndex(t => t.id === taskId);
        
        if (index === -1) {
            return res.status(404).json({ error: "Task not found" });
        }
        
        tasks.splice(index, 1);
        res.json({ message: `Task ${taskId} deleted successfully` });
    } catch (error) {
        console.error("Error deleting task:", error);
        res.status(500).json({ error: error.message });
    }
});


app.listen(PORT, () => {
    console.log(`👁️ The Oracle Nexus is active on port ${PORT}`);
});
