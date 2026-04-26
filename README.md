# VoteGuru AI 🗳️🇮🇳
**PromptWars Challenge 2 Submission — Election Process Education**

> An intelligent, multilingual AI assistant that empowers Indian voters with accurate, impartial knowledge about General (Lok Sabha) and State Assembly (Vidhan Sabha) elections.

[![Google Gemini](https://img.shields.io/badge/Google%20Gemini-2.0%20Flash-blue?logo=google)](https://ai.google.dev/)
[![Cloud Run](https://img.shields.io/badge/Deployed%20on-Cloud%20Run-4285F4?logo=google-cloud)](https://cloud.google.com/run)
[![Node.js](https://img.shields.io/badge/Node.js-20%20LTS-339933?logo=node.js)](https://nodejs.org/)

---

## 🎯 The Problem

India's election process is vast and complex. First-time voters often don't know how to register, what to bring on polling day, or what rights they have. Information is scattered, often in dense government language, and rarely available in Hindi or Hinglish.

**VoteGuru AI** solves this with a conversational AI assistant available to every Indian voter — in their own language.

---

## 🚀 Key Features

| Feature | Description |
|---|---|
| 🌐 **Multilingual** | Responds in English, Hindi (Devanagari), and Hinglish automatically |
| 🗳️ **Comprehensive Coverage** | Form 6, EPIC, EVM, VVPAT, NOTA, MCC, postal ballots, NRI voting, candidate nomination |
| 🛡️ **Logical Guardrails** | Scoped strictly to ECI-conducted elections; politely declines local body election queries |
| ⚡ **Streaming Responses** | Real-time token streaming for a fast, ChatGPT-like experience |
| 🔒 **Rate Limited** | 30 requests per 15 minutes per IP to prevent API abuse |
| ♿ **Accessible** | ARIA roles, semantic HTML, keyboard navigation, screen reader compatible |
| 🏥 **Health Check** | `/health` endpoint for Cloud Run container management |
| 📊 **Structured Logging** | Cloud Run-compatible JSON logs via Cloud Logging |

---

## 🛠️ Technology Stack

| Layer | Technology |
|---|---|
| **AI Model** | Google Gemini 2.0 Flash (`@google/generative-ai`) |
| **Backend** | Node.js 20 + Express |
| **Streaming** | Server-Sent Events (SSE) via `sendMessageStream` |
| **Rate Limiting** | `express-rate-limit` |
| **Frontend** | Vanilla HTML5, CSS3, JavaScript (ES6+) |
| **Deployment** | Google Cloud Run (containerized via Docker) |
| **Logging** | Google Cloud Logging (structured JSON) |

---

## 🧠 Architecture

```
Browser (SSE client)
    │
    ▼
Express Server (server.js)
    │  POST /api/chat/stream
    │  POST /api/chat (fallback)
    │  GET  /api/suggestions
    │  GET  /health
    ▼
Google Gemini 1.5 Flash API
    │  systemInstruction: Election scope guard
    │  conversationHistory: Last 10 turns
    │  streaming: sendMessageStream()
    ▼
SSE token stream → Browser renders markdown
```

---

## ⚠️ Design Decisions & Assumptions

1. **Strict ECI Scope** — Local body elections are explicitly declined. This reduces hallucination risk significantly, as local rules vary wildly across states.
2. **Gemini 1.5 Flash** — Chosen for its speed, cost-efficiency, and multilingual capability, making it ideal for a public-facing chatbot.
3. **SSE over WebSockets** — SSE is simpler, unidirectional (server → client), and works natively in all modern browsers without libraries.
4. **Temperature 0.3** — Lower temperature keeps responses factual and grounded, appropriate for civic/government information.
5. **History Context** — Only the last 10 conversation turns are sent to the API to balance context quality and token cost.

---

## 🏃 Run Locally

```bash
# 1. Clone this repository
git clone <your-repo-url>
cd voteguru-ai

# 2. Install dependencies
npm install

# 3. Add your API key
echo "GEMINI_API_KEY=your_key_here" > .env

# 4. Start the development server
npm run dev

# 5. Open in browser
open http://localhost:8080
```

---

## 🐳 Deploy to Google Cloud Run

```bash
# Authenticate
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Build and deploy (Antigravity handles this automatically)
gcloud run deploy voteguru-ai \
  --source . \
  --platform managed \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=your_gemini_key,GOOGLE_MAPS_API_KEY=your_maps_key,GA_MEASUREMENT_ID=G-XXXXXXXXXX"
```

> **Note:** `GOOGLE_MAPS_API_KEY` and `GA_MEASUREMENT_ID` are optional.
> The app works without them (Maps shows a link fallback; Analytics is simply disabled).

---

## 📝 LinkedIn Post (for Submission)

> 🗳️ Just submitted **VoteGuru AI** for **#PromptWarsVirtual** Challenge 2!
>
> Built an intelligent election education assistant for Indian voters — answering questions about voter registration (Form 6, EPIC), EVMs, VVPAT, NOTA, the Model Code of Conduct, and much more — in **English, Hindi, and Hinglish**.
>
> 🛠️ Google AI Stack:
> - **Google Gemini 2.0 Flash** — multilingual AI reasoning and real-time streaming responses
> - **Google Cloud Run** — serverless, auto-scaling deployment
> - **Google Cloud Logging** — structured observability
> - **Vertex AI / AI Studio** — API key management
>
> 💡 Key design decisions:
> - Strict guardrails scoped to ECI-conducted elections only (no hallucination on local body rules)
> - Server-Sent Events (SSE) for real-time token streaming
> - Rate limiting, input validation, and ARIA accessibility baked in
>
> 🔗 Live: [YOUR_CLOUD_RUN_URL]
>
> #GoogleAI #GeminiAPI #CloudRun #ElectionEducation #VoterEmpowerment #IndianElections #PromptWars #Hack2skill #BuildWithGemini
>
> @Google for Developers @Hack2skill

---

## 📁 Project Structure

```
voteguru-ai/
├── server.js           # Express + Gemini backend (streaming, rate limiting, health)
├── package.json
├── Dockerfile
├── .env                # GEMINI_API_KEY (not committed)
├── .gitignore
├── .dockerignore
└── public/
    ├── index.html      # Semantic HTML, SEO meta tags, ARIA
    ├── app.js          # SSE streaming client, XSS protection, suggestion chips
    └── style.css       # Premium tri-color UI, micro-animations
```
