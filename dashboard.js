require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

// Temporal token system
const dashboardTokens = new Map();
const TOKEN_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

function generateDashboardToken() {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + TOKEN_EXPIRY_MS;
    dashboardTokens.set(token, expires);
    
    // Cleanup expired tokens
    cleanupExpiredTokens();
    
    return token;
}

function isValidToken(token) {
    if (!token || !dashboardTokens.has(token)) {
        return false;
    }
    
    const expires = dashboardTokens.get(token);
    if (Date.now() > expires) {
        dashboardTokens.delete(token);
        return false;
    }
    
    return true;
}

function cleanupExpiredTokens() {
    const now = Date.now();
    for (const [token, expires] of dashboardTokens.entries()) {
        if (now > expires) {
            dashboardTokens.delete(token);
        }
    }
}

function getLocalIPAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return 'localhost';
}

// Token validation middleware
function validateToken(req, res, next) {
    const token = req.query.token;
    
    if (!isValidToken(token)) {
        return res.status(401).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Access Expired</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    h1 { color: #e74c3c; margin-bottom: 20px; }
                    p { color: #666; margin-bottom: 20px; }
                    .emoji { font-size: 48px; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="emoji">⏰</div>
                    <h1>Link Expired</h1>
                    <p>This dashboard link has expired for security.</p>
                    <p>Send <strong>/dashboard</strong> in WhatsApp to get a new link.</p>
                </div>
            </body>
            </html>
        `);
    }
    
    next();
}

// Apply token validation to dashboard routes
app.use('/dashboard', validateToken);
app.use(express.static('public'));

// API endpoint to generate dashboard token (for WhatsApp bot to call)
app.post('/api/generate-token', (req, res) => {
    const token = generateDashboardToken();
    const localIP = getLocalIPAddress();
    const port = process.env.DASHBOARD_PORT || 3000;
    const dashboardUrl = `http://${localIP}:${port}/chat-manager?token=${token}`;

    res.json({
        token,
        url: dashboardUrl,
        expires: Date.now() + TOKEN_EXPIRY_MS
    });
});

// Apply token validation to all other API routes
app.use('/api', validateToken);

// PostgreSQL connection (same as main bot)
const pool = new Pool({
    user: process.env.DB_USER || 'whatsapp_bot',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'whatsapp_bot',
    password: process.env.DB_PASSWORD || '',
    port: process.env.DB_PORT || 5432,
});

// Database methods for dashboard
async function getAllTasks() {
    const result = await pool.query(`
        SELECT 
            id, message_id, chat_name, sender_name, summary, 
            task_types, event_time, amount, link, original_text,
            created_at, status
        FROM tasks 
        WHERE is_task = true 
        ORDER BY 
            CASE WHEN status = 'completed' THEN 1 ELSE 0 END,
            created_at DESC
    `);
    return result.rows;
}

async function markTaskComplete(taskId) {
    await pool.query(
        'UPDATE tasks SET status = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['completed', taskId]
    );
}

async function deleteTask(taskId) {
    await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
}

// API Routes
app.get('/api/tasks', async (req, res) => {
    try {
        const tasks = await getAllTasks();
        res.json(tasks);
    } catch (error) {
        console.error('Error fetching tasks:', error);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

app.post('/api/tasks/:id/complete', async (req, res) => {
    try {
        await markTaskComplete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking task complete:', error);
        res.status(500).json({ error: 'Failed to mark task complete' });
    }
});

app.delete('/api/tasks/:id', async (req, res) => {
    try {
        await deleteTask(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting task:', error);
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

// Serve dashboard HTML with token validation
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Redirect root to dashboard (for backward compatibility)
app.get('/', (req, res) => {
    const token = req.query.token;
    if (token) {
        res.redirect(`/dashboard?token=${token}`);
    } else {
        res.status(401).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Task Bot</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    h1 { color: #25D366; margin-bottom: 20px; }
                    p { color: #666; margin-bottom: 20px; }
                    .emoji { font-size: 48px; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="emoji">🤖</div>
                    <h1>WhatsApp Task Bot</h1>
                    <p>To access the dashboard, send <strong>/dashboard</strong> in your Bot Commands chat.</p>
                    <p>You'll receive a secure link that works for 5 minutes.</p>
                </div>
            </body>
            </html>
        `);
    }
});

// Chat management API endpoints
app.get('/api/chats', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT chat_id, chat_name, is_monitored, is_group, participant_count, updated_at
            FROM chat_configs 
            ORDER BY is_monitored DESC, chat_name ASC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching chats:', error);
        res.status(500).json({ error: 'Failed to fetch chats' });
    }
});

app.post('/api/chats/:chatId/monitor', async (req, res) => {
    try {
        const { chatId } = req.params;
        const { monitored } = req.body;
        
        await pool.query(
            'UPDATE chat_configs SET is_monitored = $1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $2',
            [monitored, chatId]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating chat monitoring:', error);
        res.status(500).json({ error: 'Failed to update chat monitoring' });
    }
});

app.post('/api/refresh-chats', async (req, res) => {
    try {
        // This endpoint will be called by the chat manager
        // The actual chat discovery happens in the main bot
        res.json({ success: true, message: 'Chat refresh requested' });
    } catch (error) {
        console.error('Error refreshing chats:', error);
        res.status(500).json({ error: 'Failed to refresh chats' });
    }
});

// Serve chat manager page
app.get('/chat-manager', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat-manager.html'));
});

const PORT = process.env.DASHBOARD_PORT || 3000;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`📊 Dashboard running at http://localhost:${PORT}`);
    });
}

module.exports = app;
