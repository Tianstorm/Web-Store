const { html } = require('zaileys');
const { asJson, rupiah } = require('../utils');

function fulfillmentLines(item) {
  const fulfillment = asJson(item.fulfillment_json, {});
  const entries = [];

  for (const credential of fulfillment.credentials || []) {
    for (const [key, value] of Object.entries(credential)) {
      if (value) entries.push(`${key.replaceAll('_', ' ')}: ${value}`);
    }
  }
  if (fulfillment.serial_number) entries.push(`SN / Token: ${fulfillment.serial_number}`);
  if (fulfillment.message && entries.length === 0) entries.push(fulfillment.message);
  return entries;
}

function receiptText(order, items) {
  const lines = [
    '*RIANSHOP — STRUK DIGITAL*',
    `Order: ${order.public_id}`,
    `Status: ${String(order.status).toUpperCase()}`,
    '',
  ];
  for (const item of items) {
    lines.push(`• ${item.product_name} × ${item.quantity} — ${rupiah(item.unit_price * item.quantity)}`);
    for (const detail of fulfillmentLines(item)) lines.push(`  ${detail}`);
  }
  lines.push('', `Total: ${rupiah(order.total_amount)}`, 'Terima kasih sudah berbelanja.');
  return lines.join('\n');
}

function receiptCard(order, items) {
  const itemRows = items.map((item) => {
    const details = fulfillmentLines(item);
    return html`
      <div class="item">
        <div class="line"><strong>${item.product_name} × ${item.quantity}</strong><span>${rupiah(item.unit_price * item.quantity)}</span></div>
        ${details.map((detail) => html`<div class="detail">${detail}</div>`)}
      </div>
    `;
  });

  return html`
    <style>
      *{box-sizing:border-box}body{margin:0;padding:18px;font:13px system-ui;background:linear-gradient(145deg,#070b18,#15122b);color:#f8fafc}
      .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.brand{font-size:18px;font-weight:900;letter-spacing:.08em;color:#c4b5fd}
      .badge{padding:5px 9px;border-radius:999px;background:#16a34a22;color:#86efac;border:1px solid #22c55e44;font-size:10px;font-weight:800;text-transform:uppercase}
      .order{color:#94a3b8;font-size:11px;margin-bottom:12px}.item{padding:10px 0;border-top:1px solid #ffffff16}.line{display:flex;justify-content:space-between;gap:12px}
      .detail{margin-top:5px;padding:7px 9px;border-radius:8px;background:#ffffff0c;color:#cbd5e1;word-break:break-all}.total{display:flex;justify-content:space-between;padding-top:12px;border-top:1px dashed #ffffff35;font-size:17px;font-weight:900;color:#f0abfc}
      .foot{margin-top:12px;text-align:center;color:#64748b;font-size:10px}
    </style>
    <div class="head"><div class="brand">RIANSHOP</div><div class="badge">${order.status}</div></div>
    <div class="order">Struk digital · ${order.public_id}</div>
    ${itemRows}
    <div class="total"><span>Total</span><span>${rupiah(order.total_amount)}</span></div>
    <div class="foot">Layanan digital otomatis · Simpan struk ini</div>
  `;
}

module.exports = { receiptCard, receiptText };
