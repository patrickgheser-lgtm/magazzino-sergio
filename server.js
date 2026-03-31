require('dotenv').config();
const express = require('express');
const ytSearch = require('yt-search');
const spotify = require('spotify-url-info')(fetch);
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fs = require('fs');
const path = require('path');
const app = express();

console.log("=== [MAGAZZINO] MOTORE API V2 (PIANO B) ATTIVATO ===");

const processingQueue = [];
let isProcessing = false;

app.get('/', (req, res) => res.send('🏭 Magazzino Proxy Operativo (Motore V2)'));

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

        // STEP 1: RICERCA SU YOUTUBE
        let searchQuery = task.query;
        console.log(`[🔎 STEP 1] Cerco su YouTube: ${searchQuery}`);
        const searchResult = await ytSearch(searchQuery);
        const video = searchResult.videos[0];
        
        if (!video) throw new Error("Video non trovato.");
        console.log(`[🎯 STEP 1 OK] Trovato: "${video.title}"`);

        // ==========================================
        // STEP 2: NUOVO MOTORE API (PIANO B)
        // ==========================================
        const host = "youtube-info-download-api.p.rapidapi.com";
        const headers = { 
            'x-rapidapi-key': apiKey, 
            'x-rapidapi-host': host,
            'Content-Type': 'application/json'
        };
        
        // La nuova API vuole il link completo di YouTube
        const ytFullUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
        
        console.log(`[📡 STEP 2] Richiedo conversione (API V2)...`);
        const startUrl = `https://${host}/ajax/download.php?format=mp3&audio_quality=128&add_info=0&url=${encodeURIComponent(ytFullUrl)}`;
        
        const startRes = await fetch(startUrl, { headers });
        const startData = await startRes.json();

        if (!startData.success && startData.message) {
            throw new Error(`L'API ha rifiutato la richiesta: ${startData.message}`);
        }

        // Cerchiamo se ci dà subito il link o se dobbiamo fare polling
        let directUrl = startData.downloadUrl || startData.url || startData.link || startData.download_url;
        
        if (!directUrl && startData.progress_url) {
            console.log(`[🎫 STEP 2] Uso il progress_url nativo. Polling...`);

            for (let i = 0; i < 50; i++) {
                await new Promise(r => setTimeout(r, 4000));
                
                // La nuova API ci fornisce un link esterno (es. p.savenow.to), lo chiamiamo direttamente!
                const progRes = await fetch(startData.progress_url);
                if (progRes.ok) {
                   const progData = await progRes.json();
                   
                   // Controlliamo tutte le possibili chiavi in cui il sito potrebbe nascondere l'MP3 finale
                   directUrl = progData.downloadUrl || progData.url || progData.link || progData.download_url;
                   if (directUrl) break;
                }
            }
        }

        if (!directUrl) throw new Error("Timeout estremo API conversione (V2).");
        console.log(`[✅ STEP 2 OK] Link ottenuto. Inizio download su disco...`);

        // ==========================================
        // STEP 3: DOWNLOAD COMPLETO SU DISCO
        // ==========================================
        const streamId = Math.random().toString(36).substring(7);
        const fileName = `${streamId}.mp3`;
        const filePath = path.join(__dirname, fileName);

        const audioResponse = await fetch(directUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!audioResponse.ok) throw new Error("Il server origine ha rifiutato il download.");

        const webStream = Readable.fromWeb(audioResponse.body);
        await pipeline(webStream, fs.createWriteStream(filePath));
        
        console.log(`[💾 STEP 3 OK] File MP3 salvato fisicamente: ${fileName}`);

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

app.get('/api/stream/:id', (req, res) => {
    const filePath = path.join(__dirname, req.params.id + ".mp3");
    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File scaduto o inesistente.");
    }
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(filePath);
});

app.get('/api/spotify', async (req, res) => {
    const url = req.query.url;
    try {
        console.log(`[🟢 SPOTIFY] Estraggo metadati...`);
        const data = await spotify.getTracks(url);
        if (!data || data.length === 0) throw new Error("Playlist vuota o privata.");
        
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
