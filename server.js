// server.js
// Backend for custom Razorpay (INR) + PayPal (USD) checkout
// Run: npm install && npm start

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const PAYPAL_BASE =
  process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN; // e.g. yourstore.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = '2024-10';

// ---------------------------------------------------------------------------
// 0. CURRENCY CONVERSION HELPER
// ---------------------------------------------------------------------------
// Converts the store's base-currency cart total (in paise) into the target
// currency's smallest unit (e.g. USD cents), so what the customer is charged
// via Razorpay matches what they saw displayed on the storefront.
//
// IMPORTANT: Replace this with whatever exchange rate source matches your
// storefront's display conversion (e.g. the same rate Shopify Markets /
// your currency-display app uses), so the displayed price and the charged
// price never mismatch. A live-rate API (exchangerate-api.com, etc.) or a
// manually-updated fixed rate are both options — just keep them in sync.
app.get('/api/convert-amount', async (req, res) => {
  try {
    const { from, to, amountPaise } = req.query;

    if (from === to) {
      return res.json({ amountInSmallestUnit: parseInt(amountPaise, 10) });
    }

    // Example using a live rate API (sign up for a free key):
    // const rateRes = await fetch(`https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_RATE_API_KEY}/pair/${from}/${to}`);
    // const rateData = await rateRes.json();
    // const rate = rateData.conversion_rate;

    // Placeholder fixed rate — REPLACE with live rate or your Markets rate:
    const FIXED_INR_TO_USD = 0.012; // example only, update regularly

    const amountInINR = parseInt(amountPaise, 10) / 100;
    const amountInUSD = amountInINR * FIXED_INR_TO_USD;
    const amountInCents = Math.round(amountInUSD * 100);

    res.json({ amountInSmallestUnit: amountInCents, rateUsed: FIXED_INR_TO_USD });
  } catch (err) {
    console.error('Currency conversion error:', err);
    res.status(500).json({ error: 'Conversion failed' });
  }
});

// ---------------------------------------------------------------------------
// 1. RAZORPAY — Create Order (DYNAMIC currency: INR or USD)
// ---------------------------------------------------------------------------
// Razorpay supports creating orders directly in USD (and ~100 other currencies)
// via its International Payments feature. The customer sees and pays in that
// currency; Razorpay converts to INR when settling to your bank account.
const SUPPORTED_CURRENCIES = ['INR', 'USD'];

app.post('/api/razorpay/create-order', async (req, res) => {
  try {
    const { amount, currency, cart } = req.body;
    // amount must be in the smallest subunit: paise for INR, cents for USD

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return res.status(400).json({ error: `Unsupported currency: ${currency}` });
    }

    const order = await razorpay.orders.create({
      amount,
      currency, // "INR" or "USD" — dynamic, based on what the customer selected
      receipt: `rcpt_${Date.now()}`,
      notes: { cart_summary: JSON.stringify(cart).slice(0, 500) },
    });

    res.json({ orderId: order.id, keyId: process.env.RAZORPAY_KEY_ID, currency });
  } catch (err) {
    console.error('Razorpay create-order error:', err);
    res.status(500).json({ error: 'Failed to create Razorpay order' });
  }
});

// ---------------------------------------------------------------------------
// 2. RAZORPAY — Verify Payment Signature (MANDATORY security step)
// ---------------------------------------------------------------------------
app.post('/api/razorpay/verify', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      cart,
      customer,
      currency, // "INR" or "USD" — whatever the order was created in
    } = req.body;

    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // Signature valid -> create the order in Shopify, in the SAME currency
    // the customer actually paid in
    const shopifyOrder = await createShopifyOrder({
      cart,
      customer,
      currency: currency || 'INR',
      gateway: 'Razorpay',
      transactionId: razorpay_payment_id,
    });

    res.json({ success: true, shopifyOrder });
  } catch (err) {
    console.error('Razorpay verify error:', err);
    res.status(500).json({ error: 'Verification/order creation failed' });
  }
});

// ---------------------------------------------------------------------------
// NOTE: PayPal is not used in this version — Razorpay's International
// Payments feature now handles both INR and USD directly. If you want to
// add PayPal as an additional option later, the PayPal integration pattern
// (create-order + capture, mirroring the Razorpay flow above) can be added
// back here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. SHOPIFY — Create Order (after Razorpay payment verified)
// ---------------------------------------------------------------------------
async function createShopifyOrder({ cart, customer, currency, gateway, transactionId }) {
  const lineItems = cart.items.map((item) => ({
    variant_id: item.variantId,
    quantity: item.quantity,
  }));

  const totalAmount = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);

  const body = {
    order: {
      line_items: lineItems,
      email: customer.email,
      currency,
      financial_status: 'paid',
      transactions: [
        {
          kind: 'sale',
          status: 'success',
          amount: totalAmount.toFixed(2),
          gateway,
          authorization: transactionId,
        },
      ],
      note: `Paid via custom checkout (${gateway}) — Txn: ${transactionId}`,
      tags: 'custom-checkout',
    },
  };

  const resp = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Shopify order creation failed: ${errText}`);
  }

  const data = await resp.json();
  return data.order;
}

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
