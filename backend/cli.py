"""
Typer CLI — same scraper/db layer as the API, no duplication.
ponytail: no separate HTTP client talking to localhost; direct function calls.

Usage:
  python cli.py search "deep learning"
  python cli.py announcements noc24_cs01
  python cli.py subscribe noc24_cs01 "you@example.com"
  python cli.py subscriptions you@example.com
  python cli.py poll               # one-shot poll for new announcements
"""
import asyncio, sys, os
sys.path.insert(0, os.path.dirname(__file__))

import typer
import db, scraper

app = typer.Typer(help="Nexus course notice reminder")

def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)

@app.command()
def search(query: str):
    """Search Swayam for courses matching QUERY."""
    results = run(scraper.search_courses(query))
    if not results:
        typer.echo("No courses found.")
        return
    for r in results:
        typer.echo(f"\n{r['title']} ({r['code']})")
        typer.echo(f"  {r['instructor']} — {r['institute']}")
        if r["deadline"]:
            typer.echo(f"  Deadline: {r['deadline']}")

@app.command()
def announcements(course_code: str):
    """Show the latest announcements for COURSE_CODE."""
    items = run(scraper.get_announcements(course_code))
    if not items:
        typer.echo("No announcements found (course may be private or code is wrong).")
        return
    for a in items:
        typer.echo(f"\n[{a['date'] or '?'}] {a['title']}")
        if a["body"]:
            typer.echo(f"  {a['body'][:200]}")

@app.command()
def subscribe(course_code: str, email: str, course_name: str = ""):
    """Subscribe EMAIL to announcements for COURSE_CODE."""
    db.init()
    with db.tx() as c:
        c.execute("INSERT OR IGNORE INTO users(email) VALUES(?)", (email,))
        uid = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()["id"]
        c.execute(
            "INSERT OR IGNORE INTO subscriptions(user_id,course_code,course_name) VALUES(?,?,?)",
            (uid, course_code, course_name),
        )
    typer.echo(f"Subscribed {email} to {course_code}.")

@app.command()
def subscriptions(email: str):
    """List subscriptions for EMAIL."""
    db.init()
    rows = db.conn().execute(
        "SELECT s.course_code, s.course_name FROM subscriptions s "
        "JOIN users u ON u.id=s.user_id WHERE u.email=?", (email,)
    ).fetchall()
    if not rows:
        typer.echo("No subscriptions.")
        return
    for r in rows:
        typer.echo(f"  {r['course_code']}  {r['course_name']}")

@app.command()
def poll():
    """Check all subscribed courses for new announcements and print any new ones."""
    db.init()
    import hashlib

    async def _run():
        codes = [r["course_code"] for r in db.conn().execute(
            "SELECT DISTINCT course_code FROM subscriptions"
        ).fetchall()]
        if not codes:
            typer.echo("No subscriptions to poll.")
            return
        found = 0
        for code in codes:
            items = await scraper.get_announcements(code)
            for item in items:
                exists = db.conn().execute(
                    "SELECT 1 FROM announcement_seen WHERE course_code=? AND title_hash=?",
                    (code, item["hash"])
                ).fetchone()
                if exists:
                    continue
                found += 1
                typer.echo(f"\n[NEW] {code} — {item['title']}")
                if item["body"]:
                    typer.echo(f"  {item['body'][:200]}")
                with db.tx() as c:
                    c.execute(
                        "INSERT OR IGNORE INTO announcement_seen(course_code,title_hash) VALUES(?,?)",
                        (code, item["hash"]),
                    )
                    subs = c.execute(
                        "SELECT user_id FROM subscriptions WHERE course_code=?", (code,)
                    ).fetchall()
                    for sub in subs:
                        c.execute(
                            "INSERT INTO notifications(user_id,course_code,title,body) VALUES(?,?,?,?)",
                            (sub["user_id"], code, item["title"], item["body"]),
                        )
        typer.echo(f"\n{found} new announcement(s).")

    run(_run())

if __name__ == "__main__":
    app()
