export const pocketApi = 1;

const MAX_RECORDING_MS = 3 * 60 * 1000;
const MAX_RECORDING_BYTES = (MAX_RECORDING_MS / 1000) * 24000 * 2;
// One bar per 100 ms: half-speed scrolling and twice the visible audio history.
const WAVEFORM_HISTORY_STEP_MS = 100;

// PCM16, mono, 24 kHz: the wire format used by Codex dictation.
export function pcm24k(samples, rate) {
    const output = new Uint8Array(Math.floor((samples.length * 24000) / rate) * 2);
    const view = new DataView(output.buffer);

    for (let index = 0; index < output.length / 2; index++) {
        const position = (index * rate) / 24000;
        const left = Math.floor(position);
        const fraction = position - left;
        const value = Math.max(
            -1,
            Math.min(
                1,
                samples[left] * (1 - fraction) +
                    samples[Math.min(left + 1, samples.length - 1)] * fraction,
            ),
        );

        view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }

    return output;
}

function base64(bytes) {
    let text = "";

    for (const byte of bytes) {
        text += String.fromCharCode(byte);
    }

    return btoa(text);
}

export default function setup(pocket) {
    let current = null;
    let cancellation = 0;
    let disposed = false;
    const hidden = new Map();
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const providerKey = "x.codex-tools.provider";
    let provider = "codex";

    try {
        if (localStorage.getItem(providerKey) === "browser" && SpeechRecognition) {
            provider = "browser";
        }
    } catch {}

    const providerSelect = document.createElement("select");
    providerSelect.dataset.codexProvider = "true";
    providerSelect.setAttribute("aria-label", "Dictation provider");
    providerSelect.title =
        "Codex sends audio to OpenAI. Browser / Apple uses your browser vendor's speech service; on-device processing is not guaranteed. Browser mode has no audio levels.";
    providerSelect.style.cssText =
        "min-height:44px;max-width:10em;min-width:0;font:inherit;font-size:12px;color:var(--text);background:var(--card,var(--bg));border:1px solid var(--line);border-radius:8px";
    for (const [value, label] of [
        ["codex", "Codex"],
        ["browser", SpeechRecognition ? "Browser / Apple" : "Browser / Apple (unavailable)"],
    ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.disabled = value === "browser" && !SpeechRecognition;
        providerSelect.append(option);
    }
    providerSelect.value = provider;
    providerSelect.addEventListener("change", () => {
        cancel();
        provider = providerSelect.value === "browser" && SpeechRecognition ? "browser" : "codex";
        providerSelect.value = provider;
        try {
            localStorage.setItem(providerKey, provider);
        } catch {}
        status("idle");
        showProviderNotice();
    });
    const mic = document.createElement("button");
    const limitNotice = document.createElement("span");
    const waveform = document.createElement("button");
    const waveformCanvas = document.createElement("canvas");
    const waveformStop = document.createElement("span");

    waveform.type = "button";
    waveform.dataset.codexWaveform = "true";
    waveform.setAttribute("aria-label", "Stop dictation");
    waveform.title = "Stop dictation";
    waveform.hidden = true;
    waveform.style.cssText =
        "position:fixed;z-index:40;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--card,var(--bg,#17191e));color:var(--muted,#9ca3af);overflow:hidden;cursor:pointer;box-sizing:border-box";
    waveformCanvas.setAttribute("aria-hidden", "true");
    waveformCanvas.style.cssText =
        "position:absolute;left:44px;top:0;display:block;width:calc(100% - 44px);height:100%";
    waveformStop.setAttribute("aria-hidden", "true");
    waveformStop.style.cssText =
        "position:absolute;left:0;top:0;bottom:0;width:44px;display:grid;place-items:center;color:var(--text,#e8eaf0);pointer-events:none";
    waveformStop.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
    waveform.append(waveformCanvas, waveformStop);
    waveform.addEventListener("click", () => void finish());
    document.body.append(waveform);

    limitNotice.dataset.codexDictationLimit = "true";
    limitNotice.setAttribute("role", "status");
    limitNotice.setAttribute("aria-live", "polite");
    limitNotice.hidden = true;
    limitNotice.style.cssText =
        "color:var(--muted);font-size:11px;line-height:1.2;max-width:8em;flex-shrink:1";
    const icon =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>';

    const rotation = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? ""
        : '<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/>';
    const spinner = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity="0.25"/><g><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/>${rotation}</g></svg>`;

    mic.type = "button";
    mic.className = "icon-button";
    mic.dataset.codexDictation = "true";
    mic.dataset.part = "composer-button";
    mic.style.cssText = "min-width:44px;min-height:44px;flex-shrink:0";

    function status(state) {
        const label =
            state === "recording"
                ? "Stop dictation"
                : state === "connecting"
                  ? "Stop dictation (connecting)"
                  : state === "transcribing"
                    ? "Transcribing dictation"
                    : provider === "browser"
                      ? "Browser / Apple dictation"
                      : "Codex dictation";

        const loading = state === "connecting" || state === "transcribing";

        mic.dataset.state = state;
        mic.setAttribute("aria-label", label);
        mic.setAttribute("aria-pressed", String(state === "recording" || state === "connecting"));
        mic.setAttribute("aria-busy", String(loading));
        mic.title = label;
        mic.disabled = state === "transcribing";
        mic.style.color = state === "recording" ? "var(--err)" : loading ? "var(--accent)" : "";
        mic.innerHTML = loading ? spinner : icon;
        positionWaveform();
    }

    function positionWaveform() {
        const recording = current;

        if (!recording || recording.finishing || !sameBox(recording)) {
            waveform.hidden = true;

            return;
        }

        const rect = recording.box.getBoundingClientRect();

        waveform.hidden = rect.width <= 0 || rect.height <= 0;
        waveform.style.left = `${rect.left}px`;
        waveform.style.top = `${rect.top}px`;
        waveform.style.width = `${rect.width}px`;
        waveform.style.height = `${rect.height}px`;
    }

    function drawWaveform(recording) {
        const samples = new Uint8Array(recording.analyser?.fftSize || 0);
        const context = waveformCanvas.getContext("2d");
        const levels = [];
        let lastSampleAt = -Infinity;
        let previousLevel = 0;

        function paint() {
            if (disposed || current !== recording || recording.finishing) {
                return;
            }

            positionWaveform();

            if (context && !waveform.hidden) {
                const width = waveformCanvas.clientWidth;
                const height = waveformCanvas.clientHeight;
                const ratio = window.devicePixelRatio || 1;
                const pixelsWide = Math.max(1, Math.round(width * ratio));
                const pixelsHigh = Math.max(1, Math.round(height * ratio));

                if (waveformCanvas.width !== pixelsWide || waveformCanvas.height !== pixelsHigh) {
                    waveformCanvas.width = pixelsWide;
                    waveformCanvas.height = pixelsHigh;
                }

                const now = performance.now();

                if (now - lastSampleAt >= WAVEFORM_HISTORY_STEP_MS) {
                    recording.analyser?.getByteTimeDomainData(samples);
                    let energy = 0;

                    for (const sample of samples) {
                        energy += ((sample - 128) / 128) ** 2;
                    }

                    const level = samples.length
                        ? Math.min(1, Math.sqrt(energy / samples.length) * 6)
                        : 0;

                    previousLevel = Math.max(level, previousLevel * 0.8);
                    levels.push(previousLevel);

                    if (levels.length > 256) {
                        levels.shift();
                    }

                    lastSampleAt = now;
                }

                context.setTransform(ratio, 0, 0, ratio, 0, 0);
                context.clearRect(0, 0, width, height);
                context.strokeStyle = getComputedStyle(waveform).color;
                context.fillStyle = context.strokeStyle;
                context.lineWidth = 3;
                context.lineCap = "round";
                const count = Math.max(1, Math.floor((width - 8) / 7));
                const center = height / 2;
                const maximum = Math.max(2, Math.min(42, height - 12));

                for (let index = 0; index < count; index++) {
                    const level = levels[levels.length - count + index] ?? 0;
                    const barHeight = level * maximum;
                    const x = 4 + index * 7;

                    context.beginPath();

                    if (barHeight <= 3) {
                        context.arc(x, center, 1.5, 0, Math.PI * 2);
                        context.fill();
                    } else {
                        context.moveTo(x, center - barHeight / 2);
                        context.lineTo(x, center + barHeight / 2);
                        context.stroke();
                    }
                }
            }

            recording.waveFrame = requestAnimationFrame(paint);
        }

        paint();
    }

    function release(recording) {
        clearTimeout(recording.timer);
        clearInterval(recording.flushTimer);
        cancelAnimationFrame(recording.waveFrame);
        // Stop tracks first: a disconnected/closed node must not strand the microphone.
        for (const track of recording.stream?.getTracks() || []) {
            try {
                track.stop();
            } catch {}
        }
        for (const node of [
            recording.analyser,
            recording.processor,
            recording.source,
            recording.gain,
        ]) {
            try {
                node?.disconnect();
            } catch {}
        }
        try {
            void recording.context?.close().catch(() => {});
        } catch {}
        if (recording.recognition) {
            recording.recognition.onstart = null;
            recording.recognition.onresult = null;
            recording.recognition.onerror = null;
            recording.recognition.onend = null;
            try {
                recording.recognition.abort();
            } catch {}
            recording.resolveBrowser();
        }
    }

    function cancel() {
        cancellation++;
        const recording = current;

        current = null;

        if (recording) {
            recording.abort.abort();
            recording.rejectConnection(new Error("Dictation cancelled."));
            release(recording);
            const send = recording.box
                .closest('[data-part~="composer"]')
                ?.querySelector('[data-part~="send-button"]');

            if (send) {
                send.disabled = send.dataset.state !== "ready";
            }

            if (recording.id) {
                void pocket
                    .api(`recording/${recording.id}`, undefined, { method: "DELETE" })
                    .catch(() => {});
            }
        }

        status("idle");
    }

    function sameBox(recording) {
        return (
            !disposed &&
            current === recording &&
            pocket.conversationId() === recording.conversationId &&
            recording.box.isConnected &&
            !recording.box.disabled &&
            document.querySelector('[data-part~="composer"] textarea') === recording.box
        );
    }

    function trackEdit(recording) {
        const before = recording.rendered;
        const after = recording.box.value;

        if (before === after) {
            return;
        }

        let start = 0;
        let end = before.length;
        let nextEnd = after.length;

        while (start < end && start < nextEnd && before[start] === after[start]) {
            start++;
        }

        while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
            end--;
            nextEnd--;
        }

        const shift = nextEnd - end;

        if (end <= recording.at) {
            recording.at += shift;
            recording.end += shift;
        } else if (start < recording.end || recording.at === recording.end) {
            // An edit inside dictated words belongs to the user. Keep that edit,
            // then append only new speech after the current draft.
            recording.editedPrefix = recording.raw;
            recording.at = after.length;
            recording.end = after.length;
        }

        recording.rendered = after;
    }

    function renderTranscript(recording, raw, revision) {
        if (typeof revision === "number" && revision < recording.revision) {
            return;
        }

        if (typeof revision === "number") {
            recording.revision = revision;
        }

        if (!sameBox(recording) || typeof raw !== "string" || !raw.trim()) {
            return;
        }

        trackEdit(recording);

        if (!raw.startsWith(recording.editedPrefix)) {
            return;
        }

        const text = raw.slice(recording.editedPrefix.length).trim();
        const box = recording.box;
        const prefix =
            recording.at && !/\s$/.test(box.value.slice(0, recording.at)) && text ? " " : "";
        const suffix =
            recording.end < box.value.length && !/^\s/.test(box.value.slice(recording.end)) && text
                ? " "
                : "";
        const insert = prefix + text + suffix;

        if (box.value.slice(recording.at, recording.end) !== insert) {
            box.setRangeText(insert, recording.at, recording.end, "preserve");
            recording.end = recording.at + insert.length;
            recording.rendered = box.value;
            box.dispatchEvent(new Event("input", { bubbles: true }));
        }

        recording.raw = raw;
    }

    function flush(recording) {
        if (
            !recording.id ||
            !recording.bufferedBytes ||
            recording.queuedBytes ||
            recording.abort.signal.aborted
        ) {
            return;
        }

        const bytes = new Uint8Array(recording.bufferedBytes);
        let offset = 0;

        for (const chunk of recording.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }

        recording.chunks = [];
        recording.bufferedBytes = 0;
        recording.queuedBytes += bytes.length;

        if (recording.queuedBytes > 240000) {
            pocket.notify("error", "Dictation connection is too slow. Try again.");
            cancel();

            return;
        }

        // Serialize uploads to preserve PCM ordering and bound buffered audio.
        recording.upload = recording.upload
            .then(async () => {
                for (let at = 0; at < bytes.length; at += 48000) {
                    const result = await pocket.api(
                        `audio/${recording.id}`,
                        {
                            audio: base64(bytes.subarray(at, at + 48000)),
                        },
                        { signal: recording.abort.signal },
                    );

                    renderTranscript(recording, result.text, result.revision);
                }
            })
            .catch((failure) => {
                if (!disposed && !recording.abort.signal.aborted) {
                    pocket.notify("error", failure.message);
                }

                if (current === recording) {
                    cancel();
                }

                throw failure;
            })
            .finally(() => {
                recording.queuedBytes -= bytes.length;
            });
        void recording.upload.catch(() => {});
    }

    async function finish() {
        const recording = current;

        if (!recording || recording.finishing) {
            return;
        }

        recording.finishing = true;
        if (recording.provider !== "browser") {
            release(recording);
        }
        status("transcribing");
        let succeeded = false;

        try {
            if (recording.provider === "browser") {
                // stop() delivers the last phrase before onend; abort() would discard it.
                recording.stopTimer = setTimeout(() => {
                    recording.browserError = new Error("Browser speech did not finish. Try again.");
                    recording.resolveBrowser();
                }, 5000);
                try {
                    if (!recording.browserEnded) recording.recognition.stop();
                    await recording.browserDone;
                } finally {
                    clearTimeout(recording.stopTimer);
                    release(recording);
                }
                recording.abort.signal.throwIfAborted();
                if (recording.browserError) throw recording.browserError;
                if (!recording.raw.trim()) throw new Error("No speech recognized. Try again.");
                succeeded = sameBox(recording);
            } else {
                await recording.connection;
                flush(recording);
                await recording.upload;
                flush(recording);
                await recording.upload;
                recording.abort.signal.throwIfAborted();
                const result = await pocket.api(
                    `finish/${recording.id}`,
                    {},
                    { signal: recording.abort.signal },
                );

                if (!result.text?.trim() && !recording.raw) {
                    throw new Error("No speech recognized. Try again.");
                }

                renderTranscript(recording, result.text);
                succeeded = sameBox(recording);
            }
        } catch (failure) {
            if (!disposed && !recording.abort.signal.aborted) {
                pocket.notify("error", failure.message);
            }
        } finally {
            if (current === recording) {
                cancel();
            }
        }

        if (succeeded && recording.sendRequested) {
            const completedAt = cancellation;
            // Use Pocket's normal send path after it reconciles the final draft.
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );

            if (
                !disposed &&
                completedAt === cancellation &&
                !current &&
                pocket.conversationId() === recording.conversationId &&
                recording.box.isConnected
            ) {
                recording.box
                    .closest('[data-part~="composer"]')
                    ?.querySelector('[data-part~="send-button"]')
                    ?.click();
            }
        }
    }

    function finishAtLimit(recording) {
        if (current !== recording || recording.finishing || recording.abort.signal.aborted) {
            return;
        }

        limitNotice.textContent = "Stopped · 3-minute limit";
        limitNotice.hidden = false;
        void finish();
    }

    function showProviderNotice() {
        limitNotice.textContent =
            provider === "browser"
                ? "Browser/vendor processing · no audio levels (not guaranteed on-device)"
                : "";
        limitNotice.hidden = provider !== "browser";
    }

    function startBrowser(recording) {
        const completion = Promise.withResolvers();
        recording.browserDone = completion.promise;
        recording.resolveBrowser = completion.resolve;
        recording.phrases = [];

        try {
            const recognition = new SpeechRecognition();
            recording.recognition = recognition;
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = navigator.language || "en-US";
            recognition.onstart = () => {
                if (sameBox(recording) && !recording.finishing) status("recording");
            };
            recognition.onresult = (event) => {
                if (!sameBox(recording) || recording.abort.signal.aborted) return;
                // Web Speech results are cumulative; replace interim phrases rather
                // than appending them again when they become final.
                for (let index = event.resultIndex; index < event.results.length; index++) {
                    recording.phrases[index] = event.results[index][0]?.transcript || "";
                }
                recording.phrases.length = event.results.length;
                renderTranscript(recording, recording.phrases.join(" "));
            };
            recognition.onerror = (event) => {
                if (!sameBox(recording) || recording.abort.signal.aborted) return;
                recording.browserError = new Error(
                    `Browser speech: ${event.error || "recognition failed"}.`,
                );
                completion.resolve();
                void finish();
            };
            recognition.onend = () => {
                if (!sameBox(recording) || recording.abort.signal.aborted) return;
                recording.browserEnded = true;
                completion.resolve();
                void finish();
            };
            recognition.start();
            drawWaveform(recording);
            recording.timer = setTimeout(() => finishAtLimit(recording), MAX_RECORDING_MS);
        } catch (failure) {
            if (sameBox(recording)) {
                pocket.notify("error", failure.message);
                cancel();
            }
        }
    }

    async function start() {
        const box = document.querySelector('[data-part~="composer"] textarea');
        const conversationId = pocket.conversationId();

        if (!box || box.disabled || !conversationId || current || disposed) {
            return;
        }

        if (
            provider === "codex" &&
            (!navigator.mediaDevices?.getUserMedia || !window.AudioContext)
        ) {
            pocket.notify(
                "error",
                "Microphone recording requires HTTPS (or localhost) and a supported browser.",
            );

            return;
        }

        const connection = Promise.withResolvers();

        void connection.promise.catch(() => {});
        const recording = {
            provider,
            connection: connection.promise,
            rejectConnection: connection.reject,
            abort: new AbortController(),
            chunks: [],
            size: 0,
            box,
            conversationId,
            rendered: box.value,
            raw: "",
            revision: -1,
            editedPrefix: "",
            upload: Promise.resolve(),
            queuedBytes: 0,
            bufferedBytes: 0,
            // A mic tap appends to the draft, regardless of a saved caret/selection.
            at: box.value.length,
            end: box.value.length,
        };

        current = recording;
        showProviderNotice();
        status("connecting");
        placeMic();

        if (recording.provider === "browser") {
            startBrowser(recording);
            return;
        }

        try {
            // Create and resume during the tap, which iOS requires.
            recording.context = new AudioContext({ sampleRate: 24000 });
            await recording.context.resume();
            recording.stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
            });

            if (!sameBox(recording) || recording.abort.signal.aborted) {
                release(recording);

                return;
            }

            // iOS can suspend the context while microphone permission is open.
            if (recording.context.state !== "running") {
                await recording.context.resume();
            }

            if (!sameBox(recording) || recording.abort.signal.aborted) {
                release(recording);
                return;
            }

            if (recording.finishing) {
                throw new Error("Recording stopped before the microphone was ready.");
            }

            recording.source = recording.context.createMediaStreamSource(recording.stream);
            recording.analyser = recording.context.createAnalyser();
            recording.analyser.fftSize = 512;
            recording.processor = recording.context.createScriptProcessor(4096, 1, 1);
            recording.gain = recording.context.createGain();
            recording.gain.gain.value = 0;

            recording.processor.onaudioprocess = (event) => {
                if (recording.finishing || recording.abort.signal.aborted) {
                    return;
                }

                const chunk = pcm24k(
                    event.inputBuffer.getChannelData(0),
                    recording.context.sampleRate,
                );
                const bounded = chunk.subarray(0, MAX_RECORDING_BYTES - recording.size);

                recording.chunks.push(bounded);
                recording.bufferedBytes += bounded.length;
                recording.size += bounded.length;

                if (recording.bufferedBytes + recording.queuedBytes > 240000) {
                    pocket.notify(
                        "error",
                        "Dictation connection is too slow. Your transcript is preserved.",
                    );
                    cancel();

                    return;
                }

                if (recording.size >= MAX_RECORDING_BYTES) {
                    finishAtLimit(recording);
                }
            };

            recording.source.connect(recording.analyser);
            recording.analyser.connect(recording.processor);
            recording.processor.connect(recording.gain);
            recording.gain.connect(recording.context.destination);
            drawWaveform(recording);
            recording.timer = setTimeout(() => finishAtLimit(recording), MAX_RECORDING_MS);
            // Capture before the network handshake so early speech is not lost.
            const result = await pocket.api("start", {}, { signal: recording.abort.signal });

            recording.id = result.id;

            if (!sameBox(recording) || recording.abort.signal.aborted) {
                void pocket
                    .api(`recording/${recording.id}`, undefined, { method: "DELETE" })
                    .catch(() => {});
                release(recording);
                return;
            }

            connection.resolve();

            if (!recording.finishing) {
                recording.flushTimer = setInterval(() => flush(recording), 200);
                flush(recording);
                status("recording");
            }
        } catch (failure) {
            if (!disposed && !recording.abort.signal.aborted) {
                pocket.notify("error", failure.message);
            }

            if (current === recording) {
                cancel();
            }
        }
    }

    mic.addEventListener("click", () => {
        if (!current) {
            void start();
        } else {
            void finish();
        }
    });

    function placeMic() {
        const composer = document.querySelector('[data-part~="composer"]');
        const send = composer?.querySelector('[data-part~="send-button"]');

        if (current && !sameBox(current)) {
            cancel();
        }

        for (const [button, display] of hidden) {
            if (!button.isConnected) {
                button.style.display = display;
                hidden.delete(button);
            }
        }

        if (!send || !composer.querySelector("textarea")) {
            mic.remove();
            providerSelect.remove();
            limitNotice.remove();

            return;
        }

        for (const button of composer.querySelectorAll(".composer-mic")) {
            if (!hidden.has(button)) {
                hidden.set(button, button.style.display);
                button.style.display = "none";
            }
        }

        if (current && send.disabled) {
            send.disabled = false;
        }

        if (mic.nextElementSibling !== send) {
            send.before(mic);
        }

        if (providerSelect.nextElementSibling !== mic) {
            mic.before(providerSelect);
        }
        if (limitNotice.nextElementSibling !== providerSelect) {
            providerSelect.before(limitNotice);
        }

        positionWaveform();
    }

    const stopUpdates = pocket.on("dictation", (data) => {
        const recording = current;

        if (!recording || recording.provider !== "codex" || data.id !== recording.id) {
            return;
        }

        if (data.error) {
            pocket.notify("error", data.error);
            cancel();
        } else {
            renderTranscript(recording, data.text, data.revision);
        }
    });
    function sendRecording(event) {
        if (!current || !sameBox(current)) {
            return;
        }

        const isClick =
            event.type === "click" &&
            event.target.closest?.('[data-part~="send-button"]') ===
                current.box
                    .closest('[data-part~="composer"]')
                    ?.querySelector('[data-part~="send-button"]');
        const isEnter =
            event.type === "keydown" &&
            event.target === current.box &&
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.isComposing &&
            !window.matchMedia("(pointer: coarse)").matches;

        if (isClick || isEnter) {
            event.preventDefault();
            event.stopImmediatePropagation();
            current.sendRequested = true;
            void finish();
        }
    }

    document.addEventListener("click", sendRecording, true);
    document.addEventListener("keydown", sendRecording, true);
    const observer = new MutationObserver(placeMic);

    const onHidden = () => {
        if (document.hidden) {
            cancel();
        }
    };

    status("idle");
    showProviderNotice();
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled"],
    });
    document.addEventListener("visibilitychange", onHidden);
    placeMic();
    pocket.onDispose(() => {
        disposed = true;
        observer.disconnect();
        stopUpdates();
        document.removeEventListener("click", sendRecording, true);
        document.removeEventListener("keydown", sendRecording, true);
        document.removeEventListener("visibilitychange", onHidden);
        cancel();
        mic.remove();
        providerSelect.remove();
        limitNotice.remove();
        waveform.remove();

        for (const [button, display] of hidden) {
            button.style.display = display;
        }

        hidden.clear();
    });
    pocket.toolCall({
        tool: "codex_web_search",
        icon: "search",
        label: () => "Search the web",
        subject: (args) => args.query,
    });
}
