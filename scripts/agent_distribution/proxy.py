import http.server
import threading
from .support import Acp, require, wait_for


def check_proxy(fixture):
    proxy_requests = []

    class Proxy(http.server.BaseHTTPRequestHandler):
        def do_CONNECT(self):
            proxy_requests.append("CONNECT " + self.path)
            self.send_response(200)
            self.end_headers()
            self.close_connection = False

        def do_GET(self):
            proxy_requests.append(self.path)
            body = b"[]"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    proxy_url = f"http://127.0.0.1:{proxy.server_port}"
    try:
        proxy_variables = [
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "ALL_PROXY",
            "https_proxy",
            "http_proxy",
            "all_proxy",
        ]
        for variable in proxy_variables:
            fixture.overdue()
            before_proxy = len(proxy_requests)
            proxy_environment = {
                **fixture.active_environment,
                "RX_TEST_RELEASE_SOURCE": "http://release-fixture.invalid",
                variable: proxy_url,
            }
            proxied = Acp(fixture.acp_command, proxy_environment, fixture.work)
            proxied.close()
            wait_for(lambda: len(proxy_requests) > before_proxy)
            wait_for(lambda: not fixture.helper_pids())
            require(
                proxy_requests[before_proxy] == "CONNECT release-fixture.invalid:80"
                and proxy_requests[-1].startswith("/releases?"),
                "helper did not use its proxy",
            )
        for variable in ["NO_PROXY", "no_proxy"]:
            fixture.overdue()
            requests = fixture.state["release_requests"]
            before_proxy = len(proxy_requests)
            bypass = Acp(
                fixture.acp_command,
                {
                    **fixture.active_environment,
                    "ALL_PROXY": proxy_url,
                    variable: "127.0.0.1",
                },
                fixture.work,
            )
            bypass.close()
            fixture.wait_checked(requests)
            require(
                len(proxy_requests) == before_proxy, "helper discarded its proxy bypass"
            )
        fixture.checks["helper_proxy_environment"] = {
            "proxy_variables": proxy_variables,
            "bypass_variables": ["NO_PROXY", "no_proxy"],
            "proxy_requests": len(proxy_requests),
            "provider_credentials_excluded": True,
        }
    finally:
        proxy.shutdown()
