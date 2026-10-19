# Pi Pocket Codex Tools

Codex web search and voice dictation for [Pi Pocket](https://github.com/TannerMidd/pi-pocket).

- Web search through the Codex CLI and its existing login.
- Choose Codex dictation (`gpt-transcribe`, using Pi's OpenAI Codex sign-in) or Browser / Apple Web Speech.
- Append-to-draft behavior, sessions up to 3 minutes, and real scrolling microphone levels in Codex mode.

## Install

Requires Node.js 24+, Pi Pocket 0.14+, and HTTPS or localhost for microphone access. Web search also requires the Codex CLI.

Paste this into your clanker:

```text
Install Pi Pocket Codex Tools from https://github.com/SlightlyOffSync/pi-pocket-codex-tools.
Read the extension source.
Locate the active Pi Pocket data directory.
Copy codex-tools/index.js and codex-tools/types.d.ts into <data>/extensions/codex-tools/.
Copy codex-tools.ts into <data>/extensions/ last.
Use Pi Pocket's existing dependencies. Do not change credentials or enable the extension yourself.
Tell me to enable codex-tools in Menu → Extensions.
```

## Use

Ask Pi to search the web. Choose a dictation provider beside the mic, then tap the mic beside Send to dictate. Codex is the default. Your choice is saved in this browser under `x.codex-tools.provider` (when local storage is available).

- **Codex:** sends audio to OpenAI for transcription; requires Pi's OpenAI Codex sign-in. The extension does not save audio files. The waveform shows real microphone levels. Its history advances at 100 ms per bar: half the original scroll speed, showing twice as much time in the same space. Audio capture and transcription timing are unchanged.
- **Browser / Apple:** uses `SpeechRecognition` or `webkitSpeechRecognition`, when available. Your browser vendor controls speech processing and may send audio to its servers; this is **not a guarantee of on-device or private processing**, including on Apple devices. This mode does not use Codex routes, credentials, or the extension's audio capture pipeline. Browser speech exposes no microphone levels, so the display is a quiet line, not a live waveform. Availability and session duration depend on your browser; the option is disabled when the API is absent.

Changing providers cancels the current session (including pending transcription); text already inserted in the draft is preserved. The built-in Pocket mic remains hidden while this extension is active. This works with Pi Pocket 0.14 without a `pocket.dictation` API.

The microphone display covers the text box without changing your existing draft. Tap its stop icon to finish dictation. Tap Send to finalize the transcript and send the message.

Codex dictation defaults to English. Set `PI_CODEX_DICTATION_LANGUAGE` before server startup to use another language. Browser / Apple dictation uses the browser's language (`navigator.language`, falling back to `en-US`); it can show interim phrases that change as recognition completes. Stopping waits for the browser's final result before sending. Browser errors or permission denial leave your existing draft intact.

Switching conversations, hiding the page, or disabling the extension cancels capture. Codex resumes its audio context again after microphone permission if iPhone Safari suspended it during the permission prompt.

## Development checks

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

The browser tests use a standalone composer fixture with simulated microphone and
speech-recognition responses. They make no OpenAI requests and need no credentials
or real microphone. Tests can use an installed Chrome/Chromium, or an executable
specified with `CHROMIUM_EXECUTABLE_PATH`, instead of Playwright's Chromium.
They cover provider persistence/availability, Browser transcript revisions and
Stop/Send, provider-switch cancellation, permission-time audio interruptions, and
cleanup. Physical iPhone/Safari behavior still needs a device check; the extra
resume is defensive recovery, not a guarantee that every silent waveform is an
audio-context interruption. Browser speech has no audio levels by design.

## Credits

Dictation is adapted from [pi-codex-conversion](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion) by Igor Warzocha. Web search is adapted from [ayagmar/pi-codex-web-search](https://github.com/ayagmar/pi-codex-web-search).

[MIT licensed](LICENSE). Not affiliated with OpenAI.
