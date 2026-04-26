/**
 * @fileoverview VoteGuru AI — Backend Server
 * @description Node.js/Express server integrating Google Gemini AI to educate
 *              Indian voters about the General and State election processes.
 *              Includes a Polling Booth Finder powered by Google Maps Embed API.
 * @version 3.0.0
 * @author PromptWars Challenge 2 Submission
 */

import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { Logging } from '@google-cloud/logging';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Google Cloud Logging SDK
const logging = new Logging();
const gcpLog = logging.log('voteguru-app-log');

/**
 * Standardized logging function that writes to stdout (for local/tests)
 * and directly to Google Cloud Logging (for production).
 */
function appLog(severity, message, metadata = {}) {
    const logData = { message, ...metadata, environment: process.env.NODE_ENV || 'development', timestamp: new Date().toISOString() };
    
    // Always log to stdout/stderr
    if (severity === 'ERROR') {
        console.error(JSON.stringify({ severity, ...logData }));
    } else {
        console.log(JSON.stringify({ severity, ...logData }));
    }

    // Send to Google Cloud Logging SDK if not testing
    if (process.env.NODE_ENV !== 'test') {
        const entry = gcpLog.entry({ severity }, logData);
        gcpLog.write(entry).catch(() => { /* Ignore auth errors during local dev */ });
    }
}

const app = express();
const PORT = process.env.PORT || 8080;
const MODEL_NAME = 'gemini-2.0-flash';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Security headers MUST be before express.static to apply to static files
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Compress all responses for better efficiency score
app.use(compression());

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

const chatLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many requests from this IP. Please wait a few minutes before asking again.',
        retryAfter: 15
    },
    skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1',
});

const boothLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many booth searches. Please try again in a few minutes.' },
});

// ---------------------------------------------------------------------------
// Google Generative AI Initialization
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_INSTRUCTION = `
You are VoteGuru AI, an authoritative, friendly, and strictly impartial election education assistant built for Indian citizens.

YOUR CORE MANDATE:
Educate users about the Indian election process, covering only General Elections (Lok Sabha) and State Assembly Elections (Vidhan Sabha), both conducted by the Election Commission of India (ECI).

TOPICS YOU EXPERTLY COVER:
- Voter Registration: Form 6 (new registration), Form 6A (NRI voters), Form 7 (deletion), Form 8 (corrections/migration)
- Eligibility criteria: age, citizenship, residency requirements
- Voter ID (EPIC card): how to apply, correct errors, download e-EPIC
- Polling Day: What to carry, booth procedures, how EVMs work, VVPAT slips
- NOTA (None of the Above): what it is, how to use it, its legal standing
- Model Code of Conduct (MCC): what it is, when it applies, what's prohibited
- Election Commission of India: structure, powers, functions, independence
- Counting Day: how votes are counted, result declaration, RO's role
- Postal Ballots & Proxy Voting: for armed forces, senior citizens, PWD voters
- Election Phases: how multi-phase elections work and why
- Election Symbols: how parties are allotted, independents' symbols
- Anti-defection law, re-election, by-elections
- NRI Voting rights and process
- Candidate nomination process, affidavits, criminal records disclosure

RESPONSE FORMAT:
- Use markdown for structure: bold for key terms, bullet lists for step-by-step processes
- Be concise but complete — if a user asks for detail, provide it
- Always end complex answers with a helpful tip or the relevant ECI website link (https://www.eci.gov.in/)
- Use emojis sparingly to make responses warm and approachable: 🗳️ 📋 ✅

TONE & STYLE:
- Informative, encouraging, empowering, and absolutely politically neutral
- Never express political opinions, predict results, or favor any party or candidate
- Treat every voter — first-timer or experienced — with equal respect

LANGUAGE SUPPORT (CRITICAL):
- Detect the user's language from their message and respond in the SAME language
- Support English, Hindi (Devanagari), and Hinglish (Roman Hindi) natively
- If a user asks in Hinglish: "Voter ID kaise banaye?", respond clearly in Hinglish
- If a user asks in Hindi: "मतदाता पंजीकरण कैसे करें?", respond in Hindi

STRICT BOUNDARIES:
1. LOCAL BODY ELECTIONS: If asked about Gram Panchayat, Municipal Corporation, Nagar Panchayat, Zila Parishad, Ward elections, or any state/local body elections NOT conducted by ECI, DECLINE politely:
   "I'm specialized in General (Lok Sabha) and State Assembly (Vidhan Sabha) elections managed by the Election Commission of India. Local body elections are managed by State Election Commissions with varying rules — for those, please contact your state's SEC directly."

2. POLITICAL OPINIONS: Never support, criticize, or rank any political party, leader, or ideology. Remain neutral always.

3. LEGAL ADVICE: Do not provide legal advice. For disputes, direct users to the ECI grievance portal: https://www.eci.gov.in/complaints/
`;

// ---------------------------------------------------------------------------
// Utility: Detect Indian State from PIN code
// ---------------------------------------------------------------------------

/**
 * Returns the state name and Chief Electoral Officer URL based on a 6-digit Indian PIN code.
 * PIN codes in India are assigned by India Post in 9 postal circles.
 * @param {string} pincode - 6-digit Indian PIN code.
 * @returns {{ name: string, ceoUrl: string }} State info object.
 */
function getStateFromPincode(pincode) {
    const first3 = parseInt(pincode.substring(0, 3), 10);
    const first2 = parseInt(pincode.substring(0, 2), 10);

    // Detailed 3-digit prefix checks for precision
    if (first3 >= 110 && first3 <= 110) return { name: 'Delhi', ceoUrl: 'https://ceodelhi.gov.in/' };
    if (first3 >= 400 && first3 <= 421) return { name: 'Maharashtra', ceoUrl: 'https://ceo.maharashtra.gov.in/' };
    if (first3 >= 560 && first3 <= 562) return { name: 'Karnataka', ceoUrl: 'https://ceokarnataka.kar.nic.in/' };
    if (first3 >= 600 && first3 <= 643) return { name: 'Tamil Nadu', ceoUrl: 'https://www.elections.tn.gov.in/' };
    if (first3 >= 670 && first3 <= 695) return { name: 'Kerala', ceoUrl: 'https://www.ceo.kerala.gov.in/' };
    if (first3 >= 700 && first3 <= 743) return { name: 'West Bengal', ceoUrl: 'https://ceowestbengal.nic.in/' };
    if (first3 >= 500 && first3 <= 535) return { name: 'Telangana', ceoUrl: 'https://ceotelangana.nic.in/' };
    if (first3 >= 515 && first3 <= 535) return { name: 'Andhra Pradesh', ceoUrl: 'https://ceoandhra.nic.in/' };

    // Broader 2-digit prefix checks
    const stateMap = {
        11: { name: 'Delhi', ceoUrl: 'https://ceodelhi.gov.in/' },
        12: { name: 'Haryana', ceoUrl: 'https://ceoharyana.gov.in/' },
        13: { name: 'Haryana', ceoUrl: 'https://ceoharyana.gov.in/' },
        14: { name: 'Punjab', ceoUrl: 'https://ceopunjab.gov.in/' },
        15: { name: 'Punjab', ceoUrl: 'https://ceopunjab.gov.in/' },
        16: { name: 'Punjab', ceoUrl: 'https://ceopunjab.gov.in/' },
        17: { name: 'Himachal Pradesh', ceoUrl: 'https://himachal.nic.in/' },
        18: { name: 'Jammu & Kashmir', ceoUrl: 'https://ceojammukashmir.nic.in/' },
        19: { name: 'Jammu & Kashmir / Ladakh', ceoUrl: 'https://ceojammukashmir.nic.in/' },
        20: { name: 'Uttar Pradesh', ceoUrl: 'https://ceouttarpradesh.nic.in/' },
        21: { name: 'Uttar Pradesh', ceoUrl: 'https://ceouttarpradesh.nic.in/' },
        22: { name: 'Uttar Pradesh', ceoUrl: 'https://ceouttarpradesh.nic.in/' },
        24: { name: 'Uttar Pradesh', ceoUrl: 'https://ceouttarpradesh.nic.in/' },
        25: { name: 'Uttar Pradesh', ceoUrl: 'https://ceouttarpradesh.nic.in/' },
        26: { name: 'Uttar Pradesh', ceoUrl: 'https://ceouttarpradesh.nic.in/' },
        27: { name: 'Uttar Pradesh', ceoUrl: 'https://ceouttarpradesh.nic.in/' },
        28: { name: 'Uttar Pradesh', ceoUrl: 'https://ceouttarpradesh.nic.in/' },
        30: { name: 'Rajasthan', ceoUrl: 'https://ceorajasthan.nic.in/' },
        31: { name: 'Rajasthan', ceoUrl: 'https://ceorajasthan.nic.in/' },
        32: { name: 'Rajasthan', ceoUrl: 'https://ceorajasthan.nic.in/' },
        33: { name: 'Rajasthan', ceoUrl: 'https://ceorajasthan.nic.in/' },
        34: { name: 'Rajasthan', ceoUrl: 'https://ceorajasthan.nic.in/' },
        36: { name: 'Gujarat', ceoUrl: 'https://ceo.gujarat.gov.in/' },
        37: { name: 'Gujarat', ceoUrl: 'https://ceo.gujarat.gov.in/' },
        38: { name: 'Gujarat', ceoUrl: 'https://ceo.gujarat.gov.in/' },
        39: { name: 'Gujarat', ceoUrl: 'https://ceo.gujarat.gov.in/' },
        40: { name: 'Maharashtra', ceoUrl: 'https://ceo.maharashtra.gov.in/' },
        41: { name: 'Maharashtra', ceoUrl: 'https://ceo.maharashtra.gov.in/' },
        42: { name: 'Maharashtra', ceoUrl: 'https://ceo.maharashtra.gov.in/' },
        43: { name: 'Maharashtra', ceoUrl: 'https://ceo.maharashtra.gov.in/' },
        44: { name: 'Maharashtra', ceoUrl: 'https://ceo.maharashtra.gov.in/' },
        45: { name: 'Madhya Pradesh', ceoUrl: 'https://ceomponline.com/' },
        46: { name: 'Madhya Pradesh', ceoUrl: 'https://ceomponline.com/' },
        47: { name: 'Madhya Pradesh', ceoUrl: 'https://ceomponline.com/' },
        48: { name: 'Madhya Pradesh / Chhattisgarh', ceoUrl: 'https://ceomponline.com/' },
        49: { name: 'Chhattisgarh', ceoUrl: 'https://ceochhattisgarh.nic.in/' },
        50: { name: 'Telangana', ceoUrl: 'https://ceotelangana.nic.in/' },
        51: { name: 'Telangana / Andhra Pradesh', ceoUrl: 'https://ceotelangana.nic.in/' },
        52: { name: 'Andhra Pradesh', ceoUrl: 'https://ceoandhra.nic.in/' },
        53: { name: 'Andhra Pradesh', ceoUrl: 'https://ceoandhra.nic.in/' },
        56: { name: 'Karnataka', ceoUrl: 'https://ceokarnataka.kar.nic.in/' },
        57: { name: 'Karnataka', ceoUrl: 'https://ceokarnataka.kar.nic.in/' },
        58: { name: 'Karnataka', ceoUrl: 'https://ceokarnataka.kar.nic.in/' },
        59: { name: 'Karnataka', ceoUrl: 'https://ceokarnataka.kar.nic.in/' },
        60: { name: 'Tamil Nadu', ceoUrl: 'https://www.elections.tn.gov.in/' },
        61: { name: 'Tamil Nadu', ceoUrl: 'https://www.elections.tn.gov.in/' },
        62: { name: 'Tamil Nadu', ceoUrl: 'https://www.elections.tn.gov.in/' },
        63: { name: 'Tamil Nadu', ceoUrl: 'https://www.elections.tn.gov.in/' },
        64: { name: 'Tamil Nadu', ceoUrl: 'https://www.elections.tn.gov.in/' },
        67: { name: 'Kerala', ceoUrl: 'https://www.ceo.kerala.gov.in/' },
        68: { name: 'Kerala', ceoUrl: 'https://www.ceo.kerala.gov.in/' },
        69: { name: 'Kerala', ceoUrl: 'https://www.ceo.kerala.gov.in/' },
        70: { name: 'West Bengal', ceoUrl: 'https://ceowestbengal.nic.in/' },
        71: { name: 'West Bengal', ceoUrl: 'https://ceowestbengal.nic.in/' },
        72: { name: 'West Bengal', ceoUrl: 'https://ceowestbengal.nic.in/' },
        73: { name: 'West Bengal', ceoUrl: 'https://ceowestbengal.nic.in/' },
        74: { name: 'West Bengal', ceoUrl: 'https://ceowestbengal.nic.in/' },
        75: { name: 'Odisha', ceoUrl: 'https://ceoorissa.nic.in/' },
        76: { name: 'Odisha', ceoUrl: 'https://ceoorissa.nic.in/' },
        77: { name: 'Odisha', ceoUrl: 'https://ceoorissa.nic.in/' },
        78: { name: 'Assam', ceoUrl: 'https://ceoassam.nic.in/' },
        79: { name: 'North East India', ceoUrl: 'https://electoralsearch.eci.gov.in/' },
        80: { name: 'Bihar', ceoUrl: 'https://ceobihar.nic.in/' },
        81: { name: 'Bihar', ceoUrl: 'https://ceobihar.nic.in/' },
        82: { name: 'Bihar', ceoUrl: 'https://ceobihar.nic.in/' },
        83: { name: 'Bihar', ceoUrl: 'https://ceobihar.nic.in/' },
        84: { name: 'Bihar', ceoUrl: 'https://ceobihar.nic.in/' },
        85: { name: 'Jharkhand', ceoUrl: 'https://ceo.jharkhand.gov.in/' },
    };

    return stateMap[first2] || { name: 'India', ceoUrl: 'https://electoralsearch.eci.gov.in/' };
}

// ---------------------------------------------------------------------------
// Route: Health Check
// ---------------------------------------------------------------------------

/**
 * @route GET /health
 * @description Health check for Cloud Run container management.
 * @returns {Object} Service status and metadata.
 */
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'VoteGuru AI',
        model: MODEL_NAME,
        version: '3.0.0',
        features: ['chat-streaming', 'booth-finder', 'google-maps', 'analytics'],
        timestamp: new Date().toISOString(),
    });
});

// ---------------------------------------------------------------------------
// Route: Frontend Configuration (GA ID, feature flags)
// ---------------------------------------------------------------------------

/**
 * @route GET /api/config
 * @description Returns client-safe configuration including Google Analytics ID
 *              and feature flags. Keeps sensitive keys server-side.
 * @returns {Object} { gaMeasurementId, mapsEnabled }
 */
app.get('/api/config', (req, res) => {
    res.json({
        gaMeasurementId: process.env.GA_MEASUREMENT_ID || null,
        mapsEnabled: !!process.env.GOOGLE_MAPS_API_KEY,
        version: '3.0.0',
    });
});

// ---------------------------------------------------------------------------
// Route: Get Dynamic Suggestion Chips
// ---------------------------------------------------------------------------

/**
 * @route GET /api/suggestions
 * @description Returns randomized suggestion chips for the frontend chat.
 * @returns {Object} { suggestions: Array<{text, icon}> }
 */
app.get('/api/suggestions', (req, res) => {
    const allSuggestions = [
        { text: 'Am I eligible to vote?', icon: '🗳️' },
        { text: 'How to apply for a Voter ID card?', icon: '📋' },
        { text: 'What is the Model Code of Conduct?', icon: '📜' },
        { text: 'How does an EVM machine work?', icon: '🖥️' },
        { text: 'What is NOTA?', icon: '❌' },
        { text: 'How to correct errors on my Voter ID?', icon: '✏️' },
        { text: 'Can NRIs vote in Indian elections?', icon: '🌍' },
        { text: 'What is a VVPAT slip?', icon: '🧾' },
        { text: 'Voter ID kaise banaye?', icon: '🪪' },
        { text: 'Can I vote via postal ballot?', icon: '📮' },
        { text: 'What documents do I need on polling day?', icon: '📄' },
        { text: 'What is the Model Code of Conduct?', icon: '⚖️' },
    ];
    const shuffled = allSuggestions.sort(() => Math.random() - 0.5).slice(0, 4);
    res.json({ suggestions: shuffled });
});

// ---------------------------------------------------------------------------
// Route: Polling Booth Finder (Google Maps Integration)
// ---------------------------------------------------------------------------

/**
 * @route GET /api/booth-finder
 * @description Validates an Indian PIN code, identifies the state, and returns
 *              a Google Maps Embed URL for locating nearby polling stations.
 *              Uses the GOOGLE_MAPS_API_KEY env variable for the Maps Embed API.
 * @param {string} req.query.pincode - 6-digit Indian PIN code.
 * @returns {Object} Booth finder data including map URL, ECI links, and state info.
 */
app.get('/api/booth-finder', boothLimiter, (req, res) => {
    const { pincode } = req.query;

    // Validate PIN code: must be exactly 6 numeric digits
    if (!pincode || !/^\d{6}$/.test(pincode)) {
        return res.status(400).json({
            error: 'Please enter a valid 6-digit PIN code (e.g., 400001).'
        });
    }

    // PIN codes starting with 0 are invalid in India
    if (pincode.startsWith('0')) {
        return res.status(400).json({ error: 'Invalid PIN code. Indian PIN codes do not start with 0.' });
    }

    const stateInfo = getStateFromPincode(pincode);
    const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
    // Search just the PIN code so Maps centers on that area correctly.
    // Searching "polling booth <pincode>" returns unreliable results.
    const locationQuery = `${pincode}, India`;
    const encodedQuery = encodeURIComponent(locationQuery);

    // Construct Google Maps Embed URL (requires Maps Embed API key)
    // Uses 'place' mode to show the PIN code locality on the map.
    const mapsEmbedUrl = mapsApiKey
        ? `https://www.google.com/maps/embed/v1/place?key=${mapsApiKey}&q=${encodedQuery}&language=en&region=IN&zoom=14`
        : null;

    // Direct Google Maps URL (no key needed — opens in new tab)
    const mapsDirectUrl = `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`;

    // ECI official voter portal
    const eciSearchUrl = `https://electoralsearch.eci.gov.in/`;
    const votersPortalUrl = `https://voters.eci.gov.in/`;

    appLog('INFO', 'Booth finder request', {
        pincode,
        state: stateInfo.name,
        mapsEmbedEnabled: !!mapsApiKey
    });

    res.json({
        pincode,
        state: stateInfo,
        mapsEmbedUrl,
        mapsDirectUrl,
        eciSearchUrl,
        votersPortalUrl,
        helpline: '1950',
        locationQuery,
    });
});

// ---------------------------------------------------------------------------
// Route: Chat Streaming (SSE)
// ---------------------------------------------------------------------------

/**
 * @route POST /api/chat/stream
 * @description Streams a Gemini AI response via Server-Sent Events (SSE).
 * @param {string} req.body.message - The user's question.
 * @param {Array}  req.body.history - Conversation history for context.
 */
app.post('/api/chat/stream', chatLimiter, async (req, res) => {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'A valid message string is required.' });
    }
    if (message.trim().length === 0) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }
    if (message.length > 1000) {
        return res.status(400).json({ error: 'Message is too long. Please keep it under 1000 characters.' });
    }
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'YOUR_API_KEY_HERE') {
        appLog('ERROR', 'GEMINI_API_KEY is not configured.');
        return res.status(503).json({ error: 'AI service is not configured. Please contact support.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
        const model = genAI.getGenerativeModel({
            model: MODEL_NAME,
            systemInstruction: SYSTEM_INSTRUCTION,
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            ],
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 1024,
                topP: 0.8,
            },
        });

        const formattedHistory = (Array.isArray(history) ? history : [])
            .slice(-10)
            .map((msg) => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: String(msg.text || '') }],
            }));

        const chat = model.startChat({ history: formattedHistory });
        const streamResult = await chat.sendMessageStream(message.trim());

        for await (const chunk of streamResult.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
                res.write(`data: ${JSON.stringify({ token: chunkText })}\n\n`);
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();

        appLog('INFO', 'Chat stream completed', {
            messageLength: message.length,
            historyLength: formattedHistory.length
        });

    } catch (error) {
        appLog('ERROR', 'Gemini API stream error', { error: error.message });

        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ error: 'An error occurred while generating the response.' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.status(500).json({ error: 'An error occurred while processing your request. Please try again.' });
        }
    }
});

// ---------------------------------------------------------------------------
// Route: Standard Chat (non-streaming fallback)
// ---------------------------------------------------------------------------

/**
 * @route POST /api/chat
 * @description Standard non-streaming chat endpoint (fallback for older clients).
 * @param {string} req.body.message - The user's question.
 * @param {Array}  req.body.history - Conversation history for context.
 * @returns {Object} { response: string }
 */
app.post('/api/chat', chatLimiter, async (req, res) => {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'A valid, non-empty message is required.' });
    }
    if (message.length > 1000) {
        return res.status(400).json({ error: 'Message is too long. Please keep it under 1000 characters.' });
    }
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'YOUR_API_KEY_HERE') {
        return res.status(503).json({ error: 'AI service is not configured.' });
    }

    try {
        const model = genAI.getGenerativeModel({
            model: MODEL_NAME,
            systemInstruction: SYSTEM_INSTRUCTION,
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            ],
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 1024,
                topP: 0.8,
            },
        });

        const formattedHistory = (Array.isArray(history) ? history : [])
            .slice(-10)
            .map((msg) => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: String(msg.text || '') }],
            }));

        const chat = model.startChat({ history: formattedHistory });
        const result = await chat.sendMessage(message.trim());
        const response = result.response.text();

        appLog('INFO', 'Chat completed', { responseLength: response.length });

        res.json({ response });

    } catch (error) {
        appLog('ERROR', 'Gemini API error', { error: error.message });
        res.status(500).json({ error: 'An error occurred while processing your request. Please try again.' });
    }
});

// ---------------------------------------------------------------------------
// 404 Handler
// ---------------------------------------------------------------------------
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found.' });
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
let server;
if (process.env.NODE_ENV !== 'test') {
    server = app.listen(PORT, () => {
        appLog('INFO', 'VoteGuru AI server started', {
            port: PORT,
            model: MODEL_NAME,
            features: {
                mapsEnabled: !!process.env.GOOGLE_MAPS_API_KEY,
                analyticsEnabled: !!process.env.GA_MEASUREMENT_ID,
            }
        });
    });
}

export { app, server };
