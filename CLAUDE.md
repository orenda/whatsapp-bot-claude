# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Primary Commands
- `npm start` - Start the main WhatsApp bot service
- `npm run dev` - Run in development mode (same as start)
- `npm run dashboard` - Start the web dashboard server on port 3000
- `npm test` - Run Jest tests

### Database Setup
```bash
# Initialize PostgreSQL schema
PGPASSWORD=your_password_here psql -U whatsapp_bot -h localhost -d whatsapp_bot -f schema.sql
```

### Testing
- Uses Jest testing framework
- Test files in `/tests/` directory
- Run single test: `npm test -- dashboard.test.js`

## Architecture Overview

This is a Node.js WhatsApp bot that uses AI for task detection with the following core components:

### Main Services
- **Bot Service** (`index.js`): Core WhatsApp integration, AI processing, and message handling
- **Dashboard Service** (`dashboard.js`): Web API server with temporal token-based security

### Key Libraries
- `whatsapp-web.js`: WhatsApp Web protocol integration
- `openai`: GPT-4 integration for task detection
- `pg`: PostgreSQL database client with connection pooling
- `express`: Web server for dashboard API

### Database Schema
- **tasks**: Detected tasks with metadata (confidence, types, amounts, event times)
- **processed_messages**: Message deduplication tracking
- **chat_configs**: Chat monitoring configuration
- **bot_sessions**: Session state and last read timestamps

## Critical Architecture Patterns

### Message Processing Pipeline
1. **Reception**: WhatsApp event triggers message handler
2. **Pre-filtering**: Pattern matching via `hasTaskIndicators()` (reduces LLM calls by ~80%)
3. **Deduplication**: Check `processed_messages` table
4. **AI Analysis**: Send to OpenAI GPT-4 if indicators present
5. **Storage**: Save to `tasks` table with structured data
6. **Tracking**: Mark as processed regardless of outcome

### Session Management
- **Health Validation**: `isSessionHealthy()` checks session age/integrity
- **Auto-Recovery**: Clears corrupted sessions after configurable threshold
- **Backup System**: Creates session backups before clearing
- Session files stored in `.wwebjs_auth/` directory

### Security Model
- Dashboard uses temporal tokens (5-minute expiry)
- Commands only work in designated command chat
- Database credentials must be properly configured in `.env`

## Key Functions and Entry Points

### Core Processing Functions
- `detectTask()`: AI-powered task detection with structured JSON responses
- `hasTaskIndicators()`: Pattern-based pre-filtering for Hebrew/English
- `processMessagesForTasks()`: Bulk processing for startup message scanning
- `handleCommand()`: Command processing with proper error handling

### Data Management
- `saveTask()`: Structured task storage with conflict resolution
- `markMessageProcessed()`: Deduplication tracking
- `getAllTasks()`, `getTasksByChat()`: Query methods for task retrieval

### Health & Recovery
- `performHealthCheck()`: Comprehensive system health monitoring every 5 minutes
- `clearSessionSafely()`: Safe session clearing with backup
- Connection resilience with retry logic and timeout handling

## Configuration Requirements

### Environment Variables (.env)
```bash
# Required
OPENAI_API_KEY=your_openai_api_key_here
DB_PASSWORD=your_postgres_password_here

# Chat Configuration
MONITORED_CHATS=Work Team,Family Chat,Project Group
BOT_COMMAND_CHAT=Bot Commands
MAX_MESSAGE_HISTORY_DAYS=3

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=whatsapp_bot
DB_USER=whatsapp_bot

# Session Management
SESSION_CLEAR_THRESHOLD=3
AUTO_CLEAR_SESSION=true
SESSION_RETRY_DELAY=3000

# Startup Behavior
ALWAYS_VERIFY_CHATS=true
AUTO_PROCESS_STARTUP_MESSAGES=true
STARTUP_SCAN_TIMEOUT=60000
```

### Prerequisites
- Node.js 16+
- PostgreSQL 12+
- OpenAI API key with GPT-4 access
- WhatsApp account for bot connection

## Development Guidelines

### Adding New Task Types
1. Update `hasTaskIndicators()` function in `index.js` with new keywords
2. Modify `TASK_DETECTION_PROMPT` constant for new task types
3. Update database schema if new fields needed
4. Add UI support in dashboard HTML files

### Extending Commands
1. Add new command case in `handleCommand()` function
2. Implement command logic
3. Update `/help` command documentation
4. Test in dedicated command chat

### Database Modifications
- Schema changes go in `schema.sql`
- Add appropriate indexes for performance
- Update backup/restore procedures if needed

## Common Issues and Solutions

### WhatsApp Connection Issues
- Delete `.wwebjs_auth/` folder for fresh QR code
- Check `SESSION_CLEAR_THRESHOLD` configuration
- Monitor health check logs for connection status

### Task Detection Problems
- Verify OpenAI API key and billing limits
- Check `hasTaskIndicators()` patterns for new languages
- Review AI prompt engineering in `TASK_DETECTION_PROMPT`

### Database Connectivity
- Verify PostgreSQL service is running
- Check connection credentials in `.env`
- Test with: `psql -U whatsapp_bot -h localhost -d whatsapp_bot`

## Important Notes

- **Two-Service Architecture**: Always run both bot and dashboard services
- **Session Files**: `.wwebjs_auth/` contains authentication data - don't delete unnecessarily
- **Rate Limiting**: Pre-filtering is crucial for controlling OpenAI API costs
- **Mobile Dashboard**: Access via `/dashboard` command for secure mobile interface
- **Health Monitoring**: Built-in health checks run every 5 minutes
- **Multi-language Support**: Handles Hebrew/English mixed content