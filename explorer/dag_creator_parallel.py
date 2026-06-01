import asyncio
import json
import hashlib
import re
import argparse
from urllib.parse import urlparse, urlunparse
import networkx as nx
from playwright.async_api import async_playwright

TRACKING_DOMAINS = {
    "px.ads.linkedin.com", "ingest.us.sentry.io", "analytics.google.com",
    "www.google.com", "trk.massive.com", "us.i.posthog.com",
    "pixel-config.reddit.com", "bzr.openai.com", "doubleclick.net",
    "googletagmanager.com", "hotjar.com", "segment.io", "segment.com",
    "mixpanel.com", "amplitude.com", "intercom.io", "crisp.chat",
}


def _normalise_url(url: str) -> str:
    p = urlparse(url)
    return urlunparse((p.scheme, p.netloc, p.path.rstrip("/") or "/", "", "", ""))


def _root_domain(netloc: str) -> str:
    parts = netloc.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else netloc


def _is_tracking(url: str) -> bool:
    try:
        return urlparse(url).netloc in TRACKING_DOMAINS
    except Exception:
        return False


class CadenceExplorerParallel:
    """
    CADENCE Explorer — parallel edition.

    Uses a pool of Playwright pages (one per worker coroutine) and an asyncio
    BFS queue so child nodes are crawled concurrently.  All shared state
    (graph, visited sets, counter) is protected by a single asyncio.Lock so
    the DAG output is identical in structure to the serial version.

    Two modes (same as the serial version):
      - headless  : standard Playwright launch
      - cdp       : attach to a human-launched Chrome on --cdp-url
    """

    def __init__(self, base_url: str, max_depth: int = 2,
                 cdp_url: str = None, concurrency: int = 4,
                 page_timeout: float = 180.0):
        self.base_url = base_url
        self.allowed_domain = _root_domain(urlparse(base_url).netloc)
        self.max_depth = max_depth
        self.cdp_url = cdp_url
        self.concurrency = concurrency
        self.page_timeout = page_timeout

        self.G = nx.DiGraph()
        self.visited_urls: set = set()
        self.visited_states: set = set()
        self.url_to_node_id: dict = {}
        self.state_counter: int = 0
        self.extra_allowed_domains: set = set()
        self.asked_domains: set = set()

        # Initialized inside explore() so they bind to the correct event loop.
        # asyncio primitives created in __init__ (before asyncio.run()) attach to
        # the wrong loop on Python 3.9, causing "Future attached to a different loop".
        self._lock: asyncio.Lock = None
        self._prompt_lock: asyncio.Lock = None

    # ------------------------------------------------------------------
    # External domain handling
    # ------------------------------------------------------------------

    def _is_allowed_domain(self, netloc: str) -> bool:
        root = _root_domain(netloc)
        return root == self.allowed_domain or root in self.extra_allowed_domains

    async def _prompt_external_domain(self, domain: str) -> bool:
        """External domains are skipped by default; only included if passed via --include-domain."""
        async with self._prompt_lock:
            if domain in self.asked_domains:
                return domain in self.extra_allowed_domains
            self.asked_domains.add(domain)
            print(f"    [-] External domain '{domain}' skipped (use --include-domain to add it).")
            return False

    # ------------------------------------------------------------------
    # DOM fingerprinting
    # ------------------------------------------------------------------

    def _generate_dom_fingerprint(self, html_content: str) -> str:
        html = re.sub(r"<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>", "", html_content)
        html = re.sub(r"<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>", "", html)
        html = re.sub(r">[^<]+<", "><", html)
        return hashlib.sha256(html.encode("utf-8")).hexdigest()

    # ------------------------------------------------------------------
    # Element discovery
    # ------------------------------------------------------------------

    async def _extract_actionable_elements(self, page):
        elements = await page.query_selector_all(
            'button, a[href], [role="button"], input[type="submit"]'
        )
        actionable = []

        for idx, el in enumerate(elements):
            try:
                if not await el.is_visible():
                    continue

                tag = await page.evaluate("(el) => el.tagName.toLowerCase()", el)

                raw_text = await el.text_content() or ""
                if tag == "input":
                    raw_text = await el.get_attribute("value") or ""

                ui_label = " ".join(raw_text.split()).strip()

                if not ui_label:
                    ui_label = (
                        await el.get_attribute("aria-label")
                        or await el.get_attribute("title")
                        or await el.get_attribute("placeholder")
                        or ""
                    ).strip()

                href = ""
                if tag == "a":
                    href = await el.get_attribute("href") or ""

                if not ui_label:
                    if href:
                        ui_label = href.rstrip("/").split("/")[-1] or "home"
                    else:
                        continue

                element_id = await el.get_attribute("id")
                css_selector = (
                    f"{tag}[id='{element_id}']"
                    if element_id
                    else f"{tag}:nth-of-type({idx + 1})"
                )

                actionable.append({
                    "ui_label": ui_label,
                    "selector": css_selector,
                    "tag": tag,
                    "href": href,
                    "element_handle": el,
                })
            except Exception:
                continue

        return actionable

    # ------------------------------------------------------------------
    # Browser setup
    # ------------------------------------------------------------------

    async def _get_context(self, p):
        """Return a persistent browser context (or the CDP context)."""
        if self.cdp_url:
            print(f"[*] Attaching to Chrome via CDP at {self.cdp_url} ...")
            browser = await p.chromium.connect_over_cdp(self.cdp_url)
            return browser.contexts[0], True  # (context, is_cdp)

        user_data_dir = "./.playwright_profile"
        context = await p.chromium.launch_persistent_context(
            user_data_dir,
            headless=True,
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 720},
            args=["--disable-blink-features=AutomationControlled"],
        )
        return context, False

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def explore(self):
        # Create locks here, inside the running event loop, to avoid the
        # "Future attached to a different loop" error on Python 3.9.
        self._lock = asyncio.Lock()
        self._prompt_lock = asyncio.Lock()

        async with async_playwright() as p:
            context, is_cdp = await self._get_context(p)

            # Build a pool of pages — one per worker
            page_pool: asyncio.Queue = asyncio.Queue()
            for _ in range(self.concurrency):
                page = await context.new_page()
                if not is_cdp:
                    await page.add_init_script(
                        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
                    )
                # Playwright-level timeouts enforce caps on every CDP operation
                # (content(), title(), query_selector_all(), etc.) independently
                # of asyncio, so operations can't hang inside the event loop.
                page.set_default_timeout(10_000)
                page.set_default_navigation_timeout(25_000)
                await page_pool.put(page)

            # BFS work queue: items are (url, depth, parent_node_id)
            work_queue: asyncio.Queue = asyncio.Queue()
            await work_queue.put((_normalise_url(self.base_url), 0, None))

            print(
                f"[*] CADENCE Parallel Explorer starting: {self.base_url} "
                f"(concurrency={self.concurrency})\n"
            )

            workers = [
                asyncio.create_task(self._worker(work_queue, page_pool))
                for _ in range(self.concurrency)
            ]

            # Block until every queued item has been processed (task_done called).
            # Works correctly even as workers enqueue new child URLs.
            await work_queue.join()

            for w in workers:
                w.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

            await context.close()
            self.export_dag()

    # ------------------------------------------------------------------
    # Worker coroutine
    # ------------------------------------------------------------------

    async def _worker(self, work_queue: asyncio.Queue, page_pool: asyncio.Queue):
        while True:
            item = await work_queue.get()
            try:
                await self._process_item(item, work_queue, page_pool)
            except Exception as e:
                print(f"[!] Worker error on {item[0]}: {e}")
            finally:
                work_queue.task_done()

    # ------------------------------------------------------------------
    # Per-URL processing
    # ------------------------------------------------------------------

    async def _process_item(self, item, work_queue: asyncio.Queue, page_pool: asyncio.Queue):
        current_url, depth, parent_node_id = item

        # --- Gate checks (under lock to avoid races) ---
        async with self._lock:
            if depth > self.max_depth:
                return
            if not self._is_allowed_domain(urlparse(current_url).netloc):
                return
            if current_url in self.visited_urls:
                return
            self.visited_urls.add(current_url)

        # --- Acquire an exclusive page from the pool ---
        page = await page_pool.get()
        # Wrap in a real Task so we can properly cancel and await it.
        # asyncio.wait_for on a plain coroutine in Python 3.9 has a bug: on timeout
        # it raises TimeoutError immediately but leaves the cancelled coroutine running
        # as a zombie that still holds the page.  Using shield + explicit task.cancel()
        # + await ensures the zombie is fully dead before we reset and return the page.
        crawl_task = asyncio.ensure_future(
            self._crawl_page(page, current_url, depth, parent_node_id, work_queue)
        )
        try:
            await asyncio.wait_for(asyncio.shield(crawl_task), timeout=self.page_timeout)
        except asyncio.TimeoutError:
            print(f"[!] Timeout crawling {current_url} — skipping (increase --page-timeout if needed)")
            crawl_task.cancel()
            try:
                await crawl_task
            except (asyncio.CancelledError, Exception):
                pass
        except Exception:
            crawl_task.cancel()
            try:
                await crawl_task
            except (asyncio.CancelledError, Exception):
                pass
        finally:
            # Reset to blank before returning so the next worker gets a clean page.
            try:
                await asyncio.wait_for(
                    page.goto("about:blank", wait_until="domcontentloaded"),
                    timeout=5.0,
                )
            except Exception:
                pass
            await page_pool.put(page)

    async def _crawl_page(self, page, current_url: str, depth: int,
                          parent_node_id, work_queue: asyncio.Queue):
        # Navigate
        try:
            if _normalise_url(page.url) != current_url:
                await page.goto(current_url, wait_until="domcontentloaded", timeout=20000)
                await page.wait_for_timeout(1500)
        except Exception as e:
            print(f"[!] Navigation failed ({current_url}): {e}")
            return

        # --- Node registration ---
        html_content = await page.content()
        dom_hash = self._generate_dom_fingerprint(html_content)
        page_title = await page.title()
        state_key = (current_url, dom_hash)

        async with self._lock:
            if state_key in self.visited_states:
                return
            self.visited_states.add(state_key)
            self.state_counter += 1
            current_node_id = f"state_node_{self.state_counter}"
            self.url_to_node_id[state_key] = current_node_id
            self.G.add_node(
                current_node_id,
                label=page_title or f"Discovered State {self.state_counter}",
                url_pattern=f"^{urlparse(current_url).path}$",
                dom_fingerprint=dom_hash,
                properties={"is_terminal": False, "requires_auth": False},
            )

        print(f"[+] Node: [{current_node_id}] '{page_title}' — {current_url}")

        # --- Element discovery ---
        actions = await self._extract_actionable_elements(page)
        print(f"    {len(actions)} interactive elements found.")

        # --- Queue discovered links for BFS ---
        current_netloc = urlparse(current_url).netloc
        links_to_enqueue = []
        for action in actions:
            href = action.get("href", "")
            if not href or href.startswith("#") or href.startswith("mailto:") or href.startswith("javascript:"):
                continue

            if href.startswith("/"):
                full_url = _normalise_url(f"https://{current_netloc}{href}")
            elif href.startswith("http"):
                link_root = _root_domain(urlparse(href).netloc)
                if not self._is_allowed_domain(urlparse(href).netloc):
                    if not await self._prompt_external_domain(link_root):
                        continue
                full_url = _normalise_url(href)
            else:
                continue

            async with self._lock:
                if full_url not in self.visited_urls and depth + 1 <= self.max_depth:
                    links_to_enqueue.append((full_url, depth + 1, current_node_id))

        for link_item in links_to_enqueue:
            await work_queue.put(link_item)

        # --- Click elements and sniff API calls ---
        for idx, action in enumerate(actions[:20]):
            href = action.get("href", "")
            if href:
                if href.startswith("/"):
                    action_target_url = _normalise_url(f"https://{self.allowed_domain}{href}")
                elif href.startswith("http"):
                    action_target_url = _normalise_url(href)
                else:
                    action_target_url = ""

                if action_target_url:
                    async with self._lock:
                        if action_target_url in self.visited_urls:
                            continue

            captured_network_calls = []

            def handle_request(request, _calls=captured_network_calls):
                if request.resource_type in ("fetch", "xhr") and not _is_tracking(request.url):
                    _calls.append({
                        "url_pattern": request.url[:150],
                        "method": request.method,
                        "purpose": "DATA_FETCH",
                    })

            page.on("request", handle_request)
            try:
                el = action["element_handle"]
                if await el.is_visible():
                    await el.scroll_into_view_if_needed()
                    await page.wait_for_timeout(100)
                    await el.click(timeout=3000)
                    await page.wait_for_timeout(800)
            except Exception:
                pass
            finally:
                page.remove_listener("request", handle_request)

            if captured_network_calls:
                # Collect page state outside the lock to keep await time out of the critical section
                post_url = _normalise_url(page.url)
                post_dom_hash = self._generate_dom_fingerprint(await page.content())
                state_changed = post_dom_hash != dom_hash
                post_state_key = (post_url, post_dom_hash)

                post_title = None
                if state_changed and post_state_key not in self.url_to_node_id:
                    post_title = await page.title()

                async with self._lock:
                    if post_state_key in self.url_to_node_id:
                        target_node_id = self.url_to_node_id[post_state_key]
                    elif state_changed:
                        state_suffix = hashlib.md5(post_dom_hash.encode()).hexdigest()[:6]
                        target_node_id = f"target_state_{state_suffix}"
                        if target_node_id not in self.G.nodes:
                            self.G.add_node(
                                target_node_id,
                                label=post_title or target_node_id,
                                url_pattern=f"^{urlparse(post_url).path}$",
                                dom_fingerprint=post_dom_hash,
                                properties={"is_terminal": False, "requires_auth": False},
                            )
                    else:
                        target_node_id = current_node_id

                    edge_id = f"act_{current_node_id}_{idx}"
                    self.G.add_edge(
                        current_node_id,
                        target_node_id,
                        interaction_id=edge_id,
                        label=action["ui_label"],
                        ui_label=action["ui_label"],
                        action_type="CLICK",
                        strategy="PLAYWRIGHT",
                        locator={
                            "css": action["selector"],
                            "visible_text_match": action["ui_label"],
                        },
                        associated_network_calls=captured_network_calls,
                    )

                print(f"    [->] Edge '{action['ui_label']}' ({len(captured_network_calls)} API calls)")

            # Navigate back so the next element can be explored from the same page.
            # go_back() uses the browser cache (~1-2s); fall back to full goto() only
            # if the history entry isn't available or lands on the wrong URL.
            if _normalise_url(page.url) != current_url:
                try:
                    await page.go_back(wait_until="domcontentloaded", timeout=10000)
                    await page.wait_for_timeout(400)
                    if _normalise_url(page.url) != current_url:
                        await page.goto(current_url, wait_until="domcontentloaded", timeout=20000)
                        await page.wait_for_timeout(400)
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------

    def export_dag(self, output_filename: str = "cadence_dag.json"):
        data = nx.node_link_data(self.G)
        output = {
            "graph": {
                "id": "cadence-explorer-generated-map",
                "application_name": urlparse(self.base_url).netloc,
                "base_url": self.base_url,
                "directed": True,
                "multigraph": False,
            },
            "nodes": data.get("nodes", []),
            "links": data.get("links", []),
        }

        with open(output_filename, "w") as f:
            json.dump(output, f, indent=2)

        node_count = len(output["nodes"])
        edge_count = len(output["links"])
        print(f"\n[✓] DAG written to '{output_filename}' — {node_count} nodes, {edge_count} edges")


# ------------------------------------------------------------------
# CLI entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="CADENCE Parallel Explorer — generate a UI action DAG concurrently"
    )
    parser.add_argument("url", help="Base URL to crawl (e.g. https://example.com)")
    parser.add_argument(
        "--depth", type=int, default=2, help="BFS depth limit (default: 2)"
    )
    parser.add_argument(
        "--concurrency", type=int, default=4,
        help="Number of parallel browser pages / worker coroutines (default: 4)"
    )
    parser.add_argument(
        "--cdp-url", default=None,
        help=(
            "Attach to an existing Chrome instance instead of launching one. "
            "Start Chrome with: --remote-debugging-port=9222  "
            "Then pass: --cdp-url http://localhost:9222"
        ),
    )
    parser.add_argument(
        "--include-domain", action="append", default=[], metavar="DOMAIN",
        help="Allow an external domain in the crawl (repeatable: --include-domain foo.com --include-domain bar.com)",
    )
    parser.add_argument(
        "--page-timeout", type=float, default=180.0,
        help=(
            "Max seconds to spend crawling a single URL before skipping it (default: 180). "
            "Docs-heavy pages with many nav links can each take 60-120s at the default "
            "wait times, so raise this if you see frequent timeout warnings."
        ),
    )
    parser.add_argument(
        "--output", default="cadence_dag.json", help="Output filename (default: cadence_dag.json)"
    )
    args = parser.parse_args()

    explorer = CadenceExplorerParallel(
        base_url=args.url,
        max_depth=args.depth,
        cdp_url=args.cdp_url,
        concurrency=args.concurrency,
        page_timeout=args.page_timeout,
    )
    for domain in args.include_domain:
        explorer.extra_allowed_domains.add(domain)
    asyncio.run(explorer.explore())
