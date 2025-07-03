require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs').promises;
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let MONITORED_CHATS = process.env.MONITORED_CHATS?.split(',') || ['Test Group'];
const BOT_COMMAND_CHAT = process.env.BOT_COMMAND_CHAT || 'Bot Commands';

// Store discovered chats for management
let discoveredChats = new Map();

// PostgreSQL connection
const pool = new Pool({
    user: process.env.DB_USER || 'whatsapp_bot',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'whatsapp_bot',
    password: process.env.DB_PASSWORD || '',
    port: process.env.DB_PORT || 5432,
});

// Health monitoring variables
let lastMessageTime = Date.now();
let isWhatsAppConnected = false;
let healthCheckInterval;
let connectionTimeout;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// Initialize database
async function initDatabase() {
    try {
        const schema = await fs.readFile('schema.sql', 'utf8');
        await pool.query(schema);
        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        process.exit(1);
    }
}

// Health check functions
async function checkDatabaseHealth() {
    try {
        await pool.query('SELECT 1');
        return true;
    } catch (error) {
        console.error('❌ Database health check failed:', error.message);
        return false;
    }
}

async function performHealthCheck() {
    const now = new Date();
    const uptimeMs = process.uptime() * 1000;
    const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
    const uptimeMinutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
    
    // Check database
    const dbHealthy = await checkDatabaseHealth();
    
    // Check last message time
    const timeSinceLastMessage = Date.now() - lastMessageTime;
    const minutesSinceLastMessage = Math.floor(timeSinceLastMessage / (1000 * 60));
    
    // Get memory usage
    const memUsage = process.memoryUsage();
    const memUsageMB = Math.round(memUsage.rss / 1024 / 1024);
    
    console.log(`
╔════════════════════════════════════════════════════════
║ 💚 HEALTH CHECK - ${now.toLocaleString()}
╠════════════════════════════════════════════════════════
║ ⏱️  Uptime: ${uptimeHours}h ${uptimeMinutes}m
║ 📱 WhatsApp: ${isWhatsAppConnected ? '✅ Connected' : '❌ Disconnected'}
║ 🗄️  Database: ${dbHealthy ? '✅ Healthy' : '❌ Unhealthy'}
║ 📨 Last Message: ${minutesSinceLastMessage}m ago
║ 🧠 Memory: ${memUsageMB}MB
║ 📊 Monitored Chats: ${MONITORED_CHATS.length}
╚════════════════════════════════════════════════════════`);
    
    // Alert if issues detected
    if (!isWhatsAppConnected) {
        console.log('⚠️  WARNING: WhatsApp not connected');
        console.log('💡 If this persists, try restarting the bot to get a new QR code');
    }
    
    if (!dbHealthy) {
        console.log('⚠️  WARNING: Database connection unhealthy');
    }
    
    if (memUsageMB > 500) {
        console.log(`⚠️  WARNING: High memory usage: ${memUsageMB}MB`);
    }
    
    // Check if bot might be stuck (connected but no message activity for a very long time)
    if (isWhatsAppConnected && minutesSinceLastMessage > 180) { // 3 hours
        console.log('⚠️  WARNING: No message activity for over 3 hours - bot might be stuck');
        console.log('💡 This is normal if WhatsApp is quiet, but monitor for responsiveness');
    }
}

function startHealthMonitoring() {
    // Health check every 5 minutes
    healthCheckInterval = setInterval(performHealthCheck, 5 * 60 * 1000);
    
    // Initial health check after 30 seconds
    setTimeout(performHealthCheck, 30 * 1000);
    
    console.log('🔍 Health monitoring started (5-minute intervals)');
}

function hasTaskIndicators(text) {
    const lowerText = text.toLowerCase();
    
    // Hebrew task indicators - expanded
    const hebrewIndicators = [
        // Days and time
        'מחר', 'מחרתיים', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'ראשון',
        'היום', 'אתמול', 'השבוע', 'שבוע הבא', 'החודש', 'חודש הבא',
        'ביום', 'בשעה', 'שעות', 'דקות', 'זמן', 'תאריך',
        
        // Events and meetings
        'פגישה', 'מפגש', 'ישיבה', 'אירוע', 'חגיגה', 'יום הולדת', 'חתונה', 'בר מצווה',
        'כנס', 'סדנה', 'הרצאה', 'קורס', 'שיעור', 'בדיקה', 'טיפול', 'רופא', 'דחוף',
        
        // Payments and money
        'תשלום', 'להעביר', 'לשלם', 'כסף', 'שח', '₪', 'דולר', 'חשבון', 'חשבונית',
        'הרשמה', 'דמי', 'עלות', 'מחיר', 'תשלום', 'העברה', 'צ\'ק', 'מזומן', 'אשראי',
        
        // Action words
        'צריך', 'חייב', 'מוכרח', 'רוצה', 'צריכה', 'חייבת', 'מוכרחת', 'רוצים',
        'לזכור', 'לא לשכוח', 'חשוב', 'דחוף', 'מהיר', 'בדחיפות'
    ];
    
    // English task indicators - expanded
    const englishIndicators = [
        // Days and time
        'tomorrow', 'today', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 
        'friday', 'saturday', 'sunday', 'next week', 'this week', 'next month',
        'at', 'pm', 'am', 'o\'clock', 'oclock', 'time', 'date', 'when', 'schedule',
        
        // Events and meetings
        'meeting', 'appointment', 'event', 'party', 'birthday', 'wedding', 'conference',
        'workshop', 'lecture', 'class', 'course', 'checkup', 'treatment', 'doctor', 'urgent',
        'deadline', 'due', 'reminder', 'important', 'call', 'visit',
        
        // Payments and money
        'payment', 'pay', 'transfer', 'money', '$', '₪', 'dollar', 'bill', 'invoice',
        'registration', 'fee', 'cost', 'price', 'charge', 'owe', 'debt', 'cash', 'credit',
        
        // Action words
        'need', 'must', 'should', 'have to', 'got to', 'remember', 'dont forget',
        'important', 'urgent', 'asap', 'quickly', 'soon'
    ];
    
    // Time patterns - enhanced
    const timePatterns = [
        /\d{1,2}:\d{2}/, // 10:30
        /\d{1,2}\.\d{2}/, // 10.30
        /\d{1,2} ?pm|am/i, // 3pm, 3 PM
        /\d{1,2}:\d{2} ?pm|am/i, // 3:30pm
        /בשעה \d/, // בשעה 8
        /ב-?\d{1,2}/, // ב-8, ב8
        /at \d{1,2}/i, // at 3
        /\d{1,2} ?o'?clock/i, // 3 o'clock, 3 oclock
        /\b\d{1,2}\/\d{1,2}/, // 12/25, 3/4
        /\b\d{1,2}-\d{1,2}/, // 12-25
    ];
    
    // Amount patterns - enhanced
    const amountPatterns = [
        /\d+\s*₪/, // 50₪
        /\d+\s*שח/, // 50 שח
        /\$\d+/, // $50
        /\d+\s*\$/, // 50$
        /\d+\s*dollars?/i, // 50 dollars
        /\d+\s*shekels?/i, // 50 shekels
        /\d+\s*\*\s*\d+/, // 350 * 5.5
        /\d+\s*nis/i, // 50 NIS
        /₪\s*\d+/, // ₪50
        /\b\d{2,}\b/, // Any number with 2+ digits (potential amount)
    ];
    
    // URL patterns (links often indicate tasks)
    const urlPatterns = [
        /https?:\/\//, // HTTP/HTTPS links
        /www\./i, // www. links
        /\.com|\.org|\.net|\.co\./i, // Common domains
    ];
    
    // Question patterns (often indicate requests/tasks)
    const questionPatterns = [
        /\?/, // Any question mark
        /can you/i,
        /could you/i,
        /would you/i,
        /will you/i,
        /איך/,
        /מתי/,
        /איפה/,
        /כמה/,
        /אפשר/,
    ];
    
    // Check for indicators
    const hasHebrew = hebrewIndicators.some(indicator => text.includes(indicator));
    const hasEnglish = englishIndicators.some(indicator => lowerText.includes(indicator));
    const hasTime = timePatterns.some(pattern => pattern.test(text));
    const hasAmount = amountPatterns.some(pattern => pattern.test(text));
    const hasUrl = urlPatterns.some(pattern => pattern.test(text));
    const hasQuestion = questionPatterns.some(pattern => pattern.test(text));
    
    // Lower threshold for analysis - if any indicator is found, analyze
    return hasHebrew || hasEnglish || hasTime || hasAmount || hasUrl || hasQuestion;
}

const TASK_DETECTION_PROMPT = `
You are an expert assistant that analyzes WhatsApp messages to identify actionable tasks and events. You excel at understanding context, dates, and Hebrew/English mixed content.

TASK TYPES TO DETECT:
1. **Events**: Meetings, appointments, deadlines, celebrations, medical appointments, classes, conferences
2. **Payments**: Money transfers, bills, fees, registration payments, shared expenses, debts
3. **Reminders**: Things to remember, follow up on, or complete
4. **Requests**: Direct or indirect requests for action

DETECTION CRITERIA:
- ANY mention of future dates, times, or deadlines
- Payment amounts or money-related obligations  
- Action words (need to, must, should, remember, don't forget)
- Questions that imply action needed
- Links that require action (registration, payment, etc.)
- Appointments or scheduled activities

IMPORTANT DATE PROCESSING:
Message was sent on: \${MESSAGE_DATE}
- "tomorrow"/"מחר" = day after message date
- "today"/"היום" = same day as message date  
- "next week"/"שבוע הבא" = following week
- "Monday"/"שני" = next occurrence of that day
- Hebrew dates: Convert Jewish calendar references if mentioned

RESPONSE FORMAT:
For tasks, provide this exact JSON structure:
{
  "is_task": true,
  "types": ["event"|"payment"|"reminder"|"request"],
  "summary": "Brief, clear description of what needs to be done",
  "event_time": "2025-07-03T15:30:00" (if time/date mentioned),
  "amount": "150₪" (if payment mentioned),
  "link": "https://..." (if URL present),
  "confidence": 0.85 (0.0-1.0, how certain you are this is a task)
}

For non-tasks:
{
  "is_task": false
}

EXAMPLES:
✅ TASKS:
- "Meeting tomorrow at 3pm" → event
- "Pay 50₪ for dinner" → payment  
- "Don't forget to call mom" → reminder
- "Can you check this link?" → request
- "Registration closes Friday" → event with deadline

❌ NOT TASKS:
- "How are you?" → general conversation
- "Thanks!" → acknowledgment
- "I went to the store" → past event report
- "The weather is nice" → observation

Message text: "\${MESSAGE_TEXT}"
Response:`;

const rateLimiter = {
    lastCall: 0,
    minDelay: 1000,
    async check() {
        const now = Date.now();
        const elapsed = now - this.lastCall;
        if (elapsed < this.minDelay) {
            await new Promise(r => setTimeout(r, this.minDelay - elapsed));
        }
        this.lastCall = Date.now();
    }
};

// More robust WhatsApp client configuration
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-task-bot"
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-blink-features=AutomationControlled',
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-ipc-flooding-protection',
            '--single-process'
        ],
        timeout: 60000,
        protocolTimeout: 60000
    },
    // Add retry and connection options
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    // Add session restore timeout
    authTimeoutMs: 60000
});

// Connection management functions
function clearConnectionTimeout() {
    if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
    }
}

function startConnectionTimeout() {
    clearConnectionTimeout();
    connectionTimeout = setTimeout(() => {
        if (!isWhatsAppConnected) {
            console.log('⏰ Connection timeout - forcing restart...');
            restartConnection();
        }
    }, 180000); // 180 seconds (3 minutes) timeout
}

async function restartConnection() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('❌ Max reconnection attempts reached. Please restart manually.');
        return;
    }
    
    reconnectAttempts++;
    console.log(`🔄 Attempting reconnection ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
    
    try {
        // Clear any existing timeouts
        clearConnectionTimeout();
        
        // Set connection state to false during restart
        isWhatsAppConnected = false;
        
        // Gracefully destroy client with better error handling
        try {
            console.log('🛑 Destroying WhatsApp client...');
            
            // Wait for any pending operations to complete
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Destroy client with timeout to prevent hanging
            await Promise.race([
                client.destroy(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Client destroy timeout')), 10000))
            ]);
            
            console.log('✅ Client destroyed successfully');
        } catch (destroyError) {
            console.log('📝 Client cleanup completed (some errors expected during destroy)');
        }
        
        // Kill any remaining Chromium processes from this instance
        try {
            const { execSync } = require('child_process');
            execSync('pkill -f "whatsapp-task-bot.*chrome" 2>/dev/null || true', { stdio: 'ignore' });
            console.log('🧹 Cleaned up browser processes');
        } catch (cleanupError) {
            console.log('📝 Browser cleanup completed');
        }
        
        // Clear session if multiple failures or on first connection error
        if (reconnectAttempts >= 1) {
            const fs = require('fs');
            if (fs.existsSync('./.wwebjs_auth')) {
                console.log('🗑️  Clearing potentially corrupted session...');
                try {
                    fs.rmSync('./.wwebjs_auth', { recursive: true, force: true });
                    console.log('✅ Session directory cleared');
                } catch (fsError) {
                    console.log('📝 Session cleanup completed');
                }
            }
        }
        
        // Wait longer before reinitializing to ensure cleanup is complete
        setTimeout(() => {
            console.log('🚀 Reinitializing WhatsApp client...');
            startConnectionTimeout(); // Restart timeout for new attempt
            try {
                client.initialize();
            } catch (initError) {
                console.error('❌ Failed to reinitialize:', initError.message);
                setTimeout(() => restartConnection(), 15000); // Wait longer on failure
            }
        }, 8000); // Increased delay to ensure cleanup
    } catch (error) {
        console.error('❌ Error during restart:', error.message);
        setTimeout(() => restartConnection(), 15000); // Wait longer on error
    }
}

client.on('qr', qr => {
    clearConnectionTimeout();
    console.log('📱 Scan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
    console.log('🔗 Or scan this QR code with your WhatsApp mobile app');
    console.log('⏳ Waiting for QR code scan...');
    isWhatsAppConnected = false;
    
    // Start timeout for QR scan
    startConnectionTimeout();
});

client.on('loading_screen', (percent, message) => {
    console.log(`📡 Loading WhatsApp: ${percent}% - ${message}`);
});

client.on('authenticated', (session) => {
    clearConnectionTimeout();
    console.log('🔐 WhatsApp authenticated successfully');
    console.log('📱 Session saved, connecting to WhatsApp...');
    console.log('💾 Session will be restored on next startup');
    isWhatsAppConnected = false; // Still connecting
    
    // Start timeout for ready event with longer timeout for session restore
    connectionTimeout = setTimeout(() => {
        if (!isWhatsAppConnected) {
            console.log('⏰ Session restore timeout - forcing restart...');
            restartConnection();
        }
    }, 240000); // 4 minutes for session restore
});

client.on('auth_failure', (msg) => {
    clearConnectionTimeout();
    console.error('❌ WhatsApp authentication failed:', msg);
    console.log('💡 Attempting restart with fresh session...');
    isWhatsAppConnected = false;
    
    // Force restart on auth failure
    setTimeout(() => restartConnection(), 2000);
});

client.on('ready', async () => {
    clearConnectionTimeout();
    reconnectAttempts = 0; // Reset on successful connection
    
    console.log('✅ WhatsApp connected successfully!');
    console.log('📊 Monitored chats (task detection):', MONITORED_CHATS);
    console.log('🤖 Command chat:', BOT_COMMAND_CHAT);
    isWhatsAppConnected = true;
    lastMessageTime = Date.now();
    
    // Check if this was a restored session
    const fs = require('fs');
    if (fs.existsSync('./.wwebjs_auth')) {
        console.log('🔄 Session restored from saved authentication');
    } else {
        console.log('🆕 New session created and saved');
    }
    
    // Get basic info about the connected account with retry logic
    try {
        // Wait a bit for the connection to stabilize
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const info = client.info;
        console.log(`👤 Connected as: ${info.pushname} (${info.me.user})`);
        
        // Test getting chats with timeout protection
        console.log('🔍 Testing chat access...');
        const chats = await Promise.race([
            client.getChats(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Chat access timeout')), 30000))
        ]);
        console.log(`📱 Found ${chats.length} chats accessible`);
        
        // Discover chats after a longer delay to ensure stability
        console.log('⏳ Starting chat discovery in 10 seconds...');
        setTimeout(async () => {
            try {
                console.log('🔍 Beginning chat discovery...');
                await Promise.race([
                    discoverChats(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Chat discovery timeout')), 45000))
                ]);
                await refreshMonitoredChats();
                console.log('✅ Chat discovery completed successfully');
            } catch (error) {
                console.error('❌ Error during initial chat discovery:', error.message);
                console.log('🔄 Chat discovery will be retried on next restart');
            }
        }, 10000);
        
    } catch (error) {
        console.error('❌ Error getting account info:', error.message);
        console.log('🔄 Will retry operations after connection stabilizes');
    }
});

client.on('disconnected', reason => {
    clearConnectionTimeout();
    console.log('❌ WhatsApp disconnected:', reason);
    isWhatsAppConnected = false;
    
    // Attempt to reconnect automatically
    console.log('🔄 Attempting automatic reconnection...');
    setTimeout(() => restartConnection(), 3000);
});

// Add more debugging events
client.on('change_state', state => {
    console.log('🔄 WhatsApp state changed:', state);
});

client.on('change_battery', (batteryInfo) => {
    console.log('🔋 Phone battery:', `${batteryInfo.battery}% (${batteryInfo.plugged ? 'charging' : 'not charging'})`);
});

async function detectTask(message) {
    try {
        await rateLimiter.check();

        // Format message date for context
        const messageDate = new Date(message.timestamp * 1000).toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        const prompt = TASK_DETECTION_PROMPT
            .replace('${MESSAGE_TEXT}', message.body)
            .replace(/\${MESSAGE_DATE}/g, messageDate);

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0.3
        });

        return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
        console.error('❌ LLM Error:', error.message);
        return { is_task: false, error: true };
    }
}

// Database methods
async function isMessageProcessed(messageId) {
    const result = await pool.query(
        'SELECT message_id FROM processed_messages WHERE message_id = $1',
        [messageId]
    );
    return result.rows.length > 0;
}

async function markMessageProcessed(messageId, chatId, hadTaskIndicators, wasAnalyzed) {
    await pool.query(
        `INSERT INTO processed_messages (message_id, chat_id, had_task_indicators, was_analyzed) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, chatId, hadTaskIndicators, wasAnalyzed]
    );
}

async function saveTask(task, message, chatName, senderName) {
    await pool.query(
        `INSERT INTO tasks (
            message_id, chat_id, chat_name, sender_name, original_text,
            is_task, task_types, summary, event_time, amount, link, confidence
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (message_id) DO NOTHING`,
        [
            message.id._serialized,
            message.from,
            chatName,
            senderName,
            message.body,
            task.is_task,
            task.types || [],
            task.summary,
            task.event_time ? new Date(task.event_time) : null,
            task.amount,
            task.link,
            task.confidence || null
        ]
    );
}

// Query methods for retrieving data
async function getAllTasks(limit = 50) {
    const result = await pool.query(
        'SELECT * FROM tasks WHERE is_task = true ORDER BY created_at DESC LIMIT $1',
        [limit]
    );
    return result.rows;
}

async function getTasksByChat(chatId, limit = 50) {
    const result = await pool.query(
        'SELECT * FROM tasks WHERE chat_id = $1 AND is_task = true ORDER BY created_at DESC LIMIT $2',
        [chatId, limit]
    );
    return result.rows;
}

async function getTasksByType(taskType, limit = 50) {
    const result = await pool.query(
        'SELECT * FROM tasks WHERE $1 = ANY(task_types) ORDER BY created_at DESC LIMIT $2',
        [taskType, limit]
    );
    return result.rows;
}

async function getProcessingStats() {
    const result = await pool.query(`
        SELECT 
            COUNT(*) as total_messages,
            COUNT(*) FILTER (WHERE had_task_indicators = true) as messages_with_indicators,
            COUNT(*) FILTER (WHERE was_analyzed = true) as messages_analyzed,
            COUNT(t.id) as tasks_found
        FROM processed_messages pm
        LEFT JOIN tasks t ON pm.message_id = t.message_id AND t.is_task = true
    `);
    return result.rows[0];
}

// Chat discovery and management functions
async function discoverChats() {
    try {
        console.log('🔍 Discovering WhatsApp chats...');
        const chats = await client.getChats();
        
        for (const chat of chats) {
            const chatInfo = {
                id: chat.id._serialized,
                name: chat.name || 'Unknown',
                isGroup: chat.isGroup,
                participantCount: chat.isGroup ? (chat.participants ? chat.participants.length : 0) : 1
            };
            
            discoveredChats.set(chat.id._serialized, chatInfo);
            
            // Save to database
            await saveChatConfig(chatInfo);
        }
        
        console.log(`✅ Discovered ${chats.length} chats`);
        return chats.length;
    } catch (error) {
        console.error('❌ Error discovering chats:', error);
        return 0;
    }
}

async function saveChatConfig(chatInfo) {
    // Check if currently monitored based on .env config
    const isCurrentlyMonitored = MONITORED_CHATS.some(name => 
        chatInfo.name.includes(name) || chatInfo.name === name
    );
    
    await pool.query(`
        INSERT INTO chat_configs (chat_id, chat_name, is_monitored, is_group, participant_count)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (chat_id) 
        DO UPDATE SET 
            chat_name = EXCLUDED.chat_name,
            is_group = EXCLUDED.is_group,
            participant_count = EXCLUDED.participant_count,
            updated_at = CURRENT_TIMESTAMP
    `, [chatInfo.id, chatInfo.name, isCurrentlyMonitored, chatInfo.isGroup, chatInfo.participantCount]);
}

async function getMonitoredChats() {
    const result = await pool.query(
        'SELECT chat_id, chat_name FROM chat_configs WHERE is_monitored = true ORDER BY chat_name'
    );
    return result.rows;
}

async function getAllChats() {
    const result = await pool.query(
        'SELECT * FROM chat_configs ORDER BY is_monitored DESC, chat_name ASC'
    );
    return result.rows;
}

async function getRecentActiveChats() {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await pool.query(`
        SELECT DISTINCT cc.*, pm.last_activity 
        FROM chat_configs cc
        LEFT JOIN (
            SELECT chat_id, MAX(processed_at) as last_activity
            FROM processed_messages 
            WHERE processed_at > $1
            GROUP BY chat_id
        ) pm ON cc.chat_id = pm.chat_id
        WHERE pm.last_activity IS NOT NULL OR cc.is_monitored = true
        ORDER BY cc.is_monitored DESC, pm.last_activity DESC, cc.chat_name ASC
    `, [weekAgo]);
    return result.rows;
}

async function updateChatMonitoring(chatId, isMonitored) {
    await pool.query(
        'UPDATE chat_configs SET is_monitored = $1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $2',
        [isMonitored, chatId]
    );
    
    // Update in-memory MONITORED_CHATS array
    await refreshMonitoredChats();
}

async function refreshMonitoredChats() {
    const monitoredChats = await getMonitoredChats();
    MONITORED_CHATS = monitoredChats.map(chat => chat.chat_name);
    console.log('🔄 Updated monitored chats:', MONITORED_CHATS);
}

// WhatsApp command functions
function isCommand(text) {
    return text.startsWith('/');
}

async function getTasksForUser(userId, status = null, limit = 10) {
    // Get tasks from all monitored chats, not just specific chat
    let query = `
        SELECT id, summary, task_types, event_time, amount, link, 
               created_at, status, chat_name, chat_id
        FROM tasks 
        WHERE is_task = true
    `;
    const params = [];
    
    if (status) {
        query += ` AND status = $${params.length + 1}`;
        params.push(status);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await pool.query(query, params);
    return result.rows;
}

function formatTasksForWhatsApp(tasks, title = "🎯 Your Tasks") {
    if (tasks.length === 0) {
        return `${title}\n\nNo tasks found! 🎉`;
    }
    
    let message = `${title}\n`;
    message += `Total: ${tasks.length}\n\n`;
    
    tasks.forEach((task, index) => {
        const num = index + 1;
        const status = task.status === 'completed' ? '✅' : '⏳';
        const types = task.task_types && task.task_types.length > 0 
            ? task.task_types.map(t => t === 'event' ? '📅' : '💰').join('')
            : '📝';
        
        message += `${num}. ${status} ${types} `;
        
        if (task.summary) {
            message += `${task.summary}\n`;
        } else {
            message += `Task from ${task.chat_name}\n`;
        }
        
        // Add chat source and details
        const details = [];
        details.push(`💬 ${task.chat_name}`);
        
        if (task.event_time) {
            const eventDate = new Date(task.event_time);
            details.push(`📅 ${eventDate.toLocaleDateString()} ${eventDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`);
        }
        if (task.amount) {
            details.push(`💰 ${task.amount}`);
        }
        if (task.link) {
            details.push(`🔗 Link available`);
        }
        
        message += `   ${details.join(' • ')}\n`;
        message += `   _${formatRelativeTime(task.created_at)}_\n\n`;
    });
    
    message += `💡 Commands: /tasks /pending /completed /help`;
    return message;
}

function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    
    if (diffDays > 0) {
        return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else if (diffHours > 0) {
        return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffMinutes > 0) {
        return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
    } else {
        return 'Just now';
    }
}

async function handleCommand(command, msg) {
    const userId = msg.from;
    const chat = await msg.getChat();
    const chatName = chat.name || 'Direct Message';
    
    try {
        switch (command.toLowerCase()) {
            case '/tasks':
            case '/mytasks':
                const allTasks = await getTasksForUser(userId);
                return formatTasksForWhatsApp(allTasks, "🎯 All Your Tasks");
                
            case '/pending':
                const pendingTasks = await getTasksForUser(userId, 'pending');
                return formatTasksForWhatsApp(pendingTasks, "⏳ Pending Tasks");
                
            case '/completed':
                const completedTasks = await getTasksForUser(userId, 'completed');
                return formatTasksForWhatsApp(completedTasks, "✅ Completed Tasks");
                
            case '/dashboard':
                try {
                    // Generate dashboard token via API call to dashboard server
                    const dashboardPort = process.env.DASHBOARD_PORT || 3000;
                    const response = await fetch(`http://localhost:${dashboardPort}/api/generate-token`, {
                        method: 'POST'
                    });
                    const data = await response.json();
                    
                    const expiresIn = Math.floor((data.expires - Date.now()) / 1000 / 60);
                    
                    return `📱 Mobile Dashboard Link:\n\n` +
                           `${data.url}\n\n` +
                           `⏰ Expires in ${expiresIn} minutes\n` +
                           `🔒 Secure temporary access\n\n` +
                           `💡 Tap the link to open on your phone!\n` +
                           `(Works on same WiFi network)`;
                } catch (error) {
                    console.error('Dashboard link generation error:', error);
                    return `❌ Sorry, couldn't generate dashboard link.\nMake sure the dashboard server is running.`;
                }
                
            case '/chats':
                const recentChats = await getRecentActiveChats();
                if (recentChats.length === 0) {
                    return `📱 No recent active chats found.\nSend /refresh to discover chats or /allchats for complete list.`;
                }
                
                // Separate groups and individuals
                const groups = recentChats.filter(chat => chat.is_group);
                const individuals = recentChats.filter(chat => !chat.is_group);
                
                let chatList = `📱 Recent Active Chats (Last 7 Days):\n\n`;
                let index = 1;
                
                if (groups.length > 0) {
                    chatList += `👥 **Groups** (${groups.length}):\n`;
                    groups.forEach(chat => {
                        const status = chat.is_monitored ? '✅' : '⚫';
                        const participants = ` (${chat.participant_count} members)`;
                        const lastActivity = chat.last_activity 
                            ? new Date(chat.last_activity).toLocaleDateString()
                            : 'monitored';
                        chatList += `${index}. ${status} ${chat.chat_name}${participants} - ${lastActivity}\n`;
                        index++;
                    });
                    chatList += '\n';
                }
                
                if (individuals.length > 0) {
                    chatList += `👤 **Individual Chats** (${individuals.length}):\n`;
                    individuals.forEach(chat => {
                        const status = chat.is_monitored ? '✅' : '⚫';
                        const lastActivity = chat.last_activity 
                            ? new Date(chat.last_activity).toLocaleDateString()
                            : 'monitored';
                        chatList += `${index}. ${status} ${chat.chat_name} - ${lastActivity}\n`;
                        index++;
                    });
                    chatList += '\n';
                }
                
                chatList += `💡 Commands:\n`;
                chatList += `/monitor <number> - Start monitoring chat\n`;
                chatList += `/unmonitor <number> - Stop monitoring chat\n`;
                chatList += `/allchats - Show all discovered chats\n`;
                chatList += `/refresh - Refresh chat list`;
                
                return chatList;
                
            case '/allchats':
                const allChats = await getAllChats();
                if (allChats.length === 0) {
                    return `📱 No chats discovered yet.\nSend /refresh to discover chats.`;
                }
                
                // Separate groups and individuals for all chats
                const allGroups = allChats.filter(chat => chat.is_group);
                const allIndividuals = allChats.filter(chat => !chat.is_group);
                
                let allChatsList = `📱 All Discovered Chats:\n\n`;
                let allIndex = 1;
                
                if (allGroups.length > 0) {
                    allChatsList += `👥 **Groups** (${allGroups.length}):\n`;
                    allGroups.forEach(chat => {
                        const status = chat.is_monitored ? '✅' : '⚫';
                        const participants = ` (${chat.participant_count} members)`;
                        allChatsList += `${allIndex}. ${status} ${chat.chat_name}${participants}\n`;
                        allIndex++;
                    });
                    allChatsList += '\n';
                }
                
                if (allIndividuals.length > 0) {
                    allChatsList += `👤 **Individual Chats** (${allIndividuals.length}):\n`;
                    allIndividuals.forEach(chat => {
                        const status = chat.is_monitored ? '✅' : '⚫';
                        allChatsList += `${allIndex}. ${status} ${chat.chat_name}\n`;
                        allIndex++;
                    });
                    allChatsList += '\n';
                }
                
                allChatsList += `💡 Use /chats for recent active chats only.\n`;
                allChatsList += `Commands: /monitor <number>, /unmonitor <number>`;
                
                return allChatsList;
                
            case '/monitored':
                const monitoredChats = await getMonitoredChats();
                if (monitoredChats.length === 0) {
                    return `📊 No chats currently monitored.\n\nUse /chats to see available chats.`;
                }
                
                let monitoredList = `📊 Currently Monitored Chats:\n\n`;
                monitoredChats.forEach((chat, index) => {
                    monitoredList += `${index + 1}. ✅ ${chat.chat_name}\n`;
                });
                
                return monitoredList;
                
            case '/refresh':
                const discoveredCount = await discoverChats();
                await refreshMonitoredChats();
                return `🔄 Chat discovery complete!\n\n` +
                       `📱 Found: ${discoveredCount} chats\n` +
                       `✅ Monitored: ${MONITORED_CHATS.length} chats\n\n` +
                       `Use /chats to see all available chats.`;
                
            case '/stats':
                const globalStats = await pool.query(`
                    SELECT 
                        COUNT(*) as total_tasks,
                        COUNT(*) FILTER (WHERE status = 'pending') as pending_tasks,
                        COUNT(*) FILTER (WHERE status = 'completed') as completed_tasks,
                        COUNT(DISTINCT chat_name) as total_chats
                    FROM tasks 
                    WHERE is_task = true
                `);
                const stats = globalStats.rows[0];
                return `📊 Global Task Stats\n\n` +
                       `📝 Total Tasks: ${stats.total_tasks}\n` +
                       `⏳ Pending: ${stats.pending_tasks}\n` +
                       `✅ Completed: ${stats.completed_tasks}\n` +
                       `💬 From Chats: ${stats.total_chats}\n\n` +
                       `🤖 Monitored Chats: ${MONITORED_CHATS.join(', ')}\n` +
                       `📱 Command Chat: ${BOT_COMMAND_CHAT}`;
                
            case '/help':
                return `🤖 WhatsApp Task Bot Commands\n\n` +
                       `📋 Task Commands:\n` +
                       `/tasks - Show all your tasks from all chats\n` +
                       `/pending - Show pending tasks\n` +
                       `/completed - Show completed tasks\n` +
                       `/stats - Show global task statistics\n\n` +
                       `📱 Dashboard & Chat Management:\n` +
                       `/dashboard - Get mobile dashboard link\n` +
                       `/chats - Show recent active chats (last 7 days)\n` +
                       `/allchats - Show all discovered chats\n` +
                       `/monitored - Show monitored chats\n` +
                       `/monitor <number> - Start monitoring chat\n` +
                       `/unmonitor <number> - Stop monitoring chat\n` +
                       `/refresh - Refresh chat list\n\n` +
                       `🏗️ Setup:\n` +
                       `• Task Detection: ${MONITORED_CHATS.join(', ')}\n` +
                       `• Commands: ${BOT_COMMAND_CHAT} (this chat)\n\n` +
                       `ℹ️ The bot detects tasks from monitored chats.\n` +
                       `Use this dedicated chat for commands to avoid spam.`;
                
            default:
                // Handle numbered commands like /monitor 3, /unmonitor 2
                const parts = command.split(' ');
                const baseCommand = parts[0].toLowerCase();
                const chatNumber = parseInt(parts[1]);
                
                if ((baseCommand === '/monitor' || baseCommand === '/unmonitor') && !isNaN(chatNumber)) {
                    // Try recent chats first, then all chats
                    let chatList = await getRecentActiveChats();
                    let listType = 'recent';
                    
                    if (chatList.length === 0 || chatNumber > chatList.length) {
                        chatList = await getAllChats();
                        listType = 'all';
                    }
                    
                    if (chatNumber < 1 || chatNumber > chatList.length) {
                        return `❌ Invalid chat number. Use /chats for recent chats or /allchats for all chats (1-${chatList.length}).`;
                    }
                    
                    // Create combined list (groups first, then individuals) to match display order
                    const groups = chatList.filter(chat => chat.is_group);
                    const individuals = chatList.filter(chat => !chat.is_group);
                    const combinedList = [...groups, ...individuals];
                    
                    const selectedChat = combinedList[chatNumber - 1];
                    const newStatus = baseCommand === '/monitor';
                    
                    if (selectedChat.is_monitored === newStatus) {
                        const status = newStatus ? 'already monitored' : 'not monitored';
                        return `ℹ️ "${selectedChat.chat_name}" is ${status}.`;
                    }
                    
                    await updateChatMonitoring(selectedChat.chat_id, newStatus);
                    
                    const action = newStatus ? 'Now monitoring' : 'Stopped monitoring';
                    return `✅ ${action} "${selectedChat.chat_name}"\n\n` +
                           `📊 Currently monitoring ${MONITORED_CHATS.length} chats.`;
                }
                
                return `❓ Unknown command: ${command}\n\nType /help for available commands.`;
        }
    } catch (error) {
        console.error('Command error:', error);
        return `❌ Sorry, there was an error processing your command. Please try again.`;
    }
}

client.on('message', async msg => {
    try {
        // Update last message time for health monitoring
        lastMessageTime = Date.now();
        
        if (!msg.body || msg.body.trim().length < 1) return;

        const chat = await msg.getChat();
        const chatName = chat.name || msg.from;

        // Check if this is the dedicated command chat
        const isCommandChat = chatName.includes(BOT_COMMAND_CHAT);
        const isMonitoredChat = MONITORED_CHATS.some(name => chatName.includes(name));

        // Handle commands only in the dedicated command chat
        if (isCommandChat && isCommand(msg.body.trim())) {
            console.log(`🤖 Command received: "${msg.body}" from ${chatName}`);
            try {
                const response = await Promise.race([
                    handleCommand(msg.body.trim(), msg),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Command timeout')), 30000))
                ]);
                await msg.reply(response);
                console.log(`✅ Command completed successfully`);
            } catch (error) {
                console.error('❌ Command error:', error.message);
                try {
                    await msg.reply('❌ Sorry, there was an error processing your command.');
                } catch (replyError) {
                    console.error('❌ Failed to send error message:', replyError.message);
                }
            }
            return;
        }

        // If someone tries to use commands in non-command chats, ignore silently
        if (!isCommandChat && isCommand(msg.body.trim())) {
            return;
        }

        // Only process task detection in monitored chats (not in command chat)
        if (!isMonitoredChat || isCommandChat) return;

        // Skip very short messages for task detection
        if (msg.body.trim().length < 3) return;

        // Check if message already processed in database
        const messageId = msg.id._serialized;
        if (await isMessageProcessed(messageId)) return;

        const hasIndicators = hasTaskIndicators(msg.body);
        
        // Mark message as processed regardless of outcome
        await markMessageProcessed(messageId, msg.from, hasIndicators, false);

        // Preprocessing filter to reduce LLM calls
        if (!hasIndicators) {
            return;
        }

        console.log(`🔍 Analyzing potential task: "${msg.body.substring(0, 50)}..." from ${chatName}`);
        
        // Update that this message was analyzed
        await markMessageProcessed(messageId, msg.from, true, true);
        
        // Add timeout to task detection to prevent hanging
        try {
            const result = await Promise.race([
                detectTask(msg),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Task detection timeout')), 15000))
            ]);

            if (result.is_task) {
                const contact = await msg.getContact();
                console.log(`🎯 TASK DETECTED: ${result.summary} from ${chatName}`);
                await saveTask(result, msg, chatName, contact.pushname || 'Unknown');
            }
        } catch (error) {
            console.error(`❌ Task detection failed for message from ${chatName}:`, error.message);
        }
    } catch (error) {
        console.error('❌ Message processing error:', error);
        console.error('Stack trace:', error.stack);
        
        // Don't crash the bot, just log the error
        console.log('🔄 Continuing to process other messages...');
    }
});

// Add error handling for unhandled protocol errors
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    
    // Check if this is a protocol error that might indicate session corruption
    if (reason && reason.message && reason.message.includes('Protocol error')) {
        console.log('🔄 Protocol error detected, attempting restart...');
        setTimeout(() => restartConnection(), 3000);
    }
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    
    // Check if this is a protocol error that might indicate session corruption
    if (error.message && error.message.includes('Protocol error')) {
        console.log('🔄 Protocol error detected, attempting restart...');
        setTimeout(() => restartConnection(), 3000);
    }
});

// Add graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
    }
    if (client) {
        try {
            await client.destroy();
        } catch (destroyError) {
            console.log('📝 Client destruction completed with expected errors');
        }
    }
    try {
        await pool.end();
        console.log('✅ Database pool closed');
    } catch (err) {
        console.error('❌ Error closing database pool:', err.message);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
    }
    if (client) {
        client.destroy();
    }
    try {
        await pool.end();
        console.log('✅ Database pool closed');
    } catch (err) {
        console.error('❌ Error closing database pool:', err.message);
    }
    process.exit(0);
});

async function startBot() {
    console.log('🚀 Starting WhatsApp Task Listener...');
    await initDatabase();
    startHealthMonitoring();
    
    // Check if session exists
    const fs = require('fs');
    if (fs.existsSync('./.wwebjs_auth')) {
        console.log('🔄 Found existing session, attempting to restore...');
    } else {
        console.log('🆕 No existing session found, will show QR code...');
    }
    
    // Start connection with timeout
    console.log('⏱️  Connection timeout set to 180 seconds (3 minutes)...');
    startConnectionTimeout();
    
    try {
        client.initialize();
    } catch (error) {
        console.error('❌ Failed to initialize WhatsApp client:', error.message);
        console.log('🔄 Will attempt restart in 3 seconds...');
        setTimeout(() => restartConnection(), 3000);
    }
}

startBot().catch((error) => {
    console.error('❌ Fatal startup error:', error);
    process.exit(1);
});