// =============================================================
// whatsapp.js — Singleton wrapper around whatsapp-web.js.
// Manages QR generation, ready/auth events, reconnection, sending.
// =============================================================
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

class WhatsAppManager {
  constructor() {
    this.client = null;
    this.starting = false;
    this.state = {
      connected: false,
      ready: false,
      qrDataUrl: null,
      qrRaw: null,
      qrAge: 0,
      info: null,
      lastError: null,
      lastReadyAt: null,
      startedAt: Date.now(),
      loading: null   // { percent, msg, at }
    };
  }

  // ---------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------
  async start() {
    if (this.starting || this.state.ready) return;
    this.starting = true;

    const puppeteerOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
      puppeteer: puppeteerOpts
      // No webVersionCache override → use library default (local cache).
      // Setting type:'none' causes the well-known "stuck at 99%" issue.
    });

    this.client.on('qr', (qr) => this._onQr(qr));
    this.client.on('loading_screen', (pct, msg) => {
      const percent = parseInt(pct, 10) || 0;
      this.state.loading = { percent, msg: String(msg || ''), at: Date.now() };
      console.log(`[whatsapp] loading ${percent}% — ${msg}`);
    });
    this.client.on('authenticated', () => {
      console.log('[whatsapp] authenticated ✓');
      this.state.qrDataUrl = null;
      this.state.qrRaw = null;
    });
    this.client.on('auth_failure', (msg) => {
      console.error('[whatsapp] auth failure:', msg);
      this.state.lastError = 'auth_failure: ' + msg;
      this.state.connected = false;
      this.state.ready = false;
    });
    this.client.on('ready', () => this._onReady());
    this.client.on('disconnected', (reason) => this._onDisconnected(reason));
    this.client.on('change_state', (s) => {
      console.log('[whatsapp] state:', s);
    });

    try {
      await this.client.initialize();
    } catch (e) {
      console.error('[whatsapp] initialize failed:', e.message);
      this.state.lastError = 'init: ' + e.message;
      this.starting = false;
      // retry after 10s
      setTimeout(() => this.start().catch(() => {}), 10000);
      return;
    }
    this.starting = false;
  }

  async _onQr(qr) {
    try {
      const dataUrl = await QRCode.toDataURL(qr, {
        width: 320,
        margin: 1,
        color: { dark: '#0a0a0a', light: '#ffffff' }
      });
      this.state.qrDataUrl = dataUrl;
      this.state.qrRaw = qr;
      this.state.qrAge = Date.now();
      this.state.connected = false;
      this.state.ready = false;
      console.log('[whatsapp] QR ready — scan it from your phone');
    } catch (e) {
      console.error('[whatsapp] QR encode failed:', e.message);
    }
  }

  _onReady() {
    this.state.connected = true;
    this.state.ready = true;
    this.state.qrDataUrl = null;
    this.state.qrRaw = null;
    this.state.lastError = null;
    this.state.lastReadyAt = Date.now();
    const i = this.client.info;
    this.state.info = i ? {
      wid: i.wid?._serialized,
      pushname: i.pushname,
      platform: i.platform
    } : null;
    console.log(`[whatsapp] ready as ${this.state.info?.pushname || 'unknown'}`);
  }

  _onDisconnected(reason) {
    console.warn('[whatsapp] disconnected:', reason);
    this.state.connected = false;
    this.state.ready = false;
    this.state.lastError = 'disconnected: ' + reason;
    // Try to come back up after a delay.
    setTimeout(() => {
      this.client = null;
      this.start().catch((e) => console.error('[whatsapp] restart failed:', e.message));
    }, 5000);
  }

  async logout() {
    if (!this.client) return;
    try { await this.client.logout(); } catch (e) {
      console.error('[whatsapp] logout error:', e.message);
    }
    this.state.connected = false;
    this.state.ready = false;
    this.state.qrDataUrl = null;
  }

  // ---------------------------------------------------------
  // Sending
  // ---------------------------------------------------------
  async send(phoneOrChatId, message, fileUrl) {
    if (!this.state.ready) {
      const e = new Error('NOT_READY');
      e.code = 'NOT_READY';
      throw e;
    }

    // Already a fully-qualified chat id (group "...@g.us" or contact "...@c.us")?
    // Skip phone parsing and registration check — group IDs aren't registered users.
    if (/@(c|g)\.us$/.test(String(phoneOrChatId))) {
      return await this.sendToChatId(phoneOrChatId, message, fileUrl);
    }

    const chatId = this.toChatId(phoneOrChatId);

    // Verify the number exists on WhatsApp before sending — saves bans & noise.
    let isRegistered = true;
    try {
      isRegistered = await this.client.isRegisteredUser(chatId);
    } catch {
      // network blip — try the send anyway, the lib will surface a real error
    }
    if (!isRegistered) {
      const e = new Error('NOT_REGISTERED');
      e.code = 'NOT_REGISTERED';
      throw e;
    }

    return await this.sendToChatId(chatId, message, fileUrl);
  }

  async fetchMedia(fileUrl) {
    // "internal:" URLs point at files written by /api/upload.
    if (fileUrl.startsWith('internal:')) {
      const localPath = path.resolve(fileUrl.slice('internal:'.length));
      if (!fs.existsSync(localPath)) {
        const e = new Error('FILE_NOT_FOUND'); e.code = 'FILE_NOT_FOUND'; throw e;
      }
      return MessageMedia.fromFilePath(localPath);
    }
    // data: URLs (e.g. an image preview from the dashboard before upload).
    if (fileUrl.startsWith('data:')) {
      const m = fileUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) { const e = new Error('INVALID_DATA_URL'); e.code = 'INVALID_DATA_URL'; throw e; }
      return new MessageMedia(m[1], m[2], 'attachment');
    }
    if (/^https?:\/\//i.test(fileUrl)) {
      return await MessageMedia.fromUrl(fileUrl, { unsafeMime: true });
    }
    // Best-effort: treat as a path on disk.
    if (fs.existsSync(fileUrl)) return MessageMedia.fromFilePath(fileUrl);

    const e = new Error('INVALID_FILE_URL');
    e.code = 'INVALID_FILE_URL';
    throw e;
  }

  // ---------------------------------------------------------
  // Contacts & Groups (cached for 60s)
  // ---------------------------------------------------------
  async getContacts(forceFresh = false) {
    if (!this.state.ready) {
      const e = new Error('NOT_READY'); e.code = 'NOT_READY'; throw e;
    }
    const ttl = 60 * 1000;
    if (!forceFresh && this._contactsCache &&
        (Date.now() - this._contactsCache.at) < ttl) {
      return this._contactsCache.data;
    }
    const raw = await this.client.getContacts();
    const contacts = raw
      .filter(c => c.id?._serialized?.endsWith('@c.us'))
      .filter(c => c.isMyContact || c.name || c.pushname)
      .filter(c => !c.isGroup)
      .map(c => ({
        id:       c.id._serialized,
        phone:    c.id.user,
        name:     c.name || c.pushname || c.shortName || c.id.user,
        pushname: c.pushname || null,
        isBusiness: !!c.isBusiness,
        isMyContact: !!c.isMyContact
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));

    this._contactsCache = { at: Date.now(), data: contacts };
    return contacts;
  }

  async getGroups(forceFresh = false) {
    if (!this.state.ready) {
      const e = new Error('NOT_READY'); e.code = 'NOT_READY'; throw e;
    }
    const ttl = 60 * 1000;
    if (!forceFresh && this._groupsCache &&
        (Date.now() - this._groupsCache.at) < ttl) {
      return this._groupsCache.data;
    }
    const chats = await this.client.getChats();
    const groups = chats
      .filter(c => c.isGroup)
      .map(c => ({
        id:           c.id._serialized,
        name:         c.name || '(ללא שם)',
        participants: c.participants?.length || 0,
        unread:       c.unreadCount || 0,
        archived:     !!c.archived,
        timestamp:    c.timestamp || null
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));

    this._groupsCache = { at: Date.now(), data: groups };
    return groups;
  }

  invalidateCaches() {
    this._contactsCache = null;
    this._groupsCache = null;
    this._picCache = null;
  }

  /**
   * Lazy-fetch the profile picture URL for a chat id (group or contact).
   * Returns a CDN URL (browser-renderable) or null. Cached for 15min so
   * we don't hammer WhatsApp servers when the dashboard re-renders.
   */
  async getProfilePic(chatId) {
    if (!this.state.ready) {
      const e = new Error('NOT_READY'); e.code = 'NOT_READY'; throw e;
    }
    this._picCache = this._picCache || new Map();
    const ttl = 15 * 60 * 1000;
    const cached = this._picCache.get(chatId);
    if (cached && (Date.now() - cached.at) < ttl) return cached.url;

    let url = null;
    try {
      // Both Contact and GroupChat in whatsapp-web.js expose getProfilePicUrl().
      // For groups we need the Chat object; for contacts, the Contact.
      const isGroup = /@g\.us$/.test(chatId);
      if (isGroup) {
        const chat = await this.client.getChatById(chatId);
        url = await chat.getProfilePicUrl();
      } else {
        const id = chatId.endsWith('@c.us') ? chatId : `${this.normalizePhone(chatId)}@c.us`;
        const contact = await this.client.getContactById(id);
        url = await contact.getProfilePicUrl();
      }
    } catch {
      url = null;
    }

    this._picCache.set(chatId, { at: Date.now(), url: url || null });
    return url || null;
  }

  /**
   * Send to a recipient that may already be a chat-id (group or @c.us)
   * or a plain phone string.
   */
  async sendToChatId(chatId, message, fileUrl) {
    if (!this.state.ready) {
      const e = new Error('NOT_READY'); e.code = 'NOT_READY'; throw e;
    }
    if (fileUrl) {
      const media = await this.fetchMedia(fileUrl);
      const r = await this.client.sendMessage(chatId, media, { caption: message || '' });
      return { id: r.id?._serialized, ack: r.ack };
    }
    if (!message || !String(message).trim()) {
      const e = new Error('EMPTY_MESSAGE'); e.code = 'EMPTY_MESSAGE'; throw e;
    }
    const r = await this.client.sendMessage(chatId, message);
    return { id: r.id?._serialized, ack: r.ack };
  }

  // ---------------------------------------------------------
  // Phone helpers
  // ---------------------------------------------------------
  toChatId(phone) {
    const norm = this.normalizePhone(phone);
    return `${norm}@c.us`;
  }

  /**
   * Normalize a free-form phone string to a WhatsApp-friendly digits-only
   * E.164-ish form. Defaults Israel (972) when a leading 0 is detected, or
   * when given a 9-digit number without a country prefix.
   */
  normalizePhone(input) {
    let p = String(input ?? '').replace(/\D/g, '');
    if (!p) { const e = new Error('INVALID_PHONE'); e.code = 'INVALID_PHONE'; throw e; }
    if (p.startsWith('00')) p = p.slice(2);
    if (p.startsWith('0'))  p = '972' + p.slice(1);
    if (!p.startsWith('972') && p.length === 9) p = '972' + p;
    if (p.length < 10 || p.length > 15) {
      const e = new Error('INVALID_PHONE'); e.code = 'INVALID_PHONE'; throw e;
    }
    return p;
  }

  // ---------------------------------------------------------
  // Status snapshot for /api/status
  // ---------------------------------------------------------
  getStatus() {
    return {
      connected: this.state.connected,
      ready:     this.state.ready,
      qr:        this.state.qrDataUrl,
      info:      this.state.info,
      uptimeMs:  Date.now() - this.state.startedAt,
      lastError: this.state.lastError,
      lastReadyAt: this.state.lastReadyAt,
      loading:   this.state.loading
    };
  }
}

module.exports = new WhatsAppManager();
