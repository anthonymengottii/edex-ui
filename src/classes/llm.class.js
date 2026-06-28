// LLM chat overlay panel.
// v1: local-only, talks directly to a local Ollama server (localhost:11434) from the
// renderer (nodeIntegration is on, so require("http") is available). Streams responses
// token-by-token from POST /api/chat (NDJSON). No API key / main-process proxy yet.
// Conversations are kept as a list and persisted to disk so they survive restarts.

// Guided builder mode: a system prompt that steers the (weak, local) model through a
// 3-phase method. The phase buttons explicitly push the model forward so it doesn't
// have to self-manage the flow.
const BUILDER_SYSTEM = `Você é um construtor guiado de funcionalidades, trabalhando em fases. Responda SEMPRE em português, de forma concisa, e use blocos \`\`\` para qualquer código.

FASE 1 - ESCOPO: se o objetivo ainda estiver vago, faça poucas perguntas curtas e objetivas para esclarecer requisitos. NÃO planeje nem escreva código ainda.

FASE 2 - PLANO: quando o escopo estiver claro (ou quando pedirem o plano), produza um plano numerado contendo: arquivos a criar/editar, passos em ordem, riscos e como verificar o resultado. Sem código completo ainda.

FASE 3 - CÓDIGO: quando pedirem, gere o código de UM passo do plano por vez, completo e pronto para colar, explicando em 1-2 linhas onde vai.

Avance de fase conforme o usuário pedir.`;

const PHASE_PROMPTS = {
    plan: "O escopo está claro. Gere agora o PLANO completo: arquivos a criar/editar, passos em ordem, riscos e como verificar.",
    next: "Gere o código do PRÓXIMO passo do plano, completo e pronto para colar, dizendo onde vai.",
    review: "Revise o plano atual considerando riscos, simplificações e o que pode dar errado. Sugira melhorias."
};

// Response style steering. Cycled per conversation; injected as part of the system prompt.
const STYLE_ORDER = ["normal", "concise", "caveman"];
const STYLE_LABELS = {normal: "NORMAL", concise: "CONCISO", caveman: "CAVEMAN"};
const STYLE_PROMPTS = {
    normal: "",
    concise: "Seja conciso e direto: sem preâmbulos, sem repetição, sem enrolação. Responda só o essencial, em poucas frases curtas. Mantenha blocos ``` para código. Responda em português.",
    caveman: "Fale estilo caveman: corte artigos (o/a/um/uns) e palavras de preenchimento (só/realmente/basicamente), use fragmentos curtos, bem cru. Mantenha a precisão técnica e os blocos ``` de código intactos. Responda em português."
};

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
                <h1>LLM<i id="llm_subtitle">COCKPIT</i></h1>
                <select id="llm_model" title="Model"></select>
                <button id="llm_style" title="Response style (Normal / Concise / Caveman)"><p>NORMAL</p></button>
                <button id="llm_mode" title="Toggle guided builder mode"><p>CHAT</p></button>
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
                    <div id="llm_phases">
                        <span class="llm_phase_label">BUILDER</span>
                        <button class="llm_phase" data-phase="plan"><p>GERAR PLANO</p></button>
                        <button class="llm_phase" data-phase="next"><p>PRÓXIMO PASSO</p></button>
                        <button class="llm_phase" data-phase="review"><p>REVISAR</p></button>
                    </div>
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
        this.modeEl = el.querySelector("#llm_mode");
        this.styleEl = el.querySelector("#llm_style");

        // Wire controls
        el.querySelector("#llm_send").addEventListener("click", () => this.send());
        el.querySelector("#llm_stop").addEventListener("click", () => this.stop());
        el.querySelector("#llm_clear").addEventListener("click", () => this.clear());
        el.querySelector("#llm_close").addEventListener("click", () => this.hide());
        el.querySelector("#llm_new").addEventListener("click", () => this.newChat());
        this.modeEl.addEventListener("click", () => this.toggleMode());
        this.styleEl.addEventListener("click", () => this.cycleStyle());
        el.querySelectorAll(".llm_phase").forEach(b => {
            b.addEventListener("click", () => this._phase(b.dataset.phase));
        });
        // Copy button on rendered code blocks.
        this.messagesEl.addEventListener("click", e => {
            let btn = e.target.closest(".llm_copy");
            if (!btn) return;
            let pre = btn.parentElement.querySelector("pre");
            if (pre) this._copy(pre.innerText, btn);
        });
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

    // ---- guided builder mode -------------------------------------------------

    toggleMode() {
        let chat = this._activeChat();
        if (!chat) return;
        chat.mode = (chat.mode === "builder") ? "chat" : "builder";
        this._updateMode();
        this._save();
        if (window.audioManager) window.audioManager.scan.play();
        this.inputEl.focus();
    }

    // Reflect the active chat's mode + style in the UI.
    _updateMode() {
        let chat = this._activeChat();
        let builder = !!(chat && chat.mode === "builder");
        this.el.classList.toggle("builder", builder);
        this.modeEl.querySelector("p").innerText = builder ? "BUILDER" : "CHAT";
        let sub = this.el.querySelector("#llm_subtitle");
        if (sub) sub.innerText = builder ? "BUILDER" : "COCKPIT";

        let style = (chat && chat.style) || "normal";
        this.styleEl.querySelector("p").innerText = STYLE_LABELS[style] || "NORMAL";
        this.styleEl.classList.toggle("active", style !== "normal");
    }

    cycleStyle() {
        let chat = this._activeChat();
        if (!chat) return;
        let i = STYLE_ORDER.indexOf(chat.style || "normal");
        chat.style = STYLE_ORDER[(i + 1) % STYLE_ORDER.length];
        this._updateMode();
        this._save();
        if (window.audioManager) window.audioManager.scan.play();
        this.inputEl.focus();
    }

    // Combined system prompt for the active chat: builder steering (if on) + style.
    _systemPrompt(chat) {
        let parts = [];
        if (chat.mode === "builder") parts.push(BUILDER_SYSTEM);
        let style = STYLE_PROMPTS[chat.style || "normal"];
        if (style) parts.push(style);
        return parts.length ? parts.join("\n\n") : null;
    }

    _phase(kind) {
        let text = PHASE_PROMPTS[kind];
        if (text) this._quick(text);
    }

    _quick(text) {
        if (this.streaming) return;
        this.inputEl.value = text;
        this.send();
    }

    _copy(text, btn) {
        let done = () => {
            if (!btn) return;
            let p = btn.querySelector("p") || btn;
            let old = p.innerText;
            p.innerText = "COPIED";
            setTimeout(() => { p.innerText = old; }, 1200);
        };
        try {
            navigator.clipboard.writeText(text).then(done, () => this._copyFallback(text, done));
        } catch (e) {
            this._copyFallback(text, done);
        }
    }
    _copyFallback(text, done) {
        try {
            let t = document.createElement("textarea");
            t.value = text;
            document.body.appendChild(t);
            t.select();
            document.execCommand("copy");
            document.body.removeChild(t);
            done();
        } catch (e) { /* clipboard unavailable */ }
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
        this._updateMode();
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
        let chat = {id: this._id(), title: "New chat", model: this.model, mode: "chat", style: "normal", messages: [], updated: Date.now()};
        this.chats.unshift(chat);
        this.activeId = chat.id;
        this._renderChatList();
        this._renderConversation();
        this._updateMode();
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
        this._updateMode();
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

        // Prepend the steering system prompt (builder + style), not stored in history.
        let system = this._systemPrompt(chat);
        let outMessages = system
            ? [{role: "system", content: system}, ...chat.messages]
            : chat.messages;
        let payload = JSON.stringify({model: this.model, messages: outMessages, stream: true});
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
                out += `<div class="llm_pre_wrap"><button class="llm_copy" title="Copy"><p>COPY</p></button><pre>${this._esc(body)}</pre></div>`;
            } else {
                let safe = this._esc(part).replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
                out += safe.replace(/\n/g, "<br>");
            }
        });
        return out;
    }
}

module.exports = { LLM };
