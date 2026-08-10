"""
OTP generation/verification + JWT.
ponytail: secrets (stdlib) for OTP, PyJWT for tokens, smtplib (stdlib) for email.
Console delivery when SMTP_HOST is unset.
"""
import secrets, time, os
import jwt
from db import conn, tx

SECRET  = os.environ.get("JWT_SECRET", secrets.token_hex(32))
ACCESS  = int(os.environ.get("JWT_ACCESS_MINUTES",  "15"))
REFRESH = int(os.environ.get("JWT_REFRESH_DAYS",    "7"))
OTP_TTL = int(os.environ.get("OTP_EXPIRE_MINUTES",  "10"))

def _send_otp(email: str, code: str):
    host = os.environ.get("SMTP_HOST", "")
    if not host:
        print(f"\n  *** OTP for {email}: {code} ***\n", flush=True)
        return
    import smtplib, ssl
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["Subject"] = "Your Nexus login code"
    msg["From"]    = os.environ.get("SMTP_FROM", "noreply@example.com")
    msg["To"]      = email
    msg.set_content(f"Your one-time code is: {code}\n\nExpires in {OTP_TTL} minutes.")
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(host, int(os.environ.get("SMTP_PORT", "465")), context=ctx) as s:
        s.login(os.environ.get("SMTP_USER", ""), os.environ.get("SMTP_PASS", ""))
        s.send_message(msg)

def request_otp(email: str):
    code = "".join(secrets.choice("0123456789") for _ in range(6))
    exp  = int(time.time()) + OTP_TTL * 60
    with tx() as c:
        c.execute(
            "INSERT INTO otps(email,code,expires) VALUES(?,?,?) "
            "ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires=excluded.expires",
            (email, code, exp),
        )
    _send_otp(email, code)

def verify_otp(email: str, code: str) -> int:
    """Return user_id on success, raise ValueError otherwise."""
    row = conn().execute(
        "SELECT code, expires FROM otps WHERE email=?", (email,)
    ).fetchone()
    if not row or row["expires"] < int(time.time()):
        raise ValueError("Code expired or not requested.")
    if not secrets.compare_digest(row["code"], code.strip()):
        raise ValueError("Wrong code.")
    with tx() as c:
        c.execute("DELETE FROM otps WHERE email=?", (email,))
        c.execute("INSERT OR IGNORE INTO users(email) VALUES(?)", (email,))
        uid = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()["id"]
    return uid

def make_tokens(user_id: int) -> dict:
    now = int(time.time())
    access = jwt.encode(
        {"sub": str(user_id), "exp": now + ACCESS * 60, "type": "access"},
        SECRET, algorithm="HS256",
    )
    refresh = jwt.encode(
        {"sub": str(user_id), "exp": now + REFRESH * 86400, "type": "refresh"},
        SECRET, algorithm="HS256",
    )
    return {"access_token": access, "refresh_token": refresh}

def decode_token(token: str, kind: str = "access") -> int:
    try:
        data = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise ValueError("Token expired.")
    except Exception:
        raise ValueError("Invalid token.")
    if data.get("type") != kind:
        raise ValueError("Wrong token type.")
    return int(data["sub"])
