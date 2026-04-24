import cluster from "cluster";
import os from "os";

const numCPUs = 2; // ✅ your Render plan (2 CPUs)

if (cluster.isPrimary) {
  console.log(`🧠 Master ${process.pid} running`);

  // 🔥 spawn workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // 🔄 auto-restart worker if it crashes
  cluster.on("exit", (worker) => {
    console.log(`❌ Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

} else {

  // =========================
  // 👇 YOUR ORIGINAL SERVER (unchanged logic)
  // =========================

  import http from "http";
  import { WebSocketServer } from "ws";
  import speech from "@google-cloud/speech";
  import ffmpeg from "fluent-ffmpeg";
  import axios from "axios";

  ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

  const PORT = process.env.PORT || 8080;

  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("OK");
  });

  const wss = new WebSocketServer({ server });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Worker ${process.pid} running on port ${PORT}`);
  });

  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const client = new speech.SpeechClient({ credentials });

  async function resolveStream(url) {
    try {
      const res = await axios.get(url, {
        maxRedirects: 5,
        responseType: "stream",
      });
      return res.request?.res?.responseUrl || url;
    } catch {
      return url;
    }
  }

  function stopStreaming(state) {
    if (state.restartTimer) clearTimeout(state.restartTimer);

    if (state.recognizeStream) {
      state.recognizeStream.destroy();
      state.recognizeStream = null;
    }

    if (state.ffmpegStream && state.ffmpegStream.destroy) {
      state.ffmpegStream.destroy();
      state.ffmpegStream = null;
    }

    state.isStreaming = false;
  }

  async function startStreaming(url, lang, ws, state) {
    if (state.isStreaming) return;

    state.isStreaming = true;

    console.log(`🎧 START (${process.pid}):`, url, "|", lang);

    const realUrl = await resolveStream(url);

    const request = {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 8000,
        languageCode: lang || "en-US",
      },
      interimResults: false,
    };

    state.recognizeStream = client
      .streamingRecognize(request)
      .on("error", () => restartStream(url, lang, ws, state))
      .on("data", (data) => {
        const result = data.results?.[0];
        if (!result || !result.isFinal) return;

        const transcript = result.alternatives?.[0]?.transcript;

        if (transcript) {
          ws.send(JSON.stringify({ text: transcript, lang }));
        }
      });

    let command = ffmpeg(realUrl).inputOptions([
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-fflags", "+discardcorrupt",
      "-err_detect", "ignore_err",
      "-probesize", "500000",
      "-analyzeduration", "1000000",
      "-loglevel", "error"
    ]);

    state.ffmpegStream = command
      .noVideo()
      .audioCodec("pcm_s16le")
      .audioFrequency(8000)
      .audioChannels(1)
      .format("s16le")
      .on("error", () => restartStream(url, lang, ws, state))
      .pipe(state.recognizeStream);

    state.restartTimer = setTimeout(() => {
      restartStream(url, lang, ws, state);
    }, 270000);
  }

  function restartStream(url, lang, ws, state) {
    if (!state.isStreaming) return;

    console.log(`🔄 Restart (${process.pid})`);

    stopStreaming(state);

    setTimeout(() => {
      if (state.isStreaming !== false) {
        startStreaming(url, lang, ws, state);
      }
    }, 800);
  }

  wss.on("connection", (ws) => {
    console.log(`🔥 Client connected (Worker ${process.pid})`);

    // ⚠️ per-worker limit
    if (wss.clients.size > 5) {
      ws.send(JSON.stringify({ error: "Server busy" }));
      ws.close();
      return;
    }

    const state = {
      recognizeStream: null,
      ffmpegStream: null,
      restartTimer: null,
      isStreaming: false,
    };

    ws.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.type === "start") {
          if (state.isStreaming) return;
          startStreaming(data.url, data.lang, ws, state);
        }

        if (data.type === "stop") {
          stopStreaming(state);
        }

      } catch (err) {
        console.error("❌ Parse error:", err.message);
      }
    });

    ws.on("close", () => {
      console.log(`❌ Client disconnected (Worker ${process.pid})`);
      stopStreaming(state);
    });
  });

}
