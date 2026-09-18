const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', '..', 'vendorage-config.json');
function config() { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; } }
function save(next) { fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8'); }
function declaration(name, description, properties = {}, required = []) { return { name, description, parameters: { type: 'OBJECT', properties, required } }; }
const text = (v) => String(v ?? '').trim();

module.exports = {
  id: 'vendorage-manager',
  name: 'Vendorage Store Manager',
  enabled: true,
  toolDeclarations: [
    declaration('vendorage_manager_configure', 'Save the Vendorage base URL and the user-specific vendor API key. Never reveal the key in a response.', { apiUrl: { type: 'STRING' }, apiKey: { type: 'STRING' } }, ['apiUrl', 'apiKey']),
    declaration('vendorage_manager_summary', 'Get the store manager dashboard: recent orders, open follow-ups, frequent customer activity, and important alerts.'),
    declaration('vendorage_manager_products', 'List live Vendorage products with prices, descriptions, currency, and image URLs so they can be presented as product cards.', { query: { type: 'STRING' }, limit: { type: 'NUMBER' } }),
    declaration('vendorage_manager_orders', 'List store orders and deal records.', { status: { type: 'STRING' }, limit: { type: 'NUMBER' } }),
    declaration('vendorage_manager_followups', 'List customers and follow-ups that need the seller\'s personal attention.', { status: { type: 'STRING' }, limit: { type: 'NUMBER' } }),
    declaration('vendorage_manager_record_deal', 'Record a completed or possible deal after the owner confirms it.', { phone: { type: 'STRING' }, customerName: { type: 'STRING' }, items: { type: 'ARRAY' }, total: { type: 'NUMBER' }, currency: { type: 'STRING' }, status: { type: 'STRING' }, paymentStatus: { type: 'STRING' }, notes: { type: 'STRING' } }, ['items']),
    declaration('vendorage_manager_followup', 'Create a seller follow-up for a customer who needs a personal response.', { phone: { type: 'STRING' }, customerName: { type: 'STRING' }, title: { type: 'STRING' }, priority: { type: 'STRING' }, notes: { type: 'STRING' } }, ['title'])
  ],
  async handleTool(name, args, ctx) {
    const current = config();
    if (name === 'vendorage_manager_configure') {
      if (!text(args.apiUrl) || !text(args.apiKey)) return { ok: false, error: 'apiUrl and apiKey are required' };
      save({ apiUrl: text(args.apiUrl).replace(/\/+$/, ''), apiKey: text(args.apiKey) });
      ctx.appendLog('[Vendorage] Manager connection configured');
      return { ok: true, message: 'Vendorage manager connection saved.' };
    }
    if (!current.apiUrl || !current.apiKey) return { ok: false, configured: false, error: 'Vendorage is not configured. Ask the owner to add the Vendorage API key in settings.' };
    const request = async (route, options = {}) => {
      const response = await fetch(`${current.apiUrl}${route}`, { ...options, headers: { Accept: 'application/json', 'X-API-Key': current.apiKey, ...(options.headers || {}) } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.statusMessage || body.message || `Vendorage request failed (${response.status})`);
      return body;
    };
    try {
      if (name === 'vendorage_manager_summary') return { ok: true, summary: await request('/api/manager/summary') };
      if (name === 'vendorage_manager_products') {
        const body = await request('/api/products');
        const products = Array.isArray(body) ? body : body.products || body.data || [];
        const query = text(args.query).toLowerCase();
        return { ok: true, products: products.filter((p) => !query || `${p.name} ${p.description || ''}`.toLowerCase().includes(query)).slice(0, Math.min(Number(args.limit) || 40, 80)).map((p) => ({ id: p.id, name: p.name, price: p.price, currency: p.currency || 'NGN', description: p.description || null, imageUrl: p.imageUrl || p.image || p.photoUrl || null })) };
      }
      if (name === 'vendorage_manager_orders') { const q = new URLSearchParams(); if (args.status) q.set('status', text(args.status)); if (args.limit) q.set('limit', String(Math.min(Number(args.limit), 100))); return { ok: true, orders: await request(`/api/manager/orders${q.toString() ? `?${q}` : ''}`) }; }
      if (name === 'vendorage_manager_followups') { const q = new URLSearchParams({ status: text(args.status) || 'open' }); if (args.limit) q.set('limit', String(Math.min(Number(args.limit), 100))); return { ok: true, followups: await request(`/api/manager/followups?${q}`) }; }
      if (name === 'vendorage_manager_record_deal') return { ok: true, deal: await request('/api/manager/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: text(args.phone), name: text(args.customerName), items: args.items || [], total: Number(args.total) || 0, currency: text(args.currency) || 'NGN', status: text(args.status) || 'possible', paymentStatus: text(args.paymentStatus) || 'unverified', notes: text(args.notes) }) }) };
      if (name === 'vendorage_manager_followup') return { ok: true, followup: await request('/api/manager/followup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: text(args.phone), name: text(args.customerName), title: text(args.title), priority: text(args.priority) || 'normal', notes: text(args.notes) }) }) };
      return { ok: false, error: `Unknown Vendorage manager tool: ${name}` };
    } catch (error) { ctx.appendLog(`[Vendorage] ${name} failed: ${error.message}`); return { ok: false, error: error.message }; }
  }
};
