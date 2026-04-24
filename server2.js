import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import ffmpeg from "fluent-ffmpeg";
import http from "http";

// ✅ Use system ffmpeg (fixes SIGSEGV crash from ffmpeg-static)
// Make sure you have it installed: apt-get install -y ffmpeg
// DO NOT import or set ffmpeg-static path

const PORT = process.env.PORT || 8080;

const server = http.createServer();
const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const client = new speech.SpeechClient({ credentials });

// ✅ Helper: cleans up all streams and timers
function cleanState(state) {
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  if (state.recognizeStream) {
    state.recognizeStream.destroy();
    state.recognizeStream = null;
  }
  if (state.ffmpegStream?.destroy) {
    state.ffmpegStream.destroy();
    state.ffmpegStream = null;
  }
}

function startStreaming(url, lang, ws, state) {
  const request = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,       // ✅ Fixed: was 8000, must match audioFrequency below
      languageCode: lang || "en-US",
    },
    interimResults: false,
  };

  state.recognizeStream = client
    .streamingRecognize(request)
    .on("error", (err) => {
      console.log("⚠️ Speech API error, restarting...", err.message);
      cleanState(state);
      setTimeout(() => startStreaming(url, lang, ws, state), 300);
    })
    .on("data", (data) => {
      const result = data.results?.[0];
      if (!result || !result.isFinal) return;

      const transcript = result.alternatives?.[0]?.transcript;
      console.log("🎤 FINAL:", transcript);

      if (transcript) {
        ws.send(JSON.stringify({ text: transcript, lang }));
      }
    });

  // Build ffmpeg command
  let command = ffmpeg(url).inputOptions([
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-loglevel", "error",
  ]);

  // ✅ RAI-specific headers
  if (url.includes("rai.it")) {
    command.inputOptions([
      "-user_agent", "Mozilla/5.0",
      "-headers", "Referer: https://www.rai.it/\r\n",
    ]);
  }

  // ✅ BBC World Service is HLS — needs explicit format hint
  if (url.includes("bbcmedia.co.uk")) {
    command.inputOptions(["-f", "hls"]);
  }

  const ffmpegProc = command
    .noVideo()
    .audioCodec("pcm_s16le")
    .audioFrequency(16000)          // ✅ Fixed: was 8000
    .audioChannels(1)
    .format("s16le")
    .on("error", (err) => {
      const msg = err.message || "";

      // These are expected/normal — don't restart for these
      if (
        msg.includes("Output stream closed") ||
        msg.includes("SIGKILL") ||
        msg.includes("Exiting normally")
      ) {
        console.log("⚠️ FFmpeg closed (expected)");
        return;
      }

      // ✅ For unexpected errors (including SIGSEGV), restart after a delay
      console.error("❌ FFMPEG ERROR:", msg);
      cleanState(state);
      setTimeout(() => startStreaming(url, lang, ws, state), 1000);
    });

  state.ffmpegStream = ffmpegProc;

  // ✅ Guard: only pipe if recognizeStream is still alive
  if (state.recognizeStream && !state.recognizeStream.destroyed) {
    ffmpegProc.pipe(state.recognizeStream);
  }

  // ✅ Restart before Google's 5-minute streaming limit
  state.restartTimer = setTimeout(() => {
    console.log("🔄 Restarting stream (4.5min limit)");
    cleanState(state);
    setTimeout(() => startStreaming(url, lang, ws, state), 300);
  }, 270000);
}

wss.on("connection", (ws) => {
  console.log("🔥 Client connected");

  let isSwitching = false;

  let state = {
    recognizeStream: null,
    ffmpegStream: null,
    restartTimer: null,
  };

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "start") {
      if (isSwitching) return;
      isSwitching = true;

      const { url, lang } = data;
      console.log("🎧 START:", url);
      console.log("🌍 LANG:", lang);

      cleanState(state);

      setTimeout(() => {
        startStreaming(url, lang, ws, state);
        setTimeout(() => { isSwitching = false; }, 500);
      }, 300);
    }

    if (data.type === "stop") {
      console.log("🛑 STOP received");
      cleanState(state);
    }
  });

  ws.on("close", () => {
    console.log("❌ Client disconnected");
    cleanState(state);
  });
});
