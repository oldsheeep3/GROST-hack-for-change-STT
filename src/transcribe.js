// src/live_transcribe.js
// Node.js 18対策
const { File } = require('node:buffer');
globalThis.File = File;

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); 

const fs = require('fs');
const OpenAI = require('openai');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
const WebSocket = require('ws');

// 設定
const SEGMENT_TIME = 6; // 何秒ごとに文字起こしするか（短すぎると文脈が切れる、長いとラグになる）
const OUTPUT_DIR = path.resolve(__dirname, '../segments'); // 一時ファイルの保存場所
// ★ここにHLSのURLを入れる！
const HLS_URL = process.env.HLS_URL; // HLS配信のURL
const TTS_WS_URL = process.env.TTS_WS_URL; // テキスト送信先のTTSサーバー（WebSocket）

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// TTS WebSocketクライアント（簡易リトライ付き）
class TtsWebSocketClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.ready = false;
    this.queue = [];
    this.connecting = false;
    this.closed = false;
    this.connect();
  }

  connect() {
    if (this.connecting || this.ready || this.closed) return;
    this.connecting = true;
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.ready = true;
      this.connecting = false;
      this.flushQueue();
      console.log(`[TTS WS] connected: ${this.url}`);
    });

    this.ws.on('close', () => {
      this.ready = false;
      this.connecting = false;
      this.ws = null;
      if (!this.closed) {
        setTimeout(() => this.connect(), 1000);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[TTS WS] error: ${err.message}`);
    });
  }

  async sendText(text) {
    if (!text || !text.trim()) return;
    const payload = JSON.stringify({ type: 'text', text });

    if (this.ready && this.ws) {
      await new Promise((resolve, reject) => {
        this.ws.send(payload, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return;
    }

    this.queue.push(payload);
    if (!this.connecting) this.connect();
  }

  flushQueue() {
    while (this.queue.length && this.ready && this.ws) {
      const payload = this.queue.shift();
      this.ws.send(payload);
    }
  }

  close() {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // ignore
      }
    }
  }
}

const ttsClient = TTS_WS_URL ? new TtsWebSocketClient(TTS_WS_URL) : null;

// 文字起こし結果の送信先
async function passToNextStep(text) {
  console.log(`🚀 送信: "${text}"`);

  if (!ttsClient) {
    console.warn('⚠️ TTS_WS_URL が設定されていないため、送信をスキップします');
    return;
  }

  try {
    await ttsClient.sendText(text);
  } catch (err) {
    console.error(`⚠️ TTSサーバーへの送信に失敗しました: ${err.message}`);
  }
}

async function main() {
  console.log("🔴 ライブ文字起こしシステム起動！");

  // 1. 一時フォルダを初期化（前回のゴミを削除）
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR);

  // 2. FFmpegを起動してMP3ストリームをパイプで取得
  console.log(`🎥 ストリーム受信開始: ${HLS_URL}`);
  const ffmpeg = spawn('ffmpeg', [
    '-i', HLS_URL,
    '-c:a', 'libmp3lame',    // MP3エンコーダ
    '-ac', '1',              // モノラル
    '-ab', '128k',           // ビットレート
    '-q:a', '7',             // MP3品質（7=中品質）
    '-f', 'mp3',             // MP3形式で出力
    'pipe:1'                 // 標準出力にパイプ
  ]);

  // FFmpegのエラーログ
  ffmpeg.stderr.on('data', (data) => {
    // デバッグ時は外す
    // console.log(`ffmpeg: ${data}`);
  });

  // 3. パイプから音声バッファを定期的に切り出す
  let audioBuffer = Buffer.alloc(0);
  let segmentIndex = 0;
  let processingSegment = false;

  ffmpeg.stdout.on('data', async (chunk) => {
    audioBuffer = Buffer.concat([audioBuffer, chunk]);
    
    // SEGMENT_TIME秒分のバイト数が溜まったらセグメント化
    // MP3 128kbps = 16000 bytes/sec ≈ 6秒で96000バイト
    const BYTES_PER_SEGMENT = Math.floor(128000 * SEGMENT_TIME / 8);
    
    if (audioBuffer.length >= BYTES_PER_SEGMENT && !processingSegment) {
      processingSegment = true;
      
      const segmentBuffer = audioBuffer.slice(0, BYTES_PER_SEGMENT);
      audioBuffer = audioBuffer.slice(BYTES_PER_SEGMENT);
      
      const segmentPath = path.join(OUTPUT_DIR, `out${String(segmentIndex).padStart(3, '0')}.mp3`);
      segmentIndex++;
      
      fs.writeFileSync(segmentPath, segmentBuffer);
      console.log(`\n📂 新しい音声チャンクを検知: ${path.basename(segmentPath)}`);
      
      try {
        // Whisperに投げる
        const audioFile = fs.createReadStream(segmentPath);
        const transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-1",
          language: "ja",
          response_format: "verbose_json",
        });

        // 結果を処理
        if (transcription.segments) {
          for (const segment of transcription.segments) {
            const text = segment.text.trim();
            if (text.length > 0) await passToNextStep(text);
          }
        } else {
          if (transcription.text.trim().length > 0) await passToNextStep(transcription.text);
        }

        // ファイル削除
        fs.unlinkSync(segmentPath);
        console.log(`🗑️ 処理完了・削除: ${path.basename(segmentPath)}`);

      } catch (err) {
        console.error(`😭 エラー (${path.basename(segmentPath)}):`, err.message);
      } finally {
        processingSegment = false;
      }
    }
  });

  ffmpeg.on('close', (code) => {
    console.log(`[FFmpeg] 終了 (code: ${code})`);
  });

  console.log(`👀 ${SEGMENT_TIME}秒ごとに音声を切り出して処理中...`);
}

main();

process.on('SIGINT', () => {
  ttsClient?.close();
  process.exit(0);
});