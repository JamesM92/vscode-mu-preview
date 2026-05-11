"""Wrapper around micron2html with a passthrough URL resolver.

The default URL resolver in micron2html sends untrusted destinations to
"#", which means the preview extension can't see the original micron
link targets to route them. This wrapper supplies a passthrough
resolver, so emitted <a> tags retain their raw destinations
(`:/page/...`, `lxmf@...`, `<hash>:/page/...`, http(s)://, etc.) in
their href attribute. The webview's click interceptor reads those and
sends them back to the extension, which decides how to handle each
kind (local navigation, system browser, unsupported).

Reads a micron source from stdin and writes the body fragment to
stdout. The extension always uses fragment mode and wraps the result
in its own .mu-page shell.

NOTE on form fields: micron's `<name`default> syntax is single-line
only; both the spec and reference clients (NomadNet, MeshChat) render
it as a single <input>. Earlier revisions of this file rewrote
content/body fields into <textarea> elements for nicer multi-line
editing in the preview, but that broke parity with what users
actually see on real clients. The preview now matches MeshChat
exactly: single-line inputs, defaults truncated at the first `>`.
"""

import sys

from micron2html.converter import MicronConverter


def main() -> None:
    converter = MicronConverter(url_resolver=lambda url, *_: url)
    # authenticated=True so form fields render WITHOUT the `disabled`
    # attribute. The preview is a development simulator - the user is
    # always "authenticated" enough to interact with their own pages.
    sys.stdout.write(converter.convert(sys.stdin.read(), authenticated=True))


if __name__ == "__main__":
    main()
