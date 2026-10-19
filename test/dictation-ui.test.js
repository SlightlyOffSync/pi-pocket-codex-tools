import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

let browser;
let server;
let base;
const source = await readFile(new URL("../codex-tools/index.js", import.meta.url), "utf8");
const mic = "[data-codex-dictation]";
const select = "[data-codex-provider]";
const box = "textarea";

before(async () => {
    server = createServer((request, response) => {
        response.setHeader(
            "content-type",
            request.url === "/plugin.js" ? "text/javascript" : "text/html",
        );
        response.end(
            request.url === "/plugin.js"
                ? source
                : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:8px;--text:#eee;--muted:#999;--bg:#222} [data-part="composer"]{display:flex;flex-wrap:wrap;max-width:100%;gap:4px} textarea{width:100%;box-sizing:border-box;height:60px}button{min-width:44px;min-height:44px}</style><div data-part="composer"><textarea></textarea><button class="composer-mic" aria-label="Native mic">Native</button><button data-part="send-button" data-state="ready">Send</button></div>`,
        );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const executablePath = [
        process.env.CHROMIUM_EXECUTABLE_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
    ].find((path) => path && existsSync(path));
    browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
});

async function fixture(t, { speech = true, storage = true } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(async () => {
        assert.deepEqual(errors, [], "no uncaught browser errors");
        await context.close();
    });
    await page.goto(base);
    await page.evaluate(
        ({ speech, storage }) => {
            localStorage.clear();
            if (!storage)
                Storage.prototype.setItem = Storage.prototype.getItem = () => {
                    throw new Error("blocked");
                };
            window.calls = [];
            window.notices = [];
            window.sent = 0;
            window.recognitions = [];
            window.tracks = [];
            window.interrupt = false;
            window.resumeGate = null;
            window.permissionGate = null;
            window.sample = 128;
            window.audio = [];
            const node = () => ({
                connect() {},
                disconnect() {
                    if (window.disconnectError) throw new Error("disconnected");
                },
            });
            window.AudioContext = class {
                sampleRate = 24000;
                state = "suspended";
                resumes = 0;
                destination = {};
                constructor() {
                    window.audio.push(this);
                }
                async resume() {
                    this.resumes++;
                    if (this.resumes > 1) await window.resumeGate?.promise;
                    this.state = "running";
                }
                close() {
                    this.state = "closed";
                    return Promise.resolve();
                }
                createMediaStreamSource() {
                    window.connected = true;
                    return node();
                }
                createAnalyser() {
                    return {
                        ...node(),
                        getByteTimeDomainData(samples) {
                            samples.fill(window.sample);
                        },
                    };
                }
                createScriptProcessor() {
                    return node();
                }
                createGain() {
                    return { ...node(), gain: {} };
                }
            };
            navigator.mediaDevices.getUserMedia = async () => {
                const track = {
                    readyState: "live",
                    stop() {
                        this.readyState = "ended";
                    },
                };
                window.tracks.push(track);
                await window.permissionGate?.promise;
                if (window.interrupt) window.audio.at(-1).state = "interrupted";
                return { getTracks: () => [track] };
            };
            window.SpeechRecognition = speech
                ? class {
                      constructor() {
                          window.recognitions.push(this);
                      }
                      start() {
                          this.onstart?.();
                      }
                      stop() {
                          this.stopped = true;
                          if (!window.holdEnd) this.onend?.();
                      }
                      abort() {
                          this.aborted = true;
                          this.onend?.();
                      }
                  }
                : undefined;
            window.webkitSpeechRecognition = undefined;
            document
                .querySelector('[data-part="send-button"]')
                .addEventListener("click", () => window.sent++);
            window.phrases = (words) => {
                const results = words.map((text) =>
                    Object.assign([{ transcript: text }], { isFinal: false }),
                );
                window.recognitions.at(-1).onresult?.({ resultIndex: 0, results });
            };
            window.pocket = {
                conversationId: () => 1,
                notify: (level, message) => window.notices.push({ level, message }),
                api: async (path) => {
                    window.calls.push(path);
                    return path === "start"
                        ? { id: "recording" }
                        : { text: "Codex words", revision: 1 };
                },
                on: (_event, callback) => {
                    window.update = callback;
                    return () => {};
                },
                onDispose: (callback) => {
                    window.dispose = callback;
                },
                toolCall() {},
            };
        },
        { speech, storage },
    );
    await page.evaluate(async () => (await import("/plugin.js")).default(window.pocket));
    return page;
}

async function until(page, expression) {
    await page.waitForFunction(expression, { timeout: 5000 });
}

test("waveform scrolls at half speed and retains twice the audio history", async (t) => {
    const page = await fixture(t);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.evaluate(() => document.querySelector("[data-codex-dictation]").click());
    await page.clock.runFor(100);
    await page.evaluate(() => {
        window.sample = 160;
        window.historyPixels = () => {
            const canvas = document.querySelector("[data-codex-waveform] canvas");
            const { width, height } = canvas;
            const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
            let painted = 0;
            for (let y = 0; y < height; y++) {
                if (Math.abs(y - height / 2) <= 4) continue;
                for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3]) painted++;
            }
            return painted;
        };
    });
    await page.clock.runFor(300);
    assert.ok(
        (await page.evaluate(() => window.historyPixels())) > 0,
        "speech paints real history",
    );
    await page.evaluate(() => (window.sample = 128));
    await page.clock.runFor(3500);
    assert.ok(
        (await page.evaluate(() => window.historyPixels())) > 0,
        "history remains beyond the old 50 ms/bar window",
    );
    await page.clock.runFor(4000);
    assert.equal(
        await page.evaluate(() => window.historyPixels()),
        0,
        "history eventually scrolls out into silence",
    );
    await page.evaluate(() => window.dispose());
});

test("provider choice is touch-friendly, persistent, and explicit about processing", async (t) => {
    const page = await fixture(t);
    assert.equal(await page.locator(select).inputValue(), "codex");
    await page.selectOption(select, "browser");
    assert.equal(
        await page.evaluate(() => localStorage.getItem("x.codex-tools.provider")),
        "browser",
    );
    assert.match(
        await page.locator("[data-codex-dictation-limit]").textContent(),
        /no audio levels/,
    );
    assert.match(
        await page.locator(select).getAttribute("title"),
        /on-device processing is not guaranteed/,
    );
    await page.evaluate(async () => {
        window.dispose();
        (await import("/plugin.js")).default(window.pocket);
    });
    assert.equal(await page.locator(select).inputValue(), "browser");
    for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
        );
        assert.ok(
            await page.locator(select).evaluate((el) => el.getBoundingClientRect().height >= 44),
        );
    }
});

test("missing browser recognition is disabled; blocked storage still permits Codex", async (t) => {
    const page = await fixture(t, { speech: false, storage: false });
    assert.equal(await page.locator(`${select} option[value=browser]`).isDisabled(), true);
    await page.click(mic);
    await until(page, "window.calls.includes('start')");
    await page.click(mic);
    await until(page, "window.calls.includes('finish/recording')");
});

test("Browser revisions and cumulative phrases update the draft without Codex or capture", async (t) => {
    const page = await fixture(t);
    await page.fill(box, "Draft");
    await page.selectOption(select, "browser");
    await page.click(mic);
    await page.evaluate(() => window.phrases(["hel"]));
    assert.equal(await page.locator(box).inputValue(), "Draft hel");
    await page.evaluate(() => window.phrases(["hello", "world"]));
    assert.equal(await page.locator(box).inputValue(), "Draft hello world");
    await page.click(mic);
    await until(page, "document.querySelector('[data-codex-dictation]').dataset.state === 'idle'");
    assert.deepEqual(
        await page.evaluate(() => [window.calls.length, window.audio.length, window.tracks.length]),
        [0, 0, 0],
    );
    assert.equal(await page.locator(box).inputValue(), "Draft hello world");
});

test("Browser Send waits for onend and sends the final result once", async (t) => {
    const page = await fixture(t);
    await page.selectOption(select, "browser");
    await page.click(mic);
    await page.evaluate(() => {
        window.holdEnd = true;
        window.phrases(["interim"]);
    });
    await page.click('[data-part="send-button"]');
    assert.equal(await page.evaluate(() => window.sent), 0);
    await page.evaluate(() => {
        window.phrases(["final words"]);
        window.recognitions.at(-1).onend();
    });
    await until(page, "window.sent === 1");
    assert.equal(await page.locator(box).inputValue(), "final words");
    assert.deepEqual(await page.evaluate(() => window.calls), []);
});

test("switching provider cancels pending recognition and ignores retained callbacks", async (t) => {
    const page = await fixture(t);
    await page.selectOption(select, "browser");
    await page.click(mic);
    await page.evaluate(() => {
        window.phrases(["saved words"]);
        window.late = window.recognitions.at(-1).onresult;
        window.holdEnd = true;
    });
    await page.click('[data-part="send-button"]');
    await page.selectOption(select, "codex");
    await page.evaluate(() =>
        window.late({ resultIndex: 0, results: [[{ transcript: "wrong late words" }]] }),
    );
    assert.equal(await page.locator(box).inputValue(), "saved words");
    assert.equal(await page.evaluate(() => window.recognitions.at(-1).aborted), true);
    assert.equal(await page.evaluate(() => window.sent), 0);
    await page.click(mic);
    await until(page, "window.calls.includes('start')");
});

test("natural Browser end preserves words; recognition error never automatically sends", async (t) => {
    const page = await fixture(t);
    await page.selectOption(select, "browser");
    await page.click(mic);
    await page.evaluate(() => {
        window.phrases(["natural words"]);
        window.recognitions.at(-1).onend();
    });
    await until(page, "document.querySelector('[data-codex-dictation]').dataset.state === 'idle'");
    assert.equal(await page.locator(box).inputValue(), "natural words");
    await page.click(mic);
    await page.evaluate(() => window.recognitions.at(-1).onerror({ error: "not-allowed" }));
    await until(page, "window.notices.length > 0");
    assert.match(await page.evaluate(() => window.notices.at(-1).message), /not-allowed/);
    assert.equal(await page.evaluate(() => window.sent), 0);
});

test("iPhone permission interruption resumes before connecting the graph", async (t) => {
    const page = await fixture(t);
    await page.evaluate(() => {
        window.interrupt = true;
        window.resumeGate = Promise.withResolvers();
    });
    await page.click(mic);
    await until(page, "window.audio[0].resumes === 2");
    assert.equal(await page.evaluate(() => Boolean(window.connected)), false);
    await page.evaluate(() => window.resumeGate.resolve());
    await until(page, "window.calls.includes('start')");
    await page.click(mic);
    assert.equal(
        await page.evaluate(() => window.tracks.every((track) => track.readyState === "ended")),
        true,
    );
});

test("provider switch during permission or resume releases late streams without connecting", async (t) => {
    for (const stage of ["permission", "resume"]) {
        const page = await fixture(t);
        await page.evaluate((stage) => {
            if (stage === "permission") window.permissionGate = Promise.withResolvers();
            else {
                window.interrupt = true;
                window.resumeGate = Promise.withResolvers();
            }
        }, stage);
        await page.click(mic);
        await until(
            page,
            stage === "permission" ? "window.tracks.length === 1" : "window.audio[0].resumes === 2",
        );
        await page.selectOption(select, "browser");
        await page.evaluate(
            (stage) => window[stage === "permission" ? "permissionGate" : "resumeGate"].resolve(),
            stage,
        );
        await until(page, "window.tracks.every(track => track.readyState === 'ended')");
        assert.equal(await page.evaluate(() => Boolean(window.connected)), false);
        assert.deepEqual(await page.evaluate(() => window.calls), []);
    }
});

test("Browser Stop timeout keeps the draft and does not send", async (t) => {
    const page = await fixture(t);
    await page.selectOption(select, "browser");
    await page.click(mic);
    await page.evaluate(() => {
        window.phrases(["keep these words"]);
        window.holdEnd = true;
        const schedule = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) =>
            schedule(callback, delay === 5000 ? 10 : delay, ...args);
    });
    await page.click('[data-part="send-button"]');
    await until(page, "window.notices.length > 0");
    assert.match(await page.evaluate(() => window.notices.at(-1).message), /did not finish/);
    assert.equal(await page.locator(box).inputValue(), "keep these words");
    assert.equal(await page.evaluate(() => window.sent), 0);
});

test("Browser interim revisions preserve unrelated draft edits", async (t) => {
    const page = await fixture(t);
    await page.fill(box, "Draft");
    await page.selectOption(select, "browser");
    await page.click(mic);
    await page.evaluate(() => {
        window.phrases(["hello"]);
        document.querySelector("textarea").value = "Edited draft hello";
        window.phrases(["hello world"]);
    });
    assert.equal(await page.locator(box).inputValue(), "Edited draft hello world");
    await page.click(mic);
});

test("cleanup errors cannot strand tracks, and disposal restores the native control", async (t) => {
    const page = await fixture(t);
    await page.click(mic);
    await until(page, "window.calls.includes('start')");
    await page.evaluate(() => {
        window.disconnectError = true;
        window.dispose();
    });
    assert.equal(
        await page.evaluate(() => window.tracks.every((track) => track.readyState === "ended")),
        true,
    );
    assert.equal(await page.locator(select).count(), 0);
    assert.equal(await page.locator(mic).count(), 0);
    assert.equal(await page.locator("[data-codex-waveform]").count(), 0);
    assert.equal(await page.locator(".composer-mic").evaluate((el) => el.style.display), "");
});
