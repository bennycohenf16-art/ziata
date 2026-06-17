require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        fetchLatestBaileysVersion, isJidGroup } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const Groq = require('groq-sdk');


const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const app = express();
app.use(express.json());

const ADMIN_RAW = (process.env.ADMIN_NUMBER || '').replace(/@.*/, '');
const ADMIN_JID = ADMIN_RAW ? `${ADMIN_RAW}@s.whatsapp.net` : null;
const NOMBRE = process.env.AGENTE_NOMBRE || 'Asistente';

let qrDataURL = null;
let botConnected = false;
const conversations = {};

const CONV_FILE = './conversations.json';
function saveConversations() {
  try { require('fs').writeFileSync(CONV_FILE, JSON.stringify(conversations)); } catch {}
}
function loadConversations() {
  try {
    const data = JSON.parse(require('fs').readFileSync(CONV_FILE, 'utf8'));
    for (const [jid, msgs] of Object.entries(data)) conversations[jid] = msgs;
    console.log('[memoria] Conversaciones restauradas:', Object.keys(data).length, 'chats');
  } catch {}
}
loadConversations();



app.get('/', (req, res) => {
  if (qrDataURL) {
    res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5;font-family:sans-serif;">
      <h2>Escanea el QR con WhatsApp</h2>
      <img src="${qrDataURL}" style="width:300px;height:300px;border:4px solid #25d366;border-radius:12px">
      <p style="color:#666">Actualiza la página si el código expiró</p>
    </body></html>`);
  } else if (botConnected) {
    res.send('<html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5;font-family:sans-serif;"><h2 style="color:#25d366">✅ Bot conectado y activo</h2></body></html>');
  } else {
    res.send('<html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh"><h2>Iniciando bot...</h2></body></html>');
  }
});

app.listen(process.env.PORT || 3000);

async function askGroq(jid, userMsg) {
  if (!conversations[jid]) conversations[jid] = [];
  conversations[jid].push({ role: 'user', content: userMsg });
  if (conversations[jid].length > 20) conversations[jid] = conversations[jid].slice(-20);

  const resp = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: `hola` },
      ...conversations[jid]
    ],
    max_tokens: 800
  });

  const reply = resp.choices[0].message.content;
  conversations[jid].push({ role: 'assistant', content: reply });
  saveConversations();
  return reply;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Bot', 'Chrome', '3.0']
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrDataURL = await QRCode.toDataURL(qr);
      try { require('qrcode-terminal').generate(qr, { small: true }); } catch(_) {}
      console.log('Escanea el QR con WhatsApp para conectar el bot.');
    }
    if (connection === 'open') { qrDataURL = null; botConnected = true; console.log('Conectado a WhatsApp.'); }
    if (connection === 'close') {
      botConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        require('fs').rmSync('./auth_info', { recursive: true, force: true });
      }
      setTimeout(startBot, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.key.remoteJid || isJidGroup(msg.key.remoteJid)) continue;
      const jid = msg.key.remoteJid;
      const texto = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
      if (!texto) continue;
      try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
        // Catalog request detection
        if (/cat[aá]logo|pdf|informaci[oó]n|brochure|folleto/i.test(texto)) {
          const cats = JSON.parse(require('fs').readFileSync('./catalogs/index.json','utf8'));
        if (cats.length > 0) {
          for (const cat of cats) {
            await sock.sendMessage(jid, {
              document: require('fs').readFileSync(`./catalogs/${cat.filename}`),
              mimetype: 'application/pdf',
              fileName: cat.name.endsWith('.pdf') ? cat.name : cat.name + '.pdf'
            });
          }
          await sock.sendMessage(jid, { text: cats.length === 1 ? '📄 Aquí está el catálogo.' : `📄 Te envié ${cats.length} catálogos.` });
          continue;
        } else {
          await sock.sendMessage(jid, { text: 'Por el momento no tenemos catálogos disponibles.' });
          continue;
        }
        }
        const respuesta = await askGroq(jid, texto);
        await sock.sendMessage(jid, { text: respuesta });
        await sock.sendPresenceUpdate('paused', jid);
      } catch (err) {
        console.error(err);
        await sock.sendPresenceUpdate('paused', jid);
        await sock.sendMessage(jid, { text: 'Ocurrió un error. Intenta de nuevo.' });
      }
    }
  });
}

startBot();