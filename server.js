console.log("🚀 Avvio del Magazzino in corso...");

require('dotenv').config();
const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('🏭 Magazzino Sergio Acciaio Operativo!'));

// L'endpoint che farà il lavoro sporco
app.get('/api/convert', async (req, res) => {
    const videoId = req.query.id;
    const apiKey = process.env.RAPIDAPI_KEY;

    if (!videoId) return res.status(400).json({ error: "Manca l'ID del video." });
    if (!apiKey) return res.status(500).json({ error: "Manca la chiave API nel magazzino." });

    const host = "youtube-mp4-mp3-downloader.p.rapidapi.com";
    const headers = { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host };

    try {
        console.log(`[📦] Inizio conversione ID: ${videoId}`);
        const startUrl = `https://${host}/api/v1/download?id=${videoId}&format=mp3&audioQuality=128&addInfo=false`;
        const startRes = await fetch(startUrl, { method: 'GET', headers: headers });
        const startData = await startRes.json();

        if (startData.downloadUrl || startData.url || startData.link) {
            return res.json({ success: true, url: startData.downloadUrl || startData.url || startData.link });
        }

        const ticket = startData.progressId;
        if (!ticket) throw new Error("RapidAPI non ha rilasciato il ticket.");

        for (let i = 0; i < 25; i++) {
            await new Promise(resolve => setTimeout(resolve, 4000));
            console.log(`[🔄] Controllo stato... (${i+1}/25)`);
            const progRes = await fetch(`https://${host}/api/v1/progress?id=${ticket}`, { headers });
            
            if (progRes.ok) {
                const progData = await progRes.json();
                if (progData.status === "error" || progData.status === "failed") throw new Error("Il server di conversione ha fallito.");
                let dl = progData.downloadUrl || progData.url || progData.link || (progData.result && progData.result.downloadUrl);
                if (dl) {
                    console.log(`[✅] File pronto. Consegna in corso!`);
                    return res.json({ success: true, url: dl });
                }
            }
        }
        res.status(504).json({ error: "Tempo scaduto per la conversione." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// IL FIX: Diciamo a Render di mettersi in ascolto su 0.0.0.0 (Tutte le reti)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Magazzino in ascolto sulla porta ${PORT} su tutte le interfacce di rete.`);
});

// Per evitare che un errore casuale faccia spegnere il server a Render
process.on('uncaughtException', err => {
    console.error("⚠️ Errore critico intercettato (Ma il Magazzino non si spegne):", err.message);
});
