import http from "http";
import { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// ✅ Use correct ffmpeg binary
if (process.env.RENDER) {
  ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");
} else {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

// ✅ PORT (Render required)
const PORT = process.env.PORT || 8080;

// ✅ HTTP + WebSocket server
const server = http.createServer((req, res) => {
  // 👇 THIS fixes "No open HTTP ports detected"
  res.writeHead(200);
  res.end("OK");
});

const wss = new WebSocketServer({ server });

server.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port", PORT);
});

// ✅ Google credentials
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const client = new speech.SpeechClient({ credentials });

// =========================
// 🔥 CLEANUP FUNCTION
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
function startStreaming(url, lang, ws, state) {
  console.log("🎧 START:", url);

  const request = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 8000, // keep low for stability
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

  // 🎧 FFmpeg (STABLE CONFIG)
  let command = ffmpeg(url).inputOptions([
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-fflags", "+genpts",
    "-probesize", "32",
    "-analyzeduration", "0",
    "-thread_queue_size", "512",
    "-vn",
    "-sn",
    "-dn",
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

  // 🔄 Restart before 5 min limit
  state.restartTimer = setTimeout(() => {
    console.log("🔄 Restarting stream");
    stopStreaming(state);
    setTimeout(() => startStreaming(url, lang, ws, state), 500);
  }, 270000);
}

// =========================
// 🔌 WEBSOCKET HANDLER
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
