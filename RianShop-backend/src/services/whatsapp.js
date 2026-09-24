const fs = require('node:fs');
const { Client, FileAuthStore } = require('zaileys');
const { zaileysAuthPath } = require('../config');
const { getSetting, setSetting } = require('../db');
const { normalizePhone } = require('../utils');
const { receiptCard, receiptText } = require('./receipt');

class WhatsappManager {
  constructor() {
    this.client = null;
    this.state = {
      status: 'disconnected',
      phone: '',
      pairingCode: '',
      pairingExpiresAt: null,
      connectedAs: '',
      error: '',
    };
  }

  snapshot() {
    return { ...this.state };
  }

  async restore() {
    const phone = await getSetting('whatsapp_phone', '');
    if (!phone) return;
    try {
      await this.connect(phone);
    } catch (error) {
      this.state.error = error.message;
    }
  }

  async connect(phoneInput) {
    const phone = normalizePhone(phoneInput);
    if (!/^62\d{8,13}$/.test(phone)) {
      throw new Error('Nomor bot harus format Indonesia, contoh 6281234567890');
    }
    if (this.client) await this.disconnect();

    fs.mkdirSync(zaileysAuthPath, { recursive: true });
    const client = new Client({
      sessionId: 'rianshop',
      authType: 'pairing',
      phoneNumber: phone,
      autoConnect: false,
      qrTerminal: false,
      statusLog: false,
      auth: new FileAuthStore({ basePath: zaileysAuthPath }),
      reconnect: {
        maxAttempts: 20,
        initialDelayMs: 3000,
        maxDelayMs: 60000,
      },
    });

    this.client = client;
    this.state = {
      status: 'connecting',
      phone,
      pairingCode: '',
      pairingExpiresAt: null,
      connectedAs: '',
      error: '',
    };

    client.on('pairing-code', ({ code, expiresAt }) => {
      this.state.status = 'pairing';
      this.state.pairingCode = code;
      this.state.pairingExpiresAt = expiresAt;
    });
    client.on('connect', ({ me }) => {
      this.state.status = 'connected';
      this.state.connectedAs = me.name || me.id;
      this.state.pairingCode = '';
      this.state.pairingExpiresAt = null;
      this.state.error = '';
    });
    client.on('disconnect', ({ willReconnect, reason }) => {
      this.state.status = willReconnect ? 'reconnecting' : 'disconnected';
      this.state.error = willReconnect ? '' : String(reason || '');
    });
    client.on('reconnecting', () => {
      this.state.status = 'reconnecting';
    });
    client.on('error', ({ error }) => {
      this.state.error = error.message;
    });

    await setSetting('whatsapp_phone', phone);
    client.connect().catch((error) => {
      this.state.status = 'error';
      this.state.error = error.message;
    });
    return this.snapshot();
  }

  async disconnect() {
    if (this.client) await this.client.disconnect().catch(() => {});
    this.client = null;
    this.state.status = 'disconnected';
    this.state.pairingCode = '';
    this.state.pairingExpiresAt = null;
  }

  async logout() {
    if (this.client) await this.client.logout().catch(() => {});
    await this.disconnect();
    await setSetting('whatsapp_phone', '');
    this.state.phone = '';
    this.state.connectedAs = '';
  }

  async sendReceipt(order, items) {
    if (!this.client || this.state.status !== 'connected') {
      throw new Error('Bot WhatsApp belum terhubung');
    }
    const jid = `${normalizePhone(order.customer_phone)}@s.whatsapp.net`;
    const text = receiptText(order, items);
    await this.client.send(jid).htmlApp(receiptCard(order, items), {
      title: `Struk ${order.public_id}`,
      height: Math.min(920, 220 + items.length * 120),
      fallback: text,
    });
  }
}

const whatsappManager = new WhatsappManager();

module.exports = { whatsappManager };
