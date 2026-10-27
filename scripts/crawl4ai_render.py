#!/usr/bin/env python3
"""Render one public page with Crawl4AI and print a bounded JSON result."""

import asyncio
import json
import re
import sys

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig


MAX_MARKDOWN_CHARS = 30_000


def markdown_text(value) -> str:
    if value is None:
        return ""
    raw = getattr(value, "raw_markdown", None)
    if raw is not None:
        return str(raw)
    return str(value)


async def fetch(url: str) -> dict:
    browser = BrowserConfig(
        headless=True,
        verbose=False,
        text_mode=True,
        light_mode=True,
        memory_saving_mode=True,
        avoid_ads=True,
        user_agent_mode="random",
        viewport_width=1280,
        viewport_height=900,
    )
    run = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        wait_until="domcontentloaded",
        page_timeout=45_000,
        delay_before_return_html=1.2,
        scan_full_page=True,
        scroll_delay=0.25,
        max_scroll_steps=8,
        remove_overlay_elements=True,
        remove_consent_popups=True,
        simulate_user=True,
        word_count_threshold=5,
        exclude_external_images=True,
        verbose=False,
    )
    async with AsyncWebCrawler(config=browser) as crawler:
        result = await crawler.arun(url=url, config=run)
    text = markdown_text(getattr(result, "markdown", ""))
    text = re.sub(r"\n{4,}", "\n\n\n", text).strip()
    metadata = getattr(result, "metadata", None) or {}
    return {
        "success": bool(getattr(result, "success", False)),
        "title": str(metadata.get("title") or "").strip(),
        "finalUrl": str(getattr(result, "redirected_url", "") or url),
        "statusCode": int(getattr(result, "status_code", 0) or 0),
        "markdown": text[:MAX_MARKDOWN_CHARS],
        "truncated": len(text) > MAX_MARKDOWN_CHARS,
        "error": str(getattr(result, "error_message", "") or "").strip(),
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fetch_page.py URL", file=sys.stderr)
        return 2
    try:
        payload = asyncio.run(fetch(sys.argv[1]))
    except Exception as exc:
        payload = {
            "success": False,
            "title": "",
            "finalUrl": sys.argv[1],
            "statusCode": 0,
            "markdown": "",
            "truncated": False,
            "error": f"{type(exc).__name__}: {exc}"[:500],
        }
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
