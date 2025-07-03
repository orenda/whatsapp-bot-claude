-- WhatsApp Bot Database Schema

-- Table for storing detected tasks
CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    message_id VARCHAR(255) UNIQUE NOT NULL,
    chat_id VARCHAR(255) NOT NULL,
    chat_name VARCHAR(255),
    sender_name VARCHAR(255),
    original_text TEXT NOT NULL,
    is_task BOOLEAN NOT NULL DEFAULT false,
    task_types TEXT[], -- array of task types: event, payment
    summary TEXT,
    event_time TIMESTAMP,
    amount VARCHAR(50),
    link TEXT,
    confidence DECIMAL(3,2),
    status VARCHAR(20) DEFAULT 'pending', -- pending, completed
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table for storing all processed messages (for deduplication)
CREATE TABLE IF NOT EXISTS processed_messages (
    id SERIAL PRIMARY KEY,
    message_id VARCHAR(255) UNIQUE NOT NULL,
    chat_id VARCHAR(255) NOT NULL,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    had_task_indicators BOOLEAN DEFAULT false,
    was_analyzed BOOLEAN DEFAULT false
);

-- Table for managing chat configurations
CREATE TABLE IF NOT EXISTS chat_configs (
    id SERIAL PRIMARY KEY,
    chat_id VARCHAR(255) UNIQUE NOT NULL,
    chat_name VARCHAR(255) NOT NULL,
    is_monitored BOOLEAN DEFAULT false,
    is_group BOOLEAN DEFAULT true,
    participant_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_message_id ON tasks(message_id);
CREATE INDEX IF NOT EXISTS idx_tasks_chat_id ON tasks(chat_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_processed_messages_message_id ON processed_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_processed_messages_chat_id ON processed_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_configs_chat_id ON chat_configs(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_configs_monitored ON chat_configs(is_monitored);