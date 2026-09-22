const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Servir automatiquement les fichiers statiques du dossier 'public'
app.use(express.static('public'));

// Configuration de base (Variables d'environnement)
const PORT = process.env.PORT || 3000;
const BLINK_API_URL = 'https://api.blink.sv/graphql';
const BLINK_API_KEY = process.env.BLINK_API_KEY || ''; 
const DEFAULT_WALLET_ID = process.env.BLINK_WALLET_ID || ''; 

// Configuration BitLibera Gateway
const BITLIBERA_BASE_URL = 'https://exchanger.bitlibera.com';
const BITLIBERA_API_KEY = process.env.BITLIBERA_API_KEY || '';

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
    const result = await callBitliberaAPI('POST', '/api/v1/onramp/request-otp', req.body);
    if (!result.success) return res.status(result.status).json(result.error);
    res.json(result.data);
});

// 2. On-Ramp : Validation OTP & Débit Lumicash
app.post('/api/v1/onramp/execute', async (req, res) => {
    const result = await callBitliberaAPI('POST', '/api/v1/onramp/execute', req.body);
    if (!result.success) return res.status(result.status).json(result.error);
    res.json(result.data);
});

// 3. Off-Ramp : Générer une facture Lightning BOLT11
app.post('/api/v1/offramp/create-invoice', async (req, res) => {
    const result = await callBitliberaAPI('POST', '/api/v1/offramp/create-invoice', req.body);
    if (!result.success) return res.status(result.status).json(result.error);
    res.json(result.data);
});

// 4. Vérifier le statut d'une commande en direct
app.get('/api/v1/orders/:orderId', async (req, res) => {
    const result = await callBitliberaAPI('GET', `/api/v1/orders/${req.params.orderId}`);
    if (!result.success) return res.status(result.status).json(result.error);
    res.json(result.data);
});

// Démarrage du serveur
app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
});