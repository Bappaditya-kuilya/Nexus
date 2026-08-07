"""
Swayam course search + NPTEL announcement scraping.
ponytail: HTML scraping only — there are no public JSON APIs (verified).
"""
import re, hashlib
import httpx
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Referer": "https://swayam.gov.in/",
}

def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")

async def search_courses(q: str) -> list[dict]:
    url = f"https://swayam.gov.in/search_courses?searchText={q}"
    async with httpx.AsyncClient(headers=HEADERS, timeout=15, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
    soup = _soup(r.text)
    results = []
    for card in soup.select("div.es-course-card"):
        title_el = card.select_one("h4.courseTitle, .courseTitle")
        link_el  = card.select_one("a[href*='/preview']")
        code     = re.search(r"/([^/]+)/preview", link_el["href"]).group(1) if link_el else None
        results.append({
            "code":        code,
            "title":       title_el.get_text(strip=True) if title_el else "",
            "instructor":  (card.select_one(".courseInstructor") or card).get_text(strip=True)[:120],
            "institute":   (card.select_one(".courseInstitute") or card).get_text(strip=True)[:120],
            "deadline":    (card.select_one("strong.text-danger") or card).get_text(strip=True)[:60],
        })
    return [r for r in results if r["code"]]

async def get_announcements(code: str) -> list[dict]:
    urls = [
        f"https://onlinecourses.nptel.ac.in/{code}/announcements",
        f"https://onlinecourses.swayam2.ac.in/{code}/announcements",
    ]
    html = None
    async with httpx.AsyncClient(headers=HEADERS, timeout=15, follow_redirects=True) as client:
        for url in urls:
            r = await client.get(url)
            if r.status_code == 200:
                html = r.text
                break
    if not html:
        return []

    soup = _soup(html)
    items = []
    for el in soup.select("span.gcb-announcement-title"):
        title = el.get_text(strip=True)
        body_el = el.find_next("p", class_="gcb-announcement-content")
        # Date can be in sibling <p> text or in an inline script new Date(ts).
        date = ""
        for p in el.find_all_next("p", limit=3):
            m = re.search(r"new Date\(([\d.]+)\)", str(p))
            if m:
                from datetime import datetime, timezone
                date = datetime.fromtimestamp(float(m.group(1))/1000, tz=timezone.utc).strftime("%Y-%m-%d")
                break
            t = p.get_text(strip=True)
            if re.search(r"\d{4}", t):
                date = t[:30]
                break
        items.append({
            "title": title,
            "body":  body_el.get_text(strip=True)[:500] if body_el else "",
            "date":  date,
            "hash":  hashlib.sha1(title.encode()).hexdigest()[:16],
        })
    return items
