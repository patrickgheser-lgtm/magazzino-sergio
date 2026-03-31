require('dotenv').config();
const express = require('express');
const ytSearch = require('yt-search');
const spotify = require('spotify-url-info')(fetch);
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fs = require('fs');
const path = require('path');
const app = express();

console.log("=== [MAGAZZINO] MOTORE IBRIDO (PIANO B + PIANO A) ATTIVATO ===");

const processingQueue = [];
let isProcessing = false;

app.get('/', (req, res) => res.send('🏭 Magazzino Proxy Operativo (Motore Ibrido)'));

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

// ==========================================
// FUNZIONE: TENTA PIANO B (Veloce, 500/giorno)
// ==========================================
async function tentaPianoB(video, apiKey) {
    console.log(`[⚡ PIANO B] Avvio richiesta API V2 (Primaria)...`);
    const host = "youtube-info-download-api.p.rapidapi.com";
    const headers = { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host, 'Content-Type': 'application/json' };
    
    const ytFullUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    const startUrl = `https://${host}/ajax/download.php?format=mp3&audio_quality=128&add_info=0&url=${encodeURIComponent(ytFullUrl)}`;
    
    const startRes = await fetch(startUrl, { headers });
    const startData = await startRes.json();

    if (!startData.success) throw new Error(startData.message || "Rifiutato dall'API.");

    let directUrl = startData.downloadUrl || startData.url || startData.link || startData.download_url;
    
    if (!directUrl && startData.progress_url) {
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const progRes = await fetch(startData.progress_url);
            if (progRes.ok) {
               const progData = await progRes.json();
               directUrl = progData.downloadUrl || progData.url || progData.link || progData.download_url;
               if (directUrl) break;
            }
        }
    }

    if (!directUrl) throw new Error("Timeout Piano B.");
    return directUrl;
}

// ==========================================
// FUNZIONE: TENTA PIANO A (Lento, Limite Alto)
// ==========================================
async function tentaPianoA(video, apiKey) {
    console.log(`[🐢 PIANO A] Avvio richiesta API V1 (Emergenza)...`);
    const host = "youtube-mp4-mp3-downloader.p.rapidapi.com";
    const headers = { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host };
    
    const startUrl = `https://${host}/api/v1/download?id=${video.videoId}&format=mp3&audioQuality=128`;
    const startRes = await fetch(startUrl, { headers });
    const startData = await startRes.json();

    let directUrl = startData.downloadUrl || startData.url || startData.link;
    
    if (!directUrl) {
        const ticket = startData.progressId;
        if (!ticket) throw new Error("Nessun ticket ricevuto.");

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

    if (!directUrl) throw new Error("Timeout estremo Piano A.");
    return directUrl;
}

// ==========================================
// IL MOTORE PRINCIPALE
// ==========================================
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

        // STEP 1: Ricerca
        let searchQuery = task.query;
        const searchResult = await ytSearch(searchQuery);
        const video = searchResult.videos[0];
        
        if (!video) throw new Error("Video non trovato su YouTube.");
        console.log(`[🎯 STEP 1 OK] Trovato: "${video.title}"`);

        // STEP 2: MOTORE IBRIDO (La vera Magia)
        let directUrl = null;
        try {
            // Proviamo sempre e prima il Piano B
            directUrl = await tentaPianoB(video, apiKey);
            console.log(`[✅ PIANO B OK] Link MP3 ottenuto velocemente.`);
        } catch (erroreB) {
            // Se finisci le 500 chiamate o il server cade, entra qui!
            console.log(`[⚠️ PIANO B FALLITO] Motivo: ${erroreB.message}`);
            console.log(`[🔄 FAILOVER] Passo automaticamente al Piano A...`);
            
            // Ritentiamo col Piano A
            directUrl = await tentaPianoA(video, apiKey);
            console.log(`[✅ PIANO A OK] Link MP3 di emergenza ottenuto.`);
        }

        // STEP 3: Download su disco (Proxy)
        const streamId = Math.random().toString(36).substring(7);
        const fileName = `${streamId}.mp3`;
        const filePath = path.join(__dirname, fileName);

        console.log(`[💾 STEP 3] Scarico il file in RAM/Disco...`);
        const audioResponse = await fetch(directUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!audioResponse.ok) throw new Error("Rifiutato dal server origine.");

        const webStream = Readable.fromWeb(audioResponse.body);
        await pipeline(webStream, fs.createWriteStream(filePath));
        
        console.log(`[✅ COMPLETATO] Proxy pronto: ${fileName}`);

        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }, 2 * 60 * 60 * 1000);

        const proxyUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/stream/${streamId}`;

        task.resolve({ success: true, title: video.title, videoId: video.videoId, url: proxyUrl });

    } catch (e) {
        console.error(`[❌ ERRORE CRITICO TASK]`, e.message);
        task.reject(e);
    } finally {
        processNextInQueue(); 
    }
}

// Endpoint del proxy statico
app.get('/api/stream/:id', (req, res) => {
    const filePath = path.join(__dirname, req.params.id + ".mp3");
    if (!fs.existsSync(filePath)) return res.status(404).send("File inesistente.");
    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(filePath);
});

// Endpoint Spotify
app.get('/api/spotify', async (req, res) => {
    const url = req.query.url;
    try {
        const data = await spotify.getTracks(url);
        if (!data || data.length === 0) throw new Error("Playlist privata.");
        
        const trackNames = data.map(track => {
            let artistStr = track.artists && track.artists.length > 0 ? track.artists.map(a => a.name).join(' ') : (track.subtitle || "");
            return `${artistStr} ${track.name}`.trim();
        });
        res.json({ success: true, tracks: trackNames });
    } catch (e) {
        res.status(500).json({ error: "Errore Spotify." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Magazzino pronto sulla porta ${PORT}`));
