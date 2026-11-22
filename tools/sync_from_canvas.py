#!/usr/bin/env python3
"""Rebuild the static site in this repo from files exported from the Claude canvas.

Usage:
    python3 -I tools/sync_from_canvas.py --repo . \
        "project/Skytel Jeopardy v2.dc.html=/path/to/page.html" \
        "project/support.js=/path/to/support.js" \
        "project/image-slot.js=/path/to/image-slot.js" \
        "project/.image-slots.state.json=/path/to/state.json" \
        "project/uploads/skytel-colored.png=/path/to/logo.png"

Each argument maps a file's path inside the canvas to the local copy of it.
The script only writes files whose content changed and prints what it did.
Exit code 0 = ok (changed or not), 2 = input problem, nothing written.
"""
import argparse
import json
import os
import re
import sys

PAGE = 'project/Skytel Jeopardy v2.dc.html'
REQUIRED = {
    PAGE: 'index.html',
    'project/support.js': 'support.js',
    'project/image-slot.js': 'image-slot.js',
    'project/.image-slots.state.json': '.image-slots.state.json',
}
UPLOADS_PREFIX = 'project/uploads/'
SUPPORT_TAG = '<script src="./support.js"></script>'
HEAD_EXTRA = (
    '<title>Skytel Jeopardy</title>\n'
    '<link rel="icon" href="uploads/skytel-colored.png">\n'
    '<script src="./vendor/react.production.min.js"></script>\n'
    '<script src="./vendor/react-dom.production.min.js"></script>\n'
)
SAFE_UPLOAD = re.compile(r'^[A-Za-z0-9._-]+$')


def fail(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(2)


def build_index(page_bytes):
    try:
        page = page_bytes.decode('utf-8')
    except UnicodeDecodeError:
        fail('page is not valid UTF-8')
    if '<x-dc>' not in page or 'data-dc-script' not in page:
        fail('page does not look like the Jeopardy canvas page')
    if page.count(SUPPORT_TAG) != 1:
        fail('expected exactly one support.js script tag in the page')
    if 'vendor/react.production.min.js' in page:
        fail('page already contains the vendor React tags; expected the raw canvas page')
    return page.replace(SUPPORT_TAG, HEAD_EXTRA + SUPPORT_TAG).encode('utf-8'), page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('pairs', nargs='+', help='canvasPath=localFile')
    args = ap.parse_args()

    src = {}
    for pair in args.pairs:
        if '=' not in pair:
            fail('bad argument (need canvasPath=localFile): ' + pair)
        key, path = pair.split('=', 1)
        if not os.path.isfile(path):
            fail('local file not found for ' + key + ': ' + path)
        src[key] = path

    missing = [k for k in REQUIRED if k not in src]
    if missing:
        fail('missing required files: ' + ', '.join(missing))

    out = {}  # repo-relative path -> bytes
    index_bytes, page_text = build_index(open(src[PAGE], 'rb').read())
    out['index.html'] = index_bytes
    for key, dest in REQUIRED.items():
        if key != PAGE:
            out[dest] = open(src[key], 'rb').read()

    try:
        state = json.loads(out['.image-slots.state.json'].decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        fail('.image-slots.state.json is not valid JSON')
    if not isinstance(state, dict):
        fail('.image-slots.state.json is not a JSON object')

    for key, path in src.items():
        if key.startswith(UPLOADS_PREFIX):
            name = key[len(UPLOADS_PREFIX):]
            if not SAFE_UPLOAD.match(name):
                fail('unsafe upload file name: ' + name)
            out['uploads/' + name] = open(path, 'rb').read()
        elif key not in REQUIRED:
            fail('unexpected canvas path: ' + key)

    repo = os.path.abspath(args.repo)
    needed = sorted(set(re.findall(r'uploads/([A-Za-z0-9._-]+)', page_text)))
    for name in needed:
        rel = 'uploads/' + name
        if rel not in out and not os.path.isfile(os.path.join(repo, rel)):
            fail('page uses ' + rel + ' but it was not supplied and is not in the repo')
    for rel in ('vendor/react.production.min.js', 'vendor/react-dom.production.min.js'):
        if not os.path.isfile(os.path.join(repo, rel)):
            fail('repo is missing ' + rel)

    changed = []
    for rel, data in sorted(out.items()):
        dest = os.path.join(repo, rel)
        old = open(dest, 'rb').read() if os.path.isfile(dest) else None
        if old != data:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, 'wb') as f:
                f.write(data)
            changed.append(rel)

    slots = sorted(k for k, v in state.items() if isinstance(v, dict) and v.get('u'))
    print('filled image slots: ' + (', '.join(slots) or 'none'))
    print('uploads used by page: ' + (', '.join(needed) or 'none'))
    if changed:
        print('CHANGED: ' + ', '.join(changed))
    else:
        print('NO CHANGES')


if __name__ == '__main__':
    main()
