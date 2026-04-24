import http from "http";
import { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import axios from "axios";

// ✅ FFmpeg setup (use static safely)
ffmpeg.setFfmpegPath(ffmpegPath);

// ✅ PORT
const PORT = process.env.PORT || 8080;

// ✅ HTTP server (Render health check fix)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});

const wss = new WebSocketServer({ server });

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port", PORT);
});

// ✅ Google Speech
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const client = new speech.SpeechClient({ credentials });


// =========================
// 🔥 RESOLVE REAL STREAM URL
// =========================
async function resolveStream(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      responseType: "stream",
    });

    const finalUrl = res.request?.res?.responseUrl || url;
    console.log("🔗 Resolved URL:", finalUrl);
    return finalUrl;

  } catch (err) {
    console.error("⚠️ Resolve failed, using original:", err.message);
    return url;
  }
}


// =========================
// 🔥 CLEANUP
// =========================
function stopStreaming(state) {
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }

  if (state.recognizeStream) {
    state.recognizeStream.destroy();
    state.recognizeStream = null;
  }

  if (state.ffmpegStream && state.ffmpegStream.destroy) {
    state.ffmpegStream.destroy();
    state.ffmpegStream = null;
  }
}


// =========================
// 🎧 START STREAMING
// =========================
async function startStreaming(url, lang, ws, state) {
  console.log("🎧 START:", url);

  // 🔥 resolve redirect URL first
  const realUrl = await resolveStream(url);

  const request = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 8000,
      languageCode: lang || "en-US",
    },
    interimResults: false,
  };

  // 🎤 Speech stream
  state.recognizeStream = client
    .streamingRecognize(request)
    .on("error", (err) => {
      console.error("⚠️ Speech error:", err.message);
      stopStreaming(state);
      setTimeout(() => startStreaming(url, lang, ws, state), 1000);
    })
    .on("data", (data) => {
      const result = data.results?.[0];
      if (!result || !result.isFinal) return;

      const transcript = result.alternatives?.[0]?.transcript;

      if (transcript) {
        console.log("🎤", transcript);
        ws.send(JSON.stringify({ text: transcript, lang }));
      }
    });

  // 🎧 FFmpeg (FIXED + SAFE)
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
    .on("error", (err) => {
      console.error("❌ FFMPEG ERROR:", err.message);
      stopStreaming(state);
    })
    .pipe(state.recognizeStream);

  // 🔄 Restart safety
  state.restartTimer = setTimeout(() => {
    console.log("🔄 Restarting stream");
    stopStreaming(state);
    setTimeout(() => startStreaming(url, lang, ws, state), 500);
  }, 270000);
}


// =========================
// 🔌 WEBSOCKET
// =========================
wss.on("connection", (ws) => {
  console.log("🔥 Client connected");

  const state = {
    recognizeStream: null,
    ffmpegStream: null,
    restartTimer: null,
  };

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "start") {
        stopStreaming(state);
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
    console.log("❌ Client disconnected");
    stopStreaming(state);
  });
});
