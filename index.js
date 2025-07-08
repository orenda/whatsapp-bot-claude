require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs').promises;
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const readline = require('readline');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let MONITORED_CHATS = process.env.MONITORED_CHATS?.split(',') || ['Test Group'];
const BOT_COMMAND_CHAT = process.env.BOT_COMMAND_CHAT || 'Bot Commands';
const MAX_MESSAGE_HISTORY_DAYS = parseInt(process.env.MAX_MESSAGE_HISTORY_DAYS) || 3;
const MESSAGE_FETCH_LIMIT = parseInt(process.env.MESSAGE_FETCH_LIMIT) || 50;

// Session management configuration
const SESSION_CLEAR_THRESHOLD = parseInt(process.env.SESSION_CLEAR_THRESHOLD) || 3; // Clear session after 3 failed attempts
const AUTO_CLEAR_SESSION = process.env.AUTO_CLEAR_SESSION !== 'false'; // Allow disabling auto-clear
const SESSION_RETRY_DELAY = parseInt(process.env.SESSION_RETRY_DELAY) || 3000; // Delay between retries

// Startup behavior configuration
const ALWAYS_VERIFY_CHATS = process.env.ALWAYS_VERIFY_CHATS !== 'false'; // Always ask to verify chats on startup
const AUTO_PROCESS_STARTUP_MESSAGES = process.env.AUTO_PROCESS_STARTUP_MESSAGES !== 'false'; // Process unread messages on startup
const STARTUP_SCAN_TIMEOUT = parseInt(process.env.STARTUP_SCAN_TIMEOUT) || 60000; // Timeout for startup message scanning
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

// Session management variables
let sessionClearAttempts = 0;
let lastSuccessfulConnection = null;

// Session validation and management functions
function isSessionHealthy() {
    const fs = require('fs');
    const path = require('path');
    
    try {
        const sessionPath = './.wwebjs_auth';
        
        // Check if session directory exists
        if (!fs.existsSync(sessionPath)) {
            console.log('📝 No session directory found');
            return false;
        }
        
        // Check if session has essential files
        const sessionFiles = fs.readdirSync(sessionPath);
        if (sessionFiles.length === 0) {
            console.log('📝 Session directory is empty');
            return false;
        }
        
        // Check session age (consider stale if older than 30 days)
        const sessionStats = fs.statSync(sessionPath);
        const sessionAge = Date.now() - sessionStats.mtime.getTime();
        const maxSessionAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        
        if (sessionAge > maxSessionAge) {
            console.log(`📝 Session is ${Math.floor(sessionAge / (24 * 60 * 60 * 1000))} days old (stale)`);
            return false;
        }
        
        console.log(`📝 Session appears healthy (${Math.floor(sessionAge / (24 * 60 * 60 * 1000))} days old)`);
        return true;
        
    } catch (error) {
        console.log(`📝 Session health check failed: ${error.message}`);
        return false;
    }
}

function shouldClearSession() {
    if (!AUTO_CLEAR_SESSION) {
        console.log('📝 Auto session clearing is disabled');
        return false;
    }
    
    if (sessionClearAttempts >= SESSION_CLEAR_THRESHOLD) {
        console.log(`📝 Session clear threshold reached (${sessionClearAttempts}/${SESSION_CLEAR_THRESHOLD})`);
        return true;
    }
    
    // Check if we've had recent successful connections
    if (lastSuccessfulConnection) {
        const timeSinceSuccess = Date.now() - lastSuccessfulConnection;
        const maxTimeWithoutSuccess = 24 * 60 * 60 * 1000; // 24 hours
        
        if (timeSinceSuccess > maxTimeWithoutSuccess) {
            console.log('📝 No successful connection in 24 hours, session may be corrupted');
            return true;
        }
    }
    
    return false;
}

async function clearSessionSafely() {
    const fs = require('fs');
    
    try {
        if (fs.existsSync('./.wwebjs_auth')) {
            console.log('🗑️  Clearing session after validation...');
            
            // Create backup before clearing (optional safety measure)
            const backupPath = `./.wwebjs_auth_backup_${Date.now()}`;
            try {
                fs.cpSync('./.wwebjs_auth', backupPath, { recursive: true });
                console.log(`💾 Session backed up to ${backupPath}`);
            } catch (backupError) {
                console.log('📝 Could not create session backup');
            }
            
            // Clear the session
            fs.rmSync('./.wwebjs_auth', { recursive: true, force: true });
            console.log('✅ Session directory cleared');
            
            // Reset session-related counters
            sessionClearAttempts = 0;
            reconnectAttempts = 0;
            
        } else {
            console.log('📝 No session to clear');
        }
    } catch (error) {
        console.log(`📝 Session cleanup completed with warnings: ${error.message}`);
    }
}

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
        
        // Increment session clear attempts (but don't immediately clear)
        sessionClearAttempts++;
        
        // Only clear session after proper validation and threshold
        if (shouldClearSession()) {
            const sessionHealthy = isSessionHealthy();
            
            if (!sessionHealthy) {
                console.log('🔍 Session validation failed, clearing...');
                await clearSessionSafely();
            } else {
                console.log('🔍 Session appears healthy, keeping it and trying different approach...');
                
                // Try alternative recovery methods without clearing session
                console.log('💡 Attempting session recovery without clearing...');
                
                // Reset some counters to give session another chance
                if (sessionClearAttempts > 1) {
                    sessionClearAttempts = Math.max(1, sessionClearAttempts - 1);
                    console.log(`📝 Reduced session clear attempts to ${sessionClearAttempts}`);
                }
            }
        } else {
            console.log(`📝 Keeping session (attempt ${sessionClearAttempts}/${SESSION_CLEAR_THRESHOLD})`);
        }
        
        // Wait before reinitializing to ensure cleanup is complete
        const retryDelay = Math.min(SESSION_RETRY_DELAY * sessionClearAttempts, 15000); // Progressive delay, max 15s
        setTimeout(() => {
            console.log('🚀 Reinitializing WhatsApp client...');
            startConnectionTimeout(); // Restart timeout for new attempt
            try {
                client.initialize();
            } catch (initError) {
                console.error('❌ Failed to reinitialize:', initError.message);
                setTimeout(() => restartConnection(), retryDelay * 2); // Wait longer on failure
            }
        }, retryDelay);
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
    sessionClearAttempts = 0; // Reset session clear attempts on success
    lastSuccessfulConnection = Date.now(); // Track successful connection time
    
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
        try {
            const chats = await Promise.race([
                client.getChats(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Chat access timeout')), 60000))
            ]);
            console.log(`📱 Found ${chats.length} chats accessible`);
        } catch (error) {
            console.error('❌ Chat access failed:', error.message);
            console.log('⚠️  Proceeding with initialization anyway...');
        }
        
        // Always run initialization after a delay, regardless of chat access
        console.log('⏳ Starting initialization in 10 seconds...');
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
                console.error('❌ Error during chat discovery:', error.message);
                console.log('⚠️  Proceeding with initialization anyway...');
            }
            
            // ALWAYS run initialization, even if chat discovery fails
            console.log('🔄 DEBUG: About to call checkAndRunInitialization()');
            await checkAndRunInitialization();
        }, 10000);
        
    } catch (error) {
        console.error('❌ Error getting account info:', error.message);
        console.log('⚠️  Running initialization fallback...');
        
        // Fallback: run initialization even if everything else fails
        setTimeout(async () => {
            console.log('🔄 DEBUG: Fallback initialization triggered');
            await checkAndRunInitialization();
        }, 15000);
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
    
    // If this is "All Tasks", separate by status for better clarity
    if (title.includes("All Your Tasks")) {
        const pendingTasks = tasks.filter(t => t.status !== 'completed');
        const completedTasks = tasks.filter(t => t.status === 'completed');
        
        let message = `${title}\n`;
        message += `Total: ${tasks.length} (${pendingTasks.length} pending, ${completedTasks.length} completed)\n\n`;
        
        if (pendingTasks.length > 0) {
            message += `⏳ **PENDING TASKS** (${pendingTasks.length}):\n`;
            pendingTasks.forEach((task, index) => {
                message += formatSingleTask(task, index + 1, false);
            });
            message += '\n';
        }
        
        if (completedTasks.length > 0) {
            message += `✅ **COMPLETED TASKS** (${completedTasks.length}):\n`;
            completedTasks.forEach((task, index) => {
                message += formatSingleTask(task, index + 1, true);
            });
        }
        
        message += `💡 Commands: /tasks /pending /completed /help`;
        return message;
    }
    
    // For specific status lists (pending/completed only), use simple format
    let message = `${title}\n`;
    message += `Total: ${tasks.length}\n\n`;
    
    tasks.forEach((task, index) => {
        message += formatSingleTask(task, index + 1, task.status === 'completed');
    });
    
    message += `💡 Commands: /tasks /pending /completed /help`;
    return message;
}

function formatSingleTask(task, num, isCompleted) {
    const status = isCompleted ? '✅' : '⏳';
    const types = task.task_types && task.task_types.length > 0 
        ? task.task_types.map(t => t === 'event' ? '📅' : '💰').join('')
        : '📝';
    
    let taskText = `${num}. ${status} ${types} `;
    
    if (task.summary) {
        taskText += isCompleted ? `~${task.summary}~` : task.summary;
    } else {
        const taskName = `Task from ${task.chat_name}`;
        taskText += isCompleted ? `~${taskName}~` : taskName;
    }
    taskText += '\n';
    
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
    
    taskText += `   ${details.join(' • ')}\n`;
    taskText += `   _${formatRelativeTime(task.created_at)}_\n\n`;
    
    return taskText;
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
                
            case '/read_unread':
                try {
                    const parts = command.split(' ');
                    let maxDays = MAX_MESSAGE_HISTORY_DAYS;
                    
                    if (parts.length > 1) {
                        const userDays = parseInt(parts[1]);
                        if (!isNaN(userDays) && userDays > 0) {
                            maxDays = userDays;
                        }
                    }
                    
                    const unreadMessages = await getUnreadMessages(maxDays);
                    return formatUnreadMessages(unreadMessages);
                } catch (error) {
                    console.error('Error reading unread messages:', error);
                    return `❌ Error reading unread messages: ${error.message}`;
                }
                
            case '/mark_read':
                try {
                    await updateLastReadTimestamp();
                    return `✅ All messages marked as read!\n📅 Last read timestamp updated to now.`;
                } catch (error) {
                    console.error('Error marking messages as read:', error);
                    return `❌ Error marking messages as read: ${error.message}`;
                }
                
            case '/status':
                try {
                    const sessionResult = await pool.query('SELECT * FROM bot_sessions LIMIT 1');
                    const configResult = await pool.query('SELECT * FROM chat_selection_config LIMIT 1');
                    
                    if (sessionResult.rows.length === 0) {
                        return `❌ No bot session found. Please restart the bot.`;
                    }
                    
                    const session = sessionResult.rows[0];
                    const config = configResult.rows[0];
                    
                    const loginTime = new Date(session.login_timestamp);
                    const lastReadTime = new Date(session.last_read_timestamp);
                    const now = new Date();
                    
                    const uptimeMs = now - loginTime;
                    const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
                    const uptimeMinutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
                    
                    const timeSinceLastRead = now - lastReadTime;
                    const hoursSinceLastRead = Math.floor(timeSinceLastRead / (1000 * 60 * 60));
                    const minutesSinceLastRead = Math.floor((timeSinceLastRead % (1000 * 60 * 60)) / (1000 * 60));
                    
                    return `🤖 BOT STATUS\n` +
                           `════════════════════════════════\n` +
                           `⏰ Bot Login: ${loginTime.toLocaleString()}\n` +
                           `📈 Uptime: ${uptimeHours}h ${uptimeMinutes}m\n` +
                           `📖 Last Read: ${lastReadTime.toLocaleString()}\n` +
                           `⏱️  Since Last Read: ${hoursSinceLastRead}h ${minutesSinceLastRead}m\n` +
                           `🔧 Max History Days: ${MAX_MESSAGE_HISTORY_DAYS}\n\n` +
                           `📊 Chat Configuration:\n` +
                           `• Initialized: ${config ? (config.is_initialized ? '✅ Yes' : '❌ No') : '❌ No'}\n` +
                           `• Total Chats: ${config ? config.total_chats_discovered : 0}\n` +
                           `• Monitored: ${config ? config.monitored_chats_count : 0}\n` +
                           `• Last Init: ${config?.last_init_at ? new Date(config.last_init_at).toLocaleString() : 'Never'}`;
                } catch (error) {
                    console.error('Error getting bot status:', error);
                    return `❌ Error getting bot status: ${error.message}`;
                }
                
            case '/clear_session':
                try {
                    const isHealthy = isSessionHealthy();
                    await clearSessionSafely();
                    return `✅ Session cleared manually!\n` +
                           `📊 Session was ${isHealthy ? 'healthy' : 'unhealthy'} before clearing.\n` +
                           `🔄 Bot will need to restart and show QR code.`;
                } catch (error) {
                    console.error('Error clearing session:', error);
                    return `❌ Error clearing session: ${error.message}`;
                }
                
            case '/help':
                return `🤖 WhatsApp Task Bot Commands\n\n` +
                       `📋 Task Commands:\n` +
                       `/tasks - Show all your tasks from all chats\n` +
                       `/pending - Show pending tasks\n` +
                       `/completed - Show completed tasks\n` +
                       `/stats - Show global task statistics\n\n` +
                       `📨 Message History:\n` +
                       `/read_unread [days] - Show unread messages since last read\n` +
                       `/mark_read - Mark all messages as read\n` +
                       `/status - Show bot status and uptime\n` +
                       `/clear_session - Manually clear WhatsApp session (forces QR scan)\n\n` +
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
                       `• Commands: ${BOT_COMMAND_CHAT} (this chat)\n` +
                       `• Max History: ${MAX_MESSAGE_HISTORY_DAYS} days\n` +
                       `• Session Clear Threshold: ${SESSION_CLEAR_THRESHOLD} attempts\n` +
                       `• Auto Clear: ${AUTO_CLEAR_SESSION ? 'Enabled' : 'Disabled'}\n\n` +
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
                    
                    if (chatList.length === 0 || chatNumber > chatList.length) {
                        chatList = await getAllChats();
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
        console.log(`🔄 DEBUG: Message from chat: "${chatName}" | BOT_COMMAND_CHAT: "${BOT_COMMAND_CHAT}"`);

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
        setTimeout(() => restartConnection(), SESSION_RETRY_DELAY);
    }
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    
    // Check if this is a protocol error that might indicate session corruption
    if (error.message && error.message.includes('Protocol error')) {
        console.log('🔄 Protocol error detected, attempting restart...');
        setTimeout(() => restartConnection(), SESSION_RETRY_DELAY);
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

// Database functions for bot sessions and configuration
async function initBotSession() {
    try {
        // Check if bot session exists
        const sessionResult = await pool.query('SELECT * FROM bot_sessions LIMIT 1');
        
        if (sessionResult.rows.length === 0) {
            // Create initial session
            await pool.query(`
                INSERT INTO bot_sessions (login_timestamp, last_read_timestamp)
                VALUES (NOW(), NOW())
            `);
            console.log('✅ Bot session initialized');
        } else {
            // Update login timestamp
            await pool.query(`
                UPDATE bot_sessions 
                SET login_timestamp = NOW(), updated_at = NOW()
                WHERE id = $1
            `, [sessionResult.rows[0].id]);
            console.log('✅ Bot session updated');
        }
    } catch (error) {
        console.error('❌ Error initializing bot session:', error.message);
        throw error;
    }
}

async function getChatSelectionConfig() {
    try {
        const result = await pool.query('SELECT * FROM chat_selection_config LIMIT 1');
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Error getting chat selection config:', error.message);
        return null;
    }
}

async function saveChatSelectionConfig(config) {
    try {
        const existingConfig = await getChatSelectionConfig();
        
        if (existingConfig) {
            await pool.query(`
                UPDATE chat_selection_config 
                SET is_initialized = $1, 
                    total_chats_discovered = $2, 
                    monitored_chats_count = $3,
                    last_init_at = NOW(),
                    updated_at = NOW()
                WHERE id = $4
            `, [config.is_initialized, config.total_chats_discovered, config.monitored_chats_count, existingConfig.id]);
        } else {
            await pool.query(`
                INSERT INTO chat_selection_config (is_initialized, total_chats_discovered, monitored_chats_count, last_init_at)
                VALUES ($1, $2, $3, NOW())
            `, [config.is_initialized, config.total_chats_discovered, config.monitored_chats_count]);
        }
        
        console.log('✅ Chat selection config saved');
    } catch (error) {
        console.error('❌ Error saving chat selection config:', error.message);
        throw error;
    }
}

function createReadlineInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

async function promptChatSelection(chats) {
    const rl = createReadlineInterface();
    
    console.log('\n🔧 CHAT SELECTION SETUP');
    console.log('════════════════════════');
    console.log('Available chats:');
    
    chats.forEach((chat, index) => {
        const type = chat.isGroup ? '👥 Group' : '👤 Individual';
        const participants = chat.isGroup ? ` (${chat.participantCount} members)` : '';
        console.log(`${index + 1}. ${type}: ${chat.name}${participants}`);
    });
    
    console.log('\n📋 Options:');
    console.log('• Enter numbers separated by commas (e.g., 1,3,5) to select specific chats');
    console.log('• Enter "all" to monitor all chats');
    console.log('• Enter "skip" to keep current settings');
    console.log('• Enter "groups" to monitor only group chats');
    
    return new Promise((resolve) => {
        rl.question('\n👉 Your choice: ', (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

async function processChatSelection(selection, chats) {
    let selectedChats = [];
    
    if (selection === 'skip') {
        console.log('⏭️  Keeping current chat settings');
        return { skip: true };
    } else if (selection === 'all') {
        selectedChats = chats;
    } else if (selection === 'groups') {
        selectedChats = chats.filter(chat => chat.isGroup);
    } else {
        // Parse comma-separated numbers
        const numbers = selection.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n > 0 && n <= chats.length);
        selectedChats = numbers.map(n => chats[n - 1]);
    }
    
    if (selectedChats.length === 0) {
        console.log('❌ No valid chats selected, keeping current settings');
        return { skip: true };
    }
    
    // Update chat configurations in database
    try {
        // First, set all chats to not monitored
        await pool.query('UPDATE chat_configs SET is_monitored = false');
        
        // Then enable monitoring for selected chats
        for (const chat of selectedChats) {
            await pool.query(`
                UPDATE chat_configs 
                SET is_monitored = true, updated_at = NOW()
                WHERE chat_id = $1
            `, [chat.id]);
        }
        
        console.log(`✅ Updated monitoring for ${selectedChats.length} chats:`);
        selectedChats.forEach(chat => {
            const type = chat.isGroup ? '👥' : '👤';
            console.log(`   ${type} ${chat.name}`);
        });
        
        return { 
            skip: false, 
            selected: selectedChats,
            count: selectedChats.length
        };
    } catch (error) {
        console.error('❌ Error updating chat configurations:', error.message);
        return { skip: true };
    }
}

async function runChatSelectionInit() {
    console.log('\n🔍 Discovering available chats...');
    
    let chatList = [];
    
    try {
        // Wait for WhatsApp to be ready and discover chats with timeout
        console.log('🔄 DEBUG: Attempting to get chats...');
        const chats = await Promise.race([
            client.getChats(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Chat discovery timeout')), 30000))
        ]);
        console.log('🔄 DEBUG: Successfully got chats');
        chatList = chats.map(chat => ({
            id: chat.id._serialized,
            name: chat.name || 'Unknown',
            isGroup: chat.isGroup,
            participantCount: chat.isGroup ? (chat.participants ? chat.participants.length : 0) : 1
        }));
        
        console.log(`📊 Found ${chatList.length} chats`);
        
        // Save all discovered chats to database
        for (const chat of chatList) {
            await saveChatConfig(chat);
        }
    } catch (error) {
        console.error('❌ Chat discovery failed:', error.message);
        console.log('⚠️  Using fallback: manual chat configuration');
        
        // Fallback: use current environment variable settings
        chatList = MONITORED_CHATS.map((name, index) => ({
            id: `fallback_${index}`,
            name: name,
            isGroup: true,
            participantCount: 0
        }));
        console.log(`📊 Using ${chatList.length} chats from environment: ${MONITORED_CHATS.join(', ')}`);
    }
    
    // Prompt user for selection
    const selection = await promptChatSelection(chatList);
    const result = await processChatSelection(selection, chatList);
    
    // Save configuration
    await saveChatSelectionConfig({
        is_initialized: true,
        total_chats_discovered: chatList.length,
        monitored_chats_count: result.skip ? 0 : result.count
    });
    
    return result;
}

async function runChatSelectionReview() {
    console.log('\n🔍 Discovering available chats...');
    
    // Get current chats and monitored status
    const chats = await client.getChats();
    const chatList = chats.map(chat => ({
        id: chat.id._serialized,
        name: chat.name || 'Unknown',
        isGroup: chat.isGroup,
        participantCount: chat.isGroup ? (chat.participants ? chat.participants.length : 0) : 1
    }));
    
    // Get current monitoring status from database
    const monitoredChats = await getMonitoredChats();
    const monitoredIds = new Set(monitoredChats.map(chat => chat.chat_id));
    
    console.log(`📊 Found ${chatList.length} total chats\n`);
    
    // Show chats with current monitoring status
    console.log('🔧 CHAT REVIEW & MODIFICATION');
    console.log('════════════════════════════');
    console.log('Current status for each chat:\n');
    
    chatList.forEach((chat, index) => {
        const type = chat.isGroup ? '👥 Group' : '👤 Individual';
        const participants = chat.isGroup ? ` (${chat.participantCount} members)` : '';
        const status = monitoredIds.has(chat.id) ? '✅ MONITORED' : '❌ Not monitored';
        console.log(`${index + 1}. ${type}: ${chat.name}${participants} - ${status}`);
    });
    
    const rl = createReadlineInterface();
    
    return new Promise(async (resolve) => {
        rl.question('\n👉 Options:\n' +
                   '   • Enter numbers to toggle monitoring (e.g., "1,3,5" to toggle chats 1, 3, and 5)\n' +
                   '   • Enter "all" to monitor all chats\n' +
                   '   • Enter "none" to disable all monitoring\n' +
                   '   • Enter "groups" to monitor only group chats\n' +
                   '   • Enter "done" to finish\n\n' +
                   'Your choice: ', async (answer) => {
            rl.close();
            
            const selection = answer.trim().toLowerCase();
            
            if (selection === 'done') {
                console.log('✅ Chat review completed');
                resolve();
                return;
            }
            
            try {
                await processReviewSelection(selection, chatList, monitoredIds);
                
                // Save updated configuration
                const newMonitoredCount = await getMonitoredChats();
                await saveChatSelectionConfig({
                    is_initialized: true,
                    total_chats_discovered: chatList.length,
                    monitored_chats_count: newMonitoredCount.length
                });
                
                console.log('✅ Configuration updated successfully');
            } catch (error) {
                console.error('❌ Error updating configuration:', error.message);
            }
            
            resolve();
        });
    });
}

async function processReviewSelection(selection, chats, currentMonitoredIds) {
    if (selection === 'all') {
        // Enable monitoring for all chats
        await pool.query('UPDATE chat_configs SET is_monitored = true');
        console.log(`✅ All ${chats.length} chats are now monitored`);
        
    } else if (selection === 'none') {
        // Disable monitoring for all chats
        await pool.query('UPDATE chat_configs SET is_monitored = false');
        console.log('✅ All chat monitoring disabled');
        
    } else if (selection === 'groups') {
        // Monitor only group chats
        await pool.query('UPDATE chat_configs SET is_monitored = false');
        const groupChats = chats.filter(chat => chat.isGroup);
        for (const chat of groupChats) {
            await pool.query(`
                UPDATE chat_configs 
                SET is_monitored = true, updated_at = NOW()
                WHERE chat_id = $1
            `, [chat.id]);
        }
        console.log(`✅ Now monitoring ${groupChats.length} group chats only`);
        
    } else {
        // Parse comma-separated numbers to toggle specific chats
        const numbers = selection.split(',')
            .map(n => parseInt(n.trim()))
            .filter(n => !isNaN(n) && n > 0 && n <= chats.length);
        
        if (numbers.length === 0) {
            console.log('❌ No valid chat numbers provided');
            return;
        }
        
        // Toggle monitoring status for selected chats
        for (const num of numbers) {
            const chat = chats[num - 1];
            const currentlyMonitored = currentMonitoredIds.has(chat.id);
            const newStatus = !currentlyMonitored;
            
            await pool.query(`
                UPDATE chat_configs 
                SET is_monitored = $1, updated_at = NOW()
                WHERE chat_id = $2
            `, [newStatus, chat.id]);
            
            const action = newStatus ? 'enabled' : 'disabled';
            const type = chat.isGroup ? '👥' : '👤';
            console.log(`   ${type} ${chat.name}: monitoring ${action}`);
        }
    }
}

async function promptChatVerification() {
    console.log('🔄 DEBUG: promptChatVerification() called');
    const rl = createReadlineInterface();
    
    console.log('\n🔧 CHAT MONITORING VERIFICATION');
    console.log('═══════════════════════════════');
    
    return new Promise((resolve) => {
        rl.question('\n👉 What would you like to do?\n' +
                   '   1. Keep current chat settings and continue\n' +
                   '   2. Review and modify monitored chats\n' +
                   '   3. Reconfigure all chats from scratch\n' +
                   '   4. Skip verification (use current settings)\n\n' +
                   'Your choice (1-4): ', (answer) => {
            rl.close();
            const choice = parseInt(answer.trim());
            resolve(choice >= 1 && choice <= 4 ? choice : 1);
        });
    });
}

async function showCurrentChatConfig() {
    const config = await getChatSelectionConfig();
    const monitoredChats = await getMonitoredChats();
    
    if (!config || !config.is_initialized) {
        console.log('📋 Current Status: No configuration found (first time setup)');
        return false;
    }
    
    console.log(`📊 Current Configuration:`);
    console.log(`   • Total chats discovered: ${config.total_chats_discovered}`);
    console.log(`   • Currently monitored: ${config.monitored_chats_count}`);
    console.log(`   • Last updated: ${config.last_init_at ? new Date(config.last_init_at).toLocaleString() : 'Never'}`);
    
    if (monitoredChats.length > 0) {
        console.log(`\n📱 Monitored Chats:`);
        monitoredChats.forEach((chat, index) => {
            const type = chat.is_group ? '👥 Group' : '👤 Individual';
            const participants = chat.is_group ? ` (${chat.participant_count} members)` : '';
            console.log(`   ${index + 1}. ${type}: ${chat.chat_name}${participants}`);
        });
    } else {
        console.log('\n⚠️  No chats currently monitored');
    }
    
    return true;
}

async function checkAndRunInitialization() {
    console.log('🔄 DEBUG: checkAndRunInitialization() called');
    if (!ALWAYS_VERIFY_CHATS) {
        console.log('📝 Chat verification disabled, using existing configuration');
        const config = await getChatSelectionConfig();
        if (config && config.is_initialized) {
            console.log(`📊 Using ${config.monitored_chats_count} monitored chats`);
            return;
        }
    }
    
    // Wait for WhatsApp client to be ready
    await new Promise(resolve => {
        if (client.info) {
            resolve();
        } else {
            client.once('ready', resolve);
        }
    });
    
    // Show current configuration
    const hasConfig = await showCurrentChatConfig();
    
    // If no configuration exists, force setup
    if (!hasConfig) {
        console.log('\n🆕 First time setup required');
        await runChatSelectionInit();
        // Skip chat verification prompts for first-time setup
    } else {
        // Ask user what they want to do (only for existing configurations)
        const choice = await promptChatVerification();
        
        switch (choice) {
            case 1: // Keep current settings
                console.log('✅ Keeping current chat settings');
                break;
                
            case 2: // Review and modify
                console.log('🔧 Starting chat review and modification...');
                await runChatSelectionReview();
                break;
                
            case 3: // Reconfigure all
                console.log('🔄 Reconfiguring all chats from scratch...');
                await runChatSelectionInit();
                break;
                
            case 4: // Skip verification
                console.log('⏭️  Skipping verification, using current settings');
                break;
                
            default:
                console.log('✅ Using default option: keeping current settings');
                break;
        }
    }
    
    // After chat verification, process startup messages if enabled
    if (AUTO_PROCESS_STARTUP_MESSAGES) {
        await processStartupMessages();
    }
}

async function promptStartupMessageProcessing() {
    const lastReadTimestamp = await getLastReadTimestamp();
    
    if (!lastReadTimestamp) {
        console.log('\n📝 No previous read timestamp found, skipping startup message processing');
        return false;
    }
    
    const timeSinceLastRead = Date.now() - lastReadTimestamp.getTime();
    const hoursSinceLastRead = Math.floor(timeSinceLastRead / (1000 * 60 * 60));
    const daysSinceLastRead = Math.floor(hoursSinceLastRead / 24);
    
    console.log('\n📨 STARTUP MESSAGE PROCESSING');
    console.log('═════════════════════════════');
    console.log(`📅 Last read: ${lastReadTimestamp.toLocaleString()}`);
    console.log(`⏰ Time since last read: ${daysSinceLastRead} days, ${hoursSinceLastRead % 24} hours`);
    
    if (daysSinceLastRead > MAX_MESSAGE_HISTORY_DAYS) {
        console.log(`⚠️  Note: Will only scan last ${MAX_MESSAGE_HISTORY_DAYS} days due to MAX_MESSAGE_HISTORY_DAYS limit`);
    }
    
    const rl = createReadlineInterface();
    
    return new Promise((resolve) => {
        rl.question('\n👉 Would you like to process unread messages from monitored chats?\n' +
                   '   1. Yes, scan and process all unread messages\n' +
                   '   2. Yes, but show me a summary first\n' +
                   '   3. No, skip startup message processing\n\n' +
                   'Your choice (1-3): ', (answer) => {
            rl.close();
            const choice = parseInt(answer.trim());
            resolve(choice >= 1 && choice <= 3 ? choice : 3);
        });
    });
}

async function processMessagesForTasks(messages, chatConfig) {
    let detectedTasks = 0;
    
    for (const message of messages) {
        try {
            // Use existing task detection logic
            const hasIndicators = hasTaskIndicators(message.body);
            
            if (hasIndicators) {
                // Analyze with AI for task detection
                const analysis = await detectTask(message);
                
                if (analysis && analysis.is_task) {
                    // Save the detected task
                    await saveTask({
                        messageId: message.id,
                        chatId: message.chatId,
                        chatName: chatConfig.chat_name,
                        senderName: message.author || message.from,
                        originalText: message.body,
                        analysis: analysis
                    });
                    
                    detectedTasks++;
                }
            }
            
            // Mark message as processed
            await markMessageProcessed(
                message.id,
                message.chatId,
                hasIndicators,
                hasIndicators
            );
            
        } catch (error) {
            console.log(`   ⚠️  Error processing message: ${error.message}`);
        }
    }
    
    return detectedTasks;
}

async function processStartupMessages() {
    try {
        const choice = await promptStartupMessageProcessing();
        
        if (choice === 3) {
            console.log('⏭️  Skipping startup message processing');
            return;
        }
        
        console.log('\n🔍 Scanning for unread messages...');
        
        const monitoredChats = await getMonitoredChats();
        if (monitoredChats.length === 0) {
            console.log('⚠️  No monitored chats found, skipping message processing');
            return;
        }
        
        const lastReadTimestamp = await getLastReadTimestamp();
        let totalMessages = 0;
        let totalTasks = 0;
        let processedChats = 0;
        
        console.log(`📊 Scanning ${monitoredChats.length} monitored chats...`);
        
        for (const chatConfig of monitoredChats) {
            try {
                console.log(`\n📱 [${processedChats + 1}/${monitoredChats.length}] Scanning: ${chatConfig.chat_name}`);
                
                const messages = await getMessagesFromChat(
                    chatConfig.chat_id, 
                    lastReadTimestamp, 
                    MAX_MESSAGE_HISTORY_DAYS,
                    MESSAGE_FETCH_LIMIT
                );
                
                if (messages.length === 0) {
                    console.log('   📭 No new messages');
                } else {
                    console.log(`   📨 Found ${messages.length} messages`);
                    totalMessages += messages.length;
                    
                    if (choice === 1) {
                        // Process messages for tasks
                        const chatTasks = await processMessagesForTasks(messages, chatConfig);
                        if (chatTasks > 0) {
                            console.log(`   ✅ Detected ${chatTasks} tasks`);
                            totalTasks += chatTasks;
                        }
                    }
                }
                
                processedChats++;
                
                // Show progress
                const progress = Math.round((processedChats / monitoredChats.length) * 100);
                console.log(`   📈 Progress: ${progress}% (${processedChats}/${monitoredChats.length} chats)`);
                
            } catch (error) {
                console.log(`   ❌ Error scanning ${chatConfig.chat_name}: ${error.message}`);
            }
        }
        
        // Show final summary
        console.log('\n📊 STARTUP SCAN SUMMARY');
        console.log('═══════════════════════');
        console.log(`📨 Total messages found: ${totalMessages}`);
        console.log(`📱 Chats scanned: ${processedChats}/${monitoredChats.length}`);
        
        if (choice === 1) {
            console.log(`🎯 Tasks detected: ${totalTasks}`);
            
            if (totalMessages > 0) {
                // Update last read timestamp
                await updateLastReadTimestamp();
                console.log('✅ Last read timestamp updated');
            }
        } else if (choice === 2 && totalMessages > 0) {
            // Show summary and ask if user wants to process
            const rl = createReadlineInterface();
            
            const shouldProcess = await new Promise((resolve) => {
                rl.question(`\n👉 Found ${totalMessages} unread messages. Process them for tasks? (y/n): `, (answer) => {
                    rl.close();
                    resolve(answer.trim().toLowerCase().startsWith('y'));
                });
            });
            
            if (shouldProcess) {
                console.log('\n🔄 Processing messages for task detection...');
                
                for (const chatConfig of monitoredChats) {
                    const messages = await getMessagesFromChat(
                        chatConfig.chat_id, 
                        lastReadTimestamp, 
                        MAX_MESSAGE_HISTORY_DAYS,
                        MESSAGE_FETCH_LIMIT
                    );
                    
                    if (messages.length > 0) {
                        const chatTasks = await processMessagesForTasks(messages, chatConfig);
                        totalTasks += chatTasks;
                    }
                }
                
                console.log(`✅ Processing complete! Detected ${totalTasks} tasks total`);
                await updateLastReadTimestamp();
                console.log('✅ Last read timestamp updated');
            }
        }
        
        console.log('\n🚀 Startup processing complete, beginning live monitoring...\n');
        
    } catch (error) {
        console.error('❌ Error during startup message processing:', error.message);
        console.log('🔄 Continuing with live monitoring...\n');
    }
}

// Message history retrieval functions
async function getLastReadTimestamp() {
    try {
        const result = await pool.query('SELECT last_read_timestamp FROM bot_sessions LIMIT 1');
        return result.rows[0]?.last_read_timestamp || null;
    } catch (error) {
        console.error('❌ Error getting last read timestamp:', error.message);
        return null;
    }
}

async function updateLastReadTimestamp() {
    try {
        await pool.query(`
            UPDATE bot_sessions 
            SET last_read_timestamp = NOW(), updated_at = NOW()
            WHERE id = (SELECT id FROM bot_sessions LIMIT 1)
        `);
        console.log('✅ Last read timestamp updated');
    } catch (error) {
        console.error('❌ Error updating last read timestamp:', error.message);
        throw error;
    }
}

async function getMonitoredChats() {
    try {
        const result = await pool.query(`
            SELECT chat_id, chat_name, is_group, participant_count 
            FROM chat_configs 
            WHERE is_monitored = true
            ORDER BY chat_name
        `);
        return result.rows;
    } catch (error) {
        console.error('❌ Error getting monitored chats:', error.message);
        return [];
    }
}

async function getMessagesFromChat(chatId, fromTimestamp, maxDays = null, fetchLimit = MESSAGE_FETCH_LIMIT) {
    try {
        const chat = await client.getChatById(chatId);
        if (!chat) {
            console.log(`⚠️  Chat not found: ${chatId}`);
            return [];
        }
        
        // Calculate the earliest timestamp based on max days limit
        let earliestTimestamp = fromTimestamp;
        if (maxDays) {
            const maxDaysAgo = new Date(Date.now() - (maxDays * 24 * 60 * 60 * 1000));
            if (fromTimestamp && fromTimestamp < maxDaysAgo) {
                earliestTimestamp = maxDaysAgo;
            }
        }
        
        // Loop fetching messages until we encounter one older than earliestTimestamp
        let limit = fetchLimit;
        let messages = await chat.fetchMessages({ limit });
        let filteredMessages = messages.filter(msg => {
            const messageDate = new Date(msg.timestamp * 1000);
            return messageDate >= earliestTimestamp;
        });

        // Increase limit and refetch while all messages are within the time window
        // and more messages may be available
        while (filteredMessages.length === messages.length && messages.length === limit) {
            limit += fetchLimit;
            messages = await chat.fetchMessages({ limit });
            filteredMessages = messages.filter(msg => {
                const messageDate = new Date(msg.timestamp * 1000);
                return messageDate >= earliestTimestamp;
            });
        }

        // Format messages for display
        return filteredMessages.map(msg => ({
            id: msg.id._serialized,
            timestamp: new Date(msg.timestamp * 1000),
            from: msg.from,
            author: msg.author || msg.from,
            body: msg.body || '[Media/Other]',
            type: msg.type,
            isGroup: !!msg.author,
            hasMedia: msg.hasMedia,
            chatId: chatId
        }));
        
    } catch (error) {
        console.error(`❌ Error fetching messages from chat ${chatId}:`, error.message);
        return [];
    }
}

async function getUnreadMessages(maxDays = null) {
    try {
        const lastReadTimestamp = await getLastReadTimestamp();
        if (!lastReadTimestamp) {
            console.log('⚠️  No last read timestamp found, initializing...');
            await updateLastReadTimestamp();
            return [];
        }
        
        const monitoredChats = await getMonitoredChats();
        if (monitoredChats.length === 0) {
            console.log('⚠️  No monitored chats found');
            return [];
        }
        
        console.log(`📖 Fetching messages since ${lastReadTimestamp.toLocaleString()}`);
        console.log(`🔍 Checking ${monitoredChats.length} monitored chats...`);
        
        const allMessages = [];
        
        for (const chatConfig of monitoredChats) {
            console.log(`   📱 Checking ${chatConfig.chat_name}...`);
            const messages = await getMessagesFromChat(chatConfig.chat_id, lastReadTimestamp, maxDays, MESSAGE_FETCH_LIMIT);
            
            if (messages.length > 0) {
                console.log(`   ✅ Found ${messages.length} messages in ${chatConfig.chat_name}`);
                allMessages.push({
                    chatName: chatConfig.chat_name,
                    chatId: chatConfig.chat_id,
                    isGroup: chatConfig.is_group,
                    messages: messages
                });
            }
        }
        
        return allMessages;
        
    } catch (error) {
        console.error('❌ Error getting unread messages:', error.message);
        return [];
    }
}

function formatUnreadMessages(chatMessages) {
    if (!chatMessages || chatMessages.length === 0) {
        return '📭 No unread messages found';
    }
    
    let output = '\n📨 UNREAD MESSAGES\n';
    output += '════════════════════════════════════════════════════════\n';
    
    let totalMessages = 0;
    
    for (const chat of chatMessages) {
        totalMessages += chat.messages.length;
        const chatType = chat.isGroup ? '👥 Group' : '👤 Individual';
        output += `\n${chatType}: ${chat.chatName} (${chat.messages.length} messages)\n`;
        output += '────────────────────────────────────────────────────────\n';
        
        // Sort messages by timestamp (oldest first)
        const sortedMessages = chat.messages.sort((a, b) => a.timestamp - b.timestamp);
        
        for (const msg of sortedMessages) {
            const time = msg.timestamp.toLocaleString();
            const sender = msg.isGroup ? msg.author.split('@')[0] : 'Direct';
            const preview = msg.body.length > 50 ? msg.body.substring(0, 50) + '...' : msg.body;
            
            output += `📅 ${time}\n`;
            output += `👤 ${sender}: ${preview}\n`;
            if (msg.hasMedia) {
                output += `📎 [Contains media]\n`;
            }
            output += '\n';
        }
    }
    
    output += `\n📊 Total: ${totalMessages} unread messages from ${chatMessages.length} chats`;
    
    return output;
}

async function startBot() {
    console.log('🚀 Starting WhatsApp Task Listener...');
    await initDatabase();
    await initBotSession();
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