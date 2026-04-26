/**
 * @fileoverview VoteGuru AI — Frontend Application v3.0
 * @description Handles:
 *   - Tab navigation between Chat and Booth Finder
 *   - Streaming AI chat responses via SSE
 *   - Polling Booth Finder with Google Maps integration
 *   - Google Analytics 4 event tracking
 *   - Dynamic suggestion chips from server
 *   - XSS-safe rendering, character counting, accessibility
 * @version 3.0.0
 */

'use strict';

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const chatBox          = document.getElementById('chat-box');
const chatPanel        = document.getElementById('panel-chat');
const boothPanel       = document.getElementById('panel-booth');
const userInput        = document.getElementById('user-input');
const sendBtn          = document.getElementById('send-btn');
const loadingIndicator = document.getElementById('loading');
const suggestionsEl    = document.getElementById('suggestions');
const chipsWrapper     = document.getElementById('chips-wrapper');
const clearBtn         = document.getElementById('clear-btn');
const charCount        = document.getElementById('char-count');
const chatInputArea    = document.getElementById('chat-input-area');

// Booth Finder DOM
const pincodeForm      = document.getElementById('pincode-form');
const pincodeInput     = document.getElementById('pincode-input');
const pincodeError     = document.getElementById('pincode-error');
const boothResults     = document.getElementById('booth-results');
const stateName        = document.getElementById('state-name');
const mapIframe        = document.getElementById('map-iframe');
const mapFallback      = document.getElementById('map-fallback');
const mapsOpenLink     = document.getElementById('maps-open-link');
const stateCeoLink     = document.getElementById('state-ceo-link');

// Tabs
const tabs             = document.querySelectorAll('.tab');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let chatHistory   = [];
let isStreaming   = false;
let appConfig     = { gaMeasurementId: null, mapsEnabled: false };

// ---------------------------------------------------------------------------
// Utility: XSS-safe HTML escaping for user-supplied text
// ---------------------------------------------------------------------------

/**
 * Escapes HTML special characters to prevent XSS when displaying user input.
 * @param {string} str - Raw string to escape.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Google Analytics 4 — Event Tracking
// ---------------------------------------------------------------------------

/**
 * Sends a named event to Google Analytics 4 (gtag).
 * Silently no-ops if GA is not initialised (no Measurement ID configured).
 * @param {string} eventName - GA4 event name (snake_case recommended).
 * @param {Object} [params={}] - Additional event parameters.
 */
function trackEvent(eventName, params = {}) {
    if (typeof gtag === 'function') {
        gtag('event', eventName, {
            app_name: 'VoteGuru AI',
            app_version: '3.0.0',
            ...params,
        });
    }
}

/**
 * Dynamically loads the Google Analytics 4 script and initialises it.
 * Called once on app init with the Measurement ID from /api/config.
 * @param {string} measurementId - GA4 Measurement ID (e.g., "G-XXXXXXXXXX").
 */
function initGoogleAnalytics(measurementId) {
    if (!measurementId) return;

    // Inject gtag.js script
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    document.head.appendChild(script);

    // Initialise dataLayer and gtag
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', measurementId, {
        page_title: 'VoteGuru AI',
        page_location: window.location.href,
    });

    console.log('[VoteGuru] Google Analytics 4 initialised:', measurementId);
}

// ---------------------------------------------------------------------------
// App Configuration — fetched from /api/config on boot
// ---------------------------------------------------------------------------

/**
 * Fetches app configuration from the server and initialises GA4.
 * Config includes: gaMeasurementId, mapsEnabled flag.
 */
async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            appConfig = await res.json();
            initGoogleAnalytics(appConfig.gaMeasurementId);
        }
    } catch (err) {
        console.warn('[VoteGuru] Could not load /api/config:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Tab Navigation
// ---------------------------------------------------------------------------

/**
 * Switches between "Ask VoteGuru" (chat) and "Find My Booth" (booth finder) tabs.
 * Updates ARIA attributes and shows/hides the chat input footer.
 * @param {'chat'|'booth'} tabId - The tab to activate.
 */
function activateTab(tabId) {
    tabs.forEach((tab) => {
        const isActive = tab.dataset.tab === tabId;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    if (tabId === 'chat') {
        chatPanel.classList.add('active');
        chatPanel.removeAttribute('hidden');
        boothPanel.classList.remove('active');
        boothPanel.setAttribute('hidden', '');
        chatInputArea.classList.remove('hidden');
        trackEvent('tab_switched', { tab_name: 'chat' });
    } else {
        boothPanel.classList.add('active');
        boothPanel.removeAttribute('hidden');
        chatPanel.classList.remove('active');
        chatPanel.setAttribute('hidden', '');
        chatInputArea.classList.add('hidden');
        trackEvent('tab_switched', { tab_name: 'booth_finder' });
    }
}

// ---------------------------------------------------------------------------
// Suggestion Chips — loaded from /api/suggestions
// ---------------------------------------------------------------------------

/**
 * Fetches and renders randomised suggestion chips from the server.
 * Falls back to hardcoded chips if the request fails.
 */
async function loadSuggestions() {
    const fallbacks = [
        { text: 'How to apply for a Voter ID?', icon: '📋' },
        { text: 'What is the Model Code of Conduct?', icon: '📜' },
        { text: 'How does an EVM work?', icon: '🖥️' },
        { text: 'Am I eligible to vote?', icon: '🗳️' },
    ];

    let suggestions = fallbacks;
    try {
        const res = await fetch('/api/suggestions');
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.suggestions) && data.suggestions.length) {
                suggestions = data.suggestions;
            }
        }
    } catch (_) { /* use fallbacks */ }

    if (!chipsWrapper) return;
    chipsWrapper.innerHTML = '';
    suggestions.forEach((s) => {
        const btn = document.createElement('button');
        btn.className = 'suggestion-chip';
        btn.type = 'button';
        btn.setAttribute('aria-label', `Ask: ${s.text}`);
        btn.innerHTML = `<span class="chip-icon" aria-hidden="true">${s.icon}</span> ${escapeHtml(s.text)}`;
        btn.addEventListener('click', () => app.sendSuggestion(s.text));
        chipsWrapper.appendChild(btn);
    });
}

// ---------------------------------------------------------------------------
// Polling Booth Finder
// ---------------------------------------------------------------------------

const boothFinder = {

    /**
     * Handles the PIN code form submission.
     * Validates input, calls /api/booth-finder, and renders results.
     * @param {Event} e - Form submit event.
     */
    async handleSearch(e) {
        e.preventDefault();
        const pincode = pincodeInput.value.trim();

        // Client-side validation
        if (!/^\d{6}$/.test(pincode)) {
            this.showError('Please enter a valid 6-digit PIN code (numbers only).');
            pincodeInput.focus();
            return;
        }
        if (pincode.startsWith('0')) {
            this.showError('Invalid PIN code. Indian PIN codes do not start with 0.');
            pincodeInput.focus();
            return;
        }

        this.clearError();
        this.setSearchState(true);

        // Track the search event in GA4
        trackEvent('booth_search_performed', { pincode_prefix: pincode.substring(0, 2) });

        try {
            const res = await fetch(`/api/booth-finder?pincode=${encodeURIComponent(pincode)}`);
            const data = await res.json();

            if (!res.ok) {
                this.showError(data.error || 'Search failed. Please try again.');
                return;
            }

            this.renderResults(data);

        } catch (err) {
            console.error('[VoteGuru] Booth finder error:', err);
            trackEvent('booth_search_error', { error: err.message });
            this.showError('Could not connect to the server. Please check your connection and try again.');
        } finally {
            this.setSearchState(false);
        }
    },

    /**
     * Renders booth finder results: state badge, Google Maps iframe or fallback, action buttons.
     * @param {Object} data - Response from /api/booth-finder.
     */
    renderResults(data) {
        // State badge
        stateName.textContent = `${data.state.name} · PIN ${data.pincode}`;

        // Google Maps: embedded iframe (if API key configured) or fallback link
        if (data.mapsEmbedUrl) {
            mapIframe.src = data.mapsEmbedUrl;
            mapIframe.classList.remove('hidden');
            mapFallback.classList.add('hidden');
            trackEvent('maps_embed_shown', { pincode_prefix: data.pincode.substring(0, 2) });
        } else {
            // Fallback: "Open in Google Maps" button
        if (mapsOpenLink) {
            mapsOpenLink.href = data.mapsDirectUrl;
            mapsOpenLink.setAttribute('aria-label', `Open ${data.pincode} area in Google Maps`);
        }
            mapFallback.classList.remove('hidden');
            mapIframe.classList.add('hidden');
            trackEvent('maps_fallback_shown', { pincode_prefix: data.pincode.substring(0, 2) });
        }

        // Update State CEO link
        if (stateCeoLink) {
            stateCeoLink.href = data.state.ceoUrl;
            stateCeoLink.setAttribute('aria-label', `${data.state.name} Chief Electoral Officer website`);
        }

        // Show results panel
        boothResults.classList.remove('hidden');

        // Scroll to results
        boothResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    /**
     * Shows a validation/server error message below the form.
     * @param {string} msg - Error message text.
     */
    showError(msg) {
        pincodeError.textContent = msg;
        pincodeError.classList.remove('hidden');
    },

    /** Clears any displayed error message. */
    clearError() {
        pincodeError.textContent = '';
        pincodeError.classList.add('hidden');
    },

    /**
     * Toggles the search button loading state during the API call.
     * @param {boolean} loading - True when a request is in-flight.
     */
    setSearchState(loading) {
        const btn = document.getElementById('pincode-search-btn');
        if (!btn) return;
        btn.disabled = loading;
        btn.innerHTML = loading
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Searching...'
            : '<i class="fa-solid fa-magnifying-glass"></i> Search';
    },
};

// ---------------------------------------------------------------------------
// Chat Application
// ---------------------------------------------------------------------------

const app = {

    /** Initialises all event listeners and loads initial data. */
    init() {
        // Tab switching
        tabs.forEach((tab) => {
            tab.addEventListener('click', () => activateTab(tab.dataset.tab));
        });

        // Chat events
        sendBtn.addEventListener('click', () => this.handleSend());
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); }
        });
        userInput.addEventListener('input', () => {
            const len = userInput.value.length;
            charCount.textContent = `${len} / 1000`;
            charCount.classList.toggle('near-limit', len > 900);
        });
        clearBtn.addEventListener('click', () => this.clearChat());

        // Booth finder form
        if (pincodeForm) {
            pincodeForm.addEventListener('submit', (e) => boothFinder.handleSearch(e));
        }

        // Only allow numeric input in pincode field
        if (pincodeInput) {
            pincodeInput.addEventListener('input', () => {
                pincodeInput.value = pincodeInput.value.replace(/\D/g, '');
            });
        }

        // GA4 link tracking for booth action buttons
        document.querySelectorAll('[data-ga-event]').forEach((el) => {
            el.addEventListener('click', () => {
                trackEvent(el.dataset.gaEvent);
            });
        });

        // Load async resources
        loadSuggestions();
    },

    // -----------------------------------------------------------------------
    // Chat: Send Message
    // -----------------------------------------------------------------------

    /** Validates input, renders user bubble, and triggers streaming. */
    async handleSend() {
        if (isStreaming) return;

        const text = userInput.value.trim();
        if (!text) return;
        if (text.length > 1000) {
            this.showError('Your message is too long. Please keep it under 1000 characters.');
            return;
        }

        if (suggestionsEl) suggestionsEl.style.display = 'none';

        this.addMessage(escapeHtml(text), 'user');
        chatHistory.push({ role: 'user', text });

        userInput.value = '';
        charCount.textContent = '0 / 1000';
        this.setInputState(false);
        loadingIndicator.classList.remove('hidden');
        this.scrollToBottom();

        // Track in GA4
        trackEvent('chat_message_sent', { message_length: text.length });

        try {
            await this.streamResponse(text);
        } catch (error) {
            console.error('[VoteGuru] Chat error:', error);
            this.showError("Sorry, I'm having trouble connecting right now. Please try again in a moment.");
        } finally {
            loadingIndicator.classList.add('hidden');
            this.setInputState(true);
            userInput.focus();
            this.scrollToBottom();
        }
    },

    // -----------------------------------------------------------------------
    // Chat: Stream Response (SSE)
    // -----------------------------------------------------------------------

    /**
     * Streams the AI response via SSE and renders tokens live in a bubble.
     * After the stream ends, re-renders the full text with Markdown parsing.
     * @param {string} message - User's message to send to the server.
     */
    async streamResponse(message) {
        isStreaming = true;

        const response = await fetch('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                history: chatHistory.slice(-10),
            }),
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `Server error: ${response.status}`);
        }

        const { messageDiv, contentDiv } = this.createMessageBubble('ai');
        chatBox.appendChild(messageDiv);
        loadingIndicator.classList.add('hidden');

        let fullResponseText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();

                if (payload === '[DONE]') {
                    isStreaming = false;
                    contentDiv.innerHTML = marked.parse(fullResponseText);
                    chatHistory.push({ role: 'model', text: fullResponseText });
                    trackEvent('chat_response_received', { response_length: fullResponseText.length });
                    this.scrollToBottom();
                    return;
                }

                try {
                    const parsed = JSON.parse(payload);
                    if (parsed.error) throw new Error(parsed.error);
                    if (parsed.token) {
                        fullResponseText += parsed.token;
                        contentDiv.textContent = fullResponseText; // live preview
                        this.scrollToBottom();
                    }
                } catch (_) { /* non-JSON line, skip */ }
            }
        }

        isStreaming = false;
    },

    // -----------------------------------------------------------------------
    // Chat: Helpers
    // -----------------------------------------------------------------------

    /**
     * Pre-fills the input with a suggestion text and submits it.
     * @param {string} text - The suggestion text to send.
     */
    sendSuggestion(text) {
        trackEvent('suggestion_clicked', { suggestion_text: text });
        userInput.value = text;
        charCount.textContent = `${text.length} / 1000`;
        this.handleSend();
    },

    /**
     * Adds a fully-formed message bubble (user or AI) to the chat log.
     * @param {string} content - Message content (HTML-safe or HTML string).
     * @param {'user'|'ai'} sender - Sender type.
     * @param {boolean} [isHTML=false] - True if content is already HTML.
     */
    addMessage(content, sender, isHTML = false) {
        const { messageDiv, contentDiv } = this.createMessageBubble(sender);
        if (isHTML) {
            contentDiv.innerHTML = content;
        } else {
            contentDiv.innerHTML = content; // already escaped via escapeHtml()
        }
        chatBox.appendChild(messageDiv);
        this.scrollToBottom();
    },

    /**
     * Creates and returns the DOM elements for a message bubble.
     * @param {'user'|'ai'} sender - Sender type.
     * @returns {{ messageDiv: HTMLElement, contentDiv: HTMLElement }}
     */
    createMessageBubble(sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;
        messageDiv.setAttribute('role', 'article');

        const avatarDiv = document.createElement('div');
        avatarDiv.className = `avatar ${sender}-avatar`;
        avatarDiv.setAttribute('aria-hidden', 'true');
        avatarDiv.innerHTML = sender === 'user'
            ? '<i class="fa-solid fa-user"></i>'
            : '<i class="fa-solid fa-robot"></i>';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);

        return { messageDiv, contentDiv };
    },

    /**
     * Shows an error in an AI message bubble.
     * @param {string} text - Error text.
     */
    showError(text) {
        this.addMessage(`<span class="error-text">⚠️ ${escapeHtml(text)}</span>`, 'ai', true);
    },

    /**
     * Enables or disables the chat input/send button.
     * @param {boolean} enabled - Whether the input should be interactive.
     */
    setInputState(enabled) {
        userInput.disabled = !enabled;
        sendBtn.disabled = !enabled;
        sendBtn.classList.toggle('sending', !enabled);
    },

    /** Clears the conversation history and resets the chat UI. */
    clearChat() {
        chatHistory = [];
        chatBox.innerHTML = '';
        trackEvent('chat_cleared');

        const welcome = document.createElement('div');
        welcome.className = 'message ai-message';
        welcome.setAttribute('role', 'article');
        welcome.innerHTML = `
            <div class="avatar ai-avatar" aria-hidden="true"><i class="fa-solid fa-robot"></i></div>
            <div class="message-content">
                <p>🙏 <strong>Namaste!</strong> Conversation cleared. Ready for your next question!</p>
                <p><em>Aap apne sawal Hindi ya Hinglish mein bhi pooch sakte hain!</em> 😊</p>
            </div>
        `;
        chatBox.appendChild(welcome);

        if (suggestionsEl) {
            suggestionsEl.style.display = '';
            loadSuggestions(); // Refresh chips
        }
        userInput.focus();
    },

    /** Smoothly scrolls the chat to the latest message. */
    scrollToBottom() {
        chatPanel.scrollTo({ top: chatPanel.scrollHeight, behavior: 'smooth' });
    },
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

window.app = app; // Expose for debugging and HTML onclick attributes

document.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();     // Load GA + feature flags first
    app.init();             // Then wire up the UI
    trackEvent('app_loaded', { referrer: document.referrer || 'direct' });
});
