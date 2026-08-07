"""
FastAPI app + background announcement poll.
ponytail: asyncio.create_task for the poll loop — no APScheduler dep.
"""
import asyncio, time, os
from fastapi import FastAPI, HTTPException, Cookie, Response, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

import db, auth, scraper

app = FastAPI(title="NPTEL Notice Reminder")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("CORS_ORIGIN", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------------------------------------------- auth utils

def _current_user(access_token: str | None = Cookie(default=None)) -> int:
    if not access_token:
        raise HTTPException(401, "Not authenticated.")
    try:
        return auth.decode_token(access_token, "access")
    except ValueError as e:
        raise HTTPException(401, str(e))

# --------------------------------------------------------------------- models

class EmailIn(BaseModel):
    email: EmailStr

class OTPIn(BaseModel):
    email: EmailStr
    code: str

class SubIn(BaseModel):
    course_code: str
    course_name: str = ""

# ----------------------------------------------------------------------- auth

@app.post("/auth/request-otp", status_code=204)
def request_otp(body: EmailIn):
    auth.request_otp(body.email)

@app.post("/auth/verify-otp")
def verify_otp(body: OTPIn, response: Response):
    try:
        uid = auth.verify_otp(body.email, body.code)
    except ValueError as e:
        raise HTTPException(400, str(e))
    tokens = auth.make_tokens(uid)
    response.set_cookie("access_token",  tokens["access_token"],  httponly=True, samesite="lax", max_age=auth.ACCESS*60)
    response.set_cookie("refresh_token", tokens["refresh_token"], httponly=True, samesite="lax", max_age=auth.REFRESH*86400)
    return {"user_id": uid}

@app.post("/auth/refresh")
def refresh(response: Response, refresh_token: str | None = Cookie(default=None)):
    if not refresh_token:
        raise HTTPException(401, "No refresh token.")
    try:
        uid = auth.decode_token(refresh_token, "refresh")
    except ValueError as e:
        raise HTTPException(401, str(e))
    tokens = auth.make_tokens(uid)
    response.set_cookie("access_token", tokens["access_token"], httponly=True, samesite="lax", max_age=auth.ACCESS*60)
    return {"ok": True}

@app.post("/auth/logout", status_code=204)
def logout(response: Response):
    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")

@app.get("/auth/me")
def me(uid: int = Depends(_current_user)):
    row = db.conn().execute("SELECT id, email, created FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        raise HTTPException(404)
    return dict(row)

# -------------------------------------------------------------------- courses

@app.get("/search")
async def search(q: str):
    try:
        return await scraper.search_courses(q)
    except Exception as e:
        raise HTTPException(502, f"Swayam scrape failed: {e}")

@app.get("/courses/{code}/announcements")
async def announcements(code: str):
    try:
        return await scraper.get_announcements(code)
    except Exception as e:
        raise HTTPException(502, f"Scrape failed: {e}")

# ---------------------------------------------------------------- subscriptions

@app.get("/subscriptions")
def get_subs(uid: int = Depends(_current_user)):
    rows = db.conn().execute(
        "SELECT course_code, course_name, created FROM subscriptions WHERE user_id=?", (uid,)
    ).fetchall()
    return [dict(r) for r in rows]

@app.post("/subscriptions", status_code=201)
def add_sub(body: SubIn, uid: int = Depends(_current_user)):
    try:
        with db.tx() as c:
            c.execute(
                "INSERT OR IGNORE INTO subscriptions(user_id,course_code,course_name) VALUES(?,?,?)",
                (uid, body.course_code, body.course_name),
            )
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"ok": True}

@app.delete("/subscriptions/{code}", status_code=204)
def del_sub(code: str, uid: int = Depends(_current_user)):
    with db.tx() as c:
        c.execute("DELETE FROM subscriptions WHERE user_id=? AND course_code=?", (uid, code))

# ---------------------------------------------------------------- notifications

@app.get("/notifications")
def get_notifs(uid: int = Depends(_current_user)):
    rows = db.conn().execute(
        "SELECT id,course_code,title,body,seen,created FROM notifications "
        "WHERE user_id=? ORDER BY created DESC LIMIT 100", (uid,)
    ).fetchall()
    return [dict(r) for r in rows]

@app.post("/notifications/{nid}/seen", status_code=204)
def mark_seen(nid: int, uid: int = Depends(_current_user)):
    with db.tx() as c:
        c.execute("UPDATE notifications SET seen=1 WHERE id=? AND user_id=?", (nid, uid))

# --------------------------------------------------------- background poll loop

POLL_INTERVAL = 3600  # seconds — ponytail: simple sleep loop, not APScheduler

async def _poll():
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        try:
            codes = [r["course_code"] for r in db.conn().execute(
                "SELECT DISTINCT course_code FROM subscriptions"
            ).fetchall()]
            for code in codes:
                items = await scraper.get_announcements(code)
                for item in items:
                    existing = db.conn().execute(
                        "SELECT 1 FROM announcement_seen WHERE course_code=? AND title_hash=?",
                        (code, item["hash"])
                    ).fetchone()
                    if existing:
                        continue
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
        except Exception as e:
            print(f"[poll] error: {e}", flush=True)

@app.on_event("startup")
async def startup():
    db.init()
    asyncio.create_task(_poll())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
