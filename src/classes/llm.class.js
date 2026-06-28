// LLM chat overlay panel.
// v1: local-only, talks directly to a local Ollama server (localhost:11434) from the
// renderer (nodeIntegration is on, so require("http") is available). Streams responses
// token-by-token from POST /api/chat (NDJSON). No API key / main-process proxy yet.
class LLM {
    constructor(opts = {}) {
        this.host = opts.host || "127.0.0.1";
        this.port = opts.port || 11434;
        this.model = (window.settings && window.settings.llmModel) || "qwen2.5:3b";

        this.messages = [];     // [{role, content}] conversation history sent to the model
        this.streaming = false;
        this.req = null;        // active http.ClientRequest, kept so stop() can abort it

        // Inject the overlay into <body> (not a column - it floats over the central area).
        let el = document.createElement("section");
        el.setAttribute("id", "llm");
        el.setAttribute("class", "hidden");
        el.setAttribute("augmented-ui", "bl-clip tr-clip exe");
        el.innerHTML = `
            <div id="llm_bg"></div>
            <div id="llm_header">
                <h1>LLM<i>COCKPIT</i></h1>
                <select id="llm_model" title="Model"></select>
                <div id="llm_header_actions">
                    <button id="llm_clear" title="Clear conversation"><p>CLEAR</p></button>
                    <button id="llm_close" title="Close (Esc)"><p>CLOSE</p></button>
                </div>
            </div>
            <div id="llm_messages"></div>
            <div id="llm_footer">
                <textarea id="llm_input" rows="2" placeholder="Ask the model...   [ Enter ] send   [ Shift+Enter ] newline"></textarea>
                <button id="llm_send"><p>SEND</p></button>
                <button id="llm_stop" class="hidden"><p>STOP</p></button>
            </div>`;
        document.body.appendChild(el);

        this.el = el;
        this.messagesEl = el.querySelector("#llm_messages");
        this.inputEl = el.querySelector("#llm_input");
        this.modelEl = el.querySelector("#llm_model");

        // Wire controls
        el.querySelector("#llm_send").addEventListener("click", () => this.send());
        el.querySelector("#llm_stop").addEventListener("click", () => this.stop());
        el.querySelector("#llm_clear").addEventListener("click", () => this.clear());
        el.querySelector("#llm_close").addEventListener("click", () => this.hide());
        this.modelEl.addEventListener("change", () => { this.model = this.modelEl.value; });
        this.inputEl.addEventListener("keydown", e => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.send();
            } else if (e.key === "Escape") {
                this.hide();
            }
        });

        this.loadModels();
    }

    show() {
        this.el.classList.remove("hidden");
        if (window.audioManager) window.audioManager.expand.play();
        // Stop the eDEX keyboard from forwarding keystrokes (and stealing focus
        // back) to the terminal while the chat input is focused.
        if (window.keyboard) window.keyboard.detach();
        setTimeout(() => this.inputEl.focus(), 50);
    }
    hide() {
        this.el.classList.add("hidden");
        if (window.audioManager) window.audioManager.denied.play();
        // Re-link the keyboard and return focus to the active terminal.
        if (window.keyboard) window.keyboard.attach();
        try { window.term[window.currentTerm].term.focus(); } catch (e) { /* no term */ }
    }
    toggle() {
        if (this.el.classList.contains("hidden")) this.show();
        else this.hide();
    }

    loadModels() {
        require("http").get({host: this.host, port: this.port, path: "/api/tags"}, res => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                let names = [];
                try { names = JSON.parse(raw).models.map(m => m.name); } catch (e) { /* keep default */ }
                if (!names.includes(this.model) && names.length) this.model = names[0];
                this.modelEl.innerHTML = names.length
                    ? names.map(n => `<option ${n === this.model ? "selected" : ""}>${this._esc(n)}</option>`).join("")
                    : `<option>${this._esc(this.model)}</option>`;
            });
        }).on("error", () => {
            this.modelEl.innerHTML = `<option>${this._esc(this.model)}</option>`;
        });
    }

    send() {
        if (this.streaming) return;
        let text = this.inputEl.value.trim();
        if (!text) return;

        this.inputEl.value = "";
        this.messages.push({role: "user", content: text});
        this._renderMessage("user", text);

        // Create the assistant bubble we'll stream into.
        let bubble = this._renderMessage("assistant", "");
        let assistant = {role: "assistant", content: ""};
        let thinking = true;
        bubble.classList.add("thinking");
        bubble.innerHTML = "<em>thinking…</em>";

        this._setStreaming(true);

        let payload = JSON.stringify({model: this.model, messages: this.messages, stream: true});
        this.req = require("http").request({
            host: this.host,
            port: this.port,
            path: "/api/chat",
            method: "POST",
            headers: {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload)}
        }, res => {
            let buffer = "";
            res.on("data", chunk => {
                buffer += chunk.toString();
                let lines = buffer.split("\n");
                buffer = lines.pop();   // keep the last (possibly partial) line for the next chunk
                for (let line of lines) {
                    line = line.trim();
                    if (!line) continue;
                    let obj;
                    try { obj = JSON.parse(line); } catch (e) { continue; }
                    if (obj.message && obj.message.content) {
                        if (thinking) { thinking = false; bubble.classList.remove("thinking"); }
                        assistant.content += obj.message.content;
                        bubble.innerHTML = this._format(assistant.content);
                        if (window.audioManager) window.audioManager.stdout.play();
                        this._scroll();
                    }
                    if (obj.done) this._finish(assistant, bubble);
                }
            });
            res.on("end", () => this._finish(assistant, bubble));
        });
        this.req.on("error", e => {
            if (!this.streaming) return; // aborted via stop()
            bubble.classList.remove("thinking");
            bubble.classList.add("error");
            bubble.innerHTML = this._esc("⚠ Could not reach Ollama at " + this.host + ":" + this.port + " — is the service running? (" + (e.code || e.message) + ")");
            this._finish(null, bubble);
        });
        this.req.write(payload);
        this.req.end();
    }

    stop() {
        if (this.req) { try { this.req.destroy(); } catch (e) { /* already gone */ } }
        this._setStreaming(false);
    }

    clear() {
        if (this.streaming) this.stop();
        this.messages = [];
        this.messagesEl.innerHTML = "";
        if (window.audioManager) window.audioManager.denied.play();
    }

    _finish(assistant, bubble) {
        if (!this.streaming) return;
        if (assistant) {
            // Empty answer (e.g. aborted before any token) — drop the dangling history entry.
            if (assistant.content) this.messages.push(assistant);
            if (!assistant.content && bubble && !bubble.classList.contains("error")) {
                bubble.parentElement && bubble.parentElement.remove();
            }
        }
        this.req = null;
        this._setStreaming(false);
    }

    _setStreaming(on) {
        this.streaming = on;
        this.el.querySelector("#llm_send").classList.toggle("hidden", on);
        this.el.querySelector("#llm_stop").classList.toggle("hidden", !on);
    }

    _renderMessage(role, text) {
        let row = document.createElement("div");
        row.setAttribute("class", "llm_msg llm_" + role);
        let bubble = document.createElement("div");
        bubble.setAttribute("class", "llm_bubble");
        bubble.innerHTML = this._format(text);
        row.appendChild(bubble);
        this.messagesEl.appendChild(row);
        this._scroll();
        return bubble;
    }

    _scroll() {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    _esc(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Minimal markdown: fenced ``` code blocks -> <pre>, inline `code` -> <code>, rest escaped
    // with newlines preserved. No external lib; syntax highlighting is a later concern.
    _format(text) {
        let parts = String(text).split(/```/);
        let out = "";
        parts.forEach((part, i) => {
            if (i % 2 === 1) {
                // inside a code fence; strip an optional language tag on the first line
                let body = part.replace(/^[^\n]*\n/, m => (/^[a-zA-Z0-9_+-]*\s*$/.test(m.trim()) ? "" : m));
                out += `<pre>${this._esc(body)}</pre>`;
            } else {
                let safe = this._esc(part).replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
                out += safe.replace(/\n/g, "<br>");
            }
        });
        return out;
    }
}

module.exports = { LLM };
