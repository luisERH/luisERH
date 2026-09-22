"""SQLite persistence for OAuth state and conversation history.

Everything here is small and short-lived, so a single connection guarded by a lock is
enough; it keeps the server to one file on disk and no external services.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    payload   TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS login_requests (
    request_id TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    expires_at REAL NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_codes (
    code       TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    expires_at REAL
);
CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    subject    TEXT NOT NULL,
    title      TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conversations_subject ON conversations(subject, updated_at DESC);
"""


def hash_token(token: str) -> str:
    """Tokens are stored hashed, so a stolen database file yields no usable credential."""
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class ConversationSummary:
    id: str
    title: str
    created_at: float
    updated_at: float
    message_count: int


class Store:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        if db_path != ":memory:":
            parent = os.path.dirname(os.path.abspath(db_path))
            os.makedirs(parent, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.execute("PRAGMA foreign_keys = ON")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- generic helpers -------------------------------------------------

    def _write(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        with self._lock:
            self._conn.execute(sql, params)
            self._conn.commit()

    def _read_one(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def _read_all(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    # --- OAuth clients ---------------------------------------------------

    def save_client(self, client_id: str, payload: dict[str, Any]) -> None:
        self._write(
            "INSERT OR REPLACE INTO clients (client_id, payload, created_at) VALUES (?, ?, ?)",
            (client_id, json.dumps(payload), time.time()),
        )

    def get_client(self, client_id: str) -> dict[str, Any] | None:
        row = self._read_one("SELECT payload FROM clients WHERE client_id = ?", (client_id,))
        return json.loads(row["payload"]) if row else None

    # --- pending logins --------------------------------------------------

    def create_login_request(self, payload: dict[str, Any], ttl: int) -> str:
        request_id = uuid.uuid4().hex
        self._write(
            "INSERT INTO login_requests (request_id, payload, expires_at) VALUES (?, ?, ?)",
            (request_id, json.dumps(payload), time.time() + ttl),
        )
        return request_id

    def get_login_request(self, request_id: str) -> tuple[dict[str, Any], int] | None:
        row = self._read_one(
            "SELECT payload, expires_at, attempts FROM login_requests WHERE request_id = ?",
            (request_id,),
        )
        if row is None or row["expires_at"] < time.time():
            return None
        return json.loads(row["payload"]), int(row["attempts"])

    def bump_login_attempts(self, request_id: str) -> None:
        self._write("UPDATE login_requests SET attempts = attempts + 1 WHERE request_id = ?", (request_id,))

    def delete_login_request(self, request_id: str) -> None:
        self._write("DELETE FROM login_requests WHERE request_id = ?", (request_id,))

    # --- authorization codes ---------------------------------------------

    def save_auth_code(self, code: str, payload: dict[str, Any], expires_at: float) -> None:
        self._write(
            "INSERT INTO auth_codes (code, payload, expires_at) VALUES (?, ?, ?)",
            (code, json.dumps(payload), expires_at),
        )

    def pop_auth_code(self, code: str) -> dict[str, Any] | None:
        """Read and delete in one step: an authorization code is single-use (RFC 6749 §10.5)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT payload, expires_at FROM auth_codes WHERE code = ?", (code,)
            ).fetchone()
            if row is None:
                return None
            self._conn.execute("DELETE FROM auth_codes WHERE code = ?", (code,))
            self._conn.commit()
        if row["expires_at"] < time.time():
            return None
        return json.loads(row["payload"])

    def peek_auth_code(self, code: str) -> dict[str, Any] | None:
        row = self._read_one("SELECT payload, expires_at FROM auth_codes WHERE code = ?", (code,))
        if row is None or row["expires_at"] < time.time():
            return None
        return json.loads(row["payload"])

    # --- tokens ----------------------------------------------------------

    def save_token(self, token: str, kind: str, payload: dict[str, Any], expires_at: float | None) -> None:
        self._write(
            "INSERT OR REPLACE INTO tokens (token_hash, kind, payload, expires_at) VALUES (?, ?, ?, ?)",
            (hash_token(token), kind, json.dumps(payload), expires_at),
        )

    def get_token(self, token: str, kind: str) -> dict[str, Any] | None:
        row = self._read_one(
            "SELECT payload, expires_at FROM tokens WHERE token_hash = ? AND kind = ?",
            (hash_token(token), kind),
        )
        if row is None:
            return None
        if row["expires_at"] is not None and row["expires_at"] < time.time():
            self.delete_token(token)
            return None
        return json.loads(row["payload"])

    def delete_token(self, token: str) -> None:
        self._write("DELETE FROM tokens WHERE token_hash = ?", (hash_token(token),))

    def delete_tokens_for_client(self, client_id: str) -> None:
        self._write(
            "DELETE FROM tokens WHERE json_extract(payload, '$.client_id') = ?",
            (client_id,),
        )

    def purge_expired(self) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute("DELETE FROM auth_codes WHERE expires_at < ?", (now,))
            self._conn.execute("DELETE FROM login_requests WHERE expires_at < ?", (now,))
            self._conn.execute("DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?", (now,))
            self._conn.commit()

    # --- conversations ---------------------------------------------------

    def create_conversation(self, subject: str, title: str) -> str:
        conversation_id = uuid.uuid4().hex[:12]
        now = time.time()
        self._write(
            "INSERT INTO conversations (id, subject, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (conversation_id, subject, title, now, now),
        )
        return conversation_id

    def conversation_exists(self, conversation_id: str, subject: str) -> bool:
        return (
            self._read_one(
                "SELECT 1 FROM conversations WHERE id = ? AND subject = ?", (conversation_id, subject)
            )
            is not None
        )

    def append_message(self, conversation_id: str, role: str, content: str) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
                (conversation_id, role, content, now),
            )
            self._conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
            self._conn.commit()

    def recent_messages(self, conversation_id: str, limit: int) -> list[dict[str, str]]:
        rows = self._read_all(
            "SELECT role, content FROM (SELECT role, content, id FROM messages "
            "WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
            (conversation_id, limit),
        )
        return [{"role": row["role"], "content": row["content"]} for row in rows]

    def list_conversations(self, subject: str, limit: int) -> list[ConversationSummary]:
        rows = self._read_all(
            "SELECT c.id, c.title, c.created_at, c.updated_at, "
            "(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count "
            "FROM conversations c WHERE c.subject = ? ORDER BY c.updated_at DESC LIMIT ?",
            (subject, limit),
        )
        return [
            ConversationSummary(
                id=row["id"],
                title=row["title"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                message_count=row["message_count"],
            )
            for row in rows
        ]

    def get_conversation(self, conversation_id: str, subject: str) -> ConversationSummary | None:
        row = self._read_one(
            "SELECT c.id, c.title, c.created_at, c.updated_at, "
            "(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count "
            "FROM conversations c WHERE c.id = ? AND c.subject = ?",
            (conversation_id, subject),
        )
        if row is None:
            return None
        return ConversationSummary(
            id=row["id"],
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            message_count=row["message_count"],
        )
