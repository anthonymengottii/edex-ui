// LLM chat overlay panel.
// v1: local-only, talks directly to a local Ollama server (localhost:11434) from the
// renderer (nodeIntegration is on, so require("http") is available). Streams responses
// token-by-token from POST /api/chat (NDJSON). No API key / main-process proxy yet.
// Conversations are kept as a list and persisted to disk so they survive restarts.
class LLM {
    constructor(opts = {}) {
        this.host = opts.host || "127.0.0.1";
        this.port = opts.port || 11434;
        this.model = (window.settings && window.settings.llmModel) || "qwen2.5:3b";

        this.streaming = false;
        this.req = null;        // active http.ClientRequest, kept so stop() can abort it

        // Persistence: store conversations next to the eDEX settings.
        let dir;
        try { dir = require("@electron/remote").app.getPath("userData"); }
        catch (e) {
            try { dir = require("electron").remote.app.getPath("userData"); }
            catch (e2) { dir = require("os").tmpdir(); }
        }
        this._file = require("path").join(dir, "llm_chats.json");
        this.chats = [];        // [{id, title, model, messages:[{role,content}], updated}]
        this.activeId = null;

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
                    <button id="llm_clear" title="Clear this conversation"><p>CLEAR</p></button>
                    <button id="llm_close" title="Close (Esc)"><p>CLOSE</p></button>
                </div>
            </div>
            <div id="llm_body">
                <div id="llm_sidebar">
                    <button id="llm_new" title="New chat"><p>+ NEW CHAT</p></button>
                    <div id="llm_chatlist"></div>
                </div>
                <div id="llm_main">
                    <div id="llm_messages"></div>
                    <div id="llm_footer">
                        <textarea id="llm_input" rows="2" placeholder="Ask the model...   [ Enter ] send   [ Shift+Enter ] newline"></textarea>
                        <button id="llm_send"><p>SEND</p></button>
                        <button id="llm_stop" class="hidden"><p>STOP</p></button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(el);

        this.el = el;
        this.messagesEl = el.querySelector("#llm_messages");
        this.inputEl = el.querySelector("#llm_input");
        this.modelEl = el.querySelector("#llm_model");
        this.chatlistEl = el.querySelector("#llm_chatlist");

        // Wire controls
        el.querySelector("#llm_send").addEventListener("click", () => this.send());
        el.querySelector("#llm_stop").addEventListener("click", () => this.stop());
        el.querySelector("#llm_clear").addEventListener("click", () => this.clear());
        el.querySelector("#llm_close").addEventListener("click", () => this.hide());
        el.querySelector("#llm_new").addEventListener("click", () => this.newChat());
        this.modelEl.addEventListener("change", () => {
            this.model = this.modelEl.value;
            let chat = this._activeChat();
            if (chat) { chat.model = this.model; this._save(); }
        });
        this.chatlistEl.addEventListener("click", e => {
            let del = e.target.closest(".llm_chat_del");
            let item = e.target.closest(".llm_chat_item");
            if (!item) return;
            if (del) { e.stopPropagation(); this.deleteChat(item.dataset.id); }
            else this.switchChat(item.dataset.id);
        });
        this.inputEl.addEventListener("keydown", e => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.send();
            } else if (e.key === "Escape") {
                this.hide();
            }
        });

        this._load();
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

    // ---- conversation persistence & management -------------------------------

    _load() {
        try {
            let raw = require("fs").readFileSync(this._file, "utf8");
            let data = JSON.parse(raw);
            if (Array.isArray(data.chats)) this.chats = data.chats;
            this.activeId = data.activeId;
        } catch (e) { /* no saved chats yet */ }
        if (!this.chats.length) {
            this.newChat();   // also renders + saves
            return;
        }
        if (!this._activeChat()) this.activeId = this.chats[0].id;
        this._renderChatList();
        this._renderConversation();
    }

    _save() {
        try {
            require("fs").writeFileSync(this._file, JSON.stringify({activeId: this.activeId, chats: this.chats}, null, 0));
        } catch (e) { /* disk error - non-fatal */ }
    }

    _id() {
        try { return require("nanoid").nanoid(); }
        catch (e) { return "c" + Date.now() + Math.random().toString(36).slice(2, 7); }
    }

    _activeChat() {
        return this.chats.find(c => c.id === this.activeId);
    }

    newChat() {
        if (this.streaming) this.stop();
        let chat = {id: this._id(), title: "New chat", model: this.model, messages: [], updated: Date.now()};
        this.chats.unshift(chat);
        this.activeId = chat.id;
        this._renderChatList();
        this._renderConversation();
        this._save();
        if (window.audioManager) window.audioManager.folder.play();
        if (this.inputEl) this.inputEl.focus();
    }

    switchChat(id) {
        if (id === this.activeId) return;
        if (this.streaming) this.stop();
        this.activeId = id;
        let chat = this._activeChat();
        if (chat && chat.model) { this.model = chat.model; this._selectModel(chat.model); }
        this._renderChatList();
        this._renderConversation();
        this._save();
        if (window.audioManager) window.audioManager.folder.play();
        this.inputEl.focus();
    }

    deleteChat(id) {
        this.chats = this.chats.filter(c => c.id !== id);
        if (window.audioManager) window.audioManager.denied.play();
        if (this.activeId === id) {
            if (this.chats.length) {
                this.activeId = this.chats[0].id;
            } else {
                this.newChat();
                return;
            }
        }
        this._renderChatList();
        this._renderConversation();
        this._save();
    }

    clear() {
        if (this.streaming) this.stop();
        let chat = this._activeChat();
        if (chat) { chat.messages = []; chat.updated = Date.now(); }
        this.messagesEl.innerHTML = "";
        this._renderChatList();
        this._save();
        if (window.audioManager) window.audioManager.denied.play();
    }

    _renderChatList() {
        this.chatlistEl.innerHTML = this.chats.map(c => `
            <div class="llm_chat_item ${c.id === this.activeId ? "active" : ""}" data-id="${this._esc(c.id)}">
                <p class="llm_chat_title">${this._esc(c.title || "New chat")}</p>
                <span class="llm_chat_time">${this._time(c.updated)}</span>
                <button class="llm_chat_del" title="Delete chat">×</button>
            </div>`).join("");
    }

    _renderConversation() {
        this.messagesEl.innerHTML = "";
        let chat = this._activeChat();
        if (!chat) return;
        chat.messages.forEach(m => this._renderMessage(m.role, m.content));
    }

    _title(text) {
        let t = String(text).replace(/\s+/g, " ").trim();
        return t.length > 38 ? t.slice(0, 38) + "…" : (t || "New chat");
    }

    _time(ts) {
        if (!ts) return "";
        let d = new Date(ts), now = new Date();
        let p = n => ("0" + n).slice(-2);
        if (d.toDateString() === now.toDateString()) return p(d.getHours()) + ":" + p(d.getMinutes());
        return p(d.getDate()) + "/" + p(d.getMonth() + 1);
    }

    _selectModel(name) {
        if (!this.modelEl) return;
        for (let o of this.modelEl.options) {
            if (o.value === name) { this.modelEl.value = name; return; }
        }
    }

    // ---- model list & sending ------------------------------------------------

    loadModels() {
        require("http").get({host: this.host, port: this.port, path: "/api/tags"}, res => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                let names = [];
                try { names = JSON.parse(raw).models.map(m => m.name); } catch (e) { /* keep default */ }
                let active = this._activeChat();
                let want = (active && active.model) || this.model;
                if (!names.includes(want) && names.length) want = names[0];
                this.model = want;
                this.modelEl.innerHTML = names.length
                    ? names.map(n => `<option ${n === want ? "selected" : ""}>${this._esc(n)}</option>`).join("")
                    : `<option>${this._esc(want)}</option>`;
            });
        }).on("error", () => {
            this.modelEl.innerHTML = `<option>${this._esc(this.model)}</option>`;
        });
    }

    send() {
        if (this.streaming) return;
        let text = this.inputEl.value.trim();
        if (!text) return;

        let chat = this._activeChat();
        if (!chat) { this.newChat(); chat = this._activeChat(); }

        this.inputEl.value = "";
        chat.messages.push({role: "user", content: text});
        if (chat.messages.filter(m => m.role === "user").length === 1) chat.title = this._title(text);
        chat.model = this.model;
        chat.updated = Date.now();
        this._renderMessage("user", text);
        this._renderChatList();
        this._save();

        // Create the assistant bubble we'll stream into.
        let bubble = this._renderMessage("assistant", "");
        let assistant = {role: "assistant", content: ""};
        let thinking = true;
        bubble.classList.add("thinking");
        bubble.innerHTML = "<em>thinking…</em>";

        this._setStreaming(true);

        let payload = JSON.stringify({model: this.model, messages: chat.messages, stream: true});
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
                    if (obj.done) this._finish(assistant, bubble, chat);
                }
            });
            res.on("end", () => this._finish(assistant, bubble, chat));
        });
        this.req.on("error", e => {
            if (!this.streaming) return; // aborted via stop()
            bubble.classList.remove("thinking");
            bubble.classList.add("error");
            bubble.innerHTML = this._esc("⚠ Could not reach Ollama at " + this.host + ":" + this.port + " — is the service running? (" + (e.code || e.message) + ")");
            this._finish(null, bubble, chat);
        });
        this.req.write(payload);
        this.req.end();
    }

    stop() {
        if (this.req) { try { this.req.destroy(); } catch (e) { /* already gone */ } }
        this._setStreaming(false);
    }

    _finish(assistant, bubble, chat) {
        if (!this.streaming) return;
        if (assistant && chat) {
            if (assistant.content) {
                chat.messages.push(assistant);
                chat.updated = Date.now();
            } else if (bubble && !bubble.classList.contains("error")) {
                // Empty answer (e.g. aborted before any token) — drop the dangling bubble.
                bubble.parentElement && bubble.parentElement.remove();
            }
            this._renderChatList();
            this._save();
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
