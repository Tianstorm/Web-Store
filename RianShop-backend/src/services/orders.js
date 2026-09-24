const crypto = require('node:crypto');
const { db } = require('../db');
const { frontendUrl } = require('../config');
const { asJson, createPublicId, interpolate, isValidPhone, normalizePhone } = require('../utils');
const { createPayment, getPayment } = require('./ripay');
const { topup } = require('./digiflazz');
const { whatsappManager } = require('./whatsapp');

function serializeProduct(row) {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    name: String(row.name),
    category: String(row.category),
    description: String(row.description || ''),
    price: Number(row.price),
    stock: Number(row.stock),
    image_url: String(row.image_url || ''),
    icon: String(row.icon || 'sparkles'),
    fulfillment_type: String(row.fulfillment_type),
    provider_sku: String(row.provider_sku || ''),
    customer_fields: asJson(row.customer_fields_json, []),
    metadata: asJson(row.metadata_json, {}),
    active: Boolean(row.active),
  };
}

function serializeOrder(row, items = []) {
  return {
    public_id: String(row.public_id),
    customer_name: String(row.customer_name),
    customer_phone: String(row.customer_phone),
    customer_email: String(row.customer_email || ''),
    total_amount: Number(row.total_amount),
    status: String(row.status),
    payment_url: String(row.payment_url || ''),
    qr_image_url: String(row.qr_image_url || ''),
    payment_expires_at: row.payment_expires_at || null,
    paid_at: row.paid_at || null,
    completed_at: row.completed_at || null,
    failure_reason: String(row.failure_reason || ''),
    created_at: row.created_at,
    items: items.map((item) => ({
      id: Number(item.id),
      product_name: String(item.product_name),
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
      status: String(item.status),
      customer_data: asJson(item.customer_data_json, {}),
      fulfillment: asJson(item.fulfillment_json, {}),
    })),
  };
}

function accessTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function assertOrderAccess(row, token) {
  const expected = String(row.access_token_hash || '');
  const actual = accessTokenHash(token);
  if (
    !expected ||
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  ) {
    const error = new Error('Token akses pesanan tidak valid');
    error.status = 403;
    throw error;
  }
}

async function getOrder(publicId) {
  const result = await db.execute({
    sql: 'SELECT * FROM orders WHERE public_id = ?',
    args: [publicId],
  });
  const order = result.rows[0];
  if (!order) return null;
  const items = await db.execute({
    sql: 'SELECT * FROM order_items WHERE order_id = ? ORDER BY id',
    args: [order.id],
  });
  return { row: order, items: items.rows };
}

function validateCustomerData(product, data) {
  const customerData = data && typeof data === 'object' ? data : {};
  for (const field of product.customer_fields) {
    const value = String(customerData[field.name] || '').trim();
    if (field.required && !value) {
      throw new Error(`${field.label || field.name} wajib diisi untuk ${product.name}`);
    }
    if (value.length > 200) {
      throw new Error(`${field.label || field.name} terlalu panjang`);
    }
    if (value && field.type === 'tel' && !/^\d{8,16}$/.test(value.replace(/\D/g, ''))) {
      throw new Error(`${field.label || field.name} tidak valid`);
    }
  }
  return customerData;
}

async function createOrder(input) {
  const customerName = String(input.customer_name || '').trim();
  const customerPhone = normalizePhone(input.customer_phone);
  const customerEmail = String(input.customer_email || '').trim().toLowerCase();
  const cart = Array.isArray(input.items) ? input.items : [];
  if (customerName.length < 2) throw new Error('Nama pelanggan wajib diisi');
  if (!isValidPhone(customerPhone)) throw new Error('Nomor WhatsApp pelanggan tidak valid');
  if (cart.length === 0 || cart.length > 20) throw new Error('Keranjang tidak valid');

  const ids = [...new Set(cart.map((item) => Number(item.product_id)).filter(Boolean))];
  const placeholders = ids.map(() => '?').join(',');
  const productsResult = await db.execute({
    sql: `SELECT * FROM products WHERE active = 1 AND id IN (${placeholders || 'NULL'})`,
    args: ids,
  });
  const productMap = new Map(
    productsResult.rows.map((row) => [Number(row.id), serializeProduct(row)]),
  );
  const normalizedItems = [];
  let totalAmount = 0;

  for (const entry of cart) {
    const product = productMap.get(Number(entry.product_id));
    const quantity = Number(entry.quantity);
    if (!product) throw new Error('Salah satu produk tidak tersedia');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw new Error(`Jumlah ${product.name} tidak valid`);
    }
    if (product.fulfillment_type === 'digiflazz' && quantity !== 1) {
      throw new Error(`${product.name} hanya dapat dibeli satu per transaksi`);
    }
    if (product.fulfillment_type === 'inventory' && product.stock < quantity) {
      throw new Error(`Stok ${product.name} tidak mencukupi`);
    }
    const customerData = validateCustomerData(product, entry.customer_data);
    totalAmount += product.price * quantity;
    normalizedItems.push({ product, quantity, customerData });
  }
  if (totalAmount < 1) throw new Error('Total pesanan tidak valid');

  const publicId = createPublicId('RS');
  const accessToken = crypto.randomBytes(32).toString('base64url');
  let orderId;
  const transaction = await db.transaction('write');
  try {
    const orderResult = await transaction.execute({
      sql: `INSERT INTO orders
        (public_id, customer_name, customer_phone, customer_email, total_amount, status, access_token_hash)
        VALUES (?, ?, ?, ?, ?, 'creating', ?)`,
      args: [
        publicId,
        customerName,
        customerPhone,
        customerEmail,
        totalAmount,
        accessTokenHash(accessToken),
      ],
    });
    orderId = Number(orderResult.lastInsertRowid);

    for (const entry of normalizedItems) {
      await transaction.execute({
        sql: `INSERT INTO order_items
          (order_id, product_id, product_name, unit_price, quantity, fulfillment_type,
            provider_sku, customer_data_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting_payment')`,
        args: [
          orderId,
          entry.product.id,
          entry.product.name,
          entry.product.price,
          entry.quantity,
          entry.product.fulfillment_type,
          entry.product.provider_sku,
          JSON.stringify(entry.customerData),
        ],
      });

      if (entry.product.fulfillment_type === 'inventory') {
        const available = await transaction.execute({
          sql: `SELECT id FROM inventory
            WHERE product_id = ? AND status = 'available'
            ORDER BY id LIMIT ?`,
          args: [entry.product.id, entry.quantity],
        });
        if (available.rows.length < entry.quantity) {
          throw new Error(`Inventori ${entry.product.name} tidak mencukupi`);
        }
        for (const stock of available.rows) {
          const reservation = await transaction.execute({
            sql: `UPDATE inventory SET status = 'reserved', reserved_order_id = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'available'`,
            args: [orderId, stock.id],
          });
          if (Number(reservation.rowsAffected) !== 1) {
            throw new Error(`Inventori ${entry.product.name} baru saja habis`);
          }
        }
        await transaction.execute({
          sql: `UPDATE products SET stock = (
              SELECT COUNT(*) FROM inventory WHERE product_id = ? AND status = 'available'
            ), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          args: [entry.product.id, entry.product.id],
        });
      }
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }

  try {
    const payment = await createPayment({
      amount: totalAmount,
      customerRef: publicId,
      note: `Pesanan ${publicId}`,
      redirectUrl: `${frontendUrl.replace(/\/$/, '')}/?order=${encodeURIComponent(publicId)}`,
    });
    await db.execute({
      sql: `UPDATE orders SET status = 'pending_payment', payment_trx_id = ?, payment_url = ?,
        qr_image_url = ?, payment_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [
        payment.trx_id,
        payment.payment_page_url,
        payment.qr_image_url || '',
        payment.expires_at || null,
        orderId,
      ],
    });
    const created = await getOrder(publicId);
    return { ...serializeOrder(created.row, created.items), access_token: accessToken };
  } catch (error) {
    await releaseInventory(orderId);
    await db.execute({
      sql: `UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [error.message, orderId],
    });
    throw error;
  }
}

async function releaseInventory(orderId) {
  const transaction = await db.transaction('write');
  try {
    const reserved = await transaction.execute({
      sql: `SELECT DISTINCT product_id FROM inventory
        WHERE reserved_order_id = ? AND status = 'reserved'`,
      args: [orderId],
    });
    await transaction.execute({
      sql: `UPDATE inventory SET status = 'available', reserved_order_id = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE reserved_order_id = ? AND status = 'reserved'`,
      args: [orderId],
    });
    for (const row of reserved.rows) {
      await transaction.execute({
        sql: `UPDATE products SET stock = (
            SELECT COUNT(*) FROM inventory WHERE product_id = ? AND status = 'available'
          ), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [row.product_id, row.product_id],
      });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

async function refreshOrder(publicId, accessToken) {
  const data = await getOrder(publicId);
  if (!data) return null;
  const { row } = data;
  if (accessToken !== undefined) assertOrderAccess(row, accessToken);
  if (!row.payment_trx_id || !['pending_payment', 'paid', 'processing'].includes(String(row.status))) {
    return serializeOrder(row, data.items);
  }

  if (String(row.status) === 'pending_payment') {
    const payment = await getPayment(row.payment_trx_id);
    if (payment.status === 'paid') {
      await db.execute({
        sql: `UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [row.id],
      });
      await db.execute({
        sql: `UPDATE order_items SET status = 'processing', updated_at = CURRENT_TIMESTAMP
          WHERE order_id = ? AND status = 'waiting_payment'`,
        args: [row.id],
      });
    } else if (['expired', 'failed'].includes(payment.status)) {
      await releaseInventory(row.id);
      await db.execute({
        sql: `UPDATE orders SET status = ?, failure_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [payment.status, `Pembayaran ${payment.status}`, row.id],
      });
      const latest = await getOrder(publicId);
      return serializeOrder(latest.row, latest.items);
    } else {
      return serializeOrder(row, data.items);
    }
  }

  await fulfillOrder(publicId);
  const latest = await getOrder(publicId);
  return serializeOrder(latest.row, latest.items);
}

async function fulfillOrder(publicId) {
  const data = await getOrder(publicId);
  if (!data || !['paid', 'processing'].includes(String(data.row.status))) return;
  await db.execute({
    sql: `UPDATE orders SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [data.row.id],
  });

  for (const item of data.items) {
    if (String(item.status) === 'fulfilled') continue;
    try {
      if (item.fulfillment_type === 'inventory') {
        const inventory = await db.execute({
          sql: `SELECT * FROM inventory WHERE product_id = ? AND reserved_order_id = ?
            AND status = 'reserved' ORDER BY id LIMIT ?`,
          args: [item.product_id, data.row.id, item.quantity],
        });
        if (inventory.rows.length < Number(item.quantity)) {
          throw new Error('Inventori yang direservasi tidak lengkap');
        }
        const credentials = inventory.rows.map((stock) => asJson(stock.payload_json, {}));
        for (const stock of inventory.rows) {
          await db.execute({
            sql: `UPDATE inventory SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            args: [stock.id],
          });
        }
        await markItemFulfilled(item.id, { credentials });
      } else if (item.fulfillment_type === 'digiflazz') {
        const existing = asJson(item.fulfillment_json, {});
        const metadata = await db.execute({
          sql: 'SELECT metadata_json FROM products WHERE id = ?',
          args: [item.product_id],
        });
        const customerData = asJson(item.customer_data_json, {});
        const template = asJson(metadata.rows[0]?.metadata_json, {}).customer_number_template || '{{phone}}';
        const customerNo = interpolate(template, customerData).replace(/\D/g, '');
        if (!customerNo) throw new Error('Nomor tujuan provider tidak valid');
        const providerRef = item.provider_ref || createPublicId('DF');
        if (!item.provider_ref) {
          await db.execute({
            sql: `UPDATE order_items SET provider_ref = ?, status = 'processing',
              updated_at = CURRENT_TIMESTAMP WHERE id = ? AND provider_ref IS NULL`,
            args: [providerRef, item.id],
          });
        }
        const response = await topup({
          sku: item.provider_sku,
          customerNo,
          refId: providerRef,
        });
        const status = String(response.status || '').toLowerCase();
        const fulfillment = {
          ...existing,
          provider_status: response.status,
          serial_number: response.sn || '',
          message: response.message || '',
        };
        await db.execute({
          sql: `UPDATE order_items SET provider_ref = ?, fulfillment_json = ?, status = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          args: [
            providerRef,
            JSON.stringify(fulfillment),
            status === 'sukses' ? 'fulfilled' : status === 'gagal' ? 'failed' : 'processing',
            item.id,
          ],
        });
      } else {
        throw new Error('Metode fulfillment produk belum dikonfigurasi');
      }
    } catch (error) {
      await db.execute({
        sql: `UPDATE order_items SET status = 'needs_action', failure_reason = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [error.message, item.id],
      });
    }
  }

  const latest = await getOrder(publicId);
  const allFulfilled = latest.items.every((item) => item.status === 'fulfilled');
  const anyFailed = latest.items.some((item) => ['failed', 'needs_action'].includes(String(item.status)));
  await db.execute({
    sql: `UPDATE orders SET status = ?, completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [allFulfilled ? 'completed' : anyFailed ? 'needs_action' : 'processing', allFulfilled ? 1 : 0, latest.row.id],
  });

  if (allFulfilled) await notifyOrder(publicId);
}

async function reserveInventoryForRetry(order) {
  const transaction = await db.transaction('write');
  try {
    for (const item of order.items) {
      if (String(item.fulfillment_type) !== 'inventory') continue;
      const available = await transaction.execute({
        sql: `SELECT id FROM inventory WHERE product_id = ? AND status = 'available'
          ORDER BY id LIMIT ?`,
        args: [item.product_id, item.quantity],
      });
      if (available.rows.length < Number(item.quantity)) {
        throw new Error(`Inventori ${item.product_name} tidak mencukupi`);
      }
      for (const stock of available.rows) {
        const reservation = await transaction.execute({
          sql: `UPDATE inventory SET status = 'reserved', reserved_order_id = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'available'`,
          args: [order.row.id, stock.id],
        });
        if (Number(reservation.rowsAffected) !== 1) {
          throw new Error(`Inventori ${item.product_name} baru saja habis`);
        }
      }
      await transaction.execute({
        sql: `UPDATE products SET stock = (
            SELECT COUNT(*) FROM inventory WHERE product_id = ? AND status = 'available'
          ), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [item.product_id, item.product_id],
      });
    }
    await transaction.execute({
      sql: `UPDATE order_items SET status = 'waiting_payment', failure_reason = '',
        updated_at = CURRENT_TIMESTAMP WHERE order_id = ?`,
      args: [order.row.id],
    });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

async function retryOrder(publicId) {
  const data = await getOrder(publicId);
  if (!data) return null;
  if (data.row.paid_at) {
    await db.execute({
      sql: `UPDATE orders SET status = 'processing', failure_reason = '',
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [data.row.id],
    });
    await db.execute({
      sql: `UPDATE order_items SET status = 'processing', failure_reason = '',
        updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status IN ('failed', 'needs_action')`,
      args: [data.row.id],
    });
    await fulfillOrder(publicId);
    const latest = await getOrder(publicId);
    return serializeOrder(latest.row, latest.items);
  }

  if (!['expired', 'failed'].includes(String(data.row.status))) {
    throw new Error('Pesanan belum dapat dibuatkan pembayaran baru');
  }
  await releaseInventory(data.row.id);
  await reserveInventoryForRetry(data);
  try {
    const payment = await createPayment({
      amount: Number(data.row.total_amount),
      customerRef: `${publicId}-${Date.now()}`,
      note: `Pembayaran ulang ${publicId}`,
      redirectUrl: `${frontendUrl.replace(/\/$/, '')}/?order=${encodeURIComponent(publicId)}`,
    });
    await db.execute({
      sql: `UPDATE orders SET status = 'pending_payment', payment_trx_id = ?, payment_url = ?,
        qr_image_url = ?, payment_expires_at = ?, failure_reason = '',
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [
        payment.trx_id,
        payment.payment_page_url,
        payment.qr_image_url || '',
        payment.expires_at || null,
        data.row.id,
      ],
    });
  } catch (error) {
    await releaseInventory(data.row.id);
    await db.execute({
      sql: `UPDATE orders SET status = 'failed', failure_reason = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [error.message, data.row.id],
    });
    throw error;
  }
  const latest = await getOrder(publicId);
  return serializeOrder(latest.row, latest.items);
}

async function markItemFulfilled(itemId, fulfillment) {
  await db.execute({
    sql: `UPDATE order_items SET status = 'fulfilled', fulfillment_json = ?, failure_reason = '',
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [JSON.stringify(fulfillment), itemId],
  });
}

async function notifyOrder(publicId) {
  const data = await getOrder(publicId);
  const receipt = asJson(data.row.receipt_json, {});
  if (receipt.whatsapp_sent_at) return;
  try {
    await whatsappManager.sendReceipt(data.row, data.items);
    receipt.whatsapp_sent_at = new Date().toISOString();
    receipt.whatsapp_error = '';
  } catch (error) {
    receipt.whatsapp_error = error.message;
  }
  await db.execute({
    sql: `UPDATE orders SET receipt_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [JSON.stringify(receipt), data.row.id],
  });
}

async function handleDigiflazzCallback(payload) {
  const data = payload?.data || payload;
  if (!data?.ref_id) return false;
  const result = await db.execute({
    sql: 'SELECT * FROM order_items WHERE provider_ref = ?',
    args: [data.ref_id],
  });
  const item = result.rows[0];
  if (!item) return false;
  const status = String(data.status || '').toLowerCase();
  await db.execute({
    sql: `UPDATE order_items SET status = ?, fulfillment_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [
      status === 'sukses' ? 'fulfilled' : status === 'gagal' ? 'failed' : 'processing',
      JSON.stringify({
        provider_status: data.status,
        serial_number: data.sn || '',
        message: data.message || '',
      }),
      item.id,
    ],
  });
  const order = await db.execute({ sql: 'SELECT public_id FROM orders WHERE id = ?', args: [item.order_id] });
  if (order.rows[0]) await fulfillOrder(order.rows[0].public_id);
  return true;
}

async function processOpenOrders() {
  const result = await db.execute({
    sql: `SELECT public_id FROM orders WHERE status IN ('pending_payment', 'paid', 'processing')
      ORDER BY updated_at ASC LIMIT 30`,
  });
  for (const row of result.rows) {
    await refreshOrder(row.public_id).catch((error) => {
      console.error(`Gagal memproses ${row.public_id}:`, error.message);
    });
  }

  const notifications = await db.execute({
    sql: `SELECT public_id FROM orders
      WHERE status = 'completed'
        AND receipt_json NOT LIKE '%whatsapp_sent_at%'
        AND updated_at <= datetime('now', '-1 minute')
      ORDER BY updated_at ASC LIMIT 10`,
  });
  for (const row of notifications.rows) await notifyOrder(row.public_id);
}

module.exports = {
  createOrder,
  getOrder,
  handleDigiflazzCallback,
  processOpenOrders,
  refreshOrder,
  retryOrder,
  serializeOrder,
  serializeProduct,
};
