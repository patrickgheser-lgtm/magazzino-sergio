require('dotenv').config();
const express = require('express');
const ytSearch = require('yt-search');
const spotify = require('spotify-url-info')(fetch);
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fs = require('fs');
const path = require('path');
const app = express();

console.log("=== [MAGAZZINO] SISTEMA HARD-DISK & ANTI-TIMEOUT ATTIVATO ===");

const processingQueue = [];
let isProcessing = false;

app.get('/', (req, res) => res.send('🏭 Magazzino Proxy Operativo'));

app.get('/api/process', async (req, res) => {
    const query = req.query.q;
    const isPlaylist = req.query.isPlaylist === 'true';

    console.log(`[📩 RICEVUTO] Aggiunto alla coda: "${query}"`);
    
    const taskPromise = new Promise((resolve, reject) => {
        processingQueue.push({ query, isPlaylist, resolve, reject });
    });

    if (!isProcessing) processNextInQueue();

    try {
        const result = await taskPromise;
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function processNextInQueue() {
    if (processingQueue.length === 0) {
        isProcessing = false;
        console.log("[🏁] Coda di elaborazione vuota.");
        return;
    }

    isProcessing = true;
    const task = processingQueue.shift();
    const apiKey = process.env.RAPIDAPI_KEY;

    try {
        console.log(`\n[⚙️ ELABORO] Task: "${task.query}"`);

        let searchQuery = task.query;
        console.log(`[🔎 STEP 1] Cerco su YouTube: ${searchQuery}`);
        const searchResult = await ytSearch(searchQuery);
        const video = searchResult.videos[0];
        
        if (!video) throw new Error("Video non trovato.");
        console.log(`[🎯 STEP 1 OK] Trovato: "${video.title}"`);

        const host = "youtube-mp4-mp3-downloader.p.rapidapi.com";
        const headers = { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host };
        
        console.log(`[📡 STEP 2] Richiedo conversione...`);
        const startUrl = `https://${host}/api/v1/download?id=${video.videoId}&format=mp3&audioQuality=128`;
        const startRes = await fetch(startUrl, { headers });
        const startData = await startRes.json();

        let directUrl = startData.downloadUrl || startData.url || startData.link;
        
        if (!directUrl) {
            const ticket = startData.progressId;
            console.log(`[🎫 STEP 2] Ticket: ${ticket}. Polling aumentato a 4 min...`);

            // AUMENTATO A 50 TENTATIVI (Circa 3.5 minuti) per non fallire mai
            for (let i = 0; i < 50; i++) {
                await new Promise(r => setTimeout(r, 4000));
                const progRes = await fetch(`https://${host}/api/v1/progress?id=${ticket}`, { headers });
                if (progRes.ok) {
                   const progData = await progRes.json();
                   directUrl = progData.downloadUrl || progData.url || progData.link;
                   if (directUrl) break;
                }
            }
        }

        if (!directUrl) throw new Error("Timeout estremo API conversione.");
        console.log(`[✅ STEP 2 OK] Link ottenuto. Inizio download su disco...`);

        // STEP 3: DOWNLOAD COMPLETO SU DISCO (Addio Lag)
        const streamId = Math.random().toString(36).substring(7);
        const fileName = `${streamId}.mp3`;
        const filePath = path.join(__dirname, fileName);

        const audioResponse = await fetch(directUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!audioResponse.ok) throw new Error("Il server origine ha rifiutato il download.");

        // Salviamo l'intero MP3 fisicamente nel server Render
        const webStream = Readable.fromWeb(audioResponse.body);
        await pipeline(webStream, fs.createWriteStream(filePath));
        
        console.log(`[💾 STEP 3 OK] File MP3 salvato fisicamente: ${fileName}`);

        // Eliminiamo il file dopo 2 ore per non riempire la memoria
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`[🗑️ PULIZIA] File ${fileName} eliminato.`);
            }
        }, 2 * 60 * 60 * 1000);

        const proxyUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/stream/${streamId}`;

        task.resolve({ 
            success: true, 
            title: video.title, 
            videoId: video.videoId, 
            url: proxyUrl 
        });

    } catch (e) {
        console.error(`[❌ ERRORE TASK]`, e.message);
        task.reject(e);
    } finally {
        processNextInQueue(); 
    }
}

// L'endpoint che serve il file direttamente dal Disco Rigido
app.get('/api/stream/:id', (req, res) => {
    const filePath = path.join(__dirname, req.params.id + ".mp3");
    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File scaduto o inesistente.");
    }
    
    // Serve il file MP3 statico ad altissima velocità
    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(filePath);
});

// Fixato il rilevamento nomi per Spotify
app.get('/api/spotify', async (req, res) => {
    const url = req.query.url;
    try {
        console.log(`[🟢 SPOTIFY] Estraggo metadati avanzati...`);
        const data = await spotify.getTracks(url);
        if (!data || data.length === 0) throw new Error("Playlist vuota o privata.");
        
        // Estrazione nome artista sicura al 100%
        const trackNames = data.map(track => {
            let artistStr = "";
            if (track.artists && track.artists.length > 0) {
                artistStr = track.artists.map(a => a.name).join(' ');
            } else if (track.subtitle) {
                artistStr = track.subtitle;
            }
            return `${artistStr} ${track.name}`.trim();
        });
        
        res.json({ success: true, tracks: trackNames });
    } catch (e) {
        console.error(`[❌ ERRORE SPOTIFY]`, e.message);
        res.status(500).json({ error: "Impossibile leggere il link Spotify." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Magazzino pronto sulla porta ${PORT}`));
