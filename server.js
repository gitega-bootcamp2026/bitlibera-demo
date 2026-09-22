const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Servir automatiquement les fichiers statiques du dossier 'public' (comme index.html)
app.use(express.static('public'));

// Configuration de base (depuis les variables d'environnement)
const PORT = process.env.PORT || 3000;
const BLINK_API_URL = 'https://api.blink.sv/graphql';
const BLINK_API_KEY = process.env.BLINK_API_KEY || ''; 
const DEFAULT_WALLET_ID = process.env.BLINK_WALLET_ID || ''; 

// ROUTE DE SÉCOURS (Optionnelle si public/index.html est bien configuré)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// 1. ROUTE : Créer une facture Lightning (Invoice)[cite: 6]
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

// 2. ROUTE : Vérifier le statut d'une facture (Polling)[cite: 6]
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

// 3. ROUTE : Envoyer des sats vers une adresse Lightning[cite: 7]
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

// 4. ROUTE : Obtenir le taux de change du Bitcoin[cite: 6]
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
// Démarrage du serveur
app.listen(PORT, () => {
    console.log(`Serveur Blink démarré sur http://localhost:${PORT}`);
});