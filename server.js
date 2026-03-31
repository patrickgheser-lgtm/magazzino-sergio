require('dotenv').config();
const express = require('express');
const ytSearch = require('yt-search'); // La ricerca si sposta qui!
const app = express();

console.log("=== [MAGAZZINO] SISTEMA RAGGI X ATTIVATO ===");

app.get('/', (req, res) => res.send('🏭 Magazzino Operativo'));

app.get('/api/process', async (req, res) => {
    const query = req.query.q;
    const apiKey = process.env.RAPIDAPI_KEY;

    console.log(`\n[🔍 RAGGI X] Nuova richiesta ricevuta: "${query}"`);

    try {
        // STEP 1: RICERCA
        console.log(`[🔎 STEP 1] Avvio ricerca su YouTube...`);
        const searchResult = await ytSearch(query);
        const video = searchResult.videos[0];
        
        if (!video) {
            console.log(`[❌] Nessun video trovato per la ricerca.`);
            return res.status(404).json({ error: "Video non trovato." });
        }
        console.log(`[🎯 STEP 1 OK] Trovato: "${video.title}" (ID: ${video.videoId})`);

        // STEP 2: CONVERSIONE RAPIDAPI
        const host = "youtube-mp4-mp3-downloader.p.rapidapi.com";
        const headers = { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host };
        
        console.log(`[📡 STEP 2] Richiedo conversione a RapidAPI...`);
        const startUrl = `https://${host}/api/v1/download?id=${video.videoId}&format=mp3&audioQuality=128`;
        const startRes = await fetch(startUrl, { headers });
        const startData = await startRes.json();

        let downloadUrl = startData.downloadUrl || startData.url || startData.link;
        
        if (!downloadUrl) {
            const ticket = startData.progressId;
            console.log(`[🎫 STEP 2] Ticket ricevuto: ${ticket}. Inizio polling...`);

            for (let i = 0; i < 25; i++) {
                await new Promise(r => setTimeout(r, 4000));
                console.log(`[🔄 STEP 2] Controllo stato... (${i+1}/25)`);
                const progRes = await fetch(`https://${host}/api/v1/progress?id=${ticket}`, { headers });
                const progData = await progRes.json();
                downloadUrl = progData.downloadUrl || progData.url || progData.link;
                if (downloadUrl) break;
            }
        }

        if (downloadUrl) {
            console.log(`[✅ SUCCESSO] Risolto link per "${video.title}". Invio a Sergio...`);
            return res.json({ 
                success: true, 
                title: video.title, 
                videoId: video.videoId, 
                url: downloadUrl 
            });
        } else {
            throw new Error("Timeout conversione");
        }

    } catch (e) {
        console.error(`[❌ ERRORE MAGAZZINO]`, e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Magazzino pronto sulla porta ${PORT}`));

// Per evitare che un errore casuale faccia spegnere il server a Render
process.on('uncaughtException', err => {
    console.error("⚠️ Errore critico intercettato (Ma il Magazzino non si spegne):", err.message);
});
