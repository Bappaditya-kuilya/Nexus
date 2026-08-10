"""
sqlite3 wrapper — stdlib only.
ponytail: no ORM, no migrations tool. Schema is one CREATE TABLE IF NOT EXISTS per run.
"""
import sqlite3, os, contextlib, threading

DB_PATH = os.environ.get("NEXUS_DB", "data.db")
_local = threading.local()

def conn() -> sqlite3.Connection:
    if not getattr(_local, "c", None):
        _local.c = sqlite3.connect(DB_PATH, check_same_thread=False)
        _local.c.row_factory = sqlite3.Row
        _local.c.execute("PRAGMA journal_mode=WAL")
        _local.c.execute("PRAGMA foreign_keys=ON")
    return _local.c

@contextlib.contextmanager
def tx():
    c = conn()
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise

def init():
    with tx() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id      INTEGER PRIMARY KEY,
                email   TEXT UNIQUE NOT NULL,
                created INTEGER DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS otps (
                email   TEXT PRIMARY KEY,
                code    TEXT NOT NULL,
                expires INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS subscriptions (
                id          INTEGER PRIMARY KEY,
                user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                course_code TEXT NOT NULL,
                course_name TEXT,
                created     INTEGER DEFAULT (unixepoch()),
                UNIQUE(user_id, course_code)
            );
            CREATE TABLE IF NOT EXISTS notifications (
                id          INTEGER PRIMARY KEY,
                user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                course_code TEXT NOT NULL,
                title       TEXT NOT NULL,
                body        TEXT,
                seen        INTEGER DEFAULT 0,
                created     INTEGER DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS announcement_seen (
                course_code TEXT NOT NULL,
                title_hash  TEXT NOT NULL,
                PRIMARY KEY(course_code, title_hash)
            );
        """)
