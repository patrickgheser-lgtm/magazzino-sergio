require('dotenv').config();
const express = require('express');
const ytSearch = require('yt-search');
const spotify = require('spotify-url-info')(fetch);
const { Readable } = require('stream');
const app = express();

console.log("=== [MAGAZZINO] SISTEMA PROXY E CODE ATTIVATO ===");

// --- IL BUTTAFUORI (Gestione Coda Elaborazione) ---
const processingQueue = [];
let isProcessing = false;
const activeStreams = new Map(); // Mappa per conservare i flussi audio proxy

app.get('/', (req, res) => res.send('🏭 Magazzino Proxy Operativo'));

// L'endpoint principale che riceve le richieste e le mette in coda
app.get('/api/process', async (req, res) => {
    const query = req.query.q;
    const isPlaylist = req.query.isPlaylist === 'true';

    console.log(`[📩 RICEVUTO] Aggiunto alla coda di elaborazione: "${query}"`);
    
    // Creiamo una Promise che verrà risolta quando la canzone sarà pronta
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

// Il motore che elabora UNA canzone alla volta
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
        console.log(`\n[⚙️ ELABORO] Inizio task per: "${task.query}"`);

        // STEP 1: RICERCA SU YOUTUBE (O RISOLUZIONE SPOTIFY)
        let searchQuery = task.query;
        if (task.isPlaylist) {
           // Se Sergio ci dice che è un elemento playlist, non è un link ma un titolo puro
           searchQuery = task.query;
        }

        console.log(`[🔎 STEP 1] Cerco su YouTube: ${searchQuery}`);
        const searchResult = await ytSearch(searchQuery);
        const video = searchResult.videos[0];
        
        if (!video) throw new Error("Video non trovato.");
        console.log(`[🎯 STEP 1 OK] Trovato: "${video.title}"`);

        // STEP 2: CONVERSIONE RAPIDAPI
        const host = "youtube-mp4-mp3-downloader.p.rapidapi.com";
        const headers = { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host };
        
        console.log(`[📡 STEP 2] Richiedo conversione...`);
        const startUrl = `https://${host}/api/v1/download?id=${video.videoId}&format=mp3&audioQuality=128`;
        const startRes = await fetch(startUrl, { headers });
        const startData = await startRes.json();

        let directUrl = startData.downloadUrl || startData.url || startData.link;
        
        if (!directUrl) {
            const ticket = startData.progressId;
            console.log(`[🎫 STEP 2] Ticket: ${ticket}. Polling...`);

            for (let i = 0; i < 25; i++) {
                await new Promise(r => setTimeout(r, 4000));
                const progRes = await fetch(`https://${host}/api/v1/progress?id=${ticket}`, { headers });
                if (progRes.ok) {
                   const progData = await progRes.json();
                   directUrl = progData.downloadUrl || progData.url || progData.link;
                   if (directUrl) break;
                }
            }
        }

        if (!directUrl) throw new Error("Timeout API conversione.");

        console.log(`[✅ STEP 2 OK] Link RapidAPI ottenuto.`);

        // STEP 3: CREAZIONE DEL PROXY (Il fix per il Lag UND_ERR_SOCKET)
        // Invece di dare il link a Koyeb, salviamo il link. Koyeb chiamerà un nostro endpoint per avere lo stream stabile
        const streamId = Math.random().toString(36).substring(7);
        activeStreams.set(streamId, directUrl);

        // Manteniamo pulita la RAM: il link proxy scade dopo 2 ore
        setTimeout(() => activeStreams.delete(streamId), 2 * 60 * 60 * 1000);

        const proxyUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/stream/${streamId}`;

        task.resolve({ 
            success: true, 
            title: video.title, 
            videoId: video.videoId, 
            url: proxyUrl // Restituiamo il link del nostro proxy, non quello ballerino di RapidAPI
        });

    } catch (e) {
        console.error(`[❌ ERRORE TASK]`, e.message);
        task.reject(e);
    } finally {
        processNextInQueue(); // Passa alla prossima richiesta
    }
}

// L'endpoint PROXY che serve l'audio in modo stabile a Koyeb
app.get('/api/stream/:id', async (req, res) => {
    const directUrl = activeStreams.get(req.params.id);
    if (!directUrl) return res.status(404).send("Stream scaduto o non trovato.");

    try {
        const audioResponse = await fetch(directUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (!audioResponse.ok) throw new Error("Errore fetch dal server origine.");

        res.setHeader('Content-Type', 'audio/mpeg');
        Readable.fromWeb(audioResponse.body).pipe(res);
    } catch (e) {
        console.error("[❌ ERRORE PROXY]", e.message);
        res.status(500).send("Errore Stream");
    }
});

// L'endpoint per leggere SPOTIFY
app.get('/api/spotify', async (req, res) => {
    const url = req.query.url;
    try {
        console.log(`[🟢 SPOTIFY] Leggo i metadati da: ${url}`);
        const data = await spotify.getTracks(url);
        if (!data || data.length === 0) throw new Error("Playlist vuota o privata.");
        
        // Estraiamo "Artista - Titolo" per la ricerca successiva su YT
        const trackNames = data.map(track => `${track.artists ? track.artists[0].name : ''} ${track.name}`.trim());
        res.json({ success: true, tracks: trackNames });
    } catch (e) {
        res.status(500).json({ error: "Impossibile leggere il link Spotify." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Magazzino pronto sulla porta ${PORT}`));
