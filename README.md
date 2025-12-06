# STT to TTS bridge

## Setup
- Install deps: `pnpm install`
- Create `.env` with:
	- `OPENAI_API_KEY=...`
	- `TTS_WS_URL=ws://<your-tts-server-host>/ws/tts`

## Run
- Start live transcription: `pnpm start`
- The script cuts HLS audio, transcribes via Whisper, and forwards each sentence to the TTS WebSocket server.

