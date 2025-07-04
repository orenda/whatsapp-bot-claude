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

# PostgreSQL Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=whatsapp_bot
DB_USER=whatsapp_bot
DB_PASSWORD=your_postgres_password_here

# Dashboard Configuration
DASHBOARD_PORT=3000
```

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
