const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const axios = require('axios');
const mongoose = require('mongoose');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bestwallet', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Models
const userSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    firstName: String,
    lastName: String,
    walletAddress: String,
    createdAt: { type: Date, default: Date.now },
    twoFactorEnabled: { type: Boolean, default: false },
    biometricEnabled: { type: Boolean, default: false }
});

const walletSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    currency: String,
    amount: Number,
    walletAddress: String,
    privateKey: String,
    createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fromAddress: String,
    toAddress: String,
    amount: Number,
    currency: String,
    type: { type: String, enum: ['buy', 'sell', 'send', 'receive'] },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    transactionHash: String,
    fee: Number,
    paymentMethod: String,
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// Authentication Routes
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, firstName, lastName } = req.body;

        // Check if user exists
        let user = await User.findOne({ email });
        if (user) {
            return res.status(400).json({ message: 'User already exists' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create user
        user = new User({
            email,
            password: hashedPassword,
            firstName,
            lastName,
            walletAddress: generateWalletAddress()
        });

        await user.save();

        // Create default wallets
        const cryptos = ['bitcoin', 'ethereum', 'litecoin', 'ripple', 'cardano'];
        for (const crypto of cryptos) {
            const wallet = new Wallet({
                userId: user._id,
                currency: crypto,
                amount: 0,
                walletAddress: generateWalletAddress()
            });
            await wallet.save();
        }

        // Generate JWT
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret_key', {
            expiresIn: '7d'
        });

        res.json({
            token,
            user: {
                id: user._id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check if user exists
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        // Generate JWT
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret_key', {
            expiresIn: '7d'
        });

        res.json({
            token,
            user: {
                id: user._id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// Middleware to verify token
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
        req.userId = decoded.id;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Invalid token' });
    }
};

// Wallet Routes
app.get('/api/wallet/balance', verifyToken, async (req, res) => {
    try {
        const wallets = await Wallet.find({ userId: req.userId });
        const balance = wallets.reduce((sum, w) => sum + w.amount, 0);

        res.json({
            totalBalance: balance,
            wallets: wallets
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

app.get('/api/wallet/:currency', verifyToken, async (req, res) => {
    try {
        const wallet = await Wallet.findOne({
            userId: req.userId,
            currency: req.params.currency
        });

        if (!wallet) {
            return res.status(404).json({ message: 'Wallet not found' });
        }

        res.json(wallet);
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// Transaction Routes
app.post('/api/transaction/buy', verifyToken, async (req, res) => {
    try {
        const { currency, amount, paymentMethod } = req.body;

        // Create transaction
        const transaction = new Transaction({
            userId: req.userId,
            currency,
            amount,
            type: 'buy',
            paymentMethod,
            status: 'pending'
        });

        await transaction.save();

        // Update wallet
        const wallet = await Wallet.findOne({ userId: req.userId, currency });
        if (wallet) {
            wallet.amount += amount;
            await wallet.save();
        }

        // Simulate payment processing
        setTimeout(async () => {
            transaction.status = 'completed';
            await transaction.save();
        }, 2000);

        res.json({
            message: 'Purchase initiated',
            transaction
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

app.post('/api/transaction/sell', verifyToken, async (req, res) => {
    try {
        const { currency, amount, paymentMethod } = req.body;

        // Check balance
        const wallet = await Wallet.findOne({ userId: req.userId, currency });
        if (!wallet || wallet.amount < amount) {
            return res.status(400).json({ message: 'Insufficient balance' });
        }

        // Create transaction
        const transaction = new Transaction({
            userId: req.userId,
            currency,
            amount,
            type: 'sell',
            paymentMethod,
            status: 'pending'
        });

        await transaction.save();

        // Update wallet
        wallet.amount -= amount;
        await wallet.save();

        // Simulate payment processing
        setTimeout(async () => {
            transaction.status = 'completed';
            await transaction.save();
        }, 2000);

        res.json({
            message: 'Sale initiated',
            transaction
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

app.post('/api/transaction/send', verifyToken, async (req, res) => {
    try {
        const { toAddress, currency, amount, fee } = req.body;

        // Check balance
        const wallet = await Wallet.findOne({ userId: req.userId, currency });
        if (!wallet || wallet.amount < (amount + fee)) {
            return res.status(400).json({ message: 'Insufficient balance' });
        }

        // Create transaction
        const transaction = new Transaction({
            userId: req.userId,
            fromAddress: wallet.walletAddress,
            toAddress,
            currency,
            amount,
            type: 'send',
            fee,
            status: 'pending'
        });

        await transaction.save();

        // Update wallet
        wallet.amount -= (amount + fee);
        await wallet.save();

        // Simulate blockchain processing
        setTimeout(async () => {
            transaction.status = 'completed';
            transaction.transactionHash = generateHash();
            await transaction.save();
        }, 3000);

        res.json({
            message: 'Transaction sent',
            transaction
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

app.get('/api/transaction/history', verifyToken, async (req, res) => {
    try {
        const transactions = await Transaction.find({ userId: req.userId })
            .sort({ createdAt: -1 });

        res.json(transactions);
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// WebSocket Server for Real-time Price Updates
const wss = new WebSocket.Server({ port: 8080 });

// Store connected clients
const clients = new Set();

wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    clients.add(ws);

    // Send initial data
    ws.send(JSON.stringify({
        type: 'connection',
        message: 'Connected to price feed'
    }));

    ws.on('close', () => {
        clients.delete(ws);
    });
});

// CoinGecko API Integration
async function fetchCoinGeckoData() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params: {
                vs_currency: 'usd',
                ids: 'bitcoin,ethereum,litecoin,ripple,cardano',
                order: 'market_cap_desc',
                per_page: 5,
                sparkline: true,
                price_change_percentage: '24h'
            }
        });

        // Broadcast to all connected clients
        const priceData = response.data.map(coin => ({
            id: coin.id,
            name: coin.name,
            symbol: coin.symbol.toUpperCase(),
            price: coin.current_price,
            change24h: coin.price_change_percentage_24h,
            volume: coin.total_volume,
            marketCap: coin.market_cap,
            sparkline: coin.sparkline_in_7d?.price || []
        }));

        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'priceUpdate',
                    data: priceData
                }));
            }
        });
    } catch (error) {
        console.error('Error fetching CoinGecko data:', error);
    }
}

// Binance WebSocket Integration
async function connectBinanceWebSocket() {
    const symbols = ['btcusdt', 'ethusdt', 'ltcusdt', 'xrpusdt', 'adausdt'];
    const streams = symbols.map(symbol => `${symbol}@ticker`).join('/');
    
    const binanceWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

    binanceWs.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'binanceUpdate',
                        data: message.data
                    }));
                }
            });
        } catch (error) {
            console.error('Error parsing Binance data:', error);
        }
    });

    binanceWs.on('error', (error) => {
        console.error('Binance WebSocket error:', error);
    });
}

// Fetch prices every 5 seconds
setInterval(fetchCoinGeckoData, 5000);

// Connect to Binance on startup
connectBinanceWebSocket();

// Utility Functions
function generateWalletAddress() {
    return '0x' + Array.from({ length: 40 }, () => 
        Math.floor(Math.random() * 16).toString(16)
    ).join('');
}

function generateHash() {
    return '0x' + Array.from({ length: 64 }, () => 
        Math.floor(Math.random() * 16).toString(16)
    ).join('');
}

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running' });
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💰 WebSocket server running on port 8080`);
});

module.exports = app;