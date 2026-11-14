require('dotenv').config();
const express = require('express');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. MongoDB Connection (Aapka purana Mongo URI yahan use hoga)
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected Successfully"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// MongoDB Schema
const PaymentSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true, index: true },
    amount: Number,
    sender: String,
    time: String,
    document_download_link: String
});
const Payment = mongoose.model('Payment', PaymentSchema);

// 2. IMAP Gmail Config
const config = {
    imap: {
        user: process.env.EMAIL_USER,
        password: process.env.EMAIL_PASSWORD,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 15000
    }
};

// 3. Telegram Notification (Fast via Axios)
async function sendToTelegram(botToken, chatId, payment) {
    const message = `✅ *Payment Verified (ADV)*\n\n💰 *Amount:* ₹${payment.amount}\n👤 *From:* ${payment.sender}\n🔢 *UTR:* \`${payment.refId}\`\n🕒 *Time:* ${payment.time}\n\n📄 [View Receipt](${payment.document_download_link})`;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    try {
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
    } catch (error) {
        console.error("❌ Telegram Notification Error:", error.response ? error.response.data : error.message);
    }
}

app.get('/', (req, res) => res.send("🚀 FamPay ADV API is Online!"));

// 4. QR Code Generator Route
app.get('/qr', (req, res) => {
    const { upi, amount } = req.query;
    if (!upi || !amount) return res.status(400).json({ error: "Missing UPI ID or Amount." });

    const upiLink = `upi://pay?pa=${upi}&pn=Merchant&am=${amount}&cu=INR`;
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=15&data=${encodeURIComponent(upiLink)}`;
    
    res.redirect(qrImageUrl); 
});

// 5. Verify Route (With Strict Amount Checking)
app.get('/verify', async (req, res) => {
    const { amount, tg_chat_id, tg_bot_token } = req.query;
    const refId = req.query.utr || req.query.txn_id;

    if (!refId || !/^[a-zA-Z0-9]{8,35}$/.test(refId)) {
        return res.status(400).json({ success: false, message: "Invalid UTR / Txn ID." });
    }
    if (!amount) {
        return res.status(400).json({ success: false, message: "Missing amount." });
    }

    const expectedAmount = parseFloat(amount);
    const docLink = `https://${req.get('host')}/document?id=${refId}`;

    // Step A: Check Database First (Speed Optimization)
    try {
        const existingPayment = await Payment.findOne({ refId });
        if (existingPayment) {
            return res.json({ success: true, message: "Payment already verified (Fetched from DB).", data: existingPayment });
        }
    } catch (dbErr) {
        console.error("DB Check Error:", dbErr);
    }

    // Step B: Check Gmail
    let connection;
    try {
        connection = await imaps.connect(config);
        await connection.openBox('INBOX');

        const searchCriteria = ['UNSEEN', ['TEXT', refId]]; 
        const fetchOptions = { bodies: ['HEADER', 'TEXT'], markSeen: false }; 

        const messages = await connection.search(searchCriteria, fetchOptions);
        let paymentData = null;
        let amountMismatchError = null;

        for (let item of messages) {
            const all = item.parts.find(part => part.which === 'TEXT');
            const mail = await simpleParser("Imap-Id: " + item.attributes.uid + "\r\n" + all.body);
            const emailBody = mail.text || mail.html || '';

            if (emailBody.includes(refId)) {
                
                // Extract real amount from email
                let receivedAmount = 0;
                const amountMatch = emailBody.match(/(?:₹|Rs\.?|INR)\s*([0-9,]+(?:\.[0-9]+)?)/i);
                
                if (amountMatch) {
                    receivedAmount = parseFloat(amountMatch[1].replace(/,/g, ''));
                }

                // SECURITY CHECK: Check if received amount is less than expected amount
                if (receivedAmount < expectedAmount) {
                    amountMismatchError = {
                        success: false,
                        message: `Payment Failed! Amount mismatch. Aapko ₹${expectedAmount} pay karna tha, par aapne sirf ₹${receivedAmount} bheja hai.`,
                        refId: refId,
                        received: receivedAmount,
                        expected: expectedAmount
                    };
                    await connection.addFlags(item.attributes.uid, '\\Seen');
                    break; 
                }

                // Extract Sender Name
                let senderName = "FamPay User";
                const senderMatch = emailBody.match(/Paid from\s+([^\n\r]+)/i) || emailBody.match(/received\s+₹[0-9.]+\s+from\s+([^\n\r]+)/i);
                if (senderMatch) {
                    senderName = senderMatch[1].trim(); 
                } else if (mail.from && mail.from.text) {
                    senderName = mail.from.text;
                }

                paymentData = {
                    refId: refId, 
                    amount: receivedAmount, 
                    sender: senderName,
                    time: mail.date ? new Date(mail.date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                    document_download_link: docLink
                };

                await connection.addFlags(item.attributes.uid, '\\Seen');
                break; 
            }
        }
        connection.end();

        // Throw error if scammer paid less money
        if (amountMismatchError) {
            return res.json(amountMismatchError);
        }

        // Step C: Save to DB & Send Telegram Alert
        if (paymentData) {
            const newPayment = new Payment(paymentData);
            await newPayment.save(); 

            if (tg_chat_id && tg_bot_token) {
                sendToTelegram(tg_bot_token, tg_chat_id, paymentData);
            }
            return res.json({ success: true, message: "Payment Success & Saved to DB", data: paymentData });
        } else {
            return res.json({ success: false, message: "Payment not found in emails yet. Wait 60s and try again.", refId: refId });
        }

    } catch (error) {
        if (connection) connection.end();
        return res.status(500).json({ success: false, message: "IMAP Server Error", error: error.message });
    }
});

// 6. Receipt Document Route
app.get('/document', async (req, res) => {
    const refId = req.query.id || req.query.utr;
    if (!refId) return res.status(400).send("Missing ID");

    try {
        const payment = await Payment.findOne({ refId });

        if (!payment) {
            return res.status(404).send("<h2 style='text-align:center; color:red; margin-top:50px;'>Document not found. Please verify the payment first.</h2>");
        }

        const htmlDocument = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Receipt_${payment.refId}</title>
            <style>
                body { font-family: 'Arial', sans-serif; background-color: #f4f7f6; padding: 20px; text-align: center; }
                .receipt-card { background: white; max-width: 450px; margin: 0 auto; padding: 30px; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.1); border-top: 8px solid #00C853; }
                .success-icon { font-size: 60px; margin-bottom: 10px; }
                h1 { color: #2c3e50; font-size: 24px; margin: 0 0 20px 0; }
                .details { text-align: left; background: #f8f9fa; padding: 15px; border-radius: 8px; }
                .details p { margin: 10px 0; font-size: 15px; display: flex; justify-content: space-between; border-bottom: 1px dashed #ccc; padding-bottom: 8px; }
                .details p:last-child { border-bottom: none; }
                .label { color: #7f8c8d; font-weight: 600; }
                .value { color: #2c3e50; font-weight: bold; text-align: right; }
                .amount { font-size: 18px; color: #00C853; }
                .download-btn { display: block; background: #2980b9; color: white; border: none; padding: 15px; font-size: 16px; font-weight: bold; border-radius: 8px; cursor: pointer; margin-top: 25px; width: 100%; transition: 0.3s; }
                .download-btn:hover { background: #1c5980; }
                .watermark { margin-top: 15px; font-size: 12px; color: #aaa; }
                @media print { .download-btn { display: none; } body { background: white; } .receipt-card { box-shadow: none; border: 1px solid #ddd; } }
            </style>
        </head>
        <body>
            <div class="receipt-card">
                <div class="success-icon">✅</div>
                <h1>Payment Verified</h1>
                <div class="details">
                    <p><span class="label">Amount Paid</span> <span class="value amount">₹${payment.amount}</span></p>
                    <p><span class="label">Sender</span> <span class="value">${payment.sender}</span></p>
                    <p><span class="label">Transaction ID</span> <span class="value">${payment.refId}</span></p>
                    <p><span class="label">Date & Time</span> <span class="value" style="font-size:13px;">${payment.time}</span></p>
                </div>
                <button class="download-btn" onclick="window.print()">📥 Download PDF</button>
                <div class="watermark">Secured by MongoDB & Auto-Verification</div>
            </div>
        </body>
        </html>
        `;
        res.send(htmlDocument);
    } catch (err) {
        res.status(500).send("Database Error");
    }
});

app.listen(PORT, () => console.log(`🚀 ADV Server running on port ${PORT}`));
