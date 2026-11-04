import datetime as dt
import os
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS cursor (
    source TEXT NOT NULL, account TEXT NOT NULL, since TEXT NOT NULL,
    PRIMARY KEY (source, account));
CREATE TABLE IF NOT EXISTS conversation (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, native_id TEXT NOT NULL,
    title TEXT, approval TEXT NOT NULL DEFAULT 'approve', last_message_at TEXT,
    UNIQUE (source, account, native_id));
CREATE TABLE IF NOT EXISTS person (
    id INTEGER PRIMARY KEY, email TEXT UNIQUE, teams_oid TEXT UNIQUE, gchat_id TEXT UNIQUE, name TEXT);
CREATE TABLE IF NOT EXISTS message (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, message_id TEXT NOT NULL,
    conversation INTEGER NOT NULL REFERENCES conversation, person INTEGER REFERENCES person,
    sender TEXT, sender_name TEXT, sender_is_me INTEGER NOT NULL, sent_at TEXT NOT NULL,
    text TEXT, attachments TEXT, ref TEXT, batch INTEGER REFERENCES batch, stored_at TEXT NOT NULL,
    UNIQUE (source, message_id));
CREATE TABLE IF NOT EXISTS batch (
    id INTEGER PRIMARY KEY, conversation INTEGER NOT NULL REFERENCES conversation,
    work_item INTEGER REFERENCES work_item, state TEXT NOT NULL, prompt_id TEXT, error TEXT,
    created_at TEXT NOT NULL, delivered_at TEXT, done_at TEXT);
CREATE TABLE IF NOT EXISTS work_item (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, client TEXT, vault_note TEXT, note_guess TEXT, session_id TEXT,
    keys TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', status_line TEXT,
    created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_item_conversation (
    work_item INTEGER NOT NULL REFERENCES work_item, conversation INTEGER NOT NULL REFERENCES conversation,
    kind TEXT NOT NULL DEFAULT 'attach', created_at TEXT NOT NULL,
    PRIMARY KEY (work_item, conversation));
CREATE TABLE IF NOT EXISTS triage_log (
    id INTEGER PRIMARY KEY, batch INTEGER REFERENCES batch, conversation INTEGER REFERENCES conversation,
    at TEXT NOT NULL, relevant INTEGER, assigned_to_me INTEGER, action TEXT, work_item TEXT,
    reason TEXT, confidence REAL, candidates TEXT, raw TEXT);
CREATE TABLE IF NOT EXISTS draft (
    id INTEGER PRIMARY KEY, work_item INTEGER NOT NULL REFERENCES work_item,
    conversation INTEGER REFERENCES conversation, batch INTEGER REFERENCES batch, text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approval_request (
    draft INTEGER NOT NULL REFERENCES draft, channel TEXT NOT NULL, target TEXT NOT NULL,
    fingerprint TEXT NOT NULL, anchor TEXT NOT NULL, shown_at TEXT NOT NULL,
    PRIMARY KEY (draft,channel,target));
CREATE TABLE IF NOT EXISTS approval_event (
    id INTEGER PRIMARY KEY, draft INTEGER NOT NULL REFERENCES draft,
    channel TEXT NOT NULL, target TEXT NOT NULL, event_id TEXT NOT NULL,
    action TEXT NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL, at TEXT NOT NULL, batch INTEGER REFERENCES batch, error TEXT,
    UNIQUE (channel,target,event_id));
CREATE TABLE IF NOT EXISTS send_attempt (
    draft INTEGER PRIMARY KEY REFERENCES draft, idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL, result TEXT, error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prompt_submission (
    batch INTEGER PRIMARY KEY REFERENCES batch, session_id TEXT NOT NULL, prompt_id TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT);
"""


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def parse(stamp):
    return dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))


def connect(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = sqlite3.connect(path, timeout=30, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript(SCHEMA)
    return db
