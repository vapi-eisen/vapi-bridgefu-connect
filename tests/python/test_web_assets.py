import hashlib
import re
import unittest

from _support import ROOT

WEB = ROOT / "web"
VENDOR = WEB / "vendor" / "bridgefu-webrtc-browser"


class WebAssetTests(unittest.TestCase):
    def test_page_imports_the_vendored_sdk_directly(self):
        app = (WEB / "app.js").read_text(encoding="utf-8")
        match = re.search(r'from\s+"(\./vendor/[^"]+)"', app)
        self.assertIsNotNone(match)
        self.assertTrue((WEB / match.group(1)).is_file(), match.group(1))
        html = (WEB / "index.html").read_text(encoding="utf-8")
        self.assertIn('src="./app.js"', html)
        self.assertIn('href="./style.css"', html)
        self.assertIn('type="module"', html)

    def test_vendored_dist_matches_its_recorded_digest(self):
        provenance = (VENDOR / "VENDORED_FROM.md").read_text(encoding="utf-8")
        recorded = re.search(r"relative path\): `([0-9a-f]{64})`", provenance)
        self.assertIsNotNone(recorded)
        lines = []
        for path in sorted((VENDOR / "dist").rglob("*")):
            if path.is_file():
                relative = "./" + path.relative_to(VENDOR / "dist").as_posix()
                lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {relative}\n")
        digest = hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()
        self.assertEqual(digest, recorded.group(1))

    def test_no_bundler_or_dependencies_required(self):
        self.assertFalse((WEB / "package.json").exists())
        for name in ("server.mjs", "lib/static.mjs"):
            source = (WEB / name).read_text(encoding="utf-8")
            self.assertNotRegex(source, r'from\s+"(?!node:)[^./][^"]*"', name)


if __name__ == "__main__":
    unittest.main()
