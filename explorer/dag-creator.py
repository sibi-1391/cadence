import asyncio
import json
import hashlib
import re
from urllib.parse import urlparse
import networkx as nx
from playwright.async_api import async_playwright

class CadenceExplorer:
    def __init__(self, base_url, max_depth=2):
        self.base_url = base_url
        self.allowed_domain = urlparse(base_url).netloc
        self.max_depth = max_depth
        self.G = nx.DiGraph()
        
        # Track visited states to prevent infinite loops
        self.visited_state_hashes = set()
        self.state_counter = 0

    def _generate_dom_fingerprint(self, html_content: str) -> str:
        """
        Creates a structural layout hash by stripping dynamic text values,
        ensuring SPAs are tracked correctly even if content changes.
        """
        # Strip script/style tags and clean out text inside tags to leave structure
        structural_html = re.sub(r'<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>', '', html_content)
        structural_html = re.sub(r'<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>', '', structural_html)
        structural_html = re.sub(r'>[^<]+<', '><', structural_html) # Strip inner text
        
        return hashlib.sha256(structural_html.encode('utf-8')).hexdigest()

    async def _extract_actionable_elements(self, page):
        """
        Scans the DOM for semantic interactive entrypoints and captures
        their exact visible UI text labels for stable production routing.
        """
        elements = await page.query_selector_all('button, a, [role="button"], input[type="submit"]')
        actionable_data = []
        
        for idx, el in enumerate(elements):
            try:
                # Filter out invisible components
                if not await el.is_visible():
                    continue
                    
                tag = await page.evaluate('(el) => el.tagName.toLowerCase()', el)
                
                # CRITICAL UPDATE: Extract exact visible text seen by the user
                raw_text = await el.text_content() or ""
                # If it's an input submit button, grab its value attribute instead
                if tag == "input":
                    raw_text = await el.get_attribute('value') or ""
                
                clean_ui_label = " ".join(raw_text.split()).strip()
                
                # Skip elements that have absolutely no visible identifier (e.g., empty spacing divs)
                if not clean_ui_label and tag != "button":
                    continue
                
                element_id = await el.get_attribute('id')
                css_selector = f"{tag}[id='{element_id}']" if element_id else f"{tag}:nth-of-type({idx+1})"
                
                actionable_data.append({
                    "ui_label": clean_ui_label or f"Unnamed {tag.upper()}", # The stable handle
                    "selector": css_selector,
                    "tag": tag,
                    "element_handle": el
                })
            except Exception:
                continue 
        return actionable_data

    async def explore(self):
        async with async_playwright() as p:
            # 1. Path to store user profile configurations, cookies, and tokens
            user_data_dir = "./.playwright_profile"

            # 2. Launch a persistent context with human-like fingerprints
            context = await p.chromium.launch_persistent_context(
                user_data_dir,
                headless=False, # Set to False initially so you can monitor challenge puzzles
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 720},
                device_scale_factor=1,
                is_mobile=False,
                # Blind automated variable detection overrides
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--start-maximized"
                ]
            )
            
            page = context.pages[0] if context.pages else await context.new_page()
            
            # Override navigator.webdriver footprint via page evaluation init script
            await page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

            # Queue structure: (current_url, depth, parent_node_id)
            queue = [(self.base_url, 0, None)]

            print(f"[*] Launching CADENCE Protected Discovery Engine for: {self.base_url}\n")

            while queue:
                current_url, depth, parent_node_id = queue.pop(0)
                
                if depth > self.max_depth:
                    continue

                if urlparse(current_url).netloc != self.allowed_domain:
                    continue

                try:
                    print(f"[~] Navigating to: {current_url} (Depth: {depth})")
                    await page.goto(current_url, wait_until="load", timeout=20000)
                    
                    # ALERT POINT: If a bot wall appears, execution pauses to let a human click through it
                    if "captcha" in page.url.lower() or await page.title() == "Bot or Not?: ":
                        print("[!] Detection triggered. Please solve the puzzle in the open browser window...")
                        await page.wait_for_timeout(10000) # Gives you 10 seconds to satisfy the security challenge
                        
                except Exception as e:
                    print(f"[!] Target navigation timed out: {e}")
                    continue

                # 1. Evaluate Current UI State Topology
                html_content = await page.content()
                dom_hash = self._generate_dom_fingerprint(html_content)
                page_title = await page.title()

                if dom_hash in self.visited_state_hashes:
                    continue
                
                self.visited_state_hashes.add(dom_hash)
                self.state_counter += 1
                current_node_id = f"state_node_{self.state_counter}"

                self.G.add_node(
                    current_node_id,
                    label=page_title or f"Discovered State {self.state_counter}",
                    url_pattern=f"^{urlparse(current_url).path}$",
                    dom_fingerprint=dom_hash,
                    properties={"is_terminal": False, "requires_auth": False}
                )

                # 2. Action and Network Trace Sniffer Discovery Phase
                actions = await self._extract_actionable_elements(page)
                print(f"    Found {len(actions)} actionable interaction boundaries on page.")

                # Only evaluate the first 5 core actions to keep initialization mapping swift
                for idx, action in enumerate(actions[:5]): 
                    captured_network_calls = []

                    async def handle_request(request):
                        if request.resource_type in ["fetch", "xhr"]:
                            captured_network_calls.append({
                                "url_pattern": request.url[:100], # Keep JSON clean by trimming giant urls
                                "method": request.method,
                                "purpose": "DATA_FETCH"
                            })

                    page.on("request", handle_request)

                    try:
                        el = action["element_handle"]
                        if await el.is_visible():
                            # Human-like click emulation with micro-delays
                            await el.scroll_into_view_if_needed()
                            await page.wait_for_timeout(200)
                            await el.click(timeout=3000)
                            await page.wait_for_timeout(1500)
                    except Exception:
                        pass
                    finally:
                        page.remove_listener("request", handle_request)

                    if captured_network_calls:
                        post_action_url = page.url
                        post_html = await page.content()
                        post_dom_hash = self._generate_dom_fingerprint(post_html)
                        
                        target_node_id = f"target_state_{hashlib.md5(post_dom_hash.encode()).hexdigest()[:6]}" if post_dom_hash != dom_hash else current_node_id
                        
                        edge_id = f"act_{current_node_id}_{idx}"
                        self.G.add_edge(
                            current_node_id,
                            target_node_id,
                            interaction_id=edge_id,
                            label=action["ui_label"],
                            ui_label=action["ui_label"],
                            action_type="CLICK",
                            strategy="PLAYWRIGHT",
                            locator={"css": action["selector"]},
                            associated_network_calls=captured_network_calls
                        )
                        print(f"    [+] Edge Added -> Tracked {len(captured_network_calls)} API calls on label: '{action['ui_label']}'")

            await context.close()
            self.export_to_graphify_json()

    def export_to_graphify_json(self, output_filename="cadence_dag.json"):
        """
        Parses NetworkX core memory mappings and formats them straight into 
        the target Graphify-compatible serialized layout specification.
        """
        data = nx.node_link_data(self.G)
        
        graphify_format = {
          "graph": {
            "id": "cadence-explorer-generated-map",
            "application_name": urlparse(self.base_url).netloc,
            "directed": True
          },
          "nodes": data.get('nodes', []),
          "links": data.get('links', [])
        }

        with open(output_filename, 'w') as f:
            json.dump(graphify_format, f, indent=2)
        print(f"\n[+] CADENCE Network Engine successfully compiled to: {output_filename}")

# --- Execution Entrypoint ---
if __name__ == "__main__":
    # Point the explorer at an internal dashboard or test sandbox
    target_url = "https://www.expedia.com" 
    explorer = CadenceExplorer(base_url=target_url, max_depth=1)
    asyncio.run(explorer.explore())