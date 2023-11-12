-- migrations/001-initial.sql
CREATE TABLE guilds (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT NOT NULL
);

CREATE TABLE members (
    member_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    discriminator TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    FOREIGN KEY (guild_id) REFERENCES guilds(id)
);

CREATE TABLE IF NOT EXISTS roles (
    role_id TEXT PRIMARY KEY,
    role_name TEXT NOT NULL,
    guild_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES members(member_id),
    FOREIGN KEY (role_id) REFERENCES roles(role_id)
);

CREATE TABLE IF NOT EXISTS voting_threads (
    thread_id TEXT PRIMARY KEY,
    created_at DATETIME NOT NULL,
    nominator_id TEXT NOT NULL,
    nominee_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_name TEXT NOT NULL,
    vote_count INTEGER DEFAULT 0,
    status TEXT CHECK( status IN ('OPEN','CLOSED') )
);

CREATE TABLE IF NOT EXISTS votes (
    vote_id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    vote_timestamp DATETIME NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES voting_threads(thread_id),
    FOREIGN KEY (voter_id) REFERENCES members(member_id)
);
