const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const APP_SESSION_SECRET = process.env.APP_SESSION_SECRET || '';
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const authConfigured = Boolean(APP_USERNAME && APP_PASSWORD && APP_SESSION_SECRET);
const isProduction = process.env.NODE_ENV === 'production';

function constantTimeEqual(actual, expected) {
    const actualBuffer = Buffer.from(String(actual || ''));
    const expectedBuffer = Buffer.from(String(expected || ''));
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function sessionToken(username) {
    const payload = Buffer.from(JSON.stringify({ username, expiresAt: Date.now() + SESSION_MAX_AGE })).toString('base64url');
    const signature = crypto.createHmac('sha256', APP_SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function hasValidSession(req) {
    if (!authConfigured) return false;
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('bitlibera_session='));
    if (!cookie) return false;
    const [payload, signature] = cookie.slice('bitlibera_session='.length).split('.');
    if (!payload || !signature) return false;
    const expected = crypto.createHmac('sha256', APP_SESSION_SECRET).update(payload).digest('base64url');
    if (!constantTimeEqual(signature, expected)) return false;
    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return session.username === APP_USERNAME && session.expiresAt > Date.now();
    } catch {
        return false;
    }
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/api/auth/session', (req, res) => {
    res.json({ configured: authConfigured, authenticated: hasValidSession(req) });
});

app.post('/api/auth/login', (req, res) => {
    if (!authConfigured) {
        return res.status(503).json({ success: false, error: 'Configurez APP_USERNAME, APP_PASSWORD et APP_SESSION_SECRET dans .env.' });
    }
    if (!constantTimeEqual(req.body.username, APP_USERNAME) || !constantTimeEqual(req.body.password, APP_PASSWORD)) {
        return res.status(401).json({ success: false, error: 'Identifiant ou mot de passe incorrect.' });
    }
    const secure = isProduction ? '; Secure' : '';
    res.setHeader('Set-Cookie', `bitlibera_session=${sessionToken(APP_USERNAME)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}${secure}`);
    res.json({ success: true });
});

app.use((req, res, next) => {
    if (req.path === '/login' || req.path === '/api/auth/login' || req.path === '/api/auth/session') return next();
    if (!authConfigured) {
        if (req.path.startsWith('/api/')) return res.status(503).json({ success: false, error: 'Configurez les identifiants de connexion dans .env.' });
        return res.redirect('/login');
    }
    if (hasValidSession(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, error: 'Session expirée. Reconnectez-vous.' });
    return res.redirect('/login');
});

app.post('/api/auth/logout', (req, res) => {
    const secure = isProduction ? '; Secure' : '';
    res.setHeader('Set-Cookie', `bitlibera_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
    res.json({ success: true });
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Configuration de base (Variables d'environnement)
const PORT = process.env.PORT || 3000;
const BLINK_API_URL = 'https://api.blink.sv/graphql';
const BLINK_API_KEY = process.env.BLINK_API_KEY || ''; 
const DEFAULT_WALLET_ID = process.env.BLINK_WALLET_ID || ''; 

// Configuration BitLibera Gateway
const BITLIBERA_BASE_URL = 'https://exchanger.bitlibera.com';
const BITLIBERA_API_KEY = process.env.BITLIBERA_API_KEY || '';

const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'bitlibera.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        counterparty TEXT NOT NULL DEFAULT '',
        memo TEXT NOT NULL DEFAULT '',
        payment_request TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL,
        reference TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transactions_created_at_idx ON transactions(created_at DESC);
    CREATE TABLE IF NOT EXISTS gateway_orders (
        order_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        amount_bif INTEGER NOT NULL,
        invoice TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gateway_orders_created_at_idx ON gateway_orders(created_at DESC);
`);

const createId = () => `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const getTransaction = database.prepare('SELECT * FROM transactions WHERE id = ?');
const listTransactions = database.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100');
const saveTransaction = database.prepare(`
    INSERT INTO transactions (id, direction, status, amount_sats, counterparty, memo, payment_request, mode, reference, created_at, updated_at)
    VALUES (@id, @direction, @status, @amount_sats, @counterparty, @memo, @payment_request, @mode, @reference, @created_at, @updated_at)
`);
const updateTransactionStatus = database.prepare('UPDATE transactions SET status = ?, updated_at = ? WHERE id = ?');
const getGatewayOrder = database.prepare('SELECT * FROM gateway_orders WHERE order_id = ?');
const listGatewayOrders = database.prepare('SELECT * FROM gateway_orders ORDER BY created_at DESC LIMIT 100');
const saveGatewayOrder = database.prepare(`
    INSERT INTO gateway_orders (order_id, operation, status, phone, amount_bif, invoice, mode, created_at, updated_at)
    VALUES (@order_id, @operation, @status, @phone, @amount_bif, @invoice, @mode, @created_at, @updated_at)
`);
const updateGatewayOrderStatus = database.prepare('UPDATE gateway_orders SET status = ?, updated_at = ? WHERE order_id = ?');

function transactionRecord(values) {
    const now = new Date().toISOString();
    const record = {
        id: createId(),
        direction: values.direction,
        status: values.status,
        amount_sats: Number(values.amount_sats),
        counterparty: values.counterparty || '',
        memo: values.memo || '',
        payment_request: values.payment_request || '',
        mode: values.mode,
        reference: values.reference || '',
        created_at: now,
        updated_at: now
    };
    saveTransaction.run(record);
    return record;
}

function validateAmount(value) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2100000000) {
        const error = new Error('Le montant doit être un nombre entier de sats compris entre 1 et 2 100 000 000.');
        error.status = 400;
        throw error;
    }
    return amount;
}

function validateGatewayAmount(value) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 1) {
        const error = new Error('Le montant doit être un nombre entier de BIF supérieur à zéro.');
        error.status = 400;
        throw error;
    }
    return amount;
}

function createGatewayOrder(values) {
    const now = new Date().toISOString();
    const order = {
        order_id: `bl_${createId()}`,
        operation: values.operation,
        status: values.status,
        phone: values.phone || '',
        amount_bif: values.amount_bif,
        invoice: values.invoice || '',
        mode: 'demo',
        created_at: now,
        updated_at: now
    };
    saveGatewayOrder.run(order);
    return order;
}

async function blinkRequest(query, variables, withApiKey = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (withApiKey) headers['X-API-KEY'] = BLINK_API_KEY;
    const response = await axios.post(BLINK_API_URL, { query, variables }, { headers, timeout: 15000 });
    if (response.data.errors?.length) throw new Error(response.data.errors[0].message);
    return response.data.data;
}

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        demo: true,
        liveReceive: Boolean(DEFAULT_WALLET_ID),
        liveSend: Boolean(DEFAULT_WALLET_ID && BLINK_API_KEY),
        database: 'sqlite'
    });
});

app.get('/api/bitlibera/health', (req, res) => {
    res.json({ success: true, configured: Boolean(BITLIBERA_API_KEY), baseUrl: BITLIBERA_BASE_URL });
});

app.get('/api/bitlibera/orders', (req, res) => {
    res.json({ success: true, orders: listGatewayOrders.all() });
});

app.get('/api/transactions', (req, res) => {
    res.json({ success: true, transactions: listTransactions.all() });
});

app.post('/api/invoices', async (req, res) => {
    const amountSats = validateAmount(req.body.amountSats);
    const memo = String(req.body.memo || 'Paiement Blink').trim().slice(0, 120);
    const mode = req.body.mode === 'live' ? 'live' : 'demo';

    if (mode === 'demo') {
        const record = transactionRecord({
            direction: 'receive', status: 'PENDING', amount_sats: amountSats,
            memo, mode, payment_request: `DEMO-BOLT11-${createId().toUpperCase()}`
        });
        return res.status(201).json({ success: true, transaction: record });
    }

    if (!DEFAULT_WALLET_ID) return res.status(503).json({ success: false, error: 'Configurez BLINK_WALLET_ID pour créer une facture réelle.' });

    const mutation = `
        mutation Mutation($input: LnInvoiceCreateOnBehalfOfRecipientInput!) {
            lnInvoiceCreateOnBehalfOfRecipient(input: $input) {
                invoice { paymentRequest satoshis }
                errors { message }
            }
        }
    `;
    const data = await blinkRequest(mutation, { input: {
        recipientWalletId: DEFAULT_WALLET_ID,
        amount: String(amountSats),
        memo,
        expiresIn: '15'
    } });
    const result = data.lnInvoiceCreateOnBehalfOfRecipient;
    if (result.errors?.length) return res.status(400).json({ success: false, error: result.errors[0].message });
    const record = transactionRecord({
        direction: 'receive', status: 'PENDING', amount_sats: result.invoice.satoshis,
        memo, mode, payment_request: result.invoice.paymentRequest
    });
    res.status(201).json({ success: true, transaction: record });
});

app.post('/api/payments', async (req, res) => {
    const amountSats = validateAmount(req.body.amountSats);
    let destination = String(req.body.destination || '').trim();
    if (!destination.includes('@') && /^\+?[\d\s().-]+$/.test(destination)) {
        destination = `${destination.replace(/\D/g, '')}@blink.sv`;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) {
        return res.status(400).json({ success: false, error: 'Saisissez une adresse Lightning valide ou un numéro de téléphone.' });
    }
    const mode = req.body.mode === 'live' ? 'live' : 'demo';

    if (mode === 'demo') {
        const record = transactionRecord({
            direction: 'send', status: 'SUCCESS', amount_sats: amountSats,
            counterparty: destination, memo: 'Paiement simulé', mode
        });
        return res.status(201).json({ success: true, transaction: record });
    }

    if (!DEFAULT_WALLET_ID || !BLINK_API_KEY) {
        return res.status(503).json({ success: false, error: 'Configurez BLINK_WALLET_ID et BLINK_API_KEY pour envoyer un paiement réel.' });
    }

    const mutation = `
        mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
            lnAddressPaymentSend(input: $input) { status errors { message } }
        }
    `;
    const data = await blinkRequest(mutation, { input: {
        amount: amountSats, lnAddress: destination, walletId: DEFAULT_WALLET_ID
    } }, true);
    const result = data.lnAddressPaymentSend;
    if (result.errors?.length) return res.status(400).json({ success: false, error: result.errors[0].message });
    const status = result.status === 'SUCCESS' ? 'SUCCESS' : (result.status || 'PENDING');
    const record = transactionRecord({
        direction: 'send', status, amount_sats: amountSats,
        counterparty: destination, mode, reference: result.status || ''
    });
    res.status(201).json({ success: true, transaction: record });
});

app.post('/api/transactions/:id/simulate-payment', (req, res) => {
    const transaction = getTransaction.get(req.params.id);
    if (!transaction) return res.status(404).json({ success: false, error: 'Transaction introuvable.' });
    if (transaction.mode !== 'demo' || transaction.direction !== 'receive') {
        return res.status(400).json({ success: false, error: 'Seules les factures de démonstration peuvent être simulées.' });
    }
    if (transaction.status !== 'PENDING') return res.status(409).json({ success: false, error: 'Cette facture n’est plus en attente.' });
    updateTransactionStatus.run('PAID', new Date().toISOString(), transaction.id);
    res.json({ success: true, transaction: getTransaction.get(transaction.id) });
});

app.post('/api/transactions/:id/check', async (req, res) => {
    const transaction = getTransaction.get(req.params.id);
    if (!transaction) return res.status(404).json({ success: false, error: 'Transaction introuvable.' });
    if (transaction.mode === 'demo') return res.json({ success: true, transaction });
    if (!transaction.payment_request) return res.status(400).json({ success: false, error: 'Aucune facture associée à cette transaction.' });

    const query = `
        query CheckPaymentStatus($input: LnInvoicePaymentStatusInput!) {
            lnInvoicePaymentStatus(input: $input) { status }
        }
    `;
    const data = await blinkRequest(query, { input: { paymentRequest: transaction.payment_request } });
    const status = data.lnInvoicePaymentStatus?.status || transaction.status;
    updateTransactionStatus.run(status, new Date().toISOString(), transaction.id);
    res.json({ success: true, transaction: getTransaction.get(transaction.id) });
});

// ROUTE DE SÉCOURS
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// ==========================================
// ROUTES BLINK API
// ==========================================

// 1. ROUTE : Créer une facture Lightning (Invoice)
app.post('/api/blink/create-invoice', async (req, res) => {
    try {
        const { amountSats, memo } = req.body;

        const mutation = `
            mutation Mutation($input: LnInvoiceCreateOnBehalfOfRecipientInput!) {
                lnInvoiceCreateOnBehalfOfRecipient(input: $input) {
                    invoice {
                        paymentRequest
                        satoshis
                    }
                    errors {
                        message
                    }
                }
            }
        `;

        const variables = {
            input: {
                recipientWalletId: DEFAULT_WALLET_ID,
                amount: amountSats.toString(),
                memo: memo || "Paiement via Blink",
                expiresIn: "15" 
            }
        };

        const response = await axios.post(BLINK_API_URL, { query: mutation, variables }, {
            headers: { 'Content-Type': 'application/json' }
        });

        const data = response.data.data.lnInvoiceCreateOnBehalfOfRecipient;
        if (data.errors && data.errors.length > 0) {
            return res.status(400).json({ success: false, error: data.errors[0].message });
        }

        res.json({
            success: true,
            paymentRequest: data.invoice.paymentRequest,
            satoshis: data.invoice.satoshis
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. ROUTE : Vérifier le statut d'une facture (Polling)
app.post('/api/blink/check-status', async (req, res) => {
    try {
        const { paymentRequest } = req.body;

        const query = `
            query CheckPaymentStatus($input: LnInvoicePaymentStatusInput!) {
                lnInvoicePaymentStatus(input: $input) {
                    status
                }
            }
        `;

        const variables = { input: { paymentRequest } };

        const response = await axios.post(BLINK_API_URL, { query, variables }, {
            headers: { 'Content-Type': 'application/json' }
        });

        const status = response.data.data.lnInvoicePaymentStatus?.status;
        res.json({ success: true, status });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. ROUTE : Envoyer des sats vers une adresse Lightning
app.post('/api/blink/send-payment', async (req, res) => {
    try {
        const { lnAddress, amountSats } = req.body;

        const mutation = `
            mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
                lnAddressPaymentSend(input: $input) {
                    status
                    errors {
                        message
                    }
                }
            }
        `;

        const variables = {
            input: {
                amount: Number(amountSats),
                lnAddress: lnAddress,
                walletId: DEFAULT_WALLET_ID
            }
        };

        const response = await axios.post(BLINK_API_URL, { query: mutation, variables }, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': BLINK_API_KEY 
            }
        });

        const result = response.data.data.lnAddressPaymentSend;
        if (result.errors && result.errors.length > 0) {
            return res.status(400).json({ success: false, error: result.errors[0].message });
        }

        res.json({
            success: result.status === 'SUCCESS',
            status: result.status
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. ROUTE : Obtenir le taux de change du Bitcoin
app.get('/api/blink/rate', async (req, res) => {
    try {
        const query = `
            query realtimePrice($currency: DisplayCurrency!) {
                realtimePrice(currency: $currency) {
                    btcSatPrice {
                        base
                        offset
                    }
                }
            }
        `;

        const variables = { currency: "USD" };

        const response = await axios.post(BLINK_API_URL, { query, variables }, {
            headers: { 'Content-Type': 'application/json' }
        });

        res.json({ success: true, priceData: response.data.data.realtimePrice });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. ROUTE : Récupérer l'ID du wallet par défaut via le nom d'utilisateur
app.post('/api/blink/get-wallet', async (req, res) => {
    try {
        const { username } = req.body;

        const query = `
            query Query($username: Username!) {
                accountDefaultWallet(username: $username) {
                    id
                    currency
                }
            }
        `;

        const variables = { username: username };

        const response = await axios.post(BLINK_API_URL, { query, variables }, {
            headers: { 'Content-Type': 'application/json' }
        });

        const data = response.data.data.accountDefaultWallet;
        if (!data) {
            return res.status(404).json({ success: false, error: "Utilisateur non trouvé ou wallet introuvable." });
        }

        res.json({
            success: true,
            walletId: data.id,
            currency: data.currency
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==========================================
// ROUTES BITLIBERA GATEWAY (API v1)
// ==========================================

const callBitliberaAPI = async (method, endpoint, data = null) => {
    try {
        const config = {
            method: method,
            url: `${BITLIBERA_BASE_URL}${endpoint}`,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': BITLIBERA_API_KEY
            }
        };
        if (data) config.data = data;
        
        const response = await axios(config);
        return { success: true, data: response.data };
    } catch (error) {
        return { 
            success: false, 
            status: error.response?.status || 500, 
            error: error.response?.data || error.message 
        };
    }
};

// 1. On-Ramp : Émission de l'OTP SMS Lumicash
app.post('/api/v1/onramp/request-otp', async (req, res) => {
    if (req.body.mode === 'demo') {
        const amountBif = validateGatewayAmount(req.body.amount);
        const phone = String(req.body.phone || '').trim();
        if (!/^\+?[\d\s().-]{7,20}$/.test(phone)) return res.status(400).json({ success: false, error: 'Saisissez un numéro de téléphone valide.' });
        const order = createGatewayOrder({ operation: 'onramp', status: 'OTP_PENDING', phone, amount_bif: amountBif });
        return res.status(201).json({ success: true, demo: true, demo_otp: '123456', order_id: order.order_id, status: order.status });
    }
    if (!BITLIBERA_API_KEY) return res.status(503).json({ success: false, error: 'Configurez BITLIBERA_API_KEY pour utiliser la passerelle réelle.' });
    const { mode, ...payload } = req.body;
    const result = await callBitliberaAPI('POST', '/api/v1/onramp/request-otp', payload);
    if (!result.success) return res.status(result.status).json(result.error);
    res.json(result.data);
});

// 2. On-Ramp : Validation OTP & Débit Lumicash
app.post('/api/v1/onramp/execute', async (req, res) => {
    if (req.body.mode === 'demo') {
        const order = getGatewayOrder.get(String(req.body.order_id || ''));
        if (!order || order.operation !== 'onramp') return res.status(404).json({ success: false, error: 'Commande BitLibera introuvable.' });
        if (order.status !== 'OTP_PENDING') return res.status(409).json({ success: false, error: 'Cette commande a déjà été traitée.' });
        if (String(req.body.otp || '') !== '123456') return res.status(400).json({ success: false, error: 'Code démo invalide. Utilisez 123456.' });
        updateGatewayOrderStatus.run('COMPLETED', new Date().toISOString(), order.order_id);
        return res.json({ success: true, demo: true, order_id: order.order_id, status: 'COMPLETED' });
    }
    if (!BITLIBERA_API_KEY) return res.status(503).json({ success: false, error: 'Configurez BITLIBERA_API_KEY pour utiliser la passerelle réelle.' });
    const { mode, ...payload } = req.body;
    const result = await callBitliberaAPI('POST', '/api/v1/onramp/execute', payload);
    if (!result.success) return res.status(result.status).json(result.error);
    res.json(result.data);
});

// 3. Off-Ramp : Générer une facture Lightning BOLT11
app.post('/api/v1/offramp/create-invoice', async (req, res) => {
    if (req.body.mode === 'demo') {
        const amountBif = validateGatewayAmount(req.body.amount_bif);
        const phone = String(req.body.recipient_phone || '').trim();
        if (!/^\+?[\d\s().-]{7,20}$/.test(phone)) return res.status(400).json({ success: false, error: 'Saisissez un numéro de téléphone valide.' });
        const order = createGatewayOrder({
            operation: 'offramp', status: 'PENDING_PAYMENT', phone, amount_bif: amountBif,
            invoice: `DEMO-BOLT11-${createId().toUpperCase()}`
        });
        return res.status(201).json({ success: true, demo: true, order_id: order.order_id, status: order.status, payment_request: order.invoice });
    }
    if (!BITLIBERA_API_KEY) return res.status(503).json({ success: false, error: 'Configurez BITLIBERA_API_KEY pour utiliser la passerelle réelle.' });
    const { mode, ...payload } = req.body;
    const result = await callBitliberaAPI('POST', '/api/v1/offramp/create-invoice', payload);
    if (!result.success) return res.status(result.status).json(result.error);
    res.json(result.data);
});

// 4. Vérifier le statut d'une commande en direct
app.get('/api/v1/orders/:orderId', async (req, res) => {
    if (req.query.mode === 'demo') {
        const order = getGatewayOrder.get(req.params.orderId);
        return order ? res.json({ success: true, order }) : res.status(404).json({ success: false, error: 'Commande BitLibera introuvable.' });
    }
    if (!BITLIBERA_API_KEY) return res.status(503).json({ success: false, error: 'Configurez BITLIBERA_API_KEY pour consulter une commande réelle.' });
    const result = await callBitliberaAPI('GET', `/api/v1/orders/${req.params.orderId}`);
    if (!result.success) return res.status(result.status).json(result.error);
    res.json(result.data);
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 502).json({ success: false, error: error.message || 'Une erreur inattendue est survenue.' });
});

// Démarrage du serveur
app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
});