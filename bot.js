// Combined bot.js

require('dotenv').config();
const { createLogger, format, transports } = require('winston');
const Bottleneck = require('bottleneck');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const { Telegraf } = require('telegraf');

// Configuration
const config = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    SOLSCAN_API_KEY: process.env.SOLSCAN_API_KEY || '',
    SOLSCAN_API_URL: 'https://api.solscan.io',
    COINGECKO_API_URL: 'https://api.coingecko.com/api/v3',
};

// Logger setup
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'bot.log' }),
    ],
});

// Rate limiter
const limiter = new Bottleneck({
    minTime: 300,
    maxConcurrent: 5,
});

// Utilities
function formatTransactions(transactions) {
    if (!transactions || transactions.length === 0) return 'No recent transactions.';
    return transactions.map((tx, index) => `${index + 1}. TxID: ${tx.txId}`).join('\n');
}

// Solana API setup
const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');

async function getAccountInfo(address) {
    try {
        const publicKey = new PublicKey(address);
        const accountInfo = await connection.getAccountInfo(publicKey);
        if (!accountInfo) throw new Error('Account not found');
        return {
            owner: accountInfo.owner.toBase58(),
            lamports: accountInfo.lamports,
        };
    } catch (error) {
        logger.error(`Error fetching account info for ${address}: ${error.message}`);
        throw new Error('Failed to fetch account info.');
    }
}

async function getTokenTransactions(address) {
    try {
        const publicKey = new PublicKey(address);
        const transactions = await connection.getConfirmedSignaturesForAddress2(publicKey, { limit: 10 });
        return transactions.map(tx => ({
            txId: tx.signature,
            type: tx.err ? 'failed' : 'confirmed',
        }));
    } catch (error) {
        logger.error(`Error fetching transactions for ${address}: ${error.message}`);
        throw new Error('Failed to fetch transactions.');
    }
}

// Token info retrieval
async function getTokenInfo(symbol) {
    try {
        const response = await axios.get(`${config.COINGECKO_API_URL}/coins/markets`, {
            params: {
                vs_currency: 'usd',
                ids: symbol.toLowerCase(),
            },
        });
        if (response.data.length === 0) throw new Error('Token not found.');
        const token = response.data[0];
        return {
            name: token.name,
            symbol: token.symbol,
            price: `$${token.current_price}`,
            marketCap: `$${token.market_cap.toLocaleString()}`,
        };
    } catch (error) {
        logger.error(`Error fetching token info: ${error.message}`);
        throw new Error('Failed to retrieve token info.');
    }
}

// Token analysis
async function analyzeToken(address, tokenSymbol) {
    try {
        const [accountInfo, transactions, tokenDetails] = await Promise.all([
            getAccountInfo(address),
            getTokenTransactions(address),
            getTokenInfo(tokenSymbol),
        ]);
        const isHoneypot = checkHoneypotLogic(accountInfo, transactions);
        const ownership = checkOwnership(accountInfo);

        return {
            honeypot: isHoneypot ? '⚠️ High Risk' : '✅ No Honeypot Detected',
            ownership,
            tokenDetails,
            transactions: transactions.slice(0, 5),
        };
    } catch (error) {
        logger.error(`Error analyzing token: ${error.message}`);
        throw new Error('Analysis failed. Check the token address and symbol.');
    }
}

function checkHoneypotLogic(accountInfo, transactions) {
    if (!accountInfo || transactions.length === 0) return true;
    if (transactions.every(tx => tx.type === 'receive')) return true;
    return false;
}

function checkOwnership(accountInfo) {
    if (!accountInfo) return '❓ Unknown';
    return accountInfo.owner === '11111111111111111111111111111111'
        ? '🚨 Centralized Ownership'
        : `✅ Owner: ${accountInfo.owner}`;
}

// Bot setup
const bot = new Telegraf(config.BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply(`
        🚀 Welcome to the Honeypot Checker Bot!
        Analyze Solana tokens for risks before investing.

        Use /check <TOKEN_ADDRESS> <TOKEN_SYMBOL> to analyze a token.
        Example: /check <TOKEN_ADDRESS> solana
    `);
    logger.info('Bot started by user: ' + ctx.from.id);
});

bot.command('check', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
        return ctx.reply('❌ Usage: /check <TOKEN_ADDRESS> <TOKEN_SYMBOL>');
    }
    const [address, symbol] = args;
    try {
        ctx.reply('🔍 Analyzing the token. Please wait...');
        const analysis = await limiter.schedule(() => analyzeToken(address, symbol));
        ctx.reply(`
            🧾 **Token Analysis:**
            - **Honeypot Risk**: ${analysis.honeypot}
            - **Ownership**: ${analysis.ownership}
            - **Token Details**: 
                Name: ${analysis.tokenDetails.name}
                Symbol: ${analysis.tokenDetails.symbol}
                Price: ${analysis.tokenDetails.price}
                Market Cap: ${analysis.tokenDetails.marketCap}
            - **Recent Transactions**: ${formatTransactions(analysis.transactions)}
        `);
        logger.info(`Analysis completed for token: ${symbol}, address: ${address}`);
    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
        logger.error(`Error during analysis for token: ${symbol}, address: ${address}`);
    }
});

bot.launch()
    .then(() => logger.info('Bot launched successfully.'))
    .catch((err) => logger.error('Bot failed to launch: ' + err.message));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
