# WhatsApp Task Detection Bot

An intelligent WhatsApp bot that automatically detects actionable tasks and events from chat messages using AI, with a web dashboard for task management.

## Features

- 🤖 **Automatic Task Detection**: Uses OpenAI GPT-4 to identify tasks, events, and payment requests
- 📱 **WhatsApp Integration**: Works with WhatsApp Web via whatsapp-web.js
- 🎯 **Smart Filtering**: Pre-filters messages using keyword indicators to optimize AI usage
- 📊 **Web Dashboard**: Mobile-friendly dashboard with temporal security tokens
- 🗄️ **Database Storage**: PostgreSQL database for persistent task and chat management
- 🔍 **Chat Management**: Monitor specific chats and groups for task detection
- 💬 **Command Interface**: Dedicated command chat for bot interaction
- ⚡ **Health Monitoring**: Built-in health checks and connection stability monitoring

## Quick Start

### Prerequisites

- Node.js 16+ 
- PostgreSQL 12+
- WhatsApp account for bot connection

### Installation

1. **Clone and install dependencies:**
```bash
git clone <repository-url>
cd whatsapp-bot-claude
npm install
```

2. **Set up PostgreSQL database:**
```bash
# Create database and user
psql -U postgres -c "CREATE DATABASE whatsapp_bot;"
psql -U postgres -c "CREATE USER whatsapp_bot WITH PASSWORD 'your_password_here';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE whatsapp_bot TO whatsapp_bot;"

# Initialize schema
PGPASSWORD=your_password_here psql -U whatsapp_bot -h localhost -d whatsapp_bot -f schema.sql
```

3. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your credentials (see Configuration section below)
```

4. **Start the services:**
```bash
# Terminal 1: Start the bot
npm start

# Terminal 2: Start the dashboard (in another terminal)
npm run dashboard
```

5. **Initial setup:**
   - Scan the QR code with your WhatsApp mobile app
   - Create a "Bot Commands" chat/group for bot interaction
   - Use `/help` command to see available commands

## Configuration

### Environment Variables (.env)

```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# WhatsApp Configuration
MONITORED_CHATS=Work Team,Family Chat,Project Group
BOT_COMMAND_CHAT=Bot Commands
MAX_MESSAGE_HISTORY_DAYS=3

# PostgreSQL Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=whatsapp_bot
DB_USER=whatsapp_bot
DB_PASSWORD=your_postgres_password_here

# Dashboard Configuration
DASHBOARD_PORT=3000

# Message Retrieval
MESSAGE_FETCH_LIMIT=50
`MESSAGE_FETCH_LIMIT` sets how many messages to request at a time when scanning chats for unread history. Increase it to search further back.

# Message History
MAX_MESSAGE_HISTORY_DAYS=3
`MAX_MESSAGE_HISTORY_DAYS` controls how many days of messages the bot looks back when running the `/read_unread` command.

# Session Management
SESSION_CLEAR_THRESHOLD=3
AUTO_CLEAR_SESSION=true
SESSION_RETRY_DELAY=3000
`SESSION_CLEAR_THRESHOLD` controls how many failed connection attempts before clearing WhatsApp session (default: 3).
`AUTO_CLEAR_SESSION` allows disabling automatic session clearing (set to false to never auto-clear).
`SESSION_RETRY_DELAY` sets delay in milliseconds between connection retry attempts (default: 3000).

# Startup Behavior
ALWAYS_VERIFY_CHATS=true
AUTO_PROCESS_STARTUP_MESSAGES=true
STARTUP_SCAN_TIMEOUT=60000
`ALWAYS_VERIFY_CHATS` controls whether to always prompt for chat verification on startup (default: true).
`AUTO_PROCESS_STARTUP_MESSAGES` enables automatic processing of unread messages on startup (default: true).
`STARTUP_SCAN_TIMEOUT` sets timeout for startup message scanning in milliseconds (default: 60000).

## 🚀 Startup Process

The bot follows an enhanced initialization process on startup:

### 1. **Chat Verification Phase**
- Always prompts to verify monitored chats (unless `ALWAYS_VERIFY_CHATS=false`)
- Shows current configuration and monitoring status
- Options to keep settings, review/modify, or reconfigure completely
- Interactive terminal-based chat selection with toggle functionality

### 2. **Startup Message Processing** 
- Automatically scans for unread messages since last session
- Shows time since last read and message count preview
- Options to process immediately, review summary first, or skip
- Progress tracking with chat-by-chat scanning status
- Automatic task detection on historical messages
- Updates last read timestamp after processing

### 3. **Live Monitoring**
- Transitions to real-time message monitoring
- Continues detecting tasks from new incoming messages

### Required API Keys

1. **OpenAI API Key**: Get from [OpenAI Platform](https://platform.openai.com/)
   - Requires GPT-4 access for optimal task detection
   - Set billing limits to control costs

2. **WhatsApp Setup**: 
   - Uses WhatsApp Web - no API key needed
   - Requires phone to scan QR code for initial connection

## Usage

### Bot Commands

Use these commands in your designated "Bot Commands" chat:

**Task Management:**
- `/tasks` - Show all detected tasks
- `/pending` - Show pending tasks only  
- `/completed` - Show completed tasks
- `/stats` - Global task statistics

**Chat Management:**
- `/chats` - Show recent active chats (last 7 days)
- `/allchats` - Show all discovered chats
- `/monitored` - Show currently monitored chats
- `/monitor <number>` - Start monitoring a chat
- `/unmonitor <number>` - Stop monitoring a chat
- `/refresh` - Refresh chat discovery

**Message History:**
- `/read_unread [days]` - List unread messages from the last N days (default history window)
- `/mark_read` - Mark all messages as read and update the timestamp
- `/status` - Show bot login info and monitoring status
- `/clear_session` - Manually clear WhatsApp session (forces QR scan)

**Dashboard & Help:**
- `/dashboard` - Get secure mobile dashboard link
- `/help` - Show all available commands

### Task Detection

The bot automatically analyzes messages in monitored chats for:

**Events**: Meetings, appointments, celebrations with date/time
- "Tomorrow at 3pm we have a team meeting"
- "Birthday party on Sunday"
- "Dentist appointment next Monday 10:30"

**Payments**: Money transfers, bills, payments
- "Pay 150₪ for the dinner"
- "Transfer $50 to John for groceries"
- "Registration fee: 200 shekels"

**Supported Languages**: Hebrew and English with smart date/time parsing

### Web Dashboard

Access via `/dashboard` command for:
- View all tasks in mobile-friendly interface
- Mark tasks as completed
- Delete tasks
- Real-time updates
- Secure 5-minute access tokens

## Architecture

```
WhatsApp Web ←→ Bot (index.js) ←→ PostgreSQL Database
                    ↓
                Dashboard Server (dashboard.js) ←→ Web UI
```

### Key Components

- **index.js**: Main bot logic, WhatsApp integration, task detection
- **dashboard.js**: Web server for task management dashboard  
- **schema.sql**: Database schema for tasks, chats, and processed messages
- **public/**: Web dashboard HTML files

### Database Schema

- **tasks**: Detected tasks with metadata (event_time, amount, links, etc.)
- **processed_messages**: Message deduplication and analytics
- **chat_configs**: Chat monitoring configuration and discovery

## Troubleshooting

### Common Issues

**QR Code Problems:**
- Delete `.wwebjs_auth` folder and restart for fresh QR
- Ensure phone has stable internet connection
- Use `/refresh` to rediscover chats after connection

**Database Connection:**
- Verify PostgreSQL is running: `brew services list | grep postgresql`
- Check credentials in `.env` file
- Test connection: `psql -U whatsapp_bot -h localhost -d whatsapp_bot`

**Task Detection Issues:**
- Check OpenAI API key and billing limits
- Verify monitored chats are correctly configured
- Use `/stats` to see detection statistics

**Dashboard Access:**
- Ensure dashboard server is running on port 3000
- Check if `/dashboard` command returns valid URL
- Verify local network connectivity

### Health Monitoring

The bot includes built-in health monitoring every 5 minutes:
- WhatsApp connection status
- Database connectivity
- Memory usage alerts
- Message activity tracking

### Logs and Debugging

Monitor bot logs for:
- Connection status updates
- Task detection results
- Error messages and stack traces
- Health check reports

## Security Considerations

- Dashboard uses temporal tokens (5-minute expiry)
- Database credentials should be unique and secure
- OpenAI API key should be kept confidential
- WhatsApp session files contain authentication data

## Performance

- Pre-filtering reduces OpenAI API calls by ~80%
- Database indexing optimizes query performance
- Message deduplication prevents reprocessing
- Rate limiting protects against API limits

## Development

### Adding New Task Types

1. Update `hasTaskIndicators()` function with new keywords
2. Modify `TASK_DETECTION_PROMPT` for new task types
3. Update database schema if new fields needed
4. Add UI support in dashboard

### Extending Commands

1. Add new command case in `handleCommand()` function
2. Implement command logic
3. Update `/help` command documentation
4. Test in dedicated command chat

## License

ISC License - see package.json for details

## Support

For issues and feature requests, please check:
1. This README for common solutions
2. Bot logs for error messages  
3. Health check output for system status
4. Database connectivity and schema

If the above steps do not resolve your problem or you have a feature request, please open an issue on GitHub with relevant logs and a clear description.
