const preferredMode = localStorage.getItem('bitlibera-mode') || 'demo';
const state = { mode: 'demo', gatewayMode: localStorage.getItem('bitlibera-gateway-mode') || 'demo', transactions: [], gatewayOrders: [], filter: 'all', query: '', config: null, gatewayConfig: null };
const labels = { overview: 'Vue d’ensemble', receive: 'Recevoir', send: 'Envoyer', activity: 'Activité', settings: 'Configuration', gateway: 'BitLibera Gateway' };
const numberFormat = new Intl.NumberFormat('fr-FR');
const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
let toastTimer;
let monitoredInvoiceId = null;
let paymentSocket = null;
let paymentPollTimer = null;
let paymentFallbackTimer = null;

function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function request(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.error || `Erreur HTTP ${response.status}`);
    return data;
}

function showToast(message, isError = false) {
    const toast = document.querySelector('#toast');
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3300);
}

function setView(name) {
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
    document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
    document.querySelector('#breadcrumb-current').textContent = labels[name] || labels.overview;
    history.replaceState(null, '', `#${name}`);
    if (name === 'activity') renderActivity();
    if (name === 'gateway') loadGatewayOrders();
}

function setMode(mode) {
    if (mode === 'live') {
        const canUseLive = state.config && state.config.liveReceive;
        if (!canUseLive) {
            showToast('Configurez BLINK_WALLET_ID côté serveur pour activer le mode réel.', true);
            return;
        }
    }
    state.mode = mode;
    localStorage.setItem('bitlibera-mode', mode);
    document.querySelectorAll('.mode-option, [data-mode="demo"]').forEach((button) => {
        if (button.classList.contains('mode-option')) button.classList.toggle('selected', button.dataset.mode === mode);
    });
    document.querySelector('#mode-indicator').classList.toggle('live', mode === 'live');
    document.querySelector('#mode-indicator').title = mode === 'live' ? 'Mode réel' : 'Mode de démonstration';
    document.querySelector('#footer-mode').textContent = mode === 'live' ? 'MODE RÉEL' : 'MODE DÉMO';
    document.querySelector('#send-warning').textContent = mode === 'live'
        ? 'En mode réel, ce paiement sera envoyé immédiatement et ne pourra pas être annulé.'
        : 'Mode démo : le paiement sera simulé, aucun fonds ne sera déplacé.';
}

function setGatewayMode(mode) {
    if (mode === 'live' && !state.gatewayConfig?.configured) {
        showToast('Configurez BITLIBERA_API_KEY côté serveur pour activer la passerelle réelle.', true);
        return;
    }
    state.gatewayMode = mode;
    localStorage.setItem('bitlibera-gateway-mode', mode);
    document.querySelectorAll('[data-gateway-mode]').forEach((button) => button.classList.toggle('selected', button.dataset.gatewayMode === mode));
    document.querySelector('#gateway-notice').innerHTML = mode === 'demo'
        ? '<span class="gateway-notice-dot"></span><span>Mode démo actif : aucune demande SMS, aucun débit et aucun paiement réel. Code OTP de test : <strong>123456</strong>.</span>'
        : '<span class="gateway-notice-dot live"></span><span>Mode réel actif : les opérations sont transmises à la passerelle BitLibera.</span>';
}

function statusMarkup(status, mode) {
    const value = String(status || 'PENDING').toUpperCase();
    let className = 'pending';
    let label = value;
    if (['PAID', 'SUCCESS', 'SUCCEEDED', 'SETTLED'].includes(value)) { className = ''; label = 'Confirmé'; }
    if (['FAILED', 'ERROR', 'REJECTED', 'EXPIRED'].includes(value)) { className = 'failed'; label = value === 'EXPIRED' ? 'Expiré' : 'Échec'; }
    if (mode === 'demo') className += ' demo';
    return `<span class="status-pill ${className}">${escapeHtml(label)}${mode === 'demo' ? ' · DÉMO' : ''}</span>`;
}

function operationMarkup(transaction) {
    const isReceive = transaction.direction === 'receive';
    const title = isReceive ? 'Réception' : 'Envoi';
    const detail = transaction.counterparty || transaction.memo || 'Facture Lightning';
    return `<span class="transaction-kind"><span class="transaction-icon ${isReceive ? '' : 'send'}">${isReceive ? '↙' : '↗'}</span>${title}</span><span class="mono muted-cell">${escapeHtml(detail)}</span>`;
}

function renderTableRows(transactions, showActions = false) {
    if (!transactions.length) return '';
    return transactions.map((transaction) => {
        const isReceive = transaction.direction === 'receive';
        const date = dateFormat.format(new Date(transaction.created_at));
        const detail = transaction.counterparty || transaction.memo || (transaction.mode === 'demo' ? 'Facture de démonstration' : 'Facture Lightning');
        const checkAction = isReceive && transaction.status === 'PENDING'
            ? `<button class="row-action" data-action="${transaction.mode === 'demo' ? 'simulate' : 'check'}" data-id="${escapeHtml(transaction.id)}">${transaction.mode === 'demo' ? 'Simuler paiement' : 'Vérifier'}</button>`
            : '';
        return `<tr>
            <td>${operationMarkup(transaction)}</td>
            <td class="muted-cell">${escapeHtml(date)}</td>
            <td class="mono muted-cell">${escapeHtml(detail)}</td>
            <td class="amount-cell">${isReceive ? '+' : '−'}${numberFormat.format(transaction.amount_sats)} sats</td>
            <td>${statusMarkup(transaction.status, transaction.mode)}</td>
            ${showActions ? `<td>${checkAction}</td>` : ''}
        </tr>`;
    }).join('');
}

function updateDashboard() {
    const received = state.transactions.filter((transaction) => transaction.direction === 'receive' && transaction.status === 'PAID')
        .reduce((total, transaction) => total + Number(transaction.amount_sats), 0);
    const sent = state.transactions.filter((transaction) => transaction.direction === 'send' && ['SUCCESS', 'SUCCEEDED', 'SETTLED'].includes(transaction.status))
        .reduce((total, transaction) => total + Number(transaction.amount_sats), 0);
    const pending = state.transactions.filter((transaction) => transaction.status === 'PENDING').length;
    document.querySelector('#stat-received').innerHTML = `${numberFormat.format(received)} <small>sats</small>`;
    document.querySelector('#stat-sent').innerHTML = `${numberFormat.format(sent)} <small>sats</small>`;
    document.querySelector('#stat-pending').textContent = numberFormat.format(pending);
    const recent = state.transactions.slice(0, 5);
    document.querySelector('#recent-transactions').innerHTML = renderTableRows(recent);
    document.querySelector('#recent-empty').classList.toggle('visible', !recent.length);
}

function renderActivity() {
    const filtered = state.transactions.filter((transaction) => {
        const matchesType = state.filter === 'all' || transaction.direction === state.filter;
        const haystack = `${transaction.counterparty} ${transaction.memo} ${transaction.id}`.toLowerCase();
        return matchesType && haystack.includes(state.query.toLowerCase());
    });
    document.querySelector('#activity-transactions').innerHTML = renderTableRows(filtered, true);
    document.querySelector('#activity-empty').classList.toggle('visible', !filtered.length);
}

async function loadTransactions() {
    const data = await request('/api/transactions');
    state.transactions = data.transactions;
    updateDashboard();
    renderActivity();
}

function renderGatewayOrders() {
    const rows = state.gatewayOrders.map((order) => {
        const type = order.operation === 'onramp' ? 'Achat de sats' : 'Vente de sats';
        const date = dateFormat.format(new Date(order.created_at));
        const status = order.status === 'COMPLETED' ? 'Terminé' : order.status === 'OTP_PENDING' ? 'OTP requis' : 'Facture en attente';
        return `<tr><td>${escapeHtml(type)}</td><td class="muted-cell">${escapeHtml(date)}</td><td class="mono muted-cell">${escapeHtml(order.phone)}</td><td class="amount-cell">${numberFormat.format(order.amount_bif)} BIF</td><td>${statusMarkup(order.status === 'COMPLETED' ? 'SUCCESS' : 'PENDING', 'demo')}</td><td><button class="row-action" data-gateway-order-check="${escapeHtml(order.order_id)}">Détails</button></td></tr>`;
    }).join('');
    document.querySelector('#gateway-orders').innerHTML = rows;
    document.querySelector('#gateway-orders-empty').classList.toggle('visible', !rows);
}

async function loadGatewayOrders() {
    try {
        const data = await request('/api/bitlibera/orders');
        state.gatewayOrders = data.orders;
        renderGatewayOrders();
    } catch (error) { showToast(error.message, true); }
}

function showGatewayResponse(title, data) {
    document.querySelector('#gateway-result').innerHTML = `<strong>${escapeHtml(title)}</strong><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
}

async function handleOnrampRequest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = await request('/api/v1/onramp/request-otp', { method: 'POST', body: JSON.stringify({
        phone: form.elements.phone.value,
        amount: form.elements.amount.value,
        mode: state.gatewayMode
    }) });
    form.elements.order_id.value = data.order_id || '';
    if (data.demo_otp) form.elements.otp.value = data.demo_otp;
    showGatewayResponse(data.demo ? 'Demande OTP de démonstration créée' : 'Réponse BitLibera · demande OTP', data);
    await loadGatewayOrders();
    showToast(data.demo ? 'Commande démo créée; le code de test est 123456.' : 'Demande OTP envoyée.');
}

async function handleOnrampExecute() {
    const form = document.querySelector('#onramp-form');
    if (!form.elements.order_id.value.trim() || !form.elements.otp.value.trim()) {
        showToast('Saisissez la référence de commande et le code OTP.', true);
        return;
    }
    const data = await request('/api/v1/onramp/execute', { method: 'POST', body: JSON.stringify({
        phone: form.elements.phone.value,
        amount: form.elements.amount.value,
        otp: form.elements.otp.value,
        order_id: form.elements.order_id.value,
        mode: state.gatewayMode
    }) });
    showGatewayResponse(data.demo ? 'Débit simulé' : 'Réponse BitLibera · débit Lumicash', data);
    await loadGatewayOrders();
    showToast(data.demo ? 'Débit de démonstration enregistré.' : 'Demande de débit transmise.');
}

async function handleOfframp(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = await request('/api/v1/offramp/create-invoice', { method: 'POST', body: JSON.stringify({
        recipient_phone: form.elements.recipient_phone.value,
        amount_bif: form.elements.amount_bif.value,
        mode: state.gatewayMode
    }) });
    showGatewayResponse(data.demo ? 'Facture de démonstration créée' : 'Réponse BitLibera · facture Off-Ramp', data);
    await loadGatewayOrders();
    showToast(data.demo ? 'Facture fictive créée; elle ne peut pas recevoir de sats.' : 'Facture BitLibera créée.');
}

async function checkGatewayOrder(orderId) {
    const mode = state.gatewayMode === 'demo' ? '?mode=demo' : '';
    const data = await request(`/api/v1/orders/${encodeURIComponent(orderId)}${mode}`);
    showGatewayResponse('Statut de la commande', data);
}

function renderInvoice(transaction) {
    const isDemo = transaction.mode === 'demo';
    const statusText = ['PAID', 'SUCCESS', 'SUCCEEDED', 'SETTLED'].includes(transaction.status)
        ? 'Paiement confirmé'
        : transaction.status === 'PENDING' ? 'En attente de paiement' : transaction.status;
    document.querySelector('#invoice-result').innerHTML = `<div class="invoice-result">
        <div class="result-heading"><h2>Facture créée</h2><span class="demo-tag">${isDemo ? 'SIMULATION' : 'BLINK · LIVE'}</span></div>
        <div class="invoice-amount">${numberFormat.format(transaction.amount_sats)} <span class="mono muted-cell">sats</span></div>
        <div class="invoice-code" id="invoice-code">${escapeHtml(transaction.payment_request)}</div>
        <button type="button" class="copy-button" id="copy-invoice">Copier la référence</button>
        <div class="invoice-meta"><div class="aside-row"><span>Statut</span><strong>${escapeHtml(statusText)}</strong></div><div class="aside-row"><span>Référence</span><strong>${escapeHtml(transaction.id)}</strong></div><div class="aside-row"><span>Expiration</span><strong>${isDemo ? 'Aucune · mode démo' : '15 minutes'}</strong></div></div>
        ${isDemo ? '<div class="invoice-actions">' + (transaction.status === 'PENDING' ? '<button type="button" class="button button-primary" id="simulate-invoice" data-id="' + escapeHtml(transaction.id) + '">✓ Simuler le paiement</button>' : '') + '<p class="form-note">Cette référence est fictive et ne peut pas être payée sur Lightning.</p></div>' : ''}
    </div>`;
    document.querySelector('#copy-invoice').addEventListener('click', async () => {
        await navigator.clipboard.writeText(transaction.payment_request);
        showToast('Référence copiée.');
    });
    document.querySelector('#simulate-invoice')?.addEventListener('click', () => simulatePayment(transaction.id));
    if (!isDemo && transaction.status === 'PENDING') monitorLiveInvoice(transaction);
    else stopPaymentMonitoring();
}

function stopPaymentMonitoring() {
    monitoredInvoiceId = null;
    clearTimeout(paymentPollTimer);
    clearTimeout(paymentFallbackTimer);
    paymentSocket?.close();
    paymentSocket = null;
}

async function refreshLiveInvoice(id) {
    const data = await request(`/api/transactions/${encodeURIComponent(id)}/check`, { method: 'POST', body: '{}' });
    await loadTransactions();
    const transaction = state.transactions.find((entry) => entry.id === id) || data.transaction;
    renderInvoice(transaction);
    if (transaction.status !== 'PENDING') {
        stopPaymentMonitoring();
        showToast('Statut de la facture Blink actualisé.');
        return true;
    }
    return false;
}

function startInvoicePolling(id, delay = 1000) {
    if (monitoredInvoiceId !== id || paymentPollTimer) return;
    paymentPollTimer = setTimeout(async () => {
        paymentPollTimer = null;
        try {
            if (await refreshLiveInvoice(id)) return;
            startInvoicePolling(id, 5000);
        } catch {
            startInvoicePolling(id, 8000);
        }
    }, delay);
}

function monitorLiveInvoice(transaction) {
    stopPaymentMonitoring();
    monitoredInvoiceId = transaction.id;
    const startPolling = () => {
        clearTimeout(paymentFallbackTimer);
        paymentFallbackTimer = null;
        paymentSocket?.close();
        paymentSocket = null;
        startInvoicePolling(transaction.id);
    };

    if (!('WebSocket' in window)) {
        startPolling();
        return;
    }

    try {
        paymentSocket = new WebSocket('wss://ws.blink.sv/graphql', 'graphql-transport-ws');
        paymentSocket.onopen = () => paymentSocket.send(JSON.stringify({ type: 'connection_init', payload: {} }));
        paymentSocket.onmessage = async (event) => {
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.type === 'connection_ack') {
                paymentSocket.send(JSON.stringify({
                    id: '1',
                    type: 'subscribe',
                    payload: {
                        query: 'subscription LnInvoicePaymentStatusByPaymentRequest($input: LnInvoicePaymentStatusByPaymentRequestInput!) { lnInvoicePaymentStatusByPaymentRequest(input: $input) { paymentRequest status } }',
                        variables: { input: { paymentRequest: transaction.payment_request } }
                    }
                }));
                return;
            }
            const status = message.payload?.data?.lnInvoicePaymentStatusByPaymentRequest?.status;
            if (message.type === 'data' && status && status !== 'PENDING') {
                try { await refreshLiveInvoice(transaction.id); } catch { startPolling(); }
            }
            if (message.type === 'error') startPolling();
        };
        paymentSocket.onerror = startPolling;
        paymentSocket.onclose = () => {
            if (monitoredInvoiceId === transaction.id && !paymentPollTimer) startPolling();
        };
        paymentFallbackTimer = setTimeout(startPolling, 10000);
    } catch {
        startPolling();
    }
}

async function simulatePayment(id) {
    try {
        await request(`/api/transactions/${encodeURIComponent(id)}/simulate-payment`, { method: 'POST', body: '{}' });
        await loadTransactions();
        const current = state.transactions.find((transaction) => transaction.id === id);
        if (current) renderInvoice(current);
        showToast('Paiement simulé et enregistré dans SQLite.');
    } catch (error) { showToast(error.message, true); }
}

async function handleInvoice(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Création…';
    try {
        const data = await request('/api/invoices', { method: 'POST', body: JSON.stringify({
            amountSats: form.elements.amountSats.value,
            memo: form.elements.memo.value,
            mode: state.mode
        }) });
        renderInvoice(data.transaction);
        await loadTransactions();
        showToast(state.mode === 'demo' ? 'Facture de démonstration créée.' : 'Facture Blink créée.');
    } catch (error) { showToast(error.message, true); }
    finally { submit.disabled = false; submit.innerHTML = '<span>＋</span> Créer la facture'; }
}

async function handlePayment(event) {
    event.preventDefault();
    if (state.mode === 'live' && !state.config?.liveSend) {
        showToast('Configurez BLINK_API_KEY et BLINK_WALLET_ID pour envoyer en mode réel.', true);
        return;
    }
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    if (state.mode === 'live' && !window.confirm('Confirmer l’envoi réel de ce paiement Lightning ? Cette action est irréversible.')) return;
    submit.disabled = true;
    submit.textContent = 'Envoi…';
    try {
        const data = await request('/api/payments', { method: 'POST', body: JSON.stringify({
            destination: form.elements.destination.value,
            amountSats: form.elements.amountSats.value,
            mode: state.mode
        }) });
        await loadTransactions();
        form.reset();
        showToast(state.mode === 'demo' ? 'Paiement simulé et ajouté à l’historique.' : `Statut Blink : ${data.transaction.status}`);
        setView('activity');
    } catch (error) { showToast(error.message, true); }
    finally { submit.disabled = false; submit.innerHTML = '<span>↗</span> Continuer'; }
}

async function handleRowAction(button) {
    const id = button.dataset.id;
    const action = button.dataset.action;
    button.disabled = true;
    try {
        await request(`/api/transactions/${encodeURIComponent(id)}/${action === 'simulate' ? 'simulate-payment' : 'check'}`, { method: 'POST', body: '{}' });
        await loadTransactions();
        showToast(action === 'simulate' ? 'Paiement simulé.' : 'Statut Blink actualisé.');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
}

async function loadConfig() {
    try {
        state.config = await request('/api/health');
        state.gatewayConfig = await request('/api/bitlibera/health');
        document.querySelector('#network-label').textContent = state.config.liveReceive ? 'Connecté · Blink' : 'Mode démo disponible';
        document.querySelector('#receive-config').textContent = state.config.liveReceive ? 'Wallet Blink configuré' : 'BLINK_WALLET_ID manquant';
        document.querySelector('#send-config').textContent = state.config.liveSend ? 'Wallet et clé API configurés' : 'BLINK_API_KEY manquante';
        document.querySelector('#receive-status').classList.toggle('ready', state.config.liveReceive);
        document.querySelector('#send-status').classList.toggle('ready', state.config.liveSend);
        document.querySelectorAll('.mode-option[data-mode="live"]').forEach((button) => { button.disabled = !state.config.liveReceive; });
        setMode(preferredMode === 'live' ? 'live' : 'demo');
        document.querySelector('[data-gateway-mode="live"]').disabled = !state.gatewayConfig.configured;
        setGatewayMode(state.gatewayMode === 'live' ? 'live' : 'demo');
    } catch { document.querySelector('#network-label').textContent = 'Serveur indisponible'; }
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.querySelectorAll('[data-amount]').forEach((button) => button.addEventListener('click', () => { document.querySelector('#invoice-amount').value = button.dataset.amount; }));
document.querySelector('#invoice-form').addEventListener('submit', handleInvoice);
document.querySelector('#payment-form').addEventListener('submit', handlePayment);
document.querySelector('#logout-button').addEventListener('click', async () => {
    await request('/api/auth/logout', { method: 'POST', body: '{}' });
    location.assign('/login');
});
document.querySelector('#onramp-form').addEventListener('submit', (event) => handleOnrampRequest(event).catch((error) => showToast(error.message, true)));
document.querySelector('#execute-onramp').addEventListener('click', () => handleOnrampExecute().catch((error) => showToast(error.message, true)));
document.querySelector('#offramp-form').addEventListener('submit', (event) => handleOfframp(event).catch((error) => showToast(error.message, true)));
document.querySelectorAll('[data-gateway-mode]').forEach((button) => button.addEventListener('click', () => setGatewayMode(button.dataset.gatewayMode)));
document.querySelector('#refresh-gateway-orders').addEventListener('click', () => loadGatewayOrders().then(() => showToast('Commandes BitLibera actualisées.')));
document.querySelector('#refresh-activity').addEventListener('click', () => loadTransactions().then(() => showToast('Historique actualisé.')).catch((error) => showToast(error.message, true)));
document.querySelector('#activity-search').addEventListener('input', (event) => { state.query = event.target.value; renderActivity(); });
document.querySelectorAll('.filter-option').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.filter-option').forEach((option) => option.classList.toggle('selected', option === button));
    renderActivity();
}));
document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button) handleRowAction(button);
    const gatewayButton = event.target.closest('[data-gateway-order-check]');
    if (gatewayButton) checkGatewayOrder(gatewayButton.dataset.gatewayOrderCheck).catch((error) => showToast(error.message, true));
});

setMode('demo');
setView(Object.hasOwn(labels, location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
Promise.all([loadConfig(), loadTransactions()]).catch((error) => showToast(error.message, true));
setInterval(() => loadTransactions().catch(() => {}), 15000);