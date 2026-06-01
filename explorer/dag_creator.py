import asyncio
import json
import hashlib
import re
import argparse
from urllib.parse import urlparse, urlunparse
import networkx as nx
from playwright.async_api import async_playwright

# Tracking/analytics domains — strip from API call lists, not useful for the plugin
TRACKING_DOMAINS = {
    "px.ads.linkedin.com", "ingest.us.sentry.io", "analytics.google.com",
    "www.google.com", "trk.massive.com", "us.i.posthog.com",
    "pixel-config.reddit.com", "bzr.openai.com", "doubleclick.net",
    "googletagmanager.com", "hotjar.com", "segment.io", "segment.com",
    "mixpanel.com", "amplitude.com", "intercom.io", "crisp.chat",
}


def _normalise_url(url: str) -> str:
    """Strip query strings and fragments so BFS deduplicates cleanly."""
    p = urlparse(url)
    return urlunparse((p.scheme, p.netloc, p.path.rstrip("/") or "/", "", "", ""))


def _root_domain(netloc: str) -> str:
    """Extract root domain from a netloc — e.g. docs.massive.com -> massive.com"""
    parts = netloc.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else netloc


def _is_tracking(url: str) -> bool:
    try:
        return urlparse(url).netloc in TRACKING_DOMAINS
    except Exception:
        return False


class CadenceExplorer:
    """
    CADENCE Explorer: Crawls a target URL in non-prod, maps all UI states
    and interactive actions into a Graphify-compatible DAG JSON file.

    Two modes:
      - headless  : standard Playwright launch (works on most sites)
      - cdp       : attaches to a human-launched Chrome on --cdp-url
                    (use for bot-protected sites like Expedia, Akamai walls)
    """

    def __init__(self, base_url: str, max_depth: int = 2, cdp_url: str = None):
        self.base_url = base_url
        self.allowed_domain = _root_domain(urlparse(base_url).netloc)
        self.max_depth = max_depth
        self.cdp_url = cdp_url
        self.G = nx.DiGraph()
        self.visited_urls = set()          # BFS queue dedup — prevent re-queuing same URL
        self.visited_states = set()        # Node dedup — (url, dom_hash) for SPA states
        self.url_to_node_id = {}           # (url, dom_hash) -> node_id
        self.state_counter = 0
        self.extra_allowed_domains = set() # User-approved external domains
        self.asked_domains = set()         # Domains already prompted — don't ask twice

    # ------------------------------------------------------------------
    # External domain prompt
    # ------------------------------------------------------------------

    def _is_allowed_domain(self, netloc: str) -> bool:
        root = _root_domain(netloc)
        return root == self.allowed_domain or root in self.extra_allowed_domains

    def _prompt_external_domain(self, domain: str) -> bool:
        """Ask the user once whether to include an external domain in the crawl."""
        if domain in self.asked_domains:
            return domain in self.extra_allowed_domains
        self.asked_domains.add(domain)
        try:
            answer = input(f"\n[?] Found links to external domain '{domain}'. Include it in the DAG? (y/n): ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        if answer == "y":
            self.extra_allowed_domains.add(domain)
            print(f"    [+] '{domain}' added to crawl scope.")
            return True
        print(f"    [-] '{domain}' skipped.")
        return False

    # ------------------------------------------------------------------
    # DOM fingerprinting
    # ------------------------------------------------------------------

    def _generate_dom_fingerprint(self, html_content: str) -> str:
        """
        Structural hash of the page — strips scripts, styles, and inner text
        so SPAs that change content without changing the URL still get unique nodes.
        """
        html = re.sub(r"<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>", "", html_content)
        html = re.sub(r"<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>", "", html)
        html = re.sub(r">[^<]+<", "><", html)
        return hashlib.sha256(html.encode("utf-8")).hexdigest()

    # ------------------------------------------------------------------
    # Element discovery
    # ------------------------------------------------------------------

    async def _extract_actionable_elements(self, page):
        """
        Returns all visible interactive elements with their stable UI label.
        Falls back to aria-label, title, or placeholder when text content is empty.
        Also extracts href links from <a> tags for direct BFS queuing.
        """
        elements = await page.query_selector_all(
            'button, a[href], [role="button"], input[type="submit"]'
        )
        actionable = []

        for idx, el in enumerate(elements):
            try:
                if not await el.is_visible():
                    continue

                tag = await page.evaluate("(el) => el.tagName.toLowerCase()", el)

                # Build label from multiple fallback sources
                raw_text = await el.text_content() or ""
                if tag == "input":
                    raw_text = await el.get_attribute("value") or ""

                ui_label = " ".join(raw_text.split()).strip()

                # Fallback chain: aria-label → title → placeholder → href path
                if not ui_label:
                    ui_label = (
                        await el.get_attribute("aria-label")
                        or await el.get_attribute("title")
                        or await el.get_attribute("placeholder")
                        or ""
                    )
                    ui_label = ui_label.strip()

                # For <a> tags, extract href so the BFS can queue it directly
                href = ""
                if tag == "a":
                    href = await el.get_attribute("href") or ""

                if not ui_label:
                    if href:
                        ui_label = href.rstrip("/").split("/")[-1] or "home"
                    else:
                        continue  # Skip truly unlabelled elements

                element_id = await el.get_attribute("id")
                css_selector = (
                    f"{tag}[id='{element_id}']"
                    if element_id
                    else f"{tag}:nth-of-type({idx + 1})"
                )

                actionable.append(
                    {
                        "ui_label": ui_label,
                        "selector": css_selector,
                        "tag": tag,
                        "href": href,
                        "element_handle": el,
                    }
                )
            except Exception:
                continue

        return actionable

    # ------------------------------------------------------------------
    # Browser setup helpers
    # ------------------------------------------------------------------

    async def _get_page(self, p):
        """
        Returns (browser_or_context, page).
        Attaches to an existing Chrome CDP session when --cdp-url is provided;
        otherwise launches a stealth Playwright context.
        """
        if self.cdp_url:
            print(f"[*] Attaching to Chrome via CDP at {self.cdp_url} ...")
            browser = await p.chromium.connect_over_cdp(self.cdp_url)
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else await context.new_page()
            return browser, page

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
        page = context.pages[0] if context.pages else await context.new_page()
        await page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        return context, page

    # ------------------------------------------------------------------
    # Core BFS crawl loop
    # ------------------------------------------------------------------

    async def explore(self):
        async with async_playwright() as p:
            handle, page = await self._get_page(p)

            queue = [(_normalise_url(self.base_url), 0, None)]
            print(f"[*] CADENCE Explorer starting: {self.base_url}\n")

            while queue:
                current_url, depth, parent_node_id = queue.pop(0)

                if depth > self.max_depth:
                    continue
                if not self._is_allowed_domain(urlparse(current_url).netloc):
                    continue
                # Skip already-visited URLs — deduplicate by URL, not DOM hash
                if current_url in self.visited_urls:
                    continue
                self.visited_urls.add(current_url)

                try:
                    if _normalise_url(page.url) != current_url:
                        await page.goto(current_url, wait_until="domcontentloaded", timeout=20000)
                        await page.wait_for_timeout(2000)
                except Exception as e:
                    print(f"[!] Navigation failed: {e}")
                    continue

                # --- Node registration ---
                html_content = await page.content()
                dom_hash = self._generate_dom_fingerprint(html_content)
                page_title = await page.title()
                state_key = (current_url, dom_hash)

                # Skip if this exact (url, dom) combo was already registered
                # This allows SPA states at the same URL to each get their own node
                if state_key in self.visited_states:
                    continue
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

                # --- Edge + API sniffing ---
                actions = await self._extract_actionable_elements(page)
                print(f"    {len(actions)} interactive elements found.")

                # Queue discovered links for BFS — prompt user for external domains
                current_netloc = urlparse(current_url).netloc
                for action in actions:
                    href = action.get("href", "")
                    if not href or href.startswith("#") or href.startswith("mailto:") or href.startswith("javascript:"):
                        continue
                    if href.startswith("/"):
                        full_url = _normalise_url(f"https://{current_netloc}{href}")
                    elif href.startswith("http"):
                        link_root = _root_domain(urlparse(href).netloc)
                        if not self._is_allowed_domain(urlparse(href).netloc):
                            if not self._prompt_external_domain(link_root):
                                continue
                        full_url = _normalise_url(href)
                    else:
                        continue
                    if full_url not in self.visited_urls and depth + 1 <= self.max_depth:
                        queue.append((full_url, depth + 1, current_node_id))

                for idx, action in enumerate(actions[:20]):
                    # Skip links to already-visited URLs — no need to click them
                    href = action.get("href", "")
                    if href:
                        if href.startswith("/"):
                            action_target_url = _normalise_url(f"https://{self.allowed_domain}{href}")
                        elif href.startswith("http"):
                            action_target_url = _normalise_url(href)
                        else:
                            action_target_url = ""
                        if action_target_url and action_target_url in self.visited_urls:
                            continue

                    captured_network_calls = []

                    def handle_request(request, _calls=captured_network_calls):
                        if request.resource_type in ("fetch", "xhr") and not _is_tracking(request.url):
                            _calls.append(
                                {
                                    "url_pattern": request.url[:150],
                                    "method": request.method,
                                    "purpose": "DATA_FETCH",
                                }
                            )

                    page.on("request", handle_request)
                    try:
                        el = action["element_handle"]
                        if await el.is_visible():
                            await el.scroll_into_view_if_needed()
                            await page.wait_for_timeout(200)
                            await el.click(timeout=3000)
                            await page.wait_for_timeout(1500)
                    except Exception:
                        pass
                    finally:
                        page.remove_listener("request", handle_request)

                    if captured_network_calls:
                        post_url = _normalise_url(page.url)
                        post_dom_hash = self._generate_dom_fingerprint(await page.content())
                        navigated = post_url != current_url
                        state_changed = post_dom_hash != dom_hash

                        # Reuse existing node if this (url, dom_hash) was already registered
                        post_state_key = (post_url, post_dom_hash)
                        if post_state_key in self.url_to_node_id:
                            target_node_id = self.url_to_node_id[post_state_key]
                        elif state_changed:
                            state_suffix = hashlib.md5(post_dom_hash.encode()).hexdigest()[:6]
                            target_node_id = f"target_state_{state_suffix}"
                            if target_node_id not in self.G.nodes:
                                post_title = await page.title()
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
                        print(
                            f"    [->] Edge '{action['ui_label']}' "
                            f"({len(captured_network_calls)} API calls)"
                        )

                    # Navigate back to parent so next element can be explored
                    if _normalise_url(page.url) != current_url:
                        try:
                            await page.goto(current_url, wait_until="domcontentloaded", timeout=20000)
                            await page.wait_for_timeout(1000)
                        except Exception:
                            pass

            # Clean disconnect without killing the user's browser
            if self.cdp_url:
                await handle.close()
            else:
                await handle.close()

            self.export_dag()

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
        description="CADENCE Explorer — generate a UI action DAG for a target URL"
    )
    parser.add_argument("url", help="Base URL to crawl (e.g. https://example.com)")
    parser.add_argument(
        "--depth", type=int, default=2, help="BFS depth limit (default: 2)"
    )
    parser.add_argument(
        "--cdp-url",
        default=None,
        help=(
            "Attach to an existing Chrome instance instead of launching one. "
            "Start Chrome with: --remote-debugging-port=9222  "
            "Then pass: --cdp-url http://localhost:9222"
        ),
    )
    parser.add_argument(
        "--output", default="cadence_dag.json", help="Output filename (default: cadence_dag.json)"
    )
    args = parser.parse_args()

    explorer = CadenceExplorer(
        base_url=args.url,
        max_depth=args.depth,
        cdp_url=args.cdp_url,
    )
    asyncio.run(explorer.explore())
