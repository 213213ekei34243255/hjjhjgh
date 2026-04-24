import http from "http";
import { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// ✅ FFmpeg setup
ffmpeg.setFfmpegPath(ffmpegPath);

// ✅ PORT (Render required)
const PORT = process.env.PORT || 8080;

// ✅ HTTP + WebSocket server
const server = http.createServer();
const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});

// ✅ Google credentials
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const client = new speech.SpeechClient({
  credentials,
});

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
  console.log("🌍 LANG:", lang);

  const request = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 8000, // lighter → more stable
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
        console.log("🎤 FINAL:", transcript);
        ws.send(JSON.stringify({ text: transcript, lang }));
      }
    });

  // 🎧 FFmpeg stream
  let command = ffmpeg(url).inputOptions([
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-vn",
    "-sn",
    "-dn",
    "-loglevel", "error",
  ]);

  state.ffmpegStream = command
    .noVideo()
    .audioCodec("pcm_s16le")
    .audioFrequency(16000)
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
    setTimeout(() => startStreaming(url, lang, ws, state), 300);
  }, 270000);
}

// =========================
// 🔌 WEBSOCKET HANDLER
// =========================
wss.on("connection", (ws) => {
  console.log("🔥 Client connected");

  let state = {
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
      console.error("❌ Message parse error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ Client disconnected");
    stopStreaming(state);
  });
});
