const express = require('express');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

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

const verifiedPayments = {};

function sendToTelegram(botToken, chatId, payment) {
    const message = `✅ *Payment Successful*\n\n💰 *Amount Paid:* ₹${payment.amount}\n👤 *From:* ${payment.sender}\n🔢 *UTR / Txn ID:* \`${payment.refId}\`\n🕒 *Time:* ${payment.time}\n\n📄 [View Web Document](${payment.document_download_link})`;
    
    const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}&parse_mode=Markdown`;
    
    https.get(url).on('error', (e) => console.error("Telegram Error:", e));
}

app.get('/', (req, res) => {
    res.send("Fully Advanced FamPay API is Online!");
});

app.get('/qr', (req, res) => {
    const { upi, amount } = req.query;
    if (!upi || !amount) return res.status(400).send("Missing parameters.");

    const upiLink = `upi://pay?pa=${upi}&pn=Merchant&am=${amount}&cu=INR`;
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=15&data=${encodeURIComponent(upiLink)}`;
    
    res.redirect(qrImageUrl); 
});

app.get('/verify', async (req, res) => {
    const { amount, tg_chat_id, tg_bot_token } = req.query;
    
    const refId = req.query.utr || req.query.txn_id;

    if (!refId || !/^[a-zA-Z0-9]{8,35}$/.test(refId)) {
        return res.status(400).json({ success: false, message: "Invalid UTR or Transaction ID. Must be 8-35 alphanumeric characters." });
    }
    if (!amount) {
        return res.status(400).json({ success: false, message: "Missing amount in URL." });
    }

    const docLink = `https://${req.get('host')}/document?id=${refId}`;

    if (verifiedPayments[refId]) {
        if (tg_chat_id && tg_bot_token) sendToTelegram(tg_bot_token, tg_chat_id, verifiedPayments[refId]);
        return res.json({ success: true, message: "Payment already verified.", ...verifiedPayments[refId] });
    }

    try {
        const connection = await imaps.connect(config);
        await connection.openBox('INBOX');

        const searchCriteria = ['UNSEEN', ['TEXT', refId]]; 
        const fetchOptions = { bodies: ['HEADER', 'TEXT'], markSeen: false }; 

        const messages = await connection.search(searchCriteria, fetchOptions);
        let isFound = false;
        let paymentData = {};

        for (let item of messages) {
            const all = item.parts.find(part => part.which === 'TEXT');
            const mail = await simpleParser("Imap-Id: " + item.attributes.uid + "\r\n" + all.body);
            
            const emailBody = mail.text || mail.html || '';

            if (emailBody.includes(refId)) {
                isFound = true;
                
                let senderName = "FamPay User";
                const senderMatch = emailBody.match(/Paid from\s+([^.\r\n]+)/i);
                if (senderMatch) {
                    senderName = senderMatch[1].trim(); 
                } else if (mail.from && mail.from.text) {
                    senderName = mail.from.text;
                }

                const paymentTime = mail.date ? new Date(mail.date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

                paymentData = {
                    amount: amount, 
                    sender: senderName,
                    time: paymentTime,
                    refId: refId, 
                    utr: refId,   
                    document_download_link: docLink
                };

                await connection.addFlags(item.attributes.uid, '\\Seen');
                verifiedPayments[refId] = paymentData;
                break; 
            }
        }
        connection.end();

        if (isFound) {
            if (tg_chat_id && tg_bot_token) {
                sendToTelegram(tg_bot_token, tg_chat_id, paymentData);
            }
            return res.json({ success: true, message: "Payment Success", ...paymentData });
        } else {
            return res.json({ success: false, message: "Payment not found. Wait 60s and try again.", refId: refId });
        }

    } catch (error) {
        return res.status(500).json({ success: false, message: "Server Error", error: error.toString() });
    }
});

app.get('/document', (req, res) => {
    const refId = req.query.id || req.query.utr || req.query.txn_id;
    const payment = verifiedPayments[refId];

    if (!payment) {
        return res.status(404).send("<h2 style='text-align:center; color:red; margin-top:50px;'>Document not found. Please verify the payment first.</h2>");
    }

    const htmlDocument = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment_Receipt_${payment.refId}</title>
        <style>
            body { font-family: 'Arial', sans-serif; background-color: #eef2f3; padding: 20px; text-align: center; }
            .receipt-card { background: white; max-width: 450px; margin: 0 auto; padding: 30px; border-radius: 12px; box-shadow: 0 8px 20px rgba(0,0,0,0.1); border-top: 8px solid #00C853; }
            .success-icon { font-size: 60px; margin-bottom: 5px; }
            h1 { color: #2c3e50; font-size: 26px; margin: 10px 0; }
            .details { text-align: left; background: #f8f9fa; padding: 20px; border-radius: 8px; margin-top: 20px; }
            .details p { margin: 12px 0; font-size: 16px; border-bottom: 1px solid #eaeaea; padding-bottom: 8px; display: flex; justify-content: space-between; }
            .details p:last-child { border-bottom: none; }
            .label { color: #7f8c8d; font-weight: 600; }
            .value { color: #2c3e50; font-weight: bold; }
            .amount { font-size: 20px; color: #00C853; }
            .download-btn { display: inline-block; background: #2980b9; color: white; border: none; padding: 15px 30px; font-size: 18px; font-weight: bold; border-radius: 8px; cursor: pointer; margin-top: 30px; width: 100%; transition: 0.3s; text-decoration: none; }
            .download-btn:hover { background: #1c5980; }
            @media print { .download-btn { display: none; } body { background: white; } .receipt-card { box-shadow: none; border: 1px solid #ddd; } }
        </style>
    </head>
    <body>
        <div class="receipt-card">
            <div class="success-icon">✅</div>
            <h1>Payment Successful</h1>
            <div class="details">
                <p><span class="label">Amount Paid</span> <span class="value amount">₹${payment.amount}</span></p>
                <p><span class="label">From</span> <span class="value">${payment.sender}</span></p>
                <p><span class="label">UTR / Txn ID</span> <span class="value">${payment.refId}</span></p>
                <p><span class="label">Date & Time</span> <span class="value" style="font-size:14px;">${payment.time}</span></p>
            </div>
            <button class="download-btn" onclick="window.print()">📥 Download Document (PDF)</button>
        </div>
    </body>
    </html>
    `;
    res.send(htmlDocument);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));